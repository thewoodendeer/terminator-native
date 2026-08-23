#pragma once
// The 4×-oversampled shapers (Phase 4.2b) — the page's ClipFX / WaveFX / SatFX / MbSatFX ported 1:1: the same
// curves evaluated analytically (the WaveShaper's curve domain is [−1, 1] — anything past it takes the endpoint,
// so every curve here clamps its input the same way), run at 4× through core/fx/FxDsp.h's Oversampler4x (two
// polyphase halfband stages; the cascade's group delay = latencySamples(), the PDC plan reads it). A drive change
// glides (τ 10 ms) instead of the page's instant curve swap — same curve at rest, no zipper on the way.
#include <vector>

#include "terminator/core/fx/Effect.h"
#include "terminator/core/fx/FxDsp.h"

namespace terminator
{

/// One stereo 4× path: up → f(x) per 4× sample → down. `f` gets the 4× sample and the BASE sample index (for a
/// per-sample drive).
class OversampledShaper
{
  public:
    void prepare(int maxBlockSize);
    void reset() noexcept TERMINATOR_NONBLOCKING;
    template <class F> void process(double* l, double* r, int n, F&& f) noexcept TERMINATOR_NONBLOCKING
    {
        if (n > maxBlock_)
            n = maxBlock_;
        double* s = s4_.data();
        osL_.up(l, s, n);
        for (int i = 0; i < n; ++i)
            for (int k = 0; k < 4; ++k)
                s[4 * i + k] = f(s[4 * i + k], i);
        osL_.down(s, l, n);
        osR_.up(r, s, n);
        for (int i = 0; i < n; ++i)
            for (int k = 0; k < 4; ++k)
                s[4 * i + k] = f(s[4 * i + k], i);
        osR_.down(s, r, n);
    }
    static int latencySamples() noexcept { return Oversampler4x::latencySamples(); }

  private:
    Oversampler4x osL_, osR_;
    std::vector<double> s4_;
    int maxBlock_ = 0;
};

/// CLIP — AMT 0..100: the soft knee threshold t = 1 − 0.9·amt; past it y = t + o/(1+(o/d)²), o = |x|−t, d = 1−t;
/// ceiling 0.9886 (−0.1 dBFS — even at AMT 0 the curve tops out there).
class ClipFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::clip; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    int latencySamples() const noexcept TERMINATOR_NONBLOCKING override { return OversampledShaper::latencySamples(); }
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;
    static double curve(double x, double amt01) noexcept TERMINATOR_NONBLOCKING;

  private:
    double sr_ = 48000.0;
    Glide amt_; // 0..100
    OversampledShaper os_;
};

/// WAVE — DRIVE 0..100: tanh(k·x)/tanh(k), k = 1 + 24·drive.
class WaveFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::wave; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    int latencySamples() const noexcept TERMINATOR_NONBLOCKING override { return OversampledShaper::latencySamples(); }
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;
    static double curve(double x, double drive01) noexcept TERMINATOR_NONBLOCKING;

  private:
    double sr_ = 48000.0;
    Glide drive_; // 0..100
    OversampledShaper os_;
};

/// SAT — DRIVE 0..100: the Doidic curve y = (3x/2)(1 − x²/3) on x pre-gained by g = 1 + 2·drive, clamped ±1
/// (note the +3.5 dB small-signal gain of the curve itself at DRIVE 0 — the page's).
class SatFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::sat; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    int latencySamples() const noexcept TERMINATOR_NONBLOCKING override { return OversampledShaper::latencySamples(); }
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;
    /// The Doidic tape curve on x·g (clamped ±1) — shared with VINYL.
    static double doidic(double x, double g) noexcept TERMINATOR_NONBLOCKING;

  private:
    double sr_ = 48000.0;
    Glide drive_; // 0..100
    OversampledShaper os_;
};

/// MB SAT — LOW / MID / HIGH drive 0..100 per band, LO_X 40..2000, HI_X 500..16000 (forced ≥ 1.5·LO_X), WET
/// 0..100. Linkwitz-Riley 4th-order crossovers (two cascaded Butterworth biquads, Q −3.0103 dB in the Web Audio
/// LP/HP convention); the low band gets AP(HI_X, Q 1/√2) so the three bands sum flat; each band runs
/// tanh(a·X)/a, X = clamp(band, ±4) (the ¼ pre-gain into the ±4 curve), a = 4·drive, makeup √(1 + 4·drive). The
/// dry leg matches the wet one (AP(LO_X)·AP(HI_X), the ±4 clamp, the oversampler's delay) and the device blends
/// WET itself — the chain runs it fully wet (info().wetParam = −1).
class MbSatFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::mbsat; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    int latencySamples() const noexcept TERMINATOR_NONBLOCKING override { return OversampledShaper::latencySamples(); }
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double sr_ = 48000.0;
    int maxBlock_ = 0;
    Glide drive_[3];     // 0..100
    Glide loX_, hiX_;    // Hz (the targets are the raw params; the HI_X floor applies in recompute)
    float wet_ = 100.0f; // the TS sets the mix gains directly
    // crossovers per channel: [ch][…]
    Biquad lowLp1_[2], lowLp2_[2], lowAp_[2], restHp1_[2], restHp2_[2], midLp1_[2], midLp2_[2], highHp1_[2],
        highHp2_[2], dryAp1_[2], dryAp2_[2];
    OversampledShaper band_[3];
    DelayLine dryL_, dryR_;
    std::vector<double> bL_[3], bR_[3]; // the three bands, base rate
};

} // namespace terminator
