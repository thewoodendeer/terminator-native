#pragma once
// The delay-line / modulation devices (Phase 4.2b) — the page's DelayFX / PhaserFX / FlangerFX / VinylFX ported.
// Every delay read is the DelayNode's linear interpolation; every LFO is the OscillatorNode's shape from phase 0 at
// insert; the glides are the page's (τ 10 ms on delay times / feedback gains, 20 ms on the LFO params, 50 ms on the
// VINYL wow / flutter). Two page quirks are NOT carried (flagged in STATUS): the PHASER's feedback ran through a
// one-render-quantum DelayNode (128 frames — a Web Audio cycle rule) — here it is one sample, the device's intent;
// and the DELAY's dual-mono mode here IS dual mono (the page's ChannelMerger inputs downmix each line to mono).
#include <vector>

#include "terminator/core/fx/Effect.h"
#include "terminator/core/fx/FxDsp.h"

namespace terminator
{

/// DELAY — TIME 1..2000 ms (the R line = min(2 s, 1.02·TIME)) · FEEDBACK 0..95 % · WET 0..100 (the chain blends) ·
/// PINGPONG 0/1. Each loop is damped (LP 7.5 kHz Q 0.5 dB → HP 90 Hz Q 0.5 dB on the feedback). PINGPONG: the
/// mono sum → L → R → feedback → L.
class DelayFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::delay; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    double sr_ = 48000.0;
    Glide time_, fb_; // seconds, linear
    float wet_ = 30.0f, pingpong_ = 0.0f;
    DelayLine lineL_, lineR_;
    Biquad lpL_, hpL_, lpR_, hpR_;
};

/// PHASER — RATE 0.02..10 Hz · DEPTH 0..100 % · CENTER 100..8000 Hz · FEEDBACK 0..90 % · STAGES {4,6,8,12} · WET
/// (the chain blends; 50 = the deepest notches). `n` 2nd-order allpasses (Q 0.6) in series, centres spread ±½ octave
/// (f_i = CENTER·2^(i/(n−1) − ½)), a sine LFO adding a linear Hz offset of min(DEPTH·CENTER·0.9, lowest − 40),
/// feedback from the last stage into the first (one sample). Coefficients update every 16 samples.
class PhaserFx final : public Effect
{
  public:
    static constexpr int kMaxStages = 12;
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::phaser; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute(double lfo) noexcept TERMINATOR_NONBLOCKING;
    double sr_ = 48000.0;
    Glide rate_, depth_, center_, fb_; // Hz, 0..1, Hz, linear
    int stagesIdx_ = 1;                // 0..3 → 4/6/8/12
    float wet_ = 50.0f;
    Biquad apL_[kMaxStages], apR_[kMaxStages];
    double phase_ = 0.0;
    double lastL_ = 0.0, lastR_ = 0.0; // the last stage's last output (the 1-sample feedback)
};

/// FLANGER — RATE 0.02..8 Hz · DEPTH 0..100 % · DELAY 0.3..12 ms · FEEDBACK −95..95 % · WET (the chain blends).
/// A triangle LFO sweeps the delay DELAY ± DEPTH·DELAY·0.9 (never under one sample); the feedback is damped
/// (LP 9 kHz Q 0.5 dB).
class FlangerFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::flanger; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    double sr_ = 48000.0;
    Glide rate_, base_, depthS_, fb_; // Hz, seconds, seconds, linear
    float depthPct_ = 60.0f, wet_ = 50.0f;
    DelayLine lineL_, lineR_;
    Biquad lpL_, lpR_;
    double phase_ = 0.0;
};

/// VINYL/TAPE — WARMTH · DRIVE · WOW · FLUTTER · AGE, 0..10 each: Doidic tape saturation (g = 1 + 0.3·DRIVE, 4×) →
/// LP (Q 0.3 dB, 20 kHz − 1.2 kHz·AGE) → HP 20 Hz → wow delay (4 ms ± 0.3 ms·WOW at 0.1 + 0.07·WOW Hz) → flutter
/// delay (1 ms ± 0.05 ms·FLUTTER at 3 + 0.5·FLUTTER Hz) → peaking 200 Hz Q 0.7, +2 + 0.4·WARMTH dB. latency = the
/// 5 ms of base delay + the oversampler's.
class VinylFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::vinyl; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    int latencySamples() const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double sr_ = 48000.0;
    Glide warmth_, drive_, wow_, flutter_, age_; // the raw 0..10 params
    std::vector<double> s4_;                     // 4 × maxBlock
    int maxBlock_ = 0;
    Oversampler4x osL_, osR_;
    Biquad lpL_, lpR_, hpL_, hpR_, warmL_, warmR_;
    DelayLine wowL_, wowR_, flutL_, flutR_;
    double wowPhase_ = 0.0, flutPhase_ = 0.0;
};

} // namespace terminator
