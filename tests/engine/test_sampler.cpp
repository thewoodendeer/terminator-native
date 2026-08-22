#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "AllocationCounter.h"
#include "TestSamples.h"
#include "terminator/core/Engine.h"
#include "terminator/core/planners/LoopRender.h"
#ifndef M_PI
#define M_PI 3.14159265358979323846 // MSVC does not define M_PI without _USE_MATH_DEFINES
#endif

using namespace terminator;
using Catch::Approx;

namespace
{
struct Rig
{
    Engine engine;
    std::vector<std::vector<float>> data;
    std::vector<float*> ptrs;
    int block;
    Rig(int outs, int blockSize, double sr = 48000.0)
        : data(static_cast<std::size_t>(outs), std::vector<float>(static_cast<std::size_t>(blockSize), 0.0f)),
          block(blockSize)
    {
        for (auto& c : data)
            ptrs.push_back(c.data());
        engine.prepare({sr, blockSize, outs, 0});
    }
    void run(int blocks = 1)
    {
        for (int i = 0; i < blocks; ++i)
            engine.process(ptrs.data(), static_cast<int>(ptrs.size()), block);
    }
    std::vector<float> capture(int ch, int blocks)
    {
        std::vector<float> out;
        for (int b = 0; b < blocks; ++b)
        {
            run();
            out.insert(out.end(), data[static_cast<std::size_t>(ch)].begin(), data[static_cast<std::size_t>(ch)].end());
        }
        return out;
    }
    PadParams params(int pad)
    {
        PadParams p;
        p.pad = static_cast<std::uint16_t>(pad);
        p.attackSec = 0.0f;
        p.interpolation = Interpolation::linear;
        return p;
    }
};
} // namespace

TEST_CASE("Sampler: a trigger plays the region from its start, sample-accurately at the block offset", "[sampler]")
{
    Rig r(2, 128);
    auto s = test::ramp(1000);
    r.engine.commands().push(Command::setPadParams(r.params(0)));
    r.engine.commands().push(Command::setPadSample(0, s.get()));
    r.engine.commands().push(Command::triggerPadAtSample(0, 1.0f, 37)); // absolute sample 37 = offset 37 in block 0
    auto out = r.capture(0, 10);                                        // 1280 samples
    for (int i = 0; i < 37; ++i)
        REQUIRE(out[static_cast<std::size_t>(i)] == 0.0f);
    // sample i of the ramp appears at 37 + i (linear interp at integer positions = exact)
    for (int i = 0; i < 1000; i += 97)
        REQUIRE(out[static_cast<std::size_t>(37 + i)] == Approx(static_cast<float>(i) / 999.0f).margin(1e-6));
    // after the region: the one-shot tail is zero (release 0 → 1-sample ramp) and stays zero
    REQUIRE(out[37 + 1000 + 5] == 0.0f);
    REQUIRE(r.engine.snapshot().activeVoices == 0);
    REQUIRE(r.engine.snapshot().lastTriggeredPad == 0);
}

TEST_CASE("Sampler: velocity and pad gain scale linearly; master gain applies after", "[sampler]")
{
    Rig r(2, 64);
    auto s = test::dc(2000, 0.5f);
    auto p = r.params(3);
    p.gain = 0.8f;
    r.engine.commands().push(Command::setPadParams(p));
    r.engine.commands().push(Command::setPadSample(3, s.get()));
    r.engine.commands().push(Command::setMasterGain(0.5f));
    r.run(); // settle the gain ramp
    r.engine.commands().push(Command::triggerPad(3, 0.5f));
    r.run(2);
    REQUIRE(r.data[0][10] == Approx(0.5f * 0.5f * 0.8f * 0.5f).epsilon(1e-5)); // sample × vel × padGain × master
    REQUIRE(r.data[1][10] == Approx(r.data[0][10])); // mono source → both channels of the pair
}

TEST_CASE("Sampler: pitch is varispeed (rate = 2^(semis/12)), fine cents, and source-rate ratio", "[sampler][dsp]")
{
    Rig r(2, 512);
    auto s = test::ramp(48000); // 1 s ramp at 48k
    SECTION("+12 st reads twice as fast")
    {
        auto p = r.params(0);
        p.pitchSemitones = 12.0f;
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(0, s.get()));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        auto out = r.capture(0, 4);
        REQUIRE(out[1000] == Approx(2000.0f / 47999.0f).margin(1e-5));
    }
    SECTION("-12 st reads half speed")
    {
        auto p = r.params(0);
        p.pitchSemitones = -12.0f;
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(0, s.get()));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        auto out = r.capture(0, 4);
        REQUIRE(out[1000] == Approx(500.0f / 47999.0f).margin(1e-5));
    }
    SECTION("a 96k sample plays at the right speed on a 48k engine")
    {
        auto s96 = test::ramp(96000, 96000.0);
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, s96.get()));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        auto out = r.capture(0, 4);
        REQUIRE(out[1000] == Approx(2000.0f / 95999.0f).margin(1e-5));
    }
    SECTION("+50 cents = 2^(0.5/12)")
    {
        auto p = r.params(0);
        p.fineCents = 50.0f;
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(0, s.get()));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        auto out = r.capture(0, 4);
        const double rate = std::pow(2.0, 0.5 / 12.0);
        REQUIRE(out[1000] == Approx(static_cast<float>(1000.0 * rate / 47999.0)).margin(2e-5));
    }
}

TEST_CASE("Sampler: attack ramps linearly over attackSec; release tail after the region end", "[sampler][env]")
{
    Rig r(2, 480);
    auto s = test::dc(480, 1.0f); // 10 ms of DC
    auto p = r.params(0);
    p.attackSec = 0.005f; // 240 samples
    p.releaseSec = 0.005f;
    r.engine.commands().push(Command::setPadParams(p));
    r.engine.commands().push(Command::setPadSample(0, s.get()));
    r.engine.commands().push(Command::triggerPad(0, 1.0f));
    auto out = r.capture(0, 2);                                 // 960 samples
    REQUIRE(out[120] == Approx(121.0f / 240.0f).epsilon(0.02)); // half way up the attack
    REQUIRE(out[300] == Approx(1.0f).epsilon(1e-4));            // sustain
    // region ends at 480: the tail reads zeros (past the buffer) but the envelope still ramps down over 240
    REQUIRE(out[479] == Approx(1.0f).epsilon(1e-4));
    REQUIRE(out[481] == 0.0f); // past the buffer → silence regardless of the tail
    // with a longer sample than the region, the tail fades the audio AFTER the region end
    Rig r2(2, 480);
    auto s2 = test::dc(2000, 1.0f);
    r2.engine.commands().push(Command::setPadParams(p));
    r2.engine.commands().push(Command::setPadSample(0, s2.get(), 0, 480));
    r2.engine.commands().push(Command::triggerPad(0, 1.0f));
    auto out2 = r2.capture(0, 2);
    REQUIRE(out2[480 + 120] == Approx(0.5f).epsilon(0.03)); // half way down the 240-sample release
    REQUIRE(out2[480 + 260] == 0.0f);
}

TEST_CASE("Sampler: retrigger replaces the voice with a 3 ms fade; choke groups; poly pads", "[sampler][choke]")
{
    Rig r(2, 480);
    auto s = test::dc(48000, 1.0f);
    SECTION("same pad: the old voice fades over 3 ms (144 samples) while the new one starts")
    {
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, s.get()));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run();
        r.engine.commands().push(Command::triggerPadAtSample(0, 1.0f, 480)); // start of block 1
        r.run();
        // old voice fading 1→0 over 144 samples + new voice at 1 → sum 1 + (1 - i/144)
        REQUIRE(r.data[0][0] == Approx(2.0f - 1.0f / 144.0f).epsilon(0.02));
        REQUIRE(r.data[0][72] == Approx(1.5f).epsilon(0.02));
        REQUIRE(r.data[0][200] == Approx(1.0f).epsilon(1e-4));
        REQUIRE(r.engine.snapshot().activeVoices == 1);
    }
    SECTION("a mute group chokes other pads in the group; ungrouped pads keep ringing")
    {
        auto p0 = r.params(0);
        p0.chokeGroup = 7;
        auto p1 = r.params(1);
        p1.chokeGroup = 7;
        auto p2 = r.params(2); // own-pad choke only
        for (auto* p : {&p0, &p1, &p2})
            r.engine.commands().push(Command::setPadParams(*p));
        for (int i = 0; i < 3; ++i)
            r.engine.commands().push(Command::setPadSample(static_cast<std::uint16_t>(i), s.get()));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.engine.commands().push(Command::triggerPad(2, 1.0f));
        r.run();
        REQUIRE(r.engine.snapshot().activeVoices == 2);
        r.engine.commands().push(Command::triggerPad(1, 1.0f));
        r.run(); // pad 0 fades (144 samples), pad 1 + pad 2 sustain
        REQUIRE(r.engine.snapshot().activeVoices == 2);
        REQUIRE(r.data[0][400] == Approx(2.0f).epsilon(1e-4)); // pad1 + pad2
        REQUIRE((r.engine.snapshot().padActiveMask & 0b111) == 0b110);
    }
    SECTION("poly (-2) pads never choke themselves")
    {
        auto p = r.params(0);
        p.chokeGroup = -2;
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(0, s.get()));
        for (int i = 0; i < 5; ++i)
            r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run(2);
        REQUIRE(r.engine.snapshot().activeVoices == 5);
        REQUIRE(r.data[0][100] == Approx(5.0f).epsilon(1e-4));
    }
}

TEST_CASE(
    "Sampler: gate pads release on note-off (min 5 ms), one-shots ignore note-off, loop wraps, reverse reads backwards",
    "[sampler][modes]")
{
    Rig r(2, 480);
    SECTION("gate")
    {
        auto s = test::dc(48000, 1.0f);
        auto p = r.params(0);
        p.mode = PadMode::gate;
        p.releaseSec = 0.0f; // → 5 ms floor = 240 samples
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(0, s.get()));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run();
        r.engine.commands().push(Command::releasePadAtSample(0, 480 + 100));
        r.run();
        REQUIRE(r.data[0][99] == Approx(1.0f).epsilon(1e-4));
        REQUIRE(r.data[0][100 + 120] == Approx(0.5f).epsilon(0.02));
        REQUIRE(r.data[0][100 + 250] == 0.0f);
        REQUIRE(r.engine.snapshot().activeVoices == 0);
    }
    SECTION("one-shot ignores note-off")
    {
        auto s = test::dc(48000, 1.0f);
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, s.get()));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run();
        r.engine.commands().push(Command::releasePad(0));
        r.run();
        REQUIRE(r.data[0][400] == Approx(1.0f));
    }
    SECTION("loop wraps the region; a retrigger while looping stops it (toggle)")
    {
        auto s = test::ramp(1000);
        auto p = r.params(0);
        p.mode = PadMode::loop;
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(0, s.get(), 0, 100)); // loop 100 frames
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        auto out = r.capture(0, 1);
        REQUIRE(out[0] == Approx(0.0f));
        REQUIRE(out[99] == Approx(99.0f / 999.0f).margin(1e-6));
        REQUIRE(out[100] == Approx(0.0f).margin(1e-6)); // wrapped
        REQUIRE(out[350] == Approx(50.0f / 999.0f).margin(1e-6));
        r.engine.commands().push(Command::triggerPad(0, 1.0f)); // toggle off
        r.run(2);
        REQUIRE(r.engine.snapshot().activeVoices == 0);
    }
    SECTION("reverse plays the region backwards from its end")
    {
        auto s = test::ramp(1000);
        auto p = r.params(0);
        p.reverse = 1;
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(0, s.get(), 0, 500));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        auto out = r.capture(0, 2);
        REQUIRE(out[0] == Approx(499.0f / 999.0f).margin(1e-6));
        REQUIRE(out[100] == Approx(399.0f / 999.0f).margin(1e-6));
        REQUIRE(out[499] == Approx(0.0f).margin(1e-6));
        REQUIRE(out[520] == 0.0f);
    }
}

TEST_CASE("Sampler: per-pad output pairs route to outs 3-8; missing pairs are silent, not crashes",
          "[sampler][routing]")
{
    Rig r(8, 256);
    auto s = test::dc(4000, 1.0f);
    for (int pair = 0; pair < 4; ++pair)
    {
        auto p = r.params(pair);
        p.outputPair = static_cast<std::uint8_t>(pair);
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(static_cast<std::uint16_t>(pair), s.get()));
        r.engine.commands().push(Command::triggerPad(static_cast<std::uint16_t>(pair), 1.0f));
    }
    auto p5 = r.params(5);
    p5.outputPair = 9; // outs 19/20 — not on this device
    r.engine.commands().push(Command::setPadParams(p5));
    r.engine.commands().push(Command::setPadSample(5, s.get()));
    r.engine.commands().push(Command::triggerPad(5, 1.0f));
    r.run(2);
    for (int ch = 0; ch < 8; ++ch)
        REQUIRE(r.data[static_cast<std::size_t>(ch)][100] == Approx(1.0f));
    REQUIRE(r.engine.snapshot().outputPeak[7] == Approx(1.0f));
    REQUIRE(r.engine.snapshot().activeVoices == 5);
}

TEST_CASE("Sampler: hermite interpolation reconstructs a sine better than linear at fractional rates", "[sampler][dsp]")
{
    auto s = test::sine(48000, 1000.0);
    auto err = [&](Interpolation interp)
    {
        Rig r(1, 480);
        auto p = r.params(0);
        p.pitchSemitones = 3.0f; // rate 1.1892…
        p.interpolation = interp;
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(0, s.get()));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        auto out = r.capture(0, 20);
        const double rate = std::pow(2.0, 3.0 / 12.0);
        double e = 0.0;
        for (int i = 10; i < 9000; ++i)
        {
            const double ideal =
                std::sin(2.0 * 3.14159265358979323846 * 1000.0 * (static_cast<double>(i) * rate) / 48000.0);
            e += std::abs(static_cast<double>(out[static_cast<std::size_t>(i)]) - ideal);
        }
        return e / 8990.0;
    };
    const double linErr = err(Interpolation::linear);
    const double hermErr = err(Interpolation::hermite);
    REQUIRE(hermErr < linErr * 0.2); // hermite at least 5× more accurate
    REQUIRE(hermErr < 1e-3);
}

TEST_CASE("Sampler: 128 simultaneous voices, voice stealing past 256, and zero allocations on the callback",
          "[sampler][rt][stress]")
{
    Rig r(2, 512);
    auto s = test::sine(48000, 220.0);
    for (int i = 0; i < kMaxPads; ++i)
    {
        auto p = r.params(i);
        p.chokeGroup = -2;
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(static_cast<std::uint16_t>(i), s.get()));
    }
    r.run();
    for (int i = 0; i < 128; ++i)
        r.engine.commands().push(Command::triggerPad(static_cast<std::uint16_t>(i % kMaxPads), 0.5f));
    REQUIRE(test::allocationsDuring([&] { r.run(4); }) == 0);
    REQUIRE(r.engine.snapshot().activeVoices == 128);
    REQUIRE(r.engine.snapshot().voiceStealing == 0);
    for (int i = 0; i < 200; ++i)
        r.engine.commands().push(Command::triggerPad(static_cast<std::uint16_t>(i % kMaxPads), 0.5f));
    REQUIRE(test::allocationsDuring([&] { r.run(4); }) == 0);
    REQUIRE(r.engine.snapshot().activeVoices == kMaxVoices);
    REQUIRE(r.engine.snapshot().voiceStealing == 72);
    r.engine.commands().push(Command::panic());
    REQUIRE(test::allocationsDuring([&] { r.run(2); }) == 0);
    REQUIRE(r.engine.snapshot().activeVoices == 0);
}

TEST_CASE("Sampler: replacing a pad's sample fades voices that read the old one; clearing works", "[sampler]")
{
    Rig r(2, 480);
    auto a = test::dc(48000, 1.0f);
    auto b = test::dc(48000, 0.25f);
    r.engine.commands().push(Command::setPadParams(r.params(0)));
    r.engine.commands().push(Command::setPadSample(0, a.get()));
    r.engine.commands().push(Command::triggerPad(0, 1.0f));
    r.run();
    r.engine.commands().push(Command::setPadSample(0, b.get()));
    r.run(); // the old voice fades over 144 samples
    REQUIRE(r.data[0][0] == Approx(1.0f - 1.0f / 144.0f).epsilon(0.02));
    REQUIRE(r.data[0][300] == 0.0f);
    r.engine.commands().push(Command::triggerPad(0, 1.0f));
    r.run();
    REQUIRE(r.data[0][10] == Approx(0.25f));
    r.engine.commands().push(Command::setPadSample(0, nullptr));
    r.engine.commands().push(Command::triggerPad(0, 1.0f)); // nothing to play
    r.run(2);
    REQUIRE(r.engine.snapshot().activeVoices == 0);
}

TEST_CASE("Sampler: a rendered crossfade-loop buffer plays warm-up then the steady period seamlessly",
          "[sampler][loop]")
{
    // Build a loop render off a non-integer-cycle region, hand it to a pad, and confirm the voice (a) plays it,
    // (b) after the warm-up stays inside [loopStart, loopEnd) forever, and (c) never has a seam discontinuity.
    Rig r(2, 256);
    const int N = 4096;
    auto src = std::make_shared<SampleBuffer>();
    src->allocate(1, N, 48000.0);
    for (int i = 0; i < N; ++i)
        src->channel(0)[i] = static_cast<float>(std::sin(2.0 * M_PI * 61.7 * i / 48000.0));
    // render a crossfade loop of the whole buffer
    auto lr = terminator::loop::renderCrossfadeLoop({src->channel(0)}, 0, N, 512, 512);
    auto loopBuf = std::make_shared<SampleBuffer>();
    loopBuf->allocate(1, static_cast<std::int64_t>(lr.frames[0].size()), 48000.0);
    std::copy(lr.frames[0].begin(), lr.frames[0].end(), loopBuf->channel(0));

    PadParams p = r.params(0);
    p.mode = PadMode::loop;
    p.interpolation = Interpolation::linear;
    r.engine.commands().push(Command::setPadParams(p));
    r.engine.commands().push(Command::setPadSample(0, src.get()));
    r.engine.commands().push(Command::setPadLoopBuffer(0, loopBuf.get(), lr.loopStart, lr.loopStart + lr.period));
    r.engine.commands().push(Command::triggerPad(0, 1.0f));

    // render a few seconds and gather the mono output
    std::vector<float> out;
    for (int b = 0; b < 400; ++b)
    {
        r.run();
        out.insert(out.end(), r.data[0].begin(), r.data[0].end());
    }
    CHECK(r.engine.snapshot().activeVoices == 1); // a loop never ends on its own
    // it must actually be producing sound
    double energy = 0;
    for (float v : out)
        energy += static_cast<double>(v) * static_cast<double>(v);
    CHECK(energy > 1.0);
    // no seam click: the biggest sample-to-sample step in the steady region is close to the audio's own
    double natural = 0, maxstep = 0;
    for (int i = 1; i < N; ++i)
        natural = std::max(
            natural, std::abs(static_cast<double>(src->channel(0)[i]) - static_cast<double>(src->channel(0)[i - 1])));
    for (std::size_t i = static_cast<std::size_t>(lr.loopStart) + 100; i + 1 < out.size(); ++i)
        maxstep = std::max(maxstep, std::abs(static_cast<double>(out[i]) - static_cast<double>(out[i - 1])));
    CHECK(maxstep <= natural * 2.0);
}

TEST_CASE("Sampler: setPadLoopBuffer + a looping voice do not allocate on the callback", "[sampler][loop][rt]")
{
    Rig r(2, 128);
    auto src = test::sine(2000, 100.0);
    auto lr = terminator::loop::renderCrossfadeLoop({src->channel(0)}, 0, 2000, 256, 256);
    auto loopBuf = std::make_shared<SampleBuffer>();
    loopBuf->allocate(1, static_cast<std::int64_t>(lr.frames[0].size()), 48000.0);
    std::copy(lr.frames[0].begin(), lr.frames[0].end(), loopBuf->channel(0));
    PadParams p = r.params(0);
    p.mode = PadMode::loop;
    r.engine.commands().push(Command::setPadParams(p));
    r.engine.commands().push(Command::setPadSample(0, src.get()));
    r.engine.commands().push(Command::setPadLoopBuffer(0, loopBuf.get(), lr.loopStart, lr.loopStart + lr.period));
    r.engine.commands().push(Command::triggerPad(0, 1.0f));
    r.run(4); // drain commands, start the voice
    const auto allocs = test::allocationsDuring([&] { r.run(200); });
    CHECK(allocs == 0);
}
