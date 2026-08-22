#pragma once
// Multi-resolution waveform peaks, cached to disk — the native replacement for the Electron 256-bucket in-memory
// cache and for juce::AudioThumbnail (which we DON'T use: it lives in juce_audio_utils and pulls in GUI, and
// libterminator must stay UI-free for the Phase 11 plugin — B1 decision). A pyramid of (min,max) pairs at
// power-of-two bucket sizes is built once on the analysis thread, serialised to a small binary blob, and a
// cold re-open draws any zoom window instantly (gate: ≤ 100 ms) without touching the audio again.
//
// UI-free: this is plain arrays + a file. The renderer/UI asks for `window(startFrame, endFrame, outBuckets)`
// and gets one (min,max) per output column, picking the pyramid level whose buckets are ≤ the column width.
#include <cstdint>
#include <vector>

#include <juce_core/juce_core.h>

#include "terminator/core/SampleBuffer.h"

namespace terminator::analysis
{
struct MinMax
{
    float min = 0.0f;
    float max = 0.0f;
};

class WaveformPeaks
{
  public:
    static constexpr std::uint32_t kMagic = 0x54574B31; // "TWK1"
    static constexpr int kBaseBucketFrames = 256;       // finest level (the Electron bucket size)

    WaveformPeaks() = default;

    /// Build the pyramid from a decoded buffer (analysis thread). Channels are summed to mono for the peak view.
    void build(const SampleBuffer& buffer);
    /// Build directly from planar channels.
    void build(const std::vector<const float*>& channels, std::int64_t numFrames, double sampleRate);

    bool valid() const noexcept { return numFrames_ > 0 && !levels_.empty(); }
    std::int64_t numFrames() const noexcept { return numFrames_; }
    double sampleRate() const noexcept { return sampleRate_; }
    int numLevels() const noexcept { return static_cast<int>(levels_.size()); }

    /// One (min,max) per output column across [startFrame, endFrame). Picks the coarsest level whose bucket is
    /// still finer than a column, so the draw cost is ~outBuckets regardless of zoom. Clamped to the buffer.
    std::vector<MinMax> window(std::int64_t startFrame, std::int64_t endFrame, int outBuckets) const;

    /// Serialise / restore the pyramid to a small binary blob (little-endian). Returns false on I/O or format error.
    bool writeTo(const juce::File& file) const;
    bool readFrom(const juce::File& file);
    juce::MemoryBlock toMemory() const;
    bool fromMemory(const void* data, size_t size);

    /// A content key for the on-disk cache filename (sha1 of the audio is the caller's job; this is frames+rate).
    juce::String shapeKey() const;

  private:
    struct Level
    {
        int bucketFrames = 0;
        std::vector<MinMax> data;
    };
    std::int64_t numFrames_ = 0;
    double sampleRate_ = 0.0;
    std::vector<Level> levels_; // levels_[0] = finest (kBaseBucketFrames), each next = ×2
};
} // namespace terminator::analysis
