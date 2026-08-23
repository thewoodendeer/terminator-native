#pragma once
// Engine → UI state. The audio thread publishes a StateSnapshot once per block through a wait-free
// triple buffer; the UI thread reads the latest one on its 60 Hz timer. No locks, no allocation, and
// every slot is only ever touched by one thread at a time (no data race in the C++ sense).
#include <array>
#include <atomic>
#include <cstdint>
#include <type_traits>

#include "terminator/core/HostClock.h"
#include "terminator/core/Platform.h"
#include "terminator/core/RtAssert.h"

namespace terminator
{

/// Sampler pads: 0..63 = the chopper's pad grid (MIDI note − 36, the chop sequencer's bit masks), 64..127 = the
/// DRUM LANES (Phase 3.3, core/DrumSequencer.h: lane L plays pad kDrumPadBase + L).
inline constexpr int kChopPads = 64;
inline constexpr int kDrumPadBase = 64;
inline constexpr int kDrumLanes = 64;
inline constexpr int kMaxPads = kDrumPadBase + kDrumLanes; // 128
inline constexpr int kMaxOutputChannels = 32;
inline constexpr int kMaxInputChannels = 32;
inline constexpr int kMaxVoices = 256;
inline constexpr int kMaxStrips = 64; // mixer strips (Phase 4.1, core/Mixer.h): 0 = master, 1..63 the page's strips

struct StateSnapshot
{
    double sampleRate = 0.0;
    std::uint32_t blockSize = 0; // max block size given at prepare()
    std::uint32_t numOutputChannels = 0;
    std::uint32_t numInputChannels = 0;
    std::uint32_t prepared = 0; // 1 once prepare() ran, 0 after release()
    std::uint32_t playing = 0;
    std::uint64_t playheadSamples = 0; // advances only while playing
    std::uint64_t blocksProcessed = 0; // advances every process() call
    std::uint64_t samplesProcessed = 0;
    float masterGain = 1.0f; // current (post-ramp) value
    float testToneFrequencyHz = 0.0f;
    std::uint32_t testToneEnabled = 0;
    float peak[2] = {0.0f, 0.0f};              // per-block peak of outputs 0/1 (post master)
    float outputPeak[kMaxOutputChannels] = {}; // per-block peak of every output (post master)
    float inputPeak[kMaxInputChannels] = {};   // per-block peak of every input
    std::uint64_t commandsApplied = 0;
    std::uint64_t commandsDropped = 0; // producer-side drops (queue full) seen at publish time
    ClockPoint clock{};                // host-time ↔ sample mapping for this block

    // sampler
    std::uint32_t activeVoices = 0;
    std::uint32_t voiceStealing = 0;  // cumulative count of voices stolen because the pool was full
    std::uint64_t padActiveMask = 0;  // bit i = pad i has a sounding voice (pads 0..63, the chopper grid)
    std::uint64_t drumActiveMask = 0; // bit L = drum lane L (pad 64+L) has a sounding voice
    std::int32_t lastTriggeredPad = -1;
    double lastTriggeredPadPositionSec = 0.0; // position inside that pad's region (its buffer's seconds)
    std::int32_t lastLiveHitPad = -1;         // the last LIVE trigger (command / booked / MIDI direct): its pad …
    std::uint64_t lastLiveHitSample = 0;      // … and the engine sample it fired / was booked at (3.7)

    // chop sequencer (Phase 3.1)
    std::uint32_t seqPlaying = 0;
    std::uint32_t seqPaused = 0;
    std::uint32_t seqLoop = 1;
    std::int32_t seqStep = -1; // the step the playhead is in (−1 = stopped)
    std::int32_t seqStepCount = 0;
    std::int32_t seqPatternIndex = -1;
    double seqStepPhase = 0.0; // 0..1 inside that step at the block end
    double seqBpm = 120.0;
    std::uint64_t seqLoopStartSample = 0; // engine sample of the current pass's step 0
    std::uint64_t seqHitsFired = 0;
    std::uint64_t seqHitsSkipped = 0; // pattern hits skipped by the one-owner rule (a live hit owned the step)

    // drum sequencer (Phase 3.3, core/DrumSequencer.h) — 96 steps/bar on the same sample clock
    std::uint32_t drumPlaying = 0;
    std::int32_t drumStep = -1;           // the internal step (0..bars×96−1) the playhead is in (−1 = stopped)
    std::int32_t drumStepCount = 0;       // bars × stepsPerBar of the audible pattern
    double drumStepPhase = 0.0;           // 0..1 inside that step at the block end
    std::int64_t drumLoopStartSample = 0; // engine sample of the current pass's step 0 (the page's playStartTime; a
                                          // seek with stepOffset right after prepare can put it before sample 0)
    std::uint64_t drumHitsFired = 0;      // hits + note-repeat sub-hits dispatched to the sampler
    std::uint64_t drumHitsSkipped = 0;    // pattern hits skipped by the one-owner rule (a live hit owned the step)

    // bass synth + sequencer (Phase 3.4, core/BassSynth.h + core/BassSequencer.h)
    std::uint32_t bassPlaying = 0;
    std::uint32_t bassArrangerDriven = 0;
    std::int32_t bassTick = -1;     // the tick (0..loopTicks−1) the playhead is in at the block end (−1 = stopped)
    std::int32_t bassLoopTicks = 0; // bars × 4 × 96 of the playing pattern
    std::int64_t bassLoopStartSample = 0;   // engine sample of the current pass's tick 0 (signed)
    std::uint32_t bassVoices = 0;           // voices sounding at the block end
    float bassLevel = 0.0f;                 // the UI meter: peak over the last completed 1/30 s window
    std::uint64_t bassNoteMask[2] = {0, 0}; // bit n = a voice sounds MIDI note n (word 0 = 0..63, word 1 = 64..127)
    std::uint64_t bassNotesFired = 0;       // note-on events fired (seq + live + arr)
    std::uint64_t bassEventsDropped = 0;    // events the 512-slot ring refused (should stay 0)
    std::uint64_t bassTimelineFired = 0;    // arranger timeline events pushed
    double bassBend = 0.0;                  // the current pitch bend (semitones)

    // calibration
    std::uint32_t calibrationState =
        0; // 0 idle · 1 running · 2 done (buffer readable) · 3 failed (channel out of range)
    std::uint32_t calibrationId = 0;

    // MIDI clock OUT (Phase 3.5, core/MidiClock.h)
    std::uint32_t midiClockEnabled = 0;  // the preference (midiClockEnable)
    std::uint32_t midiClockRunning = 0;  // between START and STOP
    std::uint64_t midiClockTicks = 0;    // ticks generated since prepare (lifetime)
    std::uint64_t midiClockPosition = 0; // ticks since the last START (the song position × 6)
    std::uint64_t midiOutDropped = 0;    // out-queue refusals (the pump fell behind — should stay 0)
    std::uint32_t midiNotesToPads = 1;   // setMidiRouting

    // metronome + count-in + arp (Phase 3.6, core/Metronome.h + core/Arp.h)
    std::uint32_t metronomeEnabled = 0;
    std::uint32_t metronomeSound = 0;  // ClickSound
    std::int32_t metronomeBeat = -1;   // the last beat click's index in its bar 0..3 (−1 = none yet)
    std::uint64_t metronomeClicks = 0; // lifetime clicks fired (beats + count-in)
    std::uint64_t metronomeLastClickSample = 0;
    std::uint32_t metronomeLastClickAccent = 0;
    std::int32_t countInBeat = -1;           // −1 idle; N..1 while a count-in runs (the TS countInBeat)
    std::uint32_t countInPending = 0;        // between the countIn command and its downbeat
    std::uint64_t countInDownbeatSample = 0; // the sample the transport should start at (the last count-in's)
    std::uint32_t arpEnabled = 0;
    std::int32_t arpHoldPad = -1; // the pad held (−1 = nothing)
    std::int32_t arpStep = 0;     // steps fired since the hold
    std::int32_t arpLastPad = -1; // the pad the last step fired
    std::uint64_t arpHits = 0;    // lifetime arp steps fired

    // the mixer (Phase 4.1, core/Mixer.h)
    std::uint64_t mixerActiveMask = 0;       // bit k = strip k is live (kind ≠ off)
    std::uint64_t mixerSilentMask = 0;       // bit k = strip k is silenced by mute / the solo law (the target)
    std::uint32_t mixerRoutesRejected = 0;   // lifetime routes refused by the cycle guard
    std::uint32_t mixerOrderValid = 1;       // 0 = the graph had a loop and the fallback order runs (cannot happen)
    std::int32_t mixerMainOut = 0;           // the master's hardware pair
    std::int32_t bassStrip = -1;             // the bass synth's strip (−1 = direct to outs 1/2, the Phase-3 path)
    std::int32_t clickStrip = -1;            // the metronome's strip (−1 = direct, post master gain, the Phase-3 path)
    float stripPeakPre[kMaxStrips][2] = {};  // per strip: input peak over the 4096-sample window, L/R
    float stripPeakPost[kMaxStrips][2] = {}; // … output peak (post fader/mute/pan)
    float stripRmsPre[kMaxStrips] = {};      // … input RMS over the window (both channels pooled)
    float stripRmsPost[kMaxStrips] = {};
    float stripGain[kMaxStrips] = {};           // … the smoothed fader × mute gain at the block end (1 = unity)
    std::uint8_t stripFxCount[kMaxStrips] = {}; // … inserts in the chain (4.2)
    std::uint32_t mixerFxRejected = 0;          // lifetime mixerAddFx refusals (full / pool empty / not ported / dead)
    std::uint8_t mixerConsoleOn = 0;            // CONSOLE (4.2c): the desk stage is in on every live strip
    std::uint8_t mixerLimiterOn = 0;            // the master's safety limiter (4.2c)
};
static_assert(std::is_trivially_copyable_v<StateSnapshot>, "StateSnapshot must be trivially copyable");

/// Wait-free single-writer / single-reader triple buffer.
template <typename T> class SnapshotPublisher
{
    static_assert(std::is_trivially_copyable_v<T>, "SnapshotPublisher<T> needs a trivially copyable T");

  public:
    SnapshotPublisher() = default;
    SnapshotPublisher(const SnapshotPublisher&) = delete;
    SnapshotPublisher& operator=(const SnapshotPublisher&) = delete;

    /// Writer (audio) thread only. RT-safe.
    void publish(const T& value) noexcept TERMINATOR_NONBLOCKING
    {
        slots_[back_] = value;
        // Hand the freshly written slot to the middle and take whatever was there as the new back.
        const auto prev = middle_.exchange(back_ | kDirty, std::memory_order_acq_rel);
        back_ = prev & kIndexMask;
    }

    /// Reader (UI) thread only. Returns the newest published value (stable until the next read()).
    const T& read() noexcept
    {
        if ((middle_.load(std::memory_order_acquire) & kDirty) != 0)
        {
            const auto prev = middle_.exchange(front_, std::memory_order_acq_rel);
            front_ = prev & kIndexMask;
        }
        return slots_[front_];
    }

  private:
    static constexpr std::uint32_t kDirty = 0x4u;
    static constexpr std::uint32_t kIndexMask = 0x3u;

    std::array<T, 3> slots_{};
    std::uint32_t back_ = 0;  // owned by writer
    std::uint32_t front_ = 1; // owned by reader
    alignas(kCacheLine) std::atomic<std::uint32_t> middle_{2};
};

} // namespace terminator
