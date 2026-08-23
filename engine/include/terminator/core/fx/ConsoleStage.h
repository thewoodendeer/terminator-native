#pragma once
// CONSOLE (Phase 4.2c) — the page's analog-desk "separation" stage (`src/mixer/ConsoleStage.ts` + the `console-stage`
// worklet), ported 1:1: one stage per strip between its input and its insert chain (role CHANNEL, seeded by the
// strip's NAME — FNV-1a → mulberry32 → six tolerances in [−1, 1]) and one on the master (role BUS, zero tolerances).
// Per sample per channel: HPF (RBJ, Q 1/√2) → low shelf → high shelf → presence peak → 1-pole LPF → the bounded
// 2nd+3rd-order polynomial saturator (held flat past x0, no foldback) → a 5 Hz DC blocker (always in). Zero latency,
// no oversampling, unity small-signal gain (the page's gate: level-matched within 0.1 dB). The FLAVOURS table is the
// worklet's, AMOUNT (0..1) scales the drive and the EQ deviations and glides 1/1024 per frame (~23 ms).
#include <cstdint>

#include "terminator/core/RtAssert.h"

namespace terminator
{

enum class ConsoleFlavour : std::uint8_t
{
    ssl = 0,
    neve,
    api
};

class ConsoleStage
{
  public:
    /// The page's seed: FNV-1a (32-bit) of the strip name's UTF-16 code units (ASCII names = bytes).
    static std::uint32_t fnv1a(const char* name) noexcept;

    void prepare(double sampleRate); // non-RT
    /// RT: the role + the tolerances (channel: six mulberry32 draws from `seed`; bus: zeros); clears the state.
    void configure(bool bus, std::uint32_t seed) noexcept TERMINATOR_NONBLOCKING;
    /// RT: clear the filter / saturator state (the amount stays).
    void reset() noexcept TERMINATOR_NONBLOCKING;
    /// RT: flavour + amount 0..1; `immediate` snaps the amount (a stage switched on starts AT the setting).
    void set(ConsoleFlavour flavour, float amount01, bool immediate) noexcept TERMINATOR_NONBLOCKING;
    void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING;

    bool isBus() const noexcept { return bus_; }
    std::uint32_t seed() const noexcept { return seed_; }
    ConsoleFlavour flavour() const noexcept { return flavour_; }
    float amount() const noexcept { return amount_; }
    const double* tolerances() const noexcept { return tol_; }

  private:
    struct Biquad // the worklet's transposed direct form II
    {
        double c[5] = {1.0, 0.0, 0.0, 0.0, 0.0};
        double z1 = 0.0, z2 = 0.0;
        void identity() noexcept
        {
            c[0] = 1.0;
            c[1] = c[2] = c[3] = c[4] = 0.0;
        }
        double run(double x) noexcept TERMINATOR_NONBLOCKING
        {
            const double y = c[0] * x + z1;
            z1 = c[1] * x - c[3] * y + z2;
            z2 = c[2] * x - c[4] * y;
            return y;
        }
    };
    struct Channel
    {
        Biquad hp, lo, hi, pk;
        double lp = 0.0, dcX = 0.0, dcY = 0.0;
    };
    void recompute() noexcept TERMINATOR_NONBLOCKING;
    double sat(double x) const noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    bool bus_ = false;
    std::uint32_t seed_ = 0;
    double tol_[6] = {};
    ConsoleFlavour flavour_ = ConsoleFlavour::ssl;
    float amount_ = 0.5f, amountTarget_ = 0.5f;
    Channel ch_[2];
    double lpA_ = 0.0;
    double a2_ = 0.0, a3_ = 0.0, x0_ = 1e9, oddHold_ = 0.0, evenHold_ = 0.0;
    double dcR_ = 0.0;
};

} // namespace terminator
