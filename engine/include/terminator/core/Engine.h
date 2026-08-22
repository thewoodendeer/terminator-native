#pragma once
// The engine. One instance per app/render. Lifecycle: prepare() [non-RT] → process() × N [RT] → release()
// [non-RT]. UI talks to it only through commands() (lock-free queue) and reads back only through
// snapshot(). Phase 0: a test tone + master gain + transport counter — the shape, not the sampler.
#include <cstdint>

#include "terminator/core/Command.h"
#include "terminator/core/CommandQueue.h"
#include "terminator/core/RtAssert.h"
#include "terminator/core/StateSnapshot.h"

namespace terminator
{

class Engine
{
  public:
    struct Config
    {
        double sampleRate = 48000.0;
        int maxBlockSize = 512;
        int numOutputChannels = 2;
    };

    static constexpr std::size_t kCommandQueueCapacity = 1024;
    using Commands = SpscQueue<Command, kCommandQueueCapacity>;

    Engine() = default;
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    // --- non-RT --------------------------------------------------------------------------------
    void prepare(const Config& config);
    void release();
    bool isPrepared() const noexcept { return prepared_; }
    const Config& config() const noexcept { return config_; }

    /// Producer side of the command queue — message thread only.
    Commands& commands() noexcept { return commands_; }

    /// Latest engine state — message thread only.
    const StateSnapshot& snapshot() noexcept { return snapshot_.read(); }

    // --- RT ------------------------------------------------------------------------------------
    /// Renders numSamples into outputs[0..numChannels). Always overwrites. Safe to call before
    /// prepare() (renders silence). No allocation, no locks, no I/O — RTSan-checked.
    void process(float* const* outputs, int numChannels, int numSamples) noexcept TERMINATOR_NONBLOCKING;

  private:
    void drainCommands() noexcept TERMINATOR_NONBLOCKING;
    void apply(const Command& c) noexcept TERMINATOR_NONBLOCKING;
    void setTestToneFrequency(float hz) noexcept TERMINATOR_NONBLOCKING;

    Config config_{};
    bool prepared_ = false;

    Commands commands_;
    SnapshotPublisher<StateSnapshot> snapshot_;

    // RT state (owned by the audio thread after prepare)
    float masterGainTarget_ = 1.0f;
    float masterGainCurrent_ = 1.0f;
    bool playing_ = false;
    std::uint64_t playheadSamples_ = 0;
    std::uint64_t blocksProcessed_ = 0;
    std::uint64_t samplesProcessed_ = 0;
    std::uint64_t commandsApplied_ = 0;

    // test tone — complex phasor rotation (no libm per sample)
    bool toneEnabled_ = false;
    float toneFrequencyHz_ = 440.0f;
    float toneAmplitude_ = 0.5f;
    double toneCos_ = 1.0, toneSin_ = 0.0; // rotation per sample
    double toneRe_ = 1.0, toneIm_ = 0.0;   // current phasor
};

} // namespace terminator
