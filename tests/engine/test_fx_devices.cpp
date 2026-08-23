// The 4.2b devices (Phase 4.2b): CLIP / WAVE / SAT / MB SAT on the 4× oversampler, DELAY / PHASER / FLANGER / VINYL,
// COMP (the Blink DynamicsCompressor kernel) / SC COMP (keyed from another strip through the Mixer), REVERB (the seeded
// IR through the partitioned convolver). Every assertion is a number the page's code (or the Web Audio engine it
// runs on) fixes: the oversampler's group delay is reported exactly and its passband is flat; a driven WAVE aliases
// ≥ 30 dB less than the naive curve; the curves' small-signal gains; MB SAT sums flat at 0 drive; echoes land on the
// sample; the allpass cascade is unity and notches against the dry; VINYL's latency; the kernel's 6 ms look-ahead and
// its unity OFF style; the sc-comp ducks from the key's PRE-insert input; the reverb's output IS scale · ir sample by
// sample across all three tiers, PREDELAY shifts it, a DECAY change rebuilds and crossfades.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "terminator/core/Engine.h"
#include "terminator/core/Mixer.h"
#include "terminator/core/fx/DynamicsFx.h"
#include "terminator/core/fx/FxDsp.h"
#include "terminator/core/fx/FxPool.h"
#include "terminator/core/fx/ModFx.h"
#include "terminator/core/fx/ReverbFx.h"
#include "terminator/core/fx/ShaperFx.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;
constexpr int kBlock = 256;
constexpr double kTwoPi = 6.283185307179586;

/// Run `total` samples of a generator through `e` (both channels the same), returning the L output.
template <class Gen> std::vector<double> run(Effect& e, int total, Gen&& gen, int block = kBlock)
{
    std::vector<double> out(static_cast<std::size_t>(total));
    std::vector<double> l(static_cast<std::size_t>(block)), r(static_cast<std::size_t>(block));
    int done = 0;
    while (done < total)
    {
        const int n = std::min(block, total - done);
        for (int i = 0; i < n; ++i)
            l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] = gen(done + i);
        e.process(l.data(), r.data(), n);
        for (int i = 0; i < n; ++i)
            out[static_cast<std::size_t>(done + i)] = l[static_cast<std::size_t>(i)];
        done += n;
    }
    return out;
}

/// Steady-state gain (dB) of a sine at `hz`, amplitude `amp`, over the last 0.25 s after `settleSec`.
double gainDb(Effect& e, double hz, double amp = 0.5, double settleSec = 0.5)
{
    const int total = static_cast<int>(kSr * (settleSec + 0.25));
    const int tail = static_cast<int>(kSr * 0.25);
    const auto out = run(e, total, [&](int i) { return amp * std::sin(kTwoPi * hz * static_cast<double>(i) / kSr); });
    double si = 0.0, so = 0.0;
    for (int i = total - tail; i < total; ++i)
    {
        const double x = amp * std::sin(kTwoPi * hz * static_cast<double>(i) / kSr);
        si += x * x;
        so += out[static_cast<std::size_t>(i)] * out[static_cast<std::size_t>(i)];
    }
    return 10.0 * std::log10(so / si);
}

/// Goertzel power (dB re 1.0 amplitude) of `hz` in x[from, from+len).
double toneDb(const std::vector<double>& x, int from, int len, double hz)
{
    const double w = kTwoPi * hz / kSr;
    const double c = 2.0 * std::cos(w);
    double s0 = 0.0, s1 = 0.0, s2 = 0.0;
    for (int i = 0; i < len; ++i)
    {
        s0 = x[static_cast<std::size_t>(from + i)] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const double re = s1 - s2 * std::cos(w), im = s2 * std::sin(w);
    const double amp = 2.0 * std::sqrt(re * re + im * im) / static_cast<double>(len);
    return 20.0 * std::log10(amp + 1e-30);
}

int argmax(const std::vector<double>& v)
{
    int best = 0;
    for (std::size_t i = 1; i < v.size(); ++i)
        if (std::abs(v[i]) > std::abs(v[static_cast<std::size_t>(best)]))
            best = static_cast<int>(i);
    return best;
}
} // namespace

// ---- the type table -------------------------------------------------------------------------------------------

TEST_CASE("fx 4.2b: the type table - every page device, keys / defaults / options / WET", "[fx]")
{
    REQUIRE(fxTypeInfo(FxType::clip).numParams == 1);
    REQUIRE(fxParamIndex(FxType::clip, "AMT") == 0);
    REQUIRE(fxTypeInfo(FxType::mbsat).numParams == 6);
    REQUIRE(fxParamIndex(FxType::mbsat, "HI_X") == 4);
    REQUIRE(fxTypeInfo(FxType::mbsat).params[4].def == 3000.0f);
    REQUIRE(fxTypeInfo(FxType::mbsat).wetParam == -1); // blends internally (matched dry leg)
    REQUIRE(fxTypeInfo(FxType::phaser).wetParam == 5);
    REQUIRE(fxOptionIndex(FxType::phaser, 4, "12") == 3);
    REQUIRE(fxTypeInfo(FxType::phaser).params[4].def == 1.0f); // 6 stages
    REQUIRE(fxTypeInfo(FxType::flanger).wetParam == 4);
    REQUIRE(fxTypeInfo(FxType::flanger).params[3].min == -95.0f);
    REQUIRE(fxTypeInfo(FxType::vinyl).numParams == 5);
    REQUIRE(fxTypeInfo(FxType::vinyl).params[0].def == 4.0f);
    REQUIRE(fxOptionIndex(FxType::comp, 0, "NY-PARALLEL") == 3);
    REQUIRE(fxTypeInfo(FxType::comp).params[0].def == 2.0f); // PUNCHY
    REQUIRE(fxTypeInfo(FxType::comp).wetParam == -1);
    REQUIRE(fxParamIndex(FxType::sccomp, "KEYHP") == 7);
    REQUIRE(fxTypeInfo(FxType::sccomp).params[0].def == -1.0f); // SOURCE NONE
    REQUIRE(fxParamIndex(FxType::delay, "PINGPONG") == 3);
    REQUIRE(fxTypeInfo(FxType::delay).wetParam == 2);
    REQUIRE(fxTypeInfo(FxType::delay).params[0].def == 300.0f);
    REQUIRE(fxTypeInfo(FxType::reverb).wetParam == 3);
    REQUIRE(fxTypeInfo(FxType::reverb).params[2].max == 10.0f);
    for (int t = 1; t < static_cast<int>(FxType::count); ++t)
        REQUIRE(FxPool::isPorted(static_cast<FxType>(t)));
}

// ---- the oversampler + the shapers -----------------------------------------------------------------------------

TEST_CASE("fx 4.2b: the 4x oversampler - a whole-sample group delay, a flat passband, 30 dB less aliasing", "[fx]")
{
    // CLIP at AMT 0 is min(0.9886, |x|): a 0.5 impulse passes as 0.5 at exactly latencySamples()
    ClipFx clip;
    clip.prepare(kSr, kBlock);
    REQUIRE(clip.latencySamples() == Oversampler4x::kLatency);
    REQUIRE(Oversampler4x::kLatency == 55);
    auto imp = run(clip, 512, [](int i) { return i == 0 ? 0.5 : 0.0; });
    REQUIRE(argmax(imp) == 55);
    REQUIRE(imp[55] > 0.47); // the four halfbands spread the impulse a little (their passband stops short of Nyquist)
    double dc = 0.0;
    for (double v : imp)
        dc += v;
    REQUIRE(dc == Approx(0.5).margin(1e-3)); // unity DC gain, exactly by design
    // the passband: flat within the stage-1 halfband's ripple
    REQUIRE(gainDb(clip, 1000.0, 0.5) == Approx(0.0).margin(0.02));
    REQUIRE(gainDb(clip, 10000.0, 0.5) == Approx(0.0).margin(0.1));
    REQUIRE(gainDb(clip, 16000.0, 0.5) == Approx(0.0).margin(0.5));
    // aliasing: WAVE at DRIVE 30 on a 14 kHz sine — the 3rd harmonic (42 kHz) would fold to 6 kHz at the base rate;
    // at 4× it sits below the 96 kHz Nyquist and the decimators remove it (at DRIVE 100 the curve is a square wave
    // whose 13th+ harmonics fold even at 4× — the page's WaveShaper has the same ceiling)
    WaveFx wave;
    wave.prepare(kSr, kBlock);
    wave.setParam(0, 30.0f, true);
    const int total = 48000;
    auto os = run(wave, total, [](int i) { return 0.5 * std::sin(kTwoPi * 14000.0 * static_cast<double>(i) / kSr); });
    std::vector<double> naive(static_cast<std::size_t>(total));
    for (int i = 0; i < total; ++i)
        naive[static_cast<std::size_t>(i)] =
            WaveFx::curve(0.5 * std::sin(kTwoPi * 14000.0 * static_cast<double>(i) / kSr), 0.3);
    const double aliasOs = toneDb(os, 8192, 32768, 6000.0);
    const double aliasNaive = toneDb(naive, 8192, 32768, 6000.0);
    const double fund = toneDb(os, 8192, 32768, 14000.0);
    INFO("alias 6 kHz: oversampled " << aliasOs << " dB, naive " << aliasNaive << " dB, fundamental " << fund);
    REQUIRE(aliasNaive > -15.0);          // the naive curve folds hard (measured −9.4 dB)
    REQUIRE(aliasOs < aliasNaive - 40.0); // ours does not (measured −81 dB)
}

TEST_CASE("fx 4.2b: CLIP / WAVE / SAT - the page's curves", "[fx]")
{
    // CLIP: AMT 0 → min(0.9886, |x|); AMT 100 → t 0.1: curve(1) = 0.1 + 0.9 / (1 + 1) = 0.55; the domain clamps
    REQUIRE(ClipFx::curve(0.5, 0.0) == Approx(0.5));
    REQUIRE(ClipFx::curve(1.0, 0.0) == Approx(0.9886));
    REQUIRE(ClipFx::curve(3.0, 0.0) == Approx(0.9886));
    REQUIRE(ClipFx::curve(1.0, 1.0) == Approx(0.55));
    REQUIRE(ClipFx::curve(-1.0, 1.0) == Approx(-0.55));
    // WAVE: tanh(kx)/tanh(k), k = 1 + 24·drive; small-signal gain at DRIVE 0 = 1/tanh(1) = +2.37 dB
    REQUIRE(WaveFx::curve(1.0, 0.0) == Approx(1.0));
    REQUIRE(WaveFx::curve(0.2, 1.0) == Approx(std::tanh(5.0) / std::tanh(25.0)));
    WaveFx wave;
    wave.prepare(kSr, kBlock);
    REQUIRE(gainDb(wave, 1000.0, 0.01) == Approx(20.0 * std::log10(1.0 / std::tanh(1.0))).margin(0.05));
    // SAT: Doidic on g·x clamped: DRIVE 0 → 1.5x − 0.5x³ (+3.52 dB small-signal, the page's); DRIVE 100 → g 3
    REQUIRE(SatFx::doidic(0.5, 1.0) == Approx(1.5 * 0.5 * (1.0 - 0.25 / 3.0)));
    REQUIRE(SatFx::doidic(1.0, 1.0) == Approx(1.0));
    REQUIRE(SatFx::doidic(0.5, 3.0) == Approx(1.0)); // 1.5 clamps to 1 → the curve's top
    SatFx sat;
    sat.prepare(kSr, kBlock);
    REQUIRE(gainDb(sat, 1000.0, 0.01) == Approx(20.0 * std::log10(1.5)).margin(0.05));
    REQUIRE(sat.latencySamples() == 55);
    REQUIRE(wave.latencySamples() == 55);
}

TEST_CASE("fx 4.2b: MB SAT - LR4 split sums flat at 0 drive, a driven band lifts only its band", "[fx]")
{
    MbSatFx mb;
    mb.prepare(kSr, kBlock);
    REQUIRE(mb.latencySamples() == 55);
    for (double hz : {100.0, 1000.0, 10000.0})
    {
        INFO(hz);
        REQUIRE(gainDb(mb, hz, 0.3) == Approx(0.0).margin(0.05));
    }
    // WET 50 at 0 drive: the dry leg is phase- and latency-matched → still flat (no comb, no crossover notch)
    mb.setParam(5, 50.0f, true);
    for (double hz : {100.0, 200.0, 1000.0, 3000.0, 10000.0})
    {
        INFO(hz);
        REQUIRE(gainDb(mb, hz, 0.3) == Approx(0.0).margin(0.1));
    }
    mb.setParam(5, 100.0f, true);
    // LOW 100 at −20 dBFS: tanh(4X)/4 ≈ X for small X, makeup √5 = +7 dB, minus the tanh squash at 0.1
    mb.setParam(0, 100.0f, true);
    const double low = gainDb(mb, 100.0, 0.1);
    const double high = gainDb(mb, 10000.0, 0.1);
    INFO("LOW 100: 100 Hz " << low << " dB, 10 kHz " << high << " dB");
    REQUIRE(low > 5.0);
    REQUIRE(low < 7.1);
    REQUIRE(high == Approx(0.0).margin(0.1));
    mb.setParam(0, 0.0f, true);
    mb.setParam(2, 100.0f, true);
    REQUIRE(gainDb(mb, 100.0, 0.1) == Approx(0.0).margin(0.1));
    REQUIRE(gainDb(mb, 10000.0, 0.1) > 5.0);
}

// ---- the delays / modulation -----------------------------------------------------------------------------------

TEST_CASE("fx 4.2b: DELAY - echoes on the sample, damped feedback, ping-pong", "[fx]")
{
    DelayFx d;
    d.prepare(kSr, kBlock);
    d.setParam(0, 100.0f, true); // 100 ms = 4800 samples; R = 102 ms = 4896
    d.setParam(1, 0.0f, true);
    // a left-only impulse: dual mono → the L line echoes it at 4800, the R line is silent
    {
        std::vector<double> l(kBlock), r(kBlock);
        std::vector<double> outL, outR;
        for (int b = 0; b < 40; ++b)
        {
            std::fill(l.begin(), l.end(), 0.0);
            std::fill(r.begin(), r.end(), 0.0);
            if (b == 0)
                l[0] = 1.0;
            d.process(l.data(), r.data(), kBlock);
            outL.insert(outL.end(), l.begin(), l.end());
            outR.insert(outR.end(), r.begin(), r.end());
        }
        REQUIRE(argmax(outL) == 4800);
        REQUIRE(outL[4800] == Approx(1.0).margin(1e-3)); // 0.1 s is a float (as the AudioParam): 4800.00007 samples
        REQUIRE(outL[4799] == Approx(0.0).margin(1e-9));
        REQUIRE(*std::max_element(outR.begin(), outR.end()) == Approx(0.0).margin(1e-12));
    }
    // feedback 50 %: a second echo at 9600 through the LP 7.5 k / HP 90 damping (smaller than 0.5, not gone)
    d.reset();
    d.setParam(0, 100.0f, true);
    d.setParam(1, 50.0f, true);
    {
        auto out = run(d, 12000, [](int i) { return i == 0 ? 1.0 : 0.0; });
        REQUIRE(out[4800] == Approx(1.0).margin(1e-3));
        double peak2 = 0.0;
        for (int i = 9500; i < 9800; ++i)
            peak2 = std::max(peak2, std::abs(out[static_cast<std::size_t>(i)]));
        INFO("second echo peak " << peak2);
        REQUIRE(peak2 > 0.2);
        REQUIRE(peak2 < 0.5);
    }
    // ping-pong: the mono sum (a left-only impulse = 0.5) → L at 4800, then the R line (+4896) at 9696
    d.reset();
    d.setParam(0, 100.0f, true);
    d.setParam(1, 0.0f, true);
    d.setParam(3, 1.0f, true);
    {
        std::vector<double> l(kBlock), r(kBlock);
        std::vector<double> outL, outR;
        for (int b = 0; b < 40; ++b)
        {
            std::fill(l.begin(), l.end(), 0.0);
            std::fill(r.begin(), r.end(), 0.0);
            if (b == 0)
                l[0] = 1.0;
            d.process(l.data(), r.data(), kBlock);
            outL.insert(outL.end(), l.begin(), l.end());
            outR.insert(outR.end(), r.begin(), r.end());
        }
        REQUIRE(outL[4800] == Approx(0.5).margin(1e-3));
        REQUIRE(argmax(outR) == 9696);
        REQUIRE(outR[9696] == Approx(0.5).margin(1e-3));
    }
}

TEST_CASE("fx 4.2b: PHASER - the allpass cascade is unity, and notches against the dry", "[fx]")
{
    PhaserFx p;
    p.prepare(kSr, kBlock);
    p.setParam(1, 0.0f, true); // DEPTH 0: static notches
    p.setParam(3, 0.0f, true); // no feedback
    for (double hz : {200.0, 1000.0, 5000.0})
    {
        INFO(hz);
        REQUIRE(gainDb(p, hz, 0.5) == Approx(0.0).margin(0.05));
    }
    // 50 / 50 with the dry (what the chain does at WET 50): a sweep finds a deep notch and never exceeds 0 dB
    double minDb = 0.0, maxDb = -100.0;
    for (double hz = 300.0; hz < 3000.0; hz *= 1.04)
    {
        p.reset();
        p.setParam(1, 0.0f, true);
        p.setParam(3, 0.0f, true);
        const int total = static_cast<int>(kSr * 0.5);
        auto wet = run(p, total, [&](int i) { return 0.5 * std::sin(kTwoPi * hz * static_cast<double>(i) / kSr); });
        double so = 0.0, si = 0.0;
        for (int i = total / 2; i < total; ++i)
        {
            const double x = 0.5 * std::sin(kTwoPi * hz * static_cast<double>(i) / kSr);
            const double y = 0.5 * x + 0.5 * wet[static_cast<std::size_t>(i)];
            so += y * y;
            si += x * x;
        }
        const double db = 10.0 * std::log10(so / si);
        minDb = std::min(minDb, db);
        maxDb = std::max(maxDb, db);
    }
    INFO("sweep min " << minDb << " max " << maxDb);
    REQUIRE(minDb < -10.0);
    REQUIRE(maxDb < 0.1);
    // feedback 90 % stays bounded (1-sample feedback through a unity-magnitude cascade)
    p.reset();
    p.setParam(3, 90.0f, true);
    auto out = run(p, 48000, [](int i) { return 0.5 * std::sin(kTwoPi * 440.0 * static_cast<double>(i) / kSr); });
    REQUIRE(std::abs(out[47999]) < 20.0);
    REQUIRE(std::isfinite(out[47999]));
}

TEST_CASE("fx 4.2b: FLANGER - the swept delay, the damped feedback", "[fx]")
{
    FlangerFx f;
    f.prepare(kSr, kBlock);
    f.setParam(1, 0.0f, true); // DEPTH 0 → a fixed 3 ms = 144 samples
    f.setParam(3, 0.0f, true);
    auto out = run(f, 1024, [](int i) { return i == 0 ? 1.0 : 0.0; });
    REQUIRE(argmax(out) == 144);
    REQUIRE(out[144] == Approx(1.0).margin(1e-9));
    // feedback 50 %: the second pass at 288 through the 9 kHz lowpass
    f.reset();
    f.setParam(1, 0.0f, true);
    f.setParam(3, 50.0f, true);
    out = run(f, 1024, [](int i) { return i == 0 ? 1.0 : 0.0; });
    REQUIRE(out[144] == Approx(1.0).margin(1e-9));
    double peak2 = 0.0;
    for (int i = 280; i < 300; ++i)
        peak2 = std::max(peak2, std::abs(out[static_cast<std::size_t>(i)]));
    REQUIRE(peak2 > 0.2);
    REQUIRE(peak2 < 0.5);
    // DEPTH 100 at 0.25 Hz sweeps 3 ± 2.7 ms: the delay of a later impulse differs from 144
    f.reset();
    f.setParam(1, 100.0f, true);
    f.setParam(3, 0.0f, true);
    out = run(f, 96000, [](int i) { return i == 48000 ? 1.0 : 0.0; }); // at 1 s the 0.25 Hz triangle is at its peak
    int peakAt = 48000;
    for (int i = 48000; i < 48600; ++i)
        if (std::abs(out[static_cast<std::size_t>(i)]) > std::abs(out[static_cast<std::size_t>(peakAt)]))
            peakAt = i;
    INFO("delay at the LFO peak: " << (peakAt - 48000) << " samples");
    REQUIRE(peakAt - 48000 > 268); // 3 + 2.7 ms = 5.7 ms = 273.6 samples
    REQUIRE(peakAt - 48000 < 280);
}

TEST_CASE("fx 4.2b: VINYL/TAPE - the 5 ms + oversampler latency, AGE darkens, WOW moves the pitch", "[fx]")
{
    VinylFx v;
    v.prepare(kSr, kBlock);
    REQUIRE(v.latencySamples() == 240 + 55);
    for (int i = 0; i < 5; ++i)
        v.setParam(i, 0.0f, true); // everything flat: DRIVE 0 (the +3.5 dB curve), no wow / flutter, AGE 0
    auto out = run(v, 1024, [](int i) { return i == 0 ? 0.1 : 0.0; });
    REQUIRE(argmax(out) == 295);
    // AGE 10: the lowpass sits at 8 kHz — a 15 kHz sine loses > 6 dB vs AGE 0
    v.reset();
    for (int i = 0; i < 5; ++i)
        v.setParam(i, 0.0f, true);
    const double fresh = gainDb(v, 15000.0, 0.1);
    v.setParam(4, 10.0f, true);
    const double worn = gainDb(v, 15000.0, 0.1);
    INFO("15 kHz: AGE 0 " << fresh << " dB, AGE 10 " << worn << " dB");
    REQUIRE(fresh - worn > 6.0);
    // WARMTH 10: +6 dB bell at 200 Hz (vs WARMTH 0's +2)
    v.reset();
    for (int i = 0; i < 5; ++i)
        v.setParam(i, 0.0f, true);
    const double w0 = gainDb(v, 200.0, 0.1);
    v.setParam(0, 10.0f, true);
    const double w10 = gainDb(v, 200.0, 0.1);
    REQUIRE(w10 - w0 == Approx(4.0).margin(0.2));
}

// ---- the dynamics ----------------------------------------------------------------------------------------------

TEST_CASE("fx 4.2b: COMP - Blink's kernel: the 6 ms look-ahead, OFF is unity, PUNCHY compresses, NY blends aligned",
          "[fx]")
{
    CompFx c;
    c.prepare(kSr, kBlock);
    REQUIRE(c.latencySamples() == 288); // int(0.006 · 48000)
    // STYLE OFF (threshold 0, ratio 1): an impulse passes at unity, 288 samples late. Blink's kernel resets its
    // detector average to 0, so a FRESH compressor dips its gain for the first ~100 ms then recovers (the page's
    // DynamicsCompressorNode does the same) — the gate lets it settle on silence first, then checks the dip existed
    c.setParam(0, 0.0f, true);
    auto fresh = run(c, 1024, [](int i) { return i == 0 ? 0.5 : 0.0; });
    REQUIRE(argmax(fresh) == 288);
    REQUIRE(fresh[288] < 0.45); // the start-up dip
    run(c, 48000, [](int) { return 0.0; });
    auto out = run(c, 1024, [](int i) { return i == 0 ? 0.5 : 0.0; });
    REQUIRE(argmax(out) == 288);
    REQUIRE(out[288] == Approx(0.5).margin(1e-4));
    REQUIRE(out[0] == Approx(0.0).margin(1e-12));
    // PUNCHY (−20 dB, 4:1, makeup +4): a −6 dBFS sine gets at least 3 dB less gain than a −30 dBFS one (it is
    // compressing), and the quiet one is lifted by the makeup + Blink's auto-makeup
    c.reset();
    c.setParam(0, 2.0f, true);
    const double loud = gainDb(c, 1000.0, 0.5, 1.0);
    c.reset();
    c.setParam(0, 2.0f, true);
    const double quiet = gainDb(c, 1000.0, 0.03, 1.0);
    INFO("PUNCHY: −6 dBFS → " << loud << " dB, −30 dBFS → " << quiet << " dB");
    REQUIRE(quiet - loud > 3.0);
    REQUIRE(quiet > 4.0);
    // NY-PARALLEL: 50 % dry, the dry leg delayed by the look-ahead — an impulse comes out ONCE, at 288
    c.reset();
    c.setParam(0, 3.0f, true);
    run(c, 48000, [](int) { return 0.0; });
    out = run(c, 1024, [](int i) { return i == 0 ? 0.5 : 0.0; });
    REQUIRE(argmax(out) == 288);
    double before = 0.0;
    for (int i = 0; i < 288; ++i)
        before = std::max(before, std::abs(out[static_cast<std::size_t>(i)]));
    REQUIRE(before < 1e-9);
    // the knobs override the style: RATIO 20 on PUNCHY compresses harder than RATIO 1.5 — measured as the gain
    // difference between −30 dBFS and −6 dBFS (Blink's auto-makeup (1/saturate(1))^0.6 lifts the quiet signal MORE at
    // the higher ratio, so the loud-signal gains alone barely differ — the page's compressor behaves the same)
    auto compression = [&](float ratio)
    {
        c.reset();
        c.setParam(0, 2.0f, true);
        c.setParam(2, ratio, true);
        const double lo = gainDb(c, 1000.0, 0.5, 1.0);
        c.reset();
        c.setParam(0, 2.0f, true);
        c.setParam(2, ratio, true);
        const double hi = gainDb(c, 1000.0, 0.03, 1.0);
        return hi - lo;
    };
    const double hard = compression(20.0f), soft = compression(1.5f);
    INFO("compression at 20:1 " << hard << " dB, at 1.5:1 " << soft << " dB");
    REQUIRE(hard - soft > 5.0);
}

TEST_CASE("fx 4.2b: SC COMP - ducked from another strip's PRE-insert input through the Mixer", "[fx]")
{
    Mixer m;
    FxPool pool;
    pool.prepare(kSr, kBlock);
    m.prepare(kSr, kBlock);
    m.setPool(&pool);
    m.setStripKind(1, StripKind::channel);
    m.setStripKind(2, StripKind::channel);
    m.setOutput(2, StripOutput::none, 0); // the key strip is not heard — only strip 1 reaches the master
    REQUIRE(m.addFx(1, FxType::sccomp));
    m.setFxParam(1, 0, fxParamIndex(FxType::sccomp, "SOURCE"), 2.0f, true);
    m.setFxParam(1, 0, fxParamIndex(FxType::sccomp, "THRESH"), -40.0f, true);
    m.setFxParam(1, 0, fxParamIndex(FxType::sccomp, "RATIO"), 20.0f, true);
    m.setFxParam(1, 0, fxParamIndex(FxType::sccomp, "ATTACK"), 0.1f, true);
    m.setFxParam(1, 0, fxParamIndex(FxType::sccomp, "RELEASE"), 1000.0f, true);
    REQUIRE(m.sidechainKeyMask() == (std::uint64_t{1} << 2));
    std::vector<float> oL(kBlock), oR(kBlock);
    float* outs[2] = {oL.data(), oR.data()};
    auto measure = [&](double keyAmp)
    {
        double sum = 0.0;
        int count = 0;
        for (int b = 0; b < 200; ++b)
        {
            std::fill(oL.begin(), oL.end(), 0.0f); // the Mixer adds into the outputs (the Engine clears them)
            std::fill(oR.begin(), oR.end(), 0.0f);
            m.clearInputs(kBlock);
            for (int i = 0; i < kBlock; ++i)
            {
                const double t = static_cast<double>(b * kBlock + i) / kSr;
                m.inputs()[2][i] += 0.1 * std::sin(kTwoPi * 1000.0 * t);
                m.inputs()[3][i] += 0.1 * std::sin(kTwoPi * 1000.0 * t);
                m.inputs()[4][i] += keyAmp * std::sin(kTwoPi * 60.0 * t);
                m.inputs()[5][i] += keyAmp * std::sin(kTwoPi * 60.0 * t);
            }
            m.process(outs, 2, kBlock);
            if (b >= 100)
                for (int i = 0; i < kBlock; ++i)
                {
                    sum += static_cast<double>(oL[static_cast<std::size_t>(i)]) *
                           static_cast<double>(oL[static_cast<std::size_t>(i)]);
                    ++count;
                }
        }
        return 10.0 * std::log10(sum / count);
    };
    const double noKey = measure(0.0);
    const double keyed = measure(0.5);
    INFO("strip 1: key silent " << noKey << " dB, key loud " << keyed << " dB");
    REQUIRE(noKey - keyed > 15.0);
    // the key is the source's PRE-insert input: a UTILITY at −20 dB on strip 2 changes nothing about the ducking
    REQUIRE(m.addFx(2, FxType::utility));
    m.setFxParam(2, 0, 0, -20.0f, true);
    const double keyedStill = measure(0.5);
    REQUIRE(keyedStill == Approx(keyed).margin(0.5));
    // SOURCE NONE → clean pass again (the worklet's: no key = GR releases to 0; RELEASE 5 ms so it lets go now)
    m.setFxParam(1, 0, 0, -1.0f, true);
    m.setFxParam(1, 0, fxParamIndex(FxType::sccomp, "RELEASE"), 5.0f, true);
    REQUIRE(m.sidechainKeyMask() == 0u);
    REQUIRE(measure(0.5) == Approx(noKey).margin(0.5));
}

// ---- the reverb ----------------------------------------------------------------------------------------------

TEST_CASE("fx 4.2b: REVERB - the seeded IR, Blink's normalisation, the convolver is exact across its tiers", "[fx]")
{
    // the generator: length = floor(sr · DECAY), onset ramp from 0, deterministic, decays to the −60 dB envelope
    const int cap = static_cast<int>(kSr * 10.0);
    std::vector<float> irL(static_cast<std::size_t>(cap)), irR(static_cast<std::size_t>(cap));
    const int len = ReverbFx::generateIr(0.5, 0.5, kSr, irL.data(), irR.data(), cap);
    REQUIRE(len == 24000);
    REQUIRE(irL[0] == 0.0f);
    std::vector<float> again(static_cast<std::size_t>(cap)), againR(static_cast<std::size_t>(cap));
    ReverbFx::generateIr(0.5, 0.5, kSr, again.data(), againR.data(), cap);
    REQUIRE(std::equal(irL.begin(), irL.begin() + len, again.begin()));
    REQUIRE(irR[100] != irL[100]); // decorrelated channels
    float headPeak = 0.0f, tailPeak = 0.0f;
    for (int i = 0; i < 2000; ++i)
        headPeak = std::max(headPeak, std::abs(irL[static_cast<std::size_t>(i)]));
    for (int i = len - 2000; i < len; ++i)
        tailPeak = std::max(tailPeak, std::abs(irL[static_cast<std::size_t>(i)]));
    REQUIRE(tailPeak < headPeak * 0.01f);
    double sumSq = 0.0;
    for (int i = 0; i < len; ++i)
        sumSq += static_cast<double>(irL[static_cast<std::size_t>(i)]) *
                     static_cast<double>(irL[static_cast<std::size_t>(i)]) +
                 static_cast<double>(irR[static_cast<std::size_t>(i)]) *
                     static_cast<double>(irR[static_cast<std::size_t>(i)]);
    const float scale = ReverbFx::normalisationScale(sumSq, len, kSr);
    const double scaleD = static_cast<double>(scale);
    REQUIRE(scaleD ==
            Approx(std::pow(10.0, -58.0 / 20.0) / std::sqrt(sumSq / (2.0 * len)) * 44100.0 / kSr).epsilon(1e-5));

    // the device: DECAY 0.5 s (k3 = 4 → all three tiers in play), ROOM 50, PREDELAY 0; build until ready
    ReverbFx rv;
    rv.prepare(kSr, kBlock);
    rv.setParam(1, 0.0f, true);
    rv.setParam(2, 0.5f, true);
    std::vector<double> l(kBlock, 0.0), r(kBlock, 0.0);
    int blocks = 0;
    while (!rv.ready() && blocks < 4000)
    {
        std::fill(l.begin(), l.end(), 0.0);
        std::fill(r.begin(), r.end(), 0.0);
        rv.process(l.data(), r.data(), kBlock);
        ++blocks;
    }
    INFO("ready after " << blocks << " blocks");
    REQUIRE(rv.ready());
    REQUIRE(rv.irLength() == len);
    REQUIRE(static_cast<double>(rv.irScale()) == Approx(scaleD).epsilon(1e-6));
    // an impulse on both channels → the output IS scale · ir, sample by sample, head / tier 1 / tier 2 / tier 3
    const int total = len + 4096;
    std::vector<double> outL(static_cast<std::size_t>(total)), outR(static_cast<std::size_t>(total));
    int done = 0;
    while (done < total)
    {
        const int n = std::min(kBlock, total - done);
        std::fill(l.begin(), l.end(), 0.0);
        std::fill(r.begin(), r.end(), 0.0);
        if (done == 0)
            l[0] = r[0] = 1.0;
        rv.process(l.data(), r.data(), n);
        for (int i = 0; i < n; ++i)
        {
            outL[static_cast<std::size_t>(done + i)] = l[static_cast<std::size_t>(i)];
            outR[static_cast<std::size_t>(done + i)] = r[static_cast<std::size_t>(i)];
        }
        done += n;
    }
    double peak = 0.0;
    for (int i = 0; i < len; ++i)
        peak = std::max(peak, std::abs(static_cast<double>(irL[static_cast<std::size_t>(i)]) * scaleD));
    double errHead = 0.0, err1 = 0.0, err2 = 0.0, err3 = 0.0, errAfter = 0.0;
    for (int i = 0; i < total; ++i)
    {
        const double refL = i < len ? static_cast<double>(irL[static_cast<std::size_t>(i)]) * scaleD : 0.0;
        const double refR = i < len ? static_cast<double>(irR[static_cast<std::size_t>(i)]) * scaleD : 0.0;
        const double e = std::max(std::abs(outL[static_cast<std::size_t>(i)] - refL),
                                  std::abs(outR[static_cast<std::size_t>(i)] - refR));
        if (i < 128)
            errHead = std::max(errHead, e);
        else if (i < 512)
            err1 = std::max(err1, e);
        else if (i < 8192)
            err2 = std::max(err2, e);
        else if (i < len)
            err3 = std::max(err3, e);
        else
            errAfter = std::max(errAfter, e);
    }
    INFO("peak " << peak << " err head " << errHead << " tier1 " << err1 << " tier2 " << err2 << " tier3 " << err3
                 << " after " << errAfter);
    REQUIRE(errHead < peak * 1e-6);
    REQUIRE(err1 < peak * 1e-5);
    REQUIRE(err2 < peak * 1e-5);
    REQUIRE(err3 < peak * 1e-5);
    REQUIRE(errAfter < peak * 1e-5);
    REQUIRE(peak > 1e-4); // the thing is audible
    // PREDELAY 10 ms shifts the response by 480 samples
    rv.setParam(1, 10.0f, true);
    for (int b = 0; b < 20; ++b)
    {
        std::fill(l.begin(), l.end(), 0.0);
        std::fill(r.begin(), r.end(), 0.0);
        rv.process(l.data(), r.data(), kBlock);
    }
    // flush the ringing tail: 0.5 s of silence, then the impulse
    for (int b = 0; b < static_cast<int>(kSr * 0.6 / kBlock); ++b)
    {
        std::fill(l.begin(), l.end(), 0.0);
        std::fill(r.begin(), r.end(), 0.0);
        rv.process(l.data(), r.data(), kBlock);
    }
    std::vector<double> shifted(static_cast<std::size_t>(2048));
    done = 0;
    while (done < 2048)
    {
        std::fill(l.begin(), l.end(), 0.0);
        std::fill(r.begin(), r.end(), 0.0);
        if (done == 0)
            l[0] = r[0] = 1.0;
        rv.process(l.data(), r.data(), kBlock);
        for (int i = 0; i < kBlock; ++i)
            shifted[static_cast<std::size_t>(done + i)] = l[static_cast<std::size_t>(i)];
        done += kBlock;
    }
    double errShift = 0.0;
    for (int i = 0; i < 1500; ++i)
        errShift = std::max(errShift, std::abs(shifted[static_cast<std::size_t>(i + 480)] -
                                               static_cast<double>(irL[static_cast<std::size_t>(i)]) * scaleD));
    REQUIRE(errShift < peak * 1e-4);
    double beforePre = 0.0;
    for (int i = 0; i < 480; ++i)
        beforePre = std::max(beforePre, std::abs(shifted[static_cast<std::size_t>(i)]));
    REQUIRE(beforePre < peak * 1e-4);
    // a DECAY change rebuilds into the other slot, arms, promotes, crossfades: ready again with the new length
    rv.setParam(2, 0.3f, true);
    REQUIRE_FALSE(rv.ready());
    blocks = 0;
    while (!rv.ready() && blocks < 4000)
    {
        std::fill(l.begin(), l.end(), 0.0);
        std::fill(r.begin(), r.end(), 0.0);
        rv.process(l.data(), r.data(), kBlock);
        ++blocks;
    }
    REQUIRE(rv.ready());
    REQUIRE(rv.irLength() == 14400);
}

// ---- the chain: latencies + the crossfade -----------------------------------------------------------------------

TEST_CASE("fx 4.2b: the chain reads each device's latency; WET devices crossfade in the chain", "[fx]")
{
    Engine engine;
    engine.prepare({kSr, 64, 2, 0});
    engine.commands().push(Command::mixerSetStrip(1, static_cast<std::uint8_t>(StripKind::channel)));
    engine.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::clip)));
    engine.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::comp)));
    engine.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::vinyl)));
    engine.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::delay)));
    std::vector<float> a(64), b(64);
    float* outs[2] = {a.data(), b.data()};
    engine.process(outs, 2, 64);
    REQUIRE(engine.mixer().chainLatencySamples(1) == 55 + 288 + 295);
    engine.commands().push(Command::mixerSetFxBypass(1, 1, true));
    engine.process(outs, 2, 64);
    REQUIRE(engine.mixer().chainLatencySamples(1) == 55 + 295);
    REQUIRE(engine.mixer().fx(1, 3)->wetMix() == Approx(0.3f));
}
