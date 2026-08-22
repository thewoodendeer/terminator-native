// Project planner (patternToEvents + source/choke identity over the ValueTree) — the parity assertions from
// scripts/chop-seq-standalone.test.mts and scripts/pad-reverse.test.mts, re-expressed on the model.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "terminator/model/ProjectModel.h"
#include "terminator/model/ProjectPlanner.h"

using namespace terminator;
using namespace terminator::model;
using Catch::Approx;

namespace
{
// A kit of two pad-source pads (kick on 0, snare on 1) with no main track, on a 1/16 grid.
juce::ValueTree twoPadKit()
{
    auto p = createEmptyProject();
    auto pads = p.getChildWithName(ids::Pads);
    auto srcs = p.getChildWithName(ids::PadSources);
    for (int i = 0; i < 2; ++i)
    {
        juce::ValueTree pad(ids::Pad);
        pad.setProperty(ids::index, i, nullptr);
        pad.setProperty(ids::pitch, 0, nullptr);
        pad.setProperty(ids::mode, "oneshot", nullptr);
        pads.appendChild(pad, nullptr);
        juce::ValueTree s(ids::PadSource);
        s.setProperty(ids::pad, i, nullptr);
        s.setProperty(ids::videoId, i == 0 ? "kick" : "snare", nullptr);
        s.setProperty(ids::title, i == 0 ? "kick" : "snare", nullptr);
        s.setProperty(ids::start, 0.0, nullptr);
        s.setProperty(ids::end, 1.0, nullptr);
        srcs.appendChild(s, nullptr);
    }
    // one sequence, 1 bar @ 1/16, kick on step 0, snare on step 4 and step 3
    auto seqs = p.getChildWithName(ids::Sequences);
    seqs.removeAllChildren(nullptr);
    juce::ValueTree seq(ids::Sequence);
    seq.setProperty(ids::bars, 1, nullptr);
    seq.setProperty(ids::resolution, 16, nullptr);
    seq.setProperty(ids::viewResolution, 16, nullptr);
    seq.setProperty(ids::loop, true, nullptr);
    juce::Array<juce::var> grid, vel;
    for (int s = 0; s < 16; ++s)
    {
        juce::Array<juce::var> row, vrow;
        if (s == 0)
        {
            row.add(0);
            vrow.add(1.0);
        }
        if (s == 4)
        {
            row.add(1);
            vrow.add(0.5);
        }
        if (s == 3)
        {
            row.add(1);
            vrow.add(1.0);
        }
        grid.add(juce::var(row));
        vel.add(juce::var(vrow));
    }
    seq.setProperty(ids::grid, juce::var(grid), nullptr);
    seq.setProperty(ids::velGrid, juce::var(vel), nullptr);
    seq.setProperty(ids::revGrid, juce::var(juce::Array<juce::var>()), nullptr);
    seqs.appendChild(seq, nullptr);
    p.setProperty(ids::currentSeqIdx, 0, nullptr);
    p.setProperty(ids::metronomeBpm, 120, nullptr);
    return p;
}
} // namespace

TEST_CASE("planner: patternToEvents carries velocity, swing pushes odd 16ths, tail = next same-group hit", "[planner]")
{
    auto p = twoPadKit();
    ProjectPlanner pl(p);
    CHECK(pl.padSourceKey(0) == "src:kick");
    CHECK(pl.padSourceKey(1) == "src:snare");
    CHECK(pl.chokeGroupOf(0) == "src:kick"); // default = source identity
    CHECK(pl.seqTailGroup(0) == "src:kick");

    auto seq = pl.currentSequence();
    auto evs = pl.patternToEvents(seq);
    // kick@0, snare@3, snare@4
    REQUIRE(evs.size() == 3);
    const double stepDur = (60.0 / 120.0) * (4.0 / 16.0);
    auto find = [&](int pad, int step)
    {
        for (auto& e : evs)
            if (e.pad == pad && std::abs(e.time - step * stepDur) < stepDur * 0.6)
                return &e;
        return (SeqEvent*)nullptr;
    };
    CHECK(find(0, 0)->velocity == 1.0f);
    CHECK(find(1, 4)->velocity == 0.5f);
    CHECK(find(1, 3)->velocity == 1.0f);
    CHECK(find(0, 0)->time == Approx(0.0));
    // snare@3 ends at snare@4 (next same-group hit): maxDur == one step
    CHECK(find(1, 3)->maxDur == Approx(stepDur));
    // kick@0 has no later kick → tail runs to the pattern end (16 steps)
    CHECK(find(0, 0)->maxDur == Approx(16 * stepDur));

    // swing: odd 16th (step 3) goes late, the downbeat (step 0) does not
    pl.setSeqSwing(0.6);
    auto sw = pl.patternToEvents(seq);
    auto at = [&](int pad, int step)
    {
        for (auto& e : sw)
            if (e.pad == pad && std::abs(e.time - step * stepDur) < stepDur * 0.9)
                return e.time;
        return -1.0;
    };
    CHECK(at(0, 0) == Approx(0.0));
    CHECK(at(1, 3) > 3 * stepDur + 0.005);
}

TEST_CASE("planner: reversedFor - per-pad override beats source; source REV moves un-overridden pads", "[planner]")
{
    auto p = twoPadKit();
    // give the two pads a shared source so a source REV can move both
    for (auto s : p.getChildWithName(ids::PadSources))
        s.setProperty(ids::videoId, "song", nullptr);
    ProjectPlanner pl(p);
    CHECK(pl.padSourceKey(0) == "src:song");
    CHECK(!pl.reversedFor(0));
    // per-pad override on pad 1
    p.getChildWithName(ids::Pads).getChild(1).setProperty(ids::reverse, true, nullptr);
    CHECK(pl.reversedFor(1));
    CHECK(!pl.reversedFor(0));
    // source REV via sourceFx: moves pad 0 (no override), leaves pad 1's explicit override
    auto sfx = p.getChildWithName(ids::SourceFx);
    juce::ValueTree fx(ids::Fx);
    fx.setProperty(ids::key, "src:song", nullptr);
    fx.setProperty(ids::reverse, true, nullptr);
    sfx.appendChild(fx, nullptr);
    CHECK(pl.reversedFor(0));
    CHECK(pl.reversedFor(1));
    // an explicit forward override against a reversed source
    p.getChildWithName(ids::Pads).getChild(1).setProperty(ids::reverse, false, nullptr);
    CHECK(!pl.reversedFor(1));

    // patternToEvents carries the per-pad reverse
    auto evs = pl.patternToEvents(pl.currentSequence());
    for (auto& e : evs)
        if (e.pad == 1)
            CHECK(!e.reverse);
        else
            CHECK(e.reverse);
}

TEST_CASE("planner: a 'none' choke pad still ends at its OWN next hit (pad:i tail group)", "[planner]")
{
    auto p = twoPadKit();
    // make pad 1 polyphonic
    mapSet(p.getChildWithName(ids::PadChoke), 1, "none", nullptr);
    ProjectPlanner pl(p);
    CHECK(pl.chokeGroupOf(1) == "none");
    CHECK(pl.seqTailGroup(1) == "pad:1");
    // snare@3 still ends at snare@4 (its own next hit), not at the pattern end
    auto evs = pl.patternToEvents(pl.currentSequence());
    const double stepDur = (60.0 / 120.0) * (4.0 / 16.0);
    for (auto& e : evs)
        if (e.pad == 1 && std::abs(e.time - 3 * stepDur) < stepDur * 0.6)
            CHECK(e.maxDur == Approx(stepDur));
}
