// DrumSequencer — the drum machine's step sequencer on the sample clock (Phase 3.3). Every assertion is in
// SAMPLES (tolerance 0 unless a fade's float ramp is being read): onsets land exactly where the 96-step grid + swing
// + SHIFT say, in every block size, for ten minutes; note-repeat rolls fade INTO the next sub-hit; lanes cut each
// other by the time-order mute-group rule; one owner per hit; arranged pattern swaps land on the bar.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <memory>
#include <vector>

#include "AllocationCounter.h"
#include "TestSamples.h"
#include "terminator/core/DrumSequencer.h"
#include "terminator/core/Engine.h"
#include "terminator/core/planners/Swing.h"

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
    double sr;
    Rig(int blockSize, double sampleRate = 48000.0)
        : data(2, std::vector<float>(static_cast<std::size_t>(blockSize), 0.0f)), block(blockSize), sr(sampleRate)
    {
        for (auto& c : data)
            ptrs.push_back(c.data());
        engine.prepare({sampleRate, blockSize, 2, 0});
    }
    void run(int blocks = 1)
    {
        for (int i = 0; i < blocks; ++i)
            engine.process(ptrs.data(), 2, block);
    }
    /// Render `blocks` blocks, returning channel `ch` concatenated.
    std::vector<float> capture(int blocks, int ch = 0)
    {
        std::vector<float> out;
        out.reserve(static_cast<std::size_t>(blocks) * static_cast<std::size_t>(block));
        for (int b = 0; b < blocks; ++b)
        {
            run();
            out.insert(out.end(), data[static_cast<std::size_t>(ch)].begin(), data[static_cast<std::size_t>(ch)].end());
        }
        return out;
    }
    /// Both channels.
    std::pair<std::vector<float>, std::vector<float>> capture2(int blocks)
    {
        std::vector<float> l, r;
        for (int b = 0; b < blocks; ++b)
        {
            run();
            l.insert(l.end(), data[0].begin(), data[0].end());
            r.insert(r.end(), data[1].begin(), data[1].end());
        }
        return {l, r};
    }
    static std::uint16_t padOf(int lane) { return static_cast<std::uint16_t>(kDrumPadBase + lane); }
    /// Lane `lane` plays `sample` (a 10 s DC by default), attack 0, linear, the drum 4 ms choke, mute group `group`
    /// (0 = none → own-pad retrigger only); lane volume 1, audible.
    std::shared_ptr<SampleBuffer> bindLane(int lane, float value = 0.1f, int group = 0,
                                           std::shared_ptr<SampleBuffer> sample = nullptr)
    {
        auto s = sample != nullptr ? sample : test::dc(static_cast<std::int64_t>(sr * 10.0), value, sr);
        PadParams p;
        p.pad = padOf(lane);
        p.attackSec = 0.0f;
        p.interpolation = Interpolation::linear;
        p.chokeGroup = group > 0 ? static_cast<std::int16_t>(1000 + group) : -1;
        p.chokeFadeSec = 0.004f;
        engine.commands().push(Command::setPadParams(p));
        engine.commands().push(Command::setPadSample(padOf(lane), s.get()));
        engine.commands().push(
            Command::drumSetLane(static_cast<std::uint16_t>(lane), 1.0f, true, static_cast<std::int16_t>(group)));
        return s;
    }
};

std::shared_ptr<DrumPattern> pattern(int bars, int stepsPerBar = kDrumStepsPerBar)
{
    auto p = std::make_shared<DrumPattern>();
    p->clear();
    p->bars = bars;
    p->stepsPerBar = stepsPerBar;
    p->stepCount = std::min(kDrumMaxSteps, bars * stepsPerBar);
    return p;
}
std::shared_ptr<DrumGraphs> graphs()
{
    auto g = std::make_shared<DrumGraphs>();
    g->clear();
    return g;
}
void hit(DrumPattern& p, int step, int lane)
{
    p.grid[step] |= (1ull << lane);
}
/// First sample index ≥ from where |out| rises above `level` (−1 = never).
long onsetAfter(const std::vector<float>& out, long from, float level)
{
    for (std::size_t i = static_cast<std::size_t>(std::max(0L, from)); i < out.size(); ++i)
        if (std::abs(out[i]) > level)
            return static_cast<long>(i);
    return -1;
}
/// Every index where out steps UP by more than `jump` versus the previous sample (hit onsets on a DC lane).
std::vector<long> onsets(const std::vector<float>& out, float jump)
{
    std::vector<long> r;
    for (std::size_t i = 1; i < out.size(); ++i)
        if (out[i] - out[i - 1] > jump)
            r.push_back(static_cast<long>(i));
    return r;
}
} // namespace

TEST_CASE("DrumSequencer: hits land exactly on the 96-step grid, the pattern loops, the snapshot reads, stop silences",
          "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0); // 0.1 DC, own-pad retrigger (4 ms = 192-sample fade)
    auto p = pattern(1);     // 96 steps, 120 BPM → stepDur 1000 samples
    for (int st : {0, 24, 48, 72})
        hit(*p, st, 0);
    r.engine.commands().push(Command::drumSetPattern(p.get()));
    r.engine.commands().push(Command::drumPlay());
    auto out = r.capture(250); // 120000 samples = 2.5 s (1.25 bars)
    REQUIRE(out[0] == Approx(0.1f).epsilon(1e-4));
    REQUIRE(out[23999] == Approx(0.1f).epsilon(1e-4));
    REQUIRE(out[24000] == Approx(0.1f + 0.1f * (1.0f - 1.0f / 192.0f)).epsilon(1e-3)); // new voice + the old one fading
    REQUIRE(out[24300] == Approx(0.1f).epsilon(1e-4));                                 // the 4 ms fade is over
    REQUIRE(out[48000] > 0.19f);
    REQUIRE(out[72000] > 0.19f);
    REQUIRE(out[96000] > 0.19f); // looped: step 0 again, exactly
    REQUIRE(out[95999] == Approx(0.1f).epsilon(1e-4));
    const auto& snap = r.engine.snapshot();
    REQUIRE(snap.drumPlaying == 1);
    REQUIRE(snap.drumStepCount == 96);
    REQUIRE(snap.drumHitsFired == 5);
    REQUIRE(snap.drumLoopStartSample == 96000);
    REQUIRE(snap.drumStep == 24); // 120000 − 96000 = 24000 = step 24.0
    REQUIRE(snap.drumStepPhase == Approx(0.0).margin(1e-9));
    REQUIRE(snap.playing == 1);
    REQUIRE((snap.drumActiveMask & 1u) == 1u);
    r.engine.commands().push(Command::drumStop());
    auto tail = r.capture(2);
    REQUIRE(r.engine.snapshot().drumPlaying == 0);
    REQUIRE(r.engine.snapshot().drumStep == -1);
    REQUIRE(tail[0] < 0.1f);    // fading from the first sample of the stop block
    REQUIRE(tail[400] == 0.0f); // the 4 ms fade is done
}

TEST_CASE("DrumSequencer: swing moves odd 16ths (and the 32nds inside them) by exactly the shared formula", "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0, 0.1f), s1 = r.bindLane(1, 0.2f), s2 = r.bindLane(2, 0.3f), s3 = r.bindLane(3, 0.4f);
    auto p = pattern(1);
    hit(*p, 0, 0);  // 16th 0 → straight
    hit(*p, 6, 1);  // 16th 1 → late
    hit(*p, 9, 2);  // a 32nd INSIDE 16th 1 → moves with it (same offset)
    hit(*p, 12, 3); // 16th 2 → straight
    r.engine.commands().push(Command::drumSetPattern(p.get()));
    r.engine.commands().push(Command::drumSetParams(0.5, 1.0f, 960));
    r.engine.commands().push(Command::drumPlay());
    auto out = r.capture(60); // 28800 samples
    const double sw = swing::swingOffsetSec(1, 120.0, 0.5) * 48000.0;
    REQUIRE(sw > 100.0); // a real offset at 120 BPM / 0.5
    const long e1 = 6000 + static_cast<long>(std::floor(sw));
    const long e2 = 9000 + static_cast<long>(std::floor(sw));
    auto on = onsets(out, 0.05f);
    REQUIRE(on.size() == 3); // lanes 1, 2, 3 (lane 0 starts at sample 0 — no step up)
    REQUIRE(on[0] == e1);
    REQUIRE(on[1] == e2);
    REQUIRE(on[2] == 12000); // even 16th: never moves
    REQUIRE(out[0] == Approx(0.1f).epsilon(1e-4));
    REQUIRE(out[6000] == Approx(0.1f).epsilon(1e-4)); // nothing on the straight slot of an odd 16th
}

TEST_CASE("DrumSequencer: SHIFT snaps to the PPQ pulse, may be negative (fired before its grid), clamps at PLAY",
          "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0, 0.1f), s1 = r.bindLane(1, 0.2f);
    auto g = graphs();
    SECTION("960 PPQ: 25-sample pulses; +10 ms → 475 samples (19 pulses), −50 ms → −2400 (96 pulses)")
    {
        auto p = pattern(1);
        hit(*p, 24, 0);
        g->shiftMs[24][0] = 10.0f;
        hit(*p, 48, 1);
        g->shiftMs[48][1] = -50.0f;
        r.engine.commands().push(Command::drumSetGraphs(g.get()));
        r.engine.commands().push(Command::drumSetPattern(p.get()));
        r.engine.commands().push(Command::drumSetParams(0.0, 1.0f, 960));
        r.engine.commands().push(Command::drumPlay());
        auto out = r.capture(120); // 57600
        auto on = onsets(out, 0.05f);
        REQUIRE(on.size() == 2);
        REQUIRE(on[0] == 24000 + 475);
        REQUIRE(on[1] == 48000 - 2400); // 45600: booked 50 ms before its grid time — the look-ahead
    }
    SECTION("24 PPQ (SP-1200): 1000-sample pulses; +10 ms rounds to 0, −30 ms rounds to −1000 (JS round)")
    {
        auto p = pattern(1);
        hit(*p, 24, 0);
        g->shiftMs[24][0] = 10.0f;
        hit(*p, 48, 1);
        g->shiftMs[48][1] = -30.0f;
        r.engine.commands().push(Command::drumSetGraphs(g.get()));
        r.engine.commands().push(Command::drumSetPattern(p.get()));
        r.engine.commands().push(Command::drumSetParams(0.0, 1.0f, 24));
        r.engine.commands().push(Command::drumPlay());
        auto out = r.capture(120);
        auto on = onsets(out, 0.05f);
        REQUIRE(on.size() == 2);
        REQUIRE(on[0] == 24000);
        REQUIRE(on[1] == 47000);
    }
    SECTION("a negative SHIFT on the first step fires at its early time when PLAY came early enough, else at the PLAY "
            "block (TS: max(now + 1 ms, …) at the moment the step is booked)")
    {
        auto p = pattern(1);
        hit(*p, 0, 0);
        g->shiftMs[0][0] = -50.0f;
        r.engine.commands().push(Command::drumSetGraphs(g.get()));
        r.engine.commands().push(Command::drumSetPattern(p.get()));
        r.engine.commands().push(Command::drumPlay(4800)); // commanded in block 0: step 0 at 4800, its hit at 2400
        auto out = r.capture(20);
        REQUIRE(onsetAfter(out, 0, 0.05f) == 2400); // still in the future at PLAY time → exact
        // the second pass: step 0 of bar 2 at 100800 fires 2400 early too
        auto more = r.capture(200);
        REQUIRE(onsetAfter(more, 90000 - 9600, 0.15f) == 100800 - 2400 - 9600);
        // PLAY commanded AFTER the early time has passed: the hit fires at the PLAY block (never in the past)
        Rig r2(480);
        auto t0 = r2.bindLane(0, 0.1f);
        r2.run(8); // blocks 0..7 → sample 3840
        r2.engine.commands().push(Command::drumSetGraphs(g.get()));
        r2.engine.commands().push(Command::drumSetPattern(p.get()));
        r2.engine.commands().push(Command::drumPlay(4800)); // wants 2400 — gone
        auto out2 = r2.capture(20);
        REQUIRE(onsetAfter(out2, 0, 0.05f) == 0); // = sample 3840 absolute: the first sample of the PLAY block
    }
}

TEST_CASE("DrumSequencer: a hit's level = lane volume x step VELOCITY x drum master; muted / silent lanes skip",
          "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0, 1.0f), s1 = r.bindLane(1, 1.0f), s2 = r.bindLane(2, 1.0f);
    auto p = pattern(1);
    hit(*p, 0, 0);
    hit(*p, 0, 1);
    hit(*p, 0, 2);
    auto g = graphs();
    g->velocity[0][0] = 0.8f;
    r.engine.commands().push(Command::drumSetGraphs(g.get()));
    r.engine.commands().push(Command::drumSetPattern(p.get()));
    r.engine.commands().push(Command::drumSetLane(0, 0.5f, true, 0));  // 0.5 × 0.8 × 0.5 = 0.2
    r.engine.commands().push(Command::drumSetLane(1, 1.0f, false, 0)); // muted
    r.engine.commands().push(Command::drumSetLane(2, 0.0f, true, 0));  // fader at 0
    r.engine.commands().push(Command::drumSetParams(0.0, 0.5f, 960));
    r.engine.commands().push(Command::drumPlay());
    auto out = r.capture(10);
    REQUIRE(out[100] == Approx(0.2f).epsilon(1e-4));
    REQUIRE(r.engine.snapshot().drumHitsFired == 1);
}

TEST_CASE("DrumSequencer: PAN per hit is the StereoPanner law (mono equal-power, stereo side-mix); 0 = no panner",
          "[drums]")
{
    Rig r(480);
    SECTION("mono source")
    {
        auto s0 = r.bindLane(0, 1.0f);
        auto p = pattern(1);
        auto g = graphs();
        for (int st : {0, 24, 48, 72})
            hit(*p, st, 0);
        g->pan[0][0] = -1.0f;
        g->pan[24][0] = 1.0f;
        g->pan[48][0] = 0.5f;
        g->pan[72][0] = 0.0f;
        r.engine.commands().push(Command::drumSetGraphs(g.get()));
        r.engine.commands().push(Command::drumSetPattern(p.get()));
        r.engine.commands().push(Command::drumPlay());
        auto [l, rr] = r.capture2(200);
        REQUIRE(l[300] == Approx(1.0f).epsilon(1e-4));
        REQUIRE(rr[300] == Approx(0.0f).margin(1e-6));
        REQUIRE(l[24300] == Approx(0.0f).margin(1e-6));
        REQUIRE(rr[24300] == Approx(1.0f).epsilon(1e-4));
        const float x = (0.5f + 1.0f) * 0.5f;
        REQUIRE(l[48300] == Approx(std::cos(x * 1.5707963f)).epsilon(1e-4));
        REQUIRE(rr[48300] == Approx(std::sin(x * 1.5707963f)).epsilon(1e-4));
        REQUIRE(l[72300] == Approx(1.0f).epsilon(1e-4)); // pan 0 = no panner: unity on both (not −3 dB)
        REQUIRE(rr[72300] == Approx(1.0f).epsilon(1e-4));
    }
    SECTION("stereo source (L 1.0, R 0.5)")
    {
        auto st = std::make_shared<SampleBuffer>();
        st->allocate(2, 480000, 48000.0);
        for (std::int64_t i = 0; i < 480000; ++i)
        {
            st->channel(0)[i] = 1.0f;
            st->channel(1)[i] = 0.5f;
        }
        auto s0 = r.bindLane(0, 1.0f, 0, st);
        auto p = pattern(1);
        auto g = graphs();
        for (int s : {0, 24, 48})
            hit(*p, s, 0);
        g->pan[0][0] = -1.0f;
        g->pan[24][0] = 1.0f;
        g->pan[48][0] = -0.5f;
        r.engine.commands().push(Command::drumSetGraphs(g.get()));
        r.engine.commands().push(Command::drumSetPattern(p.get()));
        r.engine.commands().push(Command::drumPlay());
        auto [l, rr] = r.capture2(120);
        REQUIRE(l[300] == Approx(1.5f).epsilon(1e-4)); // pan −1: L = inL + inR·cos(0), R = inR·sin(0)
        REQUIRE(rr[300] == Approx(0.0f).margin(1e-6));
        REQUIRE(l[24300] == Approx(0.0f).margin(1e-6)); // pan +1: L = inL·cos(π/2), R = inR + inL·sin(π/2)
        REQUIRE(rr[24300] == Approx(1.5f).epsilon(1e-4));
        const float c = std::cos(0.5f * 1.5707963f), sn = std::sin(0.5f * 1.5707963f);
        REQUIRE(l[48300] == Approx(1.0f + 0.5f * c).epsilon(1e-4));
        REQUIRE(rr[48300] == Approx(0.5f * sn).epsilon(1e-4));
    }
}

TEST_CASE("DrumSequencer: REPEAT rolls fill the step's straight slot, each sub-hit fading INTO the next; sub-hits cut "
          "nothing and are cut by nothing but their own end",
          "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0, 1.0f);
    // an 8-step grid (1/8 slots of 12000 samples at 120 BPM) so a 1/32 roll (3000 samples) fits 4 sub-hits —
    // at the UI's 96-step storage every rate is ≥ one slot (one internal step = 1/64T) and the roll collapses to the
    // single hit below; the machinery is the same (the slot is the only input)
    auto p = pattern(1, 8);
    auto g = graphs();
    SECTION("4 sub-hits at 0 / 3000 / 6000 / 9000, each 4 ms fade ending AT the next, the last at the slot end")
    {
        hit(*p, 1, 0);       // step 1 = 12000
        g->repeat[1][0] = 9; // 1/32 = 0.125 beats = 3000 samples
        r.engine.commands().push(Command::drumSetGraphs(g.get()));
        r.engine.commands().push(Command::drumSetPattern(p.get()));
        r.engine.commands().push(Command::drumPlay());
        auto out = r.capture(60); // 28800
        REQUIRE(out[12000] == Approx(1.0f).epsilon(1e-4));
        REQUIRE(out[14000] == Approx(1.0f).epsilon(1e-4));
        REQUIRE(out[14807] == Approx(1.0f).epsilon(1e-4)); // the fade starts at 15000 − 192
        REQUIRE(out[14904] == Approx(0.5f).epsilon(0.02)); // half way down
        REQUIRE(out[14999] < 0.01f);                       // gone right before the next sub-hit
        REQUIRE(out[15000] == Approx(1.0f).epsilon(1e-4)); // the next sub-hit, alone
        REQUIRE(out[18000] == Approx(1.0f).epsilon(1e-4));
        REQUIRE(out[21000] == Approx(1.0f).epsilon(1e-4));
        REQUIRE(out[23999] < 0.01f); // the last one faded into the slot end (24000)
        REQUIRE(out[24000] == 0.0f);
        REQUIRE(r.engine.snapshot().drumHitsFired == 4);
    }
    SECTION("a rate at or above the slot (or REPEAT off) = one normal hit; a ringing live voice is NOT cut by a roll")
    {
        hit(*p, 1, 0);
        g->repeat[1][0] = 5; // 1/8 = 0.5 beats = 12000 samples = the slot → 1 time → a normal hit
        r.engine.commands().push(Command::drumSetGraphs(g.get()));
        r.engine.commands().push(Command::drumSetPattern(p.get()));
        r.engine.commands().push(Command::drumPlay());
        r.engine.commands().push(Command::triggerPad(Rig::padOf(0), 1.0f)); // a live hit at sample 0 rings
        auto out = r.capture(60);
        REQUIRE(out[11000] == Approx(1.0f).epsilon(1e-4)); // the live voice
        REQUIRE(out[12500] == Approx(1.0f).epsilon(1e-4)); // a NORMAL hit: the lane's retrigger cut the live voice
        REQUIRE(r.engine.snapshot().drumHitsFired == 1);
        // now the same step as a real roll: the sub-hits layer over the live voice (they cut nothing)
        Rig r2(480);
        auto t0 = r2.bindLane(0, 1.0f);
        auto p2 = pattern(1, 8);
        auto g2 = graphs();
        hit(*p2, 1, 0);
        g2->repeat[1][0] = 9;
        r2.engine.commands().push(Command::drumSetGraphs(g2.get()));
        r2.engine.commands().push(Command::drumSetPattern(p2.get()));
        r2.engine.commands().push(Command::drumPlay());
        r2.engine.commands().push(Command::triggerPad(Rig::padOf(0), 1.0f));
        auto out2 = r2.capture(60);
        REQUIRE(out2[12500] == Approx(2.0f).epsilon(1e-4)); // live voice + sub-hit 0
        REQUIRE(out2[15500] == Approx(2.0f).epsilon(1e-4)); // live voice + sub-hit 1 (sub-hit 0 faded into it)
        REQUIRE(out2[25000] == Approx(1.0f).epsilon(1e-4)); // the roll is over, the live voice still rings
    }
}

TEST_CASE("DrumSequencer: mute groups cut by time order (4 ms), same-instant group mates layer, ungrouped lanes ring",
          "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0, 0.1f, 1), s1 = r.bindLane(1, 0.2f, 1), s2 = r.bindLane(2, 0.3f, 0);
    auto p = pattern(1);
    hit(*p, 0, 0);
    hit(*p, 0, 2);
    hit(*p, 24, 1); // cuts lane 0 (group 1) at 24000 — lane 2 keeps ringing
    hit(*p, 48, 0);
    hit(*p, 48, 1); // same instant: BOTH sound (a deliberate layer), the older lane-1 voice is cut
    r.engine.commands().push(Command::drumSetPattern(p.get()));
    r.engine.commands().push(Command::drumPlay());
    auto out = r.capture(130);                        // 62400
    REQUIRE(out[1000] == Approx(0.4f).epsilon(1e-4)); // lane 0 + lane 2
    REQUIRE(out[23999] == Approx(0.4f).epsilon(1e-4));
    REQUIRE(out[24000] == Approx(0.2f + 0.3f + 0.1f * (1.0f - 1.0f / 192.0f)).epsilon(1e-3)); // lane 0 fading
    REQUIRE(out[24300] == Approx(0.5f).epsilon(1e-4));                                        // lane 1 + lane 2
    REQUIRE(out[48300] == Approx(0.6f).epsilon(1e-4)); // lane 0 + lane 1 (new) + lane 2
    REQUIRE(out[60000] == Approx(0.6f).epsilon(1e-4));
    REQUIRE(r.engine.snapshot().activeVoices == 3);
}

TEST_CASE("DrumSequencer: one owner per hit - a live hit on the lane within 120 ms owns the pattern's copy", "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0, 1.0f);
    auto p = pattern(1);
    hit(*p, 24, 0); // 24000
    hit(*p, 72, 0); // 72000
    r.engine.commands().push(Command::drumSetPattern(p.get()));
    r.engine.commands().push(Command::drumPlay());
    r.engine.commands().push(Command::triggerPadAtSample(Rig::padOf(0), 1.0f, 23000)); // 21 ms early: the owner
    r.engine.commands().push(Command::triggerPadAtSample(Rig::padOf(0), 1.0f, 60000)); // 250 ms before 72000: not
    auto out = r.capture(200);                                                         // 96000
    auto on = onsets(out, 0.5f);
    REQUIRE(on.size() == 3); // 23000 (live), 60000 (live), 72000 (pattern) — NOT 24000
    REQUIRE(on[0] == 23000);
    REQUIRE(on[1] == 60000);
    REQUIRE(on[2] == 72000);
    REQUIRE(r.engine.snapshot().drumHitsSkipped == 1);
    REQUIRE(r.engine.snapshot().drumHitsFired == 1);
}

TEST_CASE("DrumSequencer: arranged pattern swaps take effect from the step at their sample (half-step tolerance); "
          "clearScheduled returns to the live pattern; play with a step offset seeks",
          "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0, 0.1f), s1 = r.bindLane(1, 0.2f);
    auto a = pattern(1), b = pattern(1);
    for (int st : {0, 24, 48, 72})
    {
        hit(*a, st, 0);
        hit(*b, st, 1);
    }
    SECTION("swap at the bar, then clear")
    {
        r.engine.commands().push(Command::drumSetPattern(a.get()));
        r.engine.commands().push(Command::drumSchedulePattern(b.get(), 95999)); // 1 sample early: rounding tolerance
        r.engine.commands().push(Command::drumPlay());
        auto out = r.capture(300); // 144000: bar 1 = A, bar 2 = B
        REQUIRE(out[1000] == Approx(0.1f).epsilon(1e-4));
        REQUIRE(out[95000] == Approx(0.1f).epsilon(1e-4)); // step 95 of bar 1 still A (no lane-1 hit)
        // bar 2 step 0 = B (lane 1, 0.2) + lane 0's voice from 72000 still ringing (nothing cut it): 0.3
        REQUIRE(out[96300] == Approx(0.3f).epsilon(1e-4));
        REQUIRE(out[95700] == Approx(0.1f).epsilon(1e-4)); // before the swap: lane 0 alone
        REQUIRE(out[120300] == Approx(0.3f).epsilon(1e-4));
        r.engine.commands().push(Command::drumClearScheduled());
        auto out2 = r.capture(210);                                         // to 244800: bar 3 (192000..) = A again
        REQUIRE(out2[192000 + 300 - 144000] == Approx(0.3f).epsilon(1e-4)); // lane 0 retriggered + lane 1 ringing
        REQUIRE(r.engine.snapshot().drumHitsFired == 4 + 4 + 2 + 1);        // A bar1, B bar2, A bar 3 (steps 0,24,48)
    }
    SECTION("play(at, stepOffset = 48) lands step 48 on the anchor; the loop start is published before it")
    {
        r.engine.commands().push(Command::drumSetPattern(a.get()));
        r.engine.commands().push(Command::drumPlay(4800, 48));
        auto out = r.capture(250);
        auto on = onsets(out, 0.05f);
        // step 48 at 4800, 72 at 28800, 0 at 52800 (the loop start), 24 at 76800, 48 at 100800
        REQUIRE(out[4800] == Approx(0.1f).epsilon(1e-4));
        REQUIRE(out[4799] == 0.0f);
        REQUIRE(on.size() == 5);
        REQUIRE(on[0] == 4800);
        REQUIRE(on[1] == 28800);
        REQUIRE(on[2] == 52800);
        REQUIRE(on[3] == 76800);
        REQUIRE(on[4] == 100800);
        REQUIRE(r.engine.snapshot().drumLoopStartSample == 52800);
        REQUIRE(r.engine.snapshot().drumStep == (120000 - 52800) / 1000);
    }
}

TEST_CASE("DrumSequencer: BPM changes apply at the next scheduled step (the look-ahead window keeps the old spacing)",
          "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0, 0.2f);
    auto p = pattern(2);
    for (int st = 0; st < 192; st += 6)
        hit(*p, st, 0); // every 16th
    r.engine.commands().push(Command::drumSetPattern(p.get()));
    r.engine.commands().push(Command::drumPlay());
    r.run(50);                                          // 24000 samples
    r.engine.commands().push(Command::seqSetBpm(60.0)); // 16ths: 6000 → 12000 samples
    auto out = r.capture(400);
    auto on = onsets(out, 0.1f);
    REQUIRE(on.size() >= 10);
    bool sawSlow = false;
    for (std::size_t i = 1; i < on.size(); ++i)
    {
        const long d = on[i] - on[i - 1];
        REQUIRE((d == 6000 || d == 12000));
        if (d == 12000)
            sawSlow = true;
        else
            REQUIRE(!sawSlow); // never back to the fast spacing
    }
    REQUIRE(sawSlow);
    REQUIRE(r.engine.snapshot().drumStepCount == 192);
}

TEST_CASE("DrumSequencer: block-size invariance (64 vs 512) with swing + SHIFT + a roll + groups, zero allocations",
          "[drums][rt]")
{
    auto render = [](int block)
    {
        Rig r(block);
        auto s0 = r.bindLane(0, 0.1f, 1), s1 = r.bindLane(1, 0.2f, 1), s2 = r.bindLane(2, 0.3f, 0);
        auto p = pattern(1, 16);
        auto g = graphs();
        for (int st = 0; st < 16; st += 2)
            hit(*p, st, 0);
        for (int st = 1; st < 16; st += 4)
            hit(*p, st, 1);
        hit(*p, 3, 2);
        hit(*p, 11, 2);
        g->shiftMs[4][0] = -23.0f;
        g->shiftMs[8][0] = 17.0f;
        g->repeat[6][0] = 11; // 1/64 roll
        g->pan[3][2] = -0.3f;
        g->velocity[12][0] = 0.6f;
        r.engine.commands().push(Command::drumSetGraphs(g.get()));
        r.engine.commands().push(Command::drumSetPattern(p.get()));
        r.engine.commands().push(Command::drumSetParams(0.4, 0.9f, 96));
        r.engine.commands().push(Command::drumPlay());
        const int blocks = 245760 / block; // 5.12 s — a whole number of both block sizes
        auto out = r.capture(blocks);
        REQUIRE(test::allocationsDuring([&] { r.run(48000 / block); }) == 0); // another second: nothing allocates
        return out;
    };
    auto a = render(64), b = render(512);
    REQUIRE(a.size() == b.size());
    float maxDiff = 0.0f;
    for (std::size_t i = 0; i < a.size(); ++i)
        maxDiff = std::max(maxDiff, std::abs(a[i] - b[i]));
    REQUIRE(maxDiff < 1e-6f);
    REQUIRE(onsetAfter(a, 0, 0.05f) == 0);
}

TEST_CASE("DrumSequencer: ten minutes at 120 BPM - every loop start lands exactly on a multiple of the bar", "[drums]")
{
    Rig r(480);
    auto s0 = r.bindLane(0, 0.1f);
    auto p = pattern(1);
    hit(*p, 0, 0);
    r.engine.commands().push(Command::drumSetPattern(p.get()));
    r.engine.commands().push(Command::drumPlay());
    const long blocks = 600L * 48000L / 480L; // 600 s
    std::vector<long> hits;
    for (long b = 0; b < blocks; ++b)
    {
        r.run();
        const long base = b * 480;
        for (int i = 0; i < 480; ++i)
            if (r.data[0][static_cast<std::size_t>(i)] > 0.15f &&
                (i > 0 ? r.data[0][static_cast<std::size_t>(i - 1)] <= 0.15f : true))
                hits.push_back(base + i);
    }
    // a 120 BPM bar = 2 s → 300 passes in 600 s; the hit at sample 0 starts the DC (no overlap), every later loop
    // start is the 4 ms retrigger overlap (> 0.15)
    REQUIRE(hits.size() == 299);
    for (std::size_t k = 0; k < hits.size(); ++k)
        REQUIRE(hits[k] == static_cast<long>(k + 1) * 96000L);
    REQUIRE(r.engine.snapshot().drumHitsFired == 300);
    REQUIRE(r.engine.snapshot().drumLoopStartSample == 300 * 96000);
}
