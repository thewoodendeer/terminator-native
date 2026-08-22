#pragma once
// LOOP crossfade render — port of ChopperEngine.renderCrossfadeLoop (pure). A chop that is not a whole number
// of cycles clicks when looped raw; with fades the loop point and the intro→periodic seam are as smooth as the
// waveform. Model = overlap-add: pass k starts at k·period; each pass is the region under
// env = fadeIn(equal-power sin) × fadeOut(cos). Output = [warm-up | periodic]; the last period is the steady
// state — loop that. No fades → period n, raw region (the caller may then loop the source directly with no
// render). Gate: scripts/pad-loop.test.mts, ported in test_loop_render.cpp.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace terminator::loop
{
inline constexpr int kMinPeriodFrames = 64;

struct LoopRender
{
    std::vector<std::vector<float>> frames; // [channel][total]
    std::int64_t period = 0;
    std::int64_t loopStart = 0; // frame where the steady period begins (= warm-up length)
};

/// `chans[c]` points at the source channel; the region is [s0, s0+n). fadeIn/fadeOut in frames (may cross).
inline LoopRender renderCrossfadeLoop(const std::vector<const float*>& chans, std::int64_t s0, std::int64_t n,
                                      std::int64_t fadeInFrames, std::int64_t fadeOutFrames)
{
    const std::int64_t fi = std::max<std::int64_t>(0, std::min<std::int64_t>(n, fadeInFrames));
    const std::int64_t fo = std::max<std::int64_t>(
        0, std::min<std::int64_t>(std::max<std::int64_t>(0, n - kMinPeriodFrames), fadeOutFrames));
    const std::int64_t period = std::max<std::int64_t>(1, n - fo);
    constexpr double kHalfPi = 1.57079632679489661923;
    auto env = [&](std::int64_t j) -> double
    {
        const double a =
            (fi > 0 && j < fi) ? std::sin(kHalfPi * (static_cast<double>(j) / static_cast<double>(fi))) : 1.0;
        const double b = (fo > 0 && j >= n - fo)
                             ? std::cos(kHalfPi * (static_cast<double>(j - (n - fo)) / static_cast<double>(fo)))
                             : 1.0;
        return a * b;
    };
    const std::int64_t M = static_cast<std::int64_t>(std::ceil(static_cast<double>(n) / static_cast<double>(period)));
    const std::int64_t total = (M + 1) * period;
    // Power normalisation: crossed fades stack passes — scale so the steady state carries one pass's power.
    double maxPow = 0.0;
    for (std::int64_t i = 0; i < period; ++i)
    {
        double p = 0.0;
        for (std::int64_t j = i; j < n; j += period)
        {
            const double e = env(j);
            p += e * e;
        }
        if (p > maxPow)
            maxPow = p;
    }
    const double norm = maxPow > 1.0 ? 1.0 / std::sqrt(maxPow) : 1.0;
    LoopRender r;
    r.period = period;
    r.loopStart = M * period;
    r.frames.assign(chans.size(), std::vector<float>(static_cast<std::size_t>(total), 0.0f));
    for (std::size_t c = 0; c < chans.size(); ++c)
    {
        const float* src = chans[c];
        auto& dst = r.frames[c];
        for (std::int64_t k = 0; k <= M; ++k)
        {
            const std::int64_t at = k * period;
            const std::int64_t len = std::min<std::int64_t>(n, total - at);
            for (std::int64_t j = 0; j < len; ++j)
                dst[static_cast<std::size_t>(at + j)] +=
                    static_cast<float>(static_cast<double>(src[s0 + j]) * env(j) * norm);
        }
    }
    return r;
}
} // namespace terminator::loop
