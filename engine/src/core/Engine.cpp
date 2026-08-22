#include "terminator/core/Engine.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

void Engine::prepare(const Config& config)
{
    TERMINATOR_RT_ASSERT(config.sampleRate > 0.0);
    TERMINATOR_RT_ASSERT(config.maxBlockSize > 0);
    TERMINATOR_RT_ASSERT(config.numOutputChannels >= 0);
    config_ = config;
    masterGainCurrent_ = masterGainTarget_;
    playheadSamples_ = 0;
    blocksProcessed_ = 0;
    samplesProcessed_ = 0;
    toneRe_ = 1.0;
    toneIm_ = 0.0;
    setTestToneFrequency(toneFrequencyHz_);
    prepared_ = true;

    StateSnapshot s{};
    s.sampleRate = config_.sampleRate;
    s.blockSize = static_cast<std::uint32_t>(config_.maxBlockSize);
    s.numOutputChannels = static_cast<std::uint32_t>(config_.numOutputChannels);
    s.prepared = 1;
    s.masterGain = masterGainCurrent_;
    s.testToneEnabled = toneEnabled_ ? 1u : 0u;
    s.testToneFrequencyHz = toneFrequencyHz_;
    snapshot_.publish(s);
}

void Engine::release()
{
    prepared_ = false;
    StateSnapshot s{};
    s.prepared = 0;
    s.masterGain = masterGainCurrent_;
    snapshot_.publish(s);
}

void Engine::setTestToneFrequency(float hz) noexcept TERMINATOR_NONBLOCKING
{
    toneFrequencyHz_ = hz;
    const double sr = config_.sampleRate > 0.0 ? config_.sampleRate : 48000.0;
    const double w = 2.0 * 3.14159265358979323846 * static_cast<double>(hz) / sr;
    toneCos_ = std::cos(w);
    toneSin_ = std::sin(w);
}

void Engine::apply(const Command& c) noexcept TERMINATOR_NONBLOCKING
{
    switch (c.type)
    {
    case CommandType::setMasterGain:
        masterGainTarget_ = std::clamp(c.payload.gain.linear, 0.0f, 4.0f);
        break;
    case CommandType::setTestTone:
        toneEnabled_ = c.payload.testTone.enabled != 0;
        toneAmplitude_ = std::clamp(c.payload.testTone.amplitude, 0.0f, 1.0f);
        if (c.payload.testTone.frequencyHz > 0.0f)
            setTestToneFrequency(c.payload.testTone.frequencyHz);
        break;
    case CommandType::transportPlay:
        playing_ = true;
        break;
    case CommandType::transportStop:
        playing_ = false;
        break;
    case CommandType::panic:
        playing_ = false;
        toneEnabled_ = false;
        break;
    case CommandType::none:
        break;
    }
    ++commandsApplied_;
}

void Engine::drainCommands() noexcept TERMINATOR_NONBLOCKING
{
    Command c;
    // Bounded: at most one full queue per block, so a flooding producer cannot starve the callback.
    for (std::size_t n = 0; n < Commands::capacity() && commands_.pop(c); ++n)
        apply(c);
}

void Engine::process(float* const* outputs, int numChannels, int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    if (outputs == nullptr || numChannels <= 0 || numSamples <= 0)
        return;

    if (!prepared_)
    {
        for (int ch = 0; ch < numChannels; ++ch)
            if (outputs[ch] != nullptr)
                std::fill_n(outputs[ch], numSamples, 0.0f);
        return;
    }

    drainCommands();

    // master gain: linear ramp over this block
    const float gainStart = masterGainCurrent_;
    const float gainEnd = masterGainTarget_;
    const float gainStep = (gainEnd - gainStart) / static_cast<float>(numSamples);

    float peak0 = 0.0f, peak1 = 0.0f;
    float* out0 = outputs[0];
    float* out1 = numChannels > 1 ? outputs[1] : nullptr;

    if (toneEnabled_ && out0 != nullptr)
    {
        float g = gainStart;
        for (int i = 0; i < numSamples; ++i)
        {
            const float v = static_cast<float>(toneIm_) * toneAmplitude_ * g;
            out0[i] = v;
            if (out1 != nullptr)
                out1[i] = v;
            const float a = v < 0.0f ? -v : v;
            peak0 = a > peak0 ? a : peak0;
            // rotate phasor
            const double re = toneRe_ * toneCos_ - toneIm_ * toneSin_;
            const double im = toneRe_ * toneSin_ + toneIm_ * toneCos_;
            toneRe_ = re;
            toneIm_ = im;
            g += gainStep;
        }
        // re-normalise once per block so the rotation never drifts in magnitude
        const double mag2 = toneRe_ * toneRe_ + toneIm_ * toneIm_;
        if (mag2 > 0.0)
        {
            const double k = 1.5 - 0.5 * mag2; // one Newton step of 1/sqrt
            toneRe_ *= k;
            toneIm_ *= k;
        }
        peak1 = out1 != nullptr ? peak0 : 0.0f;
    }
    else
    {
        for (int ch = 0; ch < numChannels; ++ch)
            if (outputs[ch] != nullptr)
                std::fill_n(outputs[ch], numSamples, 0.0f);
    }
    // any channels beyond 2 are silent for now
    for (int ch = 2; ch < numChannels; ++ch)
        if (outputs[ch] != nullptr)
            std::fill_n(outputs[ch], numSamples, 0.0f);

    masterGainCurrent_ = gainEnd;

    if (playing_)
        playheadSamples_ += static_cast<std::uint64_t>(numSamples);
    samplesProcessed_ += static_cast<std::uint64_t>(numSamples);
    ++blocksProcessed_;

    StateSnapshot s{};
    s.sampleRate = config_.sampleRate;
    s.blockSize = static_cast<std::uint32_t>(config_.maxBlockSize);
    s.numOutputChannels = static_cast<std::uint32_t>(config_.numOutputChannels);
    s.prepared = 1;
    s.playing = playing_ ? 1u : 0u;
    s.playheadSamples = playheadSamples_;
    s.blocksProcessed = blocksProcessed_;
    s.samplesProcessed = samplesProcessed_;
    s.masterGain = masterGainCurrent_;
    s.testToneEnabled = toneEnabled_ ? 1u : 0u;
    s.testToneFrequencyHz = toneFrequencyHz_;
    s.peak[0] = peak0;
    s.peak[1] = peak1;
    s.commandsApplied = commandsApplied_;
    s.commandsDropped = commands_.droppedCount();
    snapshot_.publish(s);
}

} // namespace terminator
