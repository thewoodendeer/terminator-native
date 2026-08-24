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
/// The FET comp's RATIO switch: the slope, and the knee that goes with it (file scope, not a static local — a
/// function marked nonblocking may not have one: its first call would run a guarded initialisation).
constexpr double kFetRatioSlopes[7] = {1.0, 2.0, 3.0, 4.0, 6.0, 10.0, 20.0};
constexpr double kFetRatioKnees[7] = {0.0, 14.0, 11.0, 9.0, 6.0, 3.0, 1.5};

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

// ---- FET COMP -----------------------------------------------------------------------------------------------

void FetCompFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    srOs_ = sampleRate * static_cast<double>(kOversample);
    reset();
}

void FetCompFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    ratioIdx_ = 3.0f;
    detectIdx_ = 0.0f;
    modeIdx_ = 0.0f;
    input_.set(0.0f, true);
    attack_.set(3.0f, true);
    release_.set(150.0f, true);
    output_.set(0.0f, true);
    gainDb_ = 0.0;
    peakEnv_ = 0.0;
    grDb_ = 0.0f;
    // The side chain's two high-pass options and the BAND emphasis (a wide bell up where a snare lives, so the
    // detector leans on the part of the sound the ear calls "loud").
    scHpL_.reset();
    scHpR_.reset();
    scBandL_.reset();
    scBandR_.reset();
    scHpL_.set(Biquad::Type::highpass, 120.0, 0.0, 0.0, sr_);
    scHpR_.set(Biquad::Type::highpass, 120.0, 0.0, 0.0, sr_);
    scBandL_.set(Biquad::Type::peaking, 2500.0, 0.8, 9.0, sr_);
    scBandR_.set(Biquad::Type::peaking, 2500.0, 0.8, 9.0, sr_);
    decL_.reset();
    decR_.reset();
    decL_.set(sr_ * 0.47, srOs_);
    decR_.set(sr_ * 0.47, srOs_);
    dcInL_ = dcOutL_ = dcInR_ = dcOutR_ = 0.0;
    dcR_ = 1.0 - 2.0 * kPi * 5.0 / sr_; // a 5 Hz blocker, the same corner the console stage uses
}

void FetCompFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        ratioIdx_ = clampf(std::floor(value), 0.0f, 7.0f);
        break;
    case 1:
        input_.set(clampf(value, -12.0f, 24.0f), immediate);
        break;
    case 2:
        attack_.set(clampf(value, 0.05f, 50.0f), immediate);
        break;
    case 3:
        release_.set(clampf(value, 20.0f, 2000.0f), immediate);
        break;
    case 4:
        detectIdx_ = clampf(std::floor(value), 0.0f, 3.0f);
        break;
    case 5:
        modeIdx_ = clampf(std::floor(value), 0.0f, 3.0f);
        break;
    case 6:
        output_.set(clampf(value, -24.0f, 24.0f), immediate);
        break;
    default:
        break;
    }
}

float FetCompFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return ratioIdx_;
    case 1:
        return input_.target;
    case 2:
        return attack_.target;
    case 3:
        return release_.target;
    case 4:
        return detectIdx_;
    case 5:
        return modeIdx_;
    case 6:
        return output_.target;
    default:
        return 0.0f;
    }
}

/// The RATIO switch is the device's character, not one number: the knee tightens as the ratio climbs (2:1 is a
/// broad, forgiving bend; 20:1 is nearly a corner) and **NUKE** is the hardware's party trick — the same 20:1 slope
/// with the threshold dropped, the knee squared off and the release dragged out, so it pins and breathes.
FetCompFx::Curve FetCompFx::curveFor(int i) const noexcept TERMINATOR_NONBLOCKING
{
    Curve c;
    if (i >= 7) // NUKE
    {
        c.ratio = 20.0;
        c.thresholdDb = -24.0;
        c.kneeDb = 0.0;
        c.releaseScale = 3.0;
        return c;
    }
    const int k = i < 0 ? 0 : i;
    c.ratio = kFetRatioSlopes[k];
    c.kneeDb = kFetRatioKnees[k];
    c.thresholdDb = -18.0;
    c.releaseScale = 1.0;
    return c;
}

/// What the SIDE CHAIN hears: FLAT is the signal, HP1 / HP2 take the bottom out of the detector so a kick stops
/// ducking everything, BAND leans on the presence region.
double FetCompFx::detect(double x, int ch) noexcept TERMINATOR_NONBLOCKING
{
    const int d = static_cast<int>(detectIdx_);
    if (d == 0)
        return x;
    if (d == 3)
        return ch == 0 ? scBandL_.process(x) : scBandR_.process(x);
    const double hp = ch == 0 ? scHpL_.process(x) : scHpR_.process(x);
    return d == 1 ? 0.5 * (hp + x) : hp; // HP1 = half in, HP2 = the filtered signal alone
}

/// The output stage's harmonics. DIST 2 is asymmetric (even harmonics, tube-ish), DIST 3 symmetric (odd,
/// transformer-ish), BRITISH is both plus real drive. CLEAN is bit-exact — the mode has to be able to do nothing.
double FetCompFx::shape(double x) const noexcept TERMINATOR_NONBLOCKING
{
    const int m = static_cast<int>(modeIdx_);
    if (m == 0)
        return x;
    // EVERY shaper runs on a BOUNDED input. A bare polynomial is not a saturator: `x + a(x² − x⁴/2)` reaches
    // −6765 at x = 15.8, which is exactly what the +24 dB INPUT stress case found (2985 out of the device). The
    // tanh both bounds it and IS the output stage — a FET box's output does not stay linear when you slam it.
    const double t = ftanh(x);
    switch (m)
    {
    case 1: // DIST 2 — even harmonics (tube-ish). The DC this leaves behind is taken out by the blocker, not by a
            // constant: a fixed offset would be right at one level and wrong at every other (and −0.125 on SILENCE).
        return t + 0.5 * (t * t - 0.5 * t * t * t * t);
    case 2: // DIST 3 — odd harmonics (transformer-ish)
        return t - 0.7 * t * t * t;
    default: // BRITISH — both, plus real drive
        return ftanh(1.6 * (t + 0.3 * t * t - 0.45 * t * t * t)) * 0.75;
    }
}

void FetCompFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    if (input_.moving() || attack_.moving() || release_.moving() || output_.moving())
    {
        input_.advance(n, sr_, kFxTau);
        attack_.advance(n, sr_, kFxTau);
        release_.advance(n, sr_, kFxTau);
        output_.advance(n, sr_, kFxTau);
    }
    const Curve c = curveFor(static_cast<int>(ratioIdx_));
    const bool british = static_cast<int>(modeIdx_) == 3;
    const double inGain = std::pow(10.0, static_cast<double>(input_.cur) / 20.0);
    const double outGain = std::pow(10.0, static_cast<double>(output_.cur) / 20.0);
    // BRITISH grabs faster and lets go sooner — the aggressive input stage is what people reach for it for.
    const double atkMs = std::max(0.02, static_cast<double>(attack_.cur) * (british ? 0.4 : 1.0));
    const double relMs = std::max(5.0, static_cast<double>(release_.cur) * (british ? 0.7 : 1.0));
    const double atkCoef = std::exp(-1.0 / (0.001 * atkMs * sr_));
    const double slope = 1.0 - 1.0 / c.ratio;
    const bool unity = c.ratio <= 1.0;
    // CLEAN is a LINEAR output stage, so the oversampler has nothing to do — and running the signal through the
    // decimator anyway would cost it a group delay and a whisper of imaging for no reason. This is what makes
    // "1:1 · CLEAN · INPUT 0 · OUTPUT 0" bit-exact rather than nearly.
    const bool linear = static_cast<int>(modeIdx_) == 0;
    // The rectifier's decay: fast enough to track a note's envelope, slow enough not to ripple at pitch.
    const double envCoef = std::exp(-1.0 / (0.020 * sr_));

    for (int i = 0; i < n; ++i)
    {
        const double xl = l[i] * inGain, xr = r[i] * inGain;
        // STEREO LINKED, as a two-channel FET box is: the louder side sets the gain, so the image never wanders.
        const double key = std::max(std::abs(detect(xl, 0)), std::abs(detect(xr, 1)));
        peakEnv_ = key > peakEnv_ ? key : peakEnv_ * envCoef;
        double targetDb = 0.0;
        if (!unity)
        {
            const double keyDb = 20.0 * std::log10(std::max(peakEnv_, 1e-9));
            const double over = keyDb - c.thresholdDb;
            if (c.kneeDb > 0.0 && over > -0.5 * c.kneeDb && over < 0.5 * c.kneeDb)
            {
                const double t = over + 0.5 * c.kneeDb;         // 0 … knee
                targetDb = -slope * (t * t) / (2.0 * c.kneeDb); // the quadratic bend through the knee
            }
            else if (over > 0.0)
                targetDb = -slope * over;
        }
        // Program-dependent release: the deeper it is holding the sound down, the slower it lets go — the
        // opto-ish behaviour that keeps a squashed mix from pumping.
        const double relEff = relMs * c.releaseScale * (1.0 + 0.02 * (-gainDb_));
        const double relCoef = std::exp(-1.0 / (0.001 * relEff * sr_));
        const double coef = targetDb < gainDb_ ? atkCoef : relCoef;
        gainDb_ = targetDb + (gainDb_ - targetDb) * coef;
        const double g = std::pow(10.0, gainDb_ / 20.0);

        if (linear)
        {
            l[i] = xl * g * outGain;
            r[i] = xr * g * outGain;
            continue;
        }
        double ol = 0.0, orr = 0.0;
        for (int k = 0; k < kOversample; ++k) // the harmonics oversampled: ZOH up, Butterworth down
        {
            ol = decL_.process(shape(xl * g));
            orr = decR_.process(shape(xr * g));
        }
        // DC out (only the shaped path can make any)
        const double bl = ol - dcInL_ + dcR_ * dcOutL_;
        dcInL_ = ol;
        dcOutL_ = bl;
        const double br = orr - dcInR_ + dcR_ * dcOutR_;
        dcInR_ = orr;
        dcOutR_ = br;
        l[i] = bl * outGain;
        r[i] = br * outGain;
    }
    grDb_ = static_cast<float>(gainDb_);
}

// ---- TAPE ECHO ----------------------------------------------------------------------------------------------

double springAllpass(DelayLine& dl, double x, double delaySamples, double g) noexcept TERMINATOR_NONBLOCKING
{
    const double z = dl.readAt(delaySamples);
    const double v = x + g * z;
    dl.write(v);
    return z - g * v;
}

namespace
{
/// The tape motor's two wobbles. WOW is the slow one you hear as pitch drift, FLUTTER the fast one you hear as
/// grain; both scale together off one knob because on the hardware they come from the same worn transport.
constexpr double kWowHz = 0.7, kFlutterHz = 7.3;
constexpr double kWowDepth = 0.004, kFlutterDepth = 0.0012; // as a fraction of the delay time
constexpr float kTimeTau = 0.25f;                           // the motor takes a moment to change speed
/// The spring tank's dispersion stages (ms) — the uneven spacing is what makes it "boing" instead of ring.
constexpr double kSpringApMs[TapeEchoFx::kSpringStages] = {4.7, 3.1, 7.3, 2.3};
constexpr double kSpringFbMs = 38.0;
} // namespace

void TapeEchoFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    // The longest read any head can ask for: the slowest motor speed, the furthest head, plus the wow.
    const int maxDelay = static_cast<int>(kMaxTimeSec * kHeadRatio[2] * 1.05 * sampleRate) + 8;
    tapeL_.prepare(maxDelay);
    tapeR_.prepare(maxDelay);
    for (int i = 0; i < kSpringStages; ++i)
    {
        const int n = static_cast<int>(kSpringApMs[i] * 0.001 * sampleRate) + 8;
        springApL_[i].prepare(n);
        springApR_[i].prepare(n);
    }
    const int fb = static_cast<int>(kSpringFbMs * 0.001 * sampleRate) + 8;
    springFbL_.prepare(fb);
    springFbR_.prepare(fb);
    reset();
}

void TapeEchoFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    modeIdx_ = 6.0f;
    time_.set(350.0f, true);
    intensity_.set(35.0f, true);
    wow_.set(25.0f, true);
    sat_.set(30.0f, true);
    bass_.set(0.0f, true);
    treble_.set(0.0f, true);
    springAmt_.set(0.0f, true);
    tapeL_.reset();
    tapeR_.reset();
    wowPhase_ = 0.0;
    flutPhase_ = 0.5; // the two wobbles start apart, so the drift never begins as one clean sweep
    for (int i = 0; i < kSpringStages; ++i)
    {
        springApL_[i].reset();
        springApR_[i].reset();
    }
    springFbL_.reset();
    springFbR_.reset();
    springStateL_ = springStateR_ = 0.0;
    loopLpL_.reset();
    loopLpR_.reset();
    loopHpL_.reset();
    loopHpR_.reset();
    bumpL_.reset();
    bumpR_.reset();
    bassL_.reset();
    bassR_.reset();
    trebL_.reset();
    trebR_.reset();
    springLpL_.reset();
    springLpR_.reset();
    // The losses live INSIDE the feedback loop, which is the whole reason repeats darken and thicken as they go
    // round rather than just fading.
    loopLpL_.set(Biquad::Type::lowpass, 4500.0, 0.0, 0.0, sr_);
    loopLpR_.set(Biquad::Type::lowpass, 4500.0, 0.0, 0.0, sr_);
    loopHpL_.set(Biquad::Type::highpass, 120.0, 0.0, 0.0, sr_);
    loopHpR_.set(Biquad::Type::highpass, 120.0, 0.0, 0.0, sr_);
    bumpL_.set(Biquad::Type::peaking, 95.0, 1.1, 3.0, sr_);
    bumpR_.set(Biquad::Type::peaking, 95.0, 1.1, 3.0, sr_);
    springLpL_.set(Biquad::Type::lowpass, 3200.0, 0.0, 0.0, sr_);
    springLpR_.set(Biquad::Type::lowpass, 3200.0, 0.0, 0.0, sr_);
    recompute();
}

void TapeEchoFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        modeIdx_ = clampf(std::floor(value), 0.0f, 6.0f);
        break;
    case 1:
        time_.set(clampf(value, 20.0f, 1500.0f), immediate);
        break;
    case 2:
        intensity_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 3:
        wow_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 4:
        sat_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 5:
        bass_.set(clampf(value, -12.0f, 12.0f), immediate);
        break;
    case 6:
        treble_.set(clampf(value, -12.0f, 12.0f), immediate);
        break;
    case 7:
        springAmt_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    default:
        break;
    }
    if (immediate)
        recompute();
}

float TapeEchoFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return modeIdx_;
    case 1:
        return time_.target;
    case 2:
        return intensity_.target;
    case 3:
        return wow_.target;
    case 4:
        return sat_.target;
    case 5:
        return bass_.target;
    case 6:
        return treble_.target;
    case 7:
        return springAmt_.target;
    default:
        return 0.0f;
    }
}

void TapeEchoFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    bassL_.set(Biquad::Type::lowshelf, 180.0, 0.0, static_cast<double>(bass_.cur), sr_);
    bassR_.set(Biquad::Type::lowshelf, 180.0, 0.0, static_cast<double>(bass_.cur), sr_);
    trebL_.set(Biquad::Type::highshelf, 3000.0, 0.0, static_cast<double>(treble_.cur), sr_);
    trebR_.set(Biquad::Type::highshelf, 3000.0, 0.0, static_cast<double>(treble_.cur), sr_);
}

/// The spring tank: dispersion first (four allpasses at deliberately uneven delays — that is the "boing"), then a
/// damped feedback delay for the tail.
double TapeEchoFx::spring(double x, int ch) noexcept TERMINATOR_NONBLOCKING
{
    DelayLine* ap = ch == 0 ? springApL_ : springApR_;
    DelayLine& fb = ch == 0 ? springFbL_ : springFbR_;
    Biquad& lp = ch == 0 ? springLpL_ : springLpR_;
    double& st = ch == 0 ? springStateL_ : springStateR_;
    double v = x + 0.62 * st;
    for (int i = 0; i < kSpringStages; ++i)
        v = springAllpass(ap[i], v, kSpringApMs[i] * 0.001 * sr_, 0.62);
    const double out = fb.readAt(kSpringFbMs * 0.001 * sr_);
    fb.write(v);
    st = lp.process(out);
    return out;
}

void TapeEchoFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    if (time_.moving())
        time_.advance(n, sr_, kTimeTau, 1e-3f); // the motor, not a jump cut
    if (intensity_.moving() || wow_.moving() || sat_.moving() || bass_.moving() || treble_.moving() ||
        springAmt_.moving())
    {
        intensity_.advance(n, sr_, kFxTau);
        wow_.advance(n, sr_, kFxTau);
        sat_.advance(n, sr_, kFxTau);
        bass_.advance(n, sr_, kFxTau);
        treble_.advance(n, sr_, kFxTau);
        springAmt_.advance(n, sr_, kFxTau);
        recompute();
    }
    const int mode = static_cast<int>(modeIdx_);
    // MODE is a bit mask over the three heads: 0..2 = one head, 3 = 1+2, 4 = 2+3, 5 = 1+3, 6 = all three.
    const bool head[3] = {mode == 0 || mode == 3 || mode == 5 || mode == 6,
                          mode == 1 || mode == 3 || mode == 4 || mode == 6,
                          mode == 2 || mode == 4 || mode == 5 || mode == 6};
    int heads = 0;
    for (const bool h : head)
        heads += h ? 1 : 0;
    const double headScale = heads > 0 ? 1.0 / std::sqrt(static_cast<double>(heads)) : 0.0;
    const double baseSamples = static_cast<double>(time_.cur) * 0.001 * sr_;
    const double fbGain = static_cast<double>(intensity_.cur) * 0.0105; // 100 → 1.05: it runs away, by design
    const double wowAmt = static_cast<double>(wow_.cur) * 0.01;
    const double satDrive = 1.0 + static_cast<double>(sat_.cur) * 0.06;
    const double satComp = 1.0 / std::sqrt(satDrive);
    const double springMix = static_cast<double>(springAmt_.cur) * 0.01;
    const double wowInc = kWowHz / sr_, flutInc = kFlutterHz / sr_;

    for (int i = 0; i < n; ++i)
    {
        wowPhase_ = advancePhase(wowPhase_, kWowHz, sr_);
        flutPhase_ = advancePhase(flutPhase_, kFlutterHz, sr_);
        (void)wowInc;
        (void)flutInc;
        const double wobL = 1.0 + wowAmt * (kWowDepth * lfoSine(wowPhase_) + kFlutterDepth * lfoSine(flutPhase_));
        // the right channel reads the same tape a quarter-turn along the wobble, so the drift is stereo
        const double wobR =
            1.0 + wowAmt * (kWowDepth * lfoSine(wowPhase_ + 0.25) + kFlutterDepth * lfoSine(flutPhase_ + 0.25));

        double echoL = 0.0, echoR = 0.0;
        for (int h = 0; h < 3; ++h)
        {
            if (!head[h])
                continue;
            echoL += tapeL_.readAt(baseSamples * kHeadRatio[h] * wobL);
            echoR += tapeR_.readAt(baseSamples * kHeadRatio[h] * wobR);
        }
        echoL *= headScale;
        echoR *= headScale;

        // What goes back on the tape: the input plus the heads' sum, through the tape's own losses and saturation.
        double recL = l[i] + fbGain * echoL;
        double recR = r[i] + fbGain * echoR;
        recL = bumpL_.process(loopHpL_.process(loopLpL_.process(recL)));
        recR = bumpR_.process(loopHpR_.process(loopLpR_.process(recR)));
        recL = ftanh(recL * satDrive) * satComp;
        recR = ftanh(recR * satDrive) * satComp;
        tapeL_.write(recL);
        tapeR_.write(recR);

        double outL = trebL_.process(bassL_.process(echoL));
        double outR = trebR_.process(bassR_.process(echoR));
        if (springMix > 0.0)
        {
            outL = outL * (1.0 - springMix) + spring(outL, 0) * springMix;
            outR = outR * (1.0 - springMix) + spring(outR, 1) * springMix;
        }
        l[i] = outL;
        r[i] = outR;
    }
}

} // namespace terminator
