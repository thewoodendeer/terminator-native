#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <vector>

#include "AllocationCounter.h"
#include "TestSamples.h"
#include "terminator/core/Engine.h"

using namespace terminator;
using Catch::Approx;

TEST_CASE("HostClock: the snapshot's ClockPoint maps host time to sample position", "[clock]")
{
    Engine e;
    e.prepare({48000.0, 480, 2, 0});
    std::vector<float> l(480), r(480);
    float* outs[2] = {l.data(), r.data()};
    const std::uint64_t t0 = 1'000'000'000ull; // 1 s
    e.process(nullptr, 0, outs, 2, 480, t0);
    e.process(nullptr, 0, outs, 2, 480, t0 + 10'000'000ull); // +10 ms = one block later
    const auto& c = e.snapshot().clock;
    REQUIRE(c.valid());
    REQUIRE(c.hostNs == t0 + 10'000'000ull);
    REQUIRE(c.samplePosition == 480);
    REQUIRE(c.sampleAt(t0 + 10'000'000ull) == Approx(480.0));
    REQUIRE(c.sampleAt(t0 + 15'000'000ull) == Approx(720.0));
    REQUIRE(c.sampleAt(t0) == Approx(0.0).margin(1e-9));
}

TEST_CASE("Trigger timing: host-timestamped events land at their intra-block position relative to the previous block "
          "(one-block latency, spacing preserved)",
          "[clock][midi]")
{
    Engine e;
    e.prepare({48000.0, 480, 2, 0});
    auto s = test::dc(48000, 1.0f);
    PadParams p;
    p.pad = 0;
    p.attackSec = 0.0f;
    p.chokeGroup = -2;
    p.interpolation = Interpolation::linear;
    e.commands().push(Command::setPadParams(p));
    e.commands().push(Command::setPadSample(0, s.get()));
    std::vector<float> l(480), r(480);
    float* outs[2] = {l.data(), r.data()};
    const std::uint64_t t0 = 5'000'000'000ull;
    e.process(nullptr, 0, outs, 2, 480, t0); // block 0 at t0
    // two hits "arrive" during block 0: 2 ms and 4 ms after its start (flam 2 ms apart)
    e.commands().push(Command::triggerPad(0, 1.0f, t0 + 2'000'000ull));
    e.commands().push(Command::triggerPad(0, 1.0f, t0 + 4'000'000ull));
    e.process(nullptr, 0, outs, 2, 480, t0 + 10'000'000ull); // block 1: offsets relative to block 0's entry
    REQUIRE(l[95] == 0.0f);
    REQUIRE(l[96] == Approx(1.0f)); // 2 ms = 96 samples
    REQUIRE(l[191] == Approx(1.0f));
    REQUIRE(l[192] == Approx(2.0f)); // second hit 2 ms later
    // an event with a timestamp older than the previous block → offset 0; one beyond the block → last sample
    e.commands().push(Command::triggerPad(0, 1.0f, t0));
    e.commands().push(Command::triggerPad(0, 1.0f, t0 + 999'000'000ull));
    e.process(nullptr, 0, outs, 2, 480, t0 + 20'000'000ull);
    REQUIRE(l[0] == Approx(3.0f));
    REQUIRE(l[479] == Approx(4.0f));
}

TEST_CASE("MIDI in: note on/off through the per-port queues drives the note map (A01 = note 36)", "[midi]")
{
    Engine e;
    e.prepare({48000.0, 256, 2, 0});
    auto s = test::dc(48000, 1.0f);
    for (int pad = 0; pad < 3; ++pad)
    {
        PadParams p;
        p.pad = static_cast<std::uint16_t>(pad);
        p.attackSec = 0.0f;
        p.interpolation = Interpolation::linear;
        if (pad == 2)
            p.mode = PadMode::gate;
        e.commands().push(Command::setPadParams(p));
        e.commands().push(Command::setPadSample(static_cast<std::uint16_t>(pad), s.get()));
    }
    std::vector<float> l(256), r(256);
    float* outs[2] = {l.data(), r.data()};
    e.process(nullptr, 0, outs, 2, 256, 0);

    auto note = [](std::uint8_t status, std::uint8_t n, std::uint8_t v)
    {
        MidiEvent m;
        m.data[0] = status;
        m.data[1] = n;
        m.data[2] = v;
        m.size = 3;
        return m;
    };
    REQUIRE(e.midiQueue(0).push(note(0x90, 36, 127))); // pad 0 full velocity
    REQUIRE(e.midiQueue(3).push(note(0x90, 37, 64)));  // pad 1 half, other port
    REQUIRE(e.midiQueue(0).push(note(0x90, 35, 127))); // below range → unmapped
    e.process(nullptr, 0, outs, 2, 256, 0);
    REQUIRE(l[10] == Approx(1.0f + 64.0f / 127.0f).epsilon(1e-4));
    REQUIRE(e.snapshot().activeVoices == 2);

    // remap note 60 → pad 2 (gate), note-on then note-off (and running-status note-on vel 0)
    e.commands().push(Command::setNoteMap(60, 2));
    REQUIRE(e.midiQueue(1).push(note(0x90, 60, 100)));
    e.process(nullptr, 0, outs, 2, 256, 0);
    REQUIRE(e.snapshot().activeVoices == 3);
    REQUIRE(e.midiQueue(1).push(note(0x80, 60, 0)));
    e.process(nullptr, 0, outs, 2, 256, 0); // release over 5 ms (240 samples)
    e.process(nullptr, 0, outs, 2, 256, 0);
    REQUIRE(e.snapshot().activeVoices == 2);
    REQUIRE(test::allocationsDuring(
                [&]
                {
                    e.midiQueue(0).push(note(0x90, 36, 100));
                    e.process(nullptr, 0, outs, 2, 256, 0);
                }) == 0);
}

TEST_CASE("Calibration: a synthetic loopback with a known delay is measured exactly", "[calibration]")
{
    // The "device": input channel 0 = output channel 1 delayed by D samples (a software loopback).
    constexpr int kBlock = 128;
    constexpr int kDelay = 1234;
    Engine e;
    e.prepare({48000.0, kBlock, 2, 1});
    std::vector<float> l(kBlock), r(kBlock), in(kBlock);
    float* outs[2] = {l.data(), r.data()};
    const float* ins[1] = {in.data()};
    std::vector<float> delayLine(static_cast<std::size_t>(kDelay + kBlock * 4), 0.0f);
    std::size_t wr = static_cast<std::size_t>(kDelay); // write head leads read head by kDelay

    e.commands().push(Command::startCalibration(1, 0, 48000, 42));
    int blocks = 0;
    while (e.snapshot().calibrationState != 2 && blocks < 2000)
    {
        // feed the input from the delay line, then run, then push this block's output into the delay line
        for (int i = 0; i < kBlock; ++i)
            in[static_cast<std::size_t>(i)] =
                delayLine[(wr + delayLine.size() - static_cast<std::size_t>(kDelay) + static_cast<std::size_t>(i)) %
                          delayLine.size()];
        e.process(ins, 1, outs, 2, kBlock, 0);
        for (int i = 0; i < kBlock; ++i)
            delayLine[(wr + static_cast<std::size_t>(i)) % delayLine.size()] = r[static_cast<std::size_t>(i)];
        wr = (wr + kBlock) % delayLine.size();
        ++blocks;
    }
    REQUIRE(e.snapshot().calibrationState == 2);
    REQUIRE(e.snapshot().calibrationId == 42);
    REQUIRE(e.calibrationCaptureFrames() == 48000);

    // cross-correlate the capture with the click → peak at kDelay exactly
    const float* cap = e.calibrationCapture();
    const float* click = Engine::calibrationClick();
    int bestLag = -1;
    double best = -1.0;
    for (int lag = 0; lag < 48000 - Engine::kCalibrationClickFrames; ++lag)
    {
        double acc = 0.0;
        for (int k = 0; k < Engine::kCalibrationClickFrames; ++k)
            acc += static_cast<double>(cap[lag + k]) * static_cast<double>(click[k]);
        if (acc > best)
        {
            best = acc;
            bestLag = lag;
        }
    }
    REQUIRE(bestLag == kDelay);

    SECTION("out-of-range channels fail cleanly")
    {
        e.commands().push(Command::startCalibration(5, 0, 1000, 43));
        e.process(ins, 1, outs, 2, kBlock, 0);
        REQUIRE(e.snapshot().calibrationState == 3);
        REQUIRE(e.snapshot().calibrationId == 43);
    }
}
