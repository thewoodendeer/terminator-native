#pragma once
// BassSequencer — the piano roll's pattern player as a native EventSource on the engine's sample clock (Phase 3.4).
// Semantics = bass/BassEngine.ts rebuildTickMap / scheduleAhead (dossier-stems-bass-io.md §2.4, §2.6), on samples:
//   • a pattern is a PPQ-96 TICK MAP: note-on at round(start·96), off at round((start+dur)·96) (≥ on+1; an off past
//     the loop end fires at its wrap — the note holds into the repeat); a SLIDE note = an on-event that bends what is
//     sounding over its length (nothing is triggered); the BEND lane sampled per tick — posted when it moved > 0.002
//     st;
//   • tickDur = 60/max(20,bpm)/96, re-read per tick (a BPM change applies at the next tick; the incremental
//     `nextTickSample += tickDur` keeps the grid continuous — no re-anchor);
//   • at a tick: OFFS first, then ONS (a retrigger of the same pitch at the tick isn't eaten) — the engine fires them
//     in that order at the SAME sample (the TS live path added 0.2 ms to the ons; the TS EXPORT path — the reference
//     for renders — does not, and neither does this);
//   • editing while playing (the TS "stuck +8va note" fix): a live pattern replace releases every SOUNDING note whose
//     pitch changed or whose off vanished, keeps the others, and the next ticks read the new map — nothing queued ahead
//     to purge, the engine schedules tick by tick inside the block;
//   • play(at, offsetTicks) phase-locks tick `offsetTicks` to an engine sample (the chopper's transport anchor);
//     stop() drops the seq events, RELEASES what sounds and zeroes the bend (a lane never leaves the synth bent);
//   • the arranger drives the bass with an absolute-time TIMELINE (setTimeline: events sorted by sample, consumed by
//     cursor — the TS playTimeline posts them all at once; here they are pushed into the synth as their block comes);
//     while `arrangerDriven` the pattern ticks stay quiet (mutedByArranger); the wheel while ● REC mutes the lane
//     (setBendLane(false)).
// Patterns / timelines are plain structs built on the message thread and handed over by POINTER (the shell's ring
// keeps them alive). Everything here is RT (RT-RULES.md).
#include <algorithm>
#include <cmath>
#include <cstdint>

#include "terminator/core/BassSynth.h"
#include "terminator/core/RtAssert.h"

namespace terminator
{

inline constexpr int kBassPpq = 96;
inline constexpr int kBassMaxBars = 8;
inline constexpr int kBassMaxLoopTicks = kBassMaxBars * 4 * kBassPpq; // 3072
inline constexpr int kBassMaxNotes = 512;
inline constexpr int kBassMaxTimeline = 4096;
inline constexpr int kBassMaxSounding = 128;

/// One bass pattern as the engine plays it (the tick map). ~20 KB — heap-allocate, hand over by pointer.
struct BassPattern
{
    struct Note
    {
        std::int32_t id;      // the roll's note id (the reconciliation key on a live replace)
        std::int32_t onTick;  // 0..loopTicks−1
        std::int32_t offTick; // the off's tick (already wrapped into 0..loopTicks−1); −1 for a slide note
        float vel;            // 0.05..1
        float slideBeats;     // slide notes: the bend length in beats
        std::uint8_t note;    // 0..127
        bool slide;
    };
    int bars = 2;                     // 1..8
    int loopTicks = 2 * 4 * kBassPpq; // max(96, bars×4×96)
    int numNotes = 0;
    Note notes[kBassMaxNotes] = {};
    bool hasBend = false;
    float bend[kBassMaxLoopTicks] = {}; // the BEND lane sampled per tick (semitones)

    void clear() noexcept
    {
        bars = 2;
        loopTicks = 2 * 4 * kBassPpq;
        numNotes = 0;
        hasBend = false;
        for (auto& b : bend)
            b = 0.0f;
    }
    /// Add a roll note (start/dur in beats) the way rebuildTickMap does. Returns false when full.
    bool addNote(std::int32_t id, int midiNote, double startBeats, double durBeats, double vel, bool slide) noexcept;
};

/// The arranger's absolute-time bass events (playTimeline), sorted by (sample, off-before-on). By pointer.
struct BassTimeline
{
    struct Event
    {
        std::uint64_t sample;
        double value; // slide: duration seconds; bend: semitones
        float vel;
        std::uint8_t note;
        BassSynth::EventKind kind;
    };
    int count = 0;
    Event events[kBassMaxTimeline] = {};
    /// Insert keeping the order (sample, then off < slide < on < bend by kind value... see .cpp). False when full.
    bool add(BassSynth::EventKind kind, std::uint64_t sample, int note, float vel, double value) noexcept;
};

class BassSequencer
{
  public:
    /// A device change: `keepClock` (same sample rate) keeps the music exactly where it was — pattern, position,
    /// playing. Otherwise the clock resets, and `keepData` still keeps the pattern so the page does not have to
    /// re-send it (it never does).
    void prepare(double sampleRate, bool keepClock = false, bool keepData = false) noexcept;
    /// `keepData` keeps the shell-owned pattern pointers (rate-independent data the page never re-sends);
    /// everything else — playing, positions, pending hits — is cleared.
    void reset(bool keepData = false) noexcept;

    // --- commands (audio thread, from Engine::apply) ---
    void setPattern(const BassPattern* p, BassSynth& synth) noexcept TERMINATOR_NONBLOCKING; // live replace
    void setTimeline(const BassTimeline* t) noexcept TERMINATOR_NONBLOCKING;                 // nullptr = none
    void clearTimeline(BassSynth& synth) noexcept TERMINATOR_NONBLOCKING; // drops arr events, releases, bend 0
    void setArrangerDriven(bool on) noexcept TERMINATOR_NONBLOCKING { arrangerDriven_ = on; }
    void setBendLane(bool on) noexcept TERMINATOR_NONBLOCKING; // false while the wheel records
    void setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING;   // 20..300; applies at the next tick
    /// Start with absolute tick `offsetTicks` landing at engine sample `atSample` (≥ the current block start; 0 = the
    /// start of the next block). Restarts when playing.
    void play(std::uint64_t atSample, int offsetTicks, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING;
    void stop(BassSynth& synth) noexcept TERMINATOR_NONBLOCKING;

    /// Push this block's tick events + timeline events into the synth (call BEFORE synth.render for the block).
    void process(std::uint64_t blockStart, int numSamples, BassSynth& synth) noexcept TERMINATOR_NONBLOCKING;

    // --- read-back for the snapshot (audio thread) ---
    bool playing() const noexcept { return playing_; }
    bool arrangerDriven() const noexcept { return arrangerDriven_; }
    double bpm() const noexcept { return bpm_; }
    int loopTicks() const noexcept { return pat_ != nullptr ? pat_->loopTicks : 2 * 4 * kBassPpq; }
    /// The tick inside the loop the playhead is in at the block end (−1 = stopped).
    int currentTick() const noexcept { return playing_ ? currentTick_ : -1; }
    /// Engine sample of the current pass's tick 0 (the page's startTime origin; signed — a seek can put it before 0).
    std::int64_t loopStartSample() const noexcept { return static_cast<std::int64_t>(std::llround(passStart_)); }
    std::uint64_t ticksScheduled() const noexcept { return ticks_; }
    std::uint64_t timelineEventsFired() const noexcept { return timelineFired_; }
    int soundingCount() const noexcept { return soundingCount_; }

  private:
    struct Sounding
    {
        std::int32_t id;
        std::uint8_t note;
    };
    double tickDurSamples() const noexcept TERMINATOR_NONBLOCKING
    {
        return (60.0 / std::max(20.0, bpm_)) / kBassPpq * sr_;
    }
    void soundingAdd(std::int32_t id, std::uint8_t note) noexcept TERMINATOR_NONBLOCKING;
    void soundingRemove(std::int32_t id) noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    double bpm_ = 120.0;
    bool playing_ = false;
    bool arrangerDriven_ = false;
    bool bendLane_ = true;
    const BassPattern* pat_ = nullptr;
    const BassTimeline* timeline_ = nullptr;
    int timelineCursor_ = 0;
    std::int64_t nextTick_ = 0;   // the next absolute tick to schedule
    double nextTickSample_ = 0.0; // its engine sample
    double passStart_ = 0.0;      // engine sample of the current pass's tick 0
    int currentTick_ = -1;
    double lastBendSent_ = 0.0;
    bool bendSentValid_ = false;
    Sounding sounding_[kBassMaxSounding] = {};
    int soundingCount_ = 0;
    std::uint64_t ticks_ = 0;
    std::uint64_t timelineFired_ = 0;
};

} // namespace terminator
