// M/S EVERYWHERE (Phase 4.7a) — the insert chain's per-slot ROUTE (STEREO / MID / SIDE / LEFT / RIGHT). It is a
// property of the SLOT rather than of the device, so all 25 devices get it at once; these gates hold it to that.
// The one that matters most is the last: a routed device WITH LATENCY delays only the half it touches, so the other
// half is delayed to match — without that the two comb-filter when they are recombined, which sounds like a broken
// plugin and cannot be diagnosed by ear.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <vector>

#include "terminator/core/Mixer.h"
#include "terminator/core/fx/FxPool.h"
#include "terminator/render/ProjectRenderer.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;
constexpr int kBlock = 128;

/// A mixer with one channel strip carrying one device, and a way to push audio through it.
struct Rig
{
    FxPool pool;
    Mixer mixer;
    int strip = 1;

    Rig(FxType type, int paramIdx = -1, float paramVal = 0.0f)
    {
        pool.prepare(kSr, kBlock);
        mixer.setPool(&pool);
        mixer.prepare(kSr, kBlock);
        mixer.setStripKind(strip, StripKind::channel);
        REQUIRE(mixer.addFx(strip, type));
        if (paramIdx >= 0)
            mixer.setFxParam(strip, 0, paramIdx, paramVal, true);
    }

    /// Push (l, r) through the strip and read the master out. The Mixer ACCUMULATES into its outputs, so a bare-
    /// mixer rig has to zero them every block (the Engine is what normally does that).
    void run(const std::vector<double>& inL, const std::vector<double>& inR, std::vector<double>& outL,
             std::vector<double>& outR)
    {
        const int total = static_cast<int>(inL.size());
        outL.assign(static_cast<std::size_t>(total), 0.0);
        outR.assign(static_cast<std::size_t>(total), 0.0);
        std::vector<float> bl(static_cast<std::size_t>(kBlock)), br(static_cast<std::size_t>(kBlock));
        float* outs[2] = {bl.data(), br.data()};
        int done = 0;
        while (done < total)
        {
            const int n = std::min(kBlock, total - done);
            std::fill_n(bl.begin(), n, 0.0f);
            std::fill_n(br.begin(), n, 0.0f);
            mixer.clearInputs(n);
            double* const* in = mixer.inputs();
            for (int i = 0; i < n; ++i)
            {
                in[static_cast<std::size_t>(strip) * 2][i] = inL[static_cast<std::size_t>(done + i)];
                in[static_cast<std::size_t>(strip) * 2 + 1][i] = inR[static_cast<std::size_t>(done + i)];
            }
            mixer.process(outs, 2, n);
            for (int i = 0; i < n; ++i)
            {
                outL[static_cast<std::size_t>(done + i)] = static_cast<double>(bl[static_cast<std::size_t>(i)]);
                outR[static_cast<std::size_t>(done + i)] = static_cast<double>(br[static_cast<std::size_t>(i)]);
            }
            done += n;
        }
    }
};

double rmsOf(const std::vector<double>& v, int from, int to)
{
    double s = 0.0;
    for (int i = from; i < to; ++i)
        s += v[static_cast<std::size_t>(i)] * v[static_cast<std::size_t>(i)];
    return std::sqrt(s / static_cast<double>(std::max(1, to - from)));
}
} // namespace

TEST_CASE("route: STEREO is the default and changes nothing", "[mixer][route]")
{
    Rig rig(FxType::utility);
    CHECK(rig.mixer.fxRoute(rig.strip, 0) == FxRoute::stereo);
    // UTILITY at its defaults is unity, so the strip has to be transparent whatever the routing machinery does.
    const int n = 2048;
    std::vector<double> l(n), r(n), ol, orr;
    for (int i = 0; i < n; ++i)
    {
        l[static_cast<std::size_t>(i)] = 0.4 * std::sin(6.283185307179586 * 300.0 * static_cast<double>(i) / kSr);
        r[static_cast<std::size_t>(i)] = 0.25 * std::sin(6.283185307179586 * 700.0 * static_cast<double>(i) / kSr);
    }
    rig.run(l, r, ol, orr);
    for (int i = 0; i < n; ++i)
    {
        REQUIRE(ol[static_cast<std::size_t>(i)] == Approx(l[static_cast<std::size_t>(i)]).margin(1e-9));
        REQUIRE(orr[static_cast<std::size_t>(i)] == Approx(r[static_cast<std::size_t>(i)]).margin(1e-9));
    }
}

TEST_CASE("route: MID and SIDE each touch only their own half", "[mixer][route]")
{
    // A device that silences what it is given (UTILITY at -20 dB is close enough to measure with) proves the split:
    // routed to MID, a dead-centre signal is attenuated and a purely-side signal is untouched, and the other way
    // round for SIDE.
    const int n = 4096;
    std::vector<double> centreL(n), centreR(n), sideL(n), sideR(n), ol, orr;
    for (int i = 0; i < n; ++i)
    {
        const double v = 0.5 * std::sin(6.283185307179586 * 400.0 * static_cast<double>(i) / kSr);
        centreL[static_cast<std::size_t>(i)] = v; // identical = pure mid
        centreR[static_cast<std::size_t>(i)] = v;
        sideL[static_cast<std::size_t>(i)] = v; // opposite = pure side
        sideR[static_cast<std::size_t>(i)] = -v;
    }
    const auto levels = [&](FxRoute route, const std::vector<double>& il, const std::vector<double>& ir)
    {
        Rig rig(FxType::utility, 0, -20.0f); // GAIN −20 dB
        rig.mixer.setFxRoute(rig.strip, 0, route);
        REQUIRE(rig.mixer.fxRoute(rig.strip, 0) == route);
        std::vector<double> a, b;
        rig.run(il, ir, a, b);
        return rmsOf(a, n / 2, n);
    };
    const double midOnCentre = levels(FxRoute::mid, centreL, centreR);
    const double midOnSide = levels(FxRoute::mid, sideL, sideR);
    const double sideOnCentre = levels(FxRoute::side, centreL, centreR);
    const double sideOnSide = levels(FxRoute::side, sideL, sideR);
    const double untouched = rmsOf(centreL, n / 2, n);

    CHECK(midOnCentre < untouched * 0.2);                              // MID routing turned the centre down…
    CHECK(midOnSide == Approx(untouched).margin(untouched * 0.02));    // …and left the sides alone
    CHECK(sideOnSide < untouched * 0.2);                               // SIDE routing turned the sides down…
    CHECK(sideOnCentre == Approx(untouched).margin(untouched * 0.02)); // …and left the centre alone
}

TEST_CASE("route: LEFT and RIGHT touch one channel only", "[mixer][route]")
{
    const int n = 2048;
    std::vector<double> l(n), r(n), ol, orr;
    for (int i = 0; i < n; ++i)
    {
        l[static_cast<std::size_t>(i)] = 0.5 * std::sin(6.283185307179586 * 300.0 * static_cast<double>(i) / kSr);
        r[static_cast<std::size_t>(i)] = 0.5 * std::sin(6.283185307179586 * 300.0 * static_cast<double>(i) / kSr);
    }
    Rig rig(FxType::utility, 0, -20.0f);
    rig.mixer.setFxRoute(rig.strip, 0, FxRoute::left);
    rig.run(l, r, ol, orr);
    CHECK(rmsOf(ol, n / 2, n) < rmsOf(l, n / 2, n) * 0.2);
    CHECK(rmsOf(orr, n / 2, n) == Approx(rmsOf(r, n / 2, n)).margin(rmsOf(r, n / 2, n) * 0.02));
}

TEST_CASE("route: a routed device WITH LATENCY keeps the halves aligned", "[mixer][route]")
{
    // THE ONE THAT MATTERS. The LIMITER reports its look-ahead as latency. Routed to MID with a bypassed-in-effect
    // setting (a ceiling it never reaches), the mid is delayed by the look-ahead — so the side must be delayed by
    // exactly the same or the recombination combs. Measured on a pure-SIDE signal, which must come back whole.
    const int n = 8192;
    std::vector<double> l(n), r(n), ol, orr;
    for (int i = 0; i < n; ++i)
    {
        const double v = 0.3 * std::sin(6.283185307179586 * 500.0 * static_cast<double>(i) / kSr);
        l[static_cast<std::size_t>(i)] = v;
        r[static_cast<std::size_t>(i)] = -v; // pure side: the MID-routed limiter has nothing to do
    }
    Rig rig(FxType::limiter);
    rig.mixer.setFxParam(rig.strip, 0, 4, 5.0f, true); // LOOKAHEAD 5 ms — 240 samples at 48 k
    rig.mixer.setFxRoute(rig.strip, 0, FxRoute::mid);
    REQUIRE(rig.mixer.fxRoute(rig.strip, 0) == FxRoute::mid);
    rig.run(l, r, ol, orr);
    // The side survives at full level (a comb would notch it) and the two channels stay opposite.
    const int from = n / 2, to = n - 512;
    CHECK(rmsOf(ol, from, to) == Approx(rmsOf(l, from, to)).margin(rmsOf(l, from, to) * 0.05));
    for (int i = from; i < to; ++i)
        REQUIRE(ol[static_cast<std::size_t>(i)] == Approx(-orr[static_cast<std::size_t>(i)]).margin(1e-6));
}

TEST_CASE("route: when the compensation lines run out, the slot stays STEREO", "[mixer][route]")
{
    // Routing anyway would comb — so the mixer refuses and counts it, rather than sounding subtly broken.
    FxPool pool;
    pool.prepare(kSr, kBlock);
    Mixer mixer;
    mixer.setPool(&pool);
    mixer.prepare(kSr, kBlock);
    int routed = 0;
    for (int strip = 1; strip <= 4; ++strip)
    {
        mixer.setStripKind(strip, StripKind::channel);
        for (int slot = 0; slot < 4; ++slot)
        {
            mixer.addFx(strip, FxType::limiter);
            mixer.setFxParam(strip, slot, 4, 5.0f, true);
            mixer.setFxRoute(strip, slot, FxRoute::mid);
            if (mixer.fxRoute(strip, slot) == FxRoute::mid)
                ++routed;
        }
    }
    CHECK(routed == kMaxRoutedLatencySlots);
    CHECK(mixer.routeRejected() == static_cast<std::uint32_t>(16 - kMaxRoutedLatencySlots));
    // …and a ZERO-latency device is never limited by that pool, because it needs no compensation at all.
    mixer.setStripKind(5, StripKind::channel);
    REQUIRE(mixer.addFx(5, FxType::ladder));
    mixer.setFxRoute(5, 0, FxRoute::side);
    CHECK(mixer.fxRoute(5, 0) == FxRoute::side);
}

// ---- GROUPS + BUSES (4.7d) -------------------------------------------------------------------------------------
// A strip can feed another strip instead of the master, which is what a group bus is. The engine already owned the
// routing graph and its cycle guard; what these gate is that the EXPORT resolves the page's saved routing — a
// group that only exists during playback and collapses in the bounce would be worse than no groups at all.

TEST_CASE("groups: the exporter resolves a strip's routing by name", "[mixer][route][groups]")
{
    juce::ValueTree project("Project");
    juce::DynamicObject::Ptr chans(new juce::DynamicObject());
    const auto channel = [&](const char* name, const char* out)
    {
        juce::DynamicObject::Ptr c(new juce::DynamicObject());
        c->setProperty("fader", 0.0);
        if (out != nullptr)
            c->setProperty("out", juce::String(out));
        chans->setProperty(juce::Identifier(name), juce::var(c.get()));
    };
    channel("kick", "bus1");
    channel("snare", "bus1");
    channel("hat", nullptr); // no key at all = an older project = the master
    channel("bus1", "master");
    juce::DynamicObject::Ptr blob(new juce::DynamicObject());
    blob->setProperty("channels", juce::var(chans.get()));
    project.setProperty("mixer", juce::var(blob.get()), nullptr);

    render::StripNamer namer;
    const auto spec = render::buildMixerSpec(project, namer, {}, {}, true);
    const auto find = [&](const juce::String& name)
    {
        const int idx = namer(name);
        for (const auto& st : spec.strips)
            if (st.index == idx)
                return st;
        FAIL("strip not in the spec: " << name);
        return RenderStripSpec{};
    };
    const auto kick = find("kick"), snare = find("snare"), hat = find("hat"), bus = find("bus1");
    CHECK(kick.outKind == StripOutput::strip);
    CHECK(kick.outIndex == bus.index);
    CHECK(snare.outIndex == bus.index);
    CHECK(hat.outKind == StripOutput::master); // the safe default, and where it was before groups existed
    CHECK(bus.outKind == StripOutput::master);
    // …and the bus is a BUS, so PDC puts it in the bus tier with the sends rather than with the channels feeding it
    CHECK(bus.kind == StripKind::bus);
    CHECK(kick.kind == StripKind::channel);
}

TEST_CASE("groups: the engine refuses a routing cycle", "[mixer][route][groups]")
{
    // The page never has to police this — the guard is here, where the graph is.
    FxPool pool;
    pool.prepare(kSr, kBlock);
    Mixer mixer;
    mixer.setPool(&pool);
    mixer.prepare(kSr, kBlock);
    mixer.setStripKind(1, StripKind::channel);
    mixer.setStripKind(2, StripKind::bus);
    mixer.setStripKind(3, StripKind::bus);
    CHECK(mixer.setOutput(1, StripOutput::strip, 2));       // channel → bus
    CHECK(mixer.setOutput(2, StripOutput::strip, 3));       // bus → bus
    CHECK_FALSE(mixer.setOutput(3, StripOutput::strip, 2)); // …would close the loop
    CHECK_FALSE(mixer.setOutput(3, StripOutput::strip, 1)); // …so would going back to the channel
    CHECK_FALSE(mixer.setOutput(2, StripOutput::strip, 2)); // and a strip cannot feed itself
    CHECK(mixer.setOutput(3, StripOutput::master, 0));      // the master is always allowed
}

TEST_CASE("groups: audio really arrives at the bus and not at the master", "[mixer][route][groups]")
{
    FxPool pool;
    pool.prepare(kSr, kBlock);
    Mixer mixer;
    mixer.setPool(&pool);
    mixer.prepare(kSr, kBlock);
    mixer.setStripKind(1, StripKind::channel);
    mixer.setStripKind(2, StripKind::bus);
    REQUIRE(mixer.setOutput(1, StripOutput::strip, 2));

    const int n = kBlock; // NEVER more than the block the mixer was prepared for — its buffers are sized for it
    std::vector<float> bl(static_cast<std::size_t>(n)), br(static_cast<std::size_t>(n));
    float* outs[2] = {bl.data(), br.data()};
    // Several blocks per measurement: the fader glides (tau 8 ms), so one 128-sample block is nowhere near enough
    // for a −40 dB move to have happened.
    const auto push = [&](float busFader)
    {
        mixer.setFader(2, busFader);
        double peakOut = 0.0;
        for (int b = 0; b < 24; ++b)
        {
            std::fill(bl.begin(), bl.end(), 0.0f);
            std::fill(br.begin(), br.end(), 0.0f);
            mixer.clearInputs(n);
            double* const* in = mixer.inputs();
            for (int i = 0; i < n; ++i)
                in[2][i] = in[3][i] = 0.5;
            mixer.process(outs, 2, n);
            peakOut = 0.0; // only the LAST block counts — the earlier ones are the glide
            for (int i = 0; i < n; ++i)
                peakOut = std::max(peakOut, std::abs(static_cast<double>(bl[static_cast<std::size_t>(i)])));
        }
        return peakOut;
    };
    const double atUnity = push(0.0f);
    const double turnedDown = push(-40.0f);
    CHECK(atUnity > 0.4);
    // THE proof that the routing is real: pulling the BUS's fader down takes the channel with it.
    CHECK(turnedDown < atUnity * 0.1);
}
