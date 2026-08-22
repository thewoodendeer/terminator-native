#include "terminator/core/planners/Onsets.h"

#include <algorithm>
#ifndef M_PI
#define M_PI 3.14159265358979323846 // MSVC does not define M_PI without _USE_MATH_DEFINES
#endif

namespace terminator::onsets
{
namespace
{
struct MeanSigma
{
    double mean = 0, sigma = 0;
};
MeanSigma stat(const std::vector<float>& a)
{
    if (a.empty())
        return {};
    double m = 0;
    for (float v : a)
        m += static_cast<double>(v);
    m /= static_cast<double>(a.size());
    double var = 0;
    for (float v : a)
        var += (static_cast<double>(v) - m) * (static_cast<double>(v) - m);
    return {m, std::sqrt(var / static_cast<double>(a.size()))};
}
} // namespace

Onsets detectTransients(const std::vector<float>& mono, double sr)
{
    Onsets out;
    const int HOP = 256, FRAME = 512;
    const auto N = static_cast<std::int64_t>(mono.size());
    const std::int64_t numFrames = (N - FRAME) / HOP;
    if (numFrames < 2)
        return out;
    std::vector<float> energy(static_cast<std::size_t>(numFrames));
    for (std::int64_t f = 0; f < numFrames; ++f)
    {
        const std::int64_t base = f * HOP;
        double e = 0;
        for (int i = 0; i < FRAME; ++i)
        {
            const double s = static_cast<double>(mono[static_cast<std::size_t>(base + i)]);
            e += s * s;
        }
        energy[static_cast<std::size_t>(f)] = static_cast<float>(e / FRAME);
    }
    std::vector<float> flux(static_cast<std::size_t>(numFrames), 0.0f);
    for (std::int64_t f = 1; f < numFrames; ++f)
        flux[static_cast<std::size_t>(f)] =
            std::max(0.0f, energy[static_cast<std::size_t>(f)] - energy[static_cast<std::size_t>(f - 1)]);
    const auto st = stat(flux);
    const double threshold = st.mean + 0.1 * st.sigma;
    const std::int64_t minGap = static_cast<std::int64_t>(std::floor(0.03 * sr / HOP));
    std::int64_t lastPeak = -minGap;
    for (std::int64_t f = 1; f < numFrames - 1; ++f)
    {
        const float v = flux[static_cast<std::size_t>(f)];
        if (static_cast<double>(v) > threshold && v > flux[static_cast<std::size_t>(f - 1)] &&
            v >= flux[static_cast<std::size_t>(f + 1)] && f - lastPeak >= minGap)
        {
            out.times.push_back(static_cast<float>(static_cast<double>(f * HOP) / sr));
            out.strengths.push_back(v);
            lastPeak = f;
        }
    }
    return out;
}

Onsets detectDrumTransients(const std::vector<float>& mono, double sr)
{
    Onsets out;
    const auto N = static_cast<std::int64_t>(mono.size());
    if (N < 1024)
        return out;
    const double alphaKick = 1 - std::exp(-2 * M_PI * 200 / sr);
    const double alphaSnareLp = 1 - std::exp(-2 * M_PI * 1500 / sr);
    std::vector<float> low(static_cast<std::size_t>(N)), high(static_cast<std::size_t>(N));
    double pk = 0, ps = 0;
    for (std::int64_t i = 0; i < N; ++i)
    {
        const double s = static_cast<double>(mono[static_cast<std::size_t>(i)]);
        pk = pk + alphaKick * (s - pk);
        ps = ps + alphaSnareLp * (s - ps);
        low[static_cast<std::size_t>(i)] = static_cast<float>(pk);
        high[static_cast<std::size_t>(i)] = static_cast<float>(s - ps);
    }
    const int HOP = 256, FRAME = 512;
    const std::int64_t numFrames = (N - FRAME) / HOP;
    if (numFrames < 2)
        return out;
    std::vector<float> eLow(static_cast<std::size_t>(numFrames)), eHigh(static_cast<std::size_t>(numFrames));
    for (std::int64_t f = 0; f < numFrames; ++f)
    {
        const std::int64_t base = f * HOP;
        double el = 0, eh = 0;
        for (int i = 0; i < FRAME; ++i)
        {
            const double l = static_cast<double>(low[static_cast<std::size_t>(base + i)]);
            el += l * l;
            const double h = static_cast<double>(high[static_cast<std::size_t>(base + i)]);
            eh += h * h;
        }
        eLow[static_cast<std::size_t>(f)] = static_cast<float>(el / FRAME);
        eHigh[static_cast<std::size_t>(f)] = static_cast<float>(eh / FRAME);
    }
    std::vector<float> fluxLow(static_cast<std::size_t>(numFrames), 0.0f),
        fluxHigh(static_cast<std::size_t>(numFrames), 0.0f);
    for (std::int64_t f = 1; f < numFrames; ++f)
    {
        fluxLow[static_cast<std::size_t>(f)] =
            std::max(0.0f, eLow[static_cast<std::size_t>(f)] - eLow[static_cast<std::size_t>(f - 1)]);
        fluxHigh[static_cast<std::size_t>(f)] =
            std::max(0.0f, eHigh[static_cast<std::size_t>(f)] - eHigh[static_cast<std::size_t>(f - 1)]);
    }
    const auto sl = stat(fluxLow);
    const auto sh = stat(fluxHigh);
    const double thrLow = sl.mean + 0.5 * sl.sigma;
    const double thrHigh = sh.mean + 0.5 * sh.sigma;
    const std::int64_t minGap = std::max<std::int64_t>(1, static_cast<std::int64_t>(std::floor(0.05 * sr / HOP)));
    struct Hit
    {
        std::int64_t f;
        float strength;
    };
    std::vector<Hit> hits;
    std::int64_t lastL = -minGap, lastH = -minGap;
    for (std::int64_t f = 1; f < numFrames - 1; ++f)
    {
        const bool lowPeak = static_cast<double>(fluxLow[static_cast<std::size_t>(f)]) > thrLow &&
                             fluxLow[static_cast<std::size_t>(f)] > fluxLow[static_cast<std::size_t>(f - 1)] &&
                             fluxLow[static_cast<std::size_t>(f)] >= fluxLow[static_cast<std::size_t>(f + 1)];
        if (lowPeak && f - lastL >= minGap)
        {
            const double ratio = static_cast<double>(eLow[static_cast<std::size_t>(f)]) /
                                 (static_cast<double>(eHigh[static_cast<std::size_t>(f)]) + 1e-9);
            if (ratio > 0.4)
            {
                hits.push_back({f, fluxLow[static_cast<std::size_t>(f)]});
                lastL = f;
            }
        }
        const bool highPeak = static_cast<double>(fluxHigh[static_cast<std::size_t>(f)]) > thrHigh &&
                              fluxHigh[static_cast<std::size_t>(f)] > fluxHigh[static_cast<std::size_t>(f - 1)] &&
                              fluxHigh[static_cast<std::size_t>(f)] >= fluxHigh[static_cast<std::size_t>(f + 1)];
        if (highPeak && f - lastH >= minGap)
        {
            const double bodyRatio = static_cast<double>(eLow[static_cast<std::size_t>(f)]) /
                                     (static_cast<double>(eHigh[static_cast<std::size_t>(f)]) + 1e-9);
            if (bodyRatio > 0.15)
            {
                hits.push_back({f, fluxHigh[static_cast<std::size_t>(f)]});
                lastH = f;
            }
        }
    }
    std::stable_sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) { return a.f < b.f; });
    std::vector<Hit> merged;
    std::int64_t lastF = -minGap;
    for (const auto& h : hits)
    {
        if (h.f - lastF >= minGap)
        {
            merged.push_back(h);
            lastF = h.f;
        }
        else if (h.strength > merged.back().strength)
        {
            merged.back() = h;
            lastF = h.f;
        }
    }
    for (const auto& h : merged)
    {
        out.times.push_back(static_cast<float>(static_cast<double>(h.f * HOP) / sr));
        out.strengths.push_back(h.strength);
    }
    return out;
}

double detectSilenceEnd(const std::vector<float>& mono, double sr, double threshold, int windowFrames)
{
    const auto N = static_cast<std::int64_t>(mono.size());
    for (std::int64_t i = 0; i < N - windowFrames; i += windowFrames)
    {
        double rms = 0;
        for (int j = 0; j < windowFrames; ++j)
        {
            const double s = static_cast<double>(mono[static_cast<std::size_t>(i + j)]);
            rms += s * s;
        }
        if (std::sqrt(rms / windowFrames) > threshold)
            return static_cast<double>(i) / sr;
    }
    return 0.0;
}

int estimateBpm(const std::vector<float>& ch0, const std::vector<float>& ch1, double sr, double durationSec)
{
    if (durationSec < 8)
        return 0;
    const int HOP = 1024, FRAME = 2048;
    const auto length = static_cast<std::int64_t>(std::min(ch0.size(), ch1.size()));
    const std::int64_t allFrames = (length - FRAME) / HOP;
    if (allFrames < 50)
        return 0;
    const double frameRate = sr / HOP;
    const std::int64_t maxFrames = std::min<std::int64_t>(allFrames, static_cast<std::int64_t>(60 * frameRate));
    std::vector<float> energy(static_cast<std::size_t>(maxFrames));
    for (std::int64_t f = 0; f < maxFrames; ++f)
    {
        const std::int64_t base = f * HOP;
        double e = 0;
        for (int i = 0; i < FRAME; ++i)
        {
            const double s = (static_cast<double>(ch0[static_cast<std::size_t>(base + i)]) +
                              static_cast<double>(ch1[static_cast<std::size_t>(base + i)])) *
                             0.5;
            e += s * s;
        }
        energy[static_cast<std::size_t>(f)] = static_cast<float>(std::sqrt(e / FRAME));
    }
    std::vector<float> flux(static_cast<std::size_t>(maxFrames), 0.0f);
    for (std::int64_t f = 1; f < maxFrames; ++f)
    {
        const float d = energy[static_cast<std::size_t>(f)] - energy[static_cast<std::size_t>(f - 1)];
        flux[static_cast<std::size_t>(f)] = d > 0 ? d : 0;
    }
    const int WIN = 10;
    std::vector<float> novelty(static_cast<std::size_t>(maxFrames), 0.0f);
    for (std::int64_t f = 0; f < maxFrames; ++f)
    {
        const std::int64_t a = std::max<std::int64_t>(0, f - WIN);
        const std::int64_t b = std::min<std::int64_t>(maxFrames, f + WIN + 1);
        double m = 0;
        for (std::int64_t k = a; k < b; ++k)
            m += static_cast<double>(flux[static_cast<std::size_t>(k)]);
        m /= static_cast<double>(b - a);
        const double v = static_cast<double>(flux[static_cast<std::size_t>(f)]) - m;
        novelty[static_cast<std::size_t>(f)] = v > 0 ? static_cast<float>(v) : 0.0f;
    }
    const double combWeights[4] = {1.0, 0.7, 0.5, 0.4};
    auto scoreFor = [&](double bpm) -> double
    {
        const double baseLag = (60 / bpm) * frameRate;
        if (baseLag < 3)
            return -1e300;
        double total = 0;
        for (int m = 0; m < 4; ++m)
        {
            const std::int64_t lag = static_cast<std::int64_t>(std::floor(baseLag * (m + 1) + 0.5));
            if (lag >= maxFrames - 4)
                break;
            double sum = 0;
            for (std::int64_t f = 0; f < maxFrames - lag; ++f)
                sum += static_cast<double>(novelty[static_cast<std::size_t>(f)]) *
                       static_cast<double>(novelty[static_cast<std::size_t>(f + lag)]);
            total += combWeights[m] * sum;
        }
        return total;
    };
    double bestBpm = 0, bestScore = -1e300;
    for (int bpm = 60; bpm <= 200; ++bpm)
    {
        const double sc = scoreFor(bpm);
        if (sc > bestScore)
        {
            bestScore = sc;
            bestBpm = bpm;
        }
    }
    if (bestScore <= 0)
        return 0;
    double refinedBpm = bestBpm, refinedScore = bestScore;
    for (int d = -20; d <= 20; ++d)
    {
        const double bpm = bestBpm + d / 10.0;
        if (bpm < 60 || bpm > 200)
            continue;
        const double sc = scoreFor(bpm);
        if (sc > refinedScore)
        {
            refinedScore = sc;
            refinedBpm = bpm;
        }
    }
    while (refinedBpm < 75)
        refinedBpm *= 2;
    while (refinedBpm > 165)
        refinedBpm /= 2;
    return static_cast<int>(std::floor(refinedBpm + 0.5));
}
} // namespace terminator::onsets
