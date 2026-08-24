#include "terminator/stems/Resampler.h"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace terminator::stems
{
namespace
{
std::int64_t gcd64(std::int64_t a, std::int64_t b) noexcept
{
    while (b != 0)
    {
        const std::int64_t t = a % b;
        a = b;
        b = t;
    }
    return a;
}

double blackman(double t) noexcept
{
    constexpr double pi = std::numbers::pi;
    return 0.42 - 0.5 * std::cos(2.0 * pi * t) + 0.08 * std::cos(4.0 * pi * t);
}
} // namespace

Resampler::Resampler(int inRate, int outRate) : inRate_(inRate), outRate_(outRate)
{
    const std::int64_t in = inRate > 0 ? inRate : 1;
    const std::int64_t out = outRate > 0 ? outRate : 1;
    const std::int64_t g = std::max<std::int64_t>(1, gcd64(in, out));
    l_ = in / g;
    m_ = out / g;
    const double band = std::min(1.0, static_cast<double>(out) / static_cast<double>(in));
    cutoff_ = band < 1.0 ? band * kCutoffTrim : 1.0;
    half_ = static_cast<std::int64_t>(std::ceil(static_cast<double>(band < 1.0 ? kLobesDown : kLobesUp) / cutoff_));
    taps_ = half_ * 2;
    if (m_ <= kMaxPhases)
        buildTable();
}

double Resampler::kern(double x) const noexcept
{
    const double h = static_cast<double>(half_);
    if (x <= -h || x >= h)
        return 0.0;
    const double px = std::numbers::pi * cutoff_ * x;
    const double s = x == 0.0 ? 1.0 : std::sin(px) / px;
    return cutoff_ * s * blackman(0.5 + x / (2.0 * h));
}

void Resampler::buildTable()
{
    tab_.assign(static_cast<std::size_t>(m_ * taps_), 0.0f);
    for (std::int64_t p = 0; p < m_; ++p)
    {
        const double frac = static_cast<double>(p) / static_cast<double>(m_);
        double sum = 0.0;
        for (std::int64_t t = 0; t < taps_; ++t)
        {
            const double v = kern(frac + static_cast<double>(half_ - 1 - t));
            tab_[static_cast<std::size_t>(p * taps_ + t)] = static_cast<float>(v);
            sum += v;
        }
        // Exact unity DC gain per phase — window truncation leaves ~1e-3 of ripple otherwise, which reads as
        // a slow amplitude wobble.
        if (sum > 1e-9)
            for (std::int64_t t = 0; t < taps_; ++t)
                tab_[static_cast<std::size_t>(p * taps_ + t)] /= static_cast<float>(sum);
    }
}

std::int64_t Resampler::outLength(std::int64_t inFrames) const noexcept
{
    if (inFrames <= 0)
        return 0;
    // JS Math.round: half away from zero for positives — std::llround matches for non-negative input.
    const double n = (static_cast<double>(inFrames) * static_cast<double>(outRate_)) / static_cast<double>(inRate_);
    return static_cast<std::int64_t>(std::llround(n));
}

void Resampler::sampleRange(const float* src, std::int64_t lo, std::int64_t hi, std::int64_t n0, std::int64_t count,
                            std::int64_t offset, float* out) const
{
    if (count <= 0)
        return;
    std::fill(out, out + count, 0.0f);
    if (hi <= lo || src == nullptr)
        return;
    const std::int64_t last = hi - 1;
    for (std::int64_t j = 0; j < count; ++j)
    {
        const std::int64_t idx = (n0 + j) * l_;
        const std::int64_t i0 = idx / m_;
        const std::int64_t p = idx % m_;
        const std::int64_t base = i0 - half_ + 1 - offset;
        double acc = 0.0;
        if (!tab_.empty())
        {
            const std::size_t o = static_cast<std::size_t>(p * taps_);
            for (std::int64_t t = 0; t < taps_; ++t)
            {
                std::int64_t k = base + t;
                k = std::clamp(k, lo, last);
                acc += static_cast<double>(tab_[o + static_cast<std::size_t>(t)]) * static_cast<double>(src[k]);
            }
        }
        else
        {
            const double frac = static_cast<double>(p) / static_cast<double>(m_);
            double sum = 0.0;
            for (std::int64_t t = 0; t < taps_; ++t)
            {
                const double w = kern(frac + static_cast<double>(half_ - 1 - t));
                std::int64_t k = base + t;
                k = std::clamp(k, lo, last);
                acc += w * static_cast<double>(src[k]);
                sum += w;
            }
            if (sum > 1e-9)
                acc /= sum;
        }
        out[j] = static_cast<float>(acc);
    }
}

std::vector<float> Resampler::sampleRange(const std::vector<float>& src, std::int64_t lo, std::int64_t hi,
                                          std::int64_t n0, std::int64_t count, std::int64_t offset) const
{
    std::vector<float> out(static_cast<std::size_t>(std::max<std::int64_t>(0, count)), 0.0f);
    if (!out.empty())
        sampleRange(src.data(), lo, hi, n0, count, offset, out.data());
    return out;
}

std::vector<float> Resampler::resample(const float* src, std::int64_t frames) const
{
    const std::int64_t n = outLength(frames);
    std::vector<float> out(static_cast<std::size_t>(std::max<std::int64_t>(0, n)), 0.0f);
    if (!out.empty())
        sampleRange(src, 0, frames, 0, n, 0, out.data());
    return out;
}

std::vector<float> Resampler::resample(const std::vector<float>& src) const
{
    return resample(src.data(), static_cast<std::int64_t>(src.size()));
}
} // namespace terminator::stems
