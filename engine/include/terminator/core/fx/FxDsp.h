#pragma once
// Shared DSP building blocks for the Phase 4.2b devices (JUCE-free, RT after prepare):
//   · Halfband2x / Oversampler4x — the WaveShaper's `oversample = '4x'` as two polyphase Kaiser-sinc halfband
//     stages (up: 1 → 2 → 4, the shaper runs at 4×, down: 4 → 2 → 1). The cascade's group delay is a WHOLE base
//     sample (the stage-2 halfband is padded by one zero so the two decimators read the right phase) and is
//     reported by latencySamples() — the page measured Blink's at 192 frames; ours is 55 and the PDC plan (4.4)
//     reads the number, never a constant.
//   · DelayLine — a fractional delay with the DelayNode's linear interpolation (Blink's DelayDSPKernel).
//   · lfo shapes — the OscillatorNode sine / triangle from phase 0.
//   · Fft — a radix-2 complex FFT in double (the reverb's partitioned convolution).
#include <cmath>
#include <cstdint>
#include <vector>

#include "terminator/core/RtAssert.h"

namespace terminator
{

/// One 2× halfband stage: `up` interpolates (one in → two out), `down` decimates (two in → one out). `center` = the
/// FIR's group delay in high-rate samples per pass (odd = a true halfband; even = the same halfband padded by one
/// zero, so a cascade's total delay lands on a whole base sample).
class Halfband2x
{
  public:
    static constexpr int kMaxCenter = 63;
    static constexpr int kRing = 64; // ≥ kMaxCenter/2 + 1 taps per phase
    /// Non-RT. Kaiser β sets the stopband (8 ≈ 80 dB). The side taps are scaled so the DC gain is exactly 1.
    void design(int center, double beta);
    void reset() noexcept TERMINATOR_NONBLOCKING;
    void up(double x, double& y0, double& y1) noexcept TERMINATOR_NONBLOCKING;
    double down(double v0, double v1) noexcept TERMINATOR_NONBLOCKING;
    int center() const noexcept { return c_; }

  private:
    // y[2n+p] = Σ_i ph[p][i] · x[n−i] (the interpolator, gain 2); the decimator uses the same taps × ½
    double ph0_[kRing] = {}, ph1_[kRing] = {};
    int len0_ = 0, len1_ = 0;
    int c_ = 0;
    double upHist_[kRing] = {};
    double evHist_[kRing] = {}, odHist_[kRing] = {};
    int upPos_ = 0, dnPos_ = 0;
};

/// 4× oversampling: stage 1 (base ↔ 2×) center 47 (95 taps, β 8), stage 2 (2× ↔ 4×) center 16 (31-tap halfband
/// padded, β 9). Total group delay = 47 + 16/2 = 55 base samples (asserted by the gate: an impulse lands there).
class Oversampler4x
{
  public:
    static constexpr int kStage1Center = 47;
    static constexpr int kStage2Center = 16;
    static constexpr int kLatency = kStage1Center + kStage2Center / 2;
    void prepare();
    void reset() noexcept TERMINATOR_NONBLOCKING;
    /// in[0..n) → out4[0..4n)
    void up(const double* in, double* out4, int n) noexcept TERMINATOR_NONBLOCKING;
    /// in4[0..4n) → out[0..n)
    void down(const double* in4, double* out, int n) noexcept TERMINATOR_NONBLOCKING;
    static int latencySamples() noexcept { return kLatency; }

  private:
    Halfband2x s1_, s2_;
};

/// A fractional delay line. `write` stores a sample at the head; `readAt(d)` = the sample d samples before the head
/// (d = 1 → the most recent write), linearly interpolated like the DelayNode. For a plain delay of D: write(x),
/// then readAt(D + 1) (= `process`). In a feedback loop: readAt(D) (D ≥ 1) BEFORE writing this sample's input.
class DelayLine
{
  public:
    void prepare(int maxDelaySamples); // non-RT
    void reset() noexcept TERMINATOR_NONBLOCKING;
    void write(double x) noexcept TERMINATOR_NONBLOCKING
    {
        buf_[static_cast<std::size_t>(head_)] = x;
        head_ = (head_ + 1) & mask_;
    }
    double readAt(double d) const noexcept TERMINATOR_NONBLOCKING
    {
        if (d < 1.0)
            d = 1.0;
        if (d > maxD_)
            d = maxD_;
        const double p = static_cast<double>(head_) - d;
        const double fl = std::floor(p);
        const double f = p - fl;
        const int i0 = static_cast<int>(fl) & mask_;
        const int i1 = (i0 + 1) & mask_;
        const double a = buf_[static_cast<std::size_t>(i0)], b = buf_[static_cast<std::size_t>(i1)];
        return a + f * (b - a);
    }
    /// Integer tap (d ≥ 1, exact).
    double tap(int d) const noexcept TERMINATOR_NONBLOCKING
    {
        return buf_[static_cast<std::size_t>((head_ - d) & mask_)];
    }
    double process(double x, double delaySamples) noexcept TERMINATOR_NONBLOCKING
    {
        write(x);
        return readAt(delaySamples + 1.0);
    }
    int maxDelay() const noexcept { return static_cast<int>(maxD_); }

  private:
    std::vector<double> buf_;
    int mask_ = 0;
    int head_ = 0;
    double maxD_ = 0.0;
};

/// An integer delay (the PDC lines): an exact-size ring of maxDelay + maxBlock doubles; delay 0 = a true pass-through.
class IntDelay
{
  public:
    void prepare(int maxDelaySamples, int maxBlockSize); // non-RT
    void reset() noexcept TERMINATOR_NONBLOCKING;
    /// In place: out[i] = in[i − delay] (delay clamped to [0, maxDelay]).
    void process(double* x, int numSamples, int delaySamples) noexcept TERMINATOR_NONBLOCKING;
    int maxDelay() const noexcept { return maxDelay_; }

  private:
    std::vector<double> buf_;
    int size_ = 0, head_ = 0, maxDelay_ = 0;
};

/// OscillatorNode shapes from phase φ ∈ [0, 1): sine starts at 0 rising; triangle starts at 0 rising (the
/// band-limiting of a sub-10 Hz LFO is moot).
inline double lfoSine(double phase) noexcept TERMINATOR_NONBLOCKING
{
    return std::sin(6.283185307179586476925 * phase);
}
inline double lfoTriangle(double phase) noexcept TERMINATOR_NONBLOCKING
{
    return phase < 0.25 ? 4.0 * phase : (phase < 0.75 ? 2.0 - 4.0 * phase : 4.0 * phase - 4.0);
}
inline double advancePhase(double phase, double hz, double sampleRate) noexcept TERMINATOR_NONBLOCKING
{
    phase += hz / sampleRate;
    return phase >= 1.0 ? phase - std::floor(phase) : phase;
}

/// A radix-2 complex FFT (in place, double). Sizes are powers of two ≤ 1 << 16. Non-RT prepare (twiddles); the
/// transforms are RT.
class Fft
{
  public:
    void prepare(int size); // non-RT
    int size() const noexcept { return n_; }
    /// re/im in place; `inverse` scales by 1/N.
    void transform(double* re, double* im, bool inverse) const noexcept TERMINATOR_NONBLOCKING;

  private:
    int n_ = 0, log2n_ = 0;
    std::vector<double> cosT_, sinT_;
    std::vector<std::uint32_t> rev_;
};

} // namespace terminator
