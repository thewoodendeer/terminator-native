// WRITING THE EXPORT OUT (Phase 4.5f) — the 16-bit quantiser and the file writers.
//
// The headline gate is PARITY WITH THE SHIPPING APP: the expected values below were produced by running the
// Electron app's own `quantizeTPDF16` (src/renderer/audio/flacEncoder.ts) on a known input. A native 16-bit export
// has to be bit-identical to the same export from the app people already have, or the rebuild is a regression.
// The second gate is the app's `test:export-flac` contract — a WAV and a FLAC of one render hold the SAME samples,
// which is only true because both are written from this one quantiser.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>

#include "terminator/render/AudioFileWriter.h"

using namespace terminator;
using namespace terminator::render;
using Catch::Approx;

namespace
{
/// The same input the fixture was generated from: sin(i·0.3)·0.5 in L, its negation in R.
juce::AudioBuffer<float> fixtureBuffer(int n)
{
    juce::AudioBuffer<float> b(2, n);
    for (int i = 0; i < n; ++i)
    {
        const auto v = static_cast<float>(std::sin(i * 0.3) * 0.5);
        b.setSample(0, i, v);
        b.setSample(1, i, -v);
    }
    return b;
}

juce::File tempOut(const juce::String& name)
{
    return juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile(name);
}

/// Read a file back as ints (the writer's own samples, not floats).
std::vector<std::vector<int>> readInts(const juce::File& f, int& numChannels, int& numSamples, double& rate)
{
    juce::AudioFormatManager m;
    m.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> r(m.createReaderFor(f));
    if (r == nullptr)
    {
        numChannels = numSamples = 0;
        return {};
    }
    numChannels = static_cast<int>(r->numChannels);
    numSamples = static_cast<int>(r->lengthInSamples);
    rate = r->sampleRate;
    std::vector<std::vector<int>> out(static_cast<std::size_t>(numChannels),
                                      std::vector<int>(static_cast<std::size_t>(numSamples), 0));
    std::vector<int*> ptrs(static_cast<std::size_t>(numChannels));
    for (int ch = 0; ch < numChannels; ++ch)
        ptrs[static_cast<std::size_t>(ch)] = out[static_cast<std::size_t>(ch)].data();
    r->read(ptrs.data(), numChannels, 0, numSamples, false);
    return out;
}
} // namespace

TEST_CASE("export files: the 16-bit quantiser matches the shipping app sample for sample", "[export][files]")
{
    // produced by the Electron app's quantizeTPDF16 on sin(i*0.3)*0.5 / its negation (see the header note)
    const std::vector<int> expectedL = {1,      4842,   9251,   12833, 15270, 16342,  15955,  14142,
                                        11067,  7002,   2313,   -2584, -7250, -11269, -14280, -16016,
                                        -16321, -15169, -12660, -9023, -4577, 276,    5104,   9476};
    const std::vector<int> expectedR = {0,      -4842, -9251, -12835, -15270, -16343, -15955, -14142,
                                        -11067, -7002, -2312, 2585,   7250,   11269,  14279,  16015,
                                        16320,  15168, 12660, 9022,   4578,   -275,   -5104,  -9477};
    const auto q = quantizeTpdf16(fixtureBuffer(static_cast<int>(expectedL.size())));
    REQUIRE(q.size() == 2);
    for (std::size_t i = 0; i < expectedL.size(); ++i)
    {
        INFO("sample " << i);
        REQUIRE(static_cast<int>(q[0][i]) == expectedL[i]);
        REQUIRE(static_cast<int>(q[1][i]) == expectedR[i]);
    }
}

TEST_CASE("export files: the dither is TRIANGULAR and signal-independent, not truncation", "[export][files]")
{
    // digital silence must not come out as silence-plus-nothing: TPDF puts a tiny dither noise there, which is the
    // whole point (the alternative is correlated distortion on fades and tails)
    juce::AudioBuffer<float> quiet(2, 4096);
    quiet.clear();
    const auto q = quantizeTpdf16(quiet);
    int nonZero = 0;
    double sum = 0.0;
    for (int i = 0; i < 4096; ++i)
    {
        nonZero += q[0][static_cast<std::size_t>(i)] != 0 ? 1 : 0;
        sum += q[0][static_cast<std::size_t>(i)];
        REQUIRE(std::abs(static_cast<int>(q[0][static_cast<std::size_t>(i)])) <= 1); // never more than 1 LSB
    }
    REQUIRE(nonZero > 0);                   // it is really dithering…
    REQUIRE(std::abs(sum / 4096.0) < 0.05); // …with no DC bias
    // and it is deterministic: the same input always gives the same file (fixed seeds — exports are reproducible)
    const auto again = quantizeTpdf16(quiet);
    for (int i = 0; i < 4096; ++i)
        REQUIRE(q[0][static_cast<std::size_t>(i)] == again[0][static_cast<std::size_t>(i)]);
}

TEST_CASE("export files: full scale and beyond clamp instead of wrapping", "[export][files]")
{
    juce::AudioBuffer<float> hot(1, 8);
    for (int i = 0; i < 8; ++i)
        hot.setSample(0, i, i % 2 == 0 ? 4.0f : -4.0f); // way past full scale
    const auto q = quantizeTpdf16(hot);
    for (int i = 0; i < 8; ++i)
    {
        const int v = q[0][static_cast<std::size_t>(i)];
        REQUIRE(v <= 32767);
        REQUIRE(v >= -32768);
        REQUIRE(std::abs(v) > 32000); // clamped to the rail, not wrapped to the opposite one
    }
}

TEST_CASE("export files: a WAV and a FLAC of one render hold the SAME samples", "[export][files]")
{
    const auto buf = fixtureBuffer(2048);
    const auto wav = tempOut("terminator-parity.wav");
    const auto flac = tempOut("terminator-parity.flac");
    juce::String err;
    REQUIRE(writeAudioFile(wav, buf, 48000.0, AudioFileFormat::wav, 16, err));
    INFO(err);
    REQUIRE(writeAudioFile(flac, buf, 48000.0, AudioFileFormat::flac, 16, err));
    INFO(err);

    int wc = 0, ws = 0, fc = 0, fs = 0;
    double wr = 0.0, fr = 0.0;
    const auto a = readInts(wav, wc, ws, wr);
    const auto b = readInts(flac, fc, fs, fr);
    REQUIRE(wc == 2);
    REQUIRE(fc == 2);
    REQUIRE(ws == 2048);
    REQUIRE(fs == 2048);
    REQUIRE(wr == Approx(48000.0));
    REQUIRE(fr == Approx(48000.0));
    for (int ch = 0; ch < 2; ++ch)
        for (int i = 0; i < 2048; ++i)
        {
            INFO("channel " << ch << " sample " << i);
            REQUIRE(a[static_cast<std::size_t>(ch)][static_cast<std::size_t>(i)] ==
                    b[static_cast<std::size_t>(ch)][static_cast<std::size_t>(i)]);
        }
    // …and those samples ARE the quantiser's
    const auto q = quantizeTpdf16(buf);
    for (int i = 0; i < 2048; ++i)
        REQUIRE((a[0][static_cast<std::size_t>(i)] >> 16) == static_cast<int>(q[0][static_cast<std::size_t>(i)]));
    wav.deleteFile();
    flac.deleteFile();
}

TEST_CASE("export files: 24-bit and float are NOT dithered", "[export][files]")
{
    // dither belongs only at a 16-bit reduction: 24 bits is below the noise floor of anything and float has no
    // quantisation step at all. Digital silence must stay digital silence in both.
    juce::AudioBuffer<float> quiet(2, 512);
    quiet.clear();
    for (const int depth : {24, 32})
    {
        const auto f = tempOut("terminator-quiet" + juce::String(depth) + ".wav");
        juce::String err;
        REQUIRE(writeAudioFile(f, quiet, 48000.0, AudioFileFormat::wav, depth, err));
        INFO(err);
        juce::AudioFormatManager m;
        m.registerBasicFormats();
        std::unique_ptr<juce::AudioFormatReader> r(m.createReaderFor(f));
        REQUIRE(r != nullptr);
        juce::AudioBuffer<float> back(2, 512);
        r->read(&back, 0, 512, 0, true, true);
        REQUIRE(back.getMagnitude(0, 512) == 0.0f);
        r.reset();
        f.deleteFile();
    }
}

TEST_CASE("export files: a 24-bit FLAC really is 24-bit, and carries no dither", "[export][files]")
{
    // the page's own FLAC encoder is 16-bit only, so a 24-bit FLAC is written HERE (the dialog renders a 24-bit WAV
    // and has the shell transcode it). It must come back at 24 bits, and digital silence must stay silent — dither
    // belongs at a 16-bit reduction and nowhere else.
    const auto f = tempOut("terminator-24.flac");
    juce::String err;
    REQUIRE(writeAudioFile(f, fixtureBuffer(1024), 48000.0, AudioFileFormat::flac, 24, err));
    INFO(err);
    juce::AudioFormatManager m;
    m.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> r(m.createReaderFor(f));
    REQUIRE(r != nullptr);
    REQUIRE(r->bitsPerSample == 24);
    REQUIRE(r->lengthInSamples == 1024);
    r.reset();
    f.deleteFile();

    juce::AudioBuffer<float> quiet(2, 512);
    quiet.clear();
    const auto q = tempOut("terminator-quiet24.flac");
    REQUIRE(writeAudioFile(q, quiet, 48000.0, AudioFileFormat::flac, 24, err));
    std::unique_ptr<juce::AudioFormatReader> qr(m.createReaderFor(q));
    REQUIRE(qr != nullptr);
    juce::AudioBuffer<float> back(2, 512);
    qr->read(&back, 0, 512, 0, true, true);
    REQUIRE(back.getMagnitude(0, 512) == 0.0f);
    qr.reset();
    q.deleteFile();
}

TEST_CASE("export files: the format names and extensions round-trip", "[export][files]")
{
    REQUIRE(audioFileFormatFromName("wav") == AudioFileFormat::wav);
    REQUIRE(audioFileFormatFromName("FLAC") == AudioFileFormat::flac);
    REQUIRE(audioFileFormatFromName("mp3") == AudioFileFormat::mp3);
    REQUIRE(audioFileFormatFromName("nonsense") == AudioFileFormat::wav); // never a surprise format
    REQUIRE(audioFileExtension(AudioFileFormat::wav) == ".wav");
    REQUIRE(audioFileExtension(AudioFileFormat::flac) == ".flac");
    REQUIRE(audioFileExtension(AudioFileFormat::mp3) == ".mp3");
}

TEST_CASE("export files: a requested MP3 bitrate picks a real CBR rate, not a VBR level", "[export][files]")
{
    // JUCE's option list is ten VBR levels FIRST (0 = best, 9 = smallest) and the CBR rates after, so an index
    // chosen by "bigger is better" asks lame for its WORST encode. 320 kbps has to mean 320 CBR.
    REQUIRE(mp3QualityIndexFor(320) == 23); // 10 VBR + the 14th CBR rate (index 13)
    REQUIRE(mp3QualityIndexFor(256) == 22);
    REQUIRE(mp3QualityIndexFor(192) == 20);
    REQUIRE(mp3QualityIndexFor(128) == 18);
    REQUIRE(mp3QualityIndexFor(130) == 18); // nearest, not floor
    REQUIRE(mp3QualityIndexFor(1) >= 10);   // never lands in the VBR block
    REQUIRE(mp3QualityIndexFor(9999) == 23);
}

TEST_CASE("export files: MP3 without a lame binary fails with a message, never a silent wrong file", "[export][files]")
{
    const auto buf = fixtureBuffer(256);
    const auto out = tempOut("terminator-nolame.mp3");
    juce::String err;
    const bool wrote =
        writeAudioFile(out, buf, 48000.0, AudioFileFormat::mp3, 16, err, 320, juce::File("/nonexistent/lame"));
    if (!wrote)
    {
        REQUIRE(err.isNotEmpty());
        REQUIRE(err.containsIgnoreCase("lame")); // it says WHAT is missing
    }
    else
    {
        // this machine has lame on the PATH: then it must have written a real file
        REQUIRE(out.getSize() > 0);
    }
    out.deleteFile();
}
