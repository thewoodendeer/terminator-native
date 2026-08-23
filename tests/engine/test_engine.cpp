#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "terminator/core/Engine.h"

using namespace terminator;
using Catch::Approx;

namespace
{
struct Buffers
{
    explicit Buffers(int channels, int samples)
        : data(static_cast<std::size_t>(channels), std::vector<float>(static_cast<std::size_t>(samples), 99.0f))
    {
        for (auto& ch : data)
            ptrs.push_back(ch.data());
    }
    std::vector<std::vector<float>> data;
    std::vector<float*> ptrs;
    int channels() const { return static_cast<int>(data.size()); }
    int samples() const { return static_cast<int>(data[0].size()); }
};

double rms(const std::vector<float>& v)
{
    double acc = 0.0;
    for (float x : v)
        acc += static_cast<double>(x) * static_cast<double>(x);
    return std::sqrt(acc / static_cast<double>(v.size()));
}

int positiveZeroCrossings(const std::vector<float>& v)
{
    int n = 0;
    for (std::size_t i = 1; i < v.size(); ++i)
        if (v[i - 1] < 0.0f && v[i] >= 0.0f)
            ++n;
    return n;
}

void run(Engine& e, Buffers& b, int blocks)
{
    for (int i = 0; i < blocks; ++i)
        e.process(b.ptrs.data(), b.channels(), b.samples());
}
} // namespace

TEST_CASE("Engine: process before prepare renders silence and does not crash", "[engine]")
{
    Engine e;
    Buffers b(2, 256);
    e.process(b.ptrs.data(), 2, 256);
    for (auto& ch : b.data)
        for (float x : ch)
            REQUIRE(x == 0.0f);
    REQUIRE_FALSE(e.isPrepared());
    REQUIRE(e.snapshot().prepared == 0);
}

TEST_CASE("Engine: prepared with the tone off renders silence and counts blocks", "[engine]")
{
    Engine e;
    e.prepare({48000.0, 512, 2});
    REQUIRE(e.isPrepared());
    Buffers b(2, 512);
    run(e, b, 10);
    for (auto& ch : b.data)
        for (float x : ch)
            REQUIRE(x == 0.0f);
    const auto& s = e.snapshot();
    REQUIRE(s.prepared == 1);
    REQUIRE(s.blocksProcessed == 10);
    REQUIRE(s.samplesProcessed == 5120);
    REQUIRE(s.playing == 0);
    REQUIRE(s.playheadSamples == 0); // transport not started
    REQUIRE(s.sampleRate == 48000.0);
    REQUIRE(s.numOutputChannels == 2);
}

TEST_CASE("Engine: test tone has the requested frequency and amplitude, master gain scales it", "[engine][dsp]")
{
    Engine e;
    e.prepare({48000.0, 480, 2});
    REQUIRE(e.commands().push(Command::setTestTone(true, 1000.0f, 0.5f)));
    REQUIRE(e.commands().push(Command::setMasterGain(1.0f)));
    Buffers b(2, 480);
    run(e, b, 1); // drains commands, gain ramp settles within this block (1.0 → 1.0)

    // accumulate exactly one second
    std::vector<float> second;
    second.reserve(48000);
    for (int blk = 0; blk < 100; ++blk)
    {
        run(e, b, 1);
        second.insert(second.end(), b.data[0].begin(), b.data[0].end());
    }
    REQUIRE(second.size() == 48000);
    REQUIRE(rms(second) == Approx(0.5 / std::sqrt(2.0)).epsilon(0.01));
    REQUIRE(positiveZeroCrossings(second) == Approx(1000).margin(1));
    // both channels identical
    for (std::size_t i = 0; i < b.data[0].size(); ++i)
        REQUIRE(b.data[0][i] == b.data[1][i]);
    float peak = 0.0f;
    for (float x : second)
        peak = std::max(peak, std::abs(x));
    REQUIRE(peak == Approx(0.5).epsilon(0.01));

    // master gain 0.25 → amplitude 0.125 after the one-block ramp
    REQUIRE(e.commands().push(Command::setMasterGain(0.25f)));
    run(e, b, 2);
    run(e, b, 1);
    peak = 0.0f;
    for (float x : b.data[0])
        peak = std::max(peak, std::abs(x));
    REQUIRE(peak == Approx(0.125).epsilon(0.02));
    REQUIRE(e.snapshot().masterGain == Approx(0.25f));
    REQUIRE(e.snapshot().peak[0] == Approx(0.125f).epsilon(0.02));
    REQUIRE(e.snapshot().testToneEnabled == 1);
    REQUIRE(e.snapshot().testToneFrequencyHz == 1000.0f);
}

TEST_CASE("Engine: transport play/stop drives the playhead; panic silences", "[engine][transport]")
{
    Engine e;
    e.prepare({44100.0, 128, 2});
    Buffers b(2, 128);
    e.commands().push(Command::transportPlay());
    run(e, b, 5);
    REQUIRE(e.snapshot().playing == 1);
    REQUIRE(e.snapshot().playheadSamples == 5 * 128);
    e.commands().push(Command::transportStop());
    run(e, b, 3);
    REQUIRE(e.snapshot().playing == 0);
    REQUIRE(e.snapshot().playheadSamples == 5 * 128);
    e.commands().push(Command::setTestTone(true, 440.0f, 1.0f));
    e.commands().push(Command::transportPlay());
    run(e, b, 2);
    REQUIRE(e.snapshot().peak[0] > 0.0f);
    e.commands().push(Command::panic());
    run(e, b, 1);
    REQUIRE(e.snapshot().playing == 0);
    REQUIRE(e.snapshot().testToneEnabled == 0);
    REQUIRE(e.snapshot().peak[0] == 0.0f);
    REQUIRE(e.snapshot().commandsApplied == 5);
}

TEST_CASE("Engine: commands are applied in order at the start of the next block; release publishes unprepared",
          "[engine]")
{
    Engine e;
    e.prepare({48000.0, 64, 1});
    Buffers b(1, 64);
    e.commands().push(Command::setMasterGain(0.1f));
    e.commands().push(Command::setMasterGain(0.9f)); // last one wins
    run(e, b, 1);
    REQUIRE(e.snapshot().masterGain == Approx(0.9f));
    REQUIRE(e.snapshot().commandsApplied == 2);
    e.release();
    REQUIRE_FALSE(e.isPrepared());
    REQUIRE(e.snapshot().prepared == 0);
    run(e, b, 1); // silence, no crash
    for (float x : b.data[0])
        REQUIRE(x == 0.0f);
}

TEST_CASE("Engine: extra output channels beyond 2 are silenced, odd block sizes work", "[engine]")
{
    Engine e;
    e.prepare({48000.0, 1024, 8});
    e.commands().push(Command::setTestTone(true, 440.0f, 0.5f));
    Buffers b(8, 333);
    run(e, b, 3);
    REQUIRE(std::abs(b.data[0][100]) > 0.0f);
    for (int ch = 2; ch < 8; ++ch)
        for (float x : b.data[static_cast<std::size_t>(ch)])
            REQUIRE(x == 0.0f);
    REQUIRE(e.snapshot().samplesProcessed == 999);
}

TEST_CASE("Engine: the snapshot publishes the last LIVE hit's pad + sample (a booked hit at its booking, a direct "
          "trigger at its block offset, a MIDI note at its offset)",
          "[engine]")
{
    Engine e;
    e.prepare({48000.0, 64, 2, 0});
    Buffers b(2, 64);
    CHECK(e.snapshot().lastLiveHitPad == -1);
    e.commands().push(Command::triggerPadAtSample(5, 1.0f, 48000)); // booked 1 s ahead (no sample bound: silent)
    run(e, b, 1);
    CHECK(e.snapshot().lastLiveHitPad == 5);
    CHECK(e.snapshot().lastLiveHitSample == 48000);
    e.commands().push(Command::triggerPad(7, 1.0f));
    run(e, b, 1);
    CHECK(e.snapshot().lastLiveHitPad == 7);
    CHECK(e.snapshot().lastLiveHitSample == 64); // the block that applied it (offset 0, no host clock)
    MidiEvent on;
    on.data[0] = 0x90;
    on.data[1] = 36 + 9;
    on.data[2] = 100;
    on.size = 3;
    e.midiQueue(0).push(on);
    run(e, b, 1);
    CHECK(e.snapshot().lastLiveHitPad == 9);
    CHECK(e.snapshot().lastLiveHitSample == 128);
    run(e, b, 800); // the booked hit fires at 48000: the re-stamp keeps it as the last live hit
    CHECK(e.snapshot().lastLiveHitPad == 5);
    CHECK(e.snapshot().lastLiveHitSample == 48000);
}

TEST_CASE("Engine: a buffer-size change is invisible - transport, sequencer, voices and insert chains all survive",
          "[engine][devicechange]")
{
    // Preferences -> buffer size is release() + prepare() at the SAME sample rate. The device restarts; the song
    // must not. Everything below is musical state, not device state: it survives, and playback resumes where it was.
    Engine e;
    e.prepare({48000.0, 512, 2, 0});
    e.commands().push(Command::mixerSetStrip(1, static_cast<std::uint8_t>(StripKind::channel)));
    e.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::eq)));
    e.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::comp)));
    e.commands().push(Command::mixerSetFxParam(1, 0, 0, 7.5f, true)); // EQ LOW +7.5 dB
    e.commands().push(Command::mixerSetFxBypass(1, 1, true));         // the COMP bypassed
    e.commands().push(Command::seqSetBpm(90.0));
    e.commands().push(Command::seqPlay(true));
    std::vector<float> a(512), b(512);
    float* outs[2] = {a.data(), b.data()};
    for (int i = 0; i < 100; ++i)
        e.process(outs, 2, 512);
    const auto beforePlayhead = e.snapshot().playheadSamples;
    REQUIRE(beforePlayhead > 0u);
    REQUIRE(e.snapshot().seqPlaying == 1u);
    REQUIRE(e.snapshot().stripFxCount[1] == 2);

    // --- the buffer size changes ---
    e.release();
    e.prepare({48000.0, 128, 2, 0});
    std::vector<float> c(128), d(128);
    float* outs2[2] = {c.data(), d.data()};
    for (int i = 0; i < 8; ++i)
        e.process(outs2, 2, 128);

    REQUIRE(e.snapshot().seqPlaying == 1u);                  // still playing
    REQUIRE(e.snapshot().playheadSamples >= beforePlayhead); // did not rewind
    REQUIRE(e.snapshot().stripFxCount[1] == 2);              // the chain is still there
    REQUIRE(e.mixer().fxType(1, 0) == FxType::eq);           // …in the same order
    REQUIRE(e.mixer().fxType(1, 1) == FxType::comp);
    REQUIRE(e.mixer().fx(1, 0)->param(0) == Approx(7.5f)); // …with its params
    REQUIRE(e.mixer().fxBypassed(1, 1));                   // …and its bypass

    // a genuine SAMPLE-RATE change is a different story: rate-bound state cannot carry over, so it resets
    e.release();
    e.prepare({44100.0, 128, 2, 0});
    for (int i = 0; i < 4; ++i)
        e.process(outs2, 2, 128);
    REQUIRE(e.snapshot().seqPlaying == 0u);
    REQUIRE(e.snapshot().playheadSamples == 0u);
}
