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
