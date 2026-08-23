#include "terminator/core/fx/ConsoleStage.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr double kPi = 3.14159265358979323846;

struct Flavour
{
    double a2, a3, hp, lowF, low, highF, high, peakF, peak, lp;
    double busA2, busA3, busLow, busLp;
};
// Every number = the value at AMOUNT 100 %; AMOUNT scales the drive and the EQ deviations linearly (the worklet's).
constexpr Flavour kFlavours[] = {
    // SSL — clean, forward, odd-harmonic; tight sub filter, a hair of air
    {0.012, 0.144, 24.0, 100.0, 0.0, 8000.0, 0.25, 0.0, 0.0, 0.0, 0.008, 0.25, 0.0, 21000.0},
    // NEVE — transformer warmth: even harmonics, weight down low, softened top
    {0.048, 0.072, 20.0, 100.0, 0.4, 6000.0, -0.2, 0.0, 0.0, 18000.0, 0.03, 0.18, 0.3, 17000.0},
    // API — punch: 2nd AND 3rd, a presence lift around 3 kHz
    {0.03, 0.12, 22.0, 120.0, 0.2, 8000.0, 0.0, 3000.0, 0.25, 0.0, 0.02, 0.2, 0.15, 20000.0},
};

void hpCoeffs(double* c, double f, double sr, double q) noexcept TERMINATOR_NONBLOCKING
{
    const double w0 = 2.0 * kPi * f / sr, cw = std::cos(w0), sw = std::sin(w0), al = sw / (2.0 * q);
    const double b0 = (1.0 + cw) / 2.0, b1 = -(1.0 + cw), b2 = (1.0 + cw) / 2.0, a0 = 1.0 + al, a1 = -2.0 * cw,
                 a2 = 1.0 - al;
    c[0] = b0 / a0;
    c[1] = b1 / a0;
    c[2] = b2 / a0;
    c[3] = a1 / a0;
    c[4] = a2 / a0;
}
void shelfCoeffs(double* c, bool low, double f, double dB, double sr, double S) noexcept TERMINATOR_NONBLOCKING
{
    const double A = std::pow(10.0, dB / 40.0);
    const double w0 = 2.0 * kPi * f / sr, cw = std::cos(w0), sw = std::sin(w0);
    const double al = sw / 2.0 * std::sqrt((A + 1.0 / A) * (1.0 / S - 1.0) + 2.0);
    const double sq = 2.0 * std::sqrt(A) * al;
    double b0, b1, b2, a0, a1, a2;
    if (low)
    {
        b0 = A * ((A + 1.0) - (A - 1.0) * cw + sq);
        b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cw);
        b2 = A * ((A + 1.0) - (A - 1.0) * cw - sq);
        a0 = (A + 1.0) + (A - 1.0) * cw + sq;
        a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cw);
        a2 = (A + 1.0) + (A - 1.0) * cw - sq;
    }
    else
    {
        b0 = A * ((A + 1.0) + (A - 1.0) * cw + sq);
        b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cw);
        b2 = A * ((A + 1.0) + (A - 1.0) * cw - sq);
        a0 = (A + 1.0) - (A - 1.0) * cw + sq;
        a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cw);
        a2 = (A + 1.0) - (A - 1.0) * cw - sq;
    }
    c[0] = b0 / a0;
    c[1] = b1 / a0;
    c[2] = b2 / a0;
    c[3] = a1 / a0;
    c[4] = a2 / a0;
}
void peakCoeffs(double* c, double f, double dB, double sr, double q) noexcept TERMINATOR_NONBLOCKING
{
    const double A = std::pow(10.0, dB / 40.0);
    const double w0 = 2.0 * kPi * f / sr, cw = std::cos(w0), sw = std::sin(w0), al = sw / (2.0 * q);
    const double b0 = 1.0 + al * A, b1 = -2.0 * cw, b2 = 1.0 - al * A, a0 = 1.0 + al / A, a1 = -2.0 * cw,
                 a2 = 1.0 - al / A;
    c[0] = b0 / a0;
    c[1] = b1 / a0;
    c[2] = b2 / a0;
    c[3] = a1 / a0;
    c[4] = a2 / a0;
}

void identity(double* c) noexcept TERMINATOR_NONBLOCKING
{
    c[0] = 1.0;
    c[1] = c[2] = c[3] = c[4] = 0.0;
}

/// mulberry32 (the worklet's): uint32 state, returns [0, 1)
double mulberry32(std::uint32_t& a) noexcept
{
    a += 0x6D2B79F5u;
    std::uint32_t t = a;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
}
} // namespace

std::uint32_t ConsoleStage::fnv1a(const char* name) noexcept
{
    std::uint32_t h = 0x811c9dc5u;
    if (name == nullptr || *name == '\0')
        name = "strip";
    for (const char* p = name; *p != '\0'; ++p)
    {
        h ^= static_cast<std::uint8_t>(*p);
        h *= 0x01000193u;
    }
    return h;
}

void ConsoleStage::prepare(double sampleRate)
{
    sr_ = sampleRate;
    dcR_ = 1.0 - (2.0 * kPi * 5.0) / sampleRate;
    reset();
    recompute();
}

void ConsoleStage::configure(bool bus, std::uint32_t seed) noexcept TERMINATOR_NONBLOCKING
{
    bus_ = bus;
    seed_ = seed;
    if (bus)
        for (auto& t : tol_)
            t = 0.0;
    else
    {
        std::uint32_t a = seed;
        for (auto& t : tol_)
            t = mulberry32(a) * 2.0 - 1.0;
    }
    reset();
    recompute();
}

void ConsoleStage::reset() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& c : ch_)
    {
        c.hp.z1 = c.hp.z2 = c.lo.z1 = c.lo.z2 = c.hi.z1 = c.hi.z2 = c.pk.z1 = c.pk.z2 = 0.0;
        c.lp = c.dcX = c.dcY = 0.0;
    }
}

void ConsoleStage::set(ConsoleFlavour flavour, float amount01, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    flavour_ = flavour;
    amountTarget_ = std::clamp(amount01, 0.0f, 1.0f);
    if (immediate)
        amount_ = amountTarget_;
    recompute();
}

void ConsoleStage::recompute() noexcept TERMINATOR_NONBLOCKING
{
    const Flavour& F = kFlavours[static_cast<int>(flavour_) > 2 ? 0 : static_cast<int>(flavour_)];
    const double amt = static_cast<double>(amount_);
    const double* t = tol_;
    const double sr = sr_;
    // Saturator. Tolerance jitters drive ±15 % per strip.
    a2_ = (bus_ ? F.busA2 : F.a2) * amt * (1.0 + 0.15 * t[0]);
    a3_ = (bus_ ? F.busA3 : F.a3) * amt * (1.0 + 0.15 * t[1]);
    // The odd polynomial x − a3·x³ peaks at x0 = 1/√(3·a3); beyond it we hold (continuous, zero slope).
    x0_ = a3_ > 1e-9 ? 1.0 / std::sqrt(3.0 * a3_) : 1e9;
    oddHold_ = x0_ - a3_ * x0_ * x0_ * x0_;
    evenHold_ = a2_ * x0_ * x0_;
    // EQ.
    const double hpF = bus_ ? 0.0 : std::max(10.0, F.hp + 2.0 * t[2]);
    const double lowDb = (bus_ ? F.busLow : F.low) * amt + (bus_ ? 0.0 : 0.3 * t[3] * amt);
    const double highDb = bus_ ? 0.0 : F.high * amt + 0.3 * t[4] * amt;
    const double lowF = F.lowF * (1.0 + 0.1 * t[5]);
    const double highF = F.highF * (1.0 + 0.1 * t[2]);
    const double lpF = bus_ ? F.busLp : F.lp;
    double hpC[5], loC[5], hiC[5], pkC[5];
    if (hpF > 0.0)
        hpCoeffs(hpC, hpF, sr, 0.70710678118654752);
    else
        identity(hpC);
    if (std::abs(lowDb) > 1e-4)
        shelfCoeffs(loC, true, lowF, lowDb, sr, 1.0);
    else
        identity(loC);
    if (std::abs(highDb) > 1e-4)
        shelfCoeffs(hiC, false, std::min(highF, sr * 0.45), highDb, sr, 1.0);
    else
        identity(hiC);
    if (!bus_ && F.peakF > 0.0 && std::abs(F.peak) > 1e-4)
        peakCoeffs(pkC, F.peakF, F.peak * amt, sr, 0.7);
    else
        identity(pkC);
    // 1-pole LPF: at AMOUNT 0 it opens fully (fc → ∞); otherwise fc blends from very open toward the flavour's corner.
    double lpA = 0.0;
    if (lpF > 0.0 && amt > 0.0 && lpF < sr * 0.49)
    {
        const double fc = lpF + (sr * 0.49 - lpF) * (1.0 - amt);
        lpA = std::exp(-2.0 * kPi * fc / sr);
    }
    for (auto& c : ch_)
    {
        for (int i = 0; i < 5; ++i)
        {
            c.hp.c[i] = hpC[i];
            c.lo.c[i] = loC[i];
            c.hi.c[i] = hiC[i];
            c.pk.c[i] = pkC[i];
        }
    }
    lpA_ = lpA;
}

double ConsoleStage::sat(double x) const noexcept TERMINATOR_NONBLOCKING
{
    // Odd part (3rd harmonic): x − a3·x³, held flat past x0. Even part (2nd harmonic): a2·x², also held — the DC
    // blocker downstream eats the offset the even term carries.
    const double ax = x < 0.0 ? -x : x;
    if (ax >= x0_)
        return (x < 0.0 ? -oddHold_ : oddHold_) + evenHold_;
    return x - a3_ * x * ax * ax + a2_ * x * x;
}

void ConsoleStage::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    // AMOUNT glides over ~23 ms so a knob move never steps (1/1024 per frame, the worklet's).
    if (amount_ != amountTarget_)
    {
        const float step = static_cast<float>(n) / 1024.0f;
        const float d = amountTarget_ - amount_;
        if ((d < 0.0f ? -d : d) <= step)
            amount_ = amountTarget_;
        else
            amount_ += d > 0.0f ? step : -step;
        recompute();
    }
    for (int c = 0; c < 2; ++c)
    {
        double* x = c == 0 ? l : r;
        Channel& s = ch_[c];
        for (int i = 0; i < n; ++i)
        {
            double v = x[i];
            v = s.hp.run(v);
            v = s.lo.run(v);
            v = s.hi.run(v);
            v = s.pk.run(v);
            if (lpA_ > 0.0)
            {
                s.lp = v + lpA_ * (s.lp - v);
                v = s.lp;
            }
            v = sat(v);
            // DC blocker (1-pole HPF at 5 Hz) — always in, so AMOUNT sweeping through 0 never switches modes.
            const double y = v - s.dcX + dcR_ * s.dcY;
            s.dcX = v;
            s.dcY = y;
            x[i] = y;
        }
    }
}

} // namespace terminator
