#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>

#include <juce_audio_formats/juce_audio_formats.h>

#include "terminator/render/OfflineRenderer.h"

using namespace terminator;
using Catch::Approx;

namespace
{
juce::File fixture(const char* name)
{
    return juce::File(TERMINATOR_FIXTURES_DIR).getChildFile(name);
}

double rmsOf(const juce::AudioBuffer<float>& b, int ch)
{
    double acc = 0.0;
    const auto* p = b.getReadPointer(ch);
    for (int i = 0; i < b.getNumSamples(); ++i)
        acc += static_cast<double>(p[i]) * static_cast<double>(p[i]);
    return std::sqrt(acc / static_cast<double>(b.getNumSamples()));
}
} // namespace

TEST_CASE("OfflineRenderer: parses the v0 project schema", "[render][json]")
{
    RenderSpec spec;
    juce::String err;
    REQUIRE(parseRenderSpecFromText(fixture("tone-440.json").loadFileAsString(), spec, err));
    REQUIRE(err.isEmpty());
    REQUIRE(spec.sampleRate == 48000.0);
    REQUIRE(spec.blockSize == 512);
    REQUIRE(spec.numChannels == 2);
    REQUIRE(spec.lengthSeconds == 2.0);
    REQUIRE(spec.masterGain == 0.5f);
    REQUIRE(spec.testToneEnabled);
    REQUIRE(spec.testToneFrequencyHz == 440.0f);
    REQUIRE(spec.testToneAmplitude == 0.5f);
    REQUIRE(spec.totalSamples() == 96000);

    SECTION("missing sections keep defaults")
    {
        RenderSpec d;
        REQUIRE(parseRenderSpecFromText("{\"terminatorProject\":0}", d, err));
        REQUIRE(d.sampleRate == 48000.0);
        REQUIRE_FALSE(d.testToneEnabled);
    }
    SECTION("rejects wrong version, non-object, bad JSON, out-of-range")
    {
        RenderSpec d;
        REQUIRE_FALSE(parseRenderSpecFromText(fixture("bad-version.json").loadFileAsString(), d, err));
        REQUIRE(err.contains("unsupported project version"));
        REQUIRE_FALSE(parseRenderSpecFromText("[1,2]", d, err));
        REQUIRE_FALSE(parseRenderSpecFromText("{not json", d, err));
        REQUIRE(err.contains("JSON parse error"));
        REQUIRE_FALSE(parseRenderSpecFromText("{\"terminatorProject\":0,\"render\":{\"sampleRate\":1}}", d, err));
        REQUIRE(err.contains("out of range"));
        REQUIRE_FALSE(parseRenderSpecFromText("{\"terminatorProject\":0,\"master\":{\"gain\":\"loud\"}}", d, err));
        REQUIRE(err.contains("must be a number"));
        REQUIRE_FALSE(parseRenderSpecFromText("{\"render\":{}}", d, err));
        REQUIRE(err.contains("missing 'terminatorProject'"));
    }
}

TEST_CASE("OfflineRenderer: renders the tone fixture - length, RMS, channels, block count", "[render][dsp]")
{
    RenderSpec spec;
    juce::String err;
    REQUIRE(parseRenderSpecFromText(fixture("tone-440.json").loadFileAsString(), spec, err));
    const auto r = renderOffline(spec);
    REQUIRE(r.sampleRate == 48000.0);
    REQUIRE(r.buffer.getNumChannels() == 2);
    REQUIRE(r.buffer.getNumSamples() == 96000);
    REQUIRE(r.blocksProcessed == 96000 / 512 + 1); // 187 full + 1 partial block of 256
    // amplitude 0.5 × master 0.5 = 0.25 peak → RMS 0.25/√2 (first block ramps 1.0→0.5: tiny error)
    REQUIRE(rmsOf(r.buffer, 0) == Approx(0.25 / std::sqrt(2.0)).epsilon(0.01));
    REQUIRE(rmsOf(r.buffer, 1) == Approx(rmsOf(r.buffer, 0)).epsilon(1e-6));
    REQUIRE(r.buffer.getMagnitude(0, 0, 96000) <= 0.5f); // never exceeds the pre-ramp level
}

TEST_CASE("OfflineRenderer: silence fixture renders zeros; zero length renders nothing", "[render]")
{
    RenderSpec spec;
    juce::String err;
    REQUIRE(parseRenderSpecFromText(fixture("silence.json").loadFileAsString(), spec, err));
    const auto r = renderOffline(spec);
    REQUIRE(r.buffer.getNumSamples() == 48000);
    REQUIRE(r.buffer.getMagnitude(0, 48000) == 0.0f);

    spec.lengthSeconds = 0.0;
    const auto z = renderOffline(spec);
    REQUIRE(z.buffer.getNumSamples() == 0);
    REQUIRE(z.blocksProcessed == 0);
}

TEST_CASE("OfflineRenderer: render is deterministic (same spec -> identical samples)", "[render]")
{
    RenderSpec spec;
    spec.testToneEnabled = true;
    spec.lengthSeconds = 0.25;
    const auto a = renderOffline(spec);
    const auto b = renderOffline(spec);
    REQUIRE(a.buffer.getNumSamples() == b.buffer.getNumSamples());
    for (int i = 0; i < a.buffer.getNumSamples(); ++i)
        REQUIRE(a.buffer.getSample(0, i) == b.buffer.getSample(0, i));
}

TEST_CASE("OfflineRenderer: writeWav round-trips through juce::WavAudioFormat", "[render][wav]")
{
    RenderSpec spec;
    spec.testToneEnabled = true;
    spec.lengthSeconds = 0.1;
    spec.sampleRate = 44100.0;
    const auto r = renderOffline(spec);

    juce::TemporaryFile tmp(".wav");
    juce::String err;
    SECTION("24-bit")
    {
        REQUIRE(writeWav(tmp.getFile(), r.buffer, r.sampleRate, 24, err));
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatReader> reader(
            wav.createReaderFor(tmp.getFile().createInputStream().release(), true));
        REQUIRE(reader != nullptr);
        REQUIRE(reader->sampleRate == 44100.0);
        REQUIRE(reader->numChannels == 2);
        REQUIRE(reader->bitsPerSample == 24);
        REQUIRE(reader->lengthInSamples == 4410);
        juce::AudioBuffer<float> back(2, 4410);
        REQUIRE(reader->read(&back, 0, 4410, 0, true, true));
        for (int i = 0; i < 4410; i += 7)
            REQUIRE(back.getSample(0, i) == Approx(r.buffer.getSample(0, i)).margin(2e-7));
    }
    SECTION("32-bit float is bit-exact")
    {
        REQUIRE(writeWav(tmp.getFile(), r.buffer, r.sampleRate, 32, err));
        juce::WavAudioFormat wav;
        std::unique_ptr<juce::AudioFormatReader> reader(
            wav.createReaderFor(tmp.getFile().createInputStream().release(), true));
        REQUIRE(reader != nullptr);
        REQUIRE(reader->usesFloatingPointData);
        juce::AudioBuffer<float> back(2, 4410);
        REQUIRE(reader->read(&back, 0, 4410, 0, true, true));
        for (int i = 0; i < 4410; ++i)
            REQUIRE(back.getSample(1, i) == r.buffer.getSample(1, i));
    }
    SECTION("rejects a bad bit depth")
    {
        REQUIRE_FALSE(writeWav(tmp.getFile(), r.buffer, r.sampleRate, 12, err));
        REQUIRE(err.contains("bitDepth"));
    }
}
