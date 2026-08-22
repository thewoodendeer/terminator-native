#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "TestSamples.h"
#include "terminator/io/SampleLoader.h"
#include "terminator/io/SampleStore.h"
#include "terminator/io/Settings.h"
#include "terminator/render/OfflineRenderer.h"

using namespace terminator;
using Catch::Approx;

namespace
{
juce::File fixture(const char* name)
{
    return juce::File(TERMINATOR_FIXTURES_DIR).getChildFile(name);
}
} // namespace

TEST_CASE("SampleLoader: reads the WAV fixture into a planar float buffer at its own rate", "[io][loader]")
{
    SampleLoader loader;
    juce::String err;
    auto s = loader.load(fixture("ramp-48k.wav"), err);
    REQUIRE(s != nullptr);
    REQUIRE(err.isEmpty());
    REQUIRE(s->numChannels == 2);
    REQUIRE(s->numFrames == 4800);
    REQUIRE(s->sampleRate == 48000.0);
    REQUIRE(s->channel(0)[0] == 0.0f);
    REQUIRE(s->channel(0)[999] == Approx(1.0f).margin(1e-4));
    REQUIRE(s->channel(1)[500] == Approx(-s->channel(0)[500]).margin(1e-4));
    REQUIRE(s->channel(0)[2000] == 0.0f);

    SECTION("mono downmix cap")
    {
        auto m = loader.load(fixture("ramp-48k.wav"), err, 1);
        REQUIRE(m != nullptr);
        REQUIRE(m->numChannels == 1);
    }
    SECTION("missing / unsupported files fail with a message")
    {
        REQUIRE(loader.load(fixture("nope.wav"), err) == nullptr);
        REQUIRE(err.contains("not found"));
        REQUIRE(loader.load(fixture("tone-440.json"), err) == nullptr);
        REQUIRE(err.contains("unsupported"));
    }
    SECTION("a WAV written by writeWav (24-bit, 44.1k, 2 ch) round-trips through the loader")
    {
        juce::TemporaryFile tmp(".wav");
        juce::AudioBuffer<float> b(2, 1000);
        for (int i = 0; i < 1000; ++i)
        {
            b.setSample(0, i, static_cast<float>(i) / 1000.0f);
            b.setSample(1, i, -static_cast<float>(i) / 1000.0f);
        }
        REQUIRE(writeWav(tmp.getFile(), b, 44100.0, 24, err));
        auto back = loader.load(tmp.getFile(), err);
        REQUIRE(back != nullptr);
        REQUIRE(back->sampleRate == 44100.0);
        REQUIRE(back->numFrames == 1000);
        REQUIRE(back->channel(1)[500] == Approx(-0.5f).margin(2e-7));
    }
    SECTION("FLAC round-trip via juce::FlacAudioFormat")
    {
        juce::TemporaryFile tmp(".flac");
        juce::AudioBuffer<float> b(1, 2000);
        for (int i = 0; i < 2000; ++i)
            b.setSample(0, i, std::sin(static_cast<float>(i) * 0.05f));
        juce::FlacAudioFormat flac;
        std::unique_ptr<juce::OutputStream> os(tmp.getFile().createOutputStream().release());
        auto writer = flac.createWriterFor(
            os, juce::AudioFormatWriterOptions{}.withSampleRate(48000.0).withNumChannels(1).withBitsPerSample(24));
        REQUIRE(writer != nullptr);
        REQUIRE(writer->writeFromAudioSampleBuffer(b, 0, 2000));
        writer.reset();
        auto back = loader.load(tmp.getFile(), err);
        REQUIRE(back != nullptr);
        REQUIRE(back->numFrames == 2000);
        REQUIRE(back->channel(0)[777] == Approx(std::sin(777.0f * 0.05f)).margin(2e-7));
    }
}

TEST_CASE("SampleStore: ids, retire quarantine, collect", "[io][store]")
{
    SampleStore store;
    auto a = test::dc(100, 1.0f);
    auto b = test::dc(200, 1.0f);
    const auto ia = store.add(a);
    const auto ib = store.add(b);
    REQUIRE(ia != 0);
    REQUIRE(ib != ia);
    REQUIRE(store.get(ia) == a.get());
    REQUIRE(store.get(ia)->id == ia);
    REQUIRE(store.liveCount() == 2);
    REQUIRE(store.bytesLive() == 300 * sizeof(float));

    store.retire(ia, 1000);
    REQUIRE(store.get(ia) == nullptr);
    REQUIRE(store.retiredCount() == 1);
    StateSnapshot s{};
    s.prepared = 1;
    s.blocksProcessed = 1000 + SampleStore::kQuarantineBlocks - 1;
    REQUIRE(store.collect(s) == 0); // not yet
    s.blocksProcessed = 1000 + SampleStore::kQuarantineBlocks;
    REQUIRE(store.collect(s) == 1);
    REQUIRE(store.retiredCount() == 0);
    // a stopped engine frees immediately
    store.retire(ib, 5000);
    s.prepared = 0;
    REQUIRE(store.collect(s) == 1);
    REQUIRE(store.liveCount() == 0);
}

TEST_CASE("Settings: dotted get/set, save/load round trip, missing file = defaults", "[io][settings]")
{
    juce::TemporaryFile tmp(".json");
    Settings st(tmp.getFile());
    REQUIRE_FALSE(st.load());
    REQUIRE(st.get("audio.sampleRate", 48000).equals(48000));
    st.set("audio.sampleRate", 96000);
    st.set("audio.outputChannels", juce::var(juce::Array<juce::var>{0, 1, 2, 3}));
    st.set("midi.inputs.abc", true);
    REQUIRE(st.save());
    Settings again(tmp.getFile());
    REQUIRE(again.load());
    REQUIRE(static_cast<int>(again.get("audio.sampleRate")) == 96000);
    REQUIRE(again.get("audio.outputChannels").getArray()->size() == 4);
    REQUIRE(static_cast<bool>(again.get("midi.inputs.abc")));
    REQUIRE(again.get("nothing.here", "dflt").toString() == "dflt");
}

TEST_CASE("OfflineRenderer: pads + events project renders samples at the right times and outputs", "[render][sampler]")
{
    RenderSpec spec;
    juce::String err;
    REQUIRE(parseRenderSpecFromFile(fixture("pads-demo.json"), spec, err));
    REQUIRE(spec.pads.size() == 2);
    REQUIRE(spec.events.size() == 2);
    REQUIRE(spec.pads[1].params.outputPair == 1);
    REQUIRE(spec.pads[1].params.pitchSemitones == 12.0f);
    REQUIRE(loadRenderSamples(spec, err));
    const auto r = renderOffline(spec);
    REQUIRE(r.buffer.getNumChannels() == 4);
    // pad 0 at 0.1 s = sample 4800 on outs 1/2: ramp value at i
    REQUIRE(r.buffer.getSample(0, 4799) == 0.0f);
    REQUIRE(r.buffer.getSample(0, 4800 + 500) == Approx(500.0f / 999.0f).margin(1e-4));
    REQUIRE(r.buffer.getSample(1, 4800 + 500) == Approx(-500.0f / 999.0f).margin(1e-4));
    REQUIRE(r.buffer.getSample(2, 4800 + 500) == 0.0f);
    // pad 1 at 0.5 s on outs 3/4, +12 st (twice as fast), velocity 0.5 → value(2·i)·0.5
    REQUIRE(r.buffer.getSample(2, 24000 + 250) == Approx(0.5f * 500.0f / 999.0f).margin(1e-4));
    REQUIRE(r.buffer.getSample(0, 24000 + 250) == 0.0f);
    REQUIRE(r.voiceSteals == 0);
}

TEST_CASE("OfflineRenderer: the render is invariant to block size (32..2048) - events land on the same samples",
          "[render][invariance]")
{
    RenderSpec base;
    juce::String err;
    REQUIRE(parseRenderSpecFromFile(fixture("pads-demo.json"), base, err));
    REQUIRE(loadRenderSamples(base, err));
    base.lengthSeconds = 0.75;
    base.blockSize = 512;
    const auto ref = renderOffline(base);
    for (int block : {32, 64, 100, 256, 1024, 2048})
    {
        auto spec = base;
        spec.blockSize = block;
        const auto r = renderOffline(spec);
        REQUIRE(r.buffer.getNumSamples() == ref.buffer.getNumSamples());
        for (int ch = 0; ch < 4; ++ch)
            for (int i = 0; i < ref.buffer.getNumSamples(); ++i)
                if (r.buffer.getSample(ch, i) != ref.buffer.getSample(ch, i))
                    FAIL("block " << block << " differs at ch " << ch << " sample " << i);
    }
}

TEST_CASE("OfflineRenderer: a 48k sample renders at the same speed at 44.1k and 96k engine rates", "[render][rates]")
{
    RenderSpec base;
    juce::String err;
    REQUIRE(parseRenderSpecFromFile(fixture("pads-demo.json"), base, err));
    REQUIRE(loadRenderSamples(base, err));
    base.events.resize(1); // only pad 0 at 0.1 s
    base.lengthSeconds = 0.5;
    for (double rate : {44100.0, 96000.0, 192000.0})
    {
        auto spec = base;
        spec.sampleRate = rate;
        const auto r = renderOffline(spec);
        // the 1000-frame ramp (at 48k) lasts 1000/48000 s regardless of the engine rate: value at 0.1 s + 10 ms ≈
        // 480/999
        const int at = static_cast<int>(0.11 * rate);
        REQUIRE(r.buffer.getSample(0, at) == Approx(480.0f / 999.0f).margin(2e-3));
        REQUIRE(r.buffer.getSample(0, static_cast<int>(0.13 * rate)) ==
                0.0f); // ramp over by 0.1 + 1000/48000 ≈ 0.1208 s
    }
}
