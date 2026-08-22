// BLOCKS planners (blockRange/nextSlotForSource/roomAfterBlock/insertPushing/planMoveBlock) + Document.moveBlock
// — the SOURCES+BLOCKS parity: blocks move as a unit and push others aside, singles swap, sequencer steps follow.
#include <catch2/catch_test_macros.hpp>

#include "terminator/core/planners/Blocks.h"
#include "terminator/model/Document.h"

using namespace terminator;
using namespace terminator::blocks;
using namespace terminator::model;

namespace
{
Slots S(std::vector<std::string> keys) // "" = empty
{
    Slots s;
    for (auto& k : keys)
        s.push_back(k.empty() ? Key{} : Key{k});
    return s;
}
} // namespace

TEST_CASE("blocks: blockRange, nextSlotForSource, roomAfterBlock", "[blocks]")
{
    auto s = S({"a", "a", "b", "", "c"});
    auto r = blockRange(s, 1);
    REQUIRE(r);
    CHECK(r->first == 0);
    CHECK(r->second == 1);
    CHECK(!blockRange(s, 3));              // empty pad
    CHECK(nextSlotForSource(s, "a") == 2); // right after a's block
    CHECK(nextSlotForSource(s, "z") == 3); // no block → first empty
    auto room = roomAfterBlock(s, 0);      // after a's block (index 2) — pad 2 is 'b', 0 free
    CHECK(room.at == 2);
    CHECK(room.free == 0);
    auto room2 = roomAfterBlock(S({"a", "", "", "b"}), 0); // after 'a' at 1: pads 1,2 free
    CHECK(room2.at == 1);
    CHECK(room2.free == 2);
}

TEST_CASE("blocks: insertPushing pushes the occupied run right, never overwrites", "[blocks]")
{
    auto slots = S({"a", "b", "c", ""});
    std::vector<int> origin{0, 1, 2, 3};
    insertPushing(slots, origin, 1, S({"X"})); // insert X at 1 → a,X,b,c
    CHECK(slots[0] == Key{"a"});
    CHECK(slots[1] == Key{"X"});
    CHECK(slots[2] == Key{"b"});
    CHECK(slots[3] == Key{"c"});
    CHECK(origin[1] == -1);
    CHECK(origin[2] == 1); // b's old index followed it
}

TEST_CASE("blocks: planMoveBlock - a block pushes aside, singles swap", "[blocks]")
{
    // move block 'a' (0..1) onto index 3 in [a a b c] → b,c pushed left, a lands at... insertPushing at 3
    auto plan = planMoveBlock(S({"a", "a", "b", "c"}), 0, 3);
    REQUIRE(plan.valid);
    CHECK(plan.landing.size() == 2);
    // singles swap: [a b] move 0->1 swaps
    auto sw = planMoveBlock(S({"a", "b"}), 0, 1);
    REQUIRE(sw.valid);
    REQUIRE(sw.origin.size() == 2);
    CHECK(sw.origin[0] == 1);
    CHECK(sw.origin[1] == 0);
    // single onto empty: vacates the source
    auto mv = planMoveBlock(S({"a", ""}), 0, 1);
    REQUIRE(mv.valid);
    CHECK(mv.origin[1] == 0);
    CHECK(mv.origin[0] == -1);
    // a no-op (dropping on itself)
    CHECK(!planMoveBlock(S({"a", "a"}), 0, 1).valid);
}

TEST_CASE("document: moveBlock swaps two single pad-source pads and follows the sequencer steps", "[blocks][doc]")
{
    // kit: pad 0 = kick, pad 1 = snare; a sequence hits pad 0 on step 0 and pad 1 on step 4
    Document doc;
    auto pads = doc.pads();
    auto srcs = doc.tree().getChildWithName(ids::PadSources);
    for (int i = 0; i < 2; ++i)
    {
        juce::ValueTree p(ids::Pad);
        p.setProperty(ids::index, i, nullptr);
        p.setProperty(ids::pitch, i == 0 ? 0 : 3, nullptr); // give snare a distinct pitch
        p.setProperty(ids::mode, "oneshot", nullptr);
        pads.appendChild(p, nullptr);
        juce::ValueTree s(ids::PadSource);
        s.setProperty(ids::pad, i, nullptr);
        s.setProperty(ids::videoId, i == 0 ? "kick" : "snare", nullptr);
        s.setProperty(ids::title, "x", nullptr);
        s.setProperty(ids::start, 0.0, nullptr);
        s.setProperty(ids::end, 1.0, nullptr);
        srcs.appendChild(s, nullptr);
    }
    auto seq = doc.tree().getChildWithName(ids::Sequences).getChild(0);
    juce::Array<juce::var> grid;
    for (int st = 0; st < 8; ++st)
    {
        juce::Array<juce::var> row;
        if (st == 0)
            row.add(0);
        if (st == 4)
            row.add(1);
        grid.add(juce::var(row));
    }
    seq.setProperty(ids::grid, juce::var(grid), nullptr);

    REQUIRE(doc.padSourceKey(0) == "src:kick");
    REQUIRE(doc.moveBlock(0, 1)); // swap
    // now pad 0 = snare, pad 1 = kick
    CHECK(doc.padSourceKey(0) == "src:snare");
    CHECK(doc.padSourceKey(1) == "src:kick");
    CHECK(static_cast<int>(doc.padOf(0)[ids::pitch]) == 3); // snare's pitch moved with it
    CHECK(static_cast<int>(doc.padOf(1)[ids::pitch]) == 0);
    // the sequence steps followed: step 0 now fires pad 1 (kick), step 4 fires pad 0 (snare)
    auto g = doc.tree().getChildWithName(ids::Sequences).getChild(0)[ids::grid];
    CHECK(static_cast<int>(g[0][0]) == 1);
    CHECK(static_cast<int>(g[4][0]) == 0);
    // undo restores
    CHECK(doc.undo());
    CHECK(doc.padSourceKey(0) == "src:kick");
    auto g2 = doc.tree().getChildWithName(ids::Sequences).getChild(0)[ids::grid];
    CHECK(static_cast<int>(g2[0][0]) == 0);
}

TEST_CASE("document: moveBlock moves a 2-pad block and pushes a single aside", "[blocks][doc]")
{
    // pads: 0,1 = songA (a 2-pad block), 2 = songB. Move the block onto index 2 → B pushed, A at 1..2?
    Document doc;
    auto pads = doc.pads();
    auto srcs = doc.tree().getChildWithName(ids::PadSources);
    auto add = [&](int i, const char* vid)
    {
        juce::ValueTree p(ids::Pad);
        p.setProperty(ids::index, i, nullptr);
        p.setProperty(ids::pitch, 0, nullptr);
        p.setProperty(ids::mode, "oneshot", nullptr);
        pads.appendChild(p, nullptr);
        juce::ValueTree s(ids::PadSource);
        s.setProperty(ids::pad, i, nullptr);
        s.setProperty(ids::videoId, vid, nullptr);
        s.setProperty(ids::title, "x", nullptr);
        s.setProperty(ids::start, 0.0, nullptr);
        s.setProperty(ids::end, 1.0, nullptr);
        srcs.appendChild(s, nullptr);
    };
    add(0, "A");
    add(1, "A");
    add(2, "B");
    REQUIRE(doc.moveBlock(0, 2)); // drop A's block on 2 (not a single→swap; a real push)
    // every pad still occupied, B still present, A still a contiguous 2-run somewhere
    int aCount = 0, bCount = 0;
    for (int i = 0; i < 6; ++i)
    {
        const auto k = doc.padSourceKey(i);
        if (k == "src:A")
            ++aCount;
        if (k == "src:B")
            ++bCount;
    }
    CHECK(aCount == 2);
    CHECK(bCount == 1);
}
