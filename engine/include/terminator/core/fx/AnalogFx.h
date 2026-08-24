#pragma once
// The PREMIUM analog-modelled devices (Phase 4.6 — B4 "VICTOR'S PHASE-4 BRIEF"). These are NOT parity ports: the
// 4.2 devices stay exactly as they are so old projects load and sound the same, and these are new stock devices
// that only exist natively (the page's Web Audio twin is a documented pass-through — nothing on the page is heard
// in the shell).
//
//   · FetCompFx — FET COMP: the aggressive FET compressor (Empirical Labs EL8-style) Victor asked for — a RATIO
//     SWITCH rather than a threshold knob (you drive it with INPUT, exactly like the hardware), a filtered
//     detector, program-dependent release, the DIST 2 / DIST 3 harmonic modes and BRITISH mode.
//   · RetroFx — RETRO: the RC-20-shaped multi-effect — NOISE, WOBBLE, DISTORT (eight curves), DIGITAL, SPACE and
//     MAGNETIC in one box, every random element seeded so a bounce is the same take you heard.
//   · LimiterFx — LIMITER: a modern mastering limiter (styles, look-ahead, true peak). The ONE thing it must never
//     do is exceed its ceiling, so the applied gain is hard-clamped to the gain that sample actually needs — the
//     smoothing shapes how it gets there, it never decides whether it arrives.
//   · SaturatorFx — SATURATOR: the Decapitator's five analogue flavours (tube / germanium / British console /
//     transformer / punish), each a different curve on the same 4x-oversampled, DC-blocked, auto-gained stage.
//   · PlateVerbFx — HALL 224: the Lexicon 224's programs on a Dattorro tank — a REAL algorithmic reverb (input
//     diffusion into two cross-coupled modulated half-loops), where DECAY is in SECONDS because the loop gain is
//     solved for the RT60 you asked for, not a feel knob.
//   · TapeEchoFx — TAPE ECHO: the RE-201 Space Echo (three playback heads on one tape loop, motor-speed REPEAT
//     RATE with real wow and flutter, tape saturation, a head bump, repeats that darken every pass, INTENSITY that
//     runs away into self-oscillation, and the spring tank).
//   · LadderFx — ANALOG FILTER: the Moog transistor ladder (D'Angelo–Välimäki nonlinear model, the same equations
//     the BASS synth's LADDER uses, deliberately its own copy: this one runs 4× oversampled with an IIR decimator,
//     mixes the stage taps for the 6/12/18/24 dB LP · 12/24 dB HP · 12/24 dB BP modes, has its own DRIVE stage with
//     auto-gain, and self-oscillates from an analog noise floor. Changing it must never change how a bass patch
//     sounds, which a shared class could not promise.)
#include <algorithm>
#include <cstdint>
#include <vector>

#include "terminator/core/fx/Effect.h"
#include "terminator/core/fx/FxDsp.h" // DelayLine (the tape + the spring tank), lfoSine / advancePhase

namespace terminator
{

/// The Moog ladder core: four nonlinear one-pole stages with a resonant feedback path, integrated with the
/// trapezoidal rule at `srOs` (the OVERSAMPLED rate — the caller runs `kOversample` steps per base sample).
/// `V[k]` is stage k's state; the odd inversion of stage 0 is undone by the tap mixer (`tapLp1..4` are positive).
struct MoogLadder
{
    double V[4] = {}, dV[4] = {}, tV[4] = {};
    double g = 0.0;

    void reset() noexcept TERMINATOR_NONBLOCKING;
    /// g for cutoff `hz` at the oversampled rate (the model's bilinear pre-warp).
    void setCutoff(double hz, double srOs) noexcept TERMINATOR_NONBLOCKING;
    /// One step at the oversampled rate. `x` = the (already driven) input, `res` = feedback 0..~4.5.
    void step(double x, double res, double srOs) noexcept TERMINATOR_NONBLOCKING;

    double tapLp1() const noexcept TERMINATOR_NONBLOCKING { return -V[0]; }
    double tapLp2() const noexcept TERMINATOR_NONBLOCKING { return -V[1]; }
    double tapLp3() const noexcept TERMINATOR_NONBLOCKING { return -V[2]; }
    double tapLp4() const noexcept TERMINATOR_NONBLOCKING { return -V[3]; }
};

/// A 4-pole Butterworth lowpass (two cascaded TPT state-variable sections) used as the ladder's DECIMATION filter:
/// it runs at the oversampled rate and kills the images the nonlinearity throws above the base Nyquist before the
/// 4:1 drop. Minimum phase, so the device still reports ZERO latency (its in-band group delay is a fraction of a
/// base sample) — a filter you put on a live pad must not push the whole strip back through PDC.
class ButterLp4
{
  public:
    void reset() noexcept TERMINATOR_NONBLOCKING;
    void set(double cutoffHz, double sampleRate) noexcept TERMINATOR_NONBLOCKING;
    double process(double x) noexcept TERMINATOR_NONBLOCKING;

  private:
    struct Section
    {
        double ic1 = 0.0, ic2 = 0.0;
        double g = 0.0, k = 1.414213562373095, a1 = 0.0, a2 = 0.0, a3 = 0.0;
        double process(double v0) noexcept TERMINATOR_NONBLOCKING;
    };
    Section s1_, s2_;
};

/// FET COMP — the premium dynamics device (Phase 4.6c).
///   RATIO   1:1 | 2:1 | 3:1 | 4:1 | 6:1 | 10:1 | 20:1 | NUKE (the SWITCH is the character, not just the slope:
///           the knee tightens as it climbs and NUKE drops the threshold, hardens the knee and slows the release)
///   INPUT   −12..+24 dB — **there is no THRESHOLD knob, on purpose.** The threshold is fixed where the hardware's
///           is and you drive INTO it: INPUT is how hard it works, OUTPUT brings the level back.
///   ATTACK  0.05..50 ms · RELEASE 20..2000 ms, program-dependent (deep gain reduction releases slower, opto-style)
///   DETECT  FLAT | HP1 | HP2 | BAND — what the SIDE CHAIN hears, so a kick stops ducking the whole mix
///   MODE    CLEAN | DIST 2 (even harmonics, tube-ish) | DIST 3 (odd, transformer-ish) | BRITISH (faster, harder,
///           dirtier — the aggressive input stage)
///   OUTPUT  −24..+24 dB · WET 0..100 (the CHAIN crossfades it, so parallel compression is one knob)
/// The harmonics run 4× oversampled through the same ZOH-up / Butterworth-down pair the ANALOG FILTER uses, so the
/// device still reports ZERO latency: a FET compressor is feed-forward and has no look-ahead to declare.
class FetCompFx final : public Effect
{
  public:
    static constexpr int kOversample = 4;

    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::fetcomp; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    float gainReductionDb() const noexcept TERMINATOR_NONBLOCKING override { return grDb_; }
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    struct Curve
    {
        double ratio = 4.0; // ≥ 1 (NUKE = 20 with everything else pushed)
        double thresholdDb = -18.0;
        double kneeDb = 6.0;
        double releaseScale = 1.0;
    };
    Curve curveFor(int ratioIndex) const noexcept TERMINATOR_NONBLOCKING;
    double detect(double x, int ch) noexcept TERMINATOR_NONBLOCKING;
    double shape(double x) const noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    double srOs_ = 192000.0;
    float ratioIdx_ = 3.0f; // 4:1
    float detectIdx_ = 0.0f;
    float modeIdx_ = 0.0f;
    Glide input_, attack_, release_, output_;
    // the side-chain filters (one per channel) and the gain state
    Biquad scHpL_, scHpR_, scBandL_, scBandR_;
    double gainDb_ = 0.0;  // the gain reduction the smoother is at (≤ 0)
    double peakEnv_ = 0.0; // the RECTIFIER: instant attack, short decay — a detector that followed |x| sample by
                           // sample would let go at every zero crossing and modulate the gain at the signal's own
                           // frequency (which is distortion, and it made ATTACK measure ~30 % fast)
    float grDb_ = 0.0f;    // published for the page's meters
    ButterLp4 decL_, decR_;
    // The DC blocker every asymmetric stage needs: DIST 2 is an even-harmonic shaper, and an even shaper ALWAYS
    // leaves DC behind (the hardware has a coupling capacitor doing this job).
    double dcInL_ = 0.0, dcOutL_ = 0.0, dcInR_ = 0.0, dcOutR_ = 0.0, dcR_ = 0.999;
};

/// A Schroeder allpass on a delay line — the dispersion element the spring tank is built from.
double springAllpass(DelayLine& dl, double x, double delaySamples, double g) noexcept TERMINATOR_NONBLOCKING;

/// RETRO — the RC-20-shaped character box (Phase 4.6h). Six modules in series, each doing nothing at 0.
///   NOISE / NTYPE  0..100 · VINYL | TAPE | STATIC | RADIO — the floor a record has and a plugin does not.
///   WOBBLE   0..100 — the worn transport (wow + flutter on a delay line).
///   DISTORT / DTYPE  0..100 · TUBE | TAPE | FUZZ | DIODE | FOLD | BITS | TRANSISTOR | CRUSH — eight curves, so
///            "distort" is a palette rather than one sound.
///   DIGITAL  0..100 — bit depth AND sample rate falling together, the sound of an early sampler.
///   SPACE    0..100 — a small diffuse room, for the "recorded in a place" feeling.
///   MAGNETIC 0..100 — tape: dropouts, head-bump and the top going away.
///   WET      0..100 (the CHAIN crossfades).
/// **Everything random is SEEDED and reset with the device**, so an export is the take you heard, not a new roll.
class RetroFx final : public Effect
{
  public:
    static constexpr int kSpaceStages = 3;

    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::retro; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double rnd() noexcept TERMINATOR_NONBLOCKING; // −1..1, seeded
    double noiseSample(int ch) noexcept TERMINATOR_NONBLOCKING;
    double distort(double x) const noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    float nType_ = 0.0f, dType_ = 0.0f;
    Glide noise_, wobble_, distort_, digital_, space_, magnetic_;
    std::uint32_t rng_ = 0x9e3779b9u;
    // NOISE
    Biquad noiseLpL_, noiseLpR_, noiseHpL_, noiseHpR_;
    double crackleHoldL_ = 0.0, crackleHoldR_ = 0.0;
    // WOBBLE
    DelayLine wobL_, wobR_;
    double wowPh_ = 0.0, flutPh_ = 0.0;
    // DIGITAL
    double holdL_ = 0.0, holdR_ = 0.0, holdAcc_ = 0.0;
    // SPACE
    DelayLine spaceApL_[kSpaceStages], spaceApR_[kSpaceStages], spaceFbL_, spaceFbR_;
    Biquad spaceLpL_, spaceLpR_;
    double spaceStL_ = 0.0, spaceStR_ = 0.0;
    // MAGNETIC
    Biquad magLpL_, magLpR_, magBumpL_, magBumpR_;
    double dropEnv_ = 1.0, dropTimer_ = 0.0;
    double dcInL_ = 0.0, dcOutL_ = 0.0, dcInR_ = 0.0, dcOutR_ = 0.0, dcR_ = 0.999;
};

/// LIMITER — the mastering limiter (Phase 4.6g).
///   STYLE     TRANSPARENT | PUNCHY | DYNAMIC | ALLROUND | AGGRESSIVE | BUS | SAFE — the release law and how much
///             the attack is smoothed. PUNCHY lets transients through, BUS barely moves, SAFE is a catch net.
///   GAIN      0..24 dB into the limiter (how hard you push it) · CEILING −12..0 dBFS
///   RELEASE   1..1000 ms · LOOKAHEAD 0..20 ms (reported as latency, so PDC lines the strip back up)
///   TP        OFF | ON — TRUE peak: the level BETWEEN samples, estimated by 4x interpolation. A sample-peak
///             limiter can hand a converter something above its ceiling and an mp3 encoder something worse.
///   LINK      0..100 — how much the two channels share one gain (100 = the image never moves).
/// The chain runs it fully wet (a limiter is not a parallel device); `gainReductionDb()` feeds the panel meter.
class LimiterFx final : public Effect
{
  public:
    static constexpr double kMaxLookaheadSec = 0.02;

    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::limiter; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    /// The look-ahead, and with TRUE PEAK armed at least two samples — an inter-sample peak cannot be read without
    /// the samples on either side of it. Reported honestly because PDC lines the whole strip up from this number,
    /// and Mixer::setFxParam now rebuilds the plan when a param moves it.
    int latencySamples() const noexcept TERMINATOR_NONBLOCKING override
    {
        return tp_ > 0.5f ? std::max(look_, 2) : look_;
    }
    float gainReductionDb() const noexcept TERMINATOR_NONBLOCKING override { return grDb_; }
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

    /// {release scale, how much of the look-ahead the attack is smoothed over, program dependence} — public only
    /// so the style table can live at file scope in the .cpp (a nonblocking function may not have a static local).
    struct Style
    {
        double releaseScale, smoothFrac, program;
    };

  private:
    Style styleFor(int i) const noexcept TERMINATOR_NONBLOCKING;
    /// The sliding MINIMUM of the required gain over the look-ahead window — this is the anticipation: it drops as
    /// soon as a peak ENTERS the window, which is `look_` samples before that peak is played.
    double slideMin(double v) noexcept TERMINATOR_NONBLOCKING;
    double truePeak(double prev2, double prev1, double x, double next) const noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    float styleIdx_ = 3.0f;
    float tp_ = 0.0f;
    Glide gain_, ceiling_, release_, lookMs_, link_;
    int look_ = 0, maxLook_ = 0;
    std::vector<double> dlyL_, dlyR_; // the look-ahead delay on the audio
    int dlyPos_ = 0;
    std::vector<double> reqRing_; // the required-gain history the sliding min reads
    std::vector<int> minDeque_;   // monotonic indices into reqRing_ (allocation-free after prepare)
    int minHead_ = 0, minTail_ = 0;
    std::int64_t minCount_ = 0;
    double smooth_ = 1.0, held_ = 1.0;
    double tpHistL_[3] = {}, tpHistR_[3] = {};
    float grDb_ = 0.0f;
};

/// SATURATOR — five analogue flavours on one stage (Phase 4.6f).
///   STYLE   A (tube — asymmetric, even harmonics first) | E (germanium, harder edge) | N (British console, gentle
///           odd) | T (transformer, saturates the bottom first) | P (punish — fold-back fuzz)
///   DRIVE   0..100 — **0 is bit-clean**: the stage is bypassed entirely, not "nearly transparent".
///   TONE    −100..+100 — a tilt BEFORE the curve, so it changes what gets distorted, not just what comes out.
///   LOWCUT / HIGHCUT — also before the curve: keep the bottom out of the distortion and the fizz off the top.
///   PUNISH  0/1 — the extra 6x of drive, the way the hardware's abusive setting works.
///   OUTPUT  −24..+24 dB · WET 0..100 (the CHAIN crossfades, so parallel saturation is one knob).
class SaturatorFx final : public Effect
{
  public:
    static constexpr int kOversample = 4;

    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::saturator; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double curve(double x) const noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    double srOs_ = 192000.0;
    float styleIdx_ = 0.0f;
    float punish_ = 0.0f;
    Glide drive_, tone_, lowCut_, highCut_, output_;
    Biquad hpL_, hpR_, lpL_, lpR_, tiltLoL_, tiltLoR_, tiltHiL_, tiltHiR_;
    ButterLp4 decSatL_, decSatR_;
    double dcInL_ = 0.0, dcOutL_ = 0.0, dcInR_ = 0.0, dcOutR_ = 0.0, dcR_ = 0.999;
};

/// HALL 224 — the Lexicon 224's programs on a Dattorro tank (Phase 4.6e).
///   PROGRAM   HALL | CHAMBER | PLATE | ROOM | AMBIENCE — each sets the tank's size, diffusion, damping and how
///             much the tail moves; the 224's character is that its tails MODULATE, which is why they never sit
///             still and buzz the way a static tank does.
///   PREDELAY  0..250 ms · DECAY 0.2..20 s — **DECAY is in SECONDS**: the loop gain is solved from the tank's own
///             round-trip time for the RT60 asked for, so "3 s" measures 3 s rather than meaning "quite long".
///   SIZE      0..100 (the tank scales, so the whole room changes size, not just the time)
///   DIFFUSION 0..100 — smear on the input; low leaves the early reflections audible as separate events.
///   BASS      0.2..4.0 — the 224's bass decay MULTIPLIER: how much longer (or shorter) the bottom rings than the
///             rest. 2 is a hall, 0.5 keeps a mix clean.
///   DAMP      0..100 — treble decay: the top goes first, as it does in a real room.
///   MOD       0..100 · WET 0..100 (the CHAIN crossfades).
class PlateVerbFx final : public Effect
{
  public:
    static constexpr int kInDiffusers = 4;
    static constexpr double kRefSr = 29761.0; // Dattorro's rate — every length below is scaled from it
    static constexpr double kMaxPredelaySec = 0.25;
    static constexpr double kMaxSizeScale = 2.0;

    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::plateverb; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    float programIdx_ = 0.0f;
    Glide predelay_, decay_, size_, diffusion_, bassMult_, damp_, mod_;
    // input path
    DelayLine pre_;
    Biquad inLp_;
    DelayLine inAp_[kInDiffusers];
    // the tank: two cross-coupled halves, each a modulated allpass → delay → damping → allpass → delay
    DelayLine apAm_, delA1_, apA2_, delA2_;
    DelayLine apBm_, delB1_, apB2_, delB2_;
    Biquad dampA_, dampB_, bassA_, bassB_;
    double tankA_ = 0.0, tankB_ = 0.0;
    double modPhaseA_ = 0.0, modPhaseB_ = 0.0;
    // resolved per block
    double lenIn_[kInDiffusers] = {}, lenApAm_ = 0.0, lenA1_ = 0.0, lenApA2_ = 0.0, lenA2_ = 0.0;
    double lenApBm_ = 0.0, lenB1_ = 0.0, lenApB2_ = 0.0, lenB2_ = 0.0;
    double decayGain_ = 0.5, inDiff1_ = 0.75, inDiff2_ = 0.625, modDepth_ = 0.0;
};

/// TAPE ECHO — the RE-201 Space Echo (Phase 4.6d).
///   MODE      H1 | H2 | H3 | H1+2 | H2+3 | H1+3 | H1+2+3 — WHICH of the three playback heads are reading the loop.
///             One tape, three heads at fixed spacing (×1.0, ×1.6, ×2.2 of the base time), which is why the
///             multi-head modes give those uneven, rolling patterns a single delay cannot.
///   TIME      20..1500 ms — the MOTOR SPEED, so it GLIDES (τ 250 ms): moving it bends the pitch of whatever is
///             still on the tape, exactly like turning the knob on the hardware. It is not a jump-cut.
///   INTENSITY 0..100 — feedback. Past ~90 the loop runs away and self-oscillates; the tape saturation is what
///             keeps that bounded instead of exploding.
///   WOW       0..100 — the motor's wow (0.7 Hz) and flutter (7.3 Hz) together, the L/R phases offset so it drifts
///             in stereo instead of moving as one block.
///   SAT       0..100 — how hard the tape is driven. Each pass goes through it again, so repeats do not just get
///             quieter, they get thicker and darker (the loop's LP + head bump are inside the feedback path).
///   BASS / TREBLE  −12..+12 dB on the echo, the front-panel tone controls.
///   SPRING    0..100 — the tank, blended into the echo path.
///   WET       0..100 (the CHAIN crossfades — ECHO VOLUME).
class TapeEchoFx final : public Effect
{
  public:
    static constexpr double kHeadRatio[3] = {1.0, 1.6, 2.2};
    static constexpr double kMaxTimeSec = 1.5;
    static constexpr int kSpringStages = 4;

    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::tapeecho; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double spring(double x, int ch) noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    float modeIdx_ = 6.0f; // H1+2+3
    Glide time_, intensity_, wow_, sat_, bass_, treble_, springAmt_;
    DelayLine tapeL_, tapeR_;
    // inside the loop: the tape's own losses — an LP that takes a little more top off every pass, an HP, and the
    // head bump (the low-mid resonance a tape head has)
    Biquad loopLpL_, loopLpR_, loopHpL_, loopHpR_, bumpL_, bumpR_;
    Biquad bassL_, bassR_, trebL_, trebR_;
    double wowPhase_ = 0.0, flutPhase_ = 0.0;
    // the spring tank: a dispersive allpass chain into a damped feedback delay
    DelayLine springApL_[kSpringStages], springApR_[kSpringStages];
    DelayLine springFbL_, springFbR_;
    Biquad springLpL_, springLpR_;
    double springStateL_ = 0.0, springStateR_ = 0.0;
};

/// ANALOG FILTER — the Moog ladder as a mixer insert.
///   MODE   LP24|LP18|LP12|LP6|HP24|HP12|BP24|BP12 (the ladder's stage taps mixed, Oberheim-style)
///   CUTOFF 20..20000 Hz (τ 10 ms)
///   RESO   0..100 → feedback 0..4.5; it rings hard past ~85 and SELF-OSCILLATES at 100 (seeded by the model's own
///          −120 dBFS noise floor, so it starts singing from silence exactly like the hardware)
///   DRIVE  0..100 → a compensated tanh input stage in FRONT of the ladder (1..16×, √g makeup), crossfaded in so
///          DRIVE 0 is bit-clean and DRIVE 100 is colour rather than volume
///   WET    0..100 (the CHAIN crossfades; 100 = default)
/// Runs 4× oversampled (ZOH up, Butterworth decimation) — latencySamples() = 0.
class LadderFx final : public Effect
{
  public:
    static constexpr int kOversample = 4;

    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::ladder; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double tapMix(const MoogLadder& f, double x) const noexcept TERMINATOR_NONBLOCKING;
    static double drive(double x, double d, double g, double comp) noexcept TERMINATOR_NONBLOCKING;
    double noise() noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    double srOs_ = 192000.0;
    float mode_ = 0.0f;
    Glide cutoff_, reso_, drive_;
    MoogLadder fL_, fR_;
    ButterLp4 decL_, decR_;
    std::uint32_t rng_ = 0x1234567u;
};

} // namespace terminator
