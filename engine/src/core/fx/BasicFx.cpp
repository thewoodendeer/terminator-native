#include "terminator/core/fx/BasicFx.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr float kFxTau = 0.01f; // the TS setParam(…, 0.01) glide
constexpr double kTwoPi = 6.283185307179586476925;
constexpr double kHalfPi = 1.57079632679489661923;

float clampf(float v, float lo, float hi) noexcept
{
    return v < lo ? lo : (v > hi ? hi : v);
}
} // namespace

// ---- Biquad (the Web Audio spec's coefficient formulas; Blink clamps f to [0, Nyquist]) --------------------------

void Biquad::set(Type type, double freqHz, double q, double gainDb, double sampleRate) noexcept TERMINATOR_NONBLOCKING
{
    const double nyq = sampleRate * 0.5;
    const double f = std::clamp(freqHz, 0.0, nyq);
    const double w0 = 3.14159265358979323846 * (f / nyq); // = 2π f / sr
    const double cs = std::cos(w0), sn = std::sin(w0);
    double b0, b1, b2, a0, a1, a2;
    switch (type)
    {
    case Type::lowpass:
    case Type::highpass:
    {
        // Q in dB (the spec): α = sin(ω0)/2 · 10^(−Q/20)
        const double g = std::pow(10.0, -0.05 * q);
        const double alpha = 0.5 * sn * g;
        if (type == Type::lowpass)
        {
            b1 = 1.0 - cs;
            b0 = 0.5 * b1;
            b2 = b0;
        }
        else
        {
            b1 = -(1.0 + cs);
            b0 = -0.5 * b1;
            b2 = b0;
        }
        a0 = 1.0 + alpha;
        a1 = -2.0 * cs;
        a2 = 1.0 - alpha;
        break;
    }
    case Type::bandpass:
    case Type::notch:
    case Type::allpass:
    {
        const double qq = std::max(q, 1e-4);
        const double alpha = sn / (2.0 * qq);
        if (type == Type::bandpass)
        {
            b0 = alpha;
            b1 = 0.0;
            b2 = -alpha;
        }
        else if (type == Type::notch)
        {
            b0 = 1.0;
            b1 = -2.0 * cs;
            b2 = 1.0;
        }
        else
        {
            b0 = 1.0 - alpha;
            b1 = -2.0 * cs;
            b2 = 1.0 + alpha;
        }
        a0 = 1.0 + alpha;
        a1 = -2.0 * cs;
        a2 = 1.0 - alpha;
        break;
    }
    case Type::peaking:
    {
        const double A = std::pow(10.0, gainDb / 40.0);
        const double qq = std::max(q, 1e-4);
        const double alpha = sn / (2.0 * qq);
        b0 = 1.0 + alpha * A;
        b1 = -2.0 * cs;
        b2 = 1.0 - alpha * A;
        a0 = 1.0 + alpha / A;
        a1 = -2.0 * cs;
        a2 = 1.0 - alpha / A;
        break;
    }
    case Type::lowshelf:
    case Type::highshelf:
    default:
    {
        const double A = std::pow(10.0, gainDb / 40.0);
        const double alpha = 0.5 * sn * std::sqrt(2.0); // S = 1: √((A + 1/A)(1/S − 1) + 2) = √2
        const double k = 2.0 * std::sqrt(A) * alpha;
        if (type == Type::lowshelf)
        {
            b0 = A * ((A + 1.0) - (A - 1.0) * cs + k);
            b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cs);
            b2 = A * ((A + 1.0) - (A - 1.0) * cs - k);
            a0 = (A + 1.0) + (A - 1.0) * cs + k;
            a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cs);
            a2 = (A + 1.0) + (A - 1.0) * cs - k;
        }
        else
        {
            b0 = A * ((A + 1.0) + (A - 1.0) * cs + k);
            b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cs);
            b2 = A * ((A + 1.0) + (A - 1.0) * cs - k);
            a0 = (A + 1.0) - (A - 1.0) * cs + k;
            a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cs);
            a2 = (A + 1.0) - (A - 1.0) * cs - k;
        }
        break;
    }
    }
    if (a0 == 0.0)
    {
        setIdentity();
        return;
    }
    // divide (not × 1/a0): (1+α)/(1+α) is exactly 1, so a 0 dB shelf / bell is detected as the identity
    b0_ = b0 / a0;
    b1_ = b1 / a0;
    b2_ = b2 / a0;
    a1_ = a1 / a0;
    a2_ = a2 / a0;
    identity_ = b0_ == 1.0 && b1_ == a1_ && b2_ == a2_;
}

double Biquad::magnitudeAt(double freqHz, double sampleRate) const noexcept
{
    const double w = kTwoPi * freqHz / sampleRate;
    // H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2), z = e^{jw}
    const double c1 = std::cos(w), s1 = std::sin(w), c2 = std::cos(2.0 * w), s2 = std::sin(2.0 * w);
    const double nr = b0_ + b1_ * c1 + b2_ * c2, ni = -(b1_ * s1 + b2_ * s2);
    const double dr = 1.0 + a1_ * c1 + a2_ * c2, di = -(a1_ * s1 + a2_ * s2);
    const double num = nr * nr + ni * ni, den = dr * dr + di * di;
    return den > 0.0 ? std::sqrt(num / den) : 0.0;
}

// ---- UTILITY ------------------------------------------------------------------------------------------------

void UtilityFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    reset();
}
void UtilityFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    gain_.set(1.0f, true);
    mode_ = 0.0f;
    phase_ = 0.0f;
}
void UtilityFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        gain_.set(std::pow(10.0f, clampf(value, -20.0f, 20.0f) / 20.0f), immediate);
        break;
    case 1:
        mode_ = clampf(std::floor(value), 0.0f, 3.0f);
        break;
    case 2:
        phase_ = value >= 0.5f ? 1.0f : 0.0f;
        break;
    default:
        break;
    }
}
float UtilityFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return 20.0f * std::log10(gain_.target);
    case 1:
        return mode_;
    case 2:
        return phase_;
    default:
        return 0.0f;
    }
}
void UtilityFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double gS = static_cast<double>(gain_.cur), gE = static_cast<double>(gain_.advance(n, sr_, kFxTau));
    const double ph = phase_ >= 0.5f ? -1.0 : 1.0;
    const int mode = static_cast<int>(mode_);
    const double invN = 1.0 / static_cast<double>(n);
    for (int i = 0; i < n; ++i)
    {
        const double g = (gS + (gE - gS) * (static_cast<double>(i) * invN)) * ph;
        double a = l[i] * g, b = r[i] * g;
        switch (mode)
        {
        case 1: // MONO: 0.5 L + 0.5 R on both
        {
            const double m = 0.5 * a + 0.5 * b;
            a = b = m;
            break;
        }
        case 2: // MONO-L
            b = a;
            break;
        case 3: // MONO-R
            a = b;
            break;
        default:
            break;
        }
        l[i] = a;
        r[i] = b;
    }
}

// ---- EQ ----------------------------------------------------------------------------------------------------

void EqFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    reset();
}
void EqFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    low_.set(0.0f, true);
    mid_.set(0.0f, true);
    high_.set(0.0f, true);
    for (auto* b : {&lowL_, &lowR_, &midL_, &midR_, &highL_, &highR_})
        b->reset();
    recompute();
}
void EqFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    const float v = clampf(value, -12.0f, 12.0f);
    if (index == 0)
        low_.set(v, immediate);
    else if (index == 1)
        mid_.set(v, immediate);
    else if (index == 2)
        high_.set(v, immediate);
    if (immediate)
        recompute();
}
float EqFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    return index == 0 ? low_.target : index == 1 ? mid_.target : index == 2 ? high_.target : 0.0f;
}
void EqFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    lowL_.set(Biquad::Type::lowshelf, 80.0, 1.0, static_cast<double>(low_.cur), sr_);
    lowR_.set(Biquad::Type::lowshelf, 80.0, 1.0, static_cast<double>(low_.cur), sr_);
    midL_.set(Biquad::Type::peaking, 1000.0, 0.8, static_cast<double>(mid_.cur), sr_);
    midR_.set(Biquad::Type::peaking, 1000.0, 0.8, static_cast<double>(mid_.cur), sr_);
    highL_.set(Biquad::Type::highshelf, 12000.0, 1.0, static_cast<double>(high_.cur), sr_);
    highR_.set(Biquad::Type::highshelf, 12000.0, 1.0, static_cast<double>(high_.cur), sr_);
}
void EqFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const bool moving = low_.moving() || mid_.moving() || high_.moving();
    if (moving)
    {
        low_.advance(n, sr_, kFxTau);
        mid_.advance(n, sr_, kFxTau);
        high_.advance(n, sr_, kFxTau);
        recompute(); // per block while gliding (Blink recomputes per quantum on an automated param)
    }
    for (int i = 0; i < n; ++i)
    {
        l[i] = highL_.process(midL_.process(lowL_.process(l[i])));
        r[i] = highR_.process(midR_.process(lowR_.process(r[i])));
    }
}

// ---- FILTER -----------------------------------------------------------------------------------------------

void FilterFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    reset();
}
void FilterFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    type_ = 0.0f;
    cutoff_.set(20000.0f, true);
    reso_.set(1.0f, true);
    fL_.reset();
    fR_.reset();
    recompute();
}
void FilterFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    if (index == 0)
    {
        type_ = clampf(std::floor(value), 0.0f, 3.0f);
        recompute();
    }
    else if (index == 1)
        cutoff_.set(clampf(value, 20.0f, 20000.0f), immediate);
    else if (index == 2)
        reso_.set(clampf(value, 0.0001f, 30.0f), immediate);
    if (immediate)
        recompute();
}
float FilterFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    return index == 0 ? type_ : index == 1 ? cutoff_.target : index == 2 ? reso_.target : 0.0f;
}
void FilterFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    const auto t = type_ < 0.5f   ? Biquad::Type::lowpass
                   : type_ < 1.5f ? Biquad::Type::highpass
                   : type_ < 2.5f ? Biquad::Type::bandpass
                                  : Biquad::Type::notch;
    fL_.set(t, static_cast<double>(cutoff_.cur), static_cast<double>(reso_.cur), 0.0, sr_);
    fR_.set(t, static_cast<double>(cutoff_.cur), static_cast<double>(reso_.cur), 0.0, sr_);
}
void FilterFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    if (cutoff_.moving() || reso_.moving())
    {
        cutoff_.advance(n, sr_, kFxTau, 1e-3f);
        reso_.advance(n, sr_, kFxTau);
        recompute();
    }
    for (int i = 0; i < n; ++i)
    {
        l[i] = fL_.process(l[i]);
        r[i] = fR_.process(r[i]);
    }
}

// ---- WIDE -------------------------------------------------------------------------------------------------

void WideFx::prepare(double /*sampleRate*/, int /*maxBlockSize*/)
{
    reset();
}
void WideFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    width_ = 100.0f;
}
void WideFx::setParam(int index, float value, bool /*immediate*/) noexcept TERMINATOR_NONBLOCKING
{
    if (index == 0)
        width_ = clampf(value, 0.0f, 200.0f);
}
float WideFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    return index == 0 ? width_ : 0.0f;
}
void WideFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double w = static_cast<double>(width_) * 0.01;
    for (int i = 0; i < n; ++i)
    {
        const double m = 0.5 * l[i] + 0.5 * r[i];
        const double s = (0.5 * l[i] - 0.5 * r[i]) * w;
        l[i] = m + s;
        r[i] = m - s;
    }
}

// ---- M/S EQ -----------------------------------------------------------------------------------------------

void MseqFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    reset();
}
void MseqFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    midHz_.set(1000.0f, true);
    midDb_.set(0.0f, true);
    sideHz_.set(4000.0f, true);
    sideDb_.set(0.0f, true);
    mid_.reset();
    side_.reset();
    recompute();
}
void MseqFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        midHz_.set(clampf(value, 20.0f, 20000.0f), immediate);
        break;
    case 1:
        midDb_.set(clampf(value, -18.0f, 18.0f), immediate);
        break;
    case 2:
        sideHz_.set(clampf(value, 20.0f, 20000.0f), immediate);
        break;
    case 3:
        sideDb_.set(clampf(value, -18.0f, 18.0f), immediate);
        break;
    default:
        break;
    }
    if (immediate)
        recompute();
}
float MseqFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return midHz_.target;
    case 1:
        return midDb_.target;
    case 2:
        return sideHz_.target;
    case 3:
        return sideDb_.target;
    default:
        return 0.0f;
    }
}
void MseqFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    mid_.set(Biquad::Type::peaking, static_cast<double>(midHz_.cur), 1.0, static_cast<double>(midDb_.cur), sr_);
    side_.set(Biquad::Type::peaking, static_cast<double>(sideHz_.cur), 1.0, static_cast<double>(sideDb_.cur), sr_);
}
void MseqFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    if (midHz_.moving() || midDb_.moving() || sideHz_.moving() || sideDb_.moving())
    {
        midHz_.advance(n, sr_, kFxTau, 1e-3f);
        midDb_.advance(n, sr_, kFxTau);
        sideHz_.advance(n, sr_, kFxTau, 1e-3f);
        sideDb_.advance(n, sr_, kFxTau);
        recompute();
    }
    for (int i = 0; i < n; ++i)
    {
        const double m = mid_.process(0.5 * l[i] + 0.5 * r[i]);
        const double s = side_.process(0.5 * l[i] - 0.5 * r[i]);
        l[i] = m + s;
        r[i] = m - s;
    }
}

// ---- PAN --------------------------------------------------------------------------------------------------

void PanFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    reset();
}
void PanFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    rate_.set(1.0f, true);
    depth_.set(0.5f, true);
    phase_ = 0.0;
}
void PanFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    if (index == 0)
        rate_.set(clampf(value, 0.1f, 10.0f), immediate);
    else if (index == 1)
        depth_.set(clampf(value, 0.0f, 100.0f) * 0.01f, immediate);
}
float PanFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    return index == 0 ? rate_.target : index == 1 ? depth_.target * 100.0f : 0.0f;
}
void PanFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double rS = static_cast<double>(rate_.cur), rE = static_cast<double>(rate_.advance(n, sr_, kFxTau));
    const double dS = static_cast<double>(depth_.cur), dE = static_cast<double>(depth_.advance(n, sr_, kFxTau));
    const double invN = 1.0 / static_cast<double>(n);
    for (int i = 0; i < n; ++i)
    {
        const double t = static_cast<double>(i) * invN;
        const double rate = rS + (rE - rS) * t;
        const double depth = dS + (dE - dS) * t;
        const double pan = std::clamp(depth * std::sin(kTwoPi * phase_), -1.0, 1.0);
        phase_ += rate / sr_;
        if (phase_ >= 1.0)
            phase_ -= 1.0;
        if (pan == 0.0)
            continue;
        const double a = l[i], b = r[i];
        if (pan <= 0.0)
        {
            const double x = (pan + 1.0) * kHalfPi;
            l[i] = a + b * std::cos(x);
            r[i] = b * std::sin(x);
        }
        else
        {
            const double x = pan * kHalfPi;
            l[i] = a * std::cos(x);
            r[i] = b + a * std::sin(x);
        }
    }
}

} // namespace terminator
