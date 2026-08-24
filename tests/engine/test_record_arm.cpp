// THE ARM + INPUT MONITORING (Phase 5.1c). 5.1a made the engine record; this is what turns a capture into a TAKE:
//   · it starts on a SAMPLE, not on the buffer boundary that happens to contain it — armed at the count-in's
//     downbeat, at the transport's anchor, or at a sample the page names, the first recorded frame is that frame;
//   · a punch-out length ends it just as exactly (record four bars and get four bars);
//   · you can hear the input through the engine while you set the level, optionally through a mixer strip, and
//     turning the monitor off is a ramp rather than a click.
// The input signal here is a MARKER: sample k carries (k mod 4096)/4096, which is exact in binary floating point, so
// the first frame in the file says which engine sample the take began on and no test has to trust a count.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <vector>

#include <juce_audio_formats/juce_audio_formats.h>

#include "AllocationCounter.h"
#include "terminator/core/Engine.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;
constexpr std::uint8_t kChannel = static_cast<std::uint8_t>(StripKind::channel);

/// The value the input carries at absolute engine sample k — exact in binary, so a frame identifies its sample.
float marker(std::uint64_t k)
{
    return static_cast<float>(k % 4096u) / 4096.0f;
}

juce::File tempWav(const char* name)
{
    return juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile(name);
}

std::vector<std::vector<float>> readWav(const juce::File& f)
{
    juce::AudioFormatManager fm;
    fm.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> rd(fm.createReaderFor(f));
    if (rd == nullptr)
        return {};
    juce::AudioBuffer<float> buf(static_cast<int>(rd->numChannels), static_cast<int>(rd->lengthInSamples));
    rd->read(&buf, 0, buf.getNumSamples(), 0, true, true);
    std::vector<std::vector<float>> out;
    for (int c = 0; c < buf.getNumChannels(); ++c)
        out.emplace_back(buf.getReadPointer(c), buf.getReadPointer(c) + buf.getNumSamples());
    return out;
}

/// An engine with two hardware inputs carrying the marker, driven block by block.
struct Rig
{
    Engine engine;
    int block;
    int outs;
    std::vector<std::vector<float>> outData, inData;
    std::vector<float*> outPtrs;
    std::vector<const float*> inPtrs;
    std::uint64_t sample = 0; // the absolute engine sample of the NEXT block

    explicit Rig(int blockSize = 128, int numOuts = 2, int numIn = 2)
        : block(blockSize), outs(numOuts),
          outData(static_cast<std::size_t>(numOuts), std::vector<float>(static_cast<std::size_t>(blockSize), 0.0f)),
          inData(static_cast<std::size_t>(numIn), std::vector<float>(static_cast<std::size_t>(blockSize), 0.0f))
    {
        for (auto& c : outData)
            outPtrs.push_back(c.data());
        for (auto& c : inData)
            inPtrs.push_back(c.data());
        engine.prepare({kSr, blockSize, numOuts, numIn, 0});
    }
    void push(const Command& c) { REQUIRE(engine.commands().push(c)); }
    /// Fill the inputs with the marker for this block and render it.
    void run(int blocks = 1)
    {
        for (int b = 0; b < blocks; ++b)
        {
            for (auto& ch : inData)
                for (int i = 0; i < block; ++i)
                    ch[static_cast<std::size_t>(i)] = marker(sample + static_cast<std::uint64_t>(i));
            engine.process(inPtrs.data(), static_cast<int>(inPtrs.size()), outPtrs.data(), outs, block, 0);
            sample += static_cast<std::uint64_t>(block);
        }
    }
    /// Hold both inputs at a constant instead of the marker (the monitor cases want a level, not a ramp).
    void runDc(float value, int blocks = 1)
    {
        for (int b = 0; b < blocks; ++b)
        {
            for (auto& ch : inData)
                std::fill(ch.begin(), ch.end(), value);
            engine.process(inPtrs.data(), static_cast<int>(inPtrs.size()), outPtrs.data(), outs, block, 0);
            sample += static_cast<std::uint64_t>(block);
        }
    }
    RecorderConfig cfg(const juce::File& f, int channels = 1) const
    {
        RecorderConfig c;
        c.file = f;
        c.sampleRate = kSr;
        c.numChannels = channels;
        c.bitDepth = 32; // float: what was pushed is what is read back, so a frame can be identified exactly
        return c;
    }
    float out(int ch, int i) const { return outData[static_cast<std::size_t>(ch)][static_cast<std::size_t>(i)]; }
    float peak(int ch) const
    {
        float pk = 0.0f;
        for (float v : outData[static_cast<std::size_t>(ch)])
            pk = std::max(pk, std::abs(v));
        return pk;
    }
};
} // namespace

TEST_CASE("record arm: a take armed at a sample starts on THAT sample, not on the block that contains it",
          "[record][arm]")
{
    Rig r(128);
    const auto f = tempWav("terminator-arm-sample.wav");
    f.deleteFile();
    juce::String err;
    // 300 is 44 samples INSIDE the block that starts at 256 — a block-aligned recorder would be 44 samples early.
    Engine::RecordArm arm;
    arm.mode = Engine::RecordStart::atSample;
    arm.atSample = 300;
    REQUIRE(r.engine.startRecord(r.cfg(f), err, arm));
    r.run(2); // blocks 0..255: armed, nothing captured
    REQUIRE(r.engine.recordArmed());
    REQUIRE(r.engine.recorder().framesCaptured() == 0);
    r.run(6); // through sample 1024
    CHECK_FALSE(r.engine.recordArmed());
    CHECK(r.engine.recordStartSample() == 300);
    const auto frames = r.engine.stopRecord();
    CHECK(frames == 1024 - 300);
    const auto wav = readWav(f);
    REQUIRE(wav.size() == 1);
    REQUIRE(wav[0].size() == static_cast<std::size_t>(1024 - 300));
    CHECK(wav[0][0] == Approx(marker(300)));
    CHECK(wav[0][1] == Approx(marker(301)));
    CHECK(wav[0].back() == Approx(marker(1023)));
    f.deleteFile();
}

TEST_CASE("record arm: a punch-out length ends the take on its own frame", "[record][arm][punch]")
{
    Rig r(128);
    const auto f = tempWav("terminator-arm-punch.wav");
    f.deleteFile();
    juce::String err;
    Engine::RecordArm arm;
    arm.mode = Engine::RecordStart::atSample;
    arm.atSample = 100;
    arm.lengthSamples = 500; // not a multiple of the block: the end has to be a SAMPLE too
    REQUIRE(r.engine.startRecord(r.cfg(f), err, arm));
    r.run(10);
    CHECK(r.engine.recordComplete()); // the audio thread stopped; the message thread closes the file
    CHECK(r.engine.recorder().framesCaptured() == 500);
    const auto frames = r.engine.stopRecord();
    CHECK(frames == 500);
    const auto wav = readWav(f);
    REQUIRE(wav.size() == 1);
    REQUIRE(wav[0].size() == 500);
    CHECK(wav[0][0] == Approx(marker(100)));
    CHECK(wav[0].back() == Approx(marker(599)));
    f.deleteFile();
}

TEST_CASE("record arm: a take armed to the count-in starts on the DOWNBEAT it is counting to", "[record][arm][countin]")
{
    Rig r(128);
    const auto f = tempWav("terminator-arm-countin.wav");
    f.deleteFile();
    juce::String err;
    Engine::RecordArm arm;
    arm.mode = Engine::RecordStart::countInDownbeat;
    REQUIRE(r.engine.startRecord(r.cfg(f), err, arm));
    r.run(1);
    REQUIRE(r.engine.recordArmed()); // no count-in booked yet: the take waits rather than starting anywhere
    REQUIRE(r.engine.recorder().framesCaptured() == 0);
    r.push(Command::seqSetBpm(120.0)); // a beat = 24000 samples at 48k
    r.push(Command::countIn(4));
    r.run(1);
    const auto downbeat = r.engine.snapshot().countInDownbeatSample;
    REQUIRE(downbeat > 0);
    // 4 beats from the block the count-in was booked in: 128 + 4×24000
    CHECK(downbeat == 128 + 4 * 24000);
    r.run(static_cast<int>((downbeat - 128) / 128) + 4);
    CHECK_FALSE(r.engine.recordArmed());
    CHECK(r.engine.recordStartSample() == downbeat);
    r.engine.stopRecord();
    const auto wav = readWav(f);
    REQUIRE(wav.size() == 1);
    REQUIRE(!wav[0].empty());
    CHECK(wav[0][0] == Approx(marker(downbeat)));
    f.deleteFile();
}

TEST_CASE("record arm: cancelling the count-in finishes an armed take instead of leaving it hanging",
          "[record][arm][countin]")
{
    Rig r(128);
    const auto f = tempWav("terminator-arm-cancel.wav");
    f.deleteFile();
    juce::String err;
    Engine::RecordArm arm;
    arm.mode = Engine::RecordStart::countInDownbeat;
    REQUIRE(r.engine.startRecord(r.cfg(f), err, arm));
    r.push(Command::cancelCountIn());
    r.run(2);
    CHECK(r.engine.recordComplete());
    CHECK(r.engine.stopRecord() == 0); // an empty take the page can report — not a recorder that never fires
    f.deleteFile();
}

TEST_CASE("record arm: a take armed to the transport starts on the transport's own anchor", "[record][arm][transport]")
{
    Rig r(128);
    const auto f = tempWav("terminator-arm-transport.wav");
    f.deleteFile();
    juce::String err;
    Engine::RecordArm arm;
    arm.mode = Engine::RecordStart::transportStart;
    REQUIRE(r.engine.startRecord(r.cfg(f), err, arm));
    r.run(3);
    REQUIRE(r.engine.recordArmed());
    REQUIRE(r.engine.recorder().framesCaptured() == 0);
    // the sequencer anchors PLAY at an exact sample in the future: the take begins there, not when the command lands
    const std::uint64_t anchor = 3 * 128 + 77;
    r.push(Command::seqPlay(anchor));
    r.run(4);
    CHECK_FALSE(r.engine.recordArmed());
    CHECK(r.engine.recordStartSample() == anchor);
    r.engine.stopRecord();
    const auto wav = readWav(f);
    REQUIRE(wav.size() == 1);
    REQUIRE(!wav[0].empty());
    CHECK(wav[0][0] == Approx(marker(anchor)));
    f.deleteFile();
}

TEST_CASE("record arm: the take reports the TRANSPORT position of its first frame", "[record][arm][transport]")
{
    Rig r(128);
    const auto f = tempWav("terminator-arm-playhead.wav");
    f.deleteFile();
    juce::String err;
    r.push(Command::transportPlay());
    r.run(4); // the playhead is at 512
    Engine::RecordArm arm;
    arm.mode = Engine::RecordStart::atSample;
    arm.atSample = 4 * 128 + 40;
    REQUIRE(r.engine.startRecord(r.cfg(f), err, arm));
    r.run(2);
    CHECK(r.engine.recordStartSample() == 4 * 128 + 40);
    CHECK(r.engine.recordStartPlayhead() == 512 + 40); // where in the song the take belongs
    CHECK(r.engine.snapshot().recordState == 2u);      // rolling
    r.engine.stopRecord();
    r.run(1); // the snapshot is the AUDIO thread's: it says "idle" at the next block, not the moment stop() returns
    CHECK(r.engine.snapshot().recordState == 0u);
    f.deleteFile();
}

TEST_CASE("monitor: the input is heard through the engine at its gain, and OFF fades rather than cuts", "[monitor]")
{
    Rig r(128);
    r.push(Command::setMonitor(true, 0, 1, 0.5f, -1));
    r.runDc(1.0f); // the first block RAMPS from silence to the gain — that is the point of the ramp
    CHECK(r.out(0, 0) < 0.5f);
    CHECK(r.out(0, 127) == Approx(0.5f).margin(0.01));
    r.runDc(1.0f);
    CHECK(r.out(0, 0) == Approx(0.5f)); // settled: exactly the gain, on both sides
    CHECK(r.out(1, 64) == Approx(0.5f));
    r.push(Command::setMonitor(false, 0, 1, 0.5f, -1));
    r.runDc(1.0f);
    CHECK(r.out(0, 0) == Approx(0.5f).margin(0.01)); // OFF ramps down over the block…
    CHECK(r.out(0, 127) == Approx(0.0f).margin(0.005));
    r.runDc(1.0f);
    CHECK(r.peak(0) == 0.0f); // … and then it is gone
    CHECK(r.peak(1) == 0.0f);
}

TEST_CASE("monitor: one input is heard centred, on both sides", "[monitor]")
{
    Rig r(128);
    r.push(Command::setMonitor(true, 1, -1, 1.0f, -1)); // input 2 alone
    r.runDc(0.25f, 2);
    CHECK(r.out(0, 0) == Approx(0.25f));
    CHECK(r.out(1, 0) == Approx(0.25f));
}

TEST_CASE("monitor: through a strip it takes the strip's fader, so you monitor what you will hear", "[monitor][mixer]")
{
    Rig r(128);
    r.push(Command::mixerSetStrip(1, kChannel));
    r.push(Command::mixerSetFader(1, -6.0206f)); // half
    r.push(Command::setMonitor(true, 0, 1, 1.0f, 1));
    r.runDc(0.5f, static_cast<int>(0.4 * kSr / 128) + 1); // let the fader's smoother settle
    CHECK(r.out(0, 64) == Approx(0.25f).margin(0.002));
    r.push(Command::mixerSetMute(1, true));
    r.runDc(0.5f, static_cast<int>(0.4 * kSr / 128) + 1);
    CHECK(r.peak(0) == Approx(0.0f).margin(0.0005));
}

TEST_CASE("monitor: an armed take with the monitor open allocates nothing on the audio thread", "[monitor][rt]")
{
    Rig r(128);
    const auto f = tempWav("terminator-arm-alloc.wav");
    f.deleteFile();
    juce::String err;
    Engine::RecordArm arm;
    arm.mode = Engine::RecordStart::atSample;
    arm.atSample = 256 + 33;
    REQUIRE(r.engine.startRecord(r.cfg(f, 2), err, arm));
    r.push(Command::mixerSetStrip(1, kChannel));
    r.push(Command::setMonitor(true, 0, 1, 0.8f, 1));
    r.run(2); // warm every path up first (the counter measures the steady state, not the first touch)
    const auto allocs = test::allocationsDuring([&] { r.run(8); }); // armed → rolling → captured, monitor open
    CHECK(allocs == 0);
    CHECK(r.engine.recorder().framesCaptured() > 0);
    r.engine.stopRecord();
    f.deleteFile();
}
