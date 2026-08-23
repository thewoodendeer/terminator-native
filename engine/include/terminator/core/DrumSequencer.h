#pragma once
// DrumSequencer — the drum machine's step sequencer as a native EventSource on the engine's sample clock (Phase
// 3.3). Same shape as ChopSequencer: the audio callback asks it every block, it fires the lanes' hits into the
// Sampler at exact sample offsets (no look-ahead timer, no Web Audio). Semantics = drums/DrumEngine.ts
// scheduleAhead / scheduleStep / emitVoice (dossier-sequencing-midi.md §2), on samples:
//   • storage = 96 internal steps per bar (INTERNAL_SPB; the UI's 1/8·1/16·1/32 ± triplet views are lenses over it),
//     stepDur = 60/bpm × 4/96, re-read per step (a BPM change applies at the next step); the pattern ALWAYS loops;
//   • per hit: lane volume × the step's VELOCITY × the drum master; SWING on the step's 16th slot (the shared
//     formula, odd 16ths late); SHIFT (ms, ±50) snapped to the PPQ pulse — it may be NEGATIVE, so steps are scheduled
//     kLookaheadSec ahead of the block (a hit before its grid time is still sample-exact); PAN per hit; REPEAT = a
//     roll of sub-hits every `beats × 60/bpm` from the (swung + shifted) hit until the step's STRAIGHT slot end, each
//     fading (the lane's 4 ms choke) INTO the next one (Sampler sub-hits: they cut nothing, nothing cuts them);
//   • a lane hit cuts the lane's previous voice (4 ms, DRUM_CHOKE_S) and the OTHER lanes of its mute group (time
//     order: a group mate starting at the same sample layers) — that is the Sampler's choke at the hit's offset;
//   • a live-triggered lane (command / MIDI) within kLiveOwnerWindowSec of a pattern hit owns it (the copy is
//     skipped at fire time) — the TS LIVE_OWNER_WINDOW rule;
//   • arranged playback: a list of pattern SWAPS (schedulePattern {pattern, atSample}) — a step whose straight grid
//     time (+ half a step, the TS tolerance) is ≥ a swap's time plays that pattern; play(at, stepOffset) seeks.
// Patterns / graphs are plain structs built on the message thread and handed over by POINTER (the shell's ring
// keeps them alive). Lane L plays pad kDrumPadBase + L. Everything here is RT (RT-RULES.md).
#include <cmath>
#include <cstdint>

#include "terminator/core/RtAssert.h"
#include "terminator/core/Metronome.h"
#include "terminator/core/Sampler.h"

namespace terminator
{

inline constexpr int kDrumStepsPerBar = 96;                // INTERNAL_SPB
inline constexpr int kDrumMaxSteps = 4 * kDrumStepsPerBar; // MAX_STEPS (4 bars)
inline constexpr int kDrumRepeatRates = 13;
/// REPEAT_RATES in BEATS (index 0 = off): —, 1/2, 1/2T, 1/4, 1/4T, 1/8, 1/8T, 1/16, 1/16T, 1/32, 1/32T, 1/64, 1/64T
inline constexpr double kDrumRepeatBeats[kDrumRepeatRates] = {
    0.0, 2.0, 4.0 / 3.0, 1.0, 2.0 / 3.0, 0.5, 1.0 / 3.0, 0.25, 1.0 / 6.0, 0.125, 1.0 / 12.0, 0.0625, 1.0 / 24.0};

/// One drum pattern (the grid only — the graphs are engine-level). ~3 KB; heap-allocate like SeqPattern.
struct DrumPattern
{
    int bars = 2;                           // 1..4
    int stepsPerBar = kDrumStepsPerBar;     // the UI always sends 96 (tests may use a coarser grid)
    int stepCount = 2 * kDrumStepsPerBar;   // bars × stepsPerBar (≤ kDrumMaxSteps)
    std::uint64_t grid[kDrumMaxSteps] = {}; // bit L = lane L fires at this internal step

    void clear() noexcept
    {
        for (auto& g : grid)
            g = 0;
    }
};

/// The four step graphs (DrumState.stepVelocity / stepShift / stepPan / stepRepeat): engine-level, shared by every
/// pattern, indexed by internal step × lane. ~320 KB — heap-allocate.
struct DrumGraphs
{
    float velocity[kDrumMaxSteps][kDrumLanes];      // 0..1 (default 1)
    float shiftMs[kDrumMaxSteps][kDrumLanes];       // −50..50 (default 0)
    float pan[kDrumMaxSteps][kDrumLanes];           // −1..1 (default 0)
    std::uint8_t repeat[kDrumMaxSteps][kDrumLanes]; // 0..12 (default 0 = off)

    void clear() noexcept
    {
        for (int s = 0; s < kDrumMaxSteps; ++s)
            for (int l = 0; l < kDrumLanes; ++l)
            {
                velocity[s][l] = 1.0f;
                shiftMs[s][l] = 0.0f;
                pan[s][l] = 0.0f;
                repeat[s][l] = 0;
            }
    }
};

class DrumSequencer
{
  public:
    static constexpr int kMaxPending = 1024; // hits, sub-hits and sub-hit ends waiting for their block
    static constexpr int kMaxSwaps = 64;     // arranged-playback pattern swaps
    /// Steps are scheduled this far AHEAD of the block end: a SHIFT of −50 ms snapped to a PPQ pulse lands up to
    /// ~100 ms before its grid time (|round(−50/p)·p| ≤ 100 ms for p < 100 ms) — those hits must already be booked.
    static constexpr double kLookaheadSec = 0.11;
    /// ONE OWNER PER HIT (TS LIVE_OWNER_WINDOW): a lane hand-played within this window of a pattern hit IS that hit.
    static constexpr double kLiveOwnerWindowSec = 0.12;
    static constexpr double kSubHitGuardSec = 0.001; // TS: a roll fills the slot up to `next − 1 ms`

    void prepare(double sampleRate) noexcept;
    void reset() noexcept; // stop, forget patterns/graphs (non-RT use: prepare/release)

    // --- commands (audio thread, from Engine::apply) ---
    void setPattern(const DrumPattern* p) noexcept TERMINATOR_NONBLOCKING; // live: the steps not scheduled yet read it
    void schedulePattern(const DrumPattern* p, std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING;
    void clearScheduled() noexcept TERMINATOR_NONBLOCKING;
    void setGraphs(const DrumGraphs* g) noexcept TERMINATOR_NONBLOCKING; // nullptr = defaults
    void setLane(int lane, float volume, bool audible, std::int16_t group) noexcept TERMINATOR_NONBLOCKING;
    void setParams(double swing, float masterVolume, int ppq) noexcept TERMINATOR_NONBLOCKING;
    void setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING; // 20..300; applies at the next step
    /// Start with internal step `stepOffset` landing at engine sample `atSample` (≥ the current block start; 0 = the
    /// start of the next block). Restarts when playing.
    void play(std::uint64_t atSample, int stepOffset, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING;
    /// Stop scheduling, drop the pending events + swaps, fade every drum-lane voice (TS stop: every lane voice is cut).
    void stop(Sampler& sampler) noexcept TERMINATOR_NONBLOCKING;

    /// Schedule + fire this block's events into the sampler. `liveHitSample` (kMaxPads entries, engine samples;
    /// nullptr = none) = when each pad was last LIVE triggered — a pattern hit within kLiveOwnerWindowSec is skipped.
    void process(std::uint64_t blockStart, int numSamples, Sampler& sampler,
                 const double* liveHitSample = nullptr) noexcept TERMINATOR_NONBLOCKING;

    // --- read-back for the snapshot (audio thread) ---
    bool playing() const noexcept { return playing_; }
    double bpm() const noexcept { return bpm_; }
    int stepCount() const noexcept { return total(); }
    int currentStep() const noexcept { return playing_ ? currentStep_ : -1; }
    double stepPhase() const noexcept { return playing_ ? currentPhase_ : 0.0; }
    /// Engine sample of the current (audible) pass's step 0 — the page's `playStartTime` (rounded; negative after a
    /// seek that puts step 0 before the engine's sample 0).
    std::int64_t loopStartSample() const noexcept { return static_cast<std::int64_t>(std::llround(audibleLoopStart_)); }
    std::uint64_t hitsFired() const noexcept { return hitsFired_; }
    std::uint64_t hitsSkippedLiveOwned() const noexcept { return hitsSkipped_; }
    int laneGroup(int lane) const noexcept { return lane >= 0 && lane < kDrumLanes ? lanes_[lane].group : 0; }
    /// The steps scheduled since the last take (straight grid time, duration, index, steps per bar) — the metronome
    /// places its beats on them when the drums drive the transport alone (Phase 3.6). Drains; returns the count.
    int takeGridLog(GridStep* out, int maxOut) noexcept TERMINATOR_NONBLOCKING;

  private:
    struct Lane
    {
        float volume = 1.0f;
        bool audible = true;
        std::int16_t group = 0;
    };
    struct PendingEvent
    {
        double sample;
        float velocity;
        float pan;
        std::uint16_t lane;
        std::uint8_t kind; // 0 = sub-hit end (fade), 1 = hit, 2 = sub-hit
        bool used;
    };
    struct Swap
    {
        const DrumPattern* pattern;
        double atSample;
        bool used;
    };
    int total() const noexcept TERMINATOR_NONBLOCKING;
    const DrumPattern* patternAt(double sample) const noexcept TERMINATOR_NONBLOCKING;
    double stepDurSamples(const DrumPattern* p) const noexcept TERMINATOR_NONBLOCKING;
    void scheduleStep(const DrumPattern& p, int step, double gridSample,
                      const Sampler& sampler) noexcept TERMINATOR_NONBLOCKING;
    void pushEvent(double sample, int lane, float velocity, float pan,
                   std::uint8_t kind) noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    double bpm_ = 120.0;
    double swing_ = 0.0;
    float master_ = 1.0f;
    int ppq_ = 960;
    bool playing_ = false;
    const DrumPattern* pat_ = nullptr;
    const DrumGraphs* graphs_ = nullptr;
    Lane lanes_[kDrumLanes] = {};
    Swap swaps_[kMaxSwaps] = {};
    int nextStep_ = 0;            // the next internal step to schedule
    double nextStepSample_ = 0;   // its straight grid time (absolute engine sample)
    double schedLoopStart_ = 0;   // grid time of the pass being SCHEDULED (runs ≤ kLookaheadSec ahead)
    double audibleLoopStart_ = 0; // grid time of the pass the playhead is IN (published)
    int currentStep_ = -1;
    double currentPhase_ = 0.0;
    PendingEvent pending_[kMaxPending] = {};
    std::uint64_t hitsFired_ = 0;
    std::uint64_t hitsSkipped_ = 0;
    GridStep gridLog_[kMaxGridLog] = {};
    int gridLogCount_ = 0;
};

} // namespace terminator
