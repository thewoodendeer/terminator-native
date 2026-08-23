#pragma once
// LOUDNESS METER (Phase 4.3) — ITU-R BS.1770-4 / EBU R128 on the audio thread, the page's loudness-meter worklet 1:1:
// K-weighting designed from the spec's analogue prototypes at the running rate (high shelf f0 1681.97 Hz Q 0.7071752
// +3.99984 dB with Vb = Vh^0.4996667741545416; RLB high-pass 38.13547 Hz Q 0.5003270); 100 ms hops; MOMENTARY = the
// last 4 hops, SHORT-TERM = the last 30; INTEGRATED = every 400 ms block above −70 LUFS, then −10 LU below the gated
// mean, recomputed each hop over the whole history; LRA = short-term values gated −70 abs / −20 rel, 10th → 95th
// percentile; sample peak + TRUE PEAK (4 phases × 12 taps of a Kaiser β 8 sinc, each phase unity at DC) per hop;
// L/R correlation per hop. Feeds the master's output (post limiter); never touches the signal. Everything is
// preallocated (the integrated history caps at kMaxBlocks hops ≈ 2 h; the short-term history at 6000 as the page's).
#include <cstdint>
#include <vector>

#include "terminator/core/RtAssert.h"

namespace terminator
{

struct LoudnessReading
{
    float m = -1000.0f, s = -1000.0f, i = -1000.0f; // LUFS (−1000 = −∞)
    float lra = 0.0f;                               // LU
    float peakL = 0.0f, peakR = 0.0f;               // the last hop's sample peaks
    float tpL = 0.0f, tpR = 0.0f;                   // the last hop's true peaks
    float corr = 1.0f;                              // L/R correlation of the last hop
    float holdPeak = 0.0f, holdTp = 0.0f;           // since reset
    float maxM = -1000.0f, maxS = -1000.0f;         // since reset
    std::uint32_t hops = 0;                         // integrated blocks counted (the page's `hops`)
};

class LoudnessMeter
{
  public:
    static constexpr int kMaxBlocks = 72000; // 100 ms hops of integrated history: 2 hours
    static constexpr int kMaxShorts = 6000;
    static constexpr int kTpPhases = 4, kTpTaps = 12;

    void prepare(double sampleRate); // non-RT
    /// RT: clear everything (the page's 'reset': integrated + LRA + the holds; the hop in progress restarts).
    void reset() noexcept TERMINATOR_NONBLOCKING;
    /// RT: feed a block of the master output.
    void push(const double* l, const double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING;
    const LoudnessReading& reading() const noexcept TERMINATOR_NONBLOCKING { return reading_; }

  private:
    struct Biquad
    {
        double c[5] = {1.0, 0.0, 0.0, 0.0, 0.0};
        double z1 = 0.0, z2 = 0.0;
        double run(double x) noexcept TERMINATOR_NONBLOCKING
        {
            const double y = c[0] * x + z1;
            z1 = c[1] * x - c[3] * y + z2;
            z2 = c[2] * x - c[4] * y;
            return y;
        }
    };
    struct TruePeak
    {
        double hist[kTpTaps] = {};
        int pos = 0;
    };
    void endHop() noexcept TERMINATOR_NONBLOCKING;
    double truePeak(TruePeak& t, double x) const noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    Biquad kL_[2], kR_[2];
    double tpPhase_[kTpPhases][kTpTaps] = {};
    TruePeak tpL_, tpR_;
    int hopLen_ = 4800, hopPos_ = 0;
    double sqL_ = 0.0, sqR_ = 0.0, pkL_ = 0.0, pkR_ = 0.0, tpkL_ = 0.0, tpkR_ = 0.0, cLL_ = 0.0, cRR_ = 0.0, cLR_ = 0.0;
    double hops_[30] = {};
    int hopCount_ = 0;            // ≤ 30, a sliding window (oldest dropped)
    std::vector<double> blocks_;  // kMaxBlocks: 400 ms block mean-squares above the absolute gate
    std::vector<float> blocksDb_; // their LUFS (so the relative gate compares, never recomputes a log per hop)
    int blockCount_ = 0;
    std::vector<double> shorts_; // kMaxShorts: short-term LUFS above the absolute gate (a ring)
    int shortCount_ = 0, shortPos_ = 0;
    std::vector<double> scratch_; // kMaxShorts: the LRA sort
    LoudnessReading reading_;
};

} // namespace terminator
