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

// ---- HALL 224 (the Lexicon programs on a Dattorro tank) -----------------------------------------------------

namespace
{
/// Dattorro's plate, in samples at 29761 Hz. Everything is scaled from here by (sr / kRefSr) x SIZE.
constexpr double kInDiffLen[PlateVerbFx::kInDiffusers] = {142.0, 107.0, 379.0, 277.0};
constexpr double kApAmLen = 672.0, kA1Len = 4453.0, kApA2Len = 1800.0, kA2Len = 3720.0;
constexpr double kApBmLen = 908.0, kB1Len = 4217.0, kApB2Len = 2656.0, kB2Len = 3163.0;
/// The output taps, read out of the tank's delay lines — seven per side, taken from BOTH halves, which is what
/// decorrelates L from R. A mono source has to come back as a stereo room or it is not a reverb.
constexpr double kTapA[3] = {266.0, 2974.0, 1990.0};
constexpr double kTapB[4] = {1913.0, 1996.0, 187.0, 1066.0};
constexpr double kModHzA = 0.93, kModHzB = 1.31; // deliberately not related: the tail must never pulse in step

/// PROGRAM presets: {size, diffusion, damping, modulation} as 0..1 starting points. The knobs move from here.
struct VerbProgram
{
    double size, diffusion, damp, mod;
};
constexpr VerbProgram kPrograms[5] = {
    {1.00, 0.85, 0.45, 0.60}, // HALL — big, smooth, moving
    {0.75, 0.80, 0.55, 0.45}, // CHAMBER
    {0.55, 0.95, 0.30, 0.80}, // PLATE — dense and bright, the most movement
    {0.40, 0.70, 0.60, 0.30}, // ROOM
    {0.22, 0.55, 0.70, 0.20}, // AMBIENCE — short, dark, barely moving
};

double apStep(DelayLine& dl, double x, double d, double g) noexcept TERMINATOR_NONBLOCKING
{
    const double z = dl.readAt(d);
    const double v = x + g * z;
    dl.write(v);
    return z - g * v;
}
} // namespace

void PlateVerbFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    const double k = sampleRate / kRefSr * kMaxSizeScale;
    pre_.prepare(static_cast<int>(kMaxPredelaySec * sampleRate) + 8);
    for (int i = 0; i < kInDiffusers; ++i)
        inAp_[i].prepare(static_cast<int>(kInDiffLen[i] * k) + 8);
    apAm_.prepare(static_cast<int>((kApAmLen + 32.0) * k) + 64); // + the modulation swing
    delA1_.prepare(static_cast<int>(kA1Len * k) + 8);
    apA2_.prepare(static_cast<int>(kApA2Len * k) + 8);
    delA2_.prepare(static_cast<int>(kA2Len * k) + 8);
    apBm_.prepare(static_cast<int>((kApBmLen + 32.0) * k) + 64);
    delB1_.prepare(static_cast<int>(kB1Len * k) + 8);
    apB2_.prepare(static_cast<int>(kApB2Len * k) + 8);
    delB2_.prepare(static_cast<int>(kB2Len * k) + 8);
    reset();
}

void PlateVerbFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    programIdx_ = 0.0f;
    predelay_.set(0.0f, true);
    decay_.set(2.0f, true);
    size_.set(70.0f, true);
    diffusion_.set(70.0f, true);
    bassMult_.set(1.0f, true);
    damp_.set(40.0f, true);
    mod_.set(50.0f, true);
    pre_.reset();
    inLp_.reset();
    for (auto& d : inAp_)
        d.reset();
    apAm_.reset();
    delA1_.reset();
    apA2_.reset();
    delA2_.reset();
    apBm_.reset();
    delB1_.reset();
    apB2_.reset();
    delB2_.reset();
    dampA_.reset();
    dampB_.reset();
    bassA_.reset();
    bassB_.reset();
    tankA_ = tankB_ = 0.0;
    modPhaseA_ = 0.0;
    modPhaseB_ = 0.37; // the two halves start out of step
    inLp_.set(Biquad::Type::lowpass, 9000.0, 0.0, 0.0, sr_);
    recompute();
}

void PlateVerbFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        programIdx_ = clampf(std::floor(value), 0.0f, 4.0f);
        break;
    case 1:
        predelay_.set(clampf(value, 0.0f, 250.0f), immediate);
        break;
    case 2:
        decay_.set(clampf(value, 0.2f, 20.0f), immediate);
        break;
    case 3:
        size_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 4:
        diffusion_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 5:
        bassMult_.set(clampf(value, 0.2f, 4.0f), immediate);
        break;
    case 6:
        damp_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 7:
        mod_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    default:
        break;
    }
    if (immediate)
        recompute();
}

float PlateVerbFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return programIdx_;
    case 1:
        return predelay_.target;
    case 2:
        return decay_.target;
    case 3:
        return size_.target;
    case 4:
        return diffusion_.target;
    case 5:
        return bassMult_.target;
    case 6:
        return damp_.target;
    case 7:
        return mod_.target;
    default:
        return 0.0f;
    }
}

/// Resolve the tank for the current knobs. The one that matters: **DECAY is seconds**, so the loop gain is solved
/// from the tank's own round-trip time — `g = 10^(-3·T/RT60)` — instead of being a feel knob the user has to learn.
void PlateVerbFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    const VerbProgram& p = kPrograms[static_cast<int>(programIdx_)];
    // SIZE 50 = the program's own size; the knob scales around it.
    const double sizeScale = std::clamp(p.size * (0.4 + 0.012 * static_cast<double>(size_.cur)), 0.15, kMaxSizeScale);
    const double k = sr_ / kRefSr * sizeScale;
    for (int i = 0; i < kInDiffusers; ++i)
        lenIn_[i] = std::max(1.0, kInDiffLen[i] * k);
    lenApAm_ = std::max(1.0, kApAmLen * k);
    lenA1_ = std::max(1.0, kA1Len * k);
    lenApA2_ = std::max(1.0, kApA2Len * k);
    lenA2_ = std::max(1.0, kA2Len * k);
    lenApBm_ = std::max(1.0, kApBmLen * k);
    lenB1_ = std::max(1.0, kB1Len * k);
    lenApB2_ = std::max(1.0, kApB2Len * k);
    lenB2_ = std::max(1.0, kB2Len * k);

    // One trip round the tank, in seconds, then the gain that decays 60 dB in DECAY seconds.
    const double loopSec = (lenA1_ + lenA2_ + lenB1_ + lenB2_) * 0.5 / sr_;
    const double rt60 = std::max(0.05, static_cast<double>(decay_.cur));
    decayGain_ = std::clamp(std::pow(10.0, -3.0 * loopSec / rt60), 0.05, 0.9995);

    const double diff = std::clamp(p.diffusion * (0.35 + 0.0095 * static_cast<double>(diffusion_.cur)), 0.0, 0.85);
    inDiff1_ = diff;
    inDiff2_ = diff * 0.83;
    modDepth_ = p.mod * static_cast<double>(mod_.cur) * 0.01 * 12.0 * (sr_ / kRefSr); // samples of swing

    // DAMP is the treble decay; BASS is the 224's bass decay MULTIPLIER, applied as a shelf inside the loop so the
    // bottom rings for a different length than the rest instead of just being louder.
    const double dampHz = 18000.0 * std::pow(0.06, p.damp * static_cast<double>(damp_.cur) * 0.01);
    dampA_.set(Biquad::Type::lowpass, std::clamp(dampHz, 400.0, 0.45 * sr_), 0.0, 0.0, sr_);
    dampB_.set(Biquad::Type::lowpass, std::clamp(dampHz, 400.0, 0.45 * sr_), 0.0, 0.0, sr_);
    // A multiplier of M on the RT60 of the bottom = M's worth of extra loop gain down there, in dB per trip.
    const double bassDb =
        std::clamp(-60.0 * loopSec / rt60 * (1.0 / static_cast<double>(bassMult_.cur) - 1.0), -12.0, 12.0);
    bassA_.set(Biquad::Type::lowshelf, 350.0, 0.0, bassDb, sr_);
    bassB_.set(Biquad::Type::lowshelf, 350.0, 0.0, bassDb, sr_);
}

void PlateVerbFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    if (predelay_.moving() || decay_.moving() || size_.moving() || diffusion_.moving() || bassMult_.moving() ||
        damp_.moving() || mod_.moving())
    {
        predelay_.advance(n, sr_, kFxTau);
        decay_.advance(n, sr_, kFxTau);
        size_.advance(n, sr_, kFxTau);
        diffusion_.advance(n, sr_, kFxTau);
        bassMult_.advance(n, sr_, kFxTau);
        damp_.advance(n, sr_, kFxTau);
        mod_.advance(n, sr_, kFxTau);
        recompute();
    }
    const double preSamples = std::max(1.0, static_cast<double>(predelay_.cur) * 0.001 * sr_);
    const double sizeK = lenA1_ / kA1Len; // the scale the taps were resolved at

    for (int i = 0; i < n; ++i)
    {
        modPhaseA_ = advancePhase(modPhaseA_, kModHzA, sr_);
        modPhaseB_ = advancePhase(modPhaseB_, kModHzB, sr_);

        // The tank is fed MONO — a plate has one input. The stereo comes back out of the taps.
        double x = 0.5 * (l[i] + r[i]);
        x = pre_.process(x, preSamples);
        x = inLp_.process(x);
        x = apStep(inAp_[0], x, lenIn_[0], inDiff1_);
        x = apStep(inAp_[1], x, lenIn_[1], inDiff1_);
        x = apStep(inAp_[2], x, lenIn_[2], inDiff2_);
        x = apStep(inAp_[3], x, lenIn_[3], inDiff2_);

        // Half A takes the input plus what half B handed over last sample (and vice versa) — the one-sample
        // offset is what keeps the cross-coupled loop computable at all.
        double a = x + tankB_;
        a = apStep(apAm_, a, lenApAm_ + modDepth_ * lfoSine(modPhaseA_), 0.7);
        delA1_.write(a);
        a = delA1_.readAt(lenA1_);
        a = bassA_.process(dampA_.process(a)) * decayGain_;
        a = apStep(apA2_, a, lenApA2_, 0.5);
        delA2_.write(a);
        a = delA2_.readAt(lenA2_);

        double b = x + tankA_;
        b = apStep(apBm_, b, lenApBm_ + modDepth_ * lfoSine(modPhaseB_), 0.7);
        delB1_.write(b);
        b = delB1_.readAt(lenB1_);
        b = bassB_.process(dampB_.process(b)) * decayGain_;
        b = apStep(apB2_, b, lenApB2_, 0.5);
        delB2_.write(b);
        b = delB2_.readAt(lenB2_);

        tankA_ = a * decayGain_;
        tankB_ = b * decayGain_;

        // Seven taps a side, taken from BOTH halves — the reason a mono source comes back as a room.
        const double outL = delB1_.readAt(kTapB[0] * sizeK) + delB1_.readAt(kTapB[1] * sizeK) -
                            apB2_.readAt(kTapB[2] * sizeK) + delB2_.readAt(kTapB[3] * sizeK) -
                            delA1_.readAt(kTapA[0] * sizeK) - apA2_.readAt(kTapA[2] * sizeK) -
                            delA2_.readAt(kTapA[1] * sizeK * 0.5);
        const double outR = delA1_.readAt(kTapA[0] * sizeK) + delA1_.readAt(kTapA[1] * sizeK) -
                            apA2_.readAt(kTapA[2] * sizeK) + delA2_.readAt(kTapA[1] * sizeK * 0.5) -
                            delB1_.readAt(kTapB[0] * sizeK) - apB2_.readAt(kTapB[2] * sizeK) -
                            delB2_.readAt(kTapB[3] * sizeK);
        l[i] = outL * 0.6;
        r[i] = outR * 0.6;
    }
}

// ---- SATURATOR ----------------------------------------------------------------------------------------------

/// The five flavours. Each is BOUNDED by construction (the 4.6c lesson: a polynomial is not a saturator) and the
/// asymmetric ones are cleaned up by the DC blocker below, not by a fudge constant.
double SaturatorFx::curve(double x) const noexcept TERMINATOR_NONBLOCKING
{
    switch (static_cast<int>(styleIdx_))
    {
    case 0: // A — tube: asymmetric, so the even harmonics arrive first and it thickens rather than hardens
        return ftanh(x + 0.25 * x * x * (x > 0.0 ? 1.0 : 0.6));
    case 1: // E — germanium: a harder knee, more odd, the "edge" setting
        return x / (1.0 + std::abs(x) * 0.8) * 1.6 - 0.12 * ftanh(x * 3.0);
    case 2: // N — British console: gentle, almost pure odd, the one you leave on everything
        return ftanh(x * 0.85) * 1.06;
    case 3: // T — transformer: the BOTTOM saturates first (the core is what runs out of headroom), so the curve is
            // softer on peaks and firmer around the middle
        return ftanh(x) * 0.7 + 0.3 * x / std::sqrt(1.0 + x * x * 0.35);
    default: // P — punish: fold-back fuzz
    {
        const double t = ftanh(x * 1.4);
        return t - 0.45 * t * t * t + 0.18 * std::sin(3.0 * t);
    }
    }
}

void SaturatorFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    srOs_ = sampleRate * static_cast<double>(kOversample);
    reset();
}

void SaturatorFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    styleIdx_ = 0.0f;
    punish_ = 0.0f;
    drive_.set(0.0f, true);
    tone_.set(0.0f, true);
    lowCut_.set(20.0f, true);
    highCut_.set(20000.0f, true);
    output_.set(0.0f, true);
    hpL_.reset();
    hpR_.reset();
    lpL_.reset();
    lpR_.reset();
    tiltLoL_.reset();
    tiltLoR_.reset();
    tiltHiL_.reset();
    tiltHiR_.reset();
    decSatL_.reset();
    decSatR_.reset();
    decSatL_.set(sr_ * 0.47, srOs_);
    decSatR_.set(sr_ * 0.47, srOs_);
    dcInL_ = dcOutL_ = dcInR_ = dcOutR_ = 0.0;
    dcR_ = 1.0 - 2.0 * kPi * 5.0 / sr_;
    recompute();
}

void SaturatorFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        styleIdx_ = clampf(std::floor(value), 0.0f, 4.0f);
        break;
    case 1:
        drive_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 2:
        tone_.set(clampf(value, -100.0f, 100.0f), immediate);
        break;
    case 3:
        lowCut_.set(clampf(value, 20.0f, 1000.0f), immediate);
        break;
    case 4:
        highCut_.set(clampf(value, 1000.0f, 20000.0f), immediate);
        break;
    case 5:
        punish_ = value >= 0.5f ? 1.0f : 0.0f;
        break;
    case 6:
        output_.set(clampf(value, -24.0f, 24.0f), immediate);
        break;
    default:
        break;
    }
    if (immediate)
        recompute();
}

float SaturatorFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return styleIdx_;
    case 1:
        return drive_.target;
    case 2:
        return tone_.target;
    case 3:
        return lowCut_.target;
    case 4:
        return highCut_.target;
    case 5:
        return punish_;
    case 6:
        return output_.target;
    default:
        return 0.0f;
    }
}

void SaturatorFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    const double lc = static_cast<double>(lowCut_.cur), hc = static_cast<double>(highCut_.cur);
    hpL_.set(Biquad::Type::highpass, lc, 0.0, 0.0, sr_);
    hpR_.set(Biquad::Type::highpass, lc, 0.0, 0.0, sr_);
    lpL_.set(Biquad::Type::lowpass, hc, 0.0, 0.0, sr_);
    lpR_.set(Biquad::Type::lowpass, hc, 0.0, 0.0, sr_);
    // TONE is a TILT and it sits BEFORE the curve — which is the point: it decides what gets distorted, not just
    // what the distortion sounds like afterwards.
    const double tilt = static_cast<double>(tone_.cur) * 0.06; // ±6 dB
    tiltLoL_.set(Biquad::Type::lowshelf, 300.0, 0.0, -tilt, sr_);
    tiltLoR_.set(Biquad::Type::lowshelf, 300.0, 0.0, -tilt, sr_);
    tiltHiL_.set(Biquad::Type::highshelf, 2500.0, 0.0, tilt, sr_);
    tiltHiR_.set(Biquad::Type::highshelf, 2500.0, 0.0, tilt, sr_);
}

void SaturatorFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    if (drive_.moving() || tone_.moving() || lowCut_.moving() || highCut_.moving() || output_.moving())
    {
        drive_.advance(n, sr_, kFxTau);
        tone_.advance(n, sr_, kFxTau);
        lowCut_.advance(n, sr_, kFxTau);
        highCut_.advance(n, sr_, kFxTau);
        output_.advance(n, sr_, kFxTau);
        recompute();
    }
    const double d = static_cast<double>(drive_.cur) * 0.01;
    const double outGain = std::pow(10.0, static_cast<double>(output_.cur) / 20.0);
    if (d <= 0.0)
    {
        // DRIVE 0 is BIT-CLEAN: no curve, no oversampler, no filters that were not asked for.
        const bool filtering =
            static_cast<double>(lowCut_.cur) > 20.5 || static_cast<double>(highCut_.cur) < 19500.0 || tone_.cur != 0.0f;
        for (int i = 0; i < n; ++i)
        {
            double xl = l[i], xr = r[i];
            if (filtering)
            {
                xl = tiltHiL_.process(tiltLoL_.process(lpL_.process(hpL_.process(xl))));
                xr = tiltHiR_.process(tiltLoR_.process(lpR_.process(hpR_.process(xr))));
            }
            l[i] = xl * outGain;
            r[i] = xr * outGain;
        }
        return;
    }
    // 1..24x, and PUNISH is the extra 6x on top — the hardware's abusive setting, not a different algorithm.
    const double driveGain = (1.0 + 23.0 * d) * (punish_ > 0.5f ? 6.0 : 1.0);
    // AUTO-GAIN, measured rather than guessed: a power law (driveGain^−0.7) was 12 dB out across the range because
    // each curve compresses differently. Ask the CURVE ITSELF what it does to a reference level and undo exactly
    // that, so a −12 dBFS signal comes back at −12 dBFS whatever the drive and whichever flavour.
    constexpr double kRef = 0.25;
    const double shaped = std::abs(curve(kRef * driveGain));
    const double comp = shaped > 1e-9 ? kRef / shaped : 1.0;

    for (int i = 0; i < n; ++i)
    {
        double xl = tiltHiL_.process(tiltLoL_.process(lpL_.process(hpL_.process(l[i]))));
        double xr = tiltHiR_.process(tiltLoR_.process(lpR_.process(hpR_.process(r[i]))));
        xl *= driveGain;
        xr *= driveGain;
        double ol = 0.0, orr = 0.0;
        for (int k = 0; k < kOversample; ++k) // ZOH up, Butterworth down — the same zero-latency pair as the rest
        {
            ol = decSatL_.process(curve(xl));
            orr = decSatR_.process(curve(xr));
        }
        // the asymmetric flavours make DC; the blocker is what a coupling capacitor does
        const double bl = ol - dcInL_ + dcR_ * dcOutL_;
        dcInL_ = ol;
        dcOutL_ = bl;
        const double br = orr - dcInR_ + dcR_ * dcOutR_;
        dcInR_ = orr;
        dcOutR_ = br;
        l[i] = bl * comp * outGain;
        r[i] = br * comp * outGain;
    }
}

// ---- LIMITER ------------------------------------------------------------------------------------------------

namespace
{
/// {release scale, how much of the look-ahead window the attack is smoothed over, program dependence}.
constexpr LimiterFx::Style kLimStyles[7] = {
    {2.20, 1.00, 0.30}, // TRANSPARENT — slow and smooth, gets out of the way
    {0.45, 0.35, 0.20}, // PUNCHY — lets transients through
    {1.00, 0.70, 1.00}, // DYNAMIC — the release follows how hard it is working
    {1.00, 0.70, 0.40}, // ALLROUND
    {0.25, 0.20, 0.10}, // AGGRESSIVE — loud, and it shows
    {3.00, 1.00, 0.50}, // BUS — barely moves
    {0.60, 0.10, 0.00}, // SAFE — a catch net, nothing more
};
} // namespace

LimiterFx::Style LimiterFx::styleFor(int i) const noexcept TERMINATOR_NONBLOCKING
{
    return kLimStyles[std::clamp(i, 0, 6)];
}

void LimiterFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    maxLook_ = static_cast<int>(kMaxLookaheadSec * sampleRate) + 4;
    dlyL_.assign(static_cast<std::size_t>(maxLook_ + 1), 0.0);
    dlyR_.assign(static_cast<std::size_t>(maxLook_ + 1), 0.0);
    reqRing_.assign(static_cast<std::size_t>(maxLook_ + 1), 1.0);
    minDeque_.assign(static_cast<std::size_t>(maxLook_ + 2), 0);
    reset();
}

void LimiterFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    styleIdx_ = 3.0f;
    tp_ = 0.0f;
    gain_.set(0.0f, true);
    ceiling_.set(-0.3f, true);
    release_.set(120.0f, true);
    lookMs_.set(3.0f, true);
    link_.set(100.0f, true);
    std::fill(dlyL_.begin(), dlyL_.end(), 0.0);
    std::fill(dlyR_.begin(), dlyR_.end(), 0.0);
    std::fill(reqRing_.begin(), reqRing_.end(), 1.0);
    dlyPos_ = 0;
    minHead_ = minTail_ = 0;
    minCount_ = 0;
    smooth_ = held_ = 1.0;
    tpHistL_[0] = tpHistL_[1] = tpHistL_[2] = 0.0;
    tpHistR_[0] = tpHistR_[1] = tpHistR_[2] = 0.0;
    grDb_ = 0.0f;
    look_ = std::clamp(static_cast<int>(3.0 * 0.001 * sr_), 0, maxLook_);
}

void LimiterFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        styleIdx_ = clampf(std::floor(value), 0.0f, 6.0f);
        break;
    case 1:
        gain_.set(clampf(value, 0.0f, 24.0f), immediate);
        break;
    case 2:
        ceiling_.set(clampf(value, -12.0f, 0.0f), immediate);
        break;
    case 3:
        release_.set(clampf(value, 1.0f, 1000.0f), immediate);
        break;
    case 4:
        // LOOKAHEAD changes the device's LATENCY, so it is applied whole — a glide would make the reported number
        // a lie for as long as it took to arrive, and PDC reads that number.
        lookMs_.set(clampf(value, 0.0f, 20.0f), true);
        look_ = std::clamp(static_cast<int>(static_cast<double>(lookMs_.cur) * 0.001 * sr_), 0, maxLook_);
        minHead_ = minTail_ = 0;
        minCount_ = 0;
        break;
    case 5:
        tp_ = value >= 0.5f ? 1.0f : 0.0f;
        break;
    case 6:
        link_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    default:
        break;
    }
}

float LimiterFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return styleIdx_;
    case 1:
        return gain_.target;
    case 2:
        return ceiling_.target;
    case 3:
        return release_.target;
    case 4:
        return lookMs_.target;
    case 5:
        return tp_;
    case 6:
        return link_.target;
    default:
        return 0.0f;
    }
}

/// The inter-sample peak, estimated by 4-point Lagrange interpolation at the quarter points. A sample-peak reading
/// can be several dB under what the converter (or an mp3 encoder) actually reconstructs.
double LimiterFx::truePeak(double p2, double p1, double x, double n1) const noexcept TERMINATOR_NONBLOCKING
{
    double m = std::abs(x);
    for (int k = 1; k < 4; ++k)
    {
        const double t = 0.25 * static_cast<double>(k);
        const double c0 = -t * (t - 1.0) * (t - 2.0) / 6.0;
        const double c1 = (t + 1.0) * (t - 1.0) * (t - 2.0) / 2.0;
        const double c2 = -(t + 1.0) * t * (t - 2.0) / 2.0;
        const double c3 = (t + 1.0) * t * (t - 1.0) / 6.0;
        m = std::max(m, std::abs(c0 * p2 + c1 * p1 + c2 * x + c3 * n1));
    }
    return m;
}

/// A monotonic-deque sliding minimum over the last `look_ + 1` required gains. O(1) amortised, no allocation.
double LimiterFx::slideMin(double v) noexcept TERMINATOR_NONBLOCKING
{
    const int cap = static_cast<int>(reqRing_.size());
    const int idx = static_cast<int>(minCount_ % cap);
    reqRing_[static_cast<std::size_t>(idx)] = v;
    const int dcap = static_cast<int>(minDeque_.size());
    while (minTail_ != minHead_)
    {
        const int back = (minTail_ - 1 + dcap) % dcap;
        if (reqRing_[static_cast<std::size_t>(minDeque_[static_cast<std::size_t>(back)])] >= v)
            minTail_ = back;
        else
            break;
    }
    minDeque_[static_cast<std::size_t>(minTail_)] = idx;
    minTail_ = (minTail_ + 1) % dcap;
    // drop anything that has fallen out of the window
    const std::int64_t oldest = minCount_ - look_;
    while (minHead_ != minTail_)
    {
        const int front = minDeque_[static_cast<std::size_t>(minHead_)];
        const std::int64_t age = minCount_ - ((minCount_ - front + cap) % cap);
        if (age < oldest)
            minHead_ = (minHead_ + 1) % dcap;
        else
            break;
    }
    ++minCount_;
    return reqRing_[static_cast<std::size_t>(minDeque_[static_cast<std::size_t>(minHead_)])];
}

void LimiterFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    if (gain_.moving() || ceiling_.moving() || release_.moving() || link_.moving())
    {
        gain_.advance(n, sr_, kFxTau);
        ceiling_.advance(n, sr_, kFxTau);
        release_.advance(n, sr_, kFxTau);
        link_.advance(n, sr_, kFxTau);
    }
    const Style st = styleFor(static_cast<int>(styleIdx_));
    const double inGain = std::pow(10.0, static_cast<double>(gain_.cur) / 20.0);
    const double ceil = std::pow(10.0, static_cast<double>(ceiling_.cur) / 20.0);
    const double link = static_cast<double>(link_.cur) * 0.01;
    const bool trueP = tp_ > 0.5f;
    const int look = latencySamples(); // TP needs two samples of future to read an inter-sample peak
    const int cap = static_cast<int>(dlyL_.size());
    // The attack smoother is sized to a fraction of the look-ahead, so it always finishes INSIDE the window.
    const double smoothSamples = std::max(1.0, st.smoothFrac * static_cast<double>(std::max(look, 1)));
    const double atkCoef = std::exp(-1.0 / smoothSamples);

    for (int i = 0; i < n; ++i)
    {
        const double xl = l[i] * inGain, xr = r[i] * inGain;
        // what this sample needs, per channel, then linked
        const double pl = trueP ? truePeak(tpHistL_[0], tpHistL_[1], tpHistL_[2], xl) : std::abs(xl);
        const double pr = trueP ? truePeak(tpHistR_[0], tpHistR_[1], tpHistR_[2], xr) : std::abs(xr);
        tpHistL_[0] = tpHistL_[1];
        tpHistL_[1] = tpHistL_[2];
        tpHistL_[2] = xl;
        tpHistR_[0] = tpHistR_[1];
        tpHistR_[1] = tpHistR_[2];
        tpHistR_[2] = xr;
        const double peakLinked = std::max(pl, pr);
        const double peakCh = 0.5 * (pl + pr);
        const double pk = link * peakLinked + (1.0 - link) * peakCh;
        const double required = pk > ceil ? ceil / pk : 1.0;

        const double target = slideMin(required);
        if (target < smooth_)
            smooth_ = target + (smooth_ - target) * atkCoef;
        else
        {
            // program dependence: the harder it is working, the slower it lets go
            const double relMs = std::max(1.0, static_cast<double>(release_.cur)) * st.releaseScale *
                                 (1.0 + st.program * (1.0 - smooth_) * 6.0);
            const double relCoef = std::exp(-1.0 / (0.001 * relMs * sr_));
            smooth_ = target + (smooth_ - target) * relCoef;
        }

        // WRITE first, then read `look` samples back — with look = 0 that has to be the sample just written, and
        // reading before writing quietly handed back the one from a whole ring ago instead.
        dlyL_[static_cast<std::size_t>(dlyPos_)] = xl;
        dlyR_[static_cast<std::size_t>(dlyPos_)] = xr;
        const int rd = (dlyPos_ - look + cap) % cap;
        const double outL = dlyL_[static_cast<std::size_t>(rd)];
        const double outR = dlyR_[static_cast<std::size_t>(rd)];
        dlyPos_ = (dlyPos_ + 1) % cap;

        // THE HARD CLAMP. Everything above shapes HOW the gain gets there; this is what guarantees it arrives.
        // A limiter that can overshoot its ceiling is not a limiter, so the applied gain is never allowed above
        // what this exact sample needs — measured on the sample being PLAYED, not the one being watched.
        // With TP on, "what this sample needs" is its INTER-sample peak, which needs the two samples after it —
        // hence the two-sample floor on the look-ahead when TP is armed (and reported in latencySamples()).
        double plOut = std::max(std::abs(outL), std::abs(outR));
        if (trueP)
        {
            const int m1 = (rd - 1 + cap) % cap, p1 = (rd + 1) % cap, p2 = (rd + 2) % cap;
            plOut = std::max(truePeak(dlyL_[static_cast<std::size_t>(m1)], outL, dlyL_[static_cast<std::size_t>(p1)],
                                      dlyL_[static_cast<std::size_t>(p2)]),
                             truePeak(dlyR_[static_cast<std::size_t>(m1)], outR, dlyR_[static_cast<std::size_t>(p1)],
                                      dlyR_[static_cast<std::size_t>(p2)]));
        }
        const double needNow = plOut > ceil ? ceil / plOut : 1.0;
        const double g = std::min(smooth_, needNow);

        l[i] = outL * g;
        r[i] = outR * g;
        held_ = g;
    }
    grDb_ = static_cast<float>(20.0 * std::log10(std::max(held_, 1e-6)));
}

// ---- RETRO --------------------------------------------------------------------------------------------------

namespace
{
constexpr double kRetroSpaceApMs[RetroFx::kSpaceStages] = {5.9, 3.7, 8.3};
constexpr double kRetroSpaceFbMs = 27.0;
constexpr double kRetroWowHz = 0.55, kRetroFlutHz = 6.1;
} // namespace

double RetroFx::rnd() noexcept TERMINATOR_NONBLOCKING
{
    rng_ ^= rng_ << 13;
    rng_ ^= rng_ >> 17;
    rng_ ^= rng_ << 5;
    return static_cast<double>(rng_) * (2.0 / 4294967295.0) - 1.0;
}

void RetroFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    wobL_.prepare(static_cast<int>(0.02 * sampleRate) + 8);
    wobR_.prepare(static_cast<int>(0.02 * sampleRate) + 8);
    for (int i = 0; i < kSpaceStages; ++i)
    {
        const int n = static_cast<int>(kRetroSpaceApMs[i] * 0.001 * sampleRate) + 8;
        spaceApL_[i].prepare(n);
        spaceApR_[i].prepare(n);
    }
    const int fb = static_cast<int>(kRetroSpaceFbMs * 0.001 * sampleRate) + 8;
    spaceFbL_.prepare(fb);
    spaceFbR_.prepare(fb);
    reset();
}

void RetroFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    nType_ = 0.0f;
    dType_ = 0.0f;
    noise_.set(0.0f, true);
    wobble_.set(0.0f, true);
    distort_.set(0.0f, true);
    digital_.set(0.0f, true);
    space_.set(0.0f, true);
    magnetic_.set(0.0f, true);
    // SEEDED, and re-seeded here: a render that starts from a fresh device gets the same crackle and the same
    // dropouts as the last one. Random is a texture, not a lottery.
    rng_ = 0x9e3779b9u;
    noiseLpL_.reset();
    noiseLpR_.reset();
    noiseHpL_.reset();
    noiseHpR_.reset();
    wobL_.reset();
    wobR_.reset();
    wowPh_ = 0.0;
    flutPh_ = 0.31;
    holdL_ = holdR_ = holdAcc_ = 0.0;
    for (int i = 0; i < kSpaceStages; ++i)
    {
        spaceApL_[i].reset();
        spaceApR_[i].reset();
    }
    spaceFbL_.reset();
    spaceFbR_.reset();
    spaceLpL_.reset();
    spaceLpR_.reset();
    spaceStL_ = spaceStR_ = 0.0;
    magLpL_.reset();
    magLpR_.reset();
    magBumpL_.reset();
    magBumpR_.reset();
    crackleHoldL_ = crackleHoldR_ = 0.0;
    dropEnv_ = 1.0;
    dropTimer_ = 0.0;
    dcInL_ = dcOutL_ = dcInR_ = dcOutR_ = 0.0;
    dcR_ = 1.0 - 2.0 * kPi * 5.0 / sr_;
    spaceLpL_.set(Biquad::Type::lowpass, 4200.0, 0.0, 0.0, sr_);
    spaceLpR_.set(Biquad::Type::lowpass, 4200.0, 0.0, 0.0, sr_);
    recompute();
}

void RetroFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        noise_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 1:
        nType_ = clampf(std::floor(value), 0.0f, 3.0f);
        break;
    case 2:
        wobble_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 3:
        distort_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 4:
        dType_ = clampf(std::floor(value), 0.0f, 7.0f);
        break;
    case 5:
        digital_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 6:
        space_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    case 7:
        magnetic_.set(clampf(value, 0.0f, 100.0f), immediate);
        break;
    default:
        break;
    }
    if (immediate)
        recompute();
}

float RetroFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return noise_.target;
    case 1:
        return nType_;
    case 2:
        return wobble_.target;
    case 3:
        return distort_.target;
    case 4:
        return dType_;
    case 5:
        return digital_.target;
    case 6:
        return space_.target;
    case 7:
        return magnetic_.target;
    default:
        return 0.0f;
    }
}

void RetroFx::recompute() noexcept TERMINATOR_NONBLOCKING
{
    // Each NOISE flavour is a different filter on the same seeded stream: vinyl is rumble plus crackle, tape is
    // hiss, static is wide and spitty, radio is a narrow band.
    switch (static_cast<int>(nType_))
    {
    case 0: // VINYL
        noiseLpL_.set(Biquad::Type::lowpass, 5500.0, 0.0, 0.0, sr_);
        noiseHpL_.set(Biquad::Type::highpass, 30.0, 0.0, 0.0, sr_);
        break;
    case 1: // TAPE — hiss
        noiseLpL_.set(Biquad::Type::lowpass, 16000.0, 0.0, 0.0, sr_);
        noiseHpL_.set(Biquad::Type::highpass, 900.0, 0.0, 0.0, sr_);
        break;
    case 2: // STATIC
        noiseLpL_.set(Biquad::Type::lowpass, 18000.0, 0.0, 0.0, sr_);
        noiseHpL_.set(Biquad::Type::highpass, 200.0, 0.0, 0.0, sr_);
        break;
    default: // RADIO — a narrow band, like something coming through a speaker in another room
        noiseLpL_.set(Biquad::Type::lowpass, 3000.0, 0.0, 0.0, sr_);
        noiseHpL_.set(Biquad::Type::highpass, 400.0, 0.0, 0.0, sr_);
        break;
    }
    noiseLpR_ = noiseLpL_;
    noiseHpR_ = noiseHpL_;
    const double mag = static_cast<double>(magnetic_.cur) * 0.01;
    magLpL_.set(Biquad::Type::lowpass, std::clamp(19000.0 - 13000.0 * mag, 1200.0, 0.45 * sr_), 0.0, 0.0, sr_);
    magLpR_ = magLpL_;
    magBumpL_.set(Biquad::Type::peaking, 110.0, 1.0, 4.0 * mag, sr_);
    magBumpR_ = magBumpL_;
}

/// One sample of the chosen noise flavour. VINYL adds CRACKLE — sparse, seeded impulses with a decay — which is
/// the part people actually recognise; hiss alone just sounds like a bad converter.
double RetroFx::noiseSample(int ch) noexcept TERMINATOR_NONBLOCKING
{
    double n = rnd();
    n = ch == 0 ? noiseHpL_.process(noiseLpL_.process(n)) : noiseHpR_.process(noiseLpR_.process(n));
    if (static_cast<int>(nType_) == 0 || static_cast<int>(nType_) == 2)
    {
        double& hold = ch == 0 ? crackleHoldL_ : crackleHoldR_;
        if (std::abs(rnd()) > 0.99985)
            hold = rnd() * 0.9;
        hold *= 0.995;
        n += hold;
    }
    return n;
}

/// Eight curves, so DISTORT is a palette. Every one is bounded (the 4.6c/4.6f rule) and the asymmetric ones are
/// cleaned up by the DC blocker at the end of the chain.
double RetroFx::distort(double x) const noexcept TERMINATOR_NONBLOCKING
{
    switch (static_cast<int>(dType_))
    {
    case 0: // TUBE
        return ftanh(x + 0.3 * x * x);
    case 1: // TAPE
        return ftanh(x * 0.9) * 1.05;
    case 2: // FUZZ — ASYMMETRIC on purpose: a symmetric hard fuzz is indistinguishable from CRUSH once it is
            // driven, and then the selector is decoration. The two halves clip differently, so it makes even
            // harmonics that the hard clipper cannot.
        return x >= 0.0 ? ftanh(x * 5.0) * 0.85 : ftanh(x * 2.0) * 0.55;
    case 3: // DIODE — a soft knee one way, hard the other
        return x >= 0.0 ? ftanh(x * 1.5) : ftanh(x * 3.5) * 0.7;
    case 4: // FOLD — wave folding, the sound of something wired wrong
    {
        const double t = ftanh(x);
        return std::sin(2.2 * t) * 0.8;
    }
    case 5: // BITS — a staircase, and a FINE one: with only a handful of steps it just clips like everything else
            // at high drive. Twelve keeps the quantisation itself the character.
        return std::floor(std::clamp(x, -1.2, 1.2) * 12.0 + 0.5) / 12.0;
    case 6: // TRANSISTOR
        return std::clamp(x, -1.0, 1.0) * (1.0 - 0.25 * std::abs(std::clamp(x, -1.0, 1.0)));
    default: // CRUSH — hard clip
        return std::clamp(x * 2.5, -0.85, 0.85);
    }
}

void RetroFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    if (noise_.moving() || wobble_.moving() || distort_.moving() || digital_.moving() || space_.moving() ||
        magnetic_.moving())
    {
        noise_.advance(n, sr_, kFxTau);
        wobble_.advance(n, sr_, kFxTau);
        distort_.advance(n, sr_, kFxTau);
        digital_.advance(n, sr_, kFxTau);
        space_.advance(n, sr_, kFxTau);
        magnetic_.advance(n, sr_, kFxTau);
        recompute();
    }
    const double noiseAmt = static_cast<double>(noise_.cur) * 0.01;
    const double wobAmt = static_cast<double>(wobble_.cur) * 0.01;
    const double distAmt = static_cast<double>(distort_.cur) * 0.01;
    const double digAmt = static_cast<double>(digital_.cur) * 0.01;
    const double spaceAmt = static_cast<double>(space_.cur) * 0.01;
    const double magAmt = static_cast<double>(magnetic_.cur) * 0.01;
    const bool anything =
        noiseAmt > 0.0 || wobAmt > 0.0 || distAmt > 0.0 || digAmt > 0.0 || spaceAmt > 0.0 || magAmt > 0.0;
    if (!anything)
        return; // every module at 0 = the box is not there at all

    const double wobBase = 0.004 * sr_; // 4 ms of tape under the head
    const double digBits = 16.0 - 13.0 * digAmt;
    const double digStep = std::pow(2.0, digBits - 1.0);
    const double digRate = std::max(1.0, sr_ / std::max(1.0, sr_ * (1.0 - 0.93 * digAmt)));

    for (int i = 0; i < n; ++i)
    {
        double xl = l[i], xr = r[i];

        if (wobAmt > 0.0)
        {
            wowPh_ = advancePhase(wowPh_, kRetroWowHz, sr_);
            flutPh_ = advancePhase(flutPh_, kRetroFlutHz, sr_);
            const double d = wobBase * (1.0 + wobAmt * (0.09 * lfoSine(wowPh_) + 0.02 * lfoSine(flutPh_)));
            xl = wobL_.process(xl, d);
            xr = wobR_.process(xr, d);
        }

        if (distAmt > 0.0)
        {
            const double drive = 1.0 + 7.0 * distAmt;
            const double dl = distort(xl * drive), dr = distort(xr * drive);
            const double comp = 1.0 / std::sqrt(drive);
            xl = xl * (1.0 - distAmt) + dl * comp * distAmt;
            xr = xr * (1.0 - distAmt) + dr * comp * distAmt;
        }

        if (digAmt > 0.0)
        {
            // bit depth AND sample rate fall together, which is what an early sampler actually did
            holdAcc_ += 1.0;
            if (holdAcc_ >= digRate)
            {
                holdAcc_ -= digRate;
                holdL_ = std::floor(xl * digStep + 0.5) / digStep;
                holdR_ = std::floor(xr * digStep + 0.5) / digStep;
            }
            xl = xl * (1.0 - digAmt) + holdL_ * digAmt;
            xr = xr * (1.0 - digAmt) + holdR_ * digAmt;
        }

        if (magAmt > 0.0)
        {
            // DROPOUTS: the tape briefly loses contact. Seeded, so a bounce drops out in the same places.
            dropTimer_ -= 1.0;
            if (dropTimer_ <= 0.0)
            {
                dropTimer_ = (0.25 + 0.75 * std::abs(rnd())) * sr_ * (1.0 + 4.0 * (1.0 - magAmt));
                if (std::abs(rnd()) < magAmt * 0.6)
                    dropEnv_ = 1.0 - magAmt * (0.25 + 0.55 * std::abs(rnd()));
            }
            dropEnv_ += (1.0 - dropEnv_) * 0.0012;
            xl = magBumpL_.process(magLpL_.process(xl)) * dropEnv_;
            xr = magBumpR_.process(magLpR_.process(xr)) * dropEnv_;
        }

        if (noiseAmt > 0.0)
        {
            const double g = noiseAmt * noiseAmt * 0.25;
            xl += noiseSample(0) * g;
            xr += noiseSample(1) * g;
        }

        if (spaceAmt > 0.0)
        {
            double vl = xl + 0.5 * spaceStL_, vr = xr + 0.5 * spaceStR_;
            for (int k = 0; k < kSpaceStages; ++k)
            {
                vl = springAllpass(spaceApL_[k], vl, kRetroSpaceApMs[k] * 0.001 * sr_, 0.55);
                vr = springAllpass(spaceApR_[k], vr, kRetroSpaceApMs[k] * 0.001 * sr_, 0.55);
            }
            const double tl = spaceFbL_.readAt(kRetroSpaceFbMs * 0.001 * sr_);
            const double tr = spaceFbR_.readAt(kRetroSpaceFbMs * 0.001 * sr_);
            spaceFbL_.write(vl);
            spaceFbR_.write(vr);
            spaceStL_ = spaceLpL_.process(tl);
            spaceStR_ = spaceLpR_.process(tr);
            xl = xl * (1.0 - spaceAmt * 0.6) + tl * spaceAmt * 0.6;
            xr = xr * (1.0 - spaceAmt * 0.6) + tr * spaceAmt * 0.6;
        }

        // The DC blocker runs only where DC can come from — the asymmetric curves and the crackle. Run
        // unconditionally it also smears anything held: DIGITAL's staircase came out with 7168 distinct values
        // instead of a few dozen, because every step was decaying towards zero on its way past.
        if (distAmt > 0.0 || noiseAmt > 0.0)
        {
            const double bl = xl - dcInL_ + dcR_ * dcOutL_;
            dcInL_ = xl;
            dcOutL_ = bl;
            const double br = xr - dcInR_ + dcR_ * dcOutR_;
            dcInR_ = xr;
            dcOutR_ = br;
            xl = bl;
            xr = br;
        }
        l[i] = xl;
        r[i] = xr;
    }
}

// ---- EQ 6 ---------------------------------------------------------------------------------------------------

namespace
{
/// The slopes a CUT band can run, in dB/oct. Each 12 dB is one 2-pole Butterworth section.
constexpr double kEqSlopes[6] = {12.0, 24.0, 36.0, 48.0, 72.0, 96.0};
/// Where the six bands sit when the device is inserted — spread across the spectrum so the first thing a user
/// does is move one, not hunt for it.
constexpr float kEqDefaultFreq[EqFx6::kBands] = {60.0f, 200.0f, 800.0f, 2500.0f, 6000.0f, 12000.0f};
} // namespace

void EqFx6::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    reset();
}

void EqFx6::reset() noexcept TERMINATOR_NONBLOCKING
{
    for (int b = 0; b < kBands; ++b)
    {
        band_[b].type = 0.0f;
        band_[b].freq.set(kEqDefaultFreq[b], true);
        band_[b].gain.set(0.0f, true);
        band_[b].q.set(1.0f, true);
        band_[b].slope = 1.0f; // 24 dB/oct
        band_[b].sections = 0;
        for (int k = 0; k < kMaxSections; ++k)
            for (int c = 0; c < 2; ++c)
            {
                sec_[b][k][c].reset();
                sec_[b][k][c].setIdentity();
            }
    }
    out_.set(0.0f, true);
}

void EqFx6::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    const int nBandParams = kBands * kParamsPerBand;
    if (index == nBandParams) // OUT
    {
        out_.set(clampf(value, -24.0f, 24.0f), immediate);
        return;
    }
    if (index < 0 || index >= nBandParams)
        return;
    const int b = index / kParamsPerBand, p = index % kParamsPerBand;
    Band& bd = band_[b];
    switch (p)
    {
    case 0:
        bd.type = clampf(std::floor(value), 0.0f, 7.0f);
        break;
    case 1:
        bd.freq.set(clampf(value, 20.0f, 20000.0f), immediate);
        break;
    case 2:
        bd.gain.set(clampf(value, -30.0f, 30.0f), immediate);
        break;
    case 3:
        bd.q.set(clampf(value, 0.1f, 18.0f), immediate);
        break;
    default:
        bd.slope = clampf(std::floor(value), 0.0f, 5.0f);
        break;
    }
    recomputeBand(b);
}

float EqFx6::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    const int nBandParams = kBands * kParamsPerBand;
    if (index == nBandParams)
        return out_.target;
    if (index < 0 || index >= nBandParams)
        return 0.0f;
    const Band& bd = band_[index / kParamsPerBand];
    switch (index % kParamsPerBand)
    {
    case 0:
        return bd.type;
    case 1:
        return bd.freq.target;
    case 2:
        return bd.gain.target;
    case 3:
        return bd.q.target;
    default:
        return bd.slope;
    }
}

void EqFx6::recomputeBand(int b) noexcept TERMINATOR_NONBLOCKING
{
    Band& bd = band_[b];
    const double f = static_cast<double>(bd.freq.cur);
    const double g = static_cast<double>(bd.gain.cur);
    const double q = static_cast<double>(bd.q.cur);
    const int t = static_cast<int>(bd.type);
    // start from "this band does nothing", then fill in only the sections it needs
    for (int k = 0; k < kMaxSections; ++k)
        for (int c = 0; c < 2; ++c)
            sec_[b][k][c].setIdentity();
    bd.sections = 0;
    if (t == 0)
        return; // OFF is bit-exact: no section runs at all

    const auto both = [&](int k, Biquad::Type type, double freq, double qq, double gainDb)
    {
        sec_[b][k][0].set(type, freq, qq, gainDb, sr_);
        sec_[b][k][1].set(type, freq, qq, gainDb, sr_);
    };
    switch (t)
    {
    case 1: // BELL
        both(0, Biquad::Type::peaking, f, q, g);
        bd.sections = 1;
        break;
    case 2: // LOW SHELF
        both(0, Biquad::Type::lowshelf, f, q, g);
        bd.sections = 1;
        break;
    case 3: // HIGH SHELF
        both(0, Biquad::Type::highshelf, f, q, g);
        bd.sections = 1;
        break;
    case 6: // NOTCH
        both(0, Biquad::Type::notch, f, q, g);
        bd.sections = 1;
        break;
    case 7: // TILT — one shelf down, one up, around the same point: a whole-spectrum lean
        both(0, Biquad::Type::lowshelf, f, 0.7071, -g);
        both(1, Biquad::Type::highshelf, f, 0.7071, g);
        bd.sections = 2;
        break;
    default: // 4 = LOW CUT, 5 = HIGH CUT — a REAL cascade, not one biquad with a big Q
    {
        const int n = static_cast<int>(kEqSlopes[static_cast<int>(bd.slope)] / 12.0);
        const auto type = t == 4 ? Biquad::Type::highpass : Biquad::Type::lowpass;
        for (int k = 0; k < n; ++k)
        {
            // Butterworth section Qs for a 2n-pole cascade. The Web Audio biquad takes Q in DECIBELS for the cut
            // types (the spec's convention) — passing the linear value here would put every slope in the wrong
            // place, quietly.
            const double qLin =
                1.0 / (2.0 * std::cos(kPi * (2.0 * static_cast<double>(k) + 1.0) / (4.0 * static_cast<double>(n))));
            both(k, type, f, 20.0 * std::log10(qLin), 0.0);
        }
        bd.sections = n;
        break;
    }
    }
}

void EqFx6::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    for (int b = 0; b < kBands; ++b)
    {
        Band& bd = band_[b];
        if (bd.freq.moving() || bd.gain.moving() || bd.q.moving())
        {
            bd.freq.advance(n, sr_, kFxTau, 1e-3f);
            bd.gain.advance(n, sr_, kFxTau);
            bd.q.advance(n, sr_, kFxTau);
            recomputeBand(b);
        }
    }
    if (out_.moving())
        out_.advance(n, sr_, kFxTau);
    const double outGain = std::pow(10.0, static_cast<double>(out_.cur) / 20.0);

    for (int b = 0; b < kBands; ++b)
    {
        const int sections = band_[b].sections;
        for (int k = 0; k < sections; ++k)
        {
            Biquad& bl = sec_[b][k][0];
            Biquad& br = sec_[b][k][1];
            for (int i = 0; i < n; ++i)
            {
                l[i] = bl.process(l[i]);
                r[i] = br.process(r[i]);
            }
        }
    }
    if (outGain != 1.0)
        for (int i = 0; i < n; ++i)
        {
            l[i] *= outGain;
            r[i] *= outGain;
        }
}

} // namespace terminator
