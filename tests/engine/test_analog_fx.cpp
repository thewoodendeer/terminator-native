// ANALOG FILTER (Phase 4.6a) — the premium Moog transistor ladder as a mixer insert. Every assertion is a number
// the model has to hit for the device to be worth shipping over the parity FILTER: the modes really are 24 / 18 /
// 12 / 6 dB per octave (and the highpass / bandpass shapes the tap mixer claims), the cutoff is where it says it
// is, RESO rings and then SELF-OSCILLATES at the cutoff from silence, DRIVE is colour rather than level, the 4×
// oversampling buys real aliasing rejection over the same model at 1×, the device is transparent when it is
// neutral, and it stays finite everywhere (rate sweep, block sizes, extreme settings) with ZERO reported latency.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <complex>
#include <memory>
#include <vector>

#include "terminator/core/fx/AnalogFx.h"
#include "terminator/core/fx/FxDsp.h"
#include "terminator/core/fx/FxPool.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;
constexpr int kBlock = 256;
constexpr double kTwoPi = 6.283185307179586;

/// Param indices (FxPool's kLadderParams).
enum
{
    kMode = 0,
    kCutoff,
    kReso,
    kDrive
};

std::unique_ptr<LadderFx> makeFx(int mode, float cutoff, float reso, float drive = 0.0f, double sr = kSr)
{
    auto fx = std::make_unique<LadderFx>();
    fx->prepare(sr, kBlock);
    fx->setParam(kMode, static_cast<float>(mode), true);
    fx->setParam(kCutoff, cutoff, true);
    fx->setParam(kReso, reso, true);
    fx->setParam(kDrive, drive, true);
    return fx;
}

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

/// Steady-state gain (dB) at `hz`: the response measured by correlating the tail against the drive tone, so
/// harmonics and the noise floor do not count towards it.
double gainDb(Effect& e, double hz, double amp = 0.1, double sr = kSr, double settleSec = 0.6)
{
    const int total = static_cast<int>(sr * (settleSec + 0.4));
    const int tail = static_cast<int>(sr * 0.4);
    const auto out = run(e, total, [&](int i) { return amp * std::sin(kTwoPi * hz * static_cast<double>(i) / sr); });
    double re = 0.0, im = 0.0;
    for (int i = total - tail; i < total; ++i)
    {
        const double ph = kTwoPi * hz * static_cast<double>(i) / sr;
        re += out[static_cast<std::size_t>(i)] * std::sin(ph);
        im += out[static_cast<std::size_t>(i)] * std::cos(ph);
    }
    const double mag = 2.0 * std::sqrt(re * re + im * im) / static_cast<double>(tail);
    return 20.0 * std::log10(std::max(mag, 1e-12) / amp);
}

/// The response at `hz` of a freshly built device (each measurement gets its own instance so nothing carries over).
double respDb(int mode, float cutoff, float reso, double hz, float drive = 0.0f)
{
    auto fx = makeFx(mode, cutoff, reso, drive);
    return gainDb(*fx, hz);
}

/// A sine generator for `run`.
auto tone(double hz, double amp, double sr = kSr)
{
    return [hz, amp, sr](int i) { return amp * std::sin(kTwoPi * hz * static_cast<double>(i) / sr); };
}

/// The magnitude (dBFS) at `hz` in the settled second half of a buffer — correlation, so one run measures the
/// fundamental and every harmonic separately.
double magDb(const std::vector<double>& out, double hz, double sr = kSr)
{
    const int from = static_cast<int>(out.size()) / 2, to = static_cast<int>(out.size());
    double re = 0.0, im = 0.0;
    for (int i = from; i < to; ++i)
    {
        const double ph = kTwoPi * hz * static_cast<double>(i) / sr;
        re += out[static_cast<std::size_t>(i)] * std::sin(ph);
        im += out[static_cast<std::size_t>(i)] * std::cos(ph);
    }
    const double mag = 2.0 * std::sqrt(re * re + im * im) / static_cast<double>(to - from);
    return 20.0 * std::log10(std::max(mag, 1e-12));
}

/// Peak of |x| over [from, to) of a plain vector.
double peak(const std::vector<double>& v, int from, int to)
{
    double m = 0.0;
    for (int i = std::max(0, from); i < std::min(to, static_cast<int>(v.size())); ++i)
        m = std::max(m, std::abs(v[static_cast<std::size_t>(i)]));
    return m;
}

double rms(const std::vector<double>& v, int from, int to)
{
    double s = 0.0;
    for (int i = from; i < to; ++i)
        s += v[static_cast<std::size_t>(i)] * v[static_cast<std::size_t>(i)];
    return std::sqrt(s / static_cast<double>(to - from));
}

/// Zero-crossing rate → Hz, over the second half of a buffer.
double dominantHz(const std::vector<double>& v, double sr)
{
    const int from = static_cast<int>(v.size()) / 2, to = static_cast<int>(v.size());
    int crossings = 0;
    for (int i = from + 1; i < to; ++i)
        if ((v[static_cast<std::size_t>(i - 1)] <= 0.0) != (v[static_cast<std::size_t>(i)] <= 0.0))
            ++crossings;
    return 0.5 * static_cast<double>(crossings) * sr / static_cast<double>(to - from);
}

/// Total power (dB, relative to the fundamental) that is NOT at a harmonic of `hz` — the aliasing floor.
double aliasFloorDb(const std::vector<double>& out, double hz, double sr)
{
    constexpr int n = 1 << 14; // 16384 samples of the settled tail
    const int from = static_cast<int>(out.size()) - n;
    std::vector<double> re(n), im(n, 0.0);
    for (int i = 0; i < n; ++i) // Hann
        re[static_cast<std::size_t>(i)] =
            out[static_cast<std::size_t>(from + i)] *
            (0.5 - 0.5 * std::cos(kTwoPi * static_cast<double>(i) / static_cast<double>(n)));
    Fft fft;
    fft.prepare(n);
    fft.transform(re.data(), im.data(), false);
    double fund = 0.0, junk = 0.0;
    const double binHz = sr / static_cast<double>(n);
    for (int k = 1; k < n / 2; ++k)
    {
        const double p = re[static_cast<std::size_t>(k)] * re[static_cast<std::size_t>(k)] +
                         im[static_cast<std::size_t>(k)] * im[static_cast<std::size_t>(k)];
        const double f = static_cast<double>(k) * binHz;
        const double h = f / hz;
        const bool harmonic = std::abs(h - std::round(h)) < 0.02 && std::round(h) >= 1.0;
        if (std::abs(f - hz) < 3.0 * binHz)
            fund += p;
        else if (!harmonic && f > 40.0)
            junk += p;
    }
    return 10.0 * std::log10(std::max(junk, 1e-30) / std::max(fund, 1e-30));
}
} // namespace

TEST_CASE("analog filter is registered with the page's ids and ranges", "[fx][analog]")
{
    REQUIRE(fxTypeFromId("ladder") == FxType::ladder);
    const auto& info = fxTypeInfo(FxType::ladder);
    REQUIRE(info.numParams == 5);
    REQUIRE(info.wetParam == 4); // the CHAIN crossfades WET
    REQUIRE(fxParamIndex(FxType::ladder, "MODE") == 0);
    REQUIRE(fxParamIndex(FxType::ladder, "CUTOFF") == 1);
    REQUIRE(fxParamIndex(FxType::ladder, "RESO") == 2);
    REQUIRE(fxParamIndex(FxType::ladder, "DRIVE") == 3);
    REQUIRE(fxOptionIndex(FxType::ladder, 0, "LP24") == 0);
    REQUIRE(fxOptionIndex(FxType::ladder, 0, "BP12") == 7);
    REQUIRE(FxPool::isPorted(FxType::ladder));

    // A pool-built device is the real thing, not a pass-through, and costs the strip no PDC.
    FxPool pool;
    pool.prepare(kSr, kBlock);
    auto* fx = pool.acquire(FxType::ladder);
    REQUIRE(fx != nullptr);
    REQUIRE(fx->type() == FxType::ladder);
    REQUIRE(fx->latencySamples() == 0);
    pool.release(fx);
}

TEST_CASE("the ladder modes really are 24 / 18 / 12 / 6 dB per octave", "[fx][analog]")
{
    // The octave measured is 8·fc → 16·fc: a cascade of one-poles only reaches its asymptotic slope well past the
    // corner (between 2·fc and 4·fc even a perfect 4-pole reads −21 dB, which is arithmetic, not a fault). 400 Hz
    // keeps both points far below the rate's own corner.
    constexpr double fc = 400.0;
    const double lp24 = respDb(0, fc, 0.0f, 16.0 * fc) - respDb(0, fc, 0.0f, 8.0 * fc);
    const double lp18 = respDb(1, fc, 0.0f, 16.0 * fc) - respDb(1, fc, 0.0f, 8.0 * fc);
    const double lp12 = respDb(2, fc, 0.0f, 16.0 * fc) - respDb(2, fc, 0.0f, 8.0 * fc);
    const double lp6 = respDb(3, fc, 0.0f, 16.0 * fc) - respDb(3, fc, 0.0f, 8.0 * fc);
    CHECK(lp24 == Approx(-24.0).margin(2.0));
    CHECK(lp18 == Approx(-18.0).margin(2.0));
    CHECK(lp12 == Approx(-12.0).margin(2.0));
    CHECK(lp6 == Approx(-6.0).margin(2.0));

    // …and the highpass / bandpass shapes the tap mixer builds out of the same four stages.
    const double hp24 = respDb(4, fc, 0.0f, fc / 8.0) - respDb(4, fc, 0.0f, fc / 16.0);
    const double hp12 = respDb(5, fc, 0.0f, fc / 8.0) - respDb(5, fc, 0.0f, fc / 16.0);
    CHECK(hp24 == Approx(24.0).margin(3.0));
    CHECK(hp12 == Approx(12.0).margin(3.0));
    // BP peaks at the cutoff and falls away on both sides.
    const double bpMid = respDb(7, fc, 0.0f, fc), bpLo = respDb(7, fc, 0.0f, fc / 8.0),
                 bpHi = respDb(7, fc, 0.0f, 8.0 * fc);
    CHECK(bpMid > bpLo + 12.0);
    CHECK(bpMid > bpHi + 12.0);
}

TEST_CASE("the cutoff is where the knob says it is", "[fx][analog]")
{
    // A 4-pole ladder at zero resonance is ≈ −12 dB at its own cutoff (−3 dB per pole).
    for (const double fc : {200.0, 1000.0, 6000.0})
    {
        const double at = respDb(0, static_cast<float>(fc), 0.0f, fc);
        CHECK(at == Approx(-12.0).margin(3.0));
        CHECK(respDb(0, static_cast<float>(fc), 0.0f, fc / 8.0) == Approx(0.0).margin(1.0)); // flat well below
    }
}

TEST_CASE("RESO rings at the cutoff and self-oscillates from silence at the top", "[fx][analog]")
{
    constexpr double fc = 800.0;
    const double flat = respDb(0, fc, 0.0f, fc);
    const double rung = respDb(0, fc, 70.0f, fc);
    CHECK(rung > flat + 8.0); // the peak the parity FILTER's Q cannot reach without ringing wrong

    // Classic ladder behaviour: resonance steals the bottom end (the feedback path divides DC by 1 + res).
    CHECK(respDb(0, fc, 90.0f, 50.0) < respDb(0, fc, 0.0f, 50.0) - 6.0);

    // RESO 100 with NO input at all: the model's own noise floor bootstraps a sine at the cutoff.
    auto fx = makeFx(0, static_cast<float>(fc), 100.0f);
    const auto out = run(*fx, static_cast<int>(kSr * 3.0), [](int) { return 0.0; });
    const double level = rms(out, static_cast<int>(kSr * 2.0), static_cast<int>(kSr * 3.0));
    CHECK(level > 0.02);
    CHECK(level < 2.0); // bounded by the stage saturation, never a runaway
    CHECK(dominantHz(out, kSr) == Approx(fc).epsilon(0.15));

    // …and it is silent when the resonance is not up (no noise floor anybody can hear).
    auto quiet = makeFx(0, static_cast<float>(fc), 0.0f);
    const auto sil = run(*quiet, static_cast<int>(kSr * 0.5), [](int) { return 0.0; });
    CHECK(rms(sil, 0, static_cast<int>(kSr * 0.5)) < 1e-4);
}

TEST_CASE("DRIVE is colour, not level", "[fx][analog]")
{
    // Same 100 Hz tone, cutoff wide open, DRIVE 0 vs 100.
    auto clean = makeFx(0, 20000.0f, 0.0f, 0.0f);
    auto dirty = makeFx(0, 20000.0f, 0.0f, 100.0f);
    const auto outClean = run(*clean, static_cast<int>(kSr), tone(100.0, 0.2));
    const auto outDirty = run(*dirty, static_cast<int>(kSr), tone(100.0, 0.2));

    const double f0Clean = magDb(outClean, 100.0), f0Dirty = magDb(outDirty, 100.0);
    CHECK(std::abs(f0Dirty - f0Clean) < 6.0); // level compensated: DRIVE is not a volume knob

    // The harmonics are the point. A ladder ALONE cannot do this — inside the loop the tanh cancels for anything
    // under the cutoff — so this number is what proves the input stage in front of it is really there.
    const double h3Dirty = magDb(outDirty, 300.0) - f0Dirty;
    const double h3Clean = magDb(outClean, 300.0) - f0Clean;
    CHECK(h3Dirty > -30.0);
    // DRIVE 0 is not distortion-free — the ladder's own stages are tanhs, and ~−60 dB of 3rd is exactly the
    // character the model exists for. What matters is that DRIVE is a 20 dB move on top of it.
    CHECK(h3Clean < -45.0);
    CHECK(h3Dirty > h3Clean + 20.0);
}

TEST_CASE("4× oversampling buys real aliasing rejection", "[fx][analog]")
{
    // 6 kHz driven hard: at 1× the folded harmonics would land all over the spectrum. Measured through the device
    // (4×) the non-harmonic floor has to sit far below the fundamental.
    auto fx = makeFx(0, 20000.0f, 0.0f, 100.0f);
    const int total = static_cast<int>(kSr * 1.0);
    const auto out =
        run(*fx, total, [](int i) { return 0.5 * std::sin(kTwoPi * 6000.0 * static_cast<double>(i) / kSr); });
    const double floorDb = aliasFloorDb(out, 6000.0, kSr);
    CHECK(floorDb < -45.0);
}

TEST_CASE("neutral settings are transparent", "[fx][analog]")
{
    // CUTOFF wide open, RESO 0, DRIVE 0: the device passes the band it is not filtering.
    auto fx = makeFx(0, 20000.0f, 0.0f, 0.0f);
    CHECK(gainDb(*fx, 1000.0) == Approx(0.0).margin(0.5));
    auto fx2 = makeFx(0, 20000.0f, 0.0f, 0.0f);
    CHECK(gainDb(*fx2, 100.0) == Approx(0.0).margin(0.5));
    auto fx3 = makeFx(0, 20000.0f, 0.0f, 0.0f);
    CHECK(gainDb(*fx3, 2000.0) == Approx(0.0).margin(1.0));
    // …and WIDE OPEN IS NOT BYPASS, which is the honest analog answer: four poles at 20 kHz still cost ~4 dB at
    // 8 kHz. Anyone who wants the top back moves the cutoff, and the number must not drift.
    auto fx4 = makeFx(0, 20000.0f, 0.0f, 0.0f);
    CHECK(gainDb(*fx4, 8000.0) == Approx(-3.9).margin(1.5));
}

TEST_CASE("the ladder stays finite everywhere", "[fx][analog]")
{
    for (const double sr : {44100.0, 48000.0, 96000.0, 192000.0})
    {
        auto fx = makeFx(0, 20000.0f, 100.0f, 100.0f, sr);
        for (int mode = 0; mode < 8; ++mode)
        {
            fx->setParam(kMode, static_cast<float>(mode), true);
            // A full-scale square through every mode at maximum resonance and drive, sweeping the cutoff.
            int i = 0;
            const int total = static_cast<int>(sr * 0.25);
            const auto out = run(
                *fx, total,
                [&](int k)
                {
                    fx->setParam(kCutoff, 20.0f + 19980.0f * static_cast<float>(k % 2000) / 2000.0f, false);
                    ++i;
                    return (k / 64) % 2 == 0 ? 1.0 : -1.0;
                },
                64);
            for (const double v : out)
            {
                REQUIRE(std::isfinite(v));
                REQUIRE(std::abs(v) < 32.0);
            }
        }
    }
}

TEST_CASE("reset clears the ladder", "[fx][analog]")
{
    auto fx = makeFx(0, 500.0f, 100.0f, 100.0f);
    run(*fx, static_cast<int>(kSr * 0.5),
        [](int i) { return 0.9 * std::sin(kTwoPi * 60.0 * static_cast<double>(i) / kSr); });
    fx->reset();
    CHECK(fx->param(kMode) == 0.0f);
    CHECK(fx->param(kCutoff) == Approx(20000.0f));
    CHECK(fx->param(kReso) == Approx(0.0f));
    CHECK(fx->param(kDrive) == Approx(0.0f));
    const auto out = run(*fx, 4096, [](int) { return 0.0; });
    CHECK(rms(out, 0, 4096) < 1e-4);
}

TEST_CASE("block size does not change the sound", "[fx][analog]")
{
    const auto gen = [](int i) { return 0.4 * std::sin(kTwoPi * 220.0 * static_cast<double>(i) / kSr); };
    auto a = makeFx(0, 1200.0f, 60.0f, 40.0f);
    auto b = makeFx(0, 1200.0f, 60.0f, 40.0f);
    const auto outA = run(*a, 8192, gen, 8192);
    const auto outB = run(*b, 8192, gen, 37); // a deliberately awkward block
    for (std::size_t i = 0; i < outA.size(); ++i)
        REQUIRE(outA[i] == Approx(outB[i]).margin(1e-9));
}

// ---- FET COMP (4.6c) -------------------------------------------------------------------------------------------
// The premium dynamics device. What has to be true for it to be worth reaching for over the parity COMP: the RATIO
// switch really is that ratio, the attack and release land on the times they claim, the DETECT filter changes what
// the side chain hears (a kick stops ducking everything), the MODE harmonics are the harmonics they say they are,
// NUKE pins it without blowing up, and 1:1 CLEAN is bit-exact — a compressor has to be able to do nothing.

namespace
{
enum
{
    kRatio = 0,
    kInput,
    kAtk,
    kRel,
    kDetect,
    kCompMode,
    kOut
};

std::unique_ptr<FetCompFx> makeComp(int ratio, float inputDb, float atkMs = 3.0f, float relMs = 150.0f, int detect = 0,
                                    int mode = 0, double sr = kSr)
{
    auto fx = std::make_unique<FetCompFx>();
    fx->prepare(sr, kBlock);
    fx->setParam(kRatio, static_cast<float>(ratio), true);
    fx->setParam(kInput, inputDb, true);
    fx->setParam(kAtk, atkMs, true);
    fx->setParam(kRel, relMs, true);
    fx->setParam(kDetect, static_cast<float>(detect), true);
    fx->setParam(kCompMode, static_cast<float>(mode), true);
    fx->setParam(kOut, 0.0f, true);
    return fx;
}

/// dBFS of a settled sine's fundamental after `sec` through `e`.
double outDb(Effect& e, double hz, double ampDb, double sec = 1.0)
{
    const double amp = std::pow(10.0, ampDb / 20.0);
    const auto out = run(e, static_cast<int>(kSr * sec), tone(hz, amp));
    return magDb(out, hz);
}
} // namespace

TEST_CASE("fet comp: the ratio switch is the ratio", "[fx][analog][comp]")
{
    REQUIRE(fxTypeFromId("fetcomp") == FxType::fetcomp);
    const auto& info = fxTypeInfo(FxType::fetcomp);
    REQUIRE(info.numParams == 8);
    REQUIRE(info.wetParam == 7);
    REQUIRE(fxOptionIndex(FxType::fetcomp, 0, "NUKE") == 7);
    REQUIRE(fxOptionIndex(FxType::fetcomp, 4, "HP2") == 2);
    REQUIRE(fxOptionIndex(FxType::fetcomp, 5, "BRITISH") == 3);

    // The threshold is fixed at −18 dBFS and you drive into it. A −6 dBFS tone sits 12 dB over, so at ratio R the
    // output should land 12/R dB above the threshold — measured past the knee, which the high ratios have almost
    // none of.
    struct Case
    {
        int idx;
        double ratio;
    };
    for (const Case c : {Case{3, 4.0}, Case{5, 10.0}, Case{6, 20.0}})
    {
        auto fx = makeComp(c.idx, 0.0f);
        const double got = outDb(*fx, 220.0, -6.0, 1.5);
        const double want = -18.0 + 12.0 / c.ratio;
        CHECK(got == Approx(want).margin(1.5));
    }
    // …and a quiet signal under the threshold passes at unity whatever the switch says.
    auto quiet = makeComp(6, 0.0f);
    CHECK(outDb(*quiet, 220.0, -30.0, 1.0) == Approx(-30.0).margin(0.5));
}

TEST_CASE("fet comp: 1:1 CLEAN is bit-exact", "[fx][analog][comp]")
{
    // A compressor must be able to do nothing: no gain, no colour, no gain reduction.
    auto fx = makeComp(0, 0.0f);
    const int n = 4096;
    std::vector<double> l(n), r(n), inL(n);
    for (int i = 0; i < n; ++i)
    {
        inL[static_cast<std::size_t>(i)] = 0.7 * std::sin(kTwoPi * 300.0 * static_cast<double>(i) / kSr);
        l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] = inL[static_cast<std::size_t>(i)];
    }
    fx->process(l.data(), r.data(), n);
    for (int i = 0; i < n; ++i)
        REQUIRE(l[static_cast<std::size_t>(i)] == Approx(inL[static_cast<std::size_t>(i)]).margin(1e-9));
    CHECK(fx->gainReductionDb() == Approx(0.0f).margin(1e-6f));
    CHECK(fx->latencySamples() == 0); // feed-forward FET: no look-ahead to declare
}

TEST_CASE("fet comp: attack and release land on their times", "[fx][analog][comp]")
{
    // A step from silence to −6 dBFS: the gain reduction should reach ~63 % of its final value in one ATTACK.
    const auto stepAt = [](FetCompFx& fx, double atkSec, double holdSec)
    {
        const double amp = std::pow(10.0, -6.0 / 20.0);
        const int hold = static_cast<int>(kSr * holdSec);
        std::vector<double> l(static_cast<std::size_t>(hold)), r(static_cast<std::size_t>(hold));
        for (int i = 0; i < hold; ++i)
            l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] =
                amp * std::sin(kTwoPi * 400.0 * static_cast<double>(i) / kSr);
        const int oneAttack = static_cast<int>(kSr * atkSec);
        fx.process(l.data(), r.data(), oneAttack);
        const double atAttack = static_cast<double>(fx.gainReductionDb());
        fx.process(l.data() + oneAttack, r.data() + oneAttack, hold - oneAttack);
        return std::pair<double, double>{atAttack, static_cast<double>(fx.gainReductionDb())};
    };
    auto slow = makeComp(5, 0.0f, 20.0f, 400.0f);
    const auto [atAtk, settled] = stepAt(*slow, 0.020, 0.9);
    REQUIRE(settled < -3.0);                             // it IS compressing
    CHECK(atAtk / settled == Approx(0.63).margin(0.15)); // one time constant in

    // RELEASE: cut the input and the gain must come most of the way back within ~3 release constants.
    const auto silence = run(*slow, static_cast<int>(kSr * 0.9), [](int) { return 0.0; });
    (void)silence;
    CHECK(static_cast<double>(slow->gainReductionDb()) > settled * 0.25);

    // A fast attack catches more of a transient than a slow one — the knob does what its name says.
    auto fast = makeComp(5, 0.0f, 0.1f, 400.0f);
    auto lazy = makeComp(5, 0.0f, 30.0f, 400.0f);
    const auto burst = [](int i) { return i < 480 ? 0.9 : 0.0; };
    const auto f = run(*fast, 4800, burst);
    const auto s2 = run(*lazy, 4800, burst);
    CHECK(peak(f, 0, 480) < peak(s2, 0, 480));
}

TEST_CASE("fet comp: DETECT changes what the side chain hears", "[fx][analog][comp]")
{
    // 50 Hz at −6 dBFS. FLAT hears all of it and clamps down; HP2 barely hears it, so the same bass note ducks the
    // track far less — which is the whole point of a detector filter.
    auto flat = makeComp(5, 0.0f, 3.0f, 150.0f, 0);
    auto hp2 = makeComp(5, 0.0f, 3.0f, 150.0f, 2);
    const double gFlat = outDb(*flat, 50.0, -6.0, 1.2);
    const double gHp2 = outDb(*hp2, 50.0, -6.0, 1.2);
    CHECK(gHp2 > gFlat + 5.0);
    // BAND leans on the presence region: a 2.5 kHz tone compresses MORE than at FLAT.
    auto band = makeComp(5, 0.0f, 3.0f, 150.0f, 3);
    auto flat2 = makeComp(5, 0.0f, 3.0f, 150.0f, 0);
    CHECK(outDb(*band, 2500.0, -12.0, 1.2) < outDb(*flat2, 2500.0, -12.0, 1.2) - 1.5);
}

TEST_CASE("fet comp: the MODE harmonics are the harmonics they claim", "[fx][analog][comp]")
{
    const auto harmonics = [](int mode)
    {
        auto fx = makeComp(1, 0.0f, 3.0f, 150.0f, 0, mode);
        const auto out = run(*fx, static_cast<int>(kSr * 0.6), tone(200.0, 0.35));
        const double f0 = magDb(out, 200.0);
        return std::pair<double, double>{magDb(out, 400.0) - f0, magDb(out, 600.0) - f0};
    };
    const auto [clean2, clean3] = harmonics(0);
    CHECK(clean2 < -80.0); // CLEAN really is clean
    CHECK(clean3 < -80.0);
    const auto [d2h2, d2h3] = harmonics(1);
    CHECK(d2h2 > -40.0);      // DIST 2 puts a 2nd harmonic there…
    CHECK(d2h2 > d2h3 + 6.0); // …and more of it than 3rd
    const auto [d3h2, d3h3] = harmonics(2);
    CHECK(d3h3 > -40.0);
    CHECK(d3h3 > d3h2 + 6.0); // DIST 3 the other way round
    const auto [brit2, brit3] = harmonics(3);
    CHECK(std::max(brit2, brit3) > -35.0); // BRITISH is the dirty one
}

TEST_CASE("fet comp: no mode leaves DC behind", "[fx][analog][comp]")
{
    // DIST 2 is an EVEN shaper, and an even shaper always makes DC — the blocker has to take it out. Left in, a
    // constant offset eats headroom, thumps on every bypass and is inaudible until a bounce clips for no reason.
    // (A fixed correction constant is not a fix: it was −0.125 on SILENCE before this gate existed.)
    for (int mode = 0; mode < 4; ++mode)
    {
        auto fx = makeComp(3, 6.0f, 3.0f, 150.0f, 0, mode);
        const auto sil = run(*fx, static_cast<int>(kSr * 0.3), [](int) { return 0.0; });
        double mean = 0.0;
        for (const double v : sil)
            mean += v;
        CHECK(std::abs(mean / static_cast<double>(sil.size())) < 1e-5);

        auto fx2 = makeComp(3, 6.0f, 3.0f, 150.0f, 0, mode);
        const auto sine = run(*fx2, static_cast<int>(kSr * 0.5), tone(120.0, 0.5));
        double m2 = 0.0;
        const int from = static_cast<int>(kSr * 0.25);
        for (int i = from; i < static_cast<int>(sine.size()); ++i)
            m2 += sine[static_cast<std::size_t>(i)];
        CHECK(std::abs(m2 / static_cast<double>(static_cast<int>(sine.size()) - from)) < 2e-3);
    }
}

TEST_CASE("fet comp: NUKE pins it, and nothing blows up", "[fx][analog][comp]")
{
    auto nuke = makeComp(7, 12.0f, 1.0f, 200.0f);
    const auto out = run(*nuke, static_cast<int>(kSr * 1.0), tone(150.0, 0.7));
    CHECK(nuke->gainReductionDb() < -20.0f); // it really is pinned
    for (const double v : out)
    {
        REQUIRE(std::isfinite(v));
        REQUIRE(std::abs(v) < 8.0);
    }
    // Every ratio × mode × detector at every rate, full scale in: finite and bounded.
    for (const double sr : {44100.0, 48000.0, 96000.0})
        for (int ratio = 0; ratio < 8; ++ratio)
            for (int mode = 0; mode < 4; ++mode)
            {
                auto fx = makeComp(ratio, 24.0f, 0.05f, 20.0f, ratio % 4, mode, sr);
                const auto o =
                    run(*fx, static_cast<int>(sr * 0.1), [](int i) { return (i / 32) % 2 == 0 ? 1.0 : -1.0; }, 64);
                for (const double v : o)
                {
                    REQUIRE(std::isfinite(v));
                    REQUIRE(std::abs(v) < 24.0); // INPUT +24 dB is ×15.8 before the attack has caught it
                }
            }
}

TEST_CASE("fet comp: INPUT and OUTPUT are the two ends", "[fx][analog][comp]")
{
    // There is no threshold: INPUT is how hard it works. +12 dB in must produce clearly more gain reduction.
    auto soft = makeComp(4, 0.0f);
    auto hard = makeComp(4, 12.0f);
    const double a = outDb(*soft, 300.0, -18.0, 1.2);
    const double b = outDb(*hard, 300.0, -18.0, 1.2);
    CHECK(soft->gainReductionDb() > hard->gainReductionDb() + 3.0f);
    CHECK(b > a); // driven harder it is still louder out, just more squashed
    // OUTPUT is a clean trim: +6 dB out is +6 dB, nothing else.
    auto trim = makeComp(0, 0.0f);
    trim->setParam(kOut, 6.0f, true);
    CHECK(outDb(*trim, 300.0, -30.0, 0.5) == Approx(-24.0).margin(0.3));
}
