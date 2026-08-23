// Arp (Phase 3.6) on the sample clock: holding a pad steps through the bank at the tempo, every step at its exact
// sample (the TS setTimeout arp jittered by ms); up / down / random (seeded, deterministic), the rate divisors, a
// tempo change at the next step with the phase kept, release stops it, MIDI on the direct path drives it, the
// one-owner rule sees its steps, block-size invariance, no allocation (test_rt_safety).
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "TestSamples.h"
#include "terminator/core/Arp.h"
#include "terminator/core/Engine.h"

using namespace terminator;
using Catch::Approx;

namespace
{
struct Hit
{
    std::uint64_t sample; // the block the hit was seen in (exact with 1-sample blocks)
    int pad;
};

struct Rig
{
    Engine engine;
    std::vector<std::vector<float>> data;
    std::vector<float*> ptrs;
    int block;
    double sr;
    std::uint64_t seenHits = 0;
    std::vector<Hit> hits;
    std::vector<std::shared_ptr<SampleBuffer>> keep;
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
        {
            const auto at = engine.snapshot().samplesProcessed;
            engine.process(ptrs.data(), 2, block);
            const auto& s = engine.snapshot();
            if (s.arpHits != seenHits)
            {
                seenHits = s.arpHits;
                hits.push_back({at, s.arpLastPad});
            }
        }
    }
    std::vector<float> capture(int blocks)
    {
        std::vector<float> out;
        for (int b = 0; b < blocks; ++b)
        {
            run();
            out.insert(out.end(), data[0].begin(), data[0].end());
        }
        return out;
    }
    /// Pads 0..n−1 play a DC of (p+1)·0.1, all in ONE mute group so each step cuts the last (3 ms fade).
    void bindPads(int n)
    {
        for (int pad = 0; pad < n; ++pad)
        {
            auto s = test::dc(static_cast<std::int64_t>(sr * 10.0), static_cast<float>(pad + 1) * 0.1f, sr);
            PadParams p;
            p.pad = static_cast<std::uint16_t>(pad);
            p.attackSec = 0.0f;
            p.interpolation = Interpolation::linear;
            p.chokeGroup = 5;
            engine.commands().push(Command::setPadParams(p));
            engine.commands().push(Command::setPadSample(static_cast<std::uint16_t>(pad), s.get()));
            keep.push_back(s);
        }
    }
};
} // namespace

TEST_CASE("arp: holding a pad steps UP through the bank every 60/bpm/rate, exactly on the sample; releasing the held "
          "pad stops it, releasing another pad does not",
          "[arp]")
{
    Rig r(1); // 1-sample blocks: the hit's sample is exact
    r.bindPads(8);
    r.engine.commands().push(Command::seqSetBpm(120.0));
    r.engine.commands().push(Command::setArp(true, 4, false, false, 8)); // 16ths at 120 = 6000 samples
    r.engine.commands().push(Command::arpHold(3, 0.9f, 1000));
    r.run(1000 + 6000 * 9 + 10);
    REQUIRE(r.hits.size() == 10);
    const int expect[] = {3, 4, 5, 6, 7, 0, 1, 2, 3, 4};
    for (std::size_t i = 0; i < 10; ++i)
    {
        CHECK(r.hits[i].sample == 1000 + i * 6000);
        CHECK(r.hits[i].pad == expect[i]);
    }
    CHECK(r.engine.snapshot().arpHoldPad == 3);
    CHECK(r.engine.snapshot().arpStep == 10);
    // another pad's release: nothing changes
    r.engine.commands().push(Command::arpRelease(5));
    r.run(6000);
    CHECK(r.hits.size() == 11);
    CHECK(r.engine.snapshot().arpHoldPad == 3);
    // the held pad's release: stops
    r.engine.commands().push(Command::arpRelease(3));
    r.run(20000);
    CHECK(r.hits.size() == 11);
    CHECK(r.engine.snapshot().arpHoldPad == -1);
    CHECK(r.engine.snapshot().arpStep == 0);
    CHECK(r.engine.snapshot().arpHits == 11);
    // the sampler really played them: the last DC heard is pad 5's (0.6) × the held velocity 0.9 — after its 3 ms
    // cut of pad 4
    std::vector<float> tail = r.capture(10);
    for (float x : tail)
        CHECK(x == Approx(0.54f).margin(1e-3f));
}

TEST_CASE("arp: DOWN walks backwards, RANDOM stays inside the bank and is deterministic, the rate divisors, padCount 0 "
          "= the whole grid, re-holding restarts from step 0",
          "[arp]")
{
    {
        Rig r(1);
        r.bindPads(8);
        r.engine.commands().push(Command::seqSetBpm(120.0));
        r.engine.commands().push(Command::setArp(true, 8, true, false, 8)); // 32nds = 3000 samples, DOWN
        r.engine.commands().push(Command::arpHold(2, 1.0f, 0));
        r.run(3000 * 6 + 5);
        REQUIRE(r.hits.size() == 7);
        const int expect[] = {2, 1, 0, 7, 6, 5, 4};
        for (std::size_t i = 0; i < 7; ++i)
        {
            CHECK(r.hits[i].sample == i * 3000);
            CHECK(r.hits[i].pad == expect[i]);
        }
        // re-hold pad 6: step 0 again from the new sample
        const auto at = r.engine.snapshot().samplesProcessed + 100;
        r.engine.commands().push(Command::arpHold(6, 1.0f, at));
        r.run(3000 + 200);
        REQUIRE(r.hits.size() == 9);
        CHECK(r.hits[7].sample == at);
        CHECK(r.hits[7].pad == 6);
        CHECK(r.hits[8].sample == at + 3000);
        CHECK(r.hits[8].pad == 5);
    }
    {
        // random: two fresh engines walk the same (seeded) sequence, always inside [0, padCount)
        std::vector<int> a, b;
        for (int k = 0; k < 2; ++k)
        {
            Rig r(64);
            r.bindPads(8);
            r.engine.commands().push(Command::seqSetBpm(240.0));
            r.engine.commands().push(Command::setArp(true, 4, false, true, 5));
            r.engine.commands().push(Command::arpHold(0, 1.0f, 0));
            r.run(3000 * 40 / 64);
            for (const auto& h : r.hits)
                (k == 0 ? a : b).push_back(h.pad);
        }
        REQUIRE(a.size() >= 30);
        REQUIRE(a == b);
        bool varied = false;
        for (int p : a)
        {
            CHECK(p >= 0);
            CHECK(p < 5);
            varied = varied || p != a[0];
        }
        CHECK(varied);
    }
    {
        // rate 1 = quarters (24000 at 120), rate 2 = 8ths; padCount 0 = the 64-pad grid
        Rig r(64);
        r.bindPads(4);
        r.engine.commands().push(Command::seqSetBpm(120.0));
        r.engine.commands().push(Command::setArp(true, 1, false, false, 0));
        r.engine.commands().push(Command::arpHold(62, 1.0f, 0));
        r.run(96000 / 64 + 1);
        REQUIRE(r.hits.size() == 5);
        const int expect[] = {62, 63, 0, 1, 2};
        for (std::size_t i = 0; i < 5; ++i)
        {
            CHECK(r.hits[i].sample == i * 24000);
            CHECK(r.hits[i].pad == expect[i]);
        }
        r.engine.commands().push(Command::setArp(true, 2, false, false, 0)); // 8ths from the next step
        r.run(96000 / 64);
        CHECK(r.hits.size() >= 12);
    }
}

TEST_CASE("arp: a tempo change lands at the NEXT step with the phase kept (no burst); arp off while held stops it; "
          "the arp-off hold is a plain hit",
          "[arp]")
{
    Rig r(1);
    r.bindPads(8);
    r.engine.commands().push(Command::seqSetBpm(120.0));
    r.engine.commands().push(Command::setArp(true, 4, false, false, 8));
    r.engine.commands().push(Command::arpHold(0, 1.0f, 0));
    r.run(6000 * 2 + 3000);                              // steps at 0, 6000, 12000; we are at 15000
    r.engine.commands().push(Command::seqSetBpm(240.0)); // 16ths = 3000 now
    r.run(20000);
    REQUIRE(r.hits.size() >= 6);
    CHECK(r.hits[2].sample == 12000);
    CHECK(r.hits[3].sample == 18000); // the step already computed at the old spacing (the phase is kept)
    CHECK(r.hits[4].sample == 21000); // then the new interval
    CHECK(r.hits[5].sample == 24000);
    // setArp off while held: stops
    r.engine.commands().push(Command::setArp(false, 4, false, false, 8));
    const auto n = r.hits.size();
    r.run(20000);
    CHECK(r.hits.size() == n);
    CHECK(r.engine.snapshot().arpHoldPad == -1);
    CHECK(r.engine.snapshot().arpEnabled == 0);
    // arp off: a hold is a plain trigger of that pad, once
    r.engine.commands().push(Command::arpHold(5, 1.0f, 0));
    r.run(30000);
    CHECK(r.hits.size() == n);
    CHECK(r.engine.snapshot().lastTriggeredPad == 5);
}

TEST_CASE("arp: a MIDI note on the direct path holds it and the note-off releases; its steps own the pattern's hits of "
          "that pad (one owner); block-size invariant renders",
          "[arp]")
{
    {
        Rig r(64);
        r.bindPads(8);
        r.engine.commands().push(Command::seqSetBpm(120.0));
        r.engine.commands().push(Command::setArp(true, 4, false, false, 8));
        MidiEvent on;
        on.data[0] = 0x90;
        on.data[1] = 36 + 2; // pad 2
        on.data[2] = 100;
        on.size = 3;
        r.engine.midiQueue(0).push(on);
        r.run(30000 / 64);
        REQUIRE(r.hits.size() == 5); // 0, 6000, 12000, 18000, 24000
        CHECK(r.hits[0].pad == 2);
        CHECK(r.hits[4].pad == 6);
        CHECK(r.engine.snapshot().arpHoldPad == 2);
        MidiEvent off = on;
        off.data[0] = 0x80;
        off.data[2] = 0;
        r.engine.midiQueue(0).push(off);
        r.run(30000 / 64);
        CHECK(r.hits.size() == 5);
        CHECK(r.engine.snapshot().arpHoldPad == -1);
    }
    {
        // one owner: a chop pattern hits pad 3 every step (16ths at 120 from 0); the arp (held at 0) fires pad 3 on
        // its 4th step (18000 = the pattern's step 3) → the pattern's copy is skipped
        Rig r(64);
        r.bindPads(8);
        auto p = std::make_shared<SeqPattern>();
        p->clear();
        p->bars = 1;
        p->resolution = 16;
        p->stepCount = 16;
        p->grid[3] |= (1ull << 3);
        r.engine.commands().push(Command::seqSetBpm(120.0));
        r.engine.commands().push(Command::seqSetPattern(p.get()));
        r.engine.commands().push(Command::setArp(true, 4, false, false, 8));
        r.engine.commands().push(Command::seqPlay(0));
        r.engine.commands().push(Command::arpHold(0, 1.0f, 0));
        r.run(30000 / 64);
        CHECK(r.engine.snapshot().seqHitsSkipped == 1);
        CHECK(r.engine.snapshot().seqHitsFired == 0);
    }
    {
        // block invariance: the same arp rendered in 37- and 512-sample blocks is bit-identical
        std::vector<float> a, b;
        for (const int block : {37, 512})
        {
            Rig r(block);
            r.bindPads(8);
            r.engine.commands().push(Command::seqSetBpm(150.0));
            r.engine.commands().push(Command::setArp(true, 4, false, false, 8));
            r.engine.commands().push(Command::arpHold(1, 0.8f, 700));
            auto out = r.capture(37 * 512 * 2 / block);
            (block == 37 ? a : b) = std::move(out);
        }
        REQUIRE(a.size() == b.size());
        for (std::size_t i = 0; i < a.size(); ++i)
            REQUIRE(a[i] == b[i]);
    }
}
