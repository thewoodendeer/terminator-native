#pragma once
// ChopSequencer — the chop step sequencer as a native EventSource on the engine's sample clock (Phase 3.1).
// The audio callback asks it every block for the hits inside [blockStart, blockEnd) and fires them at exact
// sample offsets: no look-ahead, no timers — a frozen UI thread never stalls or bursts the pattern.
// Semantics = ChopperEngine's playSeq / seqSchedulerTick / scheduleSeqStepAudio (dossier-sequencing-midi.md §1),
// on samples instead of AudioContext seconds:
//   • stepDur = 60/bpm × 4/resolution, re-read per step (a BPM change applies at the next step);
//   • SWING applied LIVE (swing::seqSwingOffsetSec on the stored step — the export formula; the "live is
//     straight, export swings" mismatch is resolved here the way Victor decided: live matches export);
//   • a pattern switch queued while playing adopts at the next step 0 (the loop boundary); a live edit of the
//     playing pattern (setPattern) applies to the steps not fired yet;
//   • per-mute-group note length: a hit ends (3 ms fade ending AT the next hit) at the next step where a pad of
//     the SAME tail group fires (wrapping when looping) else at the pattern end — tail group = the pad's choke
//     group (≥ 0) or the pad itself (−1 / −2 poly: "a polyphonic pad still ends at its own next hit");
//   • loop off: the transport stops after the last step's slot; pause freezes the position, resume shifts.
// Patterns are built on the message thread (SeqPattern is a plain struct; the UI's SeqPattern JSON → grid bit
// masks + per-cell velocity) and handed over by POINTER; the owner keeps them alive (the shell's ring) — the
// sequencer only reads. Everything here is RT: no allocation, no locks (see RT-RULES.md).
#include <cstdint>

#include "terminator/core/Metronome.h"
#include "terminator/core/RtAssert.h"
#include "terminator/core/Sampler.h"

namespace terminator
{

inline constexpr int kSeqMaxSteps = 1536; // SEQ_MAX_STEPS: 4 bars × 384/bar
inline constexpr int kSeqMaxPads = 64;

/// One stored chop pattern, RT-readable. ~400 KB (per-cell velocity) — heap-allocate (std::make_shared).
struct SeqPattern
{
    int index = 0;       // the UI's sequence index (echoed in the snapshot)
    int bars = 2;        // 1..4
    int resolution = 16; // stored steps per bar
    int stepCount = 32;  // min(kSeqMaxSteps, bars × resolution)
    bool loop = true;
    double swing = 0.0;                             // 0..1, 16T (applied live)
    std::uint64_t grid[kSeqMaxSteps] = {};          // bit p = pad p fires at this step
    float velocity[kSeqMaxSteps][kSeqMaxPads] = {}; // 0.05..1 per lit cell (1 when the UI stored none)

    void clear() noexcept
    {
        for (auto& g : grid)
            g = 0;
        for (auto& row : velocity)
            for (auto& v : row)
                v = 1.0f;
    }
};

class ChopSequencer
{
  public:
    static constexpr int kMaxPending = 512;       // hits + note ends waiting inside/after the current block
    static constexpr double kTailFadeSec = 0.003; // the 3 ms stop fade ends AT the next same-group hit
    /// ONE OWNER PER HIT (TS lastLivePadHit / LIVE_OWNER_WINDOW): a pad hand-played within this window of a
    /// step's hit IS that step's audio — the pattern's copy is skipped (at fire time), so a live-recorded hit is
    /// never double-triggered (the group choke would restart the chop from its head — his "cut short" report).
    static constexpr double kLiveOwnerWindowSec = 0.12;

    void prepare(double sampleRate) noexcept;
    void reset() noexcept; // stop, forget patterns (non-RT use: prepare/release)

    // --- commands (audio thread, from Engine::apply) ---
    void setPattern(const SeqPattern* p) noexcept TERMINATOR_NONBLOCKING; // live: the steps not fired yet read it
    /// Switch at the next step 0 (nullptr while playing = cancel a pending switch; nullptr when stopped = no-op).
    void queuePattern(const SeqPattern* p) noexcept TERMINATOR_NONBLOCKING;
    void setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING; // 20..300; applies at the next step
    void setLoop(bool loop) noexcept TERMINATOR_NONBLOCKING;
    /// Start at engine sample `atSample` (≥ the current block start; 0 = the start of the next block). Restarts.
    void play(std::uint64_t atSample, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING;
    void stop() noexcept TERMINATOR_NONBLOCKING;
    /// Freeze the position; the notes the sequencer started are faded now (TS pauseSeq stops its scheduled
    /// sources) — only the hits not yet fired survive the pause and shift on resume.
    void pause(std::uint64_t blockStart, Sampler& sampler) noexcept TERMINATOR_NONBLOCKING;
    void resume(std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING;

    /// Fire this block's hits + note ends into the sampler. Call once per block after the commands were applied.
    /// `liveHitSample` (kSeqMaxPads entries, engine samples; nullptr = none) = when each pad was last LIVE
    /// triggered (a command / MIDI note, not the sequencer) — a pattern hit within kLiveOwnerWindowSec of it is
    /// skipped (one owner per hit).
    void process(std::uint64_t blockStart, int numSamples, Sampler& sampler,
                 const double* liveHitSample = nullptr) noexcept TERMINATOR_NONBLOCKING;

    // --- read-back for the snapshot (audio thread) ---
    bool playing() const noexcept { return playing_; }
    bool paused() const noexcept { return paused_; }
    /// The pattern's own `loop` unless seqSetLoop overrode it (cleared by the next setPattern/queuePattern).
    bool loop() const noexcept
    {
        return loopOverride_ >= 0 ? loopOverride_ != 0 : (pat_ != nullptr ? pat_->loop : true);
    }
    double bpm() const noexcept { return bpm_; }
    int patternIndex() const noexcept { return pat_ != nullptr ? pat_->index : -1; }
    int stepCount() const noexcept { return pat_ != nullptr ? pat_->stepCount : 0; }
    int currentStep() const noexcept { return currentStep_; }
    /// 0..1 inside the current step at `atSample` (the block end when publishing).
    double stepPhase(std::uint64_t atSample) const noexcept TERMINATOR_NONBLOCKING;
    std::uint64_t loopStartSample() const noexcept
    {
        return static_cast<std::uint64_t>(loopStart_ > 0.0 ? loopStart_ : 0.0);
    }
    std::uint64_t hitsFired() const noexcept { return hitsFired_; }
    std::uint64_t hitsSkippedLiveOwned() const noexcept { return hitsSkipped_; }
    /// The steps scheduled since the last take (their straight grid time, duration, index, resolution) — the
    /// metronome places its beats on them (Phase 3.6). Drains the log; returns the count written (≤ maxOut).
    int takeGridLog(GridStep* out, int maxOut) noexcept TERMINATOR_NONBLOCKING;

  private:
    /// A hit or a note end waiting for its block. One ring for both so they fire in TIME order (a note end and a
    /// hit of the same pad can sit in one block — a per-pad "next end" slot lost the earlier end; caught by the
    /// block-size invariance test).
    struct PendingEvent
    {
        double sample; // absolute engine sample (double — swing offsets are fractional)
        float velocity;
        std::uint16_t pad;
        std::uint8_t kind; // 0 = note end (3 ms fade), 1 = hit
        bool used;
    };
    double stepDurSamples(const SeqPattern& p) const noexcept TERMINATOR_NONBLOCKING;
    int tailKey(int pad, const Sampler& sampler) const noexcept TERMINATOR_NONBLOCKING;
    void scheduleStep(const SeqPattern& p, int step, double gridSample,
                      const Sampler& sampler) noexcept TERMINATOR_NONBLOCKING;
    void pushEvent(double sample, int pad, float velocity, std::uint8_t kind) noexcept TERMINATOR_NONBLOCKING;
    void shiftTimes(double delta) noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    double bpm_ = 120.0;
    bool playing_ = false;
    bool paused_ = false;
    int loopOverride_ = -1; // −1 = follow the pattern
    const SeqPattern* pat_ = nullptr;
    const SeqPattern* queued_ = nullptr;
    int nextStep_ = 0;          // the next step to schedule
    double nextStepSample_ = 0; // its grid time (absolute engine sample)
    double loopStart_ = 0;      // grid time of the current pass's step 0
    int currentStep_ = -1;      // the step the playhead is in (for the UI cursor)
    double currentStepStart_ = 0;
    double currentStepDur_ = 1;
    double pausedAt_ = 0;
    PendingEvent pending_[kMaxPending] = {};
    std::uint64_t hitsFired_ = 0;
    std::uint64_t hitsSkipped_ = 0; // pattern hits skipped because a live hit owned them
    double stopAfter_ = -1.0;       // loop off: the transport stops once this sample passed
    GridStep gridLog_[kMaxGridLog] = {};
    int gridLogCount_ = 0;
};

} // namespace terminator
