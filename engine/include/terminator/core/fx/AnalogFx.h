#pragma once
// The PREMIUM analog-modelled devices (Phase 4.6 — B4 "VICTOR'S PHASE-4 BRIEF"). These are NOT parity ports: the
// 4.2 devices stay exactly as they are so old projects load and sound the same, and these are new stock devices
// that only exist natively (the page's Web Audio twin is a documented pass-through — nothing on the page is heard
// in the shell).
//
//   · LadderFx — ANALOG FILTER: the Moog transistor ladder (D'Angelo–Välimäki nonlinear model, the same equations
//     the BASS synth's LADDER uses, deliberately its own copy: this one runs 4× oversampled with an IIR decimator,
//     mixes the stage taps for the 6/12/18/24 dB LP · 12/24 dB HP · 12/24 dB BP modes, has its own DRIVE stage with
//     auto-gain, and self-oscillates from an analog noise floor. Changing it must never change how a bass patch
//     sounds, which a shared class could not promise.)
#include <cstdint>

#include "terminator/core/fx/Effect.h"

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
