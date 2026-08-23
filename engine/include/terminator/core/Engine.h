#pragma once
// The engine. One instance per app/render. Lifecycle: prepare() [non-RT] → process() × N [RT] → release()
// [non-RT]. UI talks to it only through commands() (lock-free queue) and reads back only through
// snapshot(). Phase 1: pad sampler (voices, varispeed, envelopes, choke, per-pad output pair), test tone,
// master gain, transport counter, host-clock mapping, MIDI note map, loopback calibration.
#include <cstdint>
#include <memory>
#include <vector>

#include "terminator/core/Arp.h"
#include "terminator/core/BassSequencer.h"
#include "terminator/core/BassSynth.h"
#include "terminator/core/ChopSequencer.h"
#include "terminator/core/Command.h"
#include "terminator/core/DrumSequencer.h"
#include "terminator/core/CommandQueue.h"
#include "terminator/core/HostClock.h"
#include "terminator/core/Metronome.h"
#include "terminator/core/MidiClock.h"
#include "terminator/core/Mixer.h"
#include "terminator/core/fx/FxPool.h"
#include "terminator/core/RtAssert.h"
#include "terminator/core/Sampler.h"
#include "terminator/core/StateSnapshot.h"

namespace terminator
{

/// A timestamped raw MIDI message from a driver thread (see io/MidiHub). Consumed on the audio thread.
struct MidiEvent
{
    std::uint64_t hostTimeNs = 0;
    std::uint8_t data[3] = {0, 0, 0};
    std::uint8_t size = 0;
    std::uint8_t port = 0;
};
static_assert(std::is_trivially_copyable_v<MidiEvent>);

/// A MIDI message the ENGINE sends (Phase 3.5: the clock OUT — SPP/START/CONTINUE/STOP/ticks), produced on the
/// audio thread at its exact engine sample, stamped with the host time that sample is HEARD (block entry + offset +
/// the device's output latency). Consumed by io/MidiHub's pump thread, which sends it at that host time (0 = send
/// at once: no host clock — tests / offline).
struct MidiOutEvent
{
    std::uint64_t hostTimeNs = 0;
    std::uint64_t sample = 0;
    std::uint8_t data[3] = {0, 0, 0};
    std::uint8_t size = 0;
};
static_assert(std::is_trivially_copyable_v<MidiOutEvent>);

class Engine
{
  public:
    struct Config
    {
        double sampleRate = 48000.0;
        int maxBlockSize = 512;
        int numOutputChannels = 2;
        int numInputChannels = 0;
        int outputLatencySamples = 0; // the device's reported output latency — MIDI OUT stamps "heard at" with it
    };

    static constexpr std::size_t kCommandQueueCapacity = 1024;
    static constexpr std::size_t kMidiQueueCapacity = 1024;
    static constexpr std::size_t kMidiOutQueueCapacity = 1024;
    static constexpr int kMaxMidiPorts = 16;
    static constexpr int kMaxPendingTriggers = 64; // live hits booked past the current block (quantized live record)
    static constexpr std::uint32_t kCalibrationMaxFrames = 2 * 192000; // 2 s at 192 kHz
    static constexpr int kCalibrationClickFrames = 64;

    using Commands = SpscQueue<Command, kCommandQueueCapacity>;
    using MidiQueue = SpscQueue<MidiEvent, kMidiQueueCapacity>;
    using MidiOutQueue = SpscQueue<MidiOutEvent, kMidiOutQueueCapacity>;

    Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    // --- non-RT --------------------------------------------------------------------------------
    void prepare(const Config& config);
    void release();
    bool isPrepared() const noexcept { return prepared_; }
    const Config& config() const noexcept { return config_; }

    /// Producer side of the command queue — message thread only.
    Commands& commands() noexcept { return *commands_; }
    /// One MIDI input queue per port (producer = that port's driver thread).
    MidiQueue& midiQueue(int port) noexcept
    {
        const int clamped = port < 0 ? 0 : (port >= kMaxMidiPorts ? kMaxMidiPorts - 1 : port);
        return midiQueues_[static_cast<std::size_t>(clamped)];
    }

    /// MIDI the engine SENDS (the clock OUT, Phase 3.5) — consumer = io/MidiHub's pump thread (any one non-RT thread).
    MidiOutQueue& midiOut() noexcept { return *midiOut_; }

    /// Latest engine state — message thread only.
    const StateSnapshot& snapshot() noexcept { return snapshot_.read(); }

    /// Calibration capture buffer: readable on the message thread once snapshot().calibrationState == 2.
    const float* calibrationCapture() const noexcept { return calibCapture_.data(); }
    std::uint32_t calibrationCaptureFrames() const noexcept { return calibRecorded_; }
    /// The click that was emitted (kCalibrationClickFrames long), for cross-correlation.
    static const float* calibrationClick() noexcept;

    /// Pad read-back for the UI (message thread; pads only change via commands so this is stable enough to read).
    const Pad& pad(int i) const noexcept { return sampler_.pad(i); }
    /// The bass synth (tests render it directly; the app only talks to it through commands).
    BassSynth& bassSynth() noexcept { return bass_; }
    /// The mixer's read-back (settings / meters / masks) — tests; the app reads the snapshot.
    const Mixer& mixer() const noexcept { return *mixer_; }

    // --- RT ------------------------------------------------------------------------------------
    /// Renders numSamples into outputs[0..numOut). Always overwrites. inputs may be null / numIn 0. Safe to call
    /// before prepare() (renders silence). hostTimeNs = host time at callback entry (0 = unknown).
    void process(const float* const* inputs, int numIn, float* const* outputs, int numOut, int numSamples,
                 std::uint64_t hostTimeNs) noexcept TERMINATOR_NONBLOCKING;
    /// Output-only convenience (offline renders, tests).
    void process(float* const* outputs, int numChannels, int numSamples) noexcept TERMINATOR_NONBLOCKING
    {
        process(nullptr, 0, outputs, numChannels, numSamples, 0);
    }

  private:
    void drainCommands(int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void drainMidi(int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void apply(const Command& c, int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void setTestToneFrequency(float hz) noexcept TERMINATOR_NONBLOCKING;
    std::int32_t offsetForHostTime(std::uint64_t hostTimeNs, int numSamples) const noexcept TERMINATOR_NONBLOCKING;
    void publish(int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void firePendingTriggers(int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void bookTrigger(std::uint16_t pad, float velocity, std::uint64_t atSample, bool release, int numSamples,
                     bool hasPan = false, float pan = 0.0f) noexcept TERMINATOR_NONBLOCKING;
    void noteLiveHit(std::uint16_t pad, double atSample) noexcept TERMINATOR_NONBLOCKING
    {
        if (pad < kMaxPads)
        {
            liveHitSample_[pad] = atSample;
            lastLiveHitPad_ = pad;
            lastLiveHitSample_ = atSample > 0.0 ? static_cast<std::uint64_t>(atSample) : 0;
        }
    }

    Config config_{};
    bool prepared_ = false;

    // The big fixed buffers live on the heap (allocated ONCE in the constructor — non-RT) so an Engine value is
    // small enough for any stack (Windows threads default to 1 MB; the capture buffer alone is 1.5 MB).
    std::unique_ptr<Commands> commands_;
    std::vector<MidiQueue> midiQueues_;
    std::unique_ptr<MidiOutQueue> midiOut_;
    SnapshotPublisher<StateSnapshot> snapshot_;
    Sampler sampler_;
    ChopSequencer seq_;     // the chop sequencer on the sample clock (Phase 3.1)
    DrumSequencer drums_;   // the drum sequencer on the same clock (Phase 3.3) — lanes = pads kDrumPadBase..
    BassSynth bass_;        // the bass synth (Phase 3.4) — dry into outs 1/2 until Phase 4 routes it to its strip
    BassSequencer bassSeq_; // its pattern player on the same clock
    MidiClockOut clockOut_; // MIDI clock OUT from the transport (Phase 3.5) — anchored with seqPlay / drumPlay
    MidiClockOut::Event clockEvents_[MidiClockOut::kMaxEventsPerBlock] = {};
    Metronome metro_; // the click + count-in (Phase 3.6) — beats on the driving sequencer's grid
    Arp arp_;         // the arp (Phase 3.6) — steps on the sample clock
    std::unique_ptr<Mixer> mixer_; // the strips / sends / buses / master (Phase 4.1) — pads, drum lanes, the bass and the click
                      // (on the heap: 64 strips of meter rings are 177 KB — an Engine VALUE must fit a 1 MB Windows stack)
                      // with a strip sum into it in 64-bit; the direct paths (strip −1) stay as in Phase 3
    FxPool fxPool_;   // every insert device the chains can hold, built + prepared up front (Phase 4.2)
    std::vector<float> scratchL_, scratchR_; // a source's block on its way into a strip (prepare-sized)
    int bassStrip_ = -1;                     // setSourceStrip 0: the bass synth's strip (−1 = dry into outs 1/2)
    int clickStrip_ = -1;                    // setSourceStrip 1: the metronome's strip (−1 = direct, post master gain)
    GridStep gridLog_[kMaxGridLog] = {};
    bool midiNotesToPads_ = true; // setMidiRouting: MIDI notes play pads on the direct path (off while the page
                                  // routes notes elsewhere — bass MIDI IN, DRUM PADS mode, MIDI OFF, learn)

    // RT state (owned by the audio thread after prepare)
    float masterGainTarget_ = 1.0f;
    float masterGainCurrent_ = 1.0f;
    bool playing_ = false;
    bool seqWasPlaying_ = false;
    bool drumsWasPlaying_ = false;
    std::uint64_t playheadSamples_ = 0;
    std::uint64_t blocksProcessed_ = 0;
    std::uint64_t samplesProcessed_ = 0;
    std::uint64_t commandsApplied_ = 0;
    std::uint64_t blockHostNs_ = 0;     // entry time of the CURRENT block
    std::uint64_t prevBlockHostNs_ = 0; // entry time of the previous block (MIDI offsets are relative to it)
    float outputPeak_[kMaxOutputChannels] = {};
    float inputPeak_[kMaxInputChannels] = {};

    // the last LIVE trigger (a command / a booked hit / a MIDI note on the direct path): pad + its engine sample — the
    // page's live-record probe compares it to the landed grid line (3.7)
    std::int32_t lastLiveHitPad_ = -1;
    std::uint64_t lastLiveHitSample_ = 0;
    // MIDI note → pad
    std::int16_t noteToPad_[128];
    // when each pad was last LIVE triggered (command / MIDI — not the sequencer), engine samples; feeds the chop
    // sequencer's one-owner-per-hit rule. A large negative value = never.
    double liveHitSample_[kMaxPads];
    /// triggerPadAtSample / releasePadAtSample aimed past the current block wait here (sample-exact, any lead).
    struct PendingTrigger
    {
        std::uint64_t sample;
        float velocity;
        float pan;
        std::uint16_t pad;
        bool release;
        bool hasPan;
        bool used;
    };
    PendingTrigger pendingTrig_[kMaxPendingTriggers] = {};

    // test tone — complex phasor rotation (no libm per sample)
    bool toneEnabled_ = false;
    float toneFrequencyHz_ = 440.0f;
    float toneAmplitude_ = 0.5f;
    std::uint8_t toneOutputPair_ = 0;
    double toneCos_ = 1.0, toneSin_ = 0.0;
    double toneRe_ = 1.0, toneIm_ = 0.0;

    // calibration
    std::uint32_t calibState_ = 0; // 0 idle 1 running 2 done 3 failed
    std::uint32_t calibId_ = 0;
    std::uint16_t calibOut_ = 0, calibIn_ = 0;
    std::uint32_t calibTarget_ = 0;   // frames to record
    std::uint32_t calibRecorded_ = 0; // frames recorded so far
    std::uint32_t calibClickPos_ = 0; // frames of the click emitted so far
    std::vector<float> calibCapture_; // kCalibrationMaxFrames, allocated in the constructor
};

} // namespace terminator
