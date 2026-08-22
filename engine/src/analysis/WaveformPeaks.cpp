#include "terminator/analysis/WaveformPeaks.h"

#include <algorithm>
#include <cmath>

namespace terminator::analysis
{
void WaveformPeaks::build(const SampleBuffer& buffer)
{
    std::vector<const float*> ch;
    for (int c = 0; c < buffer.numChannels; ++c)
        ch.push_back(buffer.channel(c));
    build(ch, buffer.numFrames, buffer.sampleRate);
}

void WaveformPeaks::build(const std::vector<const float*>& channels, std::int64_t numFrames, double sampleRate)
{
    numFrames_ = numFrames;
    sampleRate_ = sampleRate;
    levels_.clear();
    if (numFrames <= 0 || channels.empty())
        return;
    const int nCh = static_cast<int>(channels.size());

    // finest level: (min,max) of the mono sum over each kBaseBucketFrames window
    const int base = kBaseBucketFrames;
    const auto baseBuckets = static_cast<std::size_t>((numFrames + base - 1) / base);
    Level l0;
    l0.bucketFrames = base;
    l0.data.resize(baseBuckets);
    for (std::size_t b = 0; b < baseBuckets; ++b)
    {
        const std::int64_t s = static_cast<std::int64_t>(b) * base;
        const std::int64_t e = std::min<std::int64_t>(s + base, numFrames);
        float mn = 0.0f, mx = 0.0f;
        bool first = true;
        for (std::int64_t i = s; i < e; ++i)
        {
            float v = 0.0f;
            for (int c = 0; c < nCh; ++c)
                v += channels[static_cast<std::size_t>(c)][i];
            v /= static_cast<float>(nCh);
            if (first)
            {
                mn = mx = v;
                first = false;
            }
            else
            {
                mn = std::min(mn, v);
                mx = std::max(mx, v);
            }
        }
        l0.data[b] = {mn, mx};
    }
    levels_.push_back(std::move(l0));

    // coarser levels: halve the bucket count each step by combining pairs, down to ≤ 2 buckets
    while (levels_.back().data.size() > 2)
    {
        const auto& prev = levels_.back();
        Level lvl;
        lvl.bucketFrames = prev.bucketFrames * 2;
        lvl.data.resize((prev.data.size() + 1) / 2);
        for (std::size_t i = 0; i < lvl.data.size(); ++i)
        {
            const auto a = prev.data[i * 2];
            const bool hasB = i * 2 + 1 < prev.data.size();
            const auto b = hasB ? prev.data[i * 2 + 1] : a;
            lvl.data[i] = {std::min(a.min, b.min), std::max(a.max, b.max)};
        }
        levels_.push_back(std::move(lvl));
    }
}

std::vector<MinMax> WaveformPeaks::window(std::int64_t startFrame, std::int64_t endFrame, int outBuckets) const
{
    std::vector<MinMax> out;
    if (!valid() || outBuckets <= 0)
        return out;
    startFrame = std::clamp<std::int64_t>(startFrame, 0, numFrames_);
    endFrame = std::clamp<std::int64_t>(endFrame, startFrame + 1, numFrames_);
    const double span = static_cast<double>(endFrame - startFrame);
    const double colFrames = span / static_cast<double>(outBuckets);
    // pick the coarsest level whose bucket is still ≤ a column (so we read ~a few buckets per column, never audio)
    const Level* level = &levels_.front();
    for (const auto& l : levels_)
    {
        if (static_cast<double>(l.bucketFrames) <= colFrames)
            level = &l;
        else
            break;
    }
    out.resize(static_cast<std::size_t>(outBuckets));
    for (int i = 0; i < outBuckets; ++i)
    {
        const std::int64_t cs = startFrame + static_cast<std::int64_t>(std::floor(i * colFrames));
        const std::int64_t ce = startFrame + static_cast<std::int64_t>(std::floor((i + 1) * colFrames));
        const std::int64_t bs = cs / level->bucketFrames;
        const std::int64_t be = std::max<std::int64_t>(bs, (ce - 1) / level->bucketFrames);
        float mn = 0.0f, mx = 0.0f;
        bool first = true;
        for (std::int64_t b = bs; b <= be && b < static_cast<std::int64_t>(level->data.size()); ++b)
        {
            const auto& mm = level->data[static_cast<std::size_t>(b)];
            if (first)
            {
                mn = mm.min;
                mx = mm.max;
                first = false;
            }
            else
            {
                mn = std::min(mn, mm.min);
                mx = std::max(mx, mm.max);
            }
        }
        out[static_cast<std::size_t>(i)] = {mn, mx};
    }
    return out;
}

juce::MemoryBlock WaveformPeaks::toMemory() const
{
    juce::MemoryOutputStream os;
    os.writeInt(static_cast<int>(kMagic));
    os.writeInt64(numFrames_);
    os.writeDouble(sampleRate_);
    os.writeInt(static_cast<int>(levels_.size()));
    for (const auto& l : levels_)
    {
        os.writeInt(l.bucketFrames);
        os.writeInt64(static_cast<juce::int64>(l.data.size()));
        os.write(l.data.data(), l.data.size() * sizeof(MinMax));
    }
    return os.getMemoryBlock();
}

bool WaveformPeaks::fromMemory(const void* data, size_t size)
{
    juce::MemoryInputStream is(data, size, false);
    if (static_cast<std::uint32_t>(is.readInt()) != kMagic)
        return false;
    numFrames_ = is.readInt64();
    sampleRate_ = is.readDouble();
    const int n = is.readInt();
    if (n < 0 || n > 64)
        return false;
    levels_.clear();
    for (int i = 0; i < n; ++i)
    {
        Level l;
        l.bucketFrames = is.readInt();
        const auto count = static_cast<std::size_t>(is.readInt64());
        if (count > (size / sizeof(MinMax)) + 1)
            return false; // corrupt
        l.data.resize(count);
        const auto bytes = static_cast<int>(count * sizeof(MinMax));
        if (is.read(l.data.data(), bytes) != bytes)
            return false;
        levels_.push_back(std::move(l));
    }
    return valid();
}

bool WaveformPeaks::writeTo(const juce::File& file) const
{
    const auto mb = toMemory();
    return file.replaceWithData(mb.getData(), mb.getSize());
}
bool WaveformPeaks::readFrom(const juce::File& file)
{
    juce::MemoryBlock mb;
    if (!file.loadFileAsData(mb))
        return false;
    return fromMemory(mb.getData(), mb.getSize());
}
juce::String WaveformPeaks::shapeKey() const
{
    return juce::String(numFrames_) + "-" + juce::String(static_cast<int>(sampleRate_));
}
} // namespace terminator::analysis
