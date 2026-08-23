// EXPORTS THROUGH THE MIXER (Phase 4.5) — "export == what you hear" made literal: renderOffline() drives the SAME
// Engine, so once the render spec carries the mix (strips, inserts, console, limiter, PDC) the exported bytes come
// out of the same Mixer that is playing. The headline gate is MASTER IMPULSE == STEM IMPULSE: one render produces
// the master and every trackout through the stem taps, and each output pair is head-trimmed by its own latency, so
// a stem lines up with the master sample for sample no matter what latency the chains carry.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "terminator/core/Engine.h"
#include "terminator/core/Mixer.h"
#include "terminator/render/OfflineRenderer.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;
constexpr int kCompLatency = 288; // the 6 ms look-ahead at 48 k

/// A one-sample impulse of `amp` at frame 0.
std::shared_ptr<SampleBuffer> impulse(float amp)
{
    auto s = std::make_shared<SampleBuffer>();
    s->allocate(1, 4096, kSr);
    for (std::int64_t i = 0; i < s->numFrames; ++i)
        s->channel(0)[i] = 0.0f;
    s->channel(0)[0] = amp;
    return s;
}

void addPad(RenderSpec& spec, int pad, int strip, float amp)
{
    RenderPadSpec p;
    p.params.pad = static_cast<std::uint16_t>(pad);
    p.params.attackSec = 0.0f;
    p.params.interpolation = Interpolation::linear;
    p.params.chokeGroup = -2;
    p.params.strip = static_cast<std::int16_t>(strip);
    p.sample = impulse(amp);
    spec.pads.push_back(p);
    RenderEvent e;
    e.pad = static_cast<std::uint16_t>(pad);
    e.timeSec = 0.0;
    e.velocity = 1.0f;
    spec.events.push_back(e);
}

RenderStripSpec channel(int index, int tap = -1)
{
    RenderStripSpec s;
    s.index = index;
    s.kind = StripKind::channel;
    s.stemTap = tap;
    return s;
}

/// A COMP carrying RATIO 1 / MAKEUP 0: an exact 288-sample look-ahead delay and nothing else.
RenderFxSpec transparentComp()
{
    RenderFxSpec f;
    f.type = FxType::comp;
    f.params = {{1, 0.0f}, {2, 1.0f}, {5, 0.0f}}; // THRESHOLD 0 dBFS · RATIO 1:1 · MAKEUP 0 dB
    return f;
}

RenderSpec baseSpec(int numChannels, double seconds = 0.05)
{
    RenderSpec spec;
    spec.sampleRate = kSr;
    spec.blockSize = 64;
    spec.numChannels = numChannels;
    spec.lengthSeconds = seconds;
    spec.mixer.enabled = true;
    return spec;
}

/// Every sample of one channel above `floorAmp`, as (index, value).
std::vector<std::pair<int, float>> hits(const juce::AudioBuffer<float>& b, int ch, float floorAmp = 1.0e-4f)
{
    std::vector<std::pair<int, float>> h;
    const auto* p = b.getReadPointer(ch);
    for (int i = 0; i < b.getNumSamples(); ++i)
        if (std::abs(p[i]) > floorAmp)
            h.emplace_back(i, p[i]);
    return h;
}
} // namespace

TEST_CASE("export: no mixer section renders the Phase-3 direct path, unchanged", "[export]")
{
    RenderSpec spec = baseSpec(2);
    spec.mixer.enabled = false;
    addPad(spec, 0, -1, 0.5f); // strip −1 = straight to the output pair
    const auto r = renderOffline(spec);
    const auto h = hits(r.buffer, 0);
    REQUIRE(h.size() == 1);
    REQUIRE(h[0].first == 0);
    REQUIRE(h[0].second == 0.5f); // bit-exact, nothing in the way
    REQUIRE(r.pairLatency.size() == 1);
    REQUIRE(r.pairLatency[0] == 0);
}

TEST_CASE("export: the mix IS the mixer - the strip's fader is in the exported bytes", "[export]")
{
    RenderSpec spec = baseSpec(2);
    auto s = channel(1);
    s.faderDb = -6.0206f; // half
    spec.mixer.strips = {s};
    addPad(spec, 0, 1, 0.5f);
    const auto r = renderOffline(spec);
    const auto h = hits(r.buffer, 0);
    REQUIRE(h.size() == 1);
    REQUIRE(h[0].first == 0);
    REQUIRE(h[0].second == Approx(0.25f).margin(0.001)); // through the strip, not around it
}

TEST_CASE("export: MASTER IMPULSE == STEM IMPULSE with a latency chain on one channel", "[export]")
{
    // pair 0 = the master, pair 1 = channel 1's trackout (it carries a COMP), pair 2 = channel 2's (clean)
    RenderSpec spec = baseSpec(6);
    auto a = channel(1, 1);
    a.fx = {transparentComp()};
    auto b = channel(2, 2);
    spec.mixer.strips = {a, b};
    addPad(spec, 0, 1, 0.5f);
    addPad(spec, 1, 2, 0.25f);
    const auto r = renderOffline(spec);

    // the plan: both channels line up on the longest channel chain, and the master carries that too
    REQUIRE(r.pairLatency.size() == 3);
    REQUIRE(r.pairLatency[0] == kCompLatency); // master
    REQUIRE(r.pairLatency[1] == kCompLatency); // the COMP strip: its own chain, no catch-up delay
    REQUIRE(r.pairLatency[2] == kCompLatency); // the clean strip: no chain, all catch-up delay

    const auto master = hits(r.buffer, 0), stemA = hits(r.buffer, 2), stemB = hits(r.buffer, 4);
    REQUIRE(stemA.size() == 1);
    REQUIRE(stemB.size() == 1);
    REQUIRE(master.size() == 1);
    // every one of them starts on sample 0 - that is the gate
    REQUIRE(stemA[0].first == 0);
    REQUIRE(stemB[0].first == 0);
    REQUIRE(master[0].first == 0);
    REQUIRE(stemB[0].second == 0.25f); // the clean trackout is bit-exact
    // …and the master is exactly the stems summed: a trackout set that rebuilds the master
    for (int i = 0; i < r.buffer.getNumSamples(); ++i)
    {
        const float sum = r.buffer.getSample(2, i) + r.buffer.getSample(4, i);
        REQUIRE(r.buffer.getSample(0, i) == Approx(sum).margin(1.0e-6));
    }
}

TEST_CASE("export: a BUS return lines up with the dry channel beside it", "[export]")
{
    // channel 1 dry -> master (tap on pair 1); channel 2 -> bus 9 (a COMP) -> master (tap on pair 2)
    RenderSpec spec = baseSpec(6);
    auto dry = channel(1, 1);
    auto fed = channel(2);
    fed.outKind = StripOutput::strip;
    fed.outIndex = 9;
    RenderStripSpec bus;
    bus.index = 9;
    bus.kind = StripKind::bus;
    bus.stemTap = 2;
    bus.fx = {transparentComp()};
    spec.mixer.strips = {dry, fed, bus};
    addPad(spec, 0, 1, 0.5f);
    addPad(spec, 1, 2, 0.25f);
    const auto r = renderOffline(spec);

    REQUIRE(r.pairLatency[0] == kCompLatency); // master: nothing on the channels, the BUS's chain upstream
    REQUIRE(r.pairLatency[1] == 0);            // the dry channel's own tap carries no latency at all
    REQUIRE(r.pairLatency[2] == kCompLatency); // the bus's tap carries its own chain

    const auto master = hits(r.buffer, 0), dryStem = hits(r.buffer, 2), busStem = hits(r.buffer, 4);
    REQUIRE(dryStem.size() == 1);
    REQUIRE(busStem.size() == 1);
    REQUIRE(master.size() == 1);
    REQUIRE(dryStem[0].first == 0);
    REQUIRE(busStem[0].first == 0);
    REQUIRE(master[0].first == 0);
    REQUIRE(dryStem[0].second == 0.5f);
    for (int i = 0; i < r.buffer.getNumSamples(); ++i)
    {
        const float sum = r.buffer.getSample(2, i) + r.buffer.getSample(4, i);
        REQUIRE(r.buffer.getSample(0, i) == Approx(sum).margin(1.0e-6));
    }
}

TEST_CASE("export: the master limiter's look-ahead is trimmed off the master alone", "[export]")
{
    RenderSpec spec = baseSpec(4);
    spec.mixer.limiter = true;
    auto a = channel(1, 1);
    spec.mixer.strips = {a};
    addPad(spec, 0, 1, 0.5f);
    const auto r = renderOffline(spec);
    // the limiter is the MASTER's latency: the trackout does not carry it (a stem is post-strip, pre-master)
    REQUIRE(r.pairLatency[0] == 288); // int(0.006 * 48000)
    REQUIRE(r.pairLatency[1] == 0);
    const auto master = hits(r.buffer, 0), stem = hits(r.buffer, 2);
    REQUIRE(master.size() == 1);
    REQUIRE(stem.size() == 1);
    REQUIRE(master[0].first == 0); // still sample 0 - the head-trim took the look-ahead out
    REQUIRE(stem[0].first == 0);
    REQUIRE(stem[0].second == 0.5f); // the stem is untouched by the master's limiter
}

TEST_CASE("export: trimLatency off leaves the alignment delay in the file", "[export]")
{
    RenderSpec spec = baseSpec(2);
    spec.mixer.trimLatency = false;
    auto a = channel(1);
    a.fx = {transparentComp()};
    spec.mixer.strips = {a};
    addPad(spec, 0, 1, 0.5f);
    const auto r = renderOffline(spec);
    REQUIRE(r.pairLatency[0] == 0); // nothing was dropped…
    const auto h = hits(r.buffer, 0);
    REQUIRE(h.size() == 1);
    REQUIRE(h[0].first == kCompLatency); // …so the raw render still shows the chain's latency
}

TEST_CASE("export: PDC off exports the strips misaligned, exactly as it plays", "[export]")
{
    RenderSpec spec = baseSpec(2);
    spec.mixer.pdc = false;
    auto a = channel(1);
    a.fx = {transparentComp()};
    auto b = channel(2);
    spec.mixer.strips = {a, b};
    addPad(spec, 0, 1, 0.5f);
    addPad(spec, 1, 2, 0.25f);
    const auto r = renderOffline(spec);
    REQUIRE(r.pairLatency[0] == 0); // no plan, so the master carries no alignment latency
    const auto h = hits(r.buffer, 0);
    REQUIRE(h.size() == 2); // the clean channel early, the COMP channel 288 later - what you hear
    REQUIRE(h[0].first == 0);
    REQUIRE(h[0].second == 0.25f);
    REQUIRE(h[1].first == kCompLatency);
}

TEST_CASE("export: CONSOLE prints into the exported bytes", "[export]")
{
    auto render = [](bool console)
    {
        RenderSpec spec = baseSpec(2, 0.2);
        spec.mixer.consoleOn = console;
        spec.mixer.consoleAmount = 100.0f;
        auto a = channel(1);
        a.seed = 0xc61c131fu; // fnv1a("kick"), the page's own seed
        spec.mixer.strips = {a};
        addPad(spec, 0, 1, 0.5f);
        return renderOffline(spec);
    };
    const auto off = render(false), on = render(true);
    double diff = 0.0;
    for (int i = 0; i < off.buffer.getNumSamples(); ++i)
        diff += std::abs(static_cast<double>(on.buffer.getSample(0, i) - off.buffer.getSample(0, i)));
    REQUIRE(diff > 0.0);  // the desk stage is really in the render…
    REQUIRE(diff < 10.0); // …and it is a character stage, not a level change
}
