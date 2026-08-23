#include "terminator/core/fx/ModFx.h"

#include <algorithm>
#include <cmath>

#include "terminator/core/fx/ShaperFx.h"

namespace terminator
{

namespace
{
constexpr float kFxTau = 0.01f;
constexpr float kLfoTau = 0.02f;
constexpr float kWowTau = 0.05f;

float clampf(float v, float lo, float hi) noexcept
{
    return v < lo ? lo : (v > hi ? hi : v);
}
} // namespace

// ---- DELAY -------------------------------------------------------------------------------------------------

void DelayFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    const int maxD = static_cast<int>(std::ceil(2.0 * sampleRate)) + 2;
    lineL_.prepare(maxD);
    lineR_.prepare(maxD);
    reset();
}
void DelayFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    time_.set(0.3f, true);
    fb_.set(0.35f, true);
    wet_ = 30.0f;
    pingpong_ = 0.0f;
    lineL_.reset();
    lineR_.reset();
    for (auto* b : {&lpL_, &lpR_})
    {
        b->reset();
        b->set(Biquad::Type::lowpass, 7500.0, 0.5, 0.0, sr_);
    }
    for (auto* b : {&hpL_, &hpR_})
    {
        b->reset();
        b->set(Biquad::Type::highpass, 90.0, 0.5, 0.0, sr_);
    }
}
void DelayFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        time_.set(clampf(value, 1.0f, 2000.0f) * 0.001f, immediate);
        break;
    case 1:
        fb_.set(clampf(value, 0.0f, 95.0f) * 0.01f, immediate);
        break;
    case 2:
        wet_ = clampf(value, 0.0f, 100.0f);
        break;
    case 3:
        pingpong_ = value >= 0.5f ? 1.0f : 0.0f;
        break;
    default:
        break;
    }
}
float DelayFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return time_.target * 1000.0f;
    case 1:
        return fb_.target * 100.0f;
    case 2:
        return wet_;
    case 3:
        return pingpong_;
    default:
        return 0.0f;
    }
}
void DelayFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double tS = static_cast<double>(time_.cur), tE = static_cast<double>(time_.advance(n, sr_, kFxTau));
    const double fS = static_cast<double>(fb_.cur), fE = static_cast<double>(fb_.advance(n, sr_, kFxTau));
    const double invN = 1.0 / static_cast<double>(std::max(1, n));
    const bool pp = pingpong_ >= 0.5f;
    for (int i = 0; i < n; ++i)
    {
        const double t = static_cast<double>(i) * invN;
        const double time = tS + (tE - tS) * t;
        const double fb = fS + (fE - fS) * t;
        const double dL = time * sr_;
        const double dR = std::min(2.0, time * 1.02) * sr_;
        if (pp)
        {
            const double yR = lineR_.readAt(dR);
            const double yL = lineL_.readAt(dL);
            const double m = 0.5 * (l[i] + r[i]);
            lineL_.write(m + hpL_.process(lpL_.process(fb * yR)));
            lineR_.write(yL);
            l[i] = yL;
            r[i] = yR;
        }
        else
        {
            const double yL = lineL_.readAt(dL);
            const double yR = lineR_.readAt(dR);
            lineL_.write(l[i] + hpL_.process(lpL_.process(fb * yL)));
            lineR_.write(r[i] + hpR_.process(lpR_.process(fb * yR)));
            l[i] = yL;
            r[i] = yR;
        }
    }
}

// ---- PHASER ------------------------------------------------------------------------------------------------

namespace
{
constexpr int kPhaserStages[] = {4, 6, 8, 12};
constexpr int kPhaserUpdate = 16;
} // namespace

void PhaserFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    reset();
}
void PhaserFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    rate_.set(0.4f, true);
    depth_.set(0.7f, true);
    center_.set(900.0f, true);
    fb_.set(0.3f, true);
    stagesIdx_ = 1;
    wet_ = 50.0f;
    phase_ = 0.0;
    lastL_ = lastR_ = 0.0;
    for (int i = 0; i < kMaxStages; ++i)
    {
        apL_[i].reset();
        apR_[i].reset();
    }
    recompute(0.0);
}
void PhaserFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        rate_.set(clampf(value, 0.02f, 10.0f), immediate);
        break;
    case 1:
        depth_.set(clampf(value, 0.0f, 100.0f) * 0.01f, immediate);
        break;
    case 2:
        center_.set(clampf(value, 100.0f, 8000.0f), immediate);
        break;
    case 3:
        fb_.set(clampf(value, 0.0f, 90.0f) * 0.01f, immediate);
        break;
    case 4:
        stagesIdx_ = static_cast<int>(clampf(std::floor(value), 0.0f, 3.0f));
        break;
    case 5:
        wet_ = clampf(value, 0.0f, 100.0f);
        break;
    default:
        break;
    }
    if (immediate)
        recompute(lfoSine(phase_));
}
float PhaserFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return rate_.target;
    case 1:
        return depth_.target * 100.0f;
    case 2:
        return center_.target;
    case 3:
        return fb_.target * 100.0f;
    case 4:
        return static_cast<float>(stagesIdx_);
    case 5:
        return wet_;
    default:
        return 0.0f;
    }
}
void PhaserFx::recompute(double lfo) noexcept TERMINATOR_NONBLOCKING
{
    const int n = kPhaserStages[stagesIdx_];
    const double center = static_cast<double>(center_.cur);
    const double depth = static_cast<double>(depth_.cur);
    const double lowest = center * 0.70710678118654752;
    const double mod = std::min(depth * center * 0.9, std::max(0.0, lowest - 40.0));
    for (int i = 0; i < n; ++i)
    {
        const double spread = n > 1 ? static_cast<double>(i) / static_cast<double>(n - 1) - 0.5 : 0.0;
        const double f = center * std::pow(2.0, spread) + mod * lfo;
        apL_[i].set(Biquad::Type::allpass, f, 0.6, 0.0, sr_);
        apR_[i].set(Biquad::Type::allpass, f, 0.6, 0.0, sr_);
    }
}
void PhaserFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double rS = static_cast<double>(rate_.cur), rE = static_cast<double>(rate_.advance(n, sr_, kLfoTau));
    const double fS = static_cast<double>(fb_.cur), fE = static_cast<double>(fb_.advance(n, sr_, kLfoTau));
    depth_.advance(n, sr_, kLfoTau);
    center_.advance(n, sr_, kLfoTau);
    const double invN = 1.0 / static_cast<double>(std::max(1, n));
    const int stages = kPhaserStages[stagesIdx_];
    for (int i = 0; i < n; ++i)
    {
        const double t = static_cast<double>(i) * invN;
        if ((i % kPhaserUpdate) == 0)
            recompute(lfoSine(phase_));
        phase_ = advancePhase(phase_, rS + (rE - rS) * t, sr_);
        const double fb = fS + (fE - fS) * t;
        double a = l[i] + fb * lastL_, b = r[i] + fb * lastR_;
        for (int s = 0; s < stages; ++s)
        {
            a = apL_[s].process(a);
            b = apR_[s].process(b);
        }
        lastL_ = a;
        lastR_ = b;
        l[i] = a;
        r[i] = b;
    }
}

// ---- FLANGER -----------------------------------------------------------------------------------------------

void FlangerFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    const int maxD = static_cast<int>(std::ceil(0.05 * sampleRate)) + 2;
    lineL_.prepare(maxD);
    lineR_.prepare(maxD);
    reset();
}
void FlangerFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    rate_.set(0.25f, true);
    depthPct_ = 60.0f;
    base_.set(0.003f, true);
    depthS_.set(0.6f * 0.003f * 0.9f, true);
    fb_.set(0.4f, true);
    wet_ = 50.0f;
    phase_ = 0.0;
    lineL_.reset();
    lineR_.reset();
    for (auto* b : {&lpL_, &lpR_})
    {
        b->reset();
        b->set(Biquad::Type::lowpass, 9000.0, 0.5, 0.0, sr_);
    }
}
void FlangerFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        rate_.set(clampf(value, 0.02f, 8.0f), immediate);
        break;
    case 1:
        depthPct_ = clampf(value, 0.0f, 100.0f);
        break;
    case 2:
        base_.set(clampf(value, 0.3f, 12.0f) * 0.001f, immediate);
        break;
    case 3:
        fb_.set(clampf(value, -95.0f, 95.0f) * 0.01f, immediate);
        break;
    case 4:
        wet_ = clampf(value, 0.0f, 100.0f);
        break;
    default:
        break;
    }
    if (index == 1 || index == 2)
        depthS_.set(depthPct_ * 0.01f * base_.target * 0.9f, immediate);
}
float FlangerFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return rate_.target;
    case 1:
        return depthPct_;
    case 2:
        return base_.target * 1000.0f;
    case 3:
        return fb_.target * 100.0f;
    case 4:
        return wet_;
    default:
        return 0.0f;
    }
}
void FlangerFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double rS = static_cast<double>(rate_.cur), rE = static_cast<double>(rate_.advance(n, sr_, kLfoTau));
    const double bS = static_cast<double>(base_.cur), bE = static_cast<double>(base_.advance(n, sr_, kLfoTau));
    const double dS = static_cast<double>(depthS_.cur), dE = static_cast<double>(depthS_.advance(n, sr_, kLfoTau));
    const double fS = static_cast<double>(fb_.cur), fE = static_cast<double>(fb_.advance(n, sr_, kLfoTau));
    const double invN = 1.0 / static_cast<double>(std::max(1, n));
    for (int i = 0; i < n; ++i)
    {
        const double t = static_cast<double>(i) * invN;
        const double lfo = lfoTriangle(phase_);
        phase_ = advancePhase(phase_, rS + (rE - rS) * t, sr_);
        const double delaySec = (bS + (bE - bS) * t) + (dS + (dE - dS) * t) * lfo;
        const double d = std::max(1.0, delaySec * sr_);
        const double fb = fS + (fE - fS) * t;
        const double yL = lineL_.readAt(d), yR = lineR_.readAt(d);
        lineL_.write(l[i] + lpL_.process(fb * yL));
        lineR_.write(r[i] + lpR_.process(fb * yR));
        l[i] = yL;
        r[i] = yR;
    }
}

// ---- VINYL / TAPE ------------------------------------------------------------------------------------------

void VinylFx::prepare(double sampleRate, int maxBlockSize)
{
    sr_ = sampleRate;
    maxBlock_ = std::max(1, maxBlockSize);
    s4_.assign(static_cast<std::size_t>(4 * maxBlock_), 0.0);
    osL_.prepare();
    osR_.prepare();
    const int maxD = static_cast<int>(std::ceil(0.1 * sampleRate)) + 2;
    for (auto* d : {&wowL_, &wowR_, &flutL_, &flutR_})
        d->prepare(maxD);
    reset();
}
void VinylFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    warmth_.set(4.0f, true);
    drive_.set(2.0f, true);
    wow_.set(3.0f, true);
    flutter_.set(3.0f, true);
    age_.set(3.0f, true);
    wowPhase_ = flutPhase_ = 0.0;
    osL_.reset();
    osR_.reset();
    for (auto* b : {&lpL_, &lpR_, &hpL_, &hpR_, &warmL_, &warmR_})
        b->reset();
    for (auto* d : {&wowL_, &wowR_, &flutL_, &flutR_})
        d->reset();
    recompute();
}
void VinylFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    const float v = clampf(value, 0.0f, 10.0f);
    switch (index)
    {
    case 0:
        warmth_.set(v, immediate);
        break;
    case 1:
        drive_.set(v, immediate);
        break;
    case 2:
        wow_.set(v, immediate);
        break;
    case 3:
        flutter_.set(v, immediate);
        break;
    case 4:
        age_.set(v, immediate);
        break;
    default:
        break;
    }
    if (immediate)
        recompute();
}
float VinylFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return warmth_.target;
    case 1:
        return drive_.target;
    case 2:
        return wow_.target;
    case 3:
        return flutter_.target;
    case 4:
        return age_.target;
    default:
        return 0.0f;
    }
}
int VinylFx::latencySamples() const noexcept TERMINATOR_NONBLOCKING
{
    return static_cast<int>(std::lround(0.005 * sr_)) + Oversampler4x::latencySamples();
}
void VinylFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    const double age = static_cast<double>(age_.cur), warm = static_cast<double>(warmth_.cur);
    const double lpF = 20000.0 - (age / 10.0) * 12000.0;
    const double gain = 2.0 + (warm / 10.0) * 4.0;
    lpL_.set(Biquad::Type::lowpass, lpF, 0.3, 0.0, sr_);
    lpR_.set(Biquad::Type::lowpass, lpF, 0.3, 0.0, sr_);
    hpL_.set(Biquad::Type::highpass, 20.0, 1.0, 0.0, sr_);
    hpR_.set(Biquad::Type::highpass, 20.0, 1.0, 0.0, sr_);
    warmL_.set(Biquad::Type::peaking, 200.0, 0.7, gain, sr_);
    warmR_.set(Biquad::Type::peaking, 200.0, 0.7, gain, sr_);
}
void VinylFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    n = std::min(n, maxBlock_);
    const bool moving = age_.moving() || warmth_.moving();
    const double dS = static_cast<double>(drive_.cur), dE = static_cast<double>(drive_.advance(n, sr_, kFxTau));
    age_.advance(n, sr_, kLfoTau);
    warmth_.advance(n, sr_, kLfoTau);
    const double wS = static_cast<double>(wow_.cur), wE = static_cast<double>(wow_.advance(n, sr_, kWowTau));
    const double fS = static_cast<double>(flutter_.cur), fE = static_cast<double>(flutter_.advance(n, sr_, kWowTau));
    if (moving)
        recompute();
    const double invN = 1.0 / static_cast<double>(std::max(1, n));
    // the tape saturation at 4× (the drive ramps per base sample)
    double* s = s4_.data();
    for (int c = 0; c < 2; ++c)
    {
        double* x = c == 0 ? l : r;
        (c == 0 ? osL_ : osR_).up(x, s, n);
        for (int i = 0; i < n; ++i)
        {
            const double g = 1.0 + ((dS + (dE - dS) * static_cast<double>(i) * invN) / 10.0) * 3.0;
            for (int k = 0; k < 4; ++k)
                s[4 * i + k] = SatFx::doidic(s[4 * i + k], g);
        }
        (c == 0 ? osL_ : osR_).down(s, x, n);
    }
    // LP → HP → wow → flutter → warmth
    for (int i = 0; i < n; ++i)
    {
        const double t = static_cast<double>(i) * invN;
        const double wow = wS + (wE - wS) * t, flut = fS + (fE - fS) * t;
        const double wowHz = 0.1 + (wow / 10.0) * 0.7, wowDepth = (wow / 10.0) * 0.003;
        const double flutHz = 3.0 + (flut / 10.0) * 5.0, flutDepth = (flut / 10.0) * 0.0005;
        const double dWow = (0.004 + wowDepth * lfoSine(wowPhase_)) * sr_;
        const double dFlut = (0.001 + flutDepth * lfoSine(flutPhase_)) * sr_;
        wowPhase_ = advancePhase(wowPhase_, wowHz, sr_);
        flutPhase_ = advancePhase(flutPhase_, flutHz, sr_);
        double a = hpL_.process(lpL_.process(l[i]));
        double b = hpR_.process(lpR_.process(r[i]));
        a = flutL_.process(wowL_.process(a, dWow), dFlut);
        b = flutR_.process(wowR_.process(b, dWow), dFlut);
        l[i] = warmL_.process(a);
        r[i] = warmR_.process(b);
    }
}

} // namespace terminator
