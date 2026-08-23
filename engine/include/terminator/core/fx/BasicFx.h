#pragma once
// The zero-latency mixer devices (Phase 4.2a) — the page's UtilityFX / EqFX / FilterFX / WideFX / MseqFX / PanFX
// ported 1:1 (same param ids / ranges / defaults / node topology; the Web Audio BiquadFilterNode maths in double).
#include "terminator/core/fx/Effect.h"

namespace terminator
{

/// UTILITY — GAIN −20..+20 dB (τ 10 ms) · MODE STEREO|MONO|MONO-L|MONO-R (instant re-patch) · PHASE normal|inverted.
class UtilityFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::utility; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    double sr_ = 48000.0;
    Glide gain_; // linear
    float mode_ = 0.0f, phase_ = 0.0f;
};

/// EQ — low shelf 80 Hz · peaking 1 kHz Q 0.8 · high shelf 12 kHz, each ±12 dB (τ 10 ms on the gains).
class EqFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::eq; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double sr_ = 48000.0;
    Glide low_, mid_, high_; // dB
    Biquad lowL_, lowR_, midL_, midR_, highL_, highR_;
};

/// FILTER — one biquad: TYPE lowpass|highpass|bandpass|notch · CUTOFF 20..20000 Hz · RESO → Q 0.0001..30 (both τ 10 ms;
/// Q is in dB for LP/HP, linear for BP/notch — the Web Audio convention).
class FilterFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::filter; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double sr_ = 48000.0;
    float type_ = 0.0f;
    Glide cutoff_, reso_;
    Biquad fL_, fR_;
};

/// WIDE — M/S width: WIDTH 0..200 (100 = as is), instant (the TS sets the gain value directly).
class WideFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::wide; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    float width_ = 100.0f;
};

/// M/S EQ — a peaking band (Q 1) on the Mid and one on the Side: MID_HZ/MID_DB/SIDE_HZ/SIDE_DB (τ 10 ms).
class MseqFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::mseq; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double sr_ = 48000.0;
    Glide midHz_, midDb_, sideHz_, sideDb_;
    Biquad mid_, side_;
};

/// PAN — a sine LFO (RATE 0.1..10 Hz, phase 0 at insert) × DEPTH 0..100 % drives the StereoPanner stereo law
/// (both τ 10 ms). Per-sample pan = per-sample law (as the AudioParam-driven panner).
class PanFx final : public Effect
{
  public:
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return FxType::pan; }
    void prepare(double sampleRate, int maxBlockSize) override;
    void reset() noexcept TERMINATOR_NONBLOCKING override;
    void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING override;
    float param(int index) const noexcept TERMINATOR_NONBLOCKING override;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING override;

  private:
    double sr_ = 48000.0;
    Glide rate_, depth_;
    double phase_ = 0.0; // 0..1
};

} // namespace terminator
