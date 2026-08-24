// PLUGINS AS INSERTS (Phase 6.2) — the ENGINE's half, which is deliberately tiny: a slot that holds a pointer.
// The plugin format, the instance and its editor live in the APP; the engine must stay headless (the CLI renderer
// and these tests link it with no plugin machinery at all). What has to be true here:
//   · an EMPTY plugin slot is a pass-through, bit for bit — a chain restored from a project keeps its slot while
//     the app is still loading the plugin, and the mix does not stop for it;
//   · an attached processor is heard, and the chain's WET crossfade blends it like any other device;
//   · its LATENCY joins the PDC plan the moment it attaches (a plugin brings its latency with it);
//   · attaching, detaching and processing allocate nothing on the audio thread.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "AllocationCounter.h"
#include "TestSamples.h"
#include "terminator/core/Engine.h"
#include "terminator/core/fx/PluginFx.h"
#include "terminator/render/OfflineRenderer.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;
constexpr std::uint8_t kChannel = static_cast<std::uint8_t>(StripKind::channel);
constexpr std::uint8_t kPlugin = static_cast<std::uint8_t>(FxType::plugin);

/// What the app hands the engine, standing in for a real VST3: a gain and a reported latency.
struct FakePlugin final : ExternalProcessor
{
    float gain = 0.5f;
    int latency = 0;
    int blocks = 0;
    void processBlock(float* const* channels, int numChannels, int numSamples) noexcept override
    {
        ++blocks;
        for (int c = 0; c < numChannels; ++c)
            for (int i = 0; i < numSamples; ++i)
                channels[c][i] *= gain;
    }
    int latencySamples() const noexcept override { return latency; }
};

struct Rig
{
    Engine engine;
    int block;
    std::vector<std::vector<float>> outData;
    std::vector<float*> outPtrs;
    std::vector<std::shared_ptr<SampleBuffer>> keep;

    explicit Rig(int blockSize = 128)
        : block(blockSize), outData(2, std::vector<float>(static_cast<std::size_t>(blockSize), 0.0f))
    {
        for (auto& c : outData)
            outPtrs.push_back(c.data());
        engine.prepare({kSr, blockSize, 2, 0, 0});
    }
    void push(const Command& c) { REQUIRE(engine.commands().push(c)); }
    void run(int blocks = 1)
    {
        for (int i = 0; i < blocks; ++i)
            engine.process(outPtrs.data(), 2, block);
    }
    void settle() { run(static_cast<int>(0.4 * kSr / block) + 1); }
    /// A DC pad on `strip` at `level`, held long enough for any test.
    void bindPad(int pad, float level, int strip)
    {
        auto s = test::dc(static_cast<std::int64_t>(kSr * 10.0), level, kSr, 1);
        keep.push_back(s);
        PadParams p;
        p.pad = static_cast<std::uint16_t>(pad);
        p.attackSec = 0.0f;
        p.interpolation = Interpolation::linear;
        p.chokeGroup = -2;
        p.strip = static_cast<std::int16_t>(strip);
        push(Command::setPadParams(p));
        push(Command::setPadSample(static_cast<std::uint16_t>(pad), s.get()));
    }
    float out(int ch, int i = 64) const { return outData[static_cast<std::size_t>(ch)][static_cast<std::size_t>(i)]; }
};
} // namespace

TEST_CASE("plugin insert: an EMPTY plugin slot passes the audio through untouched", "[plugin]")
{
    // The app takes a moment to instantiate a plugin. The slot exists from the moment the chain says so, and until
    // the instance arrives it must be inaudible rather than silent.
    Rig plain(128), slotted(128);
    for (Rig* r : {&plain, &slotted})
    {
        r->push(Command::mixerSetStrip(1, kChannel));
        r->bindPad(0, 0.4f, 1);
        r->settle();
    }
    slotted.push(Command::mixerAddFx(1, kPlugin));
    slotted.settle();
    plain.push(Command::triggerPad(0, 1.0f));
    slotted.push(Command::triggerPad(0, 1.0f));
    plain.run(4);
    slotted.run(4);
    CHECK(slotted.engine.mixer().fxCount(1) == 1);
    for (int i = 0; i < 128; i += 16)
        CHECK(slotted.out(0, i) == plain.out(0, i)); // bit for bit
}

TEST_CASE("plugin insert: an attached processor is heard, and WET blends it", "[plugin]")
{
    Rig r(128);
    FakePlugin plugin;
    plugin.gain = 0.5f;
    r.push(Command::mixerSetStrip(1, kChannel));
    r.bindPad(0, 0.4f, 1);
    r.push(Command::mixerAddFx(1, kPlugin));
    r.push(Command::mixerSetFxProcessor(1, 0, &plugin));
    r.settle();
    r.push(Command::triggerPad(0, 1.0f));
    r.run(4);
    CHECK(plugin.blocks > 0);
    CHECK(r.out(0) == Approx(0.2f).margin(0.001)); // 0.4 x 0.5
    // WET 50 = half the dry, half the plugin: 0.4 x 0.5 + 0.2 x 0.5 = 0.3
    r.push(Command::mixerSetFxParam(1, 0, 0, 50.0f, true));
    r.settle();
    CHECK(r.out(0) == Approx(0.3f).margin(0.002));
    // detached, the slot is a pass-through again
    r.push(Command::mixerSetFxProcessor(1, 0, nullptr));
    r.push(Command::mixerSetFxParam(1, 0, 0, 100.0f, true));
    r.settle();
    CHECK(r.out(0) == Approx(0.4f).margin(0.001));
}

TEST_CASE("plugin insert: the plugin's latency joins the PDC plan when it attaches", "[plugin][pdc]")
{
    Rig r(128);
    FakePlugin plugin;
    plugin.gain = 1.0f;
    plugin.latency = 512; // a look-ahead limiter's worth
    r.push(Command::mixerSetStrip(1, kChannel));
    r.push(Command::mixerAddFx(1, kPlugin));
    r.settle();
    CHECK(r.engine.mixer().chainLatencySamples(1) == 0); // nothing attached: nothing to compensate
    r.push(Command::mixerSetFxProcessor(1, 0, &plugin));
    r.settle();
    CHECK(r.engine.mixer().chainLatencySamples(1) == 512);
    r.push(Command::mixerSetFxProcessor(1, 0, nullptr));
    r.settle();
    CHECK(r.engine.mixer().chainLatencySamples(1) == 0);
}

TEST_CASE("plugin insert: attaching and running a plugin slot allocates nothing on the audio thread", "[plugin][rt]")
{
    Rig r(128);
    FakePlugin plugin;
    r.push(Command::mixerSetStrip(1, kChannel));
    r.bindPad(0, 0.4f, 1);
    r.push(Command::mixerAddFx(1, kPlugin));
    r.settle();
    r.push(Command::triggerPad(0, 1.0f));
    r.run(2);
    const auto allocs = test::allocationsDuring(
        [&]
        {
            r.push(Command::mixerSetFxProcessor(1, 0, &plugin));
            r.run(8);
            r.push(Command::mixerSetFxProcessor(1, 0, nullptr));
            r.run(8);
        });
    CHECK(allocs == 0);
}

// ── THE EXPORT (Phase 6.4) ──────────────────────────────────────────────────────────────────────────────────────
// A plugin you can hear live but not in the file is the "heard live, missing from the export" trap this project
// already walked into once (4.6, before the export went native). So the offline renderer takes the processors the
// host loaded for it — and a plugin insert with NOBODY attached renders as the pass-through it is, rather than
// silence.
TEST_CASE("export: a plugin insert is in the rendered file", "[plugin][export]")
{

    auto impulse = std::make_shared<SampleBuffer>();
    impulse->allocate(1, 4096, kSr);
    for (std::int64_t i = 0; i < impulse->numFrames; ++i)
        impulse->channel(0)[i] = 0.0f;
    impulse->channel(0)[0] = 0.5f;

    auto build = [&](ExternalProcessor* proc)
    {
        RenderSpec spec;
        spec.sampleRate = kSr;
        spec.blockSize = 64;
        spec.numChannels = 2;
        spec.lengthSeconds = 0.05;
        spec.mixer.enabled = true;
        RenderStripSpec strip;
        strip.index = 1;
        strip.kind = StripKind::channel;
        RenderFxSpec fx;
        fx.type = FxType::plugin;
        fx.pluginId = "VST3-Something-0-0"; // what the project saved; the HOST is what turns it into a processor
        fx.processor = proc;
        strip.fx.push_back(fx);
        spec.mixer.strips.push_back(strip);
        RenderPadSpec p;
        p.params.pad = 0;
        p.params.attackSec = 0.0f;
        p.params.interpolation = Interpolation::linear;
        p.params.chokeGroup = -2;
        p.params.strip = 1;
        p.sample = impulse;
        spec.pads.push_back(p);
        RenderEvent e;
        e.pad = 0;
        e.timeSec = 0.0;
        e.velocity = 1.0f;
        spec.events.push_back(e);
        return spec;
    };

    FakePlugin plugin;
    plugin.gain = 0.25f;
    const auto withPlugin = renderOffline(build(&plugin));
    const auto without = renderOffline(build(nullptr));
    REQUIRE(plugin.blocks > 0);
    const auto peak = [](const RenderResult& r) { return r.buffer.getMagnitude(0, 0, r.buffer.getNumSamples()); };
    // nothing attached = the slot passes the impulse through at full level; attached = a quarter of it
    CHECK(peak(without) == Approx(0.5f).margin(0.01));
    CHECK(peak(withPlugin) == Approx(0.125f).margin(0.005));
}
