#include "terminator/core/fx/AnalogFx.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr float kFxTau = 0.01f; // the page's setParam(…, 0.01) glide
constexpr double kPi = 3.14159265358979323846;
/// The ladder's thermal voltage (the model's tanh scaling) — the BASS synth's constant.
constexpr double kVt = 0.312;

float clampf(float v, float lo, float hi) noexcept
{
    return v < lo ? lo : (v > hi ? hi : v);
}

/// Fast tanh (Padé 7/6, clamped at ±4.97) — the ladder calls it 16× per sample per channel at 4×, so std::tanh
/// would cost more than the rest of the device put together. The same approximation the BASS synth's ladder uses.
inline double ftanh(double x) noexcept TERMINATOR_NONBLOCKING
{
    if (x > 4.97)
        return 1.0;
    if (x < -4.97)
        return -1.0;
    const double x2 = x * x;
    return x * (135135.0 + x2 * (17325.0 + x2 * (378.0 + x2))) /
           (135135.0 + x2 * (62370.0 + x2 * (3150.0 + x2 * 28.0)));
}
} // namespace

// ---- MoogLadder ---------------------------------------------------------------------------------------------

void MoogLadder::reset() noexcept TERMINATOR_NONBLOCKING
{
    for (int i = 0; i < 4; ++i)
        V[i] = dV[i] = tV[i] = 0.0;
}

void MoogLadder::setCutoff(double hz, double srOs) noexcept TERMINATOR_NONBLOCKING
{
    const double x = kPi * hz / srOs;
    g = 4.0 * kPi * kVt * hz * (1.0 - x) / (1.0 + x);
}

void MoogLadder::step(double x, double res, double srOs) noexcept TERMINATOR_NONBLOCKING
{
    const double inv2Vt = 1.0 / (2.0 * kVt), h = 1.0 / (2.0 * srOs);
    const double dV0 = -g * (ftanh((x + res * V[3]) * inv2Vt) + tV[0]);
    V[0] += (dV0 + dV[0]) * h;
    dV[0] = dV0;
    tV[0] = ftanh(V[0] * inv2Vt);
    const double dV1 = g * (tV[0] - tV[1]);
    V[1] += (dV1 + dV[1]) * h;
    dV[1] = dV1;
    tV[1] = ftanh(V[1] * inv2Vt);
    const double dV2 = g * (tV[1] - tV[2]);
    V[2] += (dV2 + dV[2]) * h;
    dV[2] = dV2;
    tV[2] = ftanh(V[2] * inv2Vt);
    const double dV3 = g * (tV[2] - tV[3]);
    V[3] += (dV3 + dV[3]) * h;
    dV[3] = dV3;
    tV[3] = ftanh(V[3] * inv2Vt);
}

// ---- ButterLp4 ----------------------------------------------------------------------------------------------

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
    const double g = std::tan(kPi * std::min(0.49 * sampleRate, cutoffHz) / sampleRate);
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

// ---- ANALOG FILTER ------------------------------------------------------------------------------------------

void LadderFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    srOs_ = sampleRate * static_cast<double>(kOversample);
    reset();
}

void LadderFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    mode_ = 0.0f;
    cutoff_.set(20000.0f, true);
    reso_.set(0.0f, true);
    drive_.set(0.0f, true);
    fL_.reset();
    fR_.reset();
    decL_.reset();
    decR_.reset();
    // The decimator sits just under the BASE Nyquist: flat where the music is, steep where the images land.
    decL_.set(sr_ * 0.47, srOs_);
    decR_.set(sr_ * 0.47, srOs_);
    recompute();
    rng_ = 0x1234567u;
}

void LadderFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    if (index == 0)
        mode_ = clampf(std::floor(value), 0.0f, 7.0f);
    else if (index == 1)
        cutoff_.set(clampf(value, 20.0f, 20000.0f), immediate);
    else if (index == 2)
        reso_.set(clampf(value, 0.0f, 100.0f), immediate);
    else if (index == 3)
        drive_.set(clampf(value, 0.0f, 100.0f), immediate);
    if (immediate)
        recompute(); // a glide-free set never reaches the block-start recompute in process()
}

void LadderFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    fL_.setCutoff(static_cast<double>(cutoff_.cur), srOs_);
    fR_.setCutoff(static_cast<double>(cutoff_.cur), srOs_);
}

float LadderFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    return index == 0   ? mode_
           : index == 1 ? cutoff_.target
           : index == 2 ? reso_.target
           : index == 3 ? drive_.target
                        : 0.0f;
}

/// Oberheim-style tap mixing on the ladder's four stages: yk = LP^k(x), so (1 − LP)^n expands into the highpass
/// and bandpass shapes without a second filter.
double LadderFx::tapMix(const MoogLadder& f, double x) const noexcept TERMINATOR_NONBLOCKING
{
    const double y1 = f.tapLp1(), y2 = f.tapLp2(), y3 = f.tapLp3(), y4 = f.tapLp4();
    switch (static_cast<int>(mode_))
    {
    case 0:
        return y4; // LP 24 dB
    case 1:
        return y3; // LP 18 dB
    case 2:
        return y2; // LP 12 dB
    case 3:
        return y1; // LP 6 dB
    case 4:
        return x - 4.0 * y1 + 6.0 * y2 - 4.0 * y3 + y4; // HP 24 dB
    case 5:
        return x - 2.0 * y1 + y2; // HP 12 dB
    case 6:
        return 4.0 * y2 - 8.0 * y3 + 4.0 * y4; // BP 24 dB
    default:
        return 2.0 * (y1 - y2); // BP 12 dB
    }
}

/// The overdrive in front of the ladder: dry at DRIVE 0, a compensated tanh at DRIVE 100.
double LadderFx::drive(double x, double d, double g, double comp) noexcept TERMINATOR_NONBLOCKING
{
    return d <= 0.0 ? x : x * (1.0 - d) + ftanh(x * g) * comp * d;
}

/// The analog noise floor (≈ −120 dBFS): what makes RESO 100 sing from silence instead of sitting at exactly zero.
double LadderFx::noise() noexcept TERMINATOR_NONBLOCKING
{
    rng_ ^= rng_ << 13;
    rng_ ^= rng_ >> 17;
    rng_ ^= rng_ << 5;
    return (static_cast<double>(rng_) * (1.0 / 2147483648.0) - 1.0) * 1e-6;
}

void LadderFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    if (cutoff_.moving() || reso_.moving() || drive_.moving())
    {
        cutoff_.advance(n, sr_, kFxTau, 1e-3f);
        reso_.advance(n, sr_, kFxTau);
        drive_.advance(n, sr_, kFxTau);
        recompute();
    }
    const double res = static_cast<double>(reso_.cur) * 0.045; // 0..100 → 0..4.5 (self-oscillates at the top)
    const double d = static_cast<double>(drive_.cur) * 0.01;
    // The INPUT stage, not a gain: inside the ladder the tanh appears on both sides of every pole and cancels for
    // anything well under the cutoff, so a bare input gain would add no colour at all. This is the mixer overdrive
    // in front of the ladder — crossfaded in by DRIVE (so DRIVE 0 is bit-clean) and level-compensated by √g, which
    // is what makes DRIVE read as harmonics rather than volume.
    const double g = 1.0 + 15.0 * d;
    const double comp = 1.0 / std::sqrt(g);
    for (int i = 0; i < n; ++i)
    {
        const double xl = drive(l[i], d, g, comp) + noise();
        const double xr = drive(r[i], d, g, comp) + noise();
        double ol = 0.0, orr = 0.0;
        for (int k = 0; k < kOversample; ++k) // ZOH up, Butterworth down
        {
            fL_.step(xl, res, srOs_);
            fR_.step(xr, res, srOs_);
            ol = decL_.process(tapMix(fL_, xl));
            orr = decR_.process(tapMix(fR_, xr));
        }
        l[i] = ol;
        r[i] = orr;
    }
}

} // namespace terminator
