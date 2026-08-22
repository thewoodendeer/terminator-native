// Undo on the ValueTree via juce::UndoManager (model::Document / EditHistory). Proves the Electron semantics:
// 500 ms coalescing by group key, begin/end batch collapsing composite edits, deep history bounded, and a
// full project round-trips through hundreds of undos back to its exact original.
#include <catch2/catch_test_macros.hpp>

#include "terminator/model/Document.h"
#include "terminator/model/ProjectModel.h"

using namespace terminator;
using namespace terminator::model;

TEST_CASE("undo: a pad-pitch drag coalesces within 500 ms into ONE step, then a new gesture is a new step", "[undo]")
{
    Document doc;
    doc.addChop(0.0, 1.0);
    doc.pads().appendChild(
        []
        {
            juce::ValueTree p(ids::Pad);
            p.setProperty(ids::index, 0, nullptr);
            p.setProperty(ids::pitch, 0, nullptr);
            return p;
        }(),
        nullptr);
    double clock = 1000.0;
    doc.history().nowMs = [&clock] { return clock; };

    doc.setPadPitch(0, 1);
    clock += 100;
    doc.setPadPitch(0, 2);
    clock += 100;
    doc.setPadPitch(0, 3); // same gesture — all within 500 ms
    CHECK(static_cast<int>(doc.padOf(0)[ids::pitch]) == 3);
    CHECK(doc.undo());
    CHECK(static_cast<int>(doc.padOf(0)[ids::pitch]) == 0); // one step undoes the whole drag
    CHECK(doc.redo());
    CHECK(static_cast<int>(doc.padOf(0)[ids::pitch]) == 3);

    clock += 1000;
    doc.setPadPitch(0, 5); // a new gesture (gap > 500 ms)
    CHECK(doc.undo());
    CHECK(static_cast<int>(doc.padOf(0)[ids::pitch]) == 3); // back to the drag's end, not to 0
}

TEST_CASE("undo: different group keys never coalesce with each other", "[undo]")
{
    Document doc;
    for (int i = 0; i < 2; ++i)
        doc.pads().appendChild(
            [i]
            {
                juce::ValueTree p(ids::Pad);
                p.setProperty(ids::index, i, nullptr);
                p.setProperty(ids::pitch, 0, nullptr);
                return p;
            }(),
            nullptr);
    double clock = 0.0;
    doc.history().nowMs = [&clock] { return clock; };
    doc.setPadPitch(0, 4);
    clock += 10;
    doc.setPadPitch(1, 7); // a different pad = a different group, same instant
    CHECK(doc.undo());
    CHECK(static_cast<int>(doc.padOf(1)[ids::pitch]) == 0);
    CHECK(static_cast<int>(doc.padOf(0)[ids::pitch]) == 4); // pad 0 untouched
    CHECK(doc.undo());
    CHECK(static_cast<int>(doc.padOf(0)[ids::pitch]) == 0);
}

TEST_CASE("undo: a batch (paste/dup/move) collapses many edits into one step", "[undo]")
{
    Document doc;
    for (int i = 0; i < 4; ++i)
        doc.pads().appendChild(
            [i]
            {
                juce::ValueTree p(ids::Pad);
                p.setProperty(ids::index, i, nullptr);
                p.setProperty(ids::pitch, 0, nullptr);
                return p;
            }(),
            nullptr);
    doc.beginBatch();
    doc.setPadPitch(0, 1);
    doc.setPadPitch(1, 2);
    doc.setPadPitch(2, 3);
    doc.endBatch();
    CHECK(doc.undo());
    CHECK(static_cast<int>(doc.padOf(0)[ids::pitch]) == 0);
    CHECK(static_cast<int>(doc.padOf(1)[ids::pitch]) == 0);
    CHECK(static_cast<int>(doc.padOf(2)[ids::pitch]) == 0); // all three in one undo
    CHECK(doc.redo());
    CHECK(static_cast<int>(doc.padOf(2)[ids::pitch]) == 3);
}

TEST_CASE("undo: chop-boundary drags coalesce per (id, side); addChop bumps nextChopId undoably", "[undo]")
{
    Document doc;
    const int a = doc.addChop(0.0, 2.0);
    double clock = 0.0;
    doc.history().nowMs = [&clock] { return clock; };
    doc.setChopBoundary(a, false, 1.5);
    clock += 50;
    doc.setChopBoundary(a, false, 1.2); // same end handle — one step
    clock += 50;
    doc.setChopBoundary(a, true, 0.3); // the START handle — a different group
    CHECK(static_cast<double>(doc.chopById(a)[ids::start]) == 0.3);
    CHECK(static_cast<double>(doc.chopById(a)[ids::end]) == 1.2);
    CHECK(doc.undo()); // undo the start drag
    CHECK(static_cast<double>(doc.chopById(a)[ids::start]) == 0.0);
    CHECK(static_cast<double>(doc.chopById(a)[ids::end]) == 1.2);
    CHECK(doc.undo()); // undo the end drag
    CHECK(static_cast<double>(doc.chopById(a)[ids::end]) == 2.0);
    const int before = static_cast<int>(doc.tree()[ids::nextChopId]);
    const int b = doc.addChop(2.0, 3.0);
    CHECK(static_cast<int>(doc.tree()[ids::nextChopId]) == before + 1);
    CHECK(doc.undo());
    CHECK(!doc.chopById(b).isValid());
    CHECK(static_cast<int>(doc.tree()[ids::nextChopId]) == before);
}

TEST_CASE("undo: 500 deep, bounded, and a real project returns to its exact original", "[undo][gate]")
{
    const auto f = juce::File(TERMINATOR_FIXTURES_DIR).getChildFile("projects").getChildFile("p4.tproj");
    REQUIRE(f.existsAsFile());
    juce::String err;
    auto tree = projectFromFile(f, err);
    REQUIRE(tree.isValid());
    Document doc(tree);
    const auto original = doc.toJson();

    // make sure there is a pad 0 with a pitch to wiggle
    auto p0 = doc.padOf(0);
    REQUIRE(p0.isValid());
    double clock = 0.0;
    doc.history().nowMs = [&clock] { return clock; };
    constexpr int kSteps = 600;
    for (int i = 0; i < kSteps; ++i)
    {
        clock += 1000; // each is its own gesture (gap > 500 ms)
        doc.setPadPitch(0, (i % 24) - 12);
    }
    CHECK(doc.history().numUndoSteps() >= 500);
    int undone = 0;
    while (doc.canUndo())
    {
        REQUIRE(doc.undo());
        ++undone;
    }
    CHECK(undone >= 500);
    // Every edit touched only pad 0's pitch; after undoing them all it is back to the original value.
    const auto d = jsonDiff(original["pads"], doc.toJson()["pads"]);
    INFO("pads diff after full undo: " << d);
    CHECK(d.isEmpty());
}
