// STEMS IN THE RT VOICE — the engine half of scripts/stem-mask.test.mts + stems-lazy.test.mts: a pad carries up
// to four stem planes + a 4-bit mask; a voice with a partial mask SUMS its lit planes while reading (the combo =
// the exact per-sample sum, mono planes fill both channels), mask 0 / 15 / a missing lit plane play the ORIGINAL
// (never silence), reverse/varispeed are identical to the base path, and a mask change on a ringing pad is a LIVE
// re-stem: a 12 ms linear crossfade with no discontinuity. Allocation-free (RT gate).
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "AllocationCounter.h"
#include "TestSamples.h"
#include "terminator/core/Engine.h"

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

std::shared_ptr<SampleBuffer> stereoDc(std::int64_t frames, float l, float r)
{
    auto s = std::make_shared<SampleBuffer>();
    s->allocate(2, frames, 48000.0);
    for (std::int64_t i = 0; i < frames; ++i)
    {
        s->channel(0)[i] = l;
        s->channel(1)[i] = r;
    }
    return s;
}

std::shared_ptr<SampleBuffer> sum(const SampleBuffer& a, const SampleBuffer& b)
{
    auto s = std::make_shared<SampleBuffer>();
    s->allocate(a.numChannels, a.numFrames, a.sampleRate);
    for (int ch = 0; ch < a.numChannels; ++ch)
        for (std::int64_t i = 0; i < a.numFrames; ++i)
            s->channel(ch)[i] = a.channel(ch)[i] + b.channel(std::min(ch, b.numChannels - 1))[i];
    return s;
}
} // namespace

TEST_CASE("Stems: a partial mask sums its lit planes while reading; 15 / 0 / a missing plane play the base",
          "[sampler][stems]")
{
    const std::int64_t N = 4000;
    auto base = test::dc(N, 0.9f);
    auto d = test::dc(N, 0.1f), b = test::dc(N, 0.2f), o = test::dc(N, 0.3f), v = test::dc(N, 0.4f);
    const SampleBuffer* planes[4] = {d.get(), b.get(), o.get(), v.get()};

    auto renderWith = [&](std::uint8_t mask, const SampleBuffer* const set[4])
    {
        Rig r(2, 256);
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, base.get()));
        r.engine.commands().push(Command::setPadStems(0, set, mask));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        auto out = r.capture(0, 2);
        return out[100];
    };
    CHECK(renderWith(0b0001, planes) == Approx(0.1f).margin(1e-7));               // drums only = plane 0
    CHECK(renderWith(0b0011, planes) == Approx(0.1f + 0.2f).margin(1e-7));        // drums+bass = exact sum
    CHECK(renderWith(0b1111, planes) == Approx(0.9f).margin(1e-7));               // ALL = the ORIGINAL
    CHECK(renderWith(0b0000, planes) == Approx(0.9f).margin(1e-7));               // 0 = unrepresentable → original
    CHECK(renderWith(0b1110, planes) == Approx(0.2f + 0.3f + 0.4f).margin(1e-7)); // three planes
    const SampleBuffer* missingOther[4] = {d.get(), b.get(), nullptr, v.get()};
    CHECK(renderWith(0b0100, missingOther) == Approx(0.9f).margin(1e-7)); // a lit plane not decoded → original
    CHECK(renderWith(0b0001, missingOther) == Approx(0.1f).margin(1e-7)); // an unlit missing plane is irrelevant
    CHECK(renderWith(0b0001, nullptr) == Approx(0.9f).margin(1e-7));      // no planes at all → original

    SECTION("a mono plane among stereo ones fills both channels; the stereo plane keeps its sides")
    {
        auto st = stereoDc(N, 0.1f, -0.1f);
        const SampleBuffer* mix[4] = {st.get(), b.get(), nullptr, nullptr};
        Rig r(2, 256);
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, base.get()));
        r.engine.commands().push(Command::setPadStems(0, mix, 0b0011));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run();
        CHECK(r.data[0][100] == Approx(0.1f + 0.2f).margin(1e-7));
        CHECK(r.data[1][100] == Approx(-0.1f + 0.2f).margin(1e-7));
    }
    SECTION("a plane of the wrong length is dropped; a new sample clears the planes (the mask stays)")
    {
        auto shortPlane = test::dc(N / 2, 0.1f);
        const SampleBuffer* bad[4] = {shortPlane.get(), b.get(), nullptr, nullptr};
        CHECK(renderWith(0b0001, bad) == Approx(0.9f).margin(1e-7)); // plane 0 dropped → lit plane missing → base
        Rig r(2, 256);
        auto base2 = test::dc(N, 0.7f);
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, base.get()));
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0001));
        r.engine.commands().push(Command::setPadSample(0, base2.get())); // the planes belonged to `base`
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run();
        CHECK(r.data[0][100] == Approx(0.7f).margin(1e-7));
        CHECK(r.engine.pad(0).stemMask == 0b0001);
        CHECK(r.engine.pad(0).stemPlanes[0] == nullptr);
    }
}

TEST_CASE("Stems: reverse + varispeed + hermite on planes == the same voice on the premixed buffer",
          "[sampler][stems][dsp]")
{
    const std::int64_t N = 24000;
    auto a = test::sine(N, 220.0), b = test::sine(N, 333.0);
    auto premix = sum(*a, *b);
    auto base = test::dc(N, 0.0f); // the original is irrelevant here (mask 3 reads the planes)
    const SampleBuffer* planes[4] = {a.get(), b.get(), nullptr, nullptr};
    auto render = [&](bool usePlanes)
    {
        Rig r(2, 512);
        auto p = r.params(0);
        p.interpolation = Interpolation::hermite;
        p.pitchSemitones = 7.0f;
        p.fineCents = -20.0f;
        p.reverse = 1;
        r.engine.commands().push(Command::setPadParams(p));
        if (usePlanes)
        {
            r.engine.commands().push(Command::setPadSample(0, base.get(), 1000, 20000));
            r.engine.commands().push(Command::setPadStems(0, planes, 0b0011));
        }
        else
            r.engine.commands().push(Command::setPadSample(0, premix.get(), 1000, 20000));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        return r.capture(0, 30);
    };
    const auto viaPlanes = render(true);
    const auto viaPremix = render(false);
    REQUIRE(viaPlanes.size() == viaPremix.size());
    double maxDiff = 0.0, energy = 0.0;
    for (std::size_t i = 0; i < viaPlanes.size(); ++i)
    {
        maxDiff = std::max(maxDiff, std::abs(static_cast<double>(viaPlanes[i]) - static_cast<double>(viaPremix[i])));
        energy += static_cast<double>(viaPremix[i]) * static_cast<double>(viaPremix[i]);
    }
    CHECK(energy > 1.0);   // the render is not silence
    CHECK(maxDiff < 1e-5); // interpolation is linear in the samples: sum-then-read == read-then-sum (float rounding)
}

TEST_CASE("Stems: a mask change on a ringing pad re-stems live with a 12 ms linear crossfade, no discontinuity",
          "[sampler][stems][restem]")
{
    const std::int64_t N = 48000;
    auto base = test::dc(N, 1.0f);
    auto d = test::dc(N, 0.25f), b = test::dc(N, 0.5f), same = test::dc(N, 0.25f);
    const int XF = 576; // 12 ms at 48 k
    SECTION("0.25 -> 0.75: the sum walks linearly over 576 samples; one voice remains")
    {
        const SampleBuffer* planes[4] = {d.get(), b.get(), nullptr, nullptr};
        Rig r(2, 480);
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, base.get()));
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0001));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run(2);
        REQUIRE(r.data[0][100] == Approx(0.25f).margin(1e-6));
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0011)); // + bass, live
        auto out = r.capture(0, 4);                                        // 1920 samples from the restem block on
        REQUIRE(r.engine.snapshot().activeVoices == 1);                    // the old voice faded out and freed itself
        // sample i: old 0.25·(1 − (i+1)/XF) + new 0.75·(i+1)/XF = 0.25 + 0.5·(i+1)/XF
        for (int i : {0, 1, 143, 287, 431, 574})
            CHECK(out[static_cast<std::size_t>(i)] ==
                  Approx(0.25 + 0.5 * static_cast<double>(i + 1) / XF).margin(2e-6));
        for (int i : {XF - 1, XF, XF + 1, XF + 100, 1900})
            CHECK(out[static_cast<std::size_t>(i)] == Approx(0.75f).margin(2e-6));
        double maxStep = 0.0;
        for (std::size_t i = 1; i < out.size(); ++i)
            maxStep = std::max(maxStep, std::abs(static_cast<double>(out[i]) - static_cast<double>(out[i - 1])));
        CHECK(maxStep <= 0.5 / XF + 2e-6); // never more than the crossfade's own per-sample step
        // the playhead read-back follows the twin (continuous position, not a restart)
        CHECK(r.engine.snapshot().lastTriggeredPadPositionSec == Approx((6.0 * 480.0) / 48000.0).margin(1e-3));
    }
    SECTION("same audio on both sides = a perfectly flat crossfade (the gate's purest form)")
    {
        const SampleBuffer* planes[4] = {d.get(), same.get(), nullptr, nullptr};
        Rig r(2, 480);
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, base.get()));
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0001));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run(1);
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0010)); // plane 1 == plane 0 content
        auto out = r.capture(0, 3);
        for (std::size_t i = 0; i < out.size(); i += 7)
            REQUIRE(out[i] == Approx(0.25f).margin(1e-6));
        CHECK(r.engine.snapshot().activeVoices == 1);
    }
    SECTION("an identical read set does not spawn a twin; a fading voice is left alone")
    {
        const SampleBuffer* planes[4] = {d.get(), b.get(), nullptr, nullptr};
        Rig r(2, 480);
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, base.get()));
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0011));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run(1);
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0011)); // same set
        r.run(1);
        CHECK(r.engine.snapshot().activeVoices == 1);
        CHECK(r.data[0][100] == Approx(0.75f).margin(1e-6));
        r.engine.commands().push(Command::stopPad(0));
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0001)); // arrives on a fading voice
        r.run(1);
        CHECK(r.engine.snapshot().activeVoices <= 1); // no twin on a dying voice
        r.run(2);
        CHECK(r.engine.snapshot().activeVoices == 0);
    }
    SECTION("a voice scheduled later in the block but not yet started re-points in place (no crossfade)")
    {
        const SampleBuffer* planes[4] = {d.get(), b.get(), nullptr, nullptr};
        Rig r(2, 480);
        r.engine.commands().push(Command::setPadParams(r.params(0)));
        r.engine.commands().push(Command::setPadSample(0, base.get()));
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0001));
        r.engine.commands().push(Command::triggerPadAtSample(0, 1.0f, 200));
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0011)); // same drain, before it renders
        r.run(1);
        CHECK(r.engine.snapshot().activeVoices == 1);
        CHECK(r.data[0][199] == 0.0f);
        CHECK(r.data[0][200] == Approx(0.75f).margin(1e-6)); // the new set from its very first sample
    }
    SECTION("a rendered LOOP voice keeps its render (the message thread re-renders + re-sends loops)")
    {
        auto loopBuf = test::dc(2000, 0.6f);
        const SampleBuffer* planes[4] = {d.get(), b.get(), nullptr, nullptr};
        Rig r(2, 480);
        auto p = r.params(0);
        p.mode = PadMode::loop;
        r.engine.commands().push(Command::setPadParams(p));
        r.engine.commands().push(Command::setPadSample(0, base.get()));
        r.engine.commands().push(Command::setPadLoopBuffer(0, loopBuf.get(), 0, 2000));
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0001));
        r.engine.commands().push(Command::triggerPad(0, 1.0f));
        r.run(1);
        r.engine.commands().push(Command::setPadStems(0, planes, 0b0011));
        r.run(1);
        CHECK(r.engine.snapshot().activeVoices == 1);
        CHECK(r.data[0][100] == Approx(0.6f).margin(1e-6));
    }
}

TEST_CASE("RT: stems read + live restem allocate nothing on the callback", "[rt][stems]")
{
    const std::int64_t N = 48000;
    auto base = test::dc(N, 1.0f);
    auto d = test::dc(N, 0.25f), b = test::dc(N, 0.5f), o = test::dc(N, 0.1f), v = test::dc(N, 0.1f);
    const SampleBuffer* planes[4] = {d.get(), b.get(), o.get(), v.get()};
    Rig r(2, 512);
    auto p = r.params(0);
    p.interpolation = Interpolation::hermite;
    r.engine.commands().push(Command::setPadParams(p));
    r.engine.commands().push(Command::setPadSample(0, base.get()));
    r.engine.commands().push(Command::setPadStems(0, planes, 0b0101));
    for (int i = 0; i < 8; ++i)
        r.engine.commands().push(Command::triggerPad(static_cast<std::uint16_t>(0), 1.0f));
    REQUIRE(test::allocationsDuring([&] { r.run(4); }) == 0);
    std::uint8_t mask = 1;
    REQUIRE(test::allocationsDuring(
                [&]
                {
                    for (int i = 0; i < 40; ++i)
                    {
                        mask = static_cast<std::uint8_t>((mask % 15) + 1);
                        r.engine.commands().push(Command::setPadStems(0, planes, mask));
                        r.run(1);
                    }
                }) == 0);
    CHECK(r.engine.snapshot().activeVoices >= 1);
}
