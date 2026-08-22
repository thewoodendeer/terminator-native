// Snap (applySnap/snapToBeat/gridAnchor/snapToTransient) + the Document chop editing (autoChop, sliceAtTime)
// built on top of the onset detectors — the chop-workflow parity assertions.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include "terminator/core/planners/Snap.h"
#include "terminator/model/Document.h"

using namespace terminator;
using namespace terminator::model;
using Catch::Approx;

TEST_CASE("snap: nearest transient within the window, and beat grid anchored at the first drum hit", "[snap]")
{
    std::vector<float> tr{0.5f, 1.02f, 1.51f};
    CHECK(snap::snapToTransient(1.0, tr) == Approx(1.02)); // 1.02 is within 0.25
    CHECK(snap::snapToTransient(3.0, tr) == Approx(3.0));  // nothing within 0.25 → unchanged
    CHECK(snap::snapToTransient(0.0, {}) == 0.0);

    // 120 BPM: beat = 0.5 s, 1/4 grid = 0.5 s, anchored at the first drum hit folded into [0,beat)
    std::vector<float> drums{0.02f, 0.52f, 1.02f}; // downbeat at 0.02
    const double anchor = snap::gridAnchor(120.0, drums, {});
    CHECK(anchor == Approx(0.02));
    // a position at 0.77 snaps to anchor + 1×0.5 = 0.52 or +2×0.5=1.02 — nearest is 1.02?
    // 0.77-0.52=0.25, 1.02-0.77=0.25 use 0.80 → nearest line 1.02 (dist .22) vs 0.52 (dist .28) → 1.02
    CHECK(snap::snapToBeat(0.80, 4, 120.0, drums, {}) == Approx(1.02));
    // applySnap dispatch + beat fallback to transient when bpm unknown
    CHECK(snap::applySnap(1.0, snap::Mode::transient, 0, tr, {}, {}) == Approx(1.02));
    CHECK(snap::applySnap(1.0, snap::Mode::beat4, 0.0, tr, {}, {}) == Approx(1.02)); // bpm 0 → transient
    CHECK(snap::applySnap(1.0, snap::Mode::off, 120, tr, drums, {}) == Approx(1.0));
}

TEST_CASE("document: autoChop divides the buffer into N equal chops on pads 0..N-1, undoably", "[snap][chops]")
{
    Document doc;
    Document::Analysis a;
    a.bufferDurationSec = 4.0;
    a.bpm = 120;
    doc.setAnalysis(a);
    const int made = doc.autoChop(4);
    CHECK(made == 4);
    CHECK(doc.chops().getNumChildren() == 4);
    // pads 0..3 point at the 4 chops, evenly spaced
    for (int i = 0; i < 4; ++i)
    {
        auto c = doc.chops().getChild(i);
        CHECK(static_cast<double>(c[ids::start]) == Approx(i * 1.0));
        CHECK(static_cast<double>(c[ids::end]) == Approx((i + 1) * 1.0));
        auto p = doc.padOf(i);
        REQUIRE(p.isValid());
        CHECK(static_cast<int>(p[ids::chopId]) == static_cast<int>(c[ids::id]));
    }
    // nextChopId advanced; undo restores the empty grid
    CHECK(static_cast<int>(doc.tree()[ids::nextChopId]) == 1 + 4);
    CHECK(doc.undo());
    CHECK(doc.chops().getNumChildren() == 0);
    CHECK(static_cast<int>(doc.tree()[ids::nextChopId]) == 1);
    CHECK(doc.redo());
    CHECK(doc.chops().getNumChildren() == 4);
}

TEST_CASE("document: sliceAtTime splits the containing chop at the (snapped) position onto a target pad",
          "[snap][chops]")
{
    Document doc;
    Document::Analysis a;
    a.bufferDurationSec = 4.0;
    doc.setAnalysis(a);
    doc.autoChop(1); // one chop [0,4) on pad 0
    // slice at 1.5 onto pad 5
    const int nid = doc.sliceAtTime(1.5, 5, 0);
    CHECK(nid > 0);
    CHECK(doc.chops().getNumChildren() == 2);
    // chop 0 now [0,1.5), new chop [1.5,4)
    CHECK(static_cast<double>(doc.chops().getChild(0)[ids::end]) == Approx(1.5));
    CHECK(static_cast<double>(doc.chops().getChild(1)[ids::start]) == Approx(1.5));
    CHECK(static_cast<double>(doc.chops().getChild(1)[ids::end]) == Approx(4.0));
    CHECK(static_cast<int>(doc.padOf(5)[ids::chopId]) == nid);
    // a slice within 10 ms of an edge is refused
    CHECK(doc.sliceAtTime(0.005, 6, 0) == -1);
    CHECK(doc.sliceAtTime(3.999, 6, 0) == -1);
    // undo removes the split (back to one chop)
    CHECK(doc.undo());
    CHECK(doc.chops().getNumChildren() == 1);
}

TEST_CASE("document: sliceAtTime honours the snap mode (snaps to a transient)", "[snap][chops]")
{
    Document doc;
    Document::Analysis a;
    a.bufferDurationSec = 4.0;
    a.transients = {1.48f}; // a transient near 1.5
    doc.setAnalysis(a);
    doc.autoChop(1);
    doc.sliceAtTime(1.5, 3, 1); // snapMode 1 = transient → snaps to 1.48
    CHECK(static_cast<double>(doc.chops().getChild(0)[ids::end]) == Approx(1.48));
}
