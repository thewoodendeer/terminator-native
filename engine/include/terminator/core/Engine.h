#pragma once
// The engine. One instance per app/render. Lifecycle: prepare() [non-RT] → process() × N [RT] → release()
// [non-RT]. UI talks to it only through commands() (lock-free queue) and reads back only through
// snapshot(). Phase 1: pad sampler (voices, varispeed, envelopes, choke, per-pad output pair), test tone,
// master gain, transport counter, host-clock mapping, MIDI note map, loopback calibration.
#include <cstdint>
#include <memory>
#include <vector>

#include "terminator/core/ChopSequencer.h"
#include "terminator/core/Command.h"
#include "terminator/core/CommandQueue.h"
#include "terminator/core/HostClock.h"
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

class Engine
{
  public:
    struct Config
    {
        double sampleRate = 48000.0;
        int maxBlockSize = 512;
        int numOutputChannels = 2;
        int numInputChannels = 0;
    };

    static constexpr std::size_t kCommandQueueCapacity = 1024;
    static constexpr std::size_t kMidiQueueCapacity = 1024;
    static constexpr int kMaxMidiPorts = 16;
    static constexpr int kMaxPendingTriggers = 64; // live hits booked past the current block (quantized live record)
    static constexpr std::uint32_t kCalibrationMaxFrames = 2 * 192000; // 2 s at 192 kHz
    static constexpr int kCalibrationClickFrames = 64;

    using Commands = SpscQueue<Command, kCommandQueueCapacity>;
    using MidiQueue = SpscQueue<MidiEvent, kMidiQueueCapacity>;

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

    /// Latest engine state — message thread only.
    const StateSnapshot& snapshot() noexcept { return snapshot_.read(); }

    /// Calibration capture buffer: readable on the message thread once snapshot().calibrationState == 2.
    const float* calibrationCapture() const noexcept { return calibCapture_.data(); }
    std::uint32_t calibrationCaptureFrames() const noexcept { return calibRecorded_; }
    /// The click that was emitted (kCalibrationClickFrames long), for cross-correlation.
    static const float* calibrationClick() noexcept;

    /// Pad read-back for the UI (message thread; pads only change via commands so this is stable enough to read).
    const Pad& pad(int i) const noexcept { return sampler_.pad(i); }

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
    void bookTrigger(std::uint16_t pad, float velocity, std::uint64_t atSample, bool release,
                     int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void noteLiveHit(std::uint16_t pad, double atSample) noexcept TERMINATOR_NONBLOCKING
    {
        if (pad < kMaxPads)
            liveHitSample_[pad] = atSample;
    }

    Config config_{};
    bool prepared_ = false;

    // The big fixed buffers live on the heap (allocated ONCE in the constructor — non-RT) so an Engine value is
    // small enough for any stack (Windows threads default to 1 MB; the capture buffer alone is 1.5 MB).
    std::unique_ptr<Commands> commands_;
    std::vector<MidiQueue> midiQueues_;
    SnapshotPublisher<StateSnapshot> snapshot_;
    Sampler sampler_;
    ChopSequencer seq_; // the chop sequencer on the sample clock (Phase 3.1)

    // RT state (owned by the audio thread after prepare)
    float masterGainTarget_ = 1.0f;
    float masterGainCurrent_ = 1.0f;
    bool playing_ = false;
    bool seqWasPlaying_ = false;
    std::uint64_t playheadSamples_ = 0;
    std::uint64_t blocksProcessed_ = 0;
    std::uint64_t samplesProcessed_ = 0;
    std::uint64_t commandsApplied_ = 0;
    std::uint64_t blockHostNs_ = 0;     // entry time of the CURRENT block
    std::uint64_t prevBlockHostNs_ = 0; // entry time of the previous block (MIDI offsets are relative to it)
    float outputPeak_[kMaxOutputChannels] = {};
    float inputPeak_[kMaxInputChannels] = {};

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
        std::uint16_t pad;
        bool release;
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
