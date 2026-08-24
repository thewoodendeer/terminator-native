#include "terminator/core/fx/FxDsp.h"

#include <algorithm>

namespace terminator
{

namespace
{
constexpr double kPi = 3.14159265358979323846;

double besselI0(double x) noexcept
{
    // the series Σ ((x/2)^k / k!)^2 — converges fast for the β we use
    double sum = 1.0, term = 1.0;
    const double h = 0.5 * x;
    for (int k = 1; k < 64; ++k)
    {
        term *= (h / static_cast<double>(k)) * (h / static_cast<double>(k));
        sum += term;
        if (term < 1e-17 * sum)
            break;
    }
    return sum;
}
} // namespace

// ---- Halfband2x ---------------------------------------------------------------------------------------------

void Halfband2x::design(int center, double beta)
{
    c_ = std::clamp(center, 1, kMaxCenter);
    const int half = (c_ % 2 == 1) ? c_ : c_ - 1; // the true halfband's half-length (odd)
    const int n = 2 * c_ + 1;
    double h[2 * kMaxCenter + 1] = {};
    const double i0b = besselI0(beta);
    double side = 0.0;
    for (int j = 0; j < n; ++j)
    {
        const int m = j - c_;
        if (m == 0)
        {
            h[j] = 0.5;
            continue;
        }
        if (m < -half || m > half || (m % 2) == 0)
        {
            h[j] = 0.0;
            continue;
        }
        const double t = 0.5 * static_cast<double>(m);
        const double sinc = std::sin(kPi * t) / (kPi * t);
        const double r = static_cast<double>(m) / static_cast<double>(half);
        const double w = besselI0(beta * std::sqrt(std::max(0.0, 1.0 - r * r))) / i0b;
        h[j] = 0.5 * sinc * w;
        side += h[j];
    }
    // exact unity DC gain: the side taps sum to ½ (the center is ½)
    const double scale = side > 0.0 ? 0.5 / side : 1.0;
    for (int j = 0; j < n; ++j)
        if (j != c_)
            h[j] *= scale;
    // the polyphase split: phase p takes h[2i+p], × 2 for the interpolator
    len0_ = c_ + 1;
    len1_ = c_;
    for (int i = 0; i < kRing; ++i)
    {
        ph0_[i] = i < len0_ ? 2.0 * h[2 * i] : 0.0;
        ph1_[i] = i < len1_ ? 2.0 * h[2 * i + 1] : 0.0;
    }
    reset();
}

void Halfband2x::reset() noexcept TERMINATOR_NONBLOCKING
{
    for (int i = 0; i < kRing; ++i)
        upHist_[i] = evHist_[i] = odHist_[i] = 0.0;
    upPos_ = dnPos_ = 0;
}

void Halfband2x::up(double x, double& y0, double& y1) noexcept TERMINATOR_NONBLOCKING
{
    upHist_[upPos_] = x;
    double a = 0.0, b = 0.0;
    for (int i = 0; i < len0_; ++i)
        a += ph0_[i] * upHist_[(upPos_ - i) & (kRing - 1)];
    for (int i = 0; i < len1_; ++i)
        b += ph1_[i] * upHist_[(upPos_ - i) & (kRing - 1)];
    upPos_ = (upPos_ + 1) & (kRing - 1);
    y0 = a;
    y1 = b;
}

double Halfband2x::down(double v0, double v1) noexcept TERMINATOR_NONBLOCKING
{
    // z[n] = Σ_i h[2i] v[2n−2i] + Σ_i h[2i+1] v[2n−2i−1] = Σ h[2i] ev[n−i] + Σ h[2i+1] od[n−1−i]
    evHist_[dnPos_] = v0;
    double z = 0.0;
    for (int i = 0; i < len0_; ++i)
        z += ph0_[i] * evHist_[(dnPos_ - i) & (kRing - 1)];
    for (int i = 0; i < len1_; ++i)
        z += ph1_[i] * odHist_[(dnPos_ - 1 - i) & (kRing - 1)];
    odHist_[dnPos_] = v1;
    dnPos_ = (dnPos_ + 1) & (kRing - 1);
    return 0.5 * z;
}

// ---- Oversampler4x ------------------------------------------------------------------------------------------

void Oversampler4x::prepare()
{
    s1_.design(kStage1Center, 8.0);
    s2_.design(kStage2Center, 9.0);
}

void Oversampler4x::reset() noexcept TERMINATOR_NONBLOCKING
{
    s1_.reset();
    s2_.reset();
}

void Oversampler4x::up(const double* in, double* out4, int n) noexcept TERMINATOR_NONBLOCKING
{
    for (int i = 0; i < n; ++i)
    {
        double a, b;
        s1_.up(in[i], a, b);
        double* o = out4 + 4 * i;
        s2_.up(a, o[0], o[1]);
        s2_.up(b, o[2], o[3]);
    }
}

void Oversampler4x::down(const double* in4, double* out, int n) noexcept TERMINATOR_NONBLOCKING
{
    for (int i = 0; i < n; ++i)
    {
        const double* q = in4 + 4 * i;
        const double a = s2_.down(q[0], q[1]);
        const double b = s2_.down(q[2], q[3]);
        out[i] = s1_.down(a, b);
    }
}

// ---- DelayLine ----------------------------------------------------------------------------------------------

void DelayLine::prepare(int maxDelaySamples)
{
    const int need = std::max(2, maxDelaySamples + 3);
    int size = 1;
    while (size < need)
        size <<= 1;
    buf_.assign(static_cast<std::size_t>(size), 0.0);
    mask_ = size - 1;
    head_ = 0;
    maxD_ = static_cast<double>(std::max(1, maxDelaySamples + 1));
}

void DelayLine::reset() noexcept TERMINATOR_NONBLOCKING
{
    std::fill(buf_.begin(), buf_.end(), 0.0);
    head_ = 0;
}

// ---- IntDelay -----------------------------------------------------------------------------------------------

void IntDelay::prepare(int maxDelaySamples, int maxBlockSize)
{
    maxDelay_ = std::max(0, maxDelaySamples);
    size_ = maxDelay_ + std::max(1, maxBlockSize) + 1;
    buf_.assign(static_cast<std::size_t>(size_), 0.0);
    head_ = 0;
}

void IntDelay::reset() noexcept TERMINATOR_NONBLOCKING
{
    std::fill(buf_.begin(), buf_.end(), 0.0);
    head_ = 0;
}

void IntDelay::process(double* x, int n, int delaySamples) noexcept TERMINATOR_NONBLOCKING
{
    const int d = std::clamp(delaySamples, 0, maxDelay_);
    double* b = buf_.data();
    if (d == 0)
    {
        // bit-exact pass-through — the ring still records the input so a later delay reads real history
        for (int i = 0; i < n; ++i)
        {
            b[head_] = x[i];
            if (++head_ >= size_)
                head_ = 0;
        }
        return;
    }
    for (int i = 0; i < n; ++i)
    {
        b[head_] = x[i];
        int r = head_ - d;
        if (r < 0)
            r += size_;
        x[i] = b[r];
        if (++head_ >= size_)
            head_ = 0;
    }
}

// ---- Fft ----------------------------------------------------------------------------------------------------

void Fft::prepare(int size)
{
    int n = 2, l = 1;
    while (n < size && n < (1 << 16))
    {
        n <<= 1;
        ++l;
    }
    n_ = n;
    log2n_ = l;
    cosT_.assign(static_cast<std::size_t>(n / 2), 0.0);
    sinT_.assign(static_cast<std::size_t>(n / 2), 0.0);
    for (int k = 0; k < n / 2; ++k)
    {
        const double a = -2.0 * kPi * static_cast<double>(k) / static_cast<double>(n);
        cosT_[static_cast<std::size_t>(k)] = std::cos(a);
        sinT_[static_cast<std::size_t>(k)] = std::sin(a);
    }
    rev_.assign(static_cast<std::size_t>(n), 0u);
    for (int i = 0; i < n; ++i)
    {
        std::uint32_t r = 0;
        for (int b = 0; b < l; ++b)
            if (i & (1 << b))
                r |= 1u << (l - 1 - b);
        rev_[static_cast<std::size_t>(i)] = r;
    }
}

void Fft::transform(double* re, double* im, bool inverse) const noexcept TERMINATOR_NONBLOCKING
{
    const int n = n_;
    for (int i = 0; i < n; ++i)
    {
        const int j = static_cast<int>(rev_[static_cast<std::size_t>(i)]);
        if (j > i)
        {
            std::swap(re[i], re[j]);
            std::swap(im[i], im[j]);
        }
    }
    for (int len = 2; len <= n; len <<= 1)
    {
        const int half = len >> 1;
        const int step = n / len;
        for (int i = 0; i < n; i += len)
        {
            for (int k = 0; k < half; ++k)
            {
                const double wr = cosT_[static_cast<std::size_t>(k * step)];
                const double wi =
                    inverse ? -sinT_[static_cast<std::size_t>(k * step)] : sinT_[static_cast<std::size_t>(k * step)];
                const int a = i + k, b = a + half;
                const double tr = re[b] * wr - im[b] * wi;
                const double ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
    if (inverse)
    {
        const double s = 1.0 / static_cast<double>(n);
        for (int i = 0; i < n; ++i)
        {
            re[i] *= s;
            im[i] *= s;
        }
    }
}

// ---- ButterLp4 (shared: the premium devices' decimator) ---------------------------------------------------

double ButterLp4::Section::process(double v0) noexcept TERMINATOR_NONBLOCKING
{
    const double v3 = v0 - ic2;
    const double v1 = a1 * ic1 + a2 * v3;
    const double v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2.0 * v1 - ic1;
    ic2 = 2.0 * v2 - ic2;
    return v2;
}

void ButterLp4::reset() noexcept TERMINATOR_NONBLOCKING
{
    s1_.ic1 = s1_.ic2 = s2_.ic1 = s2_.ic2 = 0.0;
}

void ButterLp4::set(double cutoffHz, double sampleRate) noexcept TERMINATOR_NONBLOCKING
{
    // Two Butterworth biquad sections: Q = 1/(2·cos(π(2k+1)/8)) → 0.5412, 1.3066 (k = 0, 1).
    const double g = std::tan(3.14159265358979323846 * std::min(0.49 * sampleRate, cutoffHz) / sampleRate);
    const double qs[2] = {0.541196100146197, 1.306562964876377};
    Section* secs[2] = {&s1_, &s2_};
    for (int i = 0; i < 2; ++i)
    {
        Section& s = *secs[i];
        s.g = g;
        s.k = 1.0 / qs[i];
        s.a1 = 1.0 / (1.0 + g * (g + s.k));
        s.a2 = g * s.a1;
        s.a3 = g * s.a2;
    }
}

double ButterLp4::process(double x) noexcept TERMINATOR_NONBLOCKING
{
    return s2_.process(s1_.process(x));
}

} // namespace terminator
