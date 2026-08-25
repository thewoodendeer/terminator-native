#pragma once
// THE STEMS OF ONE SOURCE (Phase 7.1c) — four full-length planes (drums, bass, other, vocals) plus the READY
// RANGES that say which parts of them actually hold a separation yet.
//
// A split fills these span by span while it runs, so a pad can play its stem mix over the part that is done
// while the rest of the track is still being separated. The ranges are in SECONDS and merged, exactly like the
// page's `readyRanges` and the project tree's — `stems::spanReady` is the same predicate on both sides; a span
// that is not covered plays the ORIGINAL, never silence.
//
// The planes are SampleBuffers so the engine can read them straight (`Command::setPadStems` takes four of
// them). They match the source's frame count, rate and channel count, which is what the voice checks before it
// sums anything.
//
// Not real-time: filled on the split thread, read by the message thread. The buffers themselves are handed to
// the engine as shared pointers whose lifetime the app owns (the SampleStore's quarantine rules apply).
#include <array>
#include <cstdint>
#include <memory>
#include <vector>

#include "terminator/core/SampleBuffer.h"
#include "terminator/core/planners/StemMask.h"
#include "terminator/stems/SplitSession.h"

namespace terminator::stems
{
class StemSet
{
  public:
    StemSet() = default;
    /// Allocates four planes of `frames` × `channels` at `sampleRate` (silent until a chunk is written).
    StemSet(std::int64_t frames, int channels, double sampleRate);

    bool valid() const noexcept { return frames_ > 0 && planes_[0] != nullptr; }
    std::int64_t frames() const noexcept { return frames_; }
    int channels() const noexcept { return channels_; }
    double sampleRate() const noexcept { return sampleRate_; }

    /// Copy one ready span into the planes and record it. The chunk's frames are SOURCE frames; anything past
    /// the end of the planes is clipped. A mono set takes the left plane of each stem (the model was fed the
    /// same channel twice).
    void write(const ReadyChunk& chunk);

    /// Merged, sorted, in seconds — what the page and the project tree call `readyRanges`.
    const std::vector<ReadyRange>& ranges() const noexcept { return ranges_; }
    /// Is this span fully separated? (Same predicate the renderer and the page use.)
    bool ready(double startSec, double endSec) const noexcept { return spanReady(ranges_, startSec, endSec); }
    /// Seconds of audio separated so far.
    double readySeconds() const noexcept;

    std::shared_ptr<SampleBuffer> plane(int stem) const;
    /// The four raw pointers, in stem order, for `Command::setPadStems`.
    std::array<const SampleBuffer*, kStemCount> planePointers() const;

  private:
    std::array<std::shared_ptr<SampleBuffer>, kStemCount> planes_{};
    std::vector<ReadyRange> ranges_;
    std::int64_t frames_ = 0;
    int channels_ = 0;
    double sampleRate_ = 0.0;
};
} // namespace terminator::stems
