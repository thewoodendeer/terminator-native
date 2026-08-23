// BassSequencer — the piano roll's pattern player on the sample clock (Phase 3.4). Every timing assertion is in
// SAMPLES at 0 tolerance: note-ons fire exactly at round(start·96) ticks of 60/bpm/96, offs before ons at a tick,
// an off past the loop wraps, a BPM change lands at the next tick, the BEND lane posts per tick, stop releases +
// unbends, a live pattern replace releases the notes that changed, the arranger timeline fires at its samples, the
// pattern is quiet while the arranger drives, ten minutes of loop starts are exact, and the whole thing allocates
// nothing on the callback.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include "AllocationCounter.h"
#include "terminator/core/BassSequencer.h"
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
    double sr;
    std::shared_ptr<BassPatch> patch = std::make_shared<BassPatch>(BassPatch::defaults());
    Rig(int blockSize, double sampleRate = 48000.0)
        : data(2, std::vector<float>(static_cast<std::size_t>(blockSize), 0.0f)), block(blockSize), sr(sampleRate)
    {
        for (auto& c : data)
            ptrs.push_back(c.data());
        engine.prepare({sampleRate, blockSize, 2, 0});
        // a plain patch: no drift / sub / post drive so every voice is a clean saw
        patch->drift = 0.0;
        patch->subLevel = 0.0;
        patch->postDrive = 0.0;
        patch->cutoff = 4000.0;
        patch->envAmt = 0.0;
        engine.commands().push(Command::bassSetPatch(patch.get()));
    }
    void run(int blocks = 1)
    {
        for (int i = 0; i < blocks; ++i)
            engine.process(ptrs.data(), 2, block);
    }
    /// Render `blocks`, returning channel 0 concatenated.
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
    const StateSnapshot& snap() { return engine.snapshot(); }
    /// Step ONE sample at a time from the current position until `untilSample` (exclusive) and return the samples at
    /// which `notesFired` increased (each one exact).
    std::vector<std::uint64_t> onsetsUntil(std::uint64_t untilSample)
    {
        std::vector<std::uint64_t> r;
        Rig1 one(engine);
        std::uint64_t last = snap().bassNotesFired;
        while (snap().samplesProcessed < untilSample)
        {
            one.step();
            const auto now = snap().bassNotesFired;
            if (now != last)
            {
                r.push_back(snap().samplesProcessed - 1);
                last = now;
            }
        }
        return r;
    }
    struct Rig1 // a 1-sample block stepper on the same engine
    {
        Engine& e;
        float l = 0.0f, r = 0.0f;
        float* p[2] = {&l, &r};
        explicit Rig1(Engine& eng) : e(eng) {}
        void step() { e.process(p, 2, 1); }
    };
};

std::shared_ptr<BassPattern> pattern(int bars)
{
    auto p = std::make_shared<BassPattern>();
    p->clear();
    p->bars = bars;
    p->loopTicks = std::max(kBassPpq, bars * 4 * kBassPpq);
    return p;
}
double rmsOf(const std::vector<float>& a, std::size_t from, std::size_t to)
{
    double s = 0.0;
    to = std::min(to, a.size());
    for (std::size_t i = from; i < to; ++i)
        s += static_cast<double>(a[i]) * static_cast<double>(a[i]);
    return std::sqrt(s / static_cast<double>(std::max<std::size_t>(1, to - from)));
}
} // namespace

TEST_CASE("BassSequencer: note-ons land exactly on their PPQ-96 ticks, the loop repeats, offs on their tick",
          "[bass][seq]")
{
    Rig r(1); // 1-sample blocks: every command lands at sample 0, every event is observed at its exact sample
    auto p = pattern(1); // 1 bar = 384 ticks; 120 BPM → tick = 250 samples, beat = 24000
    REQUIRE(p->addNote(1, 36, 0.0, 0.5, 1.0, false));
    REQUIRE(p->addNote(2, 38, 1.0, 0.5, 1.0, false));
    REQUIRE(p->addNote(3, 40, 2.0, 0.5, 1.0, false));
    REQUIRE(p->addNote(4, 41, 3.0, 0.5, 1.0, false));
    // the map: on = round(start·96), off = round((start+dur)·96)
    REQUIRE(p->notes[0].onTick == 0);
    REQUIRE(p->notes[0].offTick == 48);
    REQUIRE(p->notes[3].onTick == 288);
    REQUIRE(p->notes[3].offTick == 336);
    r.engine.commands().push(Command::bassSetPattern(p.get()));
    r.engine.commands().push(Command::bassPlay());
    const auto onsets = r.onsetsUntil(120000); // 1.25 bars
    REQUIRE(onsets == std::vector<std::uint64_t>{0, 24000, 48000, 72000, 96000});
    REQUIRE(r.snap().bassPlaying == 1);
    REQUIRE(r.snap().bassLoopTicks == 384);
    REQUIRE(r.snap().bassLoopStartSample == 96000);
    REQUIRE(r.snap().bassTick == (120000 - 96000) / 250);
    REQUIRE(r.snap().bassNotesFired == 5);
    REQUIRE(r.snap().bassEventsDropped == 0);
}

TEST_CASE("BassSequencer: at a shared tick the OFF fires before the ON — a retrigger of the same pitch is not eaten",
          "[bass][seq]")
{
    Rig r(1);
    auto p = pattern(1);
    REQUIRE(p->addNote(1, 36, 0.0, 1.0, 1.0, false)); // off at tick 96
    REQUIRE(p->addNote(2, 36, 1.0, 1.0, 1.0, false)); // on at tick 96
    r.engine.commands().push(Command::bassSetPattern(p.get()));
    r.engine.commands().push(Command::bassPlay());
    const auto onsets = r.onsetsUntil(30000);
    REQUIRE(onsets == std::vector<std::uint64_t>{0, 24000});
    std::uint64_t mask[2];
    r.engine.bassSynth().activeNoteMask(mask);
    REQUIRE((mask[0] >> 36) == 1u); // still sounding after the retrigger (mono: the off then the on re-gated it)
    REQUIRE(r.snap().bassVoices == 1);
}

TEST_CASE("BassSequencer: an off past the loop end fires at its wrap — the note holds into the repeat", "[bass][seq]")
{
    Rig r(480);
    auto p = pattern(1);
    REQUIRE(p->addNote(7, 36, 3.5, 1.0, 1.0, false)); // on tick 336, off tick 432 → wraps to 48 (12000 samples in)
    REQUIRE(p->notes[0].offTick == 48);
    r.engine.commands().push(Command::bassSetPattern(p.get()));
    r.engine.commands().push(Command::bassPlay());
    r.run(96000 / 480 + 1); // past the loop start (the note has been on since 84000)
    REQUIRE(r.snap().bassVoices == 1);
    r.run((12000 - 480) / 480);                       // up to sample 108000 — the off lands here (the release starts)
    auto out = r.capture(50);                         // 0.5 s after the off
    REQUIRE(rmsOf(out, 24000 - 2400, 24000) < 0.002); // released well before the next on at 180000
}

TEST_CASE("BassSequencer: a BPM change applies at the NEXT tick — the grid stays continuous", "[bass][seq]")
{
    Rig r(1);
    auto p = pattern(1);
    for (int b = 0; b < 4; ++b)
        REQUIRE(p->addNote(b + 1, 36 + b, b, 0.25, 1.0, false));
    r.engine.commands().push(Command::bassSetPattern(p.get()));
    r.engine.commands().push(Command::bassPlay());
    auto first = r.onsetsUntil(30000); // beats 0 and 1 at 120 BPM (ticks every 250 samples)
    REQUIRE(first == std::vector<std::uint64_t>{0, 24000});
    r.engine.commands().push(Command::seqSetBpm(60.0)); // at sample 30000: nextTick = 120 (the next one = 120 → 30000)
    // ticks from 120 on are 500 samples apart: tick 192 (beat 2) lands at 30000 + 72 × 500 = 66000
    auto next = r.onsetsUntil(70000);
    REQUIRE(next == std::vector<std::uint64_t>{66000});
    REQUIRE(r.snap().seqBpm == Approx(60.0));
}

TEST_CASE("BassSequencer: the BEND lane posts per tick (when it moved), stop unbends and releases", "[bass][seq]")
{
    Rig r(1);
    auto p = pattern(1);
    REQUIRE(p->addNote(1, 36, 0.0, 4.0, 1.0, false));
    p->hasBend = true;
    for (int t = 96; t < 192; ++t) // +7 st from beat 1 to beat 2, ramping, then back to 0
        p->bend[t] = 7.0f;
    r.engine.commands().push(Command::bassSetPattern(p.get()));
    r.engine.commands().push(Command::bassPlay());
    Rig::Rig1 one(r.engine);
    while (r.snap().samplesProcessed < 24000)
        one.step();
    REQUIRE(r.snap().bassBend == Approx(0.0));
    one.step(); // sample 24000 = tick 96
    REQUIRE(r.snap().bassBend == Approx(7.0));
    while (r.snap().samplesProcessed < 48001)
        one.step();
    REQUIRE(r.snap().bassBend == Approx(0.0)); // tick 192 posts the return to 0
    // the wheel owns the lane while recording: setBendLane(false) → no lane posts
    r.engine.commands().push(Command::bassBendLane(false));
    while (r.snap().samplesProcessed < 96000 + 24001)
        one.step();
    REQUIRE(r.snap().bassBend == Approx(0.0));
    r.engine.commands().push(Command::bassBendLane(true));
    r.engine.commands().push(Command::bassBend(3.0)); // the wheel now
    one.step();
    REQUIRE(r.snap().bassBend == Approx(3.0));
    REQUIRE(r.snap().bassVoices == 1);
    r.engine.commands().push(Command::bassStop());
    one.step();
    REQUIRE(r.snap().bassPlaying == 0);
    REQUIRE(r.snap().bassBend == Approx(0.0)); // a lane never leaves the synth bent
    REQUIRE(r.snap().bassTick == -1);
    // the voice releases (the release stage ends within ~0.12 s → silence)
    for (int i = 0; i < 48000; ++i)
        one.step();
    REQUIRE(r.snap().bassVoices == 0);
}

TEST_CASE("BassSequencer: a live pattern replace releases sounding notes whose pitch changed or whose off vanished",
          "[bass][seq]")
{
    Rig r(1);
    auto p = pattern(1);
    REQUIRE(p->addNote(1, 36, 0.0, 3.0, 1.0, false));
    REQUIRE(p->addNote(2, 43, 0.0, 3.0, 1.0, false));
    r.patch->voices = 4;
    r.engine.commands().push(Command::bassSetPatch(r.patch.get()));
    r.engine.commands().push(Command::bassSetPattern(p.get()));
    r.engine.commands().push(Command::bassPlay());
    auto onsets = r.onsetsUntil(12000);
    REQUIRE(onsets == std::vector<std::uint64_t>{0}); // both ons in the same sample
    REQUIRE(r.snap().bassNotesFired == 2);
    REQUIRE(r.snap().bassVoices == 2);
    // transpose note 1 up an octave, delete note 2 (the TS "+8va stuck note" case)
    auto q = pattern(1);
    REQUIRE(q->addNote(1, 48, 0.0, 3.0, 1.0, false));
    r.engine.commands().push(Command::bassSetPattern(q.get()));
    Rig::Rig1 one(r.engine);
    one.step(); // the replace lands: both sounding notes released (36 changed pitch, 43 has no off any more)
    for (int i = 0; i < 60000; ++i)
        one.step();
    REQUIRE(r.snap().bassVoices == 0);
    REQUIRE(r.snap().bassNotesFired == 2); // nothing retriggered mid-pass
    // the next pass plays the new map: one note, pitch 48, at the loop start
    auto nextOn = r.onsetsUntil(96001);
    REQUIRE(nextOn == std::vector<std::uint64_t>{96000});
    std::uint64_t mask[2];
    r.engine.bassSynth().activeNoteMask(mask);
    REQUIRE((mask[0] >> 48) == 1u);
}

TEST_CASE("BassSequencer: the arranger timeline fires at its absolute samples; the pattern stays quiet while it drives",
          "[bass][seq]")
{
    Rig r(1);
    auto p = pattern(1);
    REQUIRE(p->addNote(1, 36, 0.0, 0.5, 1.0, false));
    r.engine.commands().push(Command::bassSetPattern(p.get()));
    auto t = std::make_shared<BassTimeline>();
    REQUIRE(t->add(BassSynth::EventKind::on, 1000, 40, 1.0f, 0.0));
    REQUIRE(t->add(BassSynth::EventKind::off, 5000, 40, 0.0f, 0.0));
    REQUIRE(t->add(BassSynth::EventKind::on, 9000, 45, 1.0f, 0.0));
    REQUIRE(t->add(BassSynth::EventKind::bend, 9500, 0, 0.0f, 2.0));
    REQUIRE(t->add(BassSynth::EventKind::off, 12000, 45, 0.0f, 0.0));
    REQUIRE(t->count == 5);
    // sorted by sample whatever the insertion order
    REQUIRE(t->events[0].sample == 1000);
    REQUIRE(t->events[4].sample == 12000);
    r.engine.commands().push(Command::bassArrangerDriven(true));
    r.engine.commands().push(Command::bassSetTimeline(t.get()));
    r.engine.commands().push(Command::bassPlay());
    auto onsets = r.onsetsUntil(20000);
    REQUIRE(onsets == std::vector<std::uint64_t>{1000, 9000}); // no pattern note at 0 — the arranger drives
    REQUIRE(r.snap().bassTimelineFired == 5);
    REQUIRE(r.snap().bassBend == Approx(2.0));
    REQUIRE(r.snap().bassArrangerDriven == 1);
    r.engine.commands().push(Command::bassClearTimeline());
    Rig::Rig1 one(r.engine);
    one.step();
    REQUIRE(r.snap().bassBend == Approx(0.0)); // clearTimeline: release + bend 0
    r.engine.commands().push(Command::bassArrangerDriven(false));
    // the pattern plays again from the next loop start (the ticks kept counting)
    auto again = r.onsetsUntil(96001);
    REQUIRE(again == std::vector<std::uint64_t>{96000});
}

TEST_CASE("BassSequencer: a live note / slide / preview through the engine land at their sample; panic kills",
          "[bass][seq]")
{
    Rig r(1);
    r.engine.commands().push(Command::bassNote(true, 36, 1.0f, 0, 2));
    r.engine.commands().push(Command::bassNote(true, 43, 0.9f, 2000, 4)); // booked 2000 samples ahead
    auto onsets = r.onsetsUntil(3000);
    REQUIRE(onsets == std::vector<std::uint64_t>{0, 2000});
    r.engine.commands().push(Command::bassSlide(48, 0.1, 2500, 2)); // in the past → fires at once
    Rig::Rig1 one(r.engine);
    one.step();
    r.engine.commands().push(Command::bassMod(0.5));
    r.engine.commands().push(Command::bassClear(4, true)); // release (tag prev)
    one.step();
    r.engine.commands().push(Command::panic());
    one.step();
    REQUIRE(r.snap().bassVoices == 0);
    REQUIRE(r.snap().bassPlaying == 0);
}

TEST_CASE("BassSequencer: block-size invariance — the engine renders the bass bit-identically at 64 / 480 / 512",
          "[bass][seq]")
{
    auto make = [](int block)
    {
        auto r = std::make_unique<Rig>(block);
        r->patch->drift = 0.4; // the per-quantum randomness too
        r->patch->noiseLevel = 0.03;
        r->patch->mods[0] = {BassModSource::lfo1, BassModTarget::filterCutoff, 0.5};
        r->patch->numMods = 1;
        r->patch->voices = 2;
        r->engine.commands().push(Command::bassSetPatch(r->patch.get()));
        return r;
    };
    auto p = pattern(1);
    REQUIRE(p->addNote(1, 36, 0.0, 0.75, 1.0, false));
    REQUIRE(p->addNote(2, 43, 1.0, 0.5, 0.8, false));
    REQUIRE(p->addNote(3, 48, 1.5, 0.5, 0.8, true)); // a slide
    REQUIRE(p->addNote(4, 38, 2.0, 1.5, 1.0, false));
    p->hasBend = true;
    for (int t = 0; t < 384; ++t)
        p->bend[t] = static_cast<float>(std::sin(t / 60.0) * 1.5);
    const int total = 96000 * 2; // 2 bars at 120 BPM
    std::vector<std::vector<float>> outs;
    for (int block : {64, 480, 512})
    {
        auto r = make(block);
        r->engine.commands().push(Command::bassSetPattern(p.get()));
        r->engine.commands().push(Command::bassPlay());
        std::vector<float> out;
        int done = 0;
        while (done < total)
        {
            r->run();
            out.insert(out.end(), r->data[0].begin(), r->data[0].end());
            done += block;
        }
        out.resize(static_cast<std::size_t>(total));
        outs.push_back(std::move(out));
    }
    REQUIRE(rmsOf(outs[0], 10000, 20000) > 0.01);
    for (std::size_t i = 0; i < static_cast<std::size_t>(total); ++i)
    {
        REQUIRE(outs[0][i] == outs[1][i]);
        REQUIRE(outs[0][i] == outs[2][i]);
    }
}

TEST_CASE("BassSequencer: ten minutes at 120 BPM — every loop start exactly k × 192000, nothing drops, no allocation",
          "[bass][seq]")
{
    Rig r(480);
    auto p = pattern(2);
    for (int b = 0; b < 8; ++b)
        REQUIRE(p->addNote(b + 1, 36 + (b % 5), b, 0.5, 0.9, false));
    r.engine.commands().push(Command::bassSetPattern(p.get()));
    r.engine.commands().push(Command::bassPlay());
    const int blocks = 600 * 48000 / 480; // 10 minutes
    std::int64_t lastLoopStart = -1;
    int passes = 0;
    const auto allocs = test::allocationsDuring(
        [&]
        {
            for (int b = 0; b < blocks; ++b)
            {
                r.run();
                const auto ls = r.snap().bassLoopStartSample;
                if (ls != lastLoopStart)
                {
                    lastLoopStart = ls;
                    ++passes;
                }
            }
        });
    REQUIRE(allocs == 0);
    REQUIRE(passes == 150);
    REQUIRE(lastLoopStart == 149 * 192000);
    REQUIRE(r.snap().bassNotesFired == 150 * 8);
    REQUIRE(r.snap().bassEventsDropped == 0);
}
