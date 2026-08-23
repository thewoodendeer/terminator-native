#pragma once
// The dynamics devices (Phase 4.2b): COMP = the page's CompFX on a port of Blink's DynamicsCompressorKernel (the
// WebKit/Chromium DynamicsCompressorNode: the knee curve + k solver, the adaptive release polynomial, the 6 ms
// pre-delay look-ahead = latencySamples(), the perceptual auto-makeup, the sin() gain warp, the metering) — the
// "exact limiter" semantics the dossier asks to preserve; SC COMP = the page's sc-comp worklet (a compressor keyed
// from ANOTHER strip's INPUT through the chain's sidechain hooks).
#include "terminator/core/fx/Effect.h"
#include "terminator/core/fx/FxDsp.h"

namespace terminator
{

/// Blink's DynamicsCompressorKernel, in float like the original (the audio is double at the edges).
class BlinkCompressorKernel
{
  public:
    static constexpr int kMaxPreDelayFrames = 1024;
    static constexpr int kMaxPreDelayFramesMask = kMaxPreDelayFrames - 1;
    static constexpr int kDefaultPreDelayFrames = 256;
    static constexpr int kDivisionFrames = 32;

    void prepare(float sampleRate) noexcept;
    void reset() noexcept TERMINATOR_NONBLOCKING;
    void setPreDelayTime(float preDelaySec) noexcept TERMINATOR_NONBLOCKING;
    int preDelayFrames() const noexcept TERMINATOR_NONBLOCKING { return lastPreDelayFrames_; }
    /// In place allowed (src == dst). 1 or 2 channels.
    void process(const double* const* src, double* const* dst, int numChannels, int frames, float dbThreshold,
                 float dbKnee, float ratio, float attackTime, float releaseTime, float preDelayTime, float dbPostGain,
                 float effectBlend, float releaseZone1, float releaseZone2, float releaseZone3,
                 float releaseZone4) noexcept TERMINATOR_NONBLOCKING;
    /// The node's `reduction` (dB, ≤ 0).
    float meteringGainDb() const noexcept TERMINATOR_NONBLOCKING { return meteringGain_; }

  private:
    float kneeCurve(float x, float k) const noexcept TERMINATOR_NONBLOCKING;
    float saturate(float x, float k) const noexcept TERMINATOR_NONBLOCKING;
    float slopeAt(float x, float k) const noexcept TERMINATOR_NONBLOCKING;
    float kAtSlope(float desiredSlope) const noexcept TERMINATOR_NONBLOCKING;
    float updateStaticCurveParameters(float dbThreshold, float dbKnee, float ratio) noexcept TERMINATOR_NONBLOCKING;

    float sampleRate_ = 48000.0f;
    float detectorAverage_ = 0.0f;
    float compressorGain_ = 1.0f;
    float meteringReleaseK_ = 0.0f;
    float meteringGain_ = 1.0f;
    float preDelayBuffers_[2][kMaxPreDelayFrames] = {};
    int lastPreDelayFrames_ = kDefaultPreDelayFrames;
    int preDelayReadIndex_ = 0;
    int preDelayWriteIndex_ = kDefaultPreDelayFrames;
    float maxAttackCompressionDiffDb_ = -1.0f;
    // the static curve
    float ratio_ = -1.0f, slope_ = -1.0f, linearThreshold_ = -1.0f, dbThreshold_ = -1.0f, dbKnee_ = -1.0f,
          kneeThreshold_ = -1.0f, kneeThresholdDb_ = -1.0f, ykneeThresholdDb_ = -1.0f, K_ = -1.0f;
};

/// COMP — STYLE {OFF, LIGHT, PUNCHY, NY-PARALLEL, AGGRESSIVE} (picking one sets the five knobs to its preset and
/// the blend: NY-PARALLEL = 50 % dry, the dry leg delayed by the look-ahead) · THRESHOLD −60..0 · RATIO 1..20 ·
/// ATTACK 0.1..100 ms · RELEASE 10..1000 ms · MAKEUP 0..24 dB (all τ 10 ms; knee 6). The chain runs it fully wet
/// (info().wetParam = −1) — the device blends internally with its latency-matched dry leg.
class CompFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::comp; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    int latencySamples() const noexcept TERMINATOR_NONBLOCKING override { return kernel_.preDelayFrames(); }
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;
    float gainReductionDb() const noexcept TERMINATOR_NONBLOCKING override { return kernel_.meteringGainDb(); }

  private:
    double sr_ = 48000.0;
    int style_ = 2;
    Glide threshold_, ratio_, attack_, release_, makeup_; // dB, ×, ms, ms, dB
    float mix_ = 1.0f;
    BlinkCompressorKernel kernel_;
    DelayLine dryL_, dryR_;
};

/// SC COMP — SOURCE (the key strip's index, −1 = NONE) · THRESH −60..0 · RATIO 1..20 · ATTACK 0.1..100 ms · RELEASE
/// 5..1000 ms · HOLD 0..500 ms · MAKEUP 0..24 dB · KEYHP 20..500 Hz. The key = the source strip's pre-insert INPUT
/// (the chain hands it in through setSidechainKey before process()), high-passed (Butterworth, Q −3.0103 dB); the
/// detector is the worklet's: rectified peak → soft knee (6 dB) in dB → attack / hold / release on the GR → gain.
/// Zero latency. No key = clean pass.
class SidechainFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::sccomp; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    int sidechainSource() const noexcept TERMINATOR_NONBLOCKING override { return source_; }
    void setSidechainKey(const double* l, const double* r) noexcept TERMINATOR_NONBLOCKING override
    {
        keyL_ = l;
        keyR_ = r;
    }
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;
    /// The deepest gain reduction (dB, ≤ 0) in the last block — the panel meter.
    float gainReductionDb() const noexcept TERMINATOR_NONBLOCKING override { return minGr_; }

  private:
    double sr_ = 48000.0;
    int source_ = -1;
    Glide thresh_, ratio_, attack_, release_, hold_, makeup_, keyHp_; // dB, ×, ms, ms, ms, dB, Hz
    Biquad hpL_, hpR_;
    const double* keyL_ = nullptr;
    const double* keyR_ = nullptr;
    double gr_ = 0.0; // dB ≤ 0
    int holdLeft_ = 0;
    float minGr_ = 0.0f;
};

} // namespace terminator
