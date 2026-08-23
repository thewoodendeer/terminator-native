// LOUDNESS (Phase 4.3) — the page's BS.1770-4 / EBU R128 worklet natively on the master: the spec's reference points
// (a 0 dBFS 997 Hz sine in one channel reads -3.01 LKFS; both channels at -20 dBFS read -20.0), true peak between
// the samples, correlation, LRA between two levels, the integrated gate ignoring silence, reset; the meters on the
// bridge: a COMP's gain reduction per insert slot, the master limiter's GR.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <vector>

#include "terminator/core/Engine.h"
#include "terminator/core/LoudnessMeter.h"
#include "terminator/core/Mixer.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;
constexpr int kBlock = 256;
constexpr double kTwoPi = 6.283185307179586;

/// Feed `seconds` of a stereo sine (ampL / ampR, a phase offset in radians) into the meter.
void feed(LoudnessMeter& m, double hz, double ampL, double ampR, double seconds, double phase = 0.0,
          bool antiphase = false)
{
    const int total = static_cast<int>(seconds * kSr);
    std::vector<double> l(kBlock), r(kBlock);
    static std::uint64_t t0 = 0;
    for (int done = 0; done < total; done += kBlock)
    {
        const int n = std::min(kBlock, total - done);
        for (int i = 0; i < n; ++i)
        {
            const double ph =
                kTwoPi * hz * static_cast<double>(t0 + static_cast<std::uint64_t>(done + i)) / kSr + phase;
            l[static_cast<std::size_t>(i)] = ampL * std::sin(ph);
            r[static_cast<std::size_t>(i)] = (antiphase ? -1.0 : 1.0) * ampR * std::sin(ph);
        }
        m.push(l.data(), r.data(), n);
    }
    t0 += static_cast<std::uint64_t>(total);
}
} // namespace

TEST_CASE("loudness: the BS.1770 reference points - one channel 0 dBFS 997 Hz = -3.01 LKFS, both at -20 dBFS = -20.0",
          "[loudness]")
{
    LoudnessMeter m;
    m.prepare(kSr);
    feed(m, 997.0, 1.0, 0.0, 5.0);
    const auto& r1 = m.reading();
    INFO("one channel 0 dBFS: M " << r1.m << " S " << r1.s << " I " << r1.i);
    REQUIRE(r1.m == Approx(-3.01).margin(0.05));
    REQUIRE(r1.s == Approx(-3.01).margin(0.05));
    REQUIRE(r1.i == Approx(-3.01).margin(0.05));
    REQUIRE(r1.peakL == Approx(1.0).margin(1e-3));
    REQUIRE(r1.peakR == Approx(0.0).margin(1e-9));
    REQUIRE(r1.corr == 1.0f); // an empty channel: the page's worklet reports 1
    REQUIRE(r1.hops > 40);
    m.reset();
    REQUIRE(m.reading().i == -1000.0f);
    REQUIRE(m.reading().hops == 0u);
    feed(m, 997.0, 0.1, 0.1, 5.0);
    const auto& r2 = m.reading();
    INFO("both -20 dBFS: M " << r2.m << " S " << r2.s << " I " << r2.i);
    REQUIRE(r2.m == Approx(-20.0).margin(0.05));
    REQUIRE(r2.s == Approx(-20.0).margin(0.05));
    REQUIRE(r2.i == Approx(-20.0).margin(0.05));
    REQUIRE(r2.corr == Approx(1.0).margin(1e-6));
    REQUIRE(r2.maxM == Approx(-20.0).margin(0.05));
    // anti-phase: correlation -1
    m.reset();
    feed(m, 997.0, 0.1, 0.1, 1.0, 0.0, true);
    REQUIRE(m.reading().corr == Approx(-1.0).margin(1e-6));
}

TEST_CASE("loudness: true peak between the samples (fs/4 sine, phase pi/4: samples 0.354, true peak 0.5)", "[loudness]")
{
    LoudnessMeter m;
    m.prepare(kSr);
    feed(m, kSr / 4.0, 0.5, 0.5, 1.0, 0.78539816339744831);
    const auto& r = m.reading();
    INFO("sample peak " << r.peakL << " true peak " << r.tpL);
    REQUIRE(r.peakL == Approx(0.35355).margin(2e-3));
    // the 4 × 12-tap Kaiser sinc (the page's, the spec's Annex 2 size) reads 0.490 here: its own passband droop at
    // fs/4 is −0.17 dB — the same number the page's worklet shows
    REQUIRE(20.0 * std::log10(static_cast<double>(r.tpL)) == Approx(20.0 * std::log10(0.5)).margin(0.25));
    REQUIRE(r.tpL > r.peakL * 1.3f);
    REQUIRE(r.holdTp >= r.tpL); // the hold saw the onset's overshoot too
}

TEST_CASE("loudness: LRA between two levels, the integrated gate ignores silence", "[loudness]")
{
    LoudnessMeter m;
    m.prepare(kSr);
    feed(m, 997.0, 0.1, 0.1, 12.0);                   // -20
    feed(m, 997.0, 0.0316227766, 0.0316227766, 12.0); // -30
    const auto& r = m.reading();
    INFO("LRA " << r.lra << " I " << r.i);
    REQUIRE(r.lra > 8.0f);
    REQUIRE(r.lra < 10.5f);
    REQUIRE(r.i < -20.0f);
    REQUIRE(r.i > -30.0f);
    m.reset();
    feed(m, 997.0, 0.0, 0.0, 5.0); // silence: below the absolute gate, not counted
    REQUIRE(m.reading().hops == 0u);
    REQUIRE(m.reading().i == -1000.0f);
    feed(m, 997.0, 0.1, 0.1, 5.0);
    // the silence did not dilute it — only the one 400 ms block straddling the onset (−26 LUFS, inside the −10 LU
    // relative gate) pulls it a tenth down, exactly as the page's gating does
    REQUIRE(m.reading().i == Approx(-20.0).margin(0.2));
}

TEST_CASE("loudness + GR on the bridge: the master's meter, a COMP's gain reduction per slot, the limiter's GR",
          "[loudness]")
{
    Engine engine;
    engine.prepare({kSr, kBlock, 2, 0});
    engine.commands().push(Command::mixerSetStrip(1, static_cast<std::uint8_t>(StripKind::channel)));
    engine.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::eq)));
    engine.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::comp)));
    engine.commands().push(Command::mixerSetFxParam(1, 1, 0, 4.0f, true)); // AGGRESSIVE
    engine.commands().push(Command::mixerSetLimiter(true));
    std::vector<float> a(kBlock), b(kBlock);
    float* outs[2] = {a.data(), b.data()};
    // three seconds of silence: Blink's kernel reports its start-up dip as "reduction" (−21 dB on the first block —
    // the page's node too), which its 325 ms metering release lets go of
    for (int bl = 0; bl < static_cast<int>(3.0 * kSr / kBlock); ++bl)
        engine.process(outs, 2, kBlock);
    // the Engine clears the strip inputs every block before its sources add — the audio goes through a bare Mixer
    Mixer m;
    m.prepare(kSr, kBlock);
    m.setStripKind(1, StripKind::channel);
    m.setMasterLimiter(true);
    std::vector<float> oL(kBlock), oR(kBlock);
    float* mo[2] = {oL.data(), oR.data()};
    for (int bl = 0; bl < static_cast<int>(3.0 * kSr / kBlock); ++bl)
    {
        std::fill(oL.begin(), oL.end(), 0.0f);
        std::fill(oR.begin(), oR.end(), 0.0f);
        m.clearInputs(kBlock);
        for (int i = 0; i < kBlock; ++i)
        {
            const double x = 0.1 * std::sin(kTwoPi * 1000.0 * static_cast<double>(bl * kBlock + i) / kSr);
            m.inputs()[2][i] += x;
            m.inputs()[3][i] += x;
        }
        m.process(mo, 2, kBlock);
    }
    const auto& lr = m.loudness();
    INFO("master: M " << lr.m << " I " << lr.i << " (a -20 dBFS sine + the limiter's +0.57 dB makeup)");
    REQUIRE(lr.m == Approx(-20.0 + 0.57).margin(0.2));
    REQUIRE(lr.hops > 20);
    // the snapshot carries the GR per slot (the engine's strip 1: an EQ then a silent comp = 0 / 0)
    REQUIRE(engine.snapshot().stripFxGr[1][0] == 0.0f);
    REQUIRE(engine.snapshot().stripFxGr[1][1] > -0.5f);
    // a hot signal through a COMP: its slot reports the reduction, the EQ's slot 0, an empty slot 0
    FxPool pool;
    pool.prepare(kSr, kBlock);
    Mixer m2;
    m2.prepare(kSr, kBlock);
    m2.setPool(&pool);
    m2.setStripKind(1, StripKind::channel);
    REQUIRE(m2.addFx(1, FxType::eq));
    REQUIRE(m2.addFx(1, FxType::comp));
    m2.setFxParam(1, 1, 0, 4.0f, true);
    for (int bl = 0; bl < static_cast<int>(1.0 * kSr / kBlock); ++bl)
    {
        std::fill(oL.begin(), oL.end(), 0.0f);
        std::fill(oR.begin(), oR.end(), 0.0f);
        m2.clearInputs(kBlock);
        for (int i = 0; i < kBlock; ++i)
        {
            const double x = 0.5 * std::sin(kTwoPi * 1000.0 * static_cast<double>(bl * kBlock + i) / kSr);
            m2.inputs()[2][i] += x;
            m2.inputs()[3][i] += x;
        }
        m2.process(mo, 2, kBlock);
    }
    INFO("comp GR " << m2.fxGainReductionDb(1, 1) << " dB, eq GR " << m2.fxGainReductionDb(1, 0));
    REQUIRE(m2.fxGainReductionDb(1, 0) == 0.0f);
    REQUIRE(m2.fxGainReductionDb(1, 1) < -1.0f);
    REQUIRE(m2.fxGainReductionDb(1, 5) == 0.0f);
    // the snapshot's loudness fields move with the engine's master (silence = -inf, hops 0) and reset on command
    REQUIRE(engine.snapshot().lufsM == -1000.0f);
    engine.commands().push(Command::loudnessReset());
    engine.process(outs, 2, kBlock);
    REQUIRE(engine.snapshot().loudHops == 0u);
}
