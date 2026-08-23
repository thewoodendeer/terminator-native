// CONSOLE (Phase 4.2c) — the page's analog-desk separation stage, gated with the page's own numbers
// (scripts/console.test.mts, at its 44.1 kHz): unity small-signal gain within 0.1 dB on every strip and the bus for
// every flavour; THD at -6 dBFS in the desk ballpark (0.3-2 % at AMOUNT 100, clearly less at 50, cleaner when
// quieter); SSL odd-heavy, NEVE even-heavy; every strip's tilt within +/-0.6 dB of flat 60 Hz-12 kHz, every pair
// differing somewhere by >= 0.03 dB, the same seed = the same curve; the sub-sonic HPF; the NEVE bus softening 16 kHz;
// AMOUNT 0 transparent; +12 dBFS bounded; no DC after the even stage. Then through the Mixer: on / off / the seed
// command / the snapshot flag.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "terminator/core/Engine.h"
#include "terminator/core/Mixer.h"
#include "terminator/core/fx/ConsoleStage.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 44100.0;
constexpr int kBlock = 128;
constexpr double kTwoPi = 6.283185307179586;

ConsoleStage stage(bool bus, const char* name, ConsoleFlavour f, float amount01)
{
    ConsoleStage s;
    s.prepare(kSr);
    s.configure(bus, ConsoleStage::fnv1a(name));
    s.set(f, amount01, true);
    return s;
}

/// Run a sine of `sec` seconds through `s` (both channels the same), returning the L output.
std::vector<double> run(ConsoleStage& s, double hz, double amp, double sec)
{
    const int total = static_cast<int>(std::ceil(sec * kSr / kBlock)) * kBlock;
    std::vector<double> out(static_cast<std::size_t>(total));
    std::vector<double> l(kBlock), r(kBlock);
    for (int pos = 0; pos < total; pos += kBlock)
    {
        for (int i = 0; i < kBlock; ++i)
            l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] =
                amp * std::sin(kTwoPi * hz * static_cast<double>(pos + i) / kSr);
        s.process(l.data(), r.data(), kBlock);
        for (int i = 0; i < kBlock; ++i)
            out[static_cast<std::size_t>(pos + i)] = l[static_cast<std::size_t>(i)];
    }
    return out;
}
double mag(const std::vector<double>& a, double hz, int from, int to)
{
    const double w = kTwoPi * hz / kSr, c = 2.0 * std::cos(w);
    double s0 = 0.0, s1 = 0.0, s2 = 0.0;
    for (int i = from; i < to; ++i)
    {
        s0 = a[static_cast<std::size_t>(i)] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const double re = s1 - s2 * std::cos(w), im = s2 * std::sin(w);
    return 2.0 * std::sqrt(re * re + im * im) / static_cast<double>(to - from);
}
struct Harm
{
    double thd, h2, h3, fund;
    std::vector<double> out;
};
Harm harmonics(ConsoleStage& s, double hz, double amp)
{
    auto y = run(s, hz, amp, 1.0);
    const int from = static_cast<int>(0.3 * kSr), to = from + static_cast<int>(0.5 * kSr);
    const double f = mag(y, hz, from, to);
    double sum = 0.0;
    double h[7];
    for (int k = 2; k <= 8; ++k)
    {
        const double m = mag(y, hz * k, from, to) / f;
        h[k - 2] = m;
        sum += m * m;
    }
    return {std::sqrt(sum), h[0], h[1], f, std::move(y)};
}
double gainAt(ConsoleStage& s, double hz)
{
    const double amp = 0.126;
    auto y = run(s, hz, amp, 0.6);
    const int from = static_cast<int>(0.3 * kSr), to = from + static_cast<int>(0.25 * kSr);
    return 20.0 * std::log10(std::max(1e-12, mag(y, hz, from, to) / amp));
}
const char* const kStrips[] = {"sample", "kick", "snare", "hat", "openhat", "perc", "bass", "send1", "sample2"};
const ConsoleFlavour kFlavours[] = {ConsoleFlavour::ssl, ConsoleFlavour::neve, ConsoleFlavour::api};
} // namespace

TEST_CASE("console: the seed + tolerances are the page's (FNV-1a -> mulberry32)", "[console]")
{
    // the JS worklet's values (node: fnv1a('kick') = 0xc61c131f, fnv1a('strip') = 0xfd1b18d1; mulberry32 from it:
    // -0.437148455530 -0.022799781058 -0.484576527029 0.312006460968 0.313334503211 0.004763143603)
    REQUIRE(ConsoleStage::fnv1a("kick") == 0xc61c131fu);
    REQUIRE(ConsoleStage::fnv1a("strip") == 0xfd1b18d1u);
    REQUIRE(ConsoleStage::fnv1a("") == ConsoleStage::fnv1a("strip"));
    ConsoleStage a = stage(false, "kick", ConsoleFlavour::ssl, 1.0f);
    const double kKickTol[6] = {-0.437148455530, -0.022799781058, -0.484576527029,
                                0.312006460968,  0.313334503211,  0.004763143603};
    for (int i = 0; i < 6; ++i)
        REQUIRE(a.tolerances()[i] == Approx(kKickTol[i]).margin(1e-11));
    ConsoleStage b = stage(false, "kick", ConsoleFlavour::ssl, 1.0f);
    ConsoleStage c = stage(false, "snare", ConsoleFlavour::ssl, 1.0f);
    for (int i = 0; i < 6; ++i)
    {
        REQUIRE(a.tolerances()[i] == b.tolerances()[i]);
        REQUIRE(a.tolerances()[i] >= -1.0);
        REQUIRE(a.tolerances()[i] <= 1.0);
    }
    bool differs = false;
    for (int i = 0; i < 6; ++i)
        differs = differs || a.tolerances()[i] != c.tolerances()[i];
    REQUIRE(differs);
    ConsoleStage bus = stage(true, "master", ConsoleFlavour::ssl, 1.0f);
    for (int i = 0; i < 6; ++i)
        REQUIRE(bus.tolerances()[i] == 0.0);
}

TEST_CASE("console: level-matched within 0.1 dB at -18 dBFS / 1 kHz, every strip, every flavour, the bus", "[console]")
{
    for (auto f : kFlavours)
    {
        double worst = 0.0;
        for (const char* n : kStrips)
        {
            ConsoleStage s = stage(false, n, f, 1.0f);
            worst = std::max(worst, std::abs(gainAt(s, 1000.0)));
        }
        INFO("flavour " << static_cast<int>(f) << " worst " << worst);
        REQUIRE(worst <= 0.1);
        ConsoleStage b = stage(true, "master", f, 1.0f);
        REQUIRE(std::abs(gainAt(b, 1000.0)) <= 0.1);
    }
}

TEST_CASE(
    "console: harmonics per flavour at -6 dBFS (0.3-2 %), AMOUNT 50 gentler, quieter cleaner, SSL odd / NEVE even",
    "[console]")
{
    for (auto f : kFlavours)
    {
        ConsoleStage sFull = stage(false, "kick", f, 1.0f);
        ConsoleStage sHalf = stage(false, "kick", f, 0.5f);
        ConsoleStage sQuiet = stage(false, "kick", f, 1.0f);
        const Harm full = harmonics(sFull, 1000.0, 0.5);
        const Harm half = harmonics(sHalf, 1000.0, 0.5);
        const Harm quiet = harmonics(sQuiet, 1000.0, 0.126);
        INFO("flavour " << static_cast<int>(f) << ": THD " << full.thd * 100.0 << " % (h2 " << full.h2 * 100.0 << " h3 "
                        << full.h3 * 100.0 << ") @-6/100, " << half.thd * 100.0 << " % @50, " << quiet.thd * 100.0
                        << " % @-18");
        REQUIRE(full.thd >= 0.003);
        REQUIRE(full.thd <= 0.02);
        REQUIRE(half.thd < full.thd * 0.7);
        REQUIRE(quiet.thd < full.thd);
        for (double v : full.out)
            REQUIRE(std::isfinite(v));
    }
    ConsoleStage ssl = stage(false, "snare", ConsoleFlavour::ssl, 1.0f);
    ConsoleStage neve = stage(false, "snare", ConsoleFlavour::neve, 1.0f);
    const Harm hs = harmonics(ssl, 1000.0, 0.5), hn = harmonics(neve, 1000.0, 0.5);
    REQUIRE(hs.h3 > hs.h2);
    REQUIRE(hn.h2 > hn.h3);
}

TEST_CASE("console: every strip a little different (within +/-0.6 dB, pairs >= 0.03 dB apart), same name = same curve",
          "[console]")
{
    const double freqs[] = {60.0, 120.0, 250.0, 1000.0, 4000.0, 8000.0, 12000.0};
    std::map<std::string, std::vector<double>> curves;
    for (const char* n : kStrips)
    {
        std::vector<double> c;
        for (double f : freqs)
        {
            ConsoleStage s = stage(false, n, ConsoleFlavour::ssl, 1.0f);
            c.push_back(gainAt(s, f));
        }
        curves[n] = c;
    }
    double worstAbs = 0.0, minDiff = 1e9;
    for (const auto& [a, ca] : curves)
    {
        for (double v : ca)
            worstAbs = std::max(worstAbs, std::abs(v));
        for (const auto& [b, cb] : curves)
        {
            if (a >= b)
                continue;
            double d = 0.0;
            for (std::size_t i = 0; i < ca.size(); ++i)
                d = std::max(d, std::abs(ca[i] - cb[i]));
            minDiff = std::min(minDiff, d);
        }
    }
    INFO("worst |tilt| " << worstAbs << " dB, min pair difference " << minDiff << " dB");
    REQUIRE(worstAbs <= 0.6);
    REQUIRE(minDiff >= 0.03);
    for (std::size_t i = 0; i < 7; ++i)
    {
        ConsoleStage s = stage(false, "kick", ConsoleFlavour::ssl, 1.0f);
        REQUIRE(std::abs(gainAt(s, freqs[i]) - curves["kick"][i]) < 1e-6);
    }
}

TEST_CASE("console: sub-sonic HPF, the NEVE bus softens 16 kHz, AMOUNT 0 transparent, +12 dBFS bounded, no DC",
          "[console]")
{
    {
        ConsoleStage s = stage(false, "kick", ConsoleFlavour::ssl, 1.0f);
        REQUIRE(gainAt(s, 10.0) < -12.0);
    }
    {
        ConsoleStage s = stage(false, "kick", ConsoleFlavour::ssl, 1.0f);
        REQUIRE(gainAt(s, 40.0) > -2.5);
    }
    {
        ConsoleStage b = stage(true, "master", ConsoleFlavour::neve, 1.0f);
        const double hi = gainAt(b, 16000.0);
        INFO("NEVE bus 16 kHz " << hi << " dB");
        REQUIRE(hi < -0.5);
        REQUIRE(hi > -4.0);
    }
    {
        ConsoleStage s = stage(false, "kick", ConsoleFlavour::api, 0.0f);
        const Harm z = harmonics(s, 1000.0, 0.5);
        REQUIRE(z.thd < 0.0005);
        REQUIRE(std::abs(20.0 * std::log10(z.fund / 0.5)) < 0.05);
    }
    {
        ConsoleStage s = stage(false, "kick", ConsoleFlavour::ssl, 1.0f);
        auto hot = run(s, 80.0, 4.0, 0.5);
        double peak = 0.0;
        for (double v : hot)
        {
            REQUIRE(std::isfinite(v));
            peak = std::max(peak, std::abs(v));
        }
        REQUIRE(peak < 4.5);
    }
    {
        ConsoleStage s = stage(false, "kick", ConsoleFlavour::neve, 1.0f);
        auto y = run(s, 1000.0, 0.8, 1.0);
        double mean = 0.0;
        const int from = static_cast<int>(kSr / 2);
        for (std::size_t i = static_cast<std::size_t>(from); i < y.size(); ++i)
            mean += y[i];
        mean /= static_cast<double>(y.size() - static_cast<std::size_t>(from));
        REQUIRE(std::abs(mean) < 1e-3);
    }
    // the AMOUNT glide: 1/1024 per frame — a 0 -> 1 move takes ~1024 frames, then it is AT the setting
    {
        ConsoleStage s = stage(false, "kick", ConsoleFlavour::ssl, 0.0f);
        s.set(ConsoleFlavour::ssl, 1.0f, false);
        std::vector<double> l(kBlock, 0.0), r(kBlock, 0.0);
        s.process(l.data(), r.data(), kBlock);
        REQUIRE(s.amount() == Approx(128.0 / 1024.0));
        for (int b = 0; b < 10; ++b)
            s.process(l.data(), r.data(), kBlock);
        REQUIRE(s.amount() == 1.0f);
    }
}

TEST_CASE("console: through the Mixer - on / off / the seed command / the snapshot flag", "[console]")
{
    Engine engine;
    engine.prepare({kSr, 64, 2, 0});
    const auto kickSeed = ConsoleStage::fnv1a("kick");
    engine.commands().push(Command::mixerSetStrip(1, static_cast<std::uint8_t>(StripKind::channel), kickSeed));
    std::vector<float> a(64), b(64);
    float* outs[2] = {a.data(), b.data()};
    engine.process(outs, 2, 64);
    REQUIRE(engine.mixer().console(1).seed() == kickSeed);
    REQUIRE_FALSE(engine.mixer().console(1).isBus());
    REQUIRE(engine.mixer().console(0).isBus());
    REQUIRE(engine.snapshot().mixerConsoleOn == 0);
    // a -6 dBFS 1 kHz sine into strip 1 through the Mixer directly: off = the dry sine bit-exact, on = harmonics
    Mixer m;
    m.prepare(kSr, kBlock);
    m.setStripKind(1, StripKind::channel);
    m.setStripSeed(1, kickSeed);
    m.setOutput(1, StripOutput::hardware, 0); // straight out: the CHANNEL stage alone (the master adds its BUS stage)
    std::vector<float> oL(kBlock), oR(kBlock);
    float* mo[2] = {oL.data(), oR.data()};
    auto runMixer = [&](double seconds)
    {
        const int blocks = static_cast<int>(seconds * kSr / kBlock);
        std::vector<double> out;
        for (int bl = 0; bl < blocks; ++bl)
        {
            std::fill(oL.begin(), oL.end(), 0.0f);
            std::fill(oR.begin(), oR.end(), 0.0f);
            m.clearInputs(kBlock);
            for (int i = 0; i < kBlock; ++i)
            {
                const double x = 0.5 * std::sin(kTwoPi * 1000.0 * static_cast<double>(bl * kBlock + i) / kSr);
                m.inputs()[2][i] += x;
                m.inputs()[3][i] += x;
            }
            m.process(mo, 2, kBlock);
            for (int i = 0; i < kBlock; ++i)
                out.push_back(static_cast<double>(oL[static_cast<std::size_t>(i)]));
        }
        return out;
    };
    auto thdOf = [&](const std::vector<double>& y)
    {
        const int from = static_cast<int>(0.3 * kSr), to = from + static_cast<int>(0.5 * kSr);
        const double f = mag(y, 1000.0, from, to);
        double sum = 0.0;
        for (int k = 2; k <= 8; ++k)
        {
            const double r = mag(y, 1000.0 * k, from, to) / f;
            sum += r * r;
        }
        return std::sqrt(sum);
    };
    const auto dry = runMixer(1.0);
    REQUIRE(thdOf(dry) < 1e-5);
    m.setConsole(true, ConsoleFlavour::ssl, 100.0f);
    REQUIRE(m.consoleOn());
    const auto desk = runMixer(1.0);
    const double thd = thdOf(desk);
    INFO("SSL 100 on the kick strip through the Mixer: THD " << thd * 100.0 << " %");
    REQUIRE(thd > 0.003);
    REQUIRE(thd < 0.02);
    // through the master the BUS stage adds its own harmonics (the page's master carries the bus stage too)
    m.setOutput(1, StripOutput::master, 0);
    const auto viaMaster = runMixer(1.0);
    const double thdBus = thdOf(viaMaster);
    INFO("… via the master (channel + bus stage): THD " << thdBus * 100.0 << " %");
    REQUIRE(thdBus > thd);
    REQUIRE(thdBus < 0.05);
    m.setOutput(1, StripOutput::hardware, 0);
    m.setConsole(false, ConsoleFlavour::ssl, 100.0f);
    const auto dry2 = runMixer(1.0);
    REQUIRE(thdOf(dry2) < 1e-5);
    // the command path + the snapshot
    engine.commands().push(Command::mixerSetConsole(true, 1, 50.0f));
    engine.process(outs, 2, 64);
    REQUIRE(engine.snapshot().mixerConsoleOn == 1);
    REQUIRE(engine.mixer().consoleFlavour() == ConsoleFlavour::neve);
    REQUIRE(engine.mixer().consoleAmount() == 50.0f);
    engine.commands().push(Command::mixerSetConsole(false, 0, 50.0f));
    engine.process(outs, 2, 64);
    REQUIRE(engine.snapshot().mixerConsoleOn == 0);
}

TEST_CASE("master limiter: the page's -1 dBFS / 20:1 DynamicsCompressor on the master (Blink's kernel), off by default",
          "[console][limiter]")
{
    Mixer m;
    m.prepare(kSr, kBlock);
    m.setStripKind(1, StripKind::channel);
    std::vector<float> oL(kBlock), oR(kBlock);
    float* mo[2] = {oL.data(), oR.data()};
    auto runSine = [&](double amp, double seconds)
    {
        const int blocks = static_cast<int>(seconds * kSr / kBlock);
        std::vector<double> out;
        for (int bl = 0; bl < blocks; ++bl)
        {
            std::fill(oL.begin(), oL.end(), 0.0f);
            std::fill(oR.begin(), oR.end(), 0.0f);
            m.clearInputs(kBlock);
            for (int i = 0; i < kBlock; ++i)
            {
                const double x = amp * std::sin(kTwoPi * 1000.0 * static_cast<double>(bl * kBlock + i) / kSr);
                m.inputs()[2][i] += x;
                m.inputs()[3][i] += x;
            }
            m.process(mo, 2, kBlock);
            for (int i = 0; i < kBlock; ++i)
                out.push_back(static_cast<double>(oL[static_cast<std::size_t>(i)]));
        }
        return out;
    };
    // off (the default): bit-exact unity through the master
    REQUIRE_FALSE(m.masterLimiter());
    REQUIRE(m.masterLatencySamples() == 0);
    auto dry = runSine(0.5, 0.1);
    REQUIRE(dry[1000] == Approx(0.5 * std::sin(kTwoPi * 1000.0 * 1000.0 / kSr)).margin(1e-7));
    // on: the look-ahead is the master's latency (int(0.006 · 44100) = 264), an impulse lands there
    m.setMasterLimiter(true);
    REQUIRE(m.masterLatencySamples() == 264);
    {
        runSine(0.0, 1.0); // let Blink's start-up dip settle
        std::vector<double> out;
        for (int bl = 0; bl < 4; ++bl)
        {
            std::fill(oL.begin(), oL.end(), 0.0f);
            std::fill(oR.begin(), oR.end(), 0.0f);
            m.clearInputs(kBlock);
            if (bl == 0)
            {
                m.inputs()[2][0] += 0.5;
                m.inputs()[3][0] += 0.5;
            }
            m.process(mo, 2, kBlock);
            for (int i = 0; i < kBlock; ++i)
                out.push_back(static_cast<double>(oL[static_cast<std::size_t>(i)]));
        }
        int at = 0;
        for (std::size_t i = 1; i < out.size(); ++i)
            if (std::abs(out[i]) > std::abs(out[static_cast<std::size_t>(at)]))
                at = static_cast<int>(i);
        REQUIRE(at == 264);
    }
    // a -20 dBFS sine passes with Blink's perceptual makeup (+0.57 dB: (1/saturate(1))^0.6 at -1 dB / 20:1)
    {
        auto y = runSine(0.1, 1.5);
        double ss = 0.0;
        const std::size_t from = y.size() / 2;
        for (std::size_t i = from; i < y.size(); ++i)
            ss += y[i] * y[i];
        const double gainDb = 10.0 * std::log10(ss / static_cast<double>(y.size() - from) / (0.1 * 0.1 / 2.0));
        INFO("-20 dBFS through the limiter: " << gainDb << " dB");
        REQUIRE(gainDb == Approx(0.57).margin(0.15));
    }
    // a +6 dBFS sine is held to about 0 dBFS (Blink's is not a brickwall: the static curve at 20:1 leaves +0.3 dB of
    // the 6 dB overshoot, the makeup adds 0.57, and the 2.5 ms detector release rides between a 1 kHz sine's peaks —
    // the page's DynamicsCompressor "safety limiter" lets ~+0.2 dBFS through here, exactly as this does)
    {
        auto y = runSine(2.0, 1.5);
        double peak = 0.0;
        for (std::size_t i = y.size() / 2; i < y.size(); ++i)
            peak = std::max(peak, std::abs(y[i]));
        INFO("+6 dBFS in: peak " << peak);
        REQUIRE(peak < 1.1);
        REQUIRE(peak > 0.9);
    }
    // the command + the snapshot
    Engine engine;
    engine.prepare({kSr, 64, 2, 0});
    std::vector<float> a(64), b(64);
    float* outs[2] = {a.data(), b.data()};
    engine.process(outs, 2, 64);
    REQUIRE(engine.snapshot().mixerLimiterOn == 0);
    engine.commands().push(Command::mixerSetLimiter(true));
    engine.process(outs, 2, 64);
    REQUIRE(engine.snapshot().mixerLimiterOn == 1);
    REQUIRE(engine.mixer().masterLatencySamples() == 264);
}
