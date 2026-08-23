#include "terminator/core/fx/ShaperFx.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr float kFxTau = 0.01f;
constexpr double kClipCeiling = 0.9886; // −0.1 dBFS
constexpr double kButterworthDb = -3.0103;

float clampf(float v, float lo, float hi) noexcept
{
    return v < lo ? lo : (v > hi ? hi : v);
}
double clampd(double v, double lo, double hi) noexcept TERMINATOR_NONBLOCKING
{
    return v < lo ? lo : (v > hi ? hi : v);
}

/// A per-base-sample linear ramp of a drive from its block start to its block end (the Glide advanced per block).
struct Ramp
{
    double start, step;
    double at(int i) const noexcept TERMINATOR_NONBLOCKING { return start + step * static_cast<double>(i); }
};

struct ClipCurve
{
    Ramp amt;
    double operator()(double x, int i) const noexcept TERMINATOR_NONBLOCKING { return ClipFx::curve(x, amt.at(i)); }
};
struct WaveCurve
{
    Ramp drive;
    double operator()(double x, int i) const noexcept TERMINATOR_NONBLOCKING { return WaveFx::curve(x, drive.at(i)); }
};
struct SatCurve
{
    Ramp drive;
    double operator()(double x, int i) const noexcept TERMINATOR_NONBLOCKING
    {
        return SatFx::doidic(x, 1.0 + 2.0 * drive.at(i));
    }
};
struct BandCurve
{
    Ramp drive; // 0..1
    double operator()(double x, int i) const noexcept TERMINATOR_NONBLOCKING
    {
        const double a = 4.0 * drive.at(i);
        const double X = clampd(x, -4.0, 4.0);
        return a < 1e-4 ? X : std::tanh(a * X) / a;
    }
};
} // namespace

// ---- OversampledShaper -----------------------------------------------------------------------------------------

void OversampledShaper::prepare(int maxBlockSize)
{
    maxBlock_ = std::max(1, maxBlockSize);
    s4_.assign(static_cast<std::size_t>(4 * maxBlock_), 0.0);
    osL_.prepare();
    osR_.prepare();
}
void OversampledShaper::reset() noexcept TERMINATOR_NONBLOCKING
{
    osL_.reset();
    osR_.reset();
}

// ---- CLIP --------------------------------------------------------------------------------------------------

double ClipFx::curve(double x, double amt01) noexcept TERMINATOR_NONBLOCKING
{
    const double t = 1.0 - amt01 * 0.9;
    const double ax = std::min(x < 0.0 ? -x : x, 1.0); // the curve domain
    double y = ax;
    if (t < 1.0 && ax > t)
    {
        const double o = ax - t, d = 1.0 - t;
        const double q = o / d;
        y = t + o / (1.0 + q * q);
    }
    y = std::min(kClipCeiling, y);
    return x < 0.0 ? -y : y;
}
void ClipFx::prepare(double sampleRate, int maxBlockSize)
{
    sr_ = sampleRate;
    os_.prepare(maxBlockSize);
    reset();
}
void ClipFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    amt_.set(0.0f, true);
    os_.reset();
}
void ClipFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    if (index == 0)
        amt_.set(clampf(value, 0.0f, 100.0f), immediate);
}
float ClipFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    return index == 0 ? amt_.target : 0.0f;
}
void ClipFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double s = static_cast<double>(amt_.cur) * 0.01, e = static_cast<double>(amt_.advance(n, sr_, kFxTau)) * 0.01;
    os_.process(l, r, n, ClipCurve{{s, (e - s) / static_cast<double>(std::max(1, n))}});
}

// ---- WAVE --------------------------------------------------------------------------------------------------

double WaveFx::curve(double x, double drive01) noexcept TERMINATOR_NONBLOCKING
{
    const double k = 1.0 + drive01 * 24.0;
    return std::tanh(clampd(x, -1.0, 1.0) * k) / std::tanh(k);
}
void WaveFx::prepare(double sampleRate, int maxBlockSize)
{
    sr_ = sampleRate;
    os_.prepare(maxBlockSize);
    reset();
}
void WaveFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    drive_.set(0.0f, true);
    os_.reset();
}
void WaveFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    if (index == 0)
        drive_.set(clampf(value, 0.0f, 100.0f), immediate);
}
float WaveFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    return index == 0 ? drive_.target : 0.0f;
}
void WaveFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double s = static_cast<double>(drive_.cur) * 0.01,
                 e = static_cast<double>(drive_.advance(n, sr_, kFxTau)) * 0.01;
    os_.process(l, r, n, WaveCurve{{s, (e - s) / static_cast<double>(std::max(1, n))}});
}

// ---- SAT ---------------------------------------------------------------------------------------------------

double SatFx::doidic(double x, double g) noexcept TERMINATOR_NONBLOCKING
{
    const double xc = clampd(clampd(x, -1.0, 1.0) * g, -1.0, 1.0);
    return 1.5 * xc * (1.0 - xc * xc / 3.0);
}
void SatFx::prepare(double sampleRate, int maxBlockSize)
{
    sr_ = sampleRate;
    os_.prepare(maxBlockSize);
    reset();
}
void SatFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    drive_.set(0.0f, true);
    os_.reset();
}
void SatFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    if (index == 0)
        drive_.set(clampf(value, 0.0f, 100.0f), immediate);
}
float SatFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    return index == 0 ? drive_.target : 0.0f;
}
void SatFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double s = static_cast<double>(drive_.cur) * 0.01,
                 e = static_cast<double>(drive_.advance(n, sr_, kFxTau)) * 0.01;
    os_.process(l, r, n, SatCurve{{s, (e - s) / static_cast<double>(std::max(1, n))}});
}

// ---- MB SAT ------------------------------------------------------------------------------------------------

void MbSatFx::prepare(double sampleRate, int maxBlockSize)
{
    sr_ = sampleRate;
    maxBlock_ = std::max(1, maxBlockSize);
    for (int b = 0; b < 3; ++b)
    {
        band_[b].prepare(maxBlock_);
        bL_[b].assign(static_cast<std::size_t>(maxBlock_), 0.0);
        bR_[b].assign(static_cast<std::size_t>(maxBlock_), 0.0);
    }
    dryL_.prepare(OversampledShaper::latencySamples() + 1);
    dryR_.prepare(OversampledShaper::latencySamples() + 1);
    reset();
}
void MbSatFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& d : drive_)
        d.set(0.0f, true);
    loX_.set(200.0f, true);
    hiX_.set(3000.0f, true);
    wet_ = 100.0f;
    for (int c = 0; c < 2; ++c)
        for (auto* b : {&lowLp1_[c], &lowLp2_[c], &lowAp_[c], &restHp1_[c], &restHp2_[c], &midLp1_[c], &midLp2_[c],
                        &highHp1_[c], &highHp2_[c], &dryAp1_[c], &dryAp2_[c]})
            b->reset();
    for (auto& b : band_)
        b.reset();
    dryL_.reset();
    dryR_.reset();
    recompute();
}
void MbSatFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
    case 1:
    case 2:
        drive_[index].set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 3:
        loX_.set(clampf(value, 40.0f, 2000.0f), immediate);
        break;
    case 4:
        hiX_.set(clampf(value, 500.0f, 16000.0f), immediate);
        break;
    case 5:
        wet_ = clampf(value, 0.0f, 100.0f);
        break;
    default:
        break;
    }
    if (immediate)
        recompute();
}
float MbSatFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
    case 1:
    case 2:
        return drive_[index].target;
    case 3:
        return loX_.target;
    case 4:
        return hiX_.target;
    case 5:
        return wet_;
    default:
        return 0.0f;
    }
}
void MbSatFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    const double lo = static_cast<double>(loX_.cur);
    double hi = static_cast<double>(hiX_.cur);
    if (hi < lo * 1.5)
        hi = lo * 1.5; // keep a real mid band
    for (int c = 0; c < 2; ++c)
    {
        lowLp1_[c].set(Biquad::Type::lowpass, lo, kButterworthDb, 0.0, sr_);
        lowLp2_[c].set(Biquad::Type::lowpass, lo, kButterworthDb, 0.0, sr_);
        restHp1_[c].set(Biquad::Type::highpass, lo, kButterworthDb, 0.0, sr_);
        restHp2_[c].set(Biquad::Type::highpass, lo, kButterworthDb, 0.0, sr_);
        dryAp1_[c].set(Biquad::Type::allpass, lo, 0.70710678118654752, 0.0, sr_);
        midLp1_[c].set(Biquad::Type::lowpass, hi, kButterworthDb, 0.0, sr_);
        midLp2_[c].set(Biquad::Type::lowpass, hi, kButterworthDb, 0.0, sr_);
        highHp1_[c].set(Biquad::Type::highpass, hi, kButterworthDb, 0.0, sr_);
        highHp2_[c].set(Biquad::Type::highpass, hi, kButterworthDb, 0.0, sr_);
        lowAp_[c].set(Biquad::Type::allpass, hi, 0.70710678118654752, 0.0, sr_);
        dryAp2_[c].set(Biquad::Type::allpass, hi, 0.70710678118654752, 0.0, sr_);
    }
}
void MbSatFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    n = std::min(n, maxBlock_);
    if (loX_.moving() || hiX_.moving())
    {
        loX_.advance(n, sr_, kFxTau);
        hiX_.advance(n, sr_, kFxTau);
        recompute();
    }
    double dS[3], dE[3];
    for (int b = 0; b < 3; ++b)
    {
        dS[b] = static_cast<double>(drive_[b].cur) * 0.01;
        dE[b] = static_cast<double>(drive_[b].advance(n, sr_, kFxTau)) * 0.01;
    }
    const double invN = 1.0 / static_cast<double>(std::max(1, n));
    // split + the dry leg (in place on l/r: AP·AP → ±4 clamp → the oversampler's delay)
    for (int i = 0; i < n; ++i)
    {
        const double xl = l[i], xr = r[i];
        bL_[0][static_cast<std::size_t>(i)] = lowAp_[0].process(lowLp2_[0].process(lowLp1_[0].process(xl)));
        bR_[0][static_cast<std::size_t>(i)] = lowAp_[1].process(lowLp2_[1].process(lowLp1_[1].process(xr)));
        const double rl = restHp2_[0].process(restHp1_[0].process(xl));
        const double rr = restHp2_[1].process(restHp1_[1].process(xr));
        bL_[1][static_cast<std::size_t>(i)] = midLp2_[0].process(midLp1_[0].process(rl));
        bR_[1][static_cast<std::size_t>(i)] = midLp2_[1].process(midLp1_[1].process(rr));
        bL_[2][static_cast<std::size_t>(i)] = highHp2_[0].process(highHp1_[0].process(rl));
        bR_[2][static_cast<std::size_t>(i)] = highHp2_[1].process(highHp1_[1].process(rr));
        const double dl = clampd(dryAp2_[0].process(dryAp1_[0].process(xl)), -4.0, 4.0);
        const double dr = clampd(dryAp2_[1].process(dryAp1_[1].process(xr)), -4.0, 4.0);
        l[i] = dryL_.process(dl, static_cast<double>(OversampledShaper::latencySamples()));
        r[i] = dryR_.process(dr, static_cast<double>(OversampledShaper::latencySamples()));
    }
    // each band through its 4× shaper, then makeup √(1 + 4·drive)
    const double m = static_cast<double>(wet_) * 0.01, d = 1.0 - m;
    for (int i = 0; i < n; ++i)
    {
        l[i] *= d;
        r[i] *= d;
    }
    for (int b = 0; b < 3; ++b)
    {
        band_[b].process(bL_[b].data(), bR_[b].data(), n, BandCurve{{dS[b], (dE[b] - dS[b]) * invN}});
        for (int i = 0; i < n; ++i)
        {
            const double drv = dS[b] + (dE[b] - dS[b]) * static_cast<double>(i) * invN;
            const double mk = std::sqrt(1.0 + drv * 4.0) * m;
            l[i] += bL_[b][static_cast<std::size_t>(i)] * mk;
            r[i] += bR_[b][static_cast<std::size_t>(i)] * mk;
        }
    }
}

} // namespace terminator
