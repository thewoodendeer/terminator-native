#pragma once
// Synthetic SampleBuffers for engine tests (no files).
#include <cmath>
#include <memory>

#include "terminator/core/SampleBuffer.h"

namespace terminator::test
{
/// Mono ramp 0→1 over `frames` (value = i/(frames-1)).
inline std::shared_ptr<SampleBuffer> ramp(std::int64_t frames, double sampleRate = 48000.0, int channels = 1)
{
    auto s = std::make_shared<SampleBuffer>();
    s->allocate(channels, frames, sampleRate);
    for (int ch = 0; ch < channels; ++ch)
        for (std::int64_t i = 0; i < frames; ++i)
            s->channel(ch)[i] = static_cast<float>(i) / static_cast<float>(frames - 1) * (ch == 0 ? 1.0f : -1.0f);
    return s;
}
/// Constant DC value.
inline std::shared_ptr<SampleBuffer> dc(std::int64_t frames, float value, double sampleRate = 48000.0, int channels = 1)
{
    auto s = std::make_shared<SampleBuffer>();
    s->allocate(channels, frames, sampleRate);
    for (int ch = 0; ch < channels; ++ch)
        for (std::int64_t i = 0; i < frames; ++i)
            s->channel(ch)[i] = value;
    return s;
}
/// Sine at `hz`.
inline std::shared_ptr<SampleBuffer> sine(std::int64_t frames, double hz, double sampleRate = 48000.0)
{
    auto s = std::make_shared<SampleBuffer>();
    s->allocate(1, frames, sampleRate);
    for (std::int64_t i = 0; i < frames; ++i)
        s->channel(0)[i] =
            static_cast<float>(std::sin(2.0 * 3.14159265358979323846 * hz * static_cast<double>(i) / sampleRate));
    return s;
}
} // namespace terminator::test
