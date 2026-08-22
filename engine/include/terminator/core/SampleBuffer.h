#pragma once
// Decoded audio in memory: float32 planar, any channel count, any sample rate. Owned by the SampleStore
// (message thread, shared_ptr); the engine only ever holds a raw const pointer handed over by command and
// never frees, resizes or writes. See SampleStore for the retire/collect lifetime rule.
#include <cstddef>
#include <cstdint>
#include <vector>

namespace terminator
{

struct SampleBuffer
{
    std::vector<float> data; // numChannels × numFrames, planar (channel-major)
    int numChannels = 0;
    std::int64_t numFrames = 0;
    double sampleRate = 0.0;
    std::uint32_t id = 0; // SampleStore id (0 = none)

    const float* channel(int ch) const noexcept
    {
        return data.data() + static_cast<std::size_t>(ch) * static_cast<std::size_t>(numFrames);
    }
    float* channel(int ch) noexcept
    {
        return data.data() + static_cast<std::size_t>(ch) * static_cast<std::size_t>(numFrames);
    }
    double durationSeconds() const noexcept
    {
        return sampleRate > 0.0 ? static_cast<double>(numFrames) / sampleRate : 0.0;
    }

    void allocate(int channels, std::int64_t frames, double rate)
    {
        numChannels = channels;
        numFrames = frames;
        sampleRate = rate;
        data.assign(static_cast<std::size_t>(channels) * static_cast<std::size_t>(frames), 0.0f);
    }
};

} // namespace terminator
