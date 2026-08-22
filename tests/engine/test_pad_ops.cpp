// Pad / chop planners on the Document (ChopperEngine parity): movePad, clearPad/clearBlock, unassign/assign/
// clone/revive, chopPadSource family, autoSliceTransients, trims (addTrim/restoreTrims), and the pad clipboard.
// Every mutation is ONE undo step; undo returns the tree to byte-identical JSON.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "terminator/core/planners/PadClipboard.h"
#include "terminator/model/Document.h"
#include "terminator/model/ProjectModel.h"

using namespace terminator;
using namespace terminator::model;
using Catch::Approx;

namespace
{
juce::String J(Document& d)
{
    return projectToJsonText(d.tree());
}
juce::ValueTree addPad(Document& d, int i, double pitch = 0.0)
{
    juce::ValueTree p(ids::Pad);
    p.setProperty(ids::index, i, nullptr);
    p.setProperty(ids::pitch, pitch, nullptr);
    p.setProperty(ids::mode, "oneshot", nullptr);
    d.pads().appendChild(p, nullptr);
    return p;
}
int addChopOn(Document& d, int pad, double s, double e, bool free = false)
{
    const int id = static_cast<int>(d.tree()[ids::nextChopId]);
    juce::ValueTree c(ids::Chop);
    c.setProperty(ids::id, id, nullptr);
    c.setProperty(ids::start, s, nullptr);
    c.setProperty(ids::end, e, nullptr);
    if (free)
        c.setProperty(ids::free, true, nullptr);
    d.chops().appendChild(c, nullptr);
    d.tree().setProperty(ids::nextChopId, id + 1, nullptr);
    auto p = d.padOf(pad);
    if (!p.isValid())
        p = addPad(d, pad);
    p.setProperty(ids::chopId, id, nullptr);
    return id;
}
void addSourceOn(Document& d, int pad, const char* vid, double s, double e, double pitch = 0.0)
{
    if (!d.padOf(pad).isValid())
        addPad(d, pad, pitch);
    juce::ValueTree so(ids::PadSource);
    so.setProperty(ids::pad, pad, nullptr);
    so.setProperty(ids::videoId, vid, nullptr);
    so.setProperty(ids::title, juce::String(vid) + " title", nullptr);
    so.setProperty(ids::start, s, nullptr);
    so.setProperty(ids::end, e, nullptr);
    d.padSources().appendChild(so, nullptr);
}
void setGrid(Document& d, std::vector<std::vector<int>> rows)
{
    juce::Array<juce::var> g;
    for (auto& r : rows)
    {
        juce::Array<juce::var> row;
        for (int x : r)
            row.add(x);
        g.add(juce::var(row));
    }
    d.tree().getChildWithName(ids::Sequences).getChild(0).setProperty(ids::grid, juce::var(g), nullptr);
}
std::vector<std::vector<int>> grid(Document& d)
{
    std::vector<std::vector<int>> out;
    auto g = d.tree().getChildWithName(ids::Sequences).getChild(0)[ids::grid];
    if (auto* rows = g.getArray())
        for (auto& r : *rows)
        {
            std::vector<int> row;
            if (auto* cells = r.getArray())
                for (auto& c : *cells)
                    row.push_back(static_cast<int>(c));
            out.push_back(row);
        }
    return out;
}
int chopOf(Document& d, int pad)
{
    auto p = d.padOf(pad);
    return p.isValid() && p.hasProperty(ids::chopId) ? static_cast<int>(p[ids::chopId]) : -1;
}
double srcStart(Document& d, int pad)
{
    return static_cast<double>(d.padSourceOf(pad)[ids::start]);
}
double srcEnd(Document& d, int pad)
{
    return static_cast<double>(d.padSourceOf(pad)[ids::end]);
}
juce::ValueTree mapNode(Document& d, const juce::Identifier& which)
{
    return d.tree().getChildWithName(which);
}
} // namespace

// ── movePad ───────────────────────────────────────────────────────────────────────────────────────
TEST_CASE("pad-ops: movePad swaps two pads' full content, routes+chokes follow, groups stay, steps remap",
          "[pad-ops][move]")
{
    Document doc;
    const int c1 = addChopOn(doc, 0, 0.0, 1.0);
    auto p0 = doc.padOf(0);
    p0.setProperty(ids::pitch, 2, nullptr);
    p0.setProperty(ids::stems, 3, nullptr);
    p0.setProperty(ids::reverse, true, nullptr);
    p0.setProperty(ids::gate, true, nullptr);
    addSourceOn(doc, 1, "kick", 0.0, 1.0, -1.0);
    mapSet(mapNode(doc, ids::PadRoutes), 0, "sample2", nullptr);
    mapSet(mapNode(doc, ids::PadChoke), 1, "none", nullptr);
    mapSet(mapNode(doc, ids::PadGroups), 0, "grp:2", nullptr);
    setGrid(doc, {{0}, {1}, {0, 1}});
    const auto before = J(doc);

    REQUIRE(doc.movePad(0, 1));
    // pad 1 now holds the chop with every play prop; pad 0 holds the kick
    CHECK(chopOf(doc, 1) == c1);
    CHECK(static_cast<int>(doc.padOf(1)[ids::pitch]) == 2);
    CHECK(static_cast<int>(doc.padOf(1)[ids::stems]) == 3);
    CHECK(static_cast<bool>(doc.padOf(1)[ids::reverse]) == true);
    CHECK(static_cast<bool>(doc.padOf(1)[ids::gate]) == true);
    CHECK(!doc.padSourceOf(1).isValid());
    CHECK(doc.padSourceOf(0)[ids::videoId].toString() == "kick");
    CHECK(chopOf(doc, 0) == -1);
    CHECK(static_cast<double>(doc.padOf(0)[ids::pitch]) == Approx(-1.0));
    CHECK(!doc.padOf(0).hasProperty(ids::stems));
    CHECK(!doc.padOf(0).hasProperty(ids::reverse));
    // index-keyed overrides: route + choke follow their pads, the group override is pinned (TS parity)
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 1).toString() == "sample2");
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 0).isVoid());
    CHECK(mapGet(mapNode(doc, ids::PadChoke), 0).toString() == "none");
    CHECK(mapGet(mapNode(doc, ids::PadChoke), 1).isVoid());
    CHECK(mapGet(mapNode(doc, ids::PadGroups), 0).toString() == "grp:2");
    CHECK(mapGet(mapNode(doc, ids::PadGroups), 1).isVoid());
    CHECK(grid(doc) == std::vector<std::vector<int>>{{1}, {0}, {1, 0}});
    const auto after = J(doc);
    // one undo step, byte-identical
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
    REQUIRE(doc.redo());
    CHECK(J(doc) == after);
}

TEST_CASE("pad-ops: movePad onto an empty pad vacates the source (play settings stay behind), steps follow",
          "[pad-ops][move]")
{
    Document doc;
    const int c1 = addChopOn(doc, 0, 0.0, 1.0);
    doc.padOf(0).setProperty(ids::pitch, 2, nullptr);
    setGrid(doc, {{0}, {3}});
    const auto before = J(doc);
    CHECK(!doc.movePad(0, 0));
    REQUIRE(doc.movePad(0, 3));
    CHECK(chopOf(doc, 3) == c1);
    CHECK(static_cast<int>(doc.padOf(3)[ids::pitch]) == 2);
    CHECK(chopOf(doc, 0) == -1);
    CHECK(static_cast<int>(doc.padOf(0)[ids::pitch]) == 2);      // the TS leaves pitch/mode/gate/fades on the slot
    CHECK(doc.padOf(1).isValid());                               // dense pads like ensurePad
    CHECK(grid(doc) == std::vector<std::vector<int>>{{3}, {3}}); // steps on the empty dest pad are kept
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
}

// ── clearPad / clearBlock ─────────────────────────────────────────────────────────────────────────
TEST_CASE("pad-ops: clearPad merge rules - previous absorbs, first extends next back, free goes alone, shared "
          "keeps the chop",
          "[pad-ops][clear]")
{
    Document doc;
    const int c1 = addChopOn(doc, 0, 0.0, 1.0);
    const int c2 = addChopOn(doc, 1, 1.0, 2.0);
    const int c3 = addChopOn(doc, 2, 2.0, 3.0);
    mapSet(mapNode(doc, ids::PadRoutes), 1, "sample3", nullptr);

    doc.clearPad(1); // middle: previous absorbs its end
    CHECK(chopOf(doc, 1) == -1);
    CHECK(!doc.chopById(c2).isValid());
    CHECK(static_cast<double>(doc.chopById(c1)[ids::end]) == Approx(2.0));
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 1).isVoid());

    doc.clearPad(0); // first chop: its successor extends back
    CHECK(!doc.chopById(c1).isValid());
    CHECK(static_cast<double>(doc.chopById(c3)[ids::start]) == Approx(0.0));

    const int c4 = addChopOn(doc, 3, 0.5, 0.7, true); // a free chop (duplicate clone)
    doc.history().clear();
    const auto s3 = J(doc);
    doc.clearPad(3);
    CHECK(!doc.chopById(c4).isValid());
    CHECK(static_cast<double>(doc.chopById(c3)[ids::start]) == Approx(0.0)); // no merge into c3
    CHECK(static_cast<double>(doc.chopById(c3)[ids::end]) == Approx(3.0));
    REQUIRE(doc.undo());
    CHECK(J(doc) == s3);

    // shared: pads 4 and 5 both reference c3 → clearing 4 only empties that slot
    addPad(doc, 4).setProperty(ids::chopId, c3, nullptr);
    addPad(doc, 5).setProperty(ids::chopId, c3, nullptr);
    doc.clearPad(4);
    CHECK(chopOf(doc, 4) == -1);
    CHECK(chopOf(doc, 5) == c3);
    CHECK(doc.chopById(c3).isValid());
    CHECK(chopOf(doc, 2) == c3);
}

TEST_CASE("pad-ops: clearPad on a pad-source pad drops the source, stems, route/choke and unused SourceStems",
          "[pad-ops][clear]")
{
    Document doc;
    addSourceOn(doc, 6, "kick", 0.0, 1.0);
    addSourceOn(doc, 7, "snare", 0.0, 1.0);
    doc.padOf(6).setProperty(ids::stems, 5, nullptr);
    mapSet(mapNode(doc, ids::PadChoke), 6, "g", nullptr);
    mapSet(mapNode(doc, ids::PadRoutes), 6, "sample2", nullptr);
    auto ss = mapNode(doc, ids::SourceStems);
    for (const char* v : {"kick", "snare"})
    {
        juce::ValueTree n(ids::SourceStem);
        n.setProperty(ids::videoId, v, nullptr);
        n.setProperty(ids::quality, "fast", nullptr);
        ss.appendChild(n, nullptr);
    }
    const auto before = J(doc);
    doc.clearPad(6);
    CHECK(!doc.padSourceOf(6).isValid());
    CHECK(!doc.padOf(6).hasProperty(ids::stems));
    CHECK(mapGet(mapNode(doc, ids::PadChoke), 6).isVoid());
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 6).isVoid());
    CHECK(ss.getNumChildren() == 1);
    CHECK(ss.getChild(0)[ids::videoId].toString() == "snare");
    CHECK(doc.padSourceOf(7).isValid());
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
}

TEST_CASE("pad-ops: clearBlock clears the whole run hi->lo as ONE undo step", "[pad-ops][clear]")
{
    Document doc;
    addChopOn(doc, 0, 0.0, 1.0);
    addChopOn(doc, 1, 1.0, 2.0);
    addChopOn(doc, 2, 2.0, 3.0);
    addSourceOn(doc, 3, "kick", 0.0, 1.0);
    const auto before = J(doc);
    doc.clearBlock(1);
    CHECK(doc.chops().getNumChildren() == 0);
    CHECK(chopOf(doc, 0) == -1);
    CHECK(chopOf(doc, 2) == -1);
    CHECK(doc.padSourceOf(3).isValid()); // the kick is another block
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
    CHECK(!doc.canUndo());
}

// ── unassign / assign / clone / revive ───────────────────────────────────────────────────────────
TEST_CASE("pad-ops: unassignPad keeps the chop, assignChopToPad allocates dense pads, cloneChop/reviveChop are free",
          "[pad-ops][assign]")
{
    Document doc;
    const int c1 = addChopOn(doc, 0, 0.0, 1.0);
    mapSet(mapNode(doc, ids::PadRoutes), 0, "sample2", nullptr);
    doc.unassignPad(0);
    CHECK(chopOf(doc, 0) == -1);
    CHECK(doc.chopById(c1).isValid());
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 0).isVoid());
    doc.assignChopToPad(5, c1);
    CHECK(chopOf(doc, 5) == c1);
    CHECK(doc.pads().getNumChildren() == 6); // pads 0..5 exist
    const int c2 = doc.cloneChop(c1);
    CHECK(c2 == c1 + 1);
    CHECK(static_cast<bool>(doc.chopById(c2)[ids::free]) == true);
    CHECK(static_cast<double>(doc.chopById(c2)[ids::end]) == Approx(1.0));
    CHECK(doc.cloneChop(99) == 99); // unknown id returned unchanged
    CHECK(doc.reviveChop(c1, 0.0, 1.0) == c1);
    const int c3 = doc.reviveChop(42, 0.2, 0.4);
    CHECK(c3 == c2 + 1);
    CHECK(static_cast<bool>(doc.chopById(c3)[ids::free]) == true);
    CHECK(static_cast<double>(doc.chopById(c3)[ids::start]) == Approx(0.2));
    CHECK(static_cast<int>(doc.tree()[ids::nextChopId]) == c3 + 1);
    CHECK(doc.hasPadContent(5));
    CHECK(!doc.hasPadContent(0));
}

// ── chopPadSource family ─────────────────────────────────────────────────────────────────────────
TEST_CASE("pad-ops: chopPadSource cuts into the room after the block - the pad keeps the first piece, pieces "
          "inherit group + stems, neighbours are never pushed",
          "[pad-ops][chop-source]")
{
    Document doc;
    addSourceOn(doc, 0, "A", 0.0, 4.0);
    doc.padOf(0).setProperty(ids::stems, 3, nullptr);
    mapSet(mapNode(doc, ids::PadGroups), 0, "grp:2", nullptr);
    addSourceOn(doc, 4, "B", 0.0, 1.0);
    mapSet(mapNode(doc, ids::PadRoutes), 4, "sample4", nullptr);
    setGrid(doc, {{4}, {0}});
    const auto before = J(doc);
    const auto room = doc.roomAfterBlock(0);
    CHECK(room.at == 1);
    CHECK(room.free == 3);

    // duplicates dedupe, cuts within 10 ms of an edge are ignored
    CHECK(doc.chopPadSource(0, {1.0, 2.0, 2.0, 3.0, 0.005, 3.995}) == 3);
    CHECK(srcStart(doc, 0) == Approx(0.0));
    CHECK(srcEnd(doc, 0) == Approx(1.0));
    for (int i = 1; i <= 3; ++i)
    {
        CHECK(doc.padSourceOf(i)[ids::videoId].toString() == "A");
        CHECK(srcStart(doc, i) == Approx(static_cast<double>(i)));
        CHECK(srcEnd(doc, i) == Approx(static_cast<double>(i + 1)));
        CHECK(static_cast<int>(doc.padOf(i)[ids::stems]) == 3);
        CHECK(mapGet(mapNode(doc, ids::PadGroups), i).toString() == "grp:2");
    }
    CHECK(doc.padSourceOf(4)[ids::videoId].toString() == "B"); // not pushed
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 4).toString() == "sample4");
    CHECK(grid(doc) == std::vector<std::vector<int>>{{4}, {0}});
    const auto after = J(doc);
    // no room left after the (now 4-wide) block → -1 and nothing changes
    CHECK(doc.chopPadSource(3, {3.5}) == -1);
    CHECK(J(doc) == after);
    CHECK(doc.chopPadSource(0, {0.002}) == 0); // nothing to cut
    CHECK(doc.chopPadSource(9, {0.5}) == 0);   // not a pad source
    // padSourceChops = every piece of A by start
    const auto pieces = doc.padSourceChops(2);
    REQUIRE(pieces.size() == 4);
    CHECK(pieces[0].pad == 0);
    CHECK(pieces[3].pad == 3);
    CHECK(pieces[3].start == Approx(3.0));
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
    REQUIRE(doc.redo());
    CHECK(J(doc) == after);
}

TEST_CASE("pad-ops: chopPadSourceTo puts the tail on the aimed pad and pushes its occupant (the chop-while-playing "
          "gate A: the split lands at the playhead, no main chop is resurrected)",
          "[pad-ops][chop-source]")
{
    Document doc;
    addSourceOn(doc, 0, "A", 0.0, 3.0);
    addSourceOn(doc, 1, "B", 0.0, 1.0);
    mapSet(mapNode(doc, ids::PadRoutes), 1, "sample3", nullptr);
    setGrid(doc, {{1}});
    const auto before = J(doc);
    CHECK(!doc.chopPadSourceTo(0, 0.005, 1)); // too close to the start
    CHECK(!doc.chopPadSourceTo(0, 2.995, 1)); // too close to the end
    REQUIRE(doc.chopPadSourceTo(0, 1.5, 1));
    CHECK(srcEnd(doc, 0) == Approx(1.5));
    CHECK(doc.padSourceOf(1)[ids::videoId].toString() == "A");
    CHECK(srcStart(doc, 1) == Approx(1.5));
    CHECK(srcEnd(doc, 1) == Approx(3.0));
    CHECK(doc.padSourceOf(2)[ids::videoId].toString() == "B"); // pushed one to the right
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 2).toString() == "sample3");
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 1).isVoid());
    CHECK(grid(doc) == std::vector<std::vector<int>>{{2}}); // the step followed B
    CHECK(doc.chops().getNumChildren() == 0);               // the main track stays empty
    CHECK(srcEnd(doc, 0) == Approx(srcStart(doc, 1)));
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
}

TEST_CASE("pad-ops: autoChopPadSource equal pieces; at transients takes as many as fit", "[pad-ops][chop-source]")
{
    Document doc;
    addSourceOn(doc, 0, "A", 0.0, 4.0);
    addSourceOn(doc, 4, "B", 0.0, 1.0);
    const auto before = J(doc);
    CHECK(doc.autoChopPadSource(0, 4) == 3);
    CHECK(srcEnd(doc, 0) == Approx(1.0));
    CHECK(srcStart(doc, 3) == Approx(3.0));
    CHECK(doc.autoChopPadSource(0, 1) == 0); // nothing to cut
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
    // transients: 5 onsets inside, room for 3 → the first 3 from the start
    CHECK(doc.autoChopPadSourceAtTransients(0, {0.5, 1.5, 2.5, 3.5, 3.9}) == 3);
    CHECK(srcEnd(doc, 0) == Approx(0.5));
    CHECK(srcStart(doc, 1) == Approx(0.5));
    CHECK(srcStart(doc, 3) == Approx(2.5));
    CHECK(srcEnd(doc, 3) == Approx(4.0));
    CHECK(doc.autoChopPadSourceAtTransients(3, {3.0}) == -1); // no room at all
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
}

// ── autoSliceTransients ──────────────────────────────────────────────────────────────────────────
TEST_CASE("pad-ops: autoSliceTransients picks the strongest round(N*sens^0.7) onsets, skips slivers, carries stems, "
          "truncates pads, coalesces knob drags",
          "[pad-ops][auto-slice]")
{
    Document doc;
    Document::Analysis a;
    a.bufferDurationSec = 4.0;
    a.transients = {0.5f, 1.0f, 1.5f, 2.0f, 2.5f, 3.0f, 3.5f, 3.995f};
    a.transientStrengths = {0.1f, 0.9f, 0.2f, 0.8f, 0.3f, 0.7f, 0.4f, 0.5f};
    doc.setAnalysis(a);
    const int c1 = addChopOn(doc, 0, 0.0, 2.0);
    addChopOn(doc, 1, 2.0, 4.0);
    doc.padOf(0).setProperty(ids::stems, 3, nullptr);
    for (int i = 2; i < 10; ++i)
        addPad(doc, i);
    (void)c1;
    double clock = 1000.0;
    doc.history().nowMs = [&clock] { return clock; };
    const auto before = J(doc);

    doc.autoSliceTransients(1.0); // every onset → 8 pieces (the [3.995, 4) sliver is skipped)
    CHECK(doc.chops().getNumChildren() == 8);
    CHECK(doc.pads().getNumChildren() == 8); // pads truncated to n
    clock += 100;
    doc.autoSliceTransients(0.5); // round(8 * 0.5^0.7) = round(4.92) = 5 strongest: 1.0 2.0 3.0 3.995 3.5
    CHECK(doc.transientSensitivity() == Approx(0.5));
    REQUIRE(doc.chops().getNumChildren() == 5);
    const double expStart[] = {0.0, 1.0, 2.0, 3.0, 3.5};
    const double expEnd[] = {1.0, 2.0, 3.0, 3.5, 3.995};
    for (int i = 0; i < 5; ++i)
    {
        auto c = doc.chops().getChild(i);
        CHECK(static_cast<double>(c[ids::start]) == Approx(expStart[i]));
        CHECK(static_cast<double>(c[ids::end]) == Approx(expEnd[i]));
        CHECK(chopOf(doc, i) == static_cast<int>(c[ids::id]));
    }
    CHECK(doc.pads().getNumChildren() == 5);
    // stems carry over from the old chop each new one starts in: c1 [0,2) had 3
    CHECK(static_cast<int>(doc.padOf(0)[ids::stems]) == 3);
    CHECK(static_cast<int>(doc.padOf(1)[ids::stems]) == 3);
    CHECK(!doc.padOf(2).hasProperty(ids::stems));
    CHECK(!doc.padOf(4).hasProperty(ids::stems));
    // the two knob calls within 500 ms are ONE step
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
    CHECK(!doc.canUndo());
    // clamp + the N == 0 fallback → autoChop(1)
    doc.autoSliceTransients(2.0);
    CHECK(doc.transientSensitivity() == Approx(1.0));
    Document::Analysis none;
    none.bufferDurationSec = 4.0;
    doc.setAnalysis(none);
    clock += 1000;
    doc.autoSliceTransients();
    CHECK(doc.chops().getNumChildren() == 1);
    CHECK(static_cast<double>(doc.chops().getChild(0)[ids::end]) == Approx(4.0));
}

// ── trims ────────────────────────────────────────────────────────────────────────────────────────
namespace
{
void fillTrimDoc(Document& doc)
{
    Document::Analysis a;
    a.bufferDurationSec = 10.0;
    a.transients = {1.f, 3.f, 5.f, 7.f, 9.f};
    a.transientStrengths = {.1f, .2f, .3f, .4f, .5f};
    a.broadbandTransients = a.transients;
    a.broadbandStrengths = a.transientStrengths;
    a.drumTransients = {2.5f, 7.5f};
    a.drumStrengths = {.6f, .7f};
    doc.setAnalysis(a);
    for (int i = 0; i < 5; ++i)
        addChopOn(doc, i, 2.0 * i, 2.0 * i + 2.0); // ids 1..5 on pads 0..4
    doc.padOf(0).setProperty(ids::stems, 3, nullptr);
    mapSet(doc.tree().getChildWithName(ids::PadRoutes), 2, "sample2", nullptr);
}
} // namespace

TEST_CASE("pad-ops: addTrim slides, clips and swallows chops; swallowed ride the trim with pad + stems; transients "
          "cut on every detector; Trims node serialises",
          "[pad-ops][trims]")
{
    Document doc;
    fillTrimDoc(doc);
    const auto before = J(doc);
    CHECK(!doc.addTrim(1.0, 1.01)); // < 20 ms
    CHECK(!doc.addTrim(0.0, 9.99)); // never the whole sample
    CHECK(J(doc) == before);
    REQUIRE(doc.addTrim(7.0, 3.0)); // order-agnostic
    // chops: 1 [0,2) kept; 2 [2,4) clipped to [2,3); 3 swallowed; 4 [6,8) clipped to [3,4); 5 slid to [4,6)
    REQUIRE(doc.chops().getNumChildren() == 4);
    CHECK(static_cast<double>(doc.chopById(1)[ids::end]) == Approx(2.0));
    CHECK(static_cast<double>(doc.chopById(2)[ids::start]) == Approx(2.0));
    CHECK(static_cast<double>(doc.chopById(2)[ids::end]) == Approx(3.0));
    CHECK(!doc.chopById(3).isValid());
    CHECK(static_cast<double>(doc.chopById(4)[ids::start]) == Approx(3.0));
    CHECK(static_cast<double>(doc.chopById(4)[ids::end]) == Approx(4.0));
    CHECK(static_cast<double>(doc.chopById(5)[ids::start]) == Approx(4.0));
    CHECK(static_cast<double>(doc.chopById(5)[ids::end]) == Approx(6.0));
    // the swallowed chop's pad is emptied (route forgotten), other pads keep theirs
    CHECK(chopOf(doc, 2) == -1);
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 2).isVoid());
    CHECK(chopOf(doc, 1) == 2);
    CHECK(static_cast<int>(doc.padOf(0)[ids::stems]) == 3);
    // the trim list: one region [3,7] FILE time, with the three chop pieces by start
    const auto tl = doc.trimList();
    REQUIRE(tl.size() == 1);
    CHECK(tl[0].startSec == Approx(3.0));
    CHECK(tl[0].endSec == Approx(7.0));
    REQUIRE(tl[0].chops.size() == 3);
    CHECK(tl[0].chops[0].id == 2);
    CHECK(tl[0].chops[0].startSec == Approx(3.0));
    CHECK(tl[0].chops[0].endSec == Approx(4.0));
    CHECK(tl[0].chops[0].padIdx == 1);
    CHECK(tl[0].chops[0].stems == -1);
    CHECK(tl[0].chops[1].id == 3);
    CHECK(tl[0].chops[1].startSec == Approx(4.0));
    CHECK(tl[0].chops[1].endSec == Approx(6.0));
    CHECK(tl[0].chops[1].padIdx == 2);
    CHECK(tl[0].chops[2].id == 4);
    CHECK(tl[0].chops[2].startSec == Approx(6.0));
    CHECK(tl[0].chops[2].endSec == Approx(7.0));
    CHECK(tl[0].chops[2].padIdx == 3);
    // time maps + duration
    CHECK(doc.effToFile(3.5) == Approx(7.5));
    CHECK(doc.effToFile(3.0, true) == Approx(3.0));
    CHECK(doc.effToFile(3.0) == Approx(7.0));
    CHECK(doc.fileToEff(8.0) == Approx(4.0));
    CHECK(doc.analysis().bufferDurationSec == Approx(6.0));
    CHECK(trims::effectiveDurationSec(10.0, tl) == Approx(6.0));
    // transients: 3 and 5 dropped, 7→3, 9→5, on the active AND the broadband/drum arrays
    CHECK(doc.analysis().transients == std::vector<float>{1.f, 3.f, 5.f});
    CHECK(doc.analysis().transientStrengths == std::vector<float>{.1f, .4f, .5f});
    CHECK(doc.analysis().broadbandTransients == std::vector<float>{1.f, 3.f, 5.f});
    CHECK(doc.analysis().drumTransients == std::vector<float>{2.5f, 3.5f});
    CHECK(doc.analysis().drumStrengths == std::vector<float>{.6f, .7f});
    // the JSON carries trims[] in the Electron shape
    auto json = doc.toJson();
    auto trimsArr = json[juce::Identifier("trims")];
    REQUIRE(trimsArr.isArray());
    REQUIRE(trimsArr.size() == 1);
    CHECK(static_cast<double>(trimsArr[0][juce::Identifier("startSec")]) == Approx(3.0));
    CHECK(trimsArr[0][juce::Identifier("chops")].size() == 3);
    CHECK(static_cast<int>(trimsArr[0][juce::Identifier("chops")][1][juce::Identifier("padIdx")]) == 2);
    // a second, overlapping cut merges into one region
    REQUIRE(doc.addTrim(2.5, 3.5));
    CHECK(doc.trimList().size() == 1);
    CHECK(doc.trimList()[0].startSec == Approx(2.5));
    CHECK(doc.trimList()[0].endSec == Approx(7.5));
    // both are single steps
    REQUIRE(doc.undo());
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
    CHECK(!doc.canUndo());
}

TEST_CASE("pad-ops: restoreTrims brings swallowed chops back on their old pad when still empty (else the next "
          "main slot), grows clipped survivors, sorts by start",
          "[pad-ops][trims]")
{
    Document doc;
    fillTrimDoc(doc);
    const auto original = J(doc);
    CHECK(!doc.restoreTrims()); // nothing to restore
    REQUIRE(doc.addTrim(3.0, 7.0));
    const auto trimmed = J(doc);
    REQUIRE(doc.restoreTrims());
    REQUIRE(doc.chops().getNumChildren() == 5);
    for (int i = 0; i < 5; ++i)
    {
        auto c = doc.chops().getChild(i);
        CHECK(static_cast<int>(c[ids::id]) == i + 1); // sorted by start = original order
        CHECK(static_cast<double>(c[ids::start]) == Approx(2.0 * i));
        CHECK(static_cast<double>(c[ids::end]) == Approx(2.0 * i + 2.0));
        CHECK(chopOf(doc, i) == i + 1);
    }
    CHECK(doc.trimList().empty());
    CHECK(doc.analysis().bufferDurationSec == Approx(10.0));
    CHECK(doc.analysis().transients[1] == Approx(7.0f));
    CHECK(doc.analysis().drumTransients[1] == Approx(7.5f));
    CHECK(!doc.padOf(2).hasProperty(ids::stems));
    // the pad's route override forgotten by the trim is NOT restored (TS parity); everything else is back
    CHECK(mapGet(mapNode(doc, ids::PadRoutes), 2).isVoid());
    REQUIRE(doc.undo());
    CHECK(J(doc) == trimmed);
    REQUIRE(doc.undo());
    CHECK(J(doc) == original);

    // variant: the old pad is taken by then → the chop lands on the next 'main' slot (after the main block)
    Document d2;
    fillTrimDoc(d2);
    REQUIRE(d2.addTrim(3.0, 7.0));
    addSourceOn(d2, 2, "kick", 0.0, 1.0);
    REQUIRE(d2.restoreTrims());
    CHECK(d2.padSourceOf(2).isValid());
    CHECK(chopOf(d2, 5) == 3); // main pads 0,1,3,4 → next slot 5
    CHECK(static_cast<double>(d2.chopById(3)[ids::start]) == Approx(4.0));
}

// ── pad clipboard ────────────────────────────────────────────────────────────────────────────────
TEST_CASE("padclip: firstEmptyAfter wraps below the limit, pastePlan caps, clearOrder is back-to-front, "
          "duplicatePlan tracks taken slots",
          "[pad-ops][clipboard]")
{
    auto occ = [](int i) { return i == 0 || i == 1 || i == 2; };
    CHECK(padclip::firstEmptyAfter(occ, 1, {}, 4) == 3);
    CHECK(padclip::firstEmptyAfter(occ, 1, {}, 3) == -1);
    CHECK(padclip::firstEmptyAfter(occ, 2, {3}, 64) == 4);
    auto everyOther = [](int i) { return i % 2 == 1; };
    CHECK(padclip::firstEmptyAfter(everyOther, 60, {}, 61) == 0); // wraps to the front
    auto pp = padclip::pastePlan(62, 5);
    REQUIRE(pp.size() == 2);
    CHECK(pp[1].first == 63);
    CHECK(pp[1].second == 1);
    CHECK(padclip::pastePlan(64, 1).empty());
    CHECK(padclip::pastePlan(0, 0).empty());
    CHECK(padclip::pastePlan(10, 3, 11).size() == 1);
    auto notThree = [](int i) { return i != 3; };
    CHECK(padclip::clearOrder({0, 5, 3}, notThree) == std::vector<int>{5, 0});
    CHECK(padclip::cutOrder({5, 3, 0}, notThree) == std::vector<int>{5, 0});
    auto twoOcc = [](int i) { return i == 0 || i == 1; };
    auto dp = padclip::duplicatePlan({1, 0}, twoOcc, twoOcc);
    REQUIRE(dp.size() == 2);
    CHECK(dp[0] == std::pair<int, int>{0, 2});
    CHECK(dp[1] == std::pair<int, int>{1, 3});
    CHECK(padclip::duplicatePlan({0, 1}, twoOcc, twoOcc, 2).empty()); // no room below the lock line
    CHECK(padclip::copyOrder({3, 1, 2}) == std::vector<int>{1, 2, 3});
}

TEST_CASE("pad-ops: copy/paste carries the play settings + stems + reverse; one undo step; paste revives a cleared "
          "chop as a free one",
          "[pad-ops][clipboard]")
{
    Document doc;
    const int c1 = addChopOn(doc, 0, 0.0, 1.0);
    auto p0 = doc.padOf(0);
    p0.setProperty(ids::pitch, 2, nullptr);
    p0.setProperty(ids::stems, 3, nullptr);
    p0.setProperty(ids::reverse, true, nullptr);
    p0.setProperty(ids::gate, true, nullptr);
    p0.setProperty(ids::fadeIn, 0.1, nullptr);
    addSourceOn(doc, 1, "kick", 0.0, 1.0, -1.0);
    doc.padOf(1).setProperty(ids::mode, "loop", nullptr);
    const auto items = doc.copyPads({1, 0}); // pad order
    REQUIRE(items.size() == 2);
    CHECK(items[0].type == padclip::PadContent::Type::chop);
    CHECK(items[0].chopId == c1);
    CHECK(items[0].stems == 3);
    CHECK(items[0].reverse == std::optional<bool>(true));
    CHECK(items[0].fadeIn == Approx(0.1));
    CHECK(items[1].type == padclip::PadContent::Type::buffer);
    CHECK(items[1].videoId == "kick");
    CHECK(items[1].mode == "loop");
    CHECK(items[1].pitch == Approx(-1.0));
    CHECK(doc.copyPads({7}).empty()); // empty pads are skipped

    const auto before = J(doc);
    CHECK(doc.pastePads(4, items) == 2);
    CHECK(chopOf(doc, 4) == c1); // the chop still exists → same id
    CHECK(static_cast<double>(doc.padOf(4)[ids::pitch]) == Approx(2.0));
    CHECK(static_cast<int>(doc.padOf(4)[ids::stems]) == 3);
    CHECK(static_cast<bool>(doc.padOf(4)[ids::reverse]) == true);
    CHECK(static_cast<bool>(doc.padOf(4)[ids::gate]) == true);
    CHECK(static_cast<double>(doc.padOf(4)[ids::fadeIn]) == Approx(0.1));
    CHECK(doc.padSourceOf(5)[ids::videoId].toString() == "kick");
    CHECK(doc.padOf(5)[ids::mode].toString() == "loop");
    CHECK(static_cast<double>(doc.padOf(5)[ids::pitch]) == Approx(-1.0));
    CHECK(!doc.padOf(5).hasProperty(ids::stems));
    CHECK(!doc.padOf(5).hasProperty(ids::reverse));
    // the source got its mixer strip
    CHECK(mapGet(mapNode(doc, ids::SourceRoutes), "src:kick").toString() == "sample2");
    CHECK(static_cast<int>(doc.tree()[ids::nextSampleTrack]) == 3);
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
    CHECK(!doc.canUndo());
    // paste limit: only what fits below the lock line lands
    CHECK(doc.pastePads(62, items) == 2);
    CHECK(doc.pastePads(63, items, 64) == 1);
    CHECK(doc.pastePads(8, items, 8) == 0);
    doc.history().clear();

    // cut = copy + unassign (the chop survives for the paste)
    const auto cut = doc.cutPads({0});
    REQUIRE(cut.size() == 1);
    CHECK(chopOf(doc, 0) == -1);
    CHECK(doc.chopById(c1).isValid());
    CHECK(doc.pastePads(2, cut) == 1);
    CHECK(chopOf(doc, 2) == c1);
    // clear the pasted copy too → the chop is spliced out; a paste of the remembered region revives it FREE
    doc.clearPads({2, 4, 62, 63});
    CHECK(!doc.chopById(c1).isValid());
    CHECK(doc.pastePads(3, cut) == 1);
    const int revived = chopOf(doc, 3);
    CHECK(revived != c1);
    CHECK(static_cast<bool>(doc.chopById(revived)[ids::free]) == true);
    CHECK(static_cast<double>(doc.chopById(revived)[ids::end]) == Approx(1.0));
}

TEST_CASE("pad-ops: duplicatePads gives a chop pad's copy its own free chop; setPadsReverse clears an override that "
          "matches the source",
          "[pad-ops][clipboard]")
{
    Document doc;
    const int c1 = addChopOn(doc, 0, 0.0, 1.0);
    doc.padOf(0).setProperty(ids::pitch, 5, nullptr);
    addSourceOn(doc, 2, "kick", 0.0, 1.0);
    const auto before = J(doc);
    CHECK(doc.duplicatePads({0, 2}) == 2); // 0 → 3 (first empty after 2), 2 → 4
    const int copy = chopOf(doc, 3);
    CHECK(copy != c1);
    CHECK(static_cast<bool>(doc.chopById(copy)[ids::free]) == true);
    CHECK(static_cast<double>(doc.chopById(copy)[ids::end]) == Approx(1.0));
    CHECK(static_cast<double>(doc.padOf(3)[ids::pitch]) == Approx(5.0));
    CHECK(doc.padSourceOf(4)[ids::videoId].toString() == "kick");
    CHECK(chopOf(doc, 0) == c1); // the original is untouched
    REQUIRE(doc.undo());
    CHECK(J(doc) == before);
    CHECK(doc.duplicatePads({7}) == 0);

    // setPadsReverse: nullopt clears; the source's own direction clears; the opposite sets
    doc.setPadsReverse({0}, true);
    CHECK(static_cast<bool>(doc.padOf(0)[ids::reverse]) == true);
    doc.setPadsReverse({0}, std::nullopt);
    CHECK(!doc.padOf(0).hasProperty(ids::reverse));
    doc.tree().setProperty(ids::reverseSample, true, nullptr); // the main source plays reversed
    doc.setPadsReverse({0}, true);
    CHECK(!doc.padOf(0).hasProperty(ids::reverse)); // matches the source → no override
    doc.setPadsReverse({0}, false);
    CHECK(static_cast<bool>(doc.padOf(0)[ids::reverse]) == false);
}

// ── a real project: every op undoes back to byte-identical JSON ──────────────────────────────────
TEST_CASE("pad-ops: p4 (pad sources + 2 sequences) survives movePad / chopPadSourceTo / clearBlock / trims and "
          "undoes back to the loaded JSON",
          "[pad-ops][fixture]")
{
    juce::String err;
    auto tree =
        projectFromFile(juce::File(TERMINATOR_FIXTURES_DIR).getChildFile("projects").getChildFile("p4.tproj"), err);
    REQUIRE(tree.isValid());
    Document doc(tree);
    Document::Analysis a;
    a.bufferDurationSec = 220.0;
    a.transients = {10.f, 20.f, 30.f};
    a.transientStrengths = {1.f, 2.f, 3.f};
    doc.setAnalysis(a);
    const auto original = J(doc);
    REQUIRE(doc.padSourceOf(16).isValid());
    REQUIRE(chopOf(doc, 0) > 0);

    REQUIRE(doc.movePad(16, 0)); // swap a pad source with a chop pad
    CHECK(doc.padSourceOf(0).isValid());
    CHECK(chopOf(doc, 16) > 0);
    REQUIRE(doc.movePad(0, 16));                              // and back
    CHECK(jsonDiff(projectToJson(tree), doc.toJson()) == ""); // a swap + its inverse = the same project
    // 17/18 share a source with 16 → block 16..18; 19 is another source → chopPadSourceTo pushes it to 20
    REQUIRE(doc.chopPadSourceTo(17, 30.0, 19));
    CHECK(doc.padSourceOf(19)[ids::videoId].toString() == doc.padSourceOf(17)[ids::videoId].toString());
    CHECK(srcStart(doc, 19) == Approx(30.0));
    CHECK(doc.padSourceOf(20).isValid());
    doc.clearBlock(16);
    CHECK(!doc.padSourceOf(16).isValid());
    CHECK(!doc.padSourceOf(19).isValid());
    CHECK(doc.padSourceOf(20).isValid());
    REQUIRE(doc.addTrim(9.0, 9.5));
    REQUIRE(doc.restoreTrims());
    int steps = 0;
    while (doc.undo())
        ++steps;
    CHECK(steps == 6); // movePad x2, chop, clearBlock, trim, restore
    CHECK(J(doc) == original);
    while (doc.redo())
    {
    }
    CHECK(doc.trimList().empty());
}
