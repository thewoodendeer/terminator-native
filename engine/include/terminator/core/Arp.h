#pragma once
// Arp on the sample clock (Phase 3.6). The Electron `ChopperEngine.startArp / arpFire / stopArp`: holding a pad while
// ARP is on steps through the pad bank at the session tempo — `interval = 60 / bpm / rate` (rate 1 = quarters, 2 =
// 8ths, 4 = 16ths, 8 = 32nds), pad = (hold + step) mod padCount going UP, (hold − step) mod padCount going DOWN, or a
// random pad; the held velocity for every step; releasing the held pad stops it. The TS fired each step from a
// `setTimeout` aimed at start + step·interval (drift-free target, jittery fire — dossier-sequencing-midi §5); here
// every step fires INSIDE the audio callback at its exact sample, the interval re-read per step so a tempo change
// lands at the next step with the phase kept (the TS re-gridded from the start and could burst to catch up). A step's
// hit goes through the Sampler like a live hit (the pad's mute group / retrigger rules) and stamps the pad's
// live-hit time (the one-owner rule: a pattern hit of that pad within 120 ms is the arp's). Pure C++20, no JUCE, no
// allocation (RT-RULES.md).
#include <cstdint>

#include "terminator/core/RtAssert.h"
#include "terminator/core/Sampler.h"
#include "terminator/core/StateSnapshot.h"

namespace terminator
{

class Arp
{
  public:
    void prepare(double sampleRate, bool keepState = false) noexcept;
    void reset() noexcept;

    // --- commands (audio thread, from Engine::apply) ---
    /// The page's ARP settings. `rate` ≥ 1 (the note divisor), `padCount` = the pad bank size the arp walks
    /// (1..kChopPads; ≤ 0 = the whole grid). Disabling while a pad is held stops it (TS toggleArp).
    void setParams(bool enabled, int rate, bool down, bool random, int padCount) noexcept TERMINATOR_NONBLOCKING;
    void setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING; // 20..300; applies at the next step
    /// Hold `pad` at `velocity` from `atSample` (≥ blockStart; 0 = the block start): the first step fires there.
    /// Restarts when a pad is already held (TS startArp → stopArp first).
    void hold(int pad, float velocity, std::uint64_t atSample,
              std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING;
    /// Release `pad`: stops the arp when it is the held pad (−1 = whatever is held). Other pads: no-op.
    void release(int pad) noexcept TERMINATOR_NONBLOCKING;
    void stop() noexcept TERMINATOR_NONBLOCKING;

    /// Fire this block's steps into the sampler; `liveHitSample` (kMaxPads entries; nullptr = none) gets the fired
    /// pad's sample (the one-owner rule).
    void process(std::uint64_t blockStart, int numSamples, Sampler& sampler,
                 double* liveHitSample) noexcept TERMINATOR_NONBLOCKING;

    // --- read-back (audio thread) ---
    bool enabled() const noexcept { return enabled_; }
    int rate() const noexcept { return rate_; }
    bool down() const noexcept { return down_; }
    bool random() const noexcept { return random_; }
    int padCount() const noexcept { return padCount_; }
    int holdPad() const noexcept { return holdPad_; } // −1 = nothing held
    int step() const noexcept { return step_; }       // steps fired since the hold
    int lastPad() const noexcept { return lastPad_; } // the pad the last step fired (−1 none)
    std::uint64_t hits() const noexcept { return hits_; }
    double nextFireSample() const noexcept { return nextFire_; }

  private:
    int pickPad() noexcept TERMINATOR_NONBLOCKING;
    double intervalSamples() const noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    double bpm_ = 120.0;
    bool enabled_ = false;
    int rate_ = 4; // the TS default: sixteenths
    bool down_ = false;
    bool random_ = false;
    int padCount_ = kChopPads;
    int holdPad_ = -1;
    float velocity_ = 1.0f;
    int step_ = 0;
    double nextFire_ = 0.0; // absolute engine sample of the next step
    int lastPad_ = -1;
    std::uint64_t hits_ = 0;
    std::uint64_t rng_ = 0x853C49E6748FEA9Bull; // xorshift64* — seeded, so a render is deterministic
};

} // namespace terminator
