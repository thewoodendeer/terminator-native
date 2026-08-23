#include "terminator/core/fx/DynamicsFx.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr float kFxTau = 0.01f;
constexpr float kPiOverTwo = 1.57079632679489661923f;
// Metering hits peaks instantly, but releases this fast (in seconds).
constexpr float kMeteringReleaseTimeConstant = 0.325f;
constexpr float kUninitialized = -1.0f;

float clampf(float v, float lo, float hi) noexcept
{
    return v < lo ? lo : (v > hi ? hi : v);
}
float linearToDecibels(float linear) noexcept TERMINATOR_NONBLOCKING
{
    if (linear == 0.0f)
        return -1000.0f;
    return 20.0f * std::log10(linear);
}
float decibelsToLinear(float db) noexcept TERMINATOR_NONBLOCKING
{
    return std::pow(10.0f, 0.05f * db);
}
float discreteTimeConstantForSampleRate(float t, float sr) noexcept
{
    return 1.0f - std::exp(-1.0f / (sr * t));
}
float flushDenormal(float v) noexcept TERMINATOR_NONBLOCKING
{
    return (v > -1e-30f && v < 1e-30f) ? 0.0f : v;
}
} // namespace

// ---- BlinkCompressorKernel ----------------------------------------------------------------------------------

void BlinkCompressorKernel::prepare(float sampleRate) noexcept
{
    sampleRate_ = sampleRate;
    meteringReleaseK_ = discreteTimeConstantForSampleRate(kMeteringReleaseTimeConstant, sampleRate);
    ratio_ = slope_ = linearThreshold_ = dbThreshold_ = dbKnee_ = kneeThreshold_ = kneeThresholdDb_ =
        ykneeThresholdDb_ = K_ = kUninitialized;
    reset();
}

void BlinkCompressorKernel::reset() noexcept TERMINATOR_NONBLOCKING
{
    detectorAverage_ = 0.0f;
    compressorGain_ = 1.0f;
    meteringGain_ = 1.0f;
    for (auto& b : preDelayBuffers_)
        for (auto& v : b)
            v = 0.0f;
    preDelayReadIndex_ = 0;
    preDelayWriteIndex_ = kDefaultPreDelayFrames;
    lastPreDelayFrames_ =
        kDefaultPreDelayFrames;          // a fresh kernel (Blink only resets at construction; a re-acquired
                                         // device must re-configure its look-ahead on the next setPreDelayTime)
    maxAttackCompressionDiffDb_ = -1.0f; // uninitialized state
}

void BlinkCompressorKernel::setPreDelayTime(float preDelaySec) noexcept TERMINATOR_NONBLOCKING
{
    // Re-configure look-ahead section pre-delay if delay time has changed.
    int preDelayFrames = static_cast<int>(preDelaySec * sampleRate_);
    if (preDelayFrames > kMaxPreDelayFrames - 1)
        preDelayFrames = kMaxPreDelayFrames - 1;
    if (preDelayFrames < 0)
        preDelayFrames = 0;
    if (lastPreDelayFrames_ != preDelayFrames)
    {
        lastPreDelayFrames_ = preDelayFrames;
        for (auto& b : preDelayBuffers_)
            for (auto& v : b)
                v = 0.0f;
        preDelayReadIndex_ = 0;
        preDelayWriteIndex_ = preDelayFrames;
    }
}

// Exponential curve for the knee. It is 1st derivative matched at linearThreshold_ and asymptotically approaches
// the value aboveThreshold + 1 (and has a slope of 1).
float BlinkCompressorKernel::kneeCurve(float x, float k) const noexcept TERMINATOR_NONBLOCKING
{
    if (x < linearThreshold_)
        return x;
    return linearThreshold_ + (1.0f - std::exp(-k * (x - linearThreshold_))) / k;
}

// Full compression curve with constant ratio after knee.
float BlinkCompressorKernel::saturate(float x, float k) const noexcept TERMINATOR_NONBLOCKING
{
    float y;
    if (x < kneeThreshold_)
        y = kneeCurve(x, k);
    else
    {
        const float xDb = linearToDecibels(x);
        const float yDb = ykneeThresholdDb_ + slope_ * (xDb - kneeThresholdDb_);
        y = decibelsToLinear(yDb);
    }
    return y;
}

// Approximate 1st derivative with input and output expressed in dB (= the inverse of the compression "ratio").
float BlinkCompressorKernel::slopeAt(float x, float k) const noexcept TERMINATOR_NONBLOCKING
{
    if (x < linearThreshold_)
        return 1.0f;
    const float x2 = x * 1.001f;
    const float xDb = linearToDecibels(x);
    const float x2Db = linearToDecibels(x2);
    const float yDb = linearToDecibels(kneeCurve(x, k));
    const float y2Db = linearToDecibels(kneeCurve(x2, k));
    return (y2Db - yDb) / (x2Db - xDb);
}

float BlinkCompressorKernel::kAtSlope(float desiredSlope) const noexcept TERMINATOR_NONBLOCKING
{
    const float xDb = dbThreshold_ + dbKnee_;
    const float x = decibelsToLinear(xDb);
    // Approximate k given initial values.
    float minK = 0.1f;
    float maxK = 10000.0f;
    float k = 5.0f;
    for (int i = 0; i < 15; ++i)
    {
        // A high value for k will more quickly asymptotically approach a slope of 0.
        const float slope = slopeAt(x, k);
        if (slope < desiredSlope)
            maxK = k; // k is too high
        else
            minK = k; // k is too low
        // Re-calculate based on geometric mean.
        k = std::sqrt(minK * maxK);
    }
    return k;
}

float BlinkCompressorKernel::updateStaticCurveParameters(float dbThreshold, float dbKnee,
                                                         float ratio) noexcept TERMINATOR_NONBLOCKING
{
    if (dbThreshold != dbThreshold_ || dbKnee != dbKnee_ || ratio != ratio_)
    {
        // Threshold and knee.
        dbThreshold_ = dbThreshold;
        linearThreshold_ = decibelsToLinear(dbThreshold);
        dbKnee_ = dbKnee;
        // Compute knee parameters.
        ratio_ = ratio;
        slope_ = 1.0f / ratio_;
        const float k = kAtSlope(1.0f / ratio_);
        kneeThresholdDb_ = dbThreshold + dbKnee;
        kneeThreshold_ = decibelsToLinear(kneeThresholdDb_);
        ykneeThresholdDb_ = linearToDecibels(kneeCurve(kneeThreshold_, k));
        K_ = k;
    }
    return K_;
}

void BlinkCompressorKernel::process(const double* const* src, double* const* dst, int numChannels, int frames,
                                    float dbThreshold, float dbKnee, float ratio, float attackTime, float releaseTime,
                                    float preDelayTime, float dbPostGain, float effectBlend, float releaseZone1,
                                    float releaseZone2, float releaseZone3,
                                    float releaseZone4) noexcept TERMINATOR_NONBLOCKING
{
    numChannels = std::clamp(numChannels, 1, 2);
    const float sampleRate = sampleRate_;
    const float dryMix = 1.0f - effectBlend;
    const float wetMix = effectBlend;
    const float k = updateStaticCurveParameters(dbThreshold, dbKnee, ratio);

    // Makeup gain.
    const float fullRangeGain = saturate(1.0f, k);
    float fullRangeMakeupGain = 1.0f / fullRangeGain;
    // Empirical/perceptual tuning.
    fullRangeMakeupGain = std::pow(fullRangeMakeupGain, 0.6f);
    const float masterLinearGain = decibelsToLinear(dbPostGain) * fullRangeMakeupGain;

    // Attack parameters.
    attackTime = std::max(0.001f, attackTime);
    const float attackFrames = attackTime * sampleRate;
    // Release parameters.
    const float releaseFrames = sampleRate * releaseTime;
    // Detector release time.
    const float satReleaseTime = 0.0025f;
    const float satReleaseFrames = satReleaseTime * sampleRate;

    // Create a smooth function which passes through four points (y = a + b·x + c·x² + d·x³ + e·x⁴).
    const float y1 = releaseFrames * releaseZone1;
    const float y2 = releaseFrames * releaseZone2;
    const float y3 = releaseFrames * releaseZone3;
    const float y4 = releaseFrames * releaseZone4;
    // Derived for 4th-order polynomial curve fitting where the y values match the evenly spaced x values
    // (y1 : x == 0, y2 : x == 1, y3 : x == 2, y4 : x == 3).
    const float kA = 0.9999999999999998f * y1 + 1.8432219684323923e-16f * y2 - 1.9373394351676423e-16f * y3 +
                     8.824516011816245e-18f * y4;
    const float kB =
        -1.5788320352845888f * y1 + 2.3305837032074286f * y2 - 0.9141194204840429f * y3 + 0.1623677525612032f * y4;
    const float kC =
        0.5334142869106424f * y1 - 1.272736789213631f * y2 + 0.9258856042207512f * y3 - 0.18656310191776226f * y4;
    const float kD =
        0.08783463138207234f * y1 - 0.1694162967925622f * y2 + 0.08588057951595272f * y3 - 0.00429891410546283f * y4;
    const float kE =
        -0.042416883008123074f * y1 + 0.1115693827987602f * y2 - 0.09764676325265872f * y3 + 0.028494263462021576f * y4;

    setPreDelayTime(preDelayTime);

    int frameIndex = 0;
    while (frameIndex < frames)
    {
        const int loopFrames = std::min(kDivisionFrames, frames - frameIndex);
        // Calculate desired gain. Fix gremlins.
        if (std::isnan(detectorAverage_) || std::isinf(detectorAverage_))
            detectorAverage_ = 1.0f;
        const float desiredGain = detectorAverage_;
        // Pre-warp so we get desiredGain after sin() warp below.
        const float scaledDesiredGain = std::asin(desiredGain) / kPiOverTwo;

        // envelopeRate is the rate we slew from current compressor level to the desired level.
        float envelopeRate;
        const bool isReleasing = scaledDesiredGain > compressorGain_;
        // compressionDiffDb is the difference between current compression level and the desired level.
        float compressionDiffDb = linearToDecibels(compressorGain_ / scaledDesiredGain);
        if (isReleasing)
        {
            // Release mode - compressionDiffDb should be negative dB
            maxAttackCompressionDiffDb_ = -1.0f;
            if (std::isnan(compressionDiffDb) || std::isinf(compressionDiffDb))
                compressionDiffDb = -1.0f;
            // Adaptive release - higher compression (lower compressionDiffDb) releases faster.
            // Contain within range: -12 -> 0 then scale to go from 0 -> 3
            float x = compressionDiffDb;
            x = std::clamp(x, -12.0f, 0.0f);
            x = 0.25f * (x + 12.0f);
            // Compute adaptive release curve using 4th order polynomial.
            const float x2 = x * x;
            const float x3 = x2 * x;
            const float x4 = x2 * x2;
            const float relFrames = kA + kB * x + kC * x2 + kD * x3 + kE * x4;
            const float kSpacingDb = 5.0f;
            const float dbPerFrame = kSpacingDb / relFrames;
            envelopeRate = decibelsToLinear(dbPerFrame);
        }
        else
        {
            // Attack mode - compressionDiffDb should be positive dB
            if (std::isnan(compressionDiffDb) || std::isinf(compressionDiffDb))
                compressionDiffDb = 1.0f;
            // As long as we're still in attack mode, use a rate based off the largest compressionDiffDb we've
            // encountered so far.
            if (maxAttackCompressionDiffDb_ == -1.0f || maxAttackCompressionDiffDb_ < compressionDiffDb)
                maxAttackCompressionDiffDb_ = compressionDiffDb;
            const float effAttenDiffDb = std::max(0.5f, maxAttackCompressionDiffDb_);
            const float x = 0.25f / effAttenDiffDb;
            envelopeRate = 1.0f - std::pow(x, 1.0f / attackFrames);
        }

        // Inner loop - calculate shaped power average - apply compression.
        int preDelayReadIndex = preDelayReadIndex_;
        int preDelayWriteIndex = preDelayWriteIndex_;
        float detectorAverage = detectorAverage_;
        float compressorGain = compressorGain_;
        for (int f = 0; f < loopFrames; ++f)
        {
            float compressorInput = 0.0f;
            // Predelay signal, computing compression amount from un-delayed version.
            for (int c = 0; c < numChannels; ++c)
            {
                float* delayBuffer = preDelayBuffers_[c];
                const float undelayedSource = static_cast<float>(src[c][frameIndex]);
                delayBuffer[preDelayWriteIndex] = undelayedSource;
                const float absUndelayedSource = undelayedSource > 0.0f ? undelayedSource : -undelayedSource;
                if (compressorInput < absUndelayedSource)
                    compressorInput = absUndelayedSource;
            }
            // Calculate shaped power on undelayed input.
            const float scaledInput = compressorInput;
            const float absInput = scaledInput > 0.0f ? scaledInput : -scaledInput;
            // Put through shaping curve. This is linear up to the threshold, then enters a "knee" portion followed
            // by the "ratio" portion. Both transitions are smooth (1st derivative matched).
            const float shapedInput = saturate(absInput, k);
            const float attenuation = absInput <= 0.0001f ? 1.0f : shapedInput / absInput;
            float attenuationDb = -linearToDecibels(attenuation);
            attenuationDb = std::max(2.0f, attenuationDb);
            const float dbPerFrame = attenuationDb / satReleaseFrames;
            const float satReleaseRate = decibelsToLinear(dbPerFrame) - 1.0f;
            const bool isRelease = attenuation > detectorAverage;
            const float rate = isRelease ? satReleaseRate : 1.0f;
            detectorAverage += (attenuation - detectorAverage) * rate;
            detectorAverage = std::min(1.0f, detectorAverage);
            if (std::isnan(detectorAverage) || std::isinf(detectorAverage))
                detectorAverage = 1.0f;
            // Exponential approach to desired gain.
            if (envelopeRate < 1.0f)
            {
                // Attack - reduce gain to desired.
                compressorGain += (scaledDesiredGain - compressorGain) * envelopeRate;
            }
            else
            {
                // Release - exponentially increase gain to 1.0
                compressorGain *= envelopeRate;
                compressorGain = std::min(1.0f, compressorGain);
            }
            // Warp pre-compression gain to smooth out sharp exponential transition points.
            const float postWarpCompressorGain = std::sin(kPiOverTwo * compressorGain);
            // Calculate total gain using master gain and effect blend.
            const float totalGain = dryMix + wetMix * masterLinearGain * postWarpCompressorGain;
            // Calculate metering.
            const float dbRealGain = 20.0f * std::log10(postWarpCompressorGain);
            if (dbRealGain < meteringGain_)
                meteringGain_ = dbRealGain;
            else
                meteringGain_ += (dbRealGain - meteringGain_) * meteringReleaseK_;
            // Apply final gain.
            for (int c = 0; c < numChannels; ++c)
            {
                const float* delayBuffer = preDelayBuffers_[c];
                dst[c][frameIndex] = static_cast<double>(delayBuffer[preDelayReadIndex] * totalGain);
            }
            frameIndex++;
            preDelayReadIndex = (preDelayReadIndex + 1) & kMaxPreDelayFramesMask;
            preDelayWriteIndex = (preDelayWriteIndex + 1) & kMaxPreDelayFramesMask;
        }
        // Locals back to member variables.
        preDelayReadIndex_ = preDelayReadIndex;
        preDelayWriteIndex_ = preDelayWriteIndex;
        detectorAverage_ = flushDenormal(detectorAverage);
        compressorGain_ = flushDenormal(compressorGain);
    }
}

// ---- COMP --------------------------------------------------------------------------------------------------

namespace
{
struct CompPreset
{
    float threshold, ratio, attack, release, makeup, mix;
};
constexpr CompPreset kCompPresets[] = {
    {0.0f, 1.0f, 10.0f, 150.0f, 0.0f, 1.0f},   // OFF
    {-18.0f, 2.0f, 30.0f, 200.0f, 2.0f, 1.0f}, // LIGHT
    {-20.0f, 4.0f, 10.0f, 80.0f, 4.0f, 1.0f},  // PUNCHY
    {-32.0f, 8.0f, 1.0f, 50.0f, 6.0f, 0.5f},   // NY-PARALLEL
    {-28.0f, 12.0f, 1.0f, 30.0f, 8.0f, 1.0f},  // AGGRESSIVE
};
constexpr float kCompKnee = 6.0f;
constexpr float kCompPreDelay = 0.006f;
} // namespace

void CompFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    kernel_.prepare(static_cast<float>(sampleRate));
    dryL_.prepare(BlinkCompressorKernel::kMaxPreDelayFrames + 1);
    dryR_.prepare(BlinkCompressorKernel::kMaxPreDelayFrames + 1);
    reset();
}
void CompFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    kernel_.reset();
    kernel_.setPreDelayTime(kCompPreDelay);
    dryL_.reset();
    dryR_.reset();
    style_ = 2;
    setParam(0, 2.0f, true);
}
void CompFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
    {
        style_ = static_cast<int>(clampf(std::floor(value), 0.0f, 4.0f));
        const auto& p = kCompPresets[style_];
        threshold_.set(p.threshold, immediate);
        ratio_.set(p.ratio, immediate);
        attack_.set(p.attack, immediate);
        release_.set(p.release, immediate);
        makeup_.set(p.makeup, immediate);
        mix_ = p.mix;
        break;
    }
    case 1:
        threshold_.set(clampf(value, -100.0f, 0.0f), immediate);
        break;
    case 2:
        ratio_.set(clampf(value, 1.0f, 20.0f), immediate);
        break;
    case 3:
        attack_.set(clampf(value, 0.0f, 1000.0f), immediate);
        break;
    case 4:
        release_.set(clampf(value, 0.0f, 1000.0f), immediate);
        break;
    case 5:
        makeup_.set(clampf(value, 0.0f, 24.0f), immediate);
        break;
    default:
        break;
    }
}
float CompFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return static_cast<float>(style_);
    case 1:
        return threshold_.target;
    case 2:
        return ratio_.target;
    case 3:
        return attack_.target;
    case 4:
        return release_.target;
    case 5:
        return makeup_.target;
    default:
        return 0.0f;
    }
}
void CompFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    // k-rate like the node: the block's END values of the glides
    const float thr = threshold_.advance(n, sr_, kFxTau);
    const float ratio = ratio_.advance(n, sr_, kFxTau);
    const float atk = attack_.advance(n, sr_, kFxTau) * 0.001f;
    const float rel = release_.advance(n, sr_, kFxTau) * 0.001f;
    const double mkS = std::pow(10.0, static_cast<double>(makeup_.cur) / 20.0);
    const double mkE = std::pow(10.0, static_cast<double>(makeup_.advance(n, sr_, kFxTau)) / 20.0);
    const int pre = kernel_.preDelayFrames();
    const double m = static_cast<double>(mix_), d = 1.0 - m;
    // the dry leg, delayed by the look-ahead (only read when blending)
    for (int i = 0; i < n; ++i)
    {
        dryL_.write(l[i]);
        dryR_.write(r[i]);
    }
    const double* src[2] = {l, r};
    double* dst[2] = {l, r};
    kernel_.process(src, dst, 2, n, thr, kCompKnee, ratio, atk, rel, kCompPreDelay, 0.0f, 1.0f, 0.09f, 0.16f, 0.42f,
                    0.98f);
    const double invN = 1.0 / static_cast<double>(std::max(1, n));
    for (int i = 0; i < n; ++i)
    {
        const double mk = mkS + (mkE - mkS) * static_cast<double>(i) * invN;
        double wl = l[i] * mk, wr = r[i] * mk;
        if (m < 1.0)
        {
            // the dry leg written this block sits at taps (n − i) … so x[i] is at tap (n − i); the delayed dry =
            // tap (n − i + pre)
            wl = wl * m + dryL_.tap(n - i + pre) * d;
            wr = wr * m + dryR_.tap(n - i + pre) * d;
        }
        l[i] = wl;
        r[i] = wr;
    }
}

// ---- SC COMP -----------------------------------------------------------------------------------------------

void SidechainFx::prepare(double sampleRate, int /*maxBlockSize*/)
{
    sr_ = sampleRate;
    reset();
}
void SidechainFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    source_ = -1;
    thresh_.set(-24.0f, true);
    ratio_.set(4.0f, true);
    attack_.set(5.0f, true);
    release_.set(120.0f, true);
    hold_.set(0.0f, true);
    makeup_.set(0.0f, true);
    keyHp_.set(20.0f, true);
    hpL_.reset();
    hpR_.reset();
    hpL_.set(Biquad::Type::highpass, 20.0, -3.0103, 0.0, sr_);
    hpR_.set(Biquad::Type::highpass, 20.0, -3.0103, 0.0, sr_);
    keyL_ = keyR_ = nullptr;
    gr_ = 0.0;
    holdLeft_ = 0;
    minGr_ = 0.0f;
}
void SidechainFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        source_ = value < -0.5f ? -1 : static_cast<int>(clampf(std::floor(value + 0.5f), 0.0f, 63.0f));
        break;
    case 1:
        thresh_.set(clampf(value, -60.0f, 0.0f), immediate);
        break;
    case 2:
        ratio_.set(clampf(value, 1.0f, 20.0f), immediate);
        break;
    case 3:
        attack_.set(clampf(value, 0.1f, 500.0f), immediate);
        break;
    case 4:
        release_.set(clampf(value, 5.0f, 2000.0f), immediate);
        break;
    case 5:
        hold_.set(clampf(value, 0.0f, 1000.0f), immediate);
        break;
    case 6:
        makeup_.set(clampf(value, 0.0f, 24.0f), immediate);
        break;
    case 7:
        keyHp_.set(clampf(value, 20.0f, 500.0f), immediate);
        if (immediate)
        {
            hpL_.set(Biquad::Type::highpass, static_cast<double>(keyHp_.cur), -3.0103, 0.0, sr_);
            hpR_.set(Biquad::Type::highpass, static_cast<double>(keyHp_.cur), -3.0103, 0.0, sr_);
        }
        break;
    default:
        break;
    }
}
float SidechainFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return static_cast<float>(source_);
    case 1:
        return thresh_.target;
    case 2:
        return ratio_.target;
    case 3:
        return attack_.target;
    case 4:
        return release_.target;
    case 5:
        return hold_.target;
    case 6:
        return makeup_.target;
    case 7:
        return keyHp_.target;
    default:
        return 0.0f;
    }
}
void SidechainFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    // k-rate (the worklet's): the block's end values
    const double thr = static_cast<double>(thresh_.advance(n, sr_, kFxTau));
    const double ratio = static_cast<double>(ratio_.advance(n, sr_, kFxTau));
    const double atk = std::max(0.0001, static_cast<double>(attack_.advance(n, sr_, kFxTau)) * 0.001);
    const double rel = std::max(0.001, static_cast<double>(release_.advance(n, sr_, kFxTau)) * 0.001);
    const double holdSec = static_cast<double>(hold_.advance(n, sr_, kFxTau)) * 0.001;
    const double makeupLin = std::pow(10.0, static_cast<double>(makeup_.advance(n, sr_, kFxTau)) / 20.0);
    if (keyHp_.moving())
    {
        keyHp_.advance(n, sr_, kFxTau);
        hpL_.set(Biquad::Type::highpass, static_cast<double>(keyHp_.cur), -3.0103, 0.0, sr_);
        hpR_.set(Biquad::Type::highpass, static_cast<double>(keyHp_.cur), -3.0103, 0.0, sr_);
    }
    const double knee = 6.0, halfKnee = 3.0;
    const double aCoef = 1.0 - std::exp(-1.0 / (atk * sr_));
    const double rCoef = 1.0 - std::exp(-1.0 / (rel * sr_));
    const int holdSamples = static_cast<int>(std::lround(holdSec * sr_));
    const double slope = 1.0 / ratio - 1.0; // dB of GR per dB over threshold (negative)
    const double* kl = keyL_;
    const double* kr = keyR_ != nullptr ? keyR_ : keyL_;
    double gr = gr_;
    int holdLeft = holdLeft_;
    double minGr = 0.0;
    for (int i = 0; i < n; ++i)
    {
        double target = 0.0;
        if (kl != nullptr)
        {
            const double a = std::abs(hpL_.process(kl[i]));
            const double b = std::abs(hpR_.process(kr[i]));
            const double lvl = a > b ? a : b;
            const double db = 20.0 * std::log10(lvl + 1e-9);
            const double over = db - thr;
            if (over > -halfKnee)
                target =
                    (over < halfKnee) ? slope * ((over + halfKnee) * (over + halfKnee)) / (2.0 * knee) : slope * over;
        }
        if (target < gr)
        {
            gr += aCoef * (target - gr);
            holdLeft = holdSamples;
        }
        else if (holdLeft > 0)
            holdLeft--;
        else
            gr += rCoef * (target - gr);
        if (gr < minGr)
            minGr = gr;
        const double g = std::pow(10.0, gr / 20.0) * makeupLin;
        l[i] *= g;
        r[i] *= g;
    }
    gr_ = gr;
    holdLeft_ = holdLeft;
    minGr_ = static_cast<float>(minGr);
    keyL_ = keyR_ = nullptr; // the key is per block
}

} // namespace terminator
