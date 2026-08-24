// ANALOG FILTER (Phase 4.6a) — the premium Moog transistor ladder as a mixer insert. Every assertion is a number
// the model has to hit for the device to be worth shipping over the parity FILTER: the modes really are 24 / 18 /
// 12 / 6 dB per octave (and the highpass / bandpass shapes the tap mixer claims), the cutoff is where it says it
// is, RESO rings and then SELF-OSCILLATES at the cutoff from silence, DRIVE is colour rather than level, the 4×
// oversampling buys real aliasing rejection over the same model at 1×, the device is transparent when it is
// neutral, and it stays finite everywhere (rate sweep, block sizes, extreme settings) with ZERO reported latency.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
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
constexpr double kHalfPiT = 1.5707963267948966; // one quarter of the sample rate, in radians per sample

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

TEST_CASE("4x oversampling buys real aliasing rejection", "[fx][analog]") // ASCII: MSVC cannot filter a non-ASCII name
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

// ---- TAPE ECHO (4.6d) ------------------------------------------------------------------------------------------
// The RE-201. What has to be true: the heads are WHERE they say (one tape, three fixed spacings, which is the whole
// reason the multi-head modes sound the way they do), INTENSITY really is feedback and runs away at the top without
// blowing up, each pass through the loop is darker than the last, WOW moves the tape and 0 means dead steady, SAT
// thickens, the tone controls do what they say, and TIME is a MOTOR — moving it bends pitch instead of jumping.

namespace
{
enum
{
    kTapeMode = 0,
    kTapeTime,
    kIntensity,
    kWow,
    kSat,
    kBass,
    kTreble,
    kSpring
};

std::unique_ptr<TapeEchoFx> makeTape(int mode, float timeMs, float intensity, float wow = 0.0f, float sat = 0.0f,
                                     double sr = kSr)
{
    auto fx = std::make_unique<TapeEchoFx>();
    fx->prepare(sr, kBlock);
    fx->setParam(kTapeMode, static_cast<float>(mode), true);
    fx->setParam(kTapeTime, timeMs, true);
    fx->setParam(kIntensity, intensity, true);
    fx->setParam(kWow, wow, true);
    fx->setParam(kSat, sat, true);
    fx->setParam(kBass, 0.0f, true);
    fx->setParam(kTreble, 0.0f, true);
    fx->setParam(kSpring, 0.0f, true);
    return fx;
}

/// The sample positions of the peaks in `out` that stand above `floorFrac` of the biggest one, at least `minGap`
/// samples apart — the echoes.
std::vector<int> echoPositions(const std::vector<double>& out, double floorFrac, int minGap)
{
    const double top = peak(out, 0, static_cast<int>(out.size()));
    std::vector<int> hits;
    int i = 1;
    while (i < static_cast<int>(out.size()) - 1)
    {
        const double a = std::abs(out[static_cast<std::size_t>(i)]);
        if (a > floorFrac * top && a >= std::abs(out[static_cast<std::size_t>(i - 1)]) &&
            a >= std::abs(out[static_cast<std::size_t>(i + 1)]))
        {
            hits.push_back(i);
            i += minGap;
            continue;
        }
        ++i;
    }
    return hits;
}

/// A single-sample impulse generator.
auto impulse()
{
    return [](int i) { return i == 0 ? 1.0 : 0.0; };
}

/// Energy above `hz` as a fraction of the total, over [from, to) — "how bright is this stretch".
double hfFraction(const std::vector<double>& out, int from, int to, double hz, double sr)
{
    // one-pole HP vs the raw energy; enough to compare two stretches of the same signal
    double prevX = 0.0, y = 0.0, hf = 0.0, all = 0.0;
    const double a = std::exp(-kTwoPi * hz / sr);
    for (int i = from; i < to; ++i)
    {
        const double x = out[static_cast<std::size_t>(i)];
        y = a * (y + x - prevX);
        prevX = x;
        hf += y * y;
        all += x * x;
    }
    return all > 0.0 ? hf / all : 0.0;
}
} // namespace

TEST_CASE("tape echo: the three heads are where they say they are", "[fx][analog][tape]")
{
    REQUIRE(fxTypeFromId("tapeecho") == FxType::tapeecho);
    const auto& info = fxTypeInfo(FxType::tapeecho);
    REQUIRE(info.numParams == 9);
    REQUIRE(info.wetParam == 8);
    REQUIRE(fxOptionIndex(FxType::tapeecho, 0, "H1+2+3") == 6);

    // MODE H1, TIME 200 ms, no feedback: exactly one echo, at 200 ms.
    auto h1 = makeTape(0, 200.0f, 0.0f);
    const auto a = run(*h1, static_cast<int>(kSr * 0.9), impulse());
    const auto pa = echoPositions(a, 0.35, 128);
    REQUIRE(pa.size() == 1);
    CHECK(pa[0] == Approx(static_cast<int>(kSr * 0.200)).margin(kSr * 0.004));

    // All three heads: three echoes, at ×1.0, ×1.6 and ×2.2 of the time — one tape, three fixed spacings.
    auto all = makeTape(6, 200.0f, 0.0f);
    const auto b = run(*all, static_cast<int>(kSr * 0.9), impulse());
    const auto pb = echoPositions(b, 0.35, 128);
    REQUIRE(pb.size() == 3);
    CHECK(pb[0] == Approx(static_cast<int>(kSr * 0.200)).margin(kSr * 0.004));
    CHECK(pb[1] == Approx(static_cast<int>(kSr * 0.320)).margin(kSr * 0.004));
    CHECK(pb[2] == Approx(static_cast<int>(kSr * 0.440)).margin(kSr * 0.004));

    // H2+3 skips the first head entirely — the pattern starts late, which is what the mode is for.
    auto h23 = makeTape(4, 200.0f, 0.0f);
    const auto c = run(*h23, static_cast<int>(kSr * 0.9), impulse());
    const auto pc = echoPositions(c, 0.35, 128);
    REQUIRE(pc.size() == 2);
    CHECK(pc[0] == Approx(static_cast<int>(kSr * 0.320)).margin(kSr * 0.004));
}

TEST_CASE("tape echo: INTENSITY is feedback, and the top of it runs away", "[fx][analog][tape]")
{
    // 0 = one repeat only (already gated above). Half way up = a decaying train of them.
    auto mid = makeTape(0, 120.0f, 50.0f);
    const auto out = run(*mid, static_cast<int>(kSr * 2.0), impulse());
    const auto hits = echoPositions(out, 0.06, 256);
    CHECK(hits.size() >= 4); // a train, not a slap
    // …each quieter than the one before it.
    for (std::size_t i = 1; i < hits.size() && i < 4; ++i)
        CHECK(std::abs(out[static_cast<std::size_t>(hits[i])]) < std::abs(out[static_cast<std::size_t>(hits[i - 1])]));

    // Wide open it self-oscillates — and the tape saturation is what keeps that a sound instead of an explosion.
    auto runaway = makeTape(0, 120.0f, 100.0f, 0.0f, 40.0f);
    const auto ro = run(*runaway, static_cast<int>(kSr * 6.0), impulse());
    const double late = rms(ro, static_cast<int>(kSr * 5.0), static_cast<int>(kSr * 6.0));
    CHECK(late > 0.02); // still going six seconds later
    for (const double v : ro)
    {
        REQUIRE(std::isfinite(v));
        REQUIRE(std::abs(v) < 4.0);
    }
}

TEST_CASE("tape echo: every pass is darker than the last", "[fx][analog][tape]")
{
    // The losses are INSIDE the loop, so repeat 4 has to be duller than repeat 1. This is the difference between a
    // tape echo and a digital delay with a filter on the output.
    auto fx = makeTape(0, 150.0f, 70.0f, 0.0f, 20.0f);
    const auto out = run(*fx, static_cast<int>(kSr * 2.0),
                         [](int i) { return i < 64 ? std::sin(kTwoPi * 3000.0 * static_cast<double>(i) / kSr) : 0.0; });
    const int one = static_cast<int>(kSr * 0.150), win = static_cast<int>(kSr * 0.05);
    const double first = hfFraction(out, one, one + win, 2000.0, kSr);
    const double fourth = hfFraction(out, 4 * one, 4 * one + win, 2000.0, kSr);
    CHECK(fourth < first);
}

TEST_CASE("tape echo: WOW moves the tape, and 0 is dead steady", "[fx][analog][tape]")
{
    // With no wow the same impulse lands on the same sample every pass; with wow up it wanders. Measured as the
    // spread of the gaps between repeats.
    const auto gaps = [](float wow)
    {
        auto fx = makeTape(0, 200.0f, 75.0f, wow);
        const auto out = run(*fx, static_cast<int>(kSr * 3.0), impulse());
        const auto hits = echoPositions(out, 0.05, 1024);
        std::vector<double> g;
        for (std::size_t i = 1; i < hits.size(); ++i)
            g.push_back(static_cast<double>(hits[i] - hits[i - 1]));
        double mean = 0.0;
        for (const double v : g)
            mean += v;
        mean /= static_cast<double>(std::max<std::size_t>(1, g.size()));
        double var = 0.0;
        for (const double v : g)
            var += (v - mean) * (v - mean);
        return std::sqrt(var / static_cast<double>(std::max<std::size_t>(1, g.size())));
    };
    const double steady = gaps(0.0f), wobbly = gaps(100.0f);
    INFO("steady " << steady << " vs wobbly " << wobbly);
    // NOT zero at WOW 0: every pass goes through the loop's filters again, so the peak of the pulse drifts a sample
    // or two as it dulls. That is the group delay of a real feedback loop, not the motor.
    CHECK(steady < 3.0);
    CHECK(wobbly > steady * 2.0); // the motor is audibly not steady
}

TEST_CASE("tape echo: SAT thickens and the tone controls work", "[fx][analog][tape]")
{
    // SAT puts harmonics on the repeats (the tape is driven, and every pass goes through it again).
    const auto thirdHarmonic = [](float sat)
    {
        auto fx = makeTape(0, 100.0f, 60.0f, 0.0f, sat);
        const auto out = run(*fx, static_cast<int>(kSr * 1.5), tone(300.0, 0.5));
        return magDb(out, 900.0) - magDb(out, 300.0);
    };
    CHECK(thirdHarmonic(100.0f) > thirdHarmonic(0.0f) + 6.0);

    // TREBLE is a shelf on the echo: +12 makes the repeats brighter than −12, by a lot.
    const auto bright = [](float treble)
    {
        auto fx = makeTape(0, 100.0f, 0.0f);
        fx->setParam(kTreble, treble, true);
        const auto out = run(*fx, static_cast<int>(kSr * 0.5), tone(6000.0, 0.3));
        return magDb(out, 6000.0);
    };
    CHECK(bright(12.0f) > bright(-12.0f) + 12.0);
}

TEST_CASE("tape echo: TIME is a motor, not a jump cut", "[fx][analog][tape]")
{
    // Moving TIME must GLIDE (τ 250 ms), which is what bends the pitch of what is already on the tape. A jump would
    // show up as the echo arriving at the new time immediately; a motor takes a moment to get there.
    auto fx = makeTape(0, 400.0f, 0.0f);
    run(*fx, static_cast<int>(kSr * 0.2), [](int) { return 0.0; });
    fx->setParam(kTapeTime, 100.0f, false);
    CHECK(fx->param(kTapeTime) == Approx(100.0f)); // the TARGET moves at once
    run(*fx, 256, [](int) { return 0.0; });
    // …but one block later the tape has barely begun to speed up, so an impulse still reads near the old time.
    const auto out = run(*fx, static_cast<int>(kSr * 0.6), impulse());
    const auto hits = echoPositions(out, 0.3, 256);
    REQUIRE(!hits.empty());
    CHECK(hits[0] > static_cast<int>(kSr * 0.15)); // nowhere near the new 100 ms yet
}

TEST_CASE("tape echo: SPRING adds the tank", "[fx][analog][tape]")
{
    // With the tank in, the space BETWEEN the repeats stops being silent — that diffuse wash is the whole point.
    auto dry = makeTape(0, 300.0f, 0.0f);
    auto wet = makeTape(0, 300.0f, 0.0f);
    wet->setParam(kSpring, 100.0f, true);
    const int from = static_cast<int>(kSr * 0.35), to = static_cast<int>(kSr * 0.5);
    const auto a = run(*dry, static_cast<int>(kSr * 0.6), impulse());
    const auto b = run(*wet, static_cast<int>(kSr * 0.6), impulse());
    CHECK(rms(b, from, to) > rms(a, from, to) * 4.0);
}

TEST_CASE("tape echo: finite everywhere, reset clears, blocks do not matter", "[fx][analog][tape]")
{
    for (const double sr : {44100.0, 48000.0, 96000.0})
        for (int mode = 0; mode < 7; ++mode)
        {
            auto fx = makeTape(mode, 20.0f, 100.0f, 100.0f, 100.0f, sr);
            const auto out =
                run(*fx, static_cast<int>(sr * 0.4), [](int i) { return (i / 16) % 2 == 0 ? 1.0 : -1.0; }, 64);
            for (const double v : out)
            {
                REQUIRE(std::isfinite(v));
                REQUIRE(std::abs(v) < 8.0);
            }
        }

    auto fx = makeTape(6, 250.0f, 90.0f, 50.0f, 50.0f);
    run(*fx, static_cast<int>(kSr * 0.5), tone(220.0, 0.8));
    fx->reset();
    CHECK(fx->param(kTapeTime) == Approx(350.0f));
    const auto quiet = run(*fx, static_cast<int>(kSr * 0.5), [](int) { return 0.0; });
    CHECK(rms(quiet, 0, static_cast<int>(kSr * 0.5)) < 1e-6);

    auto a = makeTape(6, 180.0f, 60.0f, 40.0f, 30.0f);
    auto b = makeTape(6, 180.0f, 60.0f, 40.0f, 30.0f);
    const auto ga = run(*a, 16384, tone(180.0, 0.4), 16384);
    const auto gb = run(*b, 16384, tone(180.0, 0.4), 41);
    for (std::size_t i = 0; i < ga.size(); ++i)
        REQUIRE(ga[i] == Approx(gb[i]).margin(1e-9));
}

// ---- HALL 224 (4.6e) -------------------------------------------------------------------------------------------
// The Lexicon programs on a Dattorro tank. The headline claim is that **DECAY is in SECONDS** — the loop gain is
// solved from the tank's round trip for the RT60 asked for — so that is the first thing gated. Then: PREDELAY lands
// where it says, a mono source comes back DECORRELATED (otherwise it is not a room), BASS really is a decay
// MULTIPLIER rather than an EQ, DAMP takes the top off the tail and not the front of it, DIFFUSION smears the early
// reflections, MOD keeps the tail from sitting still, and it stays finite.

namespace
{
enum
{
    kProgram = 0,
    kPredelay,
    kDecay,
    kSize,
    kDiffusion,
    kVBass,
    kDamp,
    kVMod
};

std::unique_ptr<PlateVerbFx> makeVerb(int program, float decaySec, float predelayMs = 0.0f, float mod = 0.0f,
                                      double sr = kSr)
{
    auto fx = std::make_unique<PlateVerbFx>();
    fx->prepare(sr, kBlock);
    fx->setParam(kProgram, static_cast<float>(program), true);
    fx->setParam(kPredelay, predelayMs, true);
    fx->setParam(kDecay, decaySec, true);
    fx->setParam(kSize, 70.0f, true);
    fx->setParam(kDiffusion, 70.0f, true);
    fx->setParam(kVBass, 1.0f, true);
    fx->setParam(kDamp, 40.0f, true);
    fx->setParam(kVMod, mod, true);
    return fx;
}

/// Seconds for the tail to fall 60 dB, measured off the decay slope: fit the level in 100 ms windows and read when
/// it crosses −60 dB of the loudest window.
double rt60Of(const std::vector<double>& out, double sr)
{
    const int win = static_cast<int>(sr * 0.1);
    const int wins = static_cast<int>(out.size()) / win;
    double top = 0.0;
    std::vector<double> lv;
    for (int w = 0; w < wins; ++w)
    {
        const double e = rms(out, w * win, (w + 1) * win);
        lv.push_back(e);
        top = std::max(top, e);
    }
    if (top <= 0.0)
        return 0.0;
    for (int w = 0; w < wins; ++w)
        if (lv[static_cast<std::size_t>(w)] < top * 0.001) // −60 dB
            return static_cast<double>(w) * 0.1;
    return static_cast<double>(wins) * 0.1;
}

/// Normalised correlation between two channels over [from, to).
double correlation(const std::vector<double>& a, const std::vector<double>& b, int from, int to)
{
    double ab = 0.0, aa = 0.0, bb = 0.0;
    for (int i = from; i < to; ++i)
    {
        const double x = a[static_cast<std::size_t>(i)], y = b[static_cast<std::size_t>(i)];
        ab += x * y;
        aa += x * x;
        bb += y * y;
    }
    return (aa > 0.0 && bb > 0.0) ? ab / std::sqrt(aa * bb) : 0.0;
}

/// Run an impulse through a stereo effect and return BOTH channels.
std::pair<std::vector<double>, std::vector<double>> runStereo(Effect& e, int total, int block = kBlock)
{
    std::vector<double> outL(static_cast<std::size_t>(total)), outR(static_cast<std::size_t>(total));
    std::vector<double> l(static_cast<std::size_t>(block)), r(static_cast<std::size_t>(block));
    int done = 0;
    while (done < total)
    {
        const int n = std::min(block, total - done);
        for (int i = 0; i < n; ++i)
        {
            const double v = (done + i) == 0 ? 1.0 : 0.0;
            l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] = v;
        }
        e.process(l.data(), r.data(), n);
        for (int i = 0; i < n; ++i)
        {
            outL[static_cast<std::size_t>(done + i)] = l[static_cast<std::size_t>(i)];
            outR[static_cast<std::size_t>(done + i)] = r[static_cast<std::size_t>(i)];
        }
        done += n;
    }
    return {outL, outR};
}
} // namespace

TEST_CASE("hall 224: DECAY is in seconds", "[fx][analog][verb]")
{
    REQUIRE(fxTypeFromId("plateverb") == FxType::plateverb);
    const auto& info = fxTypeInfo(FxType::plateverb);
    REQUIRE(info.numParams == 9);
    REQUIRE(info.wetParam == 8);
    REQUIRE(fxOptionIndex(FxType::plateverb, 0, "AMBIENCE") == 4);

    // The whole point of solving the loop gain from the tank's round trip: what the knob says is what it measures.
    for (const double want : {1.0, 3.0, 6.0})
    {
        auto fx = makeVerb(0, static_cast<float>(want));
        const auto out = run(*fx, static_cast<int>(kSr * (want + 3.0)), impulse());
        const double got = rt60Of(out, kSr);
        INFO("asked " << want << " s, measured " << got << " s");
        CHECK(got == Approx(want).epsilon(0.35));
    }
}

TEST_CASE("hall 224: a mono source comes back as a room", "[fx][analog][verb]")
{
    // Fed the same signal on both channels, the two outputs have to be DIFFERENT — that is the difference between
    // a reverb and a mono delay played out of two speakers.
    auto fx = makeVerb(0, 3.0f);
    const auto [outL, outR] = runStereo(*fx, static_cast<int>(kSr * 2.0));
    const int from = static_cast<int>(kSr * 0.2), to = static_cast<int>(kSr * 1.5);
    CHECK(std::abs(correlation(outL, outR, from, to)) < 0.5);
    CHECK(rms(outL, from, to) > 1e-5);
    CHECK(rms(outR, from, to) > 1e-5);
}

TEST_CASE("hall 224: PREDELAY holds the room back", "[fx][analog][verb]")
{
    auto none = makeVerb(0, 2.0f, 0.0f);
    auto late = makeVerb(0, 2.0f, 120.0f);
    const auto a = run(*none, static_cast<int>(kSr * 0.5), impulse());
    const auto b = run(*late, static_cast<int>(kSr * 0.5), impulse());
    const auto firstAbove = [](const std::vector<double>& v, double th)
    {
        for (int i = 0; i < static_cast<int>(v.size()); ++i)
            if (std::abs(v[static_cast<std::size_t>(i)]) > th)
                return i;
        return -1;
    };
    const int ta = firstAbove(a, 1e-4), tb = firstAbove(b, 1e-4);
    REQUIRE(ta >= 0);
    REQUIRE(tb >= 0);
    CHECK(tb - ta == Approx(static_cast<int>(kSr * 0.120)).margin(kSr * 0.01));
}

TEST_CASE("hall 224: BASS is a decay multiplier, not an EQ", "[fx][analog][verb]")
{
    // The test that separates the two: with BASS 4 the bottom must ring LONGER than the top, not merely louder.
    // Measured as the low-band share of the energy EARLY vs LATE in the same tail.
    const auto lowShareLate = [](float bass)
    {
        auto fx = makeVerb(0, 3.0f);
        fx->setParam(kVBass, bass, true);
        const auto out = run(*fx, static_cast<int>(kSr * 4.0), impulse());
        const int early = static_cast<int>(kSr * 0.3), late = static_cast<int>(kSr * 2.5);
        const int win = static_cast<int>(kSr * 0.4);
        // hfFraction is the high share; 1 − it is the low share.
        const double lowEarly = 1.0 - hfFraction(out, early, early + win, 500.0, kSr);
        const double lowLate = 1.0 - hfFraction(out, late, late + win, 500.0, kSr);
        return lowLate - lowEarly; // how much MORE of the tail is bottom by the end
    };
    CHECK(lowShareLate(4.0f) > lowShareLate(0.25f));
}

TEST_CASE("hall 224: DAMP takes the top off the tail", "[fx][analog][verb]")
{
    const auto brightness = [](float damp)
    {
        auto fx = makeVerb(0, 3.0f);
        fx->setParam(kDamp, damp, true);
        const auto out = run(*fx, static_cast<int>(kSr * 3.0), impulse());
        const int late = static_cast<int>(kSr * 1.5), win = static_cast<int>(kSr * 0.5);
        return hfFraction(out, late, late + win, 3000.0, kSr);
    };
    CHECK(brightness(100.0f) < brightness(0.0f));
}

TEST_CASE("hall 224: DIFFUSION smears the early reflections", "[fx][analog][verb]")
{
    // Low diffusion leaves distinct early events; high diffusion fills the gaps. Crest factor over the first
    // 60 ms is the measurement — spiky vs smooth.
    const auto crest = [](float diffusion)
    {
        auto fx = makeVerb(3, 2.0f); // ROOM: the early reflections are the audible part
        fx->setParam(kDiffusion, diffusion, true);
        const auto out = run(*fx, static_cast<int>(kSr * 0.5), impulse());
        const int to = static_cast<int>(kSr * 0.06);
        return peak(out, 0, to) / std::max(1e-12, rms(out, 0, to));
    };
    CHECK(crest(100.0f) < crest(0.0f));
}

TEST_CASE("hall 224: MOD keeps the tail moving", "[fx][analog][verb]")
{
    // With MOD 0 the tank is a fixed network and the tail is identical run to run; with MOD up the tail is
    // measurably different — which is what stops a long decay from turning into a ringing buzz.
    auto still = makeVerb(0, 4.0f, 0.0f, 0.0f);
    auto moving = makeVerb(0, 4.0f, 0.0f, 100.0f);
    const auto a = run(*still, static_cast<int>(kSr * 2.0), impulse());
    const auto b = run(*moving, static_cast<int>(kSr * 2.0), impulse());
    const int from = static_cast<int>(kSr * 1.0), to = static_cast<int>(kSr * 2.0);
    CHECK(std::abs(correlation(a, b, from, to)) < 0.9);
    // MOD 0 is deterministic — two instances agree sample for sample.
    auto still2 = makeVerb(0, 4.0f, 0.0f, 0.0f);
    const auto c = run(*still2, static_cast<int>(kSr * 0.5), impulse());
    for (int i = 0; i < static_cast<int>(kSr * 0.5); ++i)
        REQUIRE(a[static_cast<std::size_t>(i)] == Approx(c[static_cast<std::size_t>(i)]).margin(1e-12));
}

TEST_CASE("hall 224: every program is finite, and reset clears the tank", "[fx][analog][verb]")
{
    for (const double sr : {44100.0, 48000.0, 96000.0})
        for (int prog = 0; prog < 5; ++prog)
        {
            auto fx = makeVerb(prog, 20.0f, 250.0f, 100.0f, sr);
            const auto out =
                run(*fx, static_cast<int>(sr * 0.3), [](int i) { return (i / 16) % 2 == 0 ? 1.0 : -1.0; }, 64);
            for (const double v : out)
            {
                REQUIRE(std::isfinite(v));
                REQUIRE(std::abs(v) < 12.0);
            }
        }

    auto fx = makeVerb(0, 8.0f, 50.0f, 60.0f);
    run(*fx, static_cast<int>(kSr * 1.0), tone(300.0, 0.7));
    fx->reset();
    const auto quiet = run(*fx, static_cast<int>(kSr * 0.5), [](int) { return 0.0; });
    CHECK(rms(quiet, 0, static_cast<int>(kSr * 0.5)) < 1e-9);
}

// ---- SATURATOR (4.6f) ------------------------------------------------------------------------------------------
// Five flavours on one stage. The gates are the ones the earlier devices taught: DRIVE 0 must be BIT-clean (not
// nearly), no style may leave DC behind (the DIST 2 lesson), every curve must be bounded (the +24 dB lesson), and
// DRIVE must read as colour rather than level. On top of that each STYLE has to actually be a different flavour —
// tube and transformer lean even, console and germanium lean odd — or the switch is decoration.

namespace
{
enum
{
    kStyle = 0,
    kSatDrive,
    kTone,
    kLowCut,
    kHighCut,
    kPunish,
    kSatOut
};

std::unique_ptr<SaturatorFx> makeSat(int style, float drive, double sr = kSr)
{
    auto fx = std::make_unique<SaturatorFx>();
    fx->prepare(sr, kBlock);
    fx->setParam(kStyle, static_cast<float>(style), true);
    fx->setParam(kSatDrive, drive, true);
    fx->setParam(kTone, 0.0f, true);
    fx->setParam(kLowCut, 20.0f, true);
    fx->setParam(kHighCut, 20000.0f, true);
    fx->setParam(kPunish, 0.0f, true);
    fx->setParam(kSatOut, 0.0f, true);
    return fx;
}
} // namespace

TEST_CASE("saturator: DRIVE 0 is bit-clean", "[fx][analog][sat]")
{
    REQUIRE(fxTypeFromId("saturator") == FxType::saturator);
    REQUIRE(fxTypeInfo(FxType::saturator).numParams == 8);
    REQUIRE(fxOptionIndex(FxType::saturator, 0, "P PUNISH") == 4);

    for (int style = 0; style < 5; ++style)
    {
        auto fx = makeSat(style, 0.0f);
        const int n = 2048;
        std::vector<double> l(n), r(n), in(n);
        for (int i = 0; i < n; ++i)
        {
            in[static_cast<std::size_t>(i)] = 0.8 * std::sin(kTwoPi * 250.0 * static_cast<double>(i) / kSr);
            l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] = in[static_cast<std::size_t>(i)];
        }
        fx->process(l.data(), r.data(), n);
        for (int i = 0; i < n; ++i)
            REQUIRE(l[static_cast<std::size_t>(i)] == Approx(in[static_cast<std::size_t>(i)]).margin(1e-12));
    }
}

TEST_CASE("saturator: the five styles are five different flavours", "[fx][analog][sat]")
{
    // Second vs third harmonic at the same drive: A (tube) and T (transformer) are asymmetric stages and lean
    // EVEN; N (console) and E (germanium) lean ODD. If the switch did not change the curve these would all match.
    const auto balance = [](int style)
    {
        auto fx = makeSat(style, 60.0f);
        const auto out = run(*fx, static_cast<int>(kSr * 0.6), tone(200.0, 0.3));
        return magDb(out, 400.0) - magDb(out, 600.0); // + = more even than odd
    };
    const double a = balance(0), e = balance(1), nn = balance(2), t = balance(3);
    CHECK(a > nn);
    CHECK(t > nn);
    CHECK(e < a);

    // …and every style really does distort: the 3rd harmonic is well up out of the floor at DRIVE 60.
    for (int style = 0; style < 5; ++style)
    {
        auto fx = makeSat(style, 60.0f);
        const auto out = run(*fx, static_cast<int>(kSr * 0.6), tone(200.0, 0.3));
        INFO("style " << style);
        CHECK(magDb(out, 600.0) - magDb(out, 200.0) > -40.0);
    }
}

TEST_CASE("saturator: no style leaves DC behind", "[fx][analog][sat]")
{
    // The 4.6c lesson, applied from the start this time: the asymmetric flavours (A, T, P) make DC by definition.
    for (int style = 0; style < 5; ++style)
    {
        auto fx = makeSat(style, 90.0f);
        const auto out = run(*fx, static_cast<int>(kSr * 0.6), tone(120.0, 0.6));
        double mean = 0.0;
        const int from = static_cast<int>(kSr * 0.3);
        for (int i = from; i < static_cast<int>(out.size()); ++i)
            mean += out[static_cast<std::size_t>(i)];
        INFO("style " << style);
        CHECK(std::abs(mean / static_cast<double>(static_cast<int>(out.size()) - from)) < 2e-3);
    }
}

TEST_CASE("saturator: DRIVE is colour, PUNISH is the abuse", "[fx][analog][sat]")
{
    // Auto-gain: the fundamental stays in the same neighbourhood right across the range.
    double lo = 0.0, hi = 0.0;
    {
        auto fx = makeSat(0, 5.0f);
        lo = magDb(run(*fx, static_cast<int>(kSr * 0.6), tone(200.0, 0.3)), 200.0);
    }
    {
        auto fx = makeSat(0, 100.0f);
        hi = magDb(run(*fx, static_cast<int>(kSr * 0.6), tone(200.0, 0.3)), 200.0);
    }
    CHECK(std::abs(hi - lo) < 8.0);

    // PUNISH is 6x more drive — measured at a MODERATE setting, because at DRIVE 100 the curve is already fully
    // saturated and six times more of an already-square wave is still a square wave.
    auto plain = makeSat(2, 30.0f);
    auto punished = makeSat(2, 30.0f);
    punished->setParam(kPunish, 1.0f, true);
    const auto a = run(*plain, static_cast<int>(kSr * 0.6), tone(200.0, 0.3));
    const auto b = run(*punished, static_cast<int>(kSr * 0.6), tone(200.0, 0.3));
    CHECK(magDb(b, 600.0) - magDb(b, 200.0) > magDb(a, 600.0) - magDb(a, 200.0));
    CHECK(peak(b, 0, static_cast<int>(b.size())) < 4.0);
}

TEST_CASE("saturator: the filters sit BEFORE the curve", "[fx][analog][sat]")
{
    // LOWCUT keeps the bottom OUT of the distortion — the difference between filtering the input and filtering the
    // output. Measured as the 3rd harmonic of a 60 Hz tone with the cut at 500 Hz vs wide open. (Not "silent": a
    // 12 dB/oct filter takes ~37 dB off at three octaves, and then DRIVE 100 multiplies what is left by 24.)
    const auto thirdOf60 = [](float lowCut)
    {
        auto f = makeSat(4, 100.0f);
        f->setParam(kLowCut, lowCut, true);
        const auto o = run(*f, static_cast<int>(kSr * 0.6), tone(60.0, 0.7));
        return magDb(o, 180.0);
    };
    CHECK(thirdOf60(500.0f) < thirdOf60(20.0f) - 20.0);

    // TONE is a tilt: measured CLEAN (DRIVE 0), because at high drive the saturation compresses whatever you push
    // in and the two effects cancel in the meter — which is exactly what a first version of this gate measured.
    const auto hfAt = [](float toneVal)
    {
        auto f = makeSat(2, 0.0f);
        f->setParam(kTone, toneVal, true);
        const auto o = run(*f, static_cast<int>(kSr * 0.4), tone(6000.0, 0.25));
        return magDb(o, 6000.0);
    };
    CHECK(hfAt(100.0f) > hfAt(-100.0f) + 6.0);

    // …and because the tilt is BEFORE the curve it changes WHAT gets distorted. Two tones in (100 Hz + 3 kHz):
    // with TONE up, the top is what breaks up; with TONE down, the bottom is.
    const auto topVsBottom = [](float toneVal)
    {
        auto f = makeSat(4, 55.0f);
        f->setParam(kTone, toneVal, true);
        const auto o = run(*f, static_cast<int>(kSr * 0.6),
                           [](int i)
                           {
                               const double t = static_cast<double>(i) / kSr;
                               return 0.25 * std::sin(kTwoPi * 100.0 * t) + 0.25 * std::sin(kTwoPi * 3000.0 * t);
                           });
        return magDb(o, 9000.0) - magDb(o, 300.0); // the 3 kHz tone's 3rd vs the 100 Hz tone's
    };
    CHECK(topVsBottom(100.0f) > topVsBottom(-100.0f));

    // OUTPUT is a clean trim on top of everything.
    auto trim = makeSat(2, 0.0f);
    trim->setParam(kSatOut, -6.0f, true);
    const auto o = run(*trim, static_cast<int>(kSr * 0.4), tone(400.0, 0.4));
    CHECK(magDb(o, 400.0) == Approx(20.0 * std::log10(0.4) - 6.0).margin(0.3));
}

TEST_CASE("saturator: bounded, reset, block-invariant", "[fx][analog][sat]")
{
    for (const double sr : {44100.0, 48000.0, 96000.0})
        for (int style = 0; style < 5; ++style)
        {
            auto fx = makeSat(style, 100.0f, sr);
            fx->setParam(kPunish, 1.0f, true);
            const auto out =
                run(*fx, static_cast<int>(sr * 0.2), [](int i) { return (i / 16) % 2 == 0 ? 1.0 : -1.0; }, 64);
            for (const double v : out)
            {
                REQUIRE(std::isfinite(v));
                REQUIRE(std::abs(v) < 4.0); // every curve is bounded by construction
            }
        }

    auto fx = makeSat(3, 80.0f);
    run(*fx, 4096, tone(300.0, 0.6));
    fx->reset();
    CHECK(fx->param(kSatDrive) == Approx(0.0f));

    auto a = makeSat(0, 70.0f);
    auto b = makeSat(0, 70.0f);
    const auto ga = run(*a, 8192, tone(220.0, 0.5), 8192);
    const auto gb = run(*b, 8192, tone(220.0, 0.5), 29);
    for (std::size_t i = 0; i < ga.size(); ++i)
        REQUIRE(ga[i] == Approx(gb[i]).margin(1e-9));
}

// ---- LIMITER (4.6g) --------------------------------------------------------------------------------------------
// One gate matters more than the rest: THE CEILING IS NEVER EXCEEDED. Everything else — styles, release, look-ahead
// — is about how it gets there. A limiter that overshoots is not a limiter, so that one is checked across every
// style, every rate, and material chosen to be hostile (full-scale square edges, a sine that jumps 30 dB).

namespace
{
enum
{
    kLimStyle = 0,
    kLimGain,
    kCeiling,
    kLimRelease,
    kLookahead,
    kTruePeak,
    kLink
};

std::unique_ptr<LimiterFx> makeLim(int style, float gainDb, float ceilDb, float lookMs = 3.0f, double sr = kSr)
{
    auto fx = std::make_unique<LimiterFx>();
    fx->prepare(sr, kBlock);
    fx->setParam(kLimStyle, static_cast<float>(style), true);
    fx->setParam(kLimGain, gainDb, true);
    fx->setParam(kCeiling, ceilDb, true);
    fx->setParam(kLimRelease, 120.0f, true);
    fx->setParam(kLookahead, lookMs, true);
    fx->setParam(kTruePeak, 0.0f, true);
    fx->setParam(kLink, 100.0f, true);
    return fx;
}

/// The inter-sample (true) peak of a rendered buffer, by 4x Lagrange interpolation — the same measurement the
/// device claims to make, applied independently to its OUTPUT.
double truePeakOf(const std::vector<double>& v)
{
    double m = 0.0;
    for (int i = 1; i + 2 < static_cast<int>(v.size()); ++i)
    {
        const double p1 = v[static_cast<std::size_t>(i - 1)], x = v[static_cast<std::size_t>(i)],
                     n1 = v[static_cast<std::size_t>(i + 1)], n2 = v[static_cast<std::size_t>(i + 2)];
        m = std::max(m, std::abs(x));
        for (int k = 1; k < 4; ++k)
        {
            const double t = 0.25 * static_cast<double>(k);
            const double c0 = -t * (t - 1.0) * (t - 2.0) / 6.0;
            const double c1 = (t + 1.0) * (t - 1.0) * (t - 2.0) / 2.0;
            const double c2 = -(t + 1.0) * t * (t - 2.0) / 2.0;
            const double c3 = (t + 1.0) * t * (t - 1.0) / 6.0;
            m = std::max(m, std::abs(c0 * p1 + c1 * x + c2 * n1 + c3 * n2));
        }
    }
    return m;
}
} // namespace

TEST_CASE("limiter: the ceiling is never exceeded", "[fx][analog][lim]")
{
    REQUIRE(fxTypeFromId("limiter") == FxType::limiter);
    REQUIRE(fxTypeInfo(FxType::limiter).wetParam == -1); // fully wet, never blended
    REQUIRE(fxOptionIndex(FxType::limiter, 0, "AGGRESSIVE") == 4);

    for (const double sr : {44100.0, 48000.0, 96000.0})
        for (int style = 0; style < 7; ++style)
            for (const float ceilDb : {-0.3f, -3.0f, -12.0f})
            {
                auto fx = makeLim(style, 18.0f, ceilDb, 3.0f, sr);
                const double ceilLin = std::pow(10.0, static_cast<double>(ceilDb) / 20.0);
                // hostile material: square edges, then a sine that leaps 30 dB mid-buffer
                const auto out = run(
                    *fx, static_cast<int>(sr * 0.5),
                    [&](int i)
                    {
                        const double t = static_cast<double>(i) / sr;
                        if (i < static_cast<int>(sr * 0.2))
                            return (i / 32) % 2 == 0 ? 0.95 : -0.95;
                        const double a = t < 0.35 ? 0.02 : 0.9;
                        return a * std::sin(kTwoPi * 220.0 * t);
                    },
                    64);
                INFO("sr " << sr << " style " << style << " ceiling " << ceilDb);
                REQUIRE(peak(out, 0, static_cast<int>(out.size())) <= ceilLin * 1.001);
            }
}

TEST_CASE("limiter: TP catches what sample peak misses", "[fx][analog][lim]")
{
    // The textbook inter-sample case: a sine at exactly a QUARTER of the sample rate, 45 degrees out of phase, so
    // every single sample lands at 0.707 of a peak the converter will still reconstruct. Sample-peak limiting to
    // −0.3 dBFS therefore hands the DAC something 3 dB OVER. (An earlier version of this gate used 11025 Hz, whose
    // samples wander across the phase and so eventually land near the peak — it discriminated nothing.)
    const auto gen = [](int i)
    { return 0.9 * std::sin(kHalfPiT * static_cast<double>(i) + 0.25 * 3.14159265358979323846); };
    const double ceilLin = std::pow(10.0, -0.3 / 20.0);

    auto off = makeLim(3, 6.0f, -0.3f);
    const auto a = run(*off, static_cast<int>(kSr * 0.3), gen);
    CHECK(peak(a, 0, static_cast<int>(a.size())) <= ceilLin * 1.001);

    auto on = makeLim(3, 6.0f, -0.3f);
    on->setParam(kTruePeak, 1.0f, true);
    const auto b = run(*on, static_cast<int>(kSr * 0.3), gen);
    const int from = static_cast<int>(kSr * 0.05);
    const std::vector<double> tailA(a.begin() + from, a.end());
    const std::vector<double> tailB(b.begin() + from, b.end());
    INFO("sample-peak TP " << truePeakOf(tailA) << " vs true-peak TP " << truePeakOf(tailB));
    CHECK(truePeakOf(tailA) > ceilLin * 1.2); // the overshoot a sample-peak limiter cannot see
    CHECK(truePeakOf(tailB) < truePeakOf(tailA));
    CHECK(truePeakOf(tailB) <= ceilLin * 1.05);
}

TEST_CASE("limiter: LOOKAHEAD is the latency it reports", "[fx][analog][lim]")
{
    // PDC reads latencySamples(), so it has to be the truth: the output is delayed by exactly that many samples.
    for (const float ms : {0.0f, 1.0f, 5.0f, 20.0f})
    {
        auto fx = makeLim(3, 0.0f, 0.0f, ms);
        const int want = fx->latencySamples();
        CHECK(want == static_cast<int>(static_cast<double>(ms) * 0.001 * kSr));
        REQUIRE(fx->latencySamples() == want);
        const auto out = run(*fx, 8192, [](int i) { return i == 100 ? 0.5 : 0.0; });
        int at = -1;
        for (int i = 0; i < static_cast<int>(out.size()); ++i)
            if (std::abs(out[static_cast<std::size_t>(i)]) > 1e-9)
            {
                at = i;
                break;
            }
        INFO("lookahead " << ms << " ms");
        CHECK(at == 100 + want);
    }
}

TEST_CASE("limiter: under the ceiling it does nothing at all", "[fx][analog][lim]")
{
    // Quiet material must come out bit-identical (just delayed) — no gain riding, no colour, no gain reduction.
    auto fx = makeLim(0, 0.0f, -0.3f, 0.0f);
    const int n = 4096;
    std::vector<double> l(n), r(n), in(n);
    for (int i = 0; i < n; ++i)
    {
        in[static_cast<std::size_t>(i)] = 0.2 * std::sin(kTwoPi * 200.0 * static_cast<double>(i) / kSr);
        l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] = in[static_cast<std::size_t>(i)];
    }
    fx->process(l.data(), r.data(), n);
    for (int i = 0; i < n; ++i)
        REQUIRE(l[static_cast<std::size_t>(i)] == Approx(in[static_cast<std::size_t>(i)]).margin(1e-12));
    CHECK(fx->gainReductionDb() == Approx(0.0f).margin(1e-6f));
}

TEST_CASE("limiter: GAIN pushes it, and the styles are different", "[fx][analog][lim]")
{
    const auto grAt = [](int style, float gainDb)
    {
        auto fx = makeLim(style, gainDb, -0.3f);
        run(*fx, static_cast<int>(kSr * 0.5), tone(300.0, 0.5));
        return static_cast<double>(fx->gainReductionDb());
    };
    CHECK(grAt(3, 18.0f) < grAt(3, 6.0f)); // more push, more gain reduction

    // How much of a transient survives is what separates PUNCHY from BUS.
    const auto transientPeak = [](int style)
    {
        auto fx = makeLim(style, 12.0f, -0.3f);
        const auto out = run(*fx, static_cast<int>(kSr * 0.4),
                             [](int i)
                             {
                                 const double t = static_cast<double>(i) / kSr;
                                 const double env = std::exp(-40.0 * std::fmod(t, 0.1));
                                 return 0.9 * env * std::sin(kTwoPi * 90.0 * t);
                             });
        return rms(out, 0, static_cast<int>(out.size()));
    };
    CHECK(transientPeak(4) > transientPeak(5)); // AGGRESSIVE is louder than BUS, by design
}

TEST_CASE("limiter: finite, reset, block-invariant", "[fx][analog][lim]")
{
    auto fx = makeLim(4, 24.0f, -0.3f, 10.0f);
    const auto out = run(*fx, static_cast<int>(kSr * 0.3), [](int i) { return (i / 8) % 2 == 0 ? 1.0 : -1.0; }, 64);
    for (const double v : out)
    {
        REQUIRE(std::isfinite(v));
        REQUIRE(std::abs(v) <= 1.0);
    }
    fx->reset();
    CHECK(fx->param(kCeiling) == Approx(-0.3f));
    CHECK(fx->gainReductionDb() == Approx(0.0f).margin(1e-6f));

    auto a = makeLim(3, 12.0f, -1.0f, 4.0f);
    auto b = makeLim(3, 12.0f, -1.0f, 4.0f);
    const auto ga = run(*a, 8192, tone(150.0, 0.7), 8192);
    const auto gb = run(*b, 8192, tone(150.0, 0.7), 31);
    for (std::size_t i = 0; i < ga.size(); ++i)
        REQUIRE(ga[i] == Approx(gb[i]).margin(1e-9));
}

// ---- RETRO (4.6h) ----------------------------------------------------------------------------------------------
// Six modules in one box. The gates that matter here are about RESTRAINT and REPEATABILITY: every module at 0 must
// mean the box is not in the signal at all, and every random element must be SEEDED — a character effect whose
// noise and dropouts land differently in the bounce than they did on playback is a bug, not a texture.

namespace
{
enum
{
    kNoise = 0,
    kNType,
    kWobble,
    kDistort,
    kDType,
    kDigital,
    kSpace,
    kMagnetic
};

std::unique_ptr<RetroFx> makeRetro(double sr = kSr)
{
    auto fx = std::make_unique<RetroFx>();
    fx->prepare(sr, kBlock);
    return fx;
}
} // namespace

TEST_CASE("retro: every module at 0 means the box is not there", "[fx][analog][retro]")
{
    REQUIRE(fxTypeFromId("retro") == FxType::retro);
    REQUIRE(fxTypeInfo(FxType::retro).numParams == 9);
    REQUIRE(fxOptionIndex(FxType::retro, 4, "CRUSH") == 7);

    auto fx = makeRetro();
    const int n = 4096;
    std::vector<double> l(n), r(n), in(n);
    for (int i = 0; i < n; ++i)
    {
        in[static_cast<std::size_t>(i)] = 0.5 * std::sin(kTwoPi * 220.0 * static_cast<double>(i) / kSr);
        l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] = in[static_cast<std::size_t>(i)];
    }
    fx->process(l.data(), r.data(), n);
    for (int i = 0; i < n; ++i)
        REQUIRE(l[static_cast<std::size_t>(i)] == Approx(in[static_cast<std::size_t>(i)]).margin(1e-12));
}

TEST_CASE("retro: the random parts are seeded, so a bounce is the take you heard", "[fx][analog][retro]")
{
    // Two fresh devices with the same settings must produce the SAME noise and the SAME dropouts, sample for
    // sample. Anything less means the export does not match what was played.
    const auto render = [](int block)
    {
        auto fx = makeRetro();
        fx->setParam(kNoise, 80.0f, true);
        fx->setParam(kMagnetic, 90.0f, true);
        return run(*fx, 32768, [](int) { return 0.0; }, block);
    };
    const auto a = render(512);
    const auto b = render(512);
    for (std::size_t i = 0; i < a.size(); ++i)
        REQUIRE(a[i] == Approx(b[i]).margin(1e-15));
    // …and the block size must not change it either (the RNG advances per sample, not per block).
    const auto c = render(37);
    for (std::size_t i = 0; i < a.size(); ++i)
        REQUIRE(a[i] == Approx(c[i]).margin(1e-12));
}

TEST_CASE("retro: NOISE is a floor you can hear, and the flavours differ", "[fx][analog][retro]")
{
    const auto floorOf = [](int type, float amount)
    {
        auto fx = makeRetro();
        fx->setParam(kNType, static_cast<float>(type), true);
        fx->setParam(kNoise, amount, true);
        const auto out = run(*fx, static_cast<int>(kSr * 0.5), [](int) { return 0.0; });
        return rms(out, 0, static_cast<int>(out.size()));
    };
    CHECK(floorOf(0, 0.0f) < 1e-12); // 0 really is nothing
    CHECK(floorOf(0, 100.0f) > 1e-3);
    CHECK(floorOf(0, 100.0f) > floorOf(0, 30.0f)); // the knob is a level

    // TAPE is hiss (bright); VINYL is rumble plus crackle (dark). The flavours have to be different or the
    // selector is decoration.
    const auto brightness = [](int type)
    {
        auto fx = makeRetro();
        fx->setParam(kNType, static_cast<float>(type), true);
        fx->setParam(kNoise, 100.0f, true);
        const auto out = run(*fx, static_cast<int>(kSr * 0.5), [](int) { return 0.0; });
        return hfFraction(out, 0, static_cast<int>(out.size()), 4000.0, kSr);
    };
    CHECK(brightness(1) > brightness(0)); // tape hiss above vinyl rumble
    CHECK(brightness(1) > brightness(3)); // …and above the narrow radio band
}

TEST_CASE("retro: eight distortion curves, all of them different", "[fx][analog][retro]")
{
    // Each DTYPE has to leave its own harmonic fingerprint. Comparing the 2nd/3rd/4th balance across all eight
    // catches "they are all secretly tanh".
    // Measured at a MODERATE setting: drive everything hard enough and every clipper converges on the same square,
    // which says nothing about the curves (the PUNISH lesson from 4.6f).
    std::vector<std::array<double, 3>> prints;
    for (int type = 0; type < 8; ++type)
    {
        auto fx = makeRetro();
        fx->setParam(kDType, static_cast<float>(type), true);
        fx->setParam(kDistort, 50.0f, true);
        const auto out = run(*fx, static_cast<int>(kSr * 0.6), tone(200.0, 0.25));
        const double f0 = magDb(out, 200.0);
        prints.push_back({magDb(out, 400.0) - f0, magDb(out, 600.0) - f0, magDb(out, 800.0) - f0});
        // "Does it distort" measured as everything that is NOT the fundamental, not as the 3rd harmonic: BITS is a
        // QUANTISER, and its fingerprint is broadband noise between the harmonics (its 3rd sits at −52 dB while it
        // is plainly, audibly dirty). A harmonic-only gate would have called it clean.
        const double fundAmp = std::pow(10.0, f0 / 20.0);
        const double total = rms(out, static_cast<int>(out.size()) / 2, static_cast<int>(out.size()));
        const double dirt = std::max(1e-12, total * total * 2.0 - fundAmp * fundAmp);
        INFO("type " << type << " dirt " << 10.0 * std::log10(dirt / (fundAmp * fundAmp)) << " dB");
        CHECK(10.0 * std::log10(dirt / (fundAmp * fundAmp)) > -45.0);
    }
    for (std::size_t i = 0; i < prints.size(); ++i)
        for (std::size_t j = i + 1; j < prints.size(); ++j)
        {
            const double d = std::abs(prints[i][0] - prints[j][0]) + std::abs(prints[i][1] - prints[j][1]) +
                             std::abs(prints[i][2] - prints[j][2]);
            INFO("types " << i << " and " << j << " differ by " << d << " dB");
            CHECK(d > 0.5);
        }
}

TEST_CASE("retro: DIGITAL drops the bits and the rate together", "[fx][analog][retro]")
{
    // A slow ramp in: with DIGITAL up the output has to become a STAIRCASE — far fewer distinct values than the
    // 8192 that went in.
    const auto distinctValues = [](float digital)
    {
        auto fx = makeRetro();
        fx->setParam(kDigital, digital, true);
        const auto out = run(*fx, 8192, [](int i) { return -1.0 + 2.0 * static_cast<double>(i) / 8192.0; });
        std::vector<double> vals(out.begin() + 1024, out.end());
        std::sort(vals.begin(), vals.end());
        int distinct = 1;
        for (std::size_t i = 1; i < vals.size(); ++i)
            if (std::abs(vals[i] - vals[i - 1]) > 1e-9)
                ++distinct;
        return distinct;
    };
    CHECK(distinctValues(100.0f) < distinctValues(0.0f) / 4);
}

TEST_CASE("retro: WOBBLE moves it and MAGNETIC drops out", "[fx][analog][retro]")
{
    // WOBBLE is pitch movement: a steady tone comes back with its phase wandering, so it stops correlating with
    // the tone that went in.
    auto flat = makeRetro();
    flat->setParam(kWobble, 0.0f, true);
    auto wob = makeRetro();
    wob->setParam(kWobble, 100.0f, true);
    const auto a = run(*flat, static_cast<int>(kSr * 1.5), tone(400.0, 0.5));
    const auto b = run(*wob, static_cast<int>(kSr * 1.5), tone(400.0, 0.5));
    const int from = static_cast<int>(kSr * 0.5), to = static_cast<int>(kSr * 1.5);
    CHECK(correlation(a, b, from, to) < 0.95);

    // MAGNETIC: the level has to visibly dip somewhere in a long steady tone — that is a dropout.
    auto mag = makeRetro();
    mag->setParam(kMagnetic, 100.0f, true);
    const auto m = run(*mag, static_cast<int>(kSr * 6.0), tone(300.0, 0.6));
    const int win = static_cast<int>(kSr * 0.05);
    double lowest = 1e9, highest = 0.0;
    for (int w = 2; w + 1 < static_cast<int>(m.size()) / win; ++w)
    {
        const double e = rms(m, w * win, (w + 1) * win);
        lowest = std::min(lowest, e);
        highest = std::max(highest, e);
    }
    CHECK(lowest < highest * 0.9);
}

TEST_CASE("retro: SPACE, finiteness, reset", "[fx][analog][retro]")
{
    // SPACE puts a tail on an impulse where there was none.
    auto dry = makeRetro();
    auto wet = makeRetro();
    wet->setParam(kSpace, 100.0f, true);
    const auto a = run(*dry, static_cast<int>(kSr * 0.3), impulse());
    const auto b = run(*wet, static_cast<int>(kSr * 0.3), impulse());
    const int from = static_cast<int>(kSr * 0.05), to = static_cast<int>(kSr * 0.2);
    CHECK(rms(b, from, to) > rms(a, from, to) + 1e-6);

    for (const double sr : {44100.0, 48000.0, 96000.0})
        for (int dtype = 0; dtype < 8; ++dtype)
        {
            auto fx = makeRetro(sr);
            fx->setParam(kNoise, 100.0f, true);
            fx->setParam(kWobble, 100.0f, true);
            fx->setParam(kDistort, 100.0f, true);
            fx->setParam(kDType, static_cast<float>(dtype), true);
            fx->setParam(kDigital, 100.0f, true);
            fx->setParam(kSpace, 100.0f, true);
            fx->setParam(kMagnetic, 100.0f, true);
            const auto out =
                run(*fx, static_cast<int>(sr * 0.2), [](int i) { return (i / 16) % 2 == 0 ? 1.0 : -1.0; }, 64);
            for (const double v : out)
            {
                REQUIRE(std::isfinite(v));
                REQUIRE(std::abs(v) < 6.0);
            }
        }

    auto fx = makeRetro();
    fx->setParam(kNoise, 100.0f, true);
    run(*fx, 4096, tone(200.0, 0.5));
    fx->reset();
    CHECK(fx->param(kNoise) == Approx(0.0f));
    const auto quiet = run(*fx, 4096, [](int) { return 0.0; });
    CHECK(rms(quiet, 0, 4096) < 1e-15); // back to not being there at all
}

// ---- EQ 6 (4.7b) -----------------------------------------------------------------------------------------------
// The multi-band parametric the param budget was raised for. The gates are the numbers an EQ is only worth having
// if it hits: a bell is at its frequency with its gain, a shelf lifts one end and leaves the other, a cut's SLOPE
// is the slope it says (measured per octave, including the 96 dB/oct that needs eight cascaded sections), and a
// band set to OFF is BIT-EXACT — an EQ with nothing switched on has to be nothing at all.

namespace
{
constexpr int kEqPerBand = 5;
enum
{
    kBType = 0,
    kBFreq,
    kBGain,
    kBQ,
    kBSlope
};
constexpr int kEqOut = 6 * kEqPerBand;

int eqP(int band, int which)
{
    return band * kEqPerBand + which;
}

std::unique_ptr<EqFx6> makeEq(double sr = kSr)
{
    auto fx = std::make_unique<EqFx6>();
    fx->prepare(sr, kBlock);
    return fx;
}

/// The response (dB) of an effect at `hz`, measured with a settled sine.
double eqResp(Effect& e, double hz)
{
    return gainDb(e, hz, 0.05);
}
} // namespace

TEST_CASE("eq6: every band OFF is bit-exact", "[fx][analog][eq6]")
{
    REQUIRE(fxTypeFromId("eq6") == FxType::eq6);
    REQUIRE(fxTypeInfo(FxType::eq6).numParams == 31);
    REQUIRE(fxTypeInfo(FxType::eq6).wetParam == -1);
    REQUIRE(fxParamIndex(FxType::eq6, "FREQ3") == eqP(2, kBFreq));
    REQUIRE(fxParamIndex(FxType::eq6, "OUT") == kEqOut);
    REQUIRE(fxOptionIndex(FxType::eq6, eqP(0, kBType), "HIGH CUT") == 5);
    REQUIRE(fxOptionIndex(FxType::eq6, eqP(0, kBSlope), "96") == 5);

    auto fx = makeEq();
    const int n = 4096;
    std::vector<double> l(n), r(n), in(n);
    for (int i = 0; i < n; ++i)
    {
        in[static_cast<std::size_t>(i)] = 0.4 * std::sin(kTwoPi * 440.0 * static_cast<double>(i) / kSr);
        l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] = in[static_cast<std::size_t>(i)];
    }
    fx->process(l.data(), r.data(), n);
    for (int i = 0; i < n; ++i)
        REQUIRE(l[static_cast<std::size_t>(i)] == Approx(in[static_cast<std::size_t>(i)]).margin(1e-12));
}

TEST_CASE("eq6: a bell is where it says, with the gain it says", "[fx][analog][eq6]")
{
    for (const double g : {-12.0, -6.0, 6.0, 12.0})
    {
        auto fx = makeEq();
        fx->setParam(eqP(0, kBType), 1.0f, true); // BELL
        fx->setParam(eqP(0, kBFreq), 1000.0f, true);
        fx->setParam(eqP(0, kBGain), static_cast<float>(g), true);
        fx->setParam(eqP(0, kBQ), 2.0f, true);
        INFO("gain " << g);
        CHECK(eqResp(*fx, 1000.0) == Approx(g).margin(0.5));
        // …and it leaves the rest of the spectrum where it was
        auto fx2 = makeEq();
        fx2->setParam(eqP(0, kBType), 1.0f, true);
        fx2->setParam(eqP(0, kBFreq), 1000.0f, true);
        fx2->setParam(eqP(0, kBGain), static_cast<float>(g), true);
        fx2->setParam(eqP(0, kBQ), 2.0f, true);
        CHECK(eqResp(*fx2, 60.0) == Approx(0.0).margin(0.7));
    }

    // Two bands at the same spot add up — six of them are six, not one with a bigger number.
    auto stacked = makeEq();
    for (int b = 0; b < 2; ++b)
    {
        stacked->setParam(eqP(b, kBType), 1.0f, true);
        stacked->setParam(eqP(b, kBFreq), 1000.0f, true);
        stacked->setParam(eqP(b, kBGain), 6.0f, true);
        stacked->setParam(eqP(b, kBQ), 2.0f, true);
    }
    CHECK(eqResp(*stacked, 1000.0) == Approx(12.0).margin(0.8));
}

TEST_CASE("eq6: the shelves lift one end and leave the other", "[fx][analog][eq6]")
{
    auto low = makeEq();
    low->setParam(eqP(0, kBType), 2.0f, true); // LOW SHELF
    low->setParam(eqP(0, kBFreq), 200.0f, true);
    low->setParam(eqP(0, kBGain), 9.0f, true);
    CHECK(eqResp(*low, 40.0) == Approx(9.0).margin(1.0));
    auto low2 = makeEq();
    low2->setParam(eqP(0, kBType), 2.0f, true);
    low2->setParam(eqP(0, kBFreq), 200.0f, true);
    low2->setParam(eqP(0, kBGain), 9.0f, true);
    CHECK(eqResp(*low2, 5000.0) == Approx(0.0).margin(0.5));

    auto high = makeEq();
    high->setParam(eqP(0, kBType), 3.0f, true); // HIGH SHELF
    high->setParam(eqP(0, kBFreq), 4000.0f, true);
    high->setParam(eqP(0, kBGain), -9.0f, true);
    CHECK(eqResp(*high, 12000.0) == Approx(-9.0).margin(1.2));

    // TILT leans the whole spectrum: down one end, up the other, around the same point.
    auto tilt = makeEq();
    tilt->setParam(eqP(0, kBType), 7.0f, true);
    tilt->setParam(eqP(0, kBFreq), 1000.0f, true);
    tilt->setParam(eqP(0, kBGain), 6.0f, true);
    CHECK(eqResp(*tilt, 100.0) < -3.0);
    auto tilt2 = makeEq();
    tilt2->setParam(eqP(0, kBType), 7.0f, true);
    tilt2->setParam(eqP(0, kBFreq), 1000.0f, true);
    tilt2->setParam(eqP(0, kBGain), 6.0f, true);
    CHECK(eqResp(*tilt2, 10000.0) > 3.0);
}

TEST_CASE("eq6: a cut's SLOPE is the slope it claims", "[fx][analog][eq6]")
{
    // Measured against the BUTTERWORTH MAGNITUDE rather than as a difference between two octaves. A steep slope
    // runs out of numbers before it runs out of slope: at 96 dB/oct, one octave under a 1 kHz cutoff is −192 dB,
    // which no measurement on a −26 dBFS test tone can see (the first version of this gate read 21 dB/oct there
    // and was measuring the noise floor, not the filter). So each slope is checked at the frequency where theory
    // says it should be ~40 dB down — comfortably measurable, and a much tighter claim than "about that steep".
    struct Case
    {
        int idx;
        int poles;
    };
    for (const Case c : {Case{0, 2}, Case{1, 4}, Case{2, 6}, Case{3, 8}, Case{4, 12}, Case{5, 16}})
    {
        const double fc = 1000.0;
        const double x = std::pow(10.0, -2.0 / static_cast<double>(c.poles)); // where |H| = −40 dB
        const double f = fc * x;
        const double xn = std::pow(x, 2.0 * static_cast<double>(c.poles));
        const double wantDb = 10.0 * std::log10(xn / (1.0 + xn));
        auto fx = makeEq();
        fx->setParam(eqP(0, kBType), 4.0f, true); // LOW CUT
        fx->setParam(eqP(0, kBFreq), static_cast<float>(fc), true);
        fx->setParam(eqP(0, kBSlope), static_cast<float>(c.idx), true);
        const double got = eqResp(*fx, f);
        INFO("slope index " << c.idx << " (" << c.poles << " poles) at " << f << " Hz: want " << wantDb << " dB, got "
                            << got);
        CHECK(got == Approx(wantDb).margin(3.0));
    }

    // A HIGH CUT does the same going the other way, and neither touches the passband.
    auto hc = makeEq();
    hc->setParam(eqP(0, kBType), 5.0f, true);
    hc->setParam(eqP(0, kBFreq), 2000.0f, true);
    hc->setParam(eqP(0, kBSlope), 3.0f, true); // 48 dB/oct
    CHECK(eqResp(*hc, 200.0) == Approx(0.0).margin(0.5));
    auto hc2 = makeEq();
    hc2->setParam(eqP(0, kBType), 5.0f, true);
    hc2->setParam(eqP(0, kBFreq), 2000.0f, true);
    hc2->setParam(eqP(0, kBSlope), 3.0f, true);
    CHECK(eqResp(*hc2, 8000.0) < -70.0);
}

TEST_CASE("eq6: NOTCH, OUT, reset and block size", "[fx][analog][eq6]")
{
    auto notch = makeEq();
    notch->setParam(eqP(0, kBType), 6.0f, true);
    notch->setParam(eqP(0, kBFreq), 1000.0f, true);
    notch->setParam(eqP(0, kBQ), 8.0f, true);
    CHECK(eqResp(*notch, 1000.0) < -20.0);
    auto notch2 = makeEq();
    notch2->setParam(eqP(0, kBType), 6.0f, true);
    notch2->setParam(eqP(0, kBFreq), 1000.0f, true);
    notch2->setParam(eqP(0, kBQ), 8.0f, true);
    CHECK(eqResp(*notch2, 250.0) == Approx(0.0).margin(0.5));

    auto trim = makeEq();
    trim->setParam(kEqOut, -6.0f, true);
    CHECK(eqResp(*trim, 1000.0) == Approx(-6.0).margin(0.2));

    auto fx = makeEq();
    fx->setParam(eqP(2, kBType), 1.0f, true);
    fx->setParam(eqP(2, kBGain), 12.0f, true);
    fx->reset();
    CHECK(fx->param(eqP(2, kBType)) == Approx(0.0f));
    CHECK(fx->param(eqP(2, kBGain)) == Approx(0.0f));

    const auto build = [](int block)
    {
        auto e = makeEq();
        e->setParam(eqP(0, kBType), 4.0f, true);
        e->setParam(eqP(0, kBFreq), 300.0f, true);
        e->setParam(eqP(0, kBSlope), 4.0f, true);
        e->setParam(eqP(1, kBType), 1.0f, true);
        e->setParam(eqP(1, kBFreq), 2000.0f, true);
        e->setParam(eqP(1, kBGain), 8.0f, true);
        return run(*e, 8192, tone(500.0, 0.4), block);
    };
    const auto a = build(8192), b = build(43);
    for (std::size_t i = 0; i < a.size(); ++i)
        REQUIRE(a[i] == Approx(b[i]).margin(1e-9));
}

TEST_CASE("eq6: finite with every band on at every rate", "[fx][analog][eq6]")
{
    for (const double sr : {44100.0, 48000.0, 96000.0})
        for (int t = 1; t < 8; ++t)
        {
            auto fx = makeEq(sr);
            for (int b = 0; b < 6; ++b)
            {
                fx->setParam(eqP(b, kBType), static_cast<float>(t), true);
                fx->setParam(eqP(b, kBGain), b % 2 == 0 ? 30.0f : -30.0f, true);
                fx->setParam(eqP(b, kBQ), 18.0f, true);
                fx->setParam(eqP(b, kBSlope), 5.0f, true);
            }
            const auto out =
                run(*fx, static_cast<int>(sr * 0.1), [](int i) { return (i / 16) % 2 == 0 ? 0.8 : -0.8; }, 64);
            for (const double v : out)
            {
                REQUIRE(std::isfinite(v));
                REQUIRE(std::abs(v) < 200.0);
            }
        }
}

// ---- CHANNEL, the SSL 4000 G strip (4.7c) ----------------------------------------------------------------------
// The last device on Victor's brief. The gate that carries the most weight is the E/G one: if the two curves
// measure the same, the switch is decoration and the strip is just "an EQ" — the whole reason both consoles are
// famous is that the G's Q FOLLOWS THE GAIN and the E's does not.

namespace
{
enum
{
    kHpf = 0,
    kLpf,
    kLf,
    kLfHz,
    kLfBell,
    kLmf,
    kLmfHz,
    kLmfQ,
    kHmf,
    kHmfHz,
    kHmfQ,
    kHf,
    kHfHz,
    kHfBell,
    kCurve,
    kCThresh,
    kCRatio,
    kCRel,
    kCAtk,
    kGThresh,
    kGRange,
    kGRel,
    kDynPre,
    kCsOut
};

std::unique_ptr<ChannelStripFx> makeStrip(double sr = kSr)
{
    auto fx = std::make_unique<ChannelStripFx>();
    fx->prepare(sr, kBlock);
    return fx;
}
} // namespace

TEST_CASE("channel: at its defaults the strip is bit-exact", "[fx][analog][strip]")
{
    REQUIRE(fxTypeFromId("channelstrip") == FxType::channelstrip);
    REQUIRE(fxTypeInfo(FxType::channelstrip).numParams == 24);
    REQUIRE(fxOptionIndex(FxType::channelstrip, kCurve, "G") == 1);
    REQUIRE(fxOptionIndex(FxType::channelstrip, kDynPre, "PRE EQ") == 1);

    // Filters at their ends = off, EQ flat, compressor at 0 dB threshold with the gate fully down: inserting the
    // strip and touching nothing must do nothing.
    auto fx = makeStrip();
    const int n = 4096;
    std::vector<double> l(n), r(n), in(n);
    for (int i = 0; i < n; ++i)
    {
        in[static_cast<std::size_t>(i)] = 0.3 * std::sin(kTwoPi * 500.0 * static_cast<double>(i) / kSr);
        l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] = in[static_cast<std::size_t>(i)];
    }
    fx->process(l.data(), r.data(), n);
    for (int i = 0; i < n; ++i)
        REQUIRE(l[static_cast<std::size_t>(i)] == Approx(in[static_cast<std::size_t>(i)]).margin(1e-9));
}

TEST_CASE("channel: E and G are genuinely different curves", "[fx][analog][strip]")
{
    // The claim: on the G the Q FOLLOWS the gain — a big boost is narrower than a small one. On the E it does not
    // move. Measured as the width of the same boost: how much of it is still there an octave away.
    const auto skirt = [](float curve, float gain)
    {
        auto fx = makeStrip();
        fx->setParam(kCurve, curve, true);
        fx->setParam(kLmfHz, 1000.0f, true);
        fx->setParam(kLmfQ, 1.0f, true);
        fx->setParam(kLmf, gain, true);
        const double atCentre = gainDb(*fx, 1000.0, 0.05);
        auto fx2 = makeStrip();
        fx2->setParam(kCurve, curve, true);
        fx2->setParam(kLmfHz, 1000.0f, true);
        fx2->setParam(kLmfQ, 1.0f, true);
        fx2->setParam(kLmf, gain, true);
        const double atOctave = gainDb(*fx2, 2000.0, 0.05);
        return atOctave / std::max(0.001, atCentre); // 1 = as wide as it gets, 0 = surgical
    };
    // E: the same shape whatever the gain.
    CHECK(skirt(0.0f, 3.0f) == Approx(skirt(0.0f, 15.0f)).margin(0.06));
    // G: the big boost is measurably NARROWER than the small one.
    CHECK(skirt(1.0f, 15.0f) < skirt(1.0f, 3.0f) - 0.05);

    // …and both still hit the gain they were asked for at the centre.
    for (const float c : {0.0f, 1.0f})
    {
        auto fx = makeStrip();
        fx->setParam(kCurve, c, true);
        fx->setParam(kHmfHz, 3000.0f, true);
        fx->setParam(kHmf, 9.0f, true);
        INFO("curve " << c);
        CHECK(gainDb(*fx, 3000.0, 0.05) == Approx(9.0).margin(0.6));
    }
}

TEST_CASE("channel: the filters and the four bands do what they say", "[fx][analog][strip]")
{
    auto hp = makeStrip();
    hp->setParam(kHpf, 300.0f, true);
    CHECK(gainDb(*hp, 50.0, 0.05) < -20.0);
    auto hp2 = makeStrip();
    hp2->setParam(kHpf, 300.0f, true);
    CHECK(gainDb(*hp2, 4000.0, 0.05) == Approx(0.0).margin(0.5));

    auto lp = makeStrip();
    lp->setParam(kLpf, 4000.0f, true);
    CHECK(gainDb(*lp, 16000.0, 0.05) < -20.0);

    // LF as a SHELF lifts everything below it; as a BELL it lifts only around its frequency.
    auto shelf = makeStrip();
    shelf->setParam(kLfHz, 100.0f, true);
    shelf->setParam(kLf, 10.0f, true);
    const double shelfDeep = gainDb(*shelf, 35.0, 0.05);
    auto bell = makeStrip();
    bell->setParam(kLfHz, 100.0f, true);
    bell->setParam(kLf, 10.0f, true);
    bell->setParam(kLfBell, 1.0f, true);
    const double bellDeep = gainDb(*bell, 35.0, 0.05);
    CHECK(shelfDeep > bellDeep + 3.0);

    auto hf = makeStrip();
    hf->setParam(kHfHz, 8000.0f, true);
    hf->setParam(kHf, -10.0f, true);
    CHECK(gainDb(*hf, 15000.0, 0.05) < -6.0);
}

TEST_CASE("channel: the dynamics section, and PRE EQ really is a different order", "[fx][analog][strip]")
{
    // The compressor works and reports its gain reduction.
    auto comp = makeStrip();
    comp->setParam(kCThresh, -24.0f, true);
    comp->setParam(kCRatio, 8.0f, true);
    run(*comp, static_cast<int>(kSr * 0.6), tone(400.0, 0.5));
    CHECK(comp->gainReductionDb() < -8.0f);

    // FAST vs SLOW attack: the fast one catches more of a transient.
    const auto firstPeak = [](float fast)
    {
        auto fx = makeStrip();
        fx->setParam(kCThresh, -30.0f, true);
        fx->setParam(kCRatio, 10.0f, true);
        fx->setParam(kCAtk, fast, true);
        const auto out = run(*fx, 4800, [](int i) { return i < 480 ? 0.9 : 0.0; });
        return peak(out, 0, 480);
    };
    CHECK(firstPeak(1.0f) < firstPeak(0.0f));

    // The gate shuts quiet material and leaves loud material alone.
    auto gate = makeStrip();
    gate->setParam(kGThresh, -30.0f, true);
    gate->setParam(kGRange, 40.0f, true);
    const auto quiet = run(*gate, static_cast<int>(kSr * 0.8), tone(400.0, 0.005));
    CHECK(rms(quiet, static_cast<int>(kSr * 0.5), static_cast<int>(kSr * 0.8)) < 0.0025);
    auto gate2 = makeStrip();
    gate2->setParam(kGThresh, -30.0f, true);
    gate2->setParam(kGRange, 40.0f, true);
    const auto loud = run(*gate2, static_cast<int>(kSr * 0.8), tone(400.0, 0.4));
    CHECK(rms(loud, static_cast<int>(kSr * 0.5), static_cast<int>(kSr * 0.8)) > 0.2);

    // DYN PRE EQ: with a big EQ boost and a compressor working, the order changes the result — compressing before
    // the boost lets the boost through, compressing after it catches the boost.
    const auto levelWith = [](float pre)
    {
        auto fx = makeStrip();
        fx->setParam(kDynPre, pre, true);
        fx->setParam(kHmfHz, 1000.0f, true);
        fx->setParam(kHmf, 15.0f, true);
        fx->setParam(kCThresh, -24.0f, true);
        fx->setParam(kCRatio, 10.0f, true);
        return gainDb(*fx, 1000.0, 0.2);
    };
    CHECK(std::abs(levelWith(1.0f) - levelWith(0.0f)) > 1.0);
}

TEST_CASE("channel: finite, reset, block-invariant", "[fx][analog][strip]")
{
    for (const double sr : {44100.0, 48000.0, 96000.0})
    {
        auto fx = makeStrip(sr);
        fx->setParam(kHpf, 350.0f, true);
        fx->setParam(kLpf, 3000.0f, true);
        for (const int p : {kLf, kLmf, kHmf, kHf})
            fx->setParam(p, 15.0f, true);
        fx->setParam(kCThresh, -40.0f, true);
        fx->setParam(kCRatio, 20.0f, true);
        fx->setParam(kGThresh, 0.0f, true);
        fx->setParam(kGRange, 60.0f, true);
        fx->setParam(kCsOut, 24.0f, true);
        const auto out = run(*fx, static_cast<int>(sr * 0.2), [](int i) { return (i / 16) % 2 == 0 ? 1.0 : -1.0; }, 64);
        for (const double v : out)
        {
            REQUIRE(std::isfinite(v));
            // four bands at +15 dB and OUT at +24 is 84 dB of deliberate gain on a full-scale square — the check
            // here is that it stays FINITE and bounded, not that it stays quiet
            REQUIRE(std::abs(v) < 300.0);
        }
    }

    auto fx = makeStrip();
    fx->setParam(kLmf, 12.0f, true);
    fx->reset();
    CHECK(fx->param(kLmf) == Approx(0.0f));
    CHECK(fx->param(kCurve) == Approx(1.0f)); // G is the default

    const auto build = [](int block)
    {
        auto e = makeStrip();
        e->setParam(kHpf, 120.0f, true);
        e->setParam(kHmf, 6.0f, true);
        e->setParam(kCThresh, -20.0f, true);
        e->setParam(kCRatio, 4.0f, true);
        return run(*e, 8192, tone(300.0, 0.4), block);
    };
    const auto a = build(8192), b = build(53);
    for (std::size_t i = 0; i < a.size(); ++i)
        REQUIRE(a[i] == Approx(b[i]).margin(1e-9));
}
