// Metronome + count-in (Phase 3.6) on the sample clock. The clicks are synthesised in the callback and placed on the
// DRIVING sequencer's grid: every assertion is in samples at 0 tolerance — on the beat at any resolution, through a
// tempo change (the click lands where the sequencer's step lands, never on a naive 60/bpm walker), pause/resume/stop,
// the drums alone, a driver hand-over without a double click, block-size invariance; the count-in books N clicks a
// beat apart, publishes N..1, silences the train until its downbeat and the transport's beat 0 there is ONE click.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "TestSamples.h"
#include "terminator/core/Engine.h"
#include "terminator/core/Metronome.h"

using namespace terminator;
using Catch::Approx;

namespace
{
struct Click
{
    std::uint64_t sample;
    int beat;
    bool accent;
};

struct Rig
{
    Engine engine;
    std::vector<std::vector<float>> data;
    std::vector<float*> ptrs;
    int block;
    double sr;
    std::uint64_t seenClicks = 0;
    std::vector<Click> clicks;
    Rig(int blockSize, double sampleRate = 48000.0)
        : data(2, std::vector<float>(static_cast<std::size_t>(blockSize), 0.0f)), block(blockSize), sr(sampleRate)
    {
        for (auto& c : data)
            ptrs.push_back(c.data());
        engine.prepare({sampleRate, blockSize, 2, 0});
    }
    /// Render `blocks`, logging every click the snapshot reports (one per block at most at musical tempi).
    void run(int blocks = 1)
    {
        for (int i = 0; i < blocks; ++i)
        {
            engine.process(ptrs.data(), 2, block);
            const auto& s = engine.snapshot();
            if (s.metronomeClicks != seenClicks)
            {
                seenClicks = s.metronomeClicks;
                clicks.push_back({s.metronomeLastClickSample, s.metronomeBeat, s.metronomeLastClickAccent != 0});
            }
        }
    }
    /// Render `blocks`, returning channel 0 concatenated (and logging clicks).
    std::vector<float> capture(int blocks)
    {
        std::vector<float> out;
        out.reserve(static_cast<std::size_t>(blocks) * static_cast<std::size_t>(block));
        for (int b = 0; b < blocks; ++b)
        {
            run();
            out.insert(out.end(), data[0].begin(), data[0].end());
        }
        return out;
    }
    std::shared_ptr<SampleBuffer> bindPad(int pad, std::int16_t group = -2)
    {
        auto s = test::dc(static_cast<std::int64_t>(sr * 10.0), static_cast<float>(pad + 1) * 0.1f, sr);
        PadParams p;
        p.pad = static_cast<std::uint16_t>(pad);
        p.attackSec = 0.0f;
        p.interpolation = Interpolation::linear;
        p.chokeGroup = group;
        engine.commands().push(Command::setPadParams(p));
        engine.commands().push(Command::setPadSample(static_cast<std::uint16_t>(pad), s.get()));
        return s;
    }
    void metro(bool on, std::uint8_t sound = 0) { engine.commands().push(Command::setMetronome(on, sound)); }
};

std::shared_ptr<SeqPattern> pattern(int bars, int resolution, bool loop = true)
{
    auto p = std::make_shared<SeqPattern>();
    p->clear();
    p->index = 0;
    p->bars = bars;
    p->resolution = resolution;
    p->stepCount = std::min(kSeqMaxSteps, bars * resolution);
    p->loop = loop;
    p->swing = 0.0;
    return p;
}
void hit(SeqPattern& p, int step, int pad)
{
    p.grid[step] |= (1ull << pad);
}

/// Standalone renders of the Metronome (no engine): one click at `at`, `blocks` blocks of `block`.
std::vector<float> renderClick(ClickSound sound, std::uint64_t at, int block, int blocks, double sr = 48000.0)
{
    Metronome m;
    m.prepare(sr);
    m.setSound(sound);
    m.countIn(1, at, 0); // one accented click, no transport needed
    std::vector<float> out;
    std::vector<float> l(static_cast<std::size_t>(block)), r(static_cast<std::size_t>(block));
    std::uint64_t pos = 0;
    for (int b = 0; b < blocks; ++b)
    {
        std::fill(l.begin(), l.end(), 0.0f);
        std::fill(r.begin(), r.end(), 0.0f);
        m.process(pos, block, l.data(), r.data());
        out.insert(out.end(), l.begin(), l.end());
        pos += static_cast<std::uint64_t>(block);
    }
    return out;
}
} // namespace

TEST_CASE("metronome: the five click sounds render at their sample, peak within bounds, and are silent by 350 ms",
          "[metronome]")
{
    const ClickSound sounds[] = {ClickSound::click, ClickSound::hihat, ClickSound::rimshot, ClickSound::kick,
                                 ClickSound::clap};
    for (const auto snd : sounds)
    {
        const auto out = renderClick(snd, 1000, 64, 400); // 25600 samples
        std::size_t first = out.size();
        float peak = 0.0f;
        for (std::size_t i = 0; i < out.size(); ++i)
        {
            REQUIRE(std::isfinite(out[i]));
            if (out[i] != 0.0f && first == out.size())
                first = i;
            peak = std::max(peak, std::abs(out[i]));
        }
        INFO("sound " << static_cast<int>(snd));
        CHECK(first >= 1000);     // nothing before the click
        CHECK(first <= 1000 + 2); // and it starts there (the 1 ms attack's first sample is 0 — sin(0) too)
        CHECK(peak > 0.05f);
        CHECK(peak <= 1.0f);
        // silent after the longest source stops (kick 350 ms): every element ends at its own stop time
        for (std::size_t i = 1000 + 16800 + 1; i < out.size(); ++i)
            REQUIRE(out[i] == 0.0f);
        // block-size invariant: the same click rendered in 37-sample blocks is bit-identical
        const auto out37 = renderClick(snd, 1000, 37, 25600 / 37 + 1);
        for (std::size_t i = 0; i < out.size(); ++i)
            REQUIRE(out37[i] == out[i]);
    }
    // a click sounds only once it is booked: no output with nothing pending
    Metronome m;
    m.prepare(48000.0);
    m.setEnabled(true);
    std::vector<float> l(64), r(64);
    for (int b = 0; b < 50; ++b)
    {
        m.process(static_cast<std::uint64_t>(b) * 64, 64, l.data(), r.data());
        for (float x : l)
            REQUIRE(x == 0.0f);
    }
    CHECK(m.clicks() == 0);
}

TEST_CASE("metronome: the beats ride the chop sequencer's grid - one per beat from the anchor, accent on beat 0, "
          "none while METRO is off, block-size invariant",
          "[metronome]")
{
    for (const int block : {64, 37, 512})
    {
        Rig r(block);
        r.engine.commands().push(Command::seqSetBpm(120.0));
        auto p = pattern(1, 16);
        r.engine.commands().push(Command::seqSetPattern(p.get()));
        // METRO off: the sequencer plays, no clicks
        r.engine.commands().push(Command::seqPlay(1000));
        r.run(48000 / block);
        CHECK(r.clicks.empty());
        CHECK(r.engine.snapshot().metronomeEnabled == 0);
        r.engine.commands().push(Command::seqStop());
        r.run(2);
        // METRO on, PLAY (the anchor = the block that applies it): beats at anchor + n·24000 (120 BPM), beat index
        // n mod 4, accent on 0
        r.metro(true);
        const auto anchor = r.engine.snapshot().samplesProcessed;
        r.engine.commands().push(Command::seqPlay(0));
        r.clicks.clear();
        const int blocks = (96000 + block - 1) / block; // ≥ 2 s
        r.run(blocks);
        REQUIRE(r.clicks.size() >= 4);
        for (std::size_t i = 0; i < 4; ++i)
        {
            INFO("block " << block << " click " << i);
            CHECK(r.clicks[i].sample == anchor + i * 24000);
            CHECK(r.clicks[i].beat == static_cast<int>(i % 4));
            CHECK(r.clicks[i].accent == (i % 4 == 0));
        }
        CHECK(r.engine.snapshot().metronomeEnabled == 1);
        CHECK(r.engine.snapshot().metronomeClicks == r.clicks.size());
    }
}

TEST_CASE("metronome: a tempo change puts the click where the SEQUENCER's step lands (never a naive 60/bpm walker)",
          "[metronome]")
{
    // res 16 at 120: steps 6000 apart; the BPM goes to 90 during step 5 → steps 6.. are 8000 apart; beat 2 = step 8 =
    // 1000 + 6·6000 + 2·8000 = 53000. A walker re-reading 60/bpm per beat would have clicked at 49000.
    Rig r(64);
    auto keep = r.bindPad(7);
    auto p = pattern(1, 16);
    hit(*p, 8, 7);
    r.engine.commands().push(Command::seqSetBpm(120.0));
    r.engine.commands().push(Command::seqSetPattern(p.get()));
    r.metro(true);
    r.engine.commands().push(Command::seqPlay(1000));
    auto out = r.capture((1000 + 5 * 6000 + 3000) / 64); // inside step 5
    r.engine.commands().push(Command::seqSetBpm(90.0));
    const auto more = r.capture(2000);
    out.insert(out.end(), more.begin(), more.end());
    // the pad's onset (DC, attack 0) is AT 53000 — the sequencer's own step 8
    REQUIRE(out.size() > 53100);
    CHECK(out[52999] == Approx(0.0f).margin(1e-6f)); // nothing from the pad yet (the click at 49000? none)
    CHECK(out[53000] == Approx(0.8f).margin(1e-3f));
    // the clicks: 1000, 25000 (beat 1 = step 4 at 120), then 53000 (beat 2 = step 8), then 53000 + 4·8000 = 85000
    REQUIRE(r.clicks.size() >= 4);
    CHECK(r.clicks[0].sample == 1000);
    CHECK(r.clicks[1].sample == 25000);
    CHECK(r.clicks[2].sample == 53000);
    CHECK(r.clicks[3].sample == 85000);
    for (const auto& c : r.clicks)
        CHECK(c.sample != 49000);
}

TEST_CASE("metronome: a resolution not divisible by 4 (6 steps per bar) still clicks on every beat, interpolated "
          "inside the step; a step longer than a beat (2 per bar) books the beats inside it",
          "[metronome]")
{
    {
        Rig r(64);
        auto p = pattern(1, 6); // steps 16000 apart at 120; beats every 24000
        r.engine.commands().push(Command::seqSetBpm(120.0));
        r.engine.commands().push(Command::seqSetPattern(p.get()));
        r.metro(true);
        r.engine.commands().push(Command::seqPlay(0));
        r.run(2 * 48000 / 64 + 1); // one bar + a step
        REQUIRE(r.clicks.size() >= 4);
        for (std::size_t i = 0; i < 4; ++i)
            CHECK(r.clicks[i].sample == i * 24000);
        CHECK(r.clicks[1].beat == 1);
        CHECK(r.clicks[3].beat == 3);
    }
    {
        Rig r(64);
        auto p = pattern(1, 2); // a step = 2 beats = 48000 samples
        r.engine.commands().push(Command::seqSetBpm(120.0));
        r.engine.commands().push(Command::seqSetPattern(p.get()));
        r.metro(true);
        r.engine.commands().push(Command::seqPlay(640));
        r.run(2 * 48000 / 64 + 20);
        REQUIRE(r.clicks.size() >= 4);
        for (std::size_t i = 0; i < 4; ++i)
            CHECK(r.clicks[i].sample == 640 + i * 24000);
    }
}

TEST_CASE("metronome: pause stops the clicks and drops the booked beat, resume continues on the shifted grid, stop "
          "ends them, METRO toggled on mid-play clicks on the next beat",
          "[metronome]")
{
    Rig r(64);
    auto p = pattern(2, 16);
    r.engine.commands().push(Command::seqSetBpm(120.0));
    r.engine.commands().push(Command::seqSetPattern(p.get()));
    r.engine.commands().push(Command::seqPlay(0));
    r.run(30000 / 64); // 1 beat + a bit, METRO off
    CHECK(r.clicks.empty());
    // toggle on mid-play: the next beat (48000) clicks, nothing in between
    r.metro(true);
    r.run((48000 + 640 - 30016) / 64 + 1);
    REQUIRE(r.clicks.size() == 1);
    CHECK(r.clicks[0].sample == 48000);
    CHECK(r.clicks[0].beat == 2);
    // pause at ~60000: no clicks while paused (the beat at 72000 must not fire)
    r.run(static_cast<int>((60032 - r.engine.snapshot().samplesProcessed) / 64));
    r.engine.commands().push(Command::seqPause());
    r.run(48000 / 64); // a second of pause
    CHECK(r.clicks.size() == 1);
    // resume: the grid shifts by the pause length; the seq's step 12 (beat 3) lands 12000 after the resume point
    // (it was 12000 away when paused: 72000 − 60032 = 11968 → the block math: paused at block start 60032, the step
    // was at 72000)
    const auto resumeAt = r.engine.snapshot().samplesProcessed;
    r.engine.commands().push(Command::seqResume());
    r.run(30000 / 64);
    REQUIRE(r.clicks.size() == 2);
    CHECK(r.clicks[1].sample == resumeAt + (72000 - 60032));
    CHECK(r.clicks[1].beat == 3);
    // stop: nothing more
    r.engine.commands().push(Command::seqStop());
    r.run(96000 / 64);
    CHECK(r.clicks.size() == 2);
    CHECK(r.engine.snapshot().metronomeEnabled == 1); // the flag stays (TS: the METRO flag survives STOP)
}

TEST_CASE("metronome: the drums alone drive the clicks (96 steps per bar); the chop sequencer takes the grid over "
          "when it plays - no double click at the hand-over; drumStop with the seq silent ends them",
          "[metronome]")
{
    Rig r(64);
    r.engine.commands().push(Command::seqSetBpm(120.0));
    r.metro(true, 3);                                  // the kick
    r.engine.commands().push(Command::drumPlay(0, 0)); // the default 2-bar 96-step grid: a step = 1000 samples
    r.run(96000 / 64);
    REQUIRE(r.clicks.size() == 4);
    for (std::size_t i = 0; i < 4; ++i)
    {
        CHECK(r.clicks[i].sample == i * 24000);
        CHECK(r.clicks[i].beat == static_cast<int>(i));
    }
    // the chop sequencer joins at 96000 (the same grid): one click there, then every 24000 from the seq
    auto p = pattern(1, 16);
    r.engine.commands().push(Command::seqSetPattern(p.get()));
    r.engine.commands().push(Command::seqPlay(96000));
    r.run(96000 / 64);
    REQUIRE(r.clicks.size() == 8);
    for (std::size_t i = 4; i < 8; ++i)
        CHECK(r.clicks[i].sample == i * 24000);
    // seqStop with the drums still running: the drums drive again — the beats go on
    r.engine.commands().push(Command::seqStop());
    r.run(48000 / 64);
    CHECK(r.clicks.size() >= 9);
    // drumStop: silence
    r.engine.commands().push(Command::drumStop());
    const auto n = r.clicks.size();
    r.run(96000 / 64);
    CHECK(r.clicks.size() == n);
}

TEST_CASE("metronome: count-in - N clicks a beat apart from atSample, the first accented, countInBeat N..1 then -1, "
          "the downbeat sample published; the train is silent until the downbeat and the transport's beat 0 there "
          "is ONE click; cancel drops the rest",
          "[metronome]")
{
    {
        // the transport plays the whole time (the beats at 24000-multiples would click) — a count-in from 10000
        // owns the clicks until its downbeat at 10000 + 4·24000 = 106000
        Rig r(64);
        auto p = pattern(1, 16);
        r.engine.commands().push(Command::seqSetBpm(120.0));
        r.engine.commands().push(Command::seqSetPattern(p.get()));
        r.metro(true);
        r.engine.commands().push(Command::seqPlay(0));
        r.run(1);
        r.engine.commands().push(Command::countIn(4, 10000));
        r.run(1);
        CHECK(r.engine.snapshot().countInBeat == 4);
        CHECK(r.engine.snapshot().countInPending == 1);
        CHECK(r.engine.snapshot().countInDownbeatSample == 106000);
        r.run(10000 / 64 + 2);         // past the first count-in click
        REQUIRE(r.clicks.size() == 2); // the transport's beat 0 at sample 0 + the count-in's first
        CHECK(r.clicks[1].sample == 10000);
        CHECK(r.clicks[1].accent);
        CHECK(r.engine.snapshot().countInBeat == 4);
        r.run(24000 / 64);
        CHECK(r.clicks.size() == 3);
        CHECK(r.clicks[2].sample == 34000);
        CHECK_FALSE(r.clicks[2].accent);
        CHECK(r.engine.snapshot().countInBeat == 3);
        r.run(24000 / 64);
        CHECK(r.engine.snapshot().countInBeat == 2);
        r.run(24000 / 64);
        CHECK(r.engine.snapshot().countInBeat == 1);
        CHECK(r.clicks.size() == 5);
        CHECK(r.clicks[4].sample == 82000);
        // the transport's beats at 24000 / 48000 / 72000 / 96000 were silent (before the downbeat); 120000 clicks
        r.run(50000 / 64);
        CHECK(r.engine.snapshot().countInBeat == -1);
        CHECK(r.engine.snapshot().countInPending == 0);
        REQUIRE(r.clicks.size() == 6);
        CHECK(r.clicks[5].sample == 120000);
    }
    {
        // stopped transport: count in, then PLAY at the downbeat — its beat 0 is exactly one click
        Rig r(64);
        auto p = pattern(1, 16);
        r.engine.commands().push(Command::seqSetBpm(120.0));
        r.engine.commands().push(Command::seqSetPattern(p.get()));
        r.metro(true);
        r.engine.commands().push(Command::countIn(4, 10000));
        r.run(1);
        const auto downbeat = r.engine.snapshot().countInDownbeatSample;
        REQUIRE(downbeat == 106000);
        r.engine.commands().push(Command::seqPlay(downbeat));
        r.run(200000 / 64);
        REQUIRE(r.clicks.size() >= 7);
        CHECK(r.clicks[3].sample == 82000);
        CHECK(r.clicks[4].sample == 106000); // the downbeat: the transport's beat 0, once
        CHECK(r.clicks[4].beat == 0);
        CHECK(r.clicks[4].accent);
        CHECK(r.clicks[5].sample == 130000);
        CHECK(r.clicks[6].sample == 154000);
    }
    {
        // cancel
        Rig r(64);
        r.engine.commands().push(Command::seqSetBpm(120.0));
        r.engine.commands().push(Command::countIn(4, 10000)); // METRO off: the count-in clicks regardless (TS)
        r.run(40000 / 64);
        CHECK(r.clicks.size() == 2);
        r.engine.commands().push(Command::cancelCountIn());
        r.run(1);
        CHECK(r.engine.snapshot().countInBeat == -1);
        CHECK(r.engine.snapshot().countInDownbeatSample == 0);
        r.run(100000 / 64);
        CHECK(r.clicks.size() == 2);
        // a count-in at 0 = the block start; beats follow the BPM at the time (90 → 32000 apart)
        r.engine.commands().push(Command::seqSetBpm(90.0));
        r.engine.commands().push(Command::countIn(2, 0));
        const auto at = r.engine.snapshot().samplesProcessed;
        r.run(70000 / 64);
        REQUIRE(r.clicks.size() == 4);
        CHECK(r.clicks[2].sample == at);
        CHECK(r.clicks[3].sample == at + 32000);
        CHECK(r.engine.snapshot().countInDownbeatSample == at + 64000);
    }
}

TEST_CASE("metronome: the clicks bypass the master gain (the TS clicks went straight to the destination)",
          "[metronome]")
{
    Rig r(64);
    r.engine.commands().push(Command::setMasterGain(0.0f));
    r.engine.commands().push(Command::countIn(1, 6400));
    auto out = r.capture(102);                  // the click starts at 6400 = block 100; block 101 sits in its decay
    CHECK(r.engine.snapshot().peak[0] > 0.05f); // the meter sees it (read in the block that holds the click)
    const auto more = r.capture(300);
    out.insert(out.end(), more.begin(), more.end());
    float peak = 0.0f;
    for (float x : out)
        peak = std::max(peak, std::abs(x));
    CHECK(peak > 0.05f);
}
