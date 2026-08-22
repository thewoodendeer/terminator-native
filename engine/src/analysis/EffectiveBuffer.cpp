#include "terminator/analysis/EffectiveBuffer.h"

#include <algorithm>
#include <vector>

namespace terminator::analysis
{
std::shared_ptr<SampleBuffer> buildEffectiveBuffer(const SampleBuffer& file, const trims::TrimList& trims)
{
    std::vector<const float*> src;
    src.reserve(static_cast<std::size_t>(std::max(0, file.numChannels)));
    for (int ch = 0; ch < file.numChannels; ++ch)
        src.push_back(file.channel(ch));
    auto out = std::make_shared<SampleBuffer>();
    if (src.empty() || file.numFrames <= 0)
    {
        out->allocate(file.numChannels, 0, file.sampleRate);
        return out;
    }
    const auto eff = trims::buildEffectiveChannels(src, file.numFrames, file.sampleRate, trims);
    const auto frames = static_cast<std::int64_t>(eff.empty() ? 0 : eff[0].size());
    out->allocate(file.numChannels, frames, file.sampleRate);
    for (std::size_t c = 0; c < eff.size(); ++c)
        std::copy(eff[c].begin(), eff[c].end(), out->channel(static_cast<int>(c)));
    out->id = 0; // the store assigns one when it takes ownership
    return out;
}

std::shared_ptr<SampleBuffer> effectiveOrSame(const std::shared_ptr<SampleBuffer>& file, const trims::TrimList& trims)
{
    if (file == nullptr || trims.empty())
        return file;
    return buildEffectiveBuffer(*file, trims);
}

StemPlanes buildEffectiveStems(const StemPlanes& filePlanes, const trims::TrimList& trims)
{
    StemPlanes out{};
    for (std::size_t k = 0; k < out.size(); ++k)
        out[k] = effectiveOrSame(filePlanes[k], trims);
    return out;
}
} // namespace terminator::analysis
