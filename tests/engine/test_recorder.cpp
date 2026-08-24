// RECORDING (Phase 5.1a) — the native capture path. The shipping app records through the PAGE (getUserMedia →
// MediaRecorder → decode), which in the shell means the audio goes through WebKit before it is a file. This is the
// engine's own recorder, and these are the properties that make it worth having:
//   · what went in is what lands in the file, sample for sample (32-bit float) — no resampling, no processing;
//   · the audio thread never allocates, never blocks and never touches the file;
//   · if the writer falls behind, the loss is COUNTED rather than spliced over silently;
//   · 24-bit is the default because that is what an interface actually gives.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>

#include "AllocationCounter.h"
#include "terminator/io/Recorder.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;

/// Read a WAV back as float channels.
std::vector<std::vector<float>> readWav(const juce::File& f, double& sampleRate, int& bits)
{
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> rd(fm.createReaderFor(f));
    if (rd == nullptr)
        return {};
    sampleRate = rd->sampleRate;
    bits = static_cast<int>(rd->bitsPerSample);
    juce::AudioBuffer<float> buf(static_cast<int>(rd->numChannels), static_cast<int>(rd->lengthInSamples));
    rd->read(&buf, 0, buf.getNumSamples(), 0, true, true);
    std::vector<std::vector<float>> out;
    for (int c = 0; c < buf.getNumChannels(); ++c)
        out.emplace_back(buf.getReadPointer(c), buf.getReadPointer(c) + buf.getNumSamples());
    return out;
}

juce::File tempWav(const char* name)
{
    return juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile(name);
}

/// Feed `frames` of a two-channel test signal through the recorder in `block`-sized chunks.
void feed(Recorder& rec, int frames, int block, int numIn = 2)
{
    std::vector<std::vector<float>> chans(static_cast<std::size_t>(numIn),
                                          std::vector<float>(static_cast<std::size_t>(block), 0.0f));
    std::vector<const float*> ptrs;
    for (auto& c : chans)
        ptrs.push_back(c.data());
    int done = 0;
    while (done < frames)
    {
        const int n = std::min(block, frames - done);
        for (int i = 0; i < n; ++i)
            for (int c = 0; c < numIn; ++c)
                chans[static_cast<std::size_t>(c)][static_cast<std::size_t>(i)] =
                    static_cast<float>((0.5 - 0.1 * c) * std::sin(6.283185307179586 * (200.0 + 100.0 * c) *
                                                                  static_cast<double>(done + i) / kSr));
        rec.push(ptrs.data(), numIn, n);
        done += n;
    }
}
} // namespace

TEST_CASE("recorder: what goes in is what lands in the file", "[io][recorder]")
{
    const auto f = tempWav("terminator-rec-float.wav");
    Recorder rec;
    RecorderConfig cfg;
    cfg.file = f;
    cfg.sampleRate = kSr;
    cfg.numChannels = 2;
    cfg.bitDepth = 32; // float: the only depth where "identical" is a fair thing to ask for
    juce::String err;
    REQUIRE(rec.start(cfg, err));
    const int frames = 24000;
    feed(rec, frames, 128);
    const auto written = rec.stop();
    CHECK(written == static_cast<std::uint64_t>(frames));
    CHECK(rec.framesDropped() == 0);

    double sr = 0.0;
    int bits = 0;
    const auto back = readWav(f, sr, bits);
    REQUIRE(back.size() == 2);
    CHECK(sr == Approx(kSr));
    CHECK(static_cast<int>(back[0].size()) == frames);
    for (int i = 0; i < frames; ++i)
        for (int c = 0; c < 2; ++c)
        {
            const float want = static_cast<float>(
                (0.5 - 0.1 * c) * std::sin(6.283185307179586 * (200.0 + 100.0 * c) * static_cast<double>(i) / kSr));
            REQUIRE(back[static_cast<std::size_t>(c)][static_cast<std::size_t>(i)] == Approx(want).margin(1e-6));
        }
    f.deleteFile();
}

TEST_CASE("recorder: 24-bit is the default, and it is really 24-bit", "[io][recorder]")
{
    const auto f = tempWav("terminator-rec-24.wav");
    Recorder rec;
    RecorderConfig cfg;
    cfg.file = f;
    cfg.sampleRate = kSr;
    juce::String err;
    REQUIRE(rec.start(cfg, err)); // no bitDepth given
    feed(rec, 4800, 256);
    rec.stop();
    double sr = 0.0;
    int bits = 0;
    const auto back = readWav(f, sr, bits);
    CHECK(bits == 24);
    REQUIRE(back.size() == 2);
    // 24-bit is ~1/8388608 per step: the same signal, within a step and a half.
    for (int i = 0; i < 4800; ++i)
    {
        const float want = static_cast<float>(0.5 * std::sin(6.283185307179586 * 200.0 * static_cast<double>(i) / kSr));
        REQUIRE(back[0][static_cast<std::size_t>(i)] == Approx(want).margin(2e-7));
    }
    f.deleteFile();
}

TEST_CASE("recorder: the audio thread never allocates", "[io][recorder]")
{
    const auto f = tempWav("terminator-rec-alloc.wav");
    Recorder rec;
    RecorderConfig cfg;
    cfg.file = f;
    cfg.sampleRate = kSr;
    cfg.bitDepth = 32;
    juce::String err;
    REQUIRE(rec.start(cfg, err));
    std::vector<float> a(128, 0.25f), b(128, -0.25f);
    const float* ptrs[2] = {a.data(), b.data()};
    // push() is the ONLY thing the audio callback calls, so it is the only thing that has to be clean
    const auto allocs = terminator::test::allocationsDuring(
        [&]
        {
            for (int i = 0; i < 200; ++i)
                rec.push(ptrs, 2, 128);
        });
    CHECK(allocs == 0);
    rec.stop();
    f.deleteFile();
}

TEST_CASE("recorder: an overrun is counted, not spliced over", "[io][recorder]")
{
    // A one-second ring, filled far faster than any writer could drain it. The point is not that nothing is lost —
    // it is that what is lost is REPORTED, so a take with a hole can be thrown away instead of mixed.
    const auto f = tempWav("terminator-rec-overrun.wav");
    Recorder rec;
    RecorderConfig cfg;
    cfg.file = f;
    cfg.sampleRate = kSr;
    cfg.bitDepth = 32;
    cfg.ringSeconds = 1;
    juce::String err;
    REQUIRE(rec.start(cfg, err));
    std::vector<float> a(4096, 0.5f);
    const float* ptrs[2] = {a.data(), a.data()};
    for (int i = 0; i < 200; ++i) // 800k frames into a 48k ring, with no time for the writer
        rec.push(ptrs, 2, 4096);
    const auto captured = rec.framesCaptured();
    const auto dropped = rec.framesDropped();
    rec.stop();
    CHECK(dropped > 0);
    CHECK(captured + dropped == 200ull * 4096ull); // every frame is accounted for, one way or the other
    f.deleteFile();
}

TEST_CASE("recorder: it takes the input channels it is told to", "[io][recorder]")
{
    // Four inputs on the interface, and the take is channels 3 and 1 — in that order. Recording "the first two"
    // is not good enough for anyone with more than a stereo input.
    const auto f = tempWav("terminator-rec-chans.wav");
    Recorder rec;
    RecorderConfig cfg;
    cfg.file = f;
    cfg.sampleRate = kSr;
    cfg.numChannels = 2;
    cfg.bitDepth = 32;
    cfg.inputChannels = {3, 1};
    juce::String err;
    REQUIRE(rec.start(cfg, err));
    const int n = 512;
    std::vector<std::vector<float>> ins(4, std::vector<float>(static_cast<std::size_t>(n), 0.0f));
    for (int c = 0; c < 4; ++c)
        std::fill(ins[static_cast<std::size_t>(c)].begin(), ins[static_cast<std::size_t>(c)].end(),
                  0.1f * static_cast<float>(c + 1)); // 0.1 / 0.2 / 0.3 / 0.4
    const float* ptrs[4] = {ins[0].data(), ins[1].data(), ins[2].data(), ins[3].data()};
    rec.push(ptrs, 4, n);
    CHECK(rec.peak(0) == Approx(0.4f).margin(1e-6f)); // input 3
    CHECK(rec.peak(1) == Approx(0.2f).margin(1e-6f)); // input 1
    rec.stop();
    double sr = 0.0;
    int bits = 0;
    const auto back = readWav(f, sr, bits);
    REQUIRE(back.size() == 2);
    CHECK(back[0][10] == Approx(0.4f).margin(1e-6f));
    CHECK(back[1][10] == Approx(0.2f).margin(1e-6f));
    f.deleteFile();
}

TEST_CASE("recorder: a bad path fails cleanly", "[io][recorder]")
{
    Recorder rec;
    RecorderConfig cfg;
    cfg.file = juce::File("/this/directory/does/not/exist/and/cannot/be/made/x.wav");
    juce::String err;
    CHECK_FALSE(rec.start(cfg, err));
    CHECK(err.isNotEmpty());
    CHECK_FALSE(rec.recording());
    // …and a failed start leaves nothing behind that a later stop could trip over
    CHECK(rec.stop() == 0);
}
