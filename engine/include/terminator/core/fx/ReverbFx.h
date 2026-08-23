#pragma once
// REVERB (Phase 4.2b) — the page's ReverbFX: ConvolverNode(normalize = true) on a procedurally generated stereo IR
// (the seeded LCG, the onset ramp, the √-frac air absorption, −60 dB at DECAY), A/B swapped with a 60 ms crossfade
// when ROOM / DECAY change; a PREDELAY DelayNode in front; WET blended by the chain.
//
// Natively the convolution is a zero-latency non-uniform partitioned scheme on the audio thread: a 128-tap direct
// head, then 128-sample partitions to lag 512, 512-sample partitions to lag 8192, and 4096-sample partitions for
// the rest with a whole partition of lead (their multiply-accumulate is sliced across the 32 ticks before the
// result is due, so a 10 s tail never spikes the callback). The IR is generated and its partitions transformed
// INCREMENTALLY on the audio thread too (a bounded budget per block, every buffer pre-sized for DECAY 10 s at the
// rate; the first IR of a fresh insert lands within ~0.3 s and a ROOM / DECAY move rebuilds into the idle slot,
// then crossfades) — the core stays JUCE-free and headless-testable. Blink's normalisation is reproduced exactly:
// scale = 10^(−58/20) / rms(IR) · 44100 / sr.
#include <cstdint>
#include <memory>
#include <vector>

#include "terminator/core/fx/Effect.h"
#include "terminator/core/fx/FxDsp.h"

namespace terminator
{

class ReverbFx final : public Effect
{
  public:
    static constexpr int kHead = 128;
    static constexpr int kP1 = 128, kK1 = 3;  // lags [128, 512)
    static constexpr int kP2 = 512, kK2 = 15; // lags [512, 8192)
    static constexpr int kP3 = 4096;          // lags [8192, L), one partition of lead
    static constexpr int kO3 = 2 * kP3;
    static constexpr double kMaxDecaySec = 10.0;
    static constexpr double kFadeSec = 0.06;
    static constexpr std::uint32_t kSeed = 0x9e3779b9u;

    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::reverb; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

    // --- read-back (tests) ---
    /// True once an IR is active and no rebuild is pending / running.
    bool ready() const noexcept
    {
        return active_ >= 0 && !dirty_ && stage_ == Stage::idle && fadeLeft_ == 0 && pending_ < 0;
    }
    bool building() const noexcept { return stage_ != Stage::idle; }
    int irLength() const noexcept { return active_ >= 0 ? slot_[active_].len : 0; }
    float irScale() const noexcept { return active_ >= 0 ? slot_[active_].scale : 0.0f; }
    /// The page's generator (one channel after the other from one seed stream), for gates: out[c][0..len).
    static int generateIr(double room01, double decaySec, double sampleRate, float* outL, float* outR,
                          int capacity) noexcept;
    /// Blink's normalisation scale for a 2-channel response of `len` samples with total power Σx².
    static float normalisationScale(double sumSquares, int len, double sampleRate) noexcept;

  private:
    enum class Stage : std::uint8_t
    {
        idle,
        gen,
        small,
        tier3
    };
    struct Slot
    {
        int len = 0, k1 = 0, k2 = 0, k3 = 0;
        float scale = 0.0f;
        // the head taps + the small tiers' spectra (zeroed; small)
        std::vector<double> head;    // 2 × kHead
        std::vector<float> h1, h2;   // 2 × kK1 × (kP1+1) × 2, 2 × kK2 × (kP2+1) × 2
        std::unique_ptr<float[]> h3; // 2 × k3max × (kP3+1) × 2 (uninitialised — written by the build)
        std::vector<double> tail1, tail2, tail3, tail3Next; // 2 × P each (the tier outputs for the coming block)
        std::vector<double> acc;                            // the tier-3 job's accumulator: 2 × (kP3+1) × 2
        int jobDone = 0;                                    // partitions accumulated so far in the running tier-3 job
        bool jobOpen = false;
    };
    void startBuild() noexcept TERMINATOR_NONBLOCKING;
    void buildStep(int n) noexcept TERMINATOR_NONBLOCKING;
    void transformPartition(const float* ir, int len, int start, int P, float* outHalf,
                            float scale) noexcept TERMINATOR_NONBLOCKING;
    void forwardInput(int c, int P, float* outHalf) noexcept TERMINATOR_NONBLOCKING;
    void smallTierStep(int c, int P, int K, int kMax, const float* fdl, int fdlPos, int fdlCount, const float* h,
                       double* tail) noexcept TERMINATOR_NONBLOCKING;
    void tier3Begin() noexcept TERMINATOR_NONBLOCKING;
    void tier3Slice(Slot& s) noexcept TERMINATOR_NONBLOCKING;
    void tier3Finish(Slot& s) noexcept TERMINATOR_NONBLOCKING;
    double rnd() noexcept TERMINATOR_NONBLOCKING
    {
        seed_ = seed_ * 1664525u + 1013904223u;
        return static_cast<double>(seed_) / 4294967296.0 * 2.0 - 1.0;
    }
    const Fft& fftFor(int P) const noexcept TERMINATOR_NONBLOCKING
    {
        return P == kP1 ? fft1_ : (P == kP2 ? fft2_ : fft3_);
    }

    double sr_ = 48000.0;
    int maxBlock_ = 0;
    int maxIr_ = 0, k3Max_ = 0;
    Glide pre_; // seconds
    float room_ = 50.0f, decay_ = 2.0f, wet_ = 30.0f;
    DelayLine preL_, preR_;
    // the input history (both channels): the last 2·kP3 samples
    std::vector<double> hist_; // 2 × kHistSize
    std::uint64_t pos_ = 0;
    // the shared frequency-delay lines (one per tier, both channels)
    std::vector<float> fdl1_, fdl2_; // 2 × kK1 × (kP1+1) × 2 ; 2 × kK2 × (kP2+1) × 2
    std::unique_ptr<float[]> fdl3_;  // 2 × k3max × (kP3+1) × 2
    int fdl1Pos_ = 0, fdl2Pos_ = 0, fdl3Pos_ = 0;
    int fdl1Count_ = 0, fdl2Count_ = 0, fdl3Count_ = 0;
    Fft fft1_, fft2_, fft3_;
    std::vector<double> re_, im_; // 2·kP3 work
    Slot slot_[2];
    int active_ = -1;  // the slot heard (or fading in)
    int fading_ = -1;  // the slot fading out (−1 = none)
    int pending_ = -1; // a freshly built slot waiting for a tier-3 boundary to arm (its first big-tier job), then
                       // the next one to be promoted (so its long tail is complete from its first heard sample)
    bool pendingArmed_ = false;
    int fadeLeft_ = 0, fadeLen_ = 1;
    // the incremental build
    Stage stage_ = Stage::idle;
    bool dirty_ = false;
    int buildSlot_ = -1;
    std::unique_ptr<float[]> irTime_; // 2 × maxIr (uninitialised)
    std::uint32_t seed_ = kSeed;
    int genPos_ = 0;
    double genY_ = 0.0, power_ = 0.0;
    double bRoom_ = 0.5, bDecay_ = 2.0;
    int bLen_ = 0, bBuildUp_ = 1;
    double bFcStart_ = 0.0, bK_ = 0.0;
    int partPos_ = 0; // the next tier-3 partition to transform (channel-major: c·k3 + k)
};

} // namespace terminator
