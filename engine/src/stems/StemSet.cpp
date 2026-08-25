#include "terminator/stems/StemSet.h"

#include <algorithm>

namespace terminator::stems
{
StemSet::StemSet(std::int64_t frames, int channels, double sampleRate)
    : frames_(std::max<std::int64_t>(0, frames)), channels_(std::clamp(channels, 1, 2)),
      sampleRate_(sampleRate > 0.0 ? sampleRate : 44100.0)
{
    if (frames_ <= 0)
        return;
    for (auto& p : planes_)
    {
        p = std::make_shared<SampleBuffer>();
        p->allocate(channels_, frames_, sampleRate_);
    }
}

void StemSet::write(const ReadyChunk& chunk)
{
    if (!valid() || chunk.stems.size() < static_cast<std::size_t>(kStemPlanes))
        return;
    const std::int64_t start = std::max<std::int64_t>(0, chunk.startFrame);
    const std::int64_t end = std::min(frames_, chunk.endFrame);
    if (end <= start)
        return;
    const std::int64_t offset = start - chunk.startFrame; // if the span started before frame 0
    const auto n = static_cast<std::size_t>(end - start);

    for (int stem = 0; stem < kStemCount; ++stem)
    {
        auto& buffer = *planes_[static_cast<std::size_t>(stem)];
        for (int ch = 0; ch < channels_; ++ch)
        {
            // Plane order is [drumsL, drumsR, bassL, bassR, …]; a mono set takes the left of each pair (the
            // model was handed the same channel twice, so the two are equal).
            const auto& src = chunk.stems[static_cast<std::size_t>(stem * 2 + ch)];
            if (static_cast<std::int64_t>(src.size()) < offset + static_cast<std::int64_t>(n))
                continue;
            std::copy(src.begin() + static_cast<std::ptrdiff_t>(offset),
                      src.begin() + static_cast<std::ptrdiff_t>(offset) + static_cast<std::ptrdiff_t>(n),
                      buffer.channel(ch) + start);
        }
    }
    ranges_ =
        addReadyRange(ranges_, {static_cast<double>(start) / sampleRate_, static_cast<double>(end) / sampleRate_});
}

double StemSet::readySeconds() const noexcept
{
    double total = 0.0;
    for (const auto& r : ranges_)
        total += r.end - r.start;
    return total;
}

std::shared_ptr<SampleBuffer> StemSet::plane(int stem) const
{
    return stem >= 0 && stem < kStemCount ? planes_[static_cast<std::size_t>(stem)] : nullptr;
}

std::array<const SampleBuffer*, kStemCount> StemSet::planePointers() const
{
    std::array<const SampleBuffer*, kStemCount> out{};
    for (int i = 0; i < kStemCount; ++i)
        out[static_cast<std::size_t>(i)] = planes_[static_cast<std::size_t>(i)].get();
    return out;
}
} // namespace terminator::stems
