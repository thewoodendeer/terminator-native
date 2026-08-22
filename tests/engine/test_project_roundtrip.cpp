// Project model: ChopPreset JSON ⇄ ValueTree. Fixtures = Victor's 8 real .tproj projects (tests/fixtures/
// projects/p1..p8): every key the Electron writer emitted must come back equal (numbers within 1e-9, key order
// ignored, null grid rows == empty rows); our writer may add keys (version, sequences' viewResolution…) but
// never drop one; and save → load → save is a fixed point.
#include <catch2/catch_test_macros.hpp>

#include <juce_core/juce_core.h>

#include "terminator/model/ProjectModel.h"

using namespace terminator;
using namespace terminator::model;

namespace
{
juce::File fixture(const char* name)
{
    return juce::File(TERMINATOR_FIXTURES_DIR).getChildFile("projects").getChildFile(name);
}
juce::var parse(const juce::String& text)
{
    juce::var v;
    REQUIRE(juce::JSON::parse(text, v).wasOk());
    return v;
}
/// First difference between two trees (type, property values incl. var TYPE, children), or empty.
juce::String treeDiff(const juce::ValueTree& a, const juce::ValueTree& b, const juce::String& path = "/")
{
    if (a.getType() != b.getType())
        return path + " type " + a.getType().toString() + " vs " + b.getType().toString();
    for (int i = 0; i < a.getNumProperties(); ++i)
    {
        const auto n = a.getPropertyName(i);
        if (!b.hasProperty(n))
            return path + " missing prop " + n.toString();
        const auto &x = a[n], &y = b[n];
        if (!(x == y))
            return path + " prop " + n.toString() + ": " + x.toString() + " vs " + y.toString();
        if (x.isInt() != y.isInt() || x.isInt64() != y.isInt64() || x.isDouble() != y.isDouble())
            return path + " prop " + n.toString() + " var type differs";
    }
    if (a.getNumProperties() != b.getNumProperties())
        return path + " extra props on the right";
    if (a.getNumChildren() != b.getNumChildren())
        return path + " child count " + juce::String(a.getNumChildren()) + " vs " + juce::String(b.getNumChildren());
    for (int i = 0; i < a.getNumChildren(); ++i)
        if (auto d = treeDiff(a.getChild(i), b.getChild(i),
                              path + a.getChild(i).getType().toString() + "[" + juce::String(i) + "]/");
            d.isNotEmpty())
            return d;
    return {};
}
/// Every key of `original` must exist in `ours` with an equal value; extra keys in `ours` are allowed.
juce::String subsetDiff(const juce::var& original, const juce::var& ours)
{
    const auto* po = original.getDynamicObject();
    const auto* pu = ours.getDynamicObject();
    REQUIRE(po != nullptr);
    REQUIRE(pu != nullptr);
    for (int i = 0; i < po->getProperties().size(); ++i)
    {
        const auto k = po->getProperties().getName(i);
        if (!pu->getProperties().contains(k))
            return "missing key " + k.toString();
        if (auto d = jsonDiff(po->getProperties().getValueAt(i), pu->getProperties()[k], 1e-9, true); d.isNotEmpty())
            return k.toString() + " " + d;
    }
    return {};
}
} // namespace

TEST_CASE("project: the 8 real projects round-trip through the ValueTree losslessly", "[model][roundtrip]")
{
    for (int i = 1; i <= 8; ++i)
    {
        const auto f = fixture(("p" + juce::String(i) + ".tproj").toRawUTF8());
        INFO("fixture " << f.getFileName());
        REQUIRE(f.existsAsFile());
        const auto originalText = f.loadFileAsString();
        const auto original = parse(originalText);
        juce::String err;
        auto tree = projectFromJsonText(originalText, err);
        INFO(err);
        REQUIRE(tree.isValid());
        CHECK(tree.getType() == ids::Project);
        const auto ours = projectToJson(tree);
        const auto d = subsetDiff(original, ours);
        INFO("diff: " << d);
        CHECK(d.isEmpty());
        CHECK(static_cast<int>(ours["version"]) == kProjectFormatVersion);
        // fixed point: load our output again → identical JSON
        auto tree2 = projectFromJson(ours, err);
        REQUIRE(tree2.isValid());
        const auto again = projectToJson(tree2);
        const auto d2 = jsonDiff(ours, again);
        INFO("second pass diff: " << d2);
        CHECK(d2.isEmpty());
        // and the tree is a fixed point from the second pass on (the first pass may add root defaults the
        // old file lacked; property var TYPES included — undo compares vars)
        auto tree3 = projectFromJson(again, err);
        const auto td = treeDiff(tree2, tree3);
        INFO("tree diff: " << td);
        CHECK(td.isEmpty());
        // the chopper-owned sections are structured (not opaque)
        CHECK(tree.getChildWithName(ids::Chops).getNumChildren() == original["chops"].size());
        CHECK(tree.getChildWithName(ids::Pads).getNumChildren() == original["pads"].size());
        CHECK(tree.getChildWithName(ids::Sequences).getNumChildren() == original["sequences"].size());
    }
}

TEST_CASE("project: legacy shapes - no sequences[] -> the single-pattern fields; drums._inputQuantize migrates; "
          "masks normalise; bad resolutions fall back",
          "[model][legacy]")
{
    const juce::String legacy = R"({
      "videoId": "abc", "savedAt": "2025-01-01T00:00:00.000Z", "chops": [{"id":1,"start":0,"end":2}],
      "pads": [{"index":0,"chopId":1,"mode":"oneshot","pitch":0,"stems":0,"gate":false,"fadeIn":0},
               {"index":1,"chopId":null,"mode":"loop","pitch":3,"stems":5,"reverse":true}],
      "bpm": 90, "nextChopId": 2, "seqBars": 2, "seqResolution": 7, "seqGrid": [[0], null, [1]], "seqLoop": false,
      "drums": {"_inputQuantize": 42.6, "tracks": []}
    })";
    juce::String err;
    auto t = projectFromJsonText(legacy, err);
    REQUIRE(t.isValid());
    auto seqs = t.getChildWithName(ids::Sequences);
    REQUIRE(seqs.getNumChildren() == 1);
    CHECK(static_cast<int>(seqs.getChild(0)[ids::bars]) == 2);
    CHECK(static_cast<int>(seqs.getChild(0)[ids::resolution]) == 16); // 7 is not a grid → 16
    CHECK(static_cast<int>(seqs.getChild(0)[ids::viewResolution]) == 16);
    CHECK(static_cast<bool>(seqs.getChild(0)[ids::loop]) == false);
    CHECK(seqs.getChild(0)[ids::grid].size() == 3);
    CHECK(seqs.getChild(0)[ids::grid][1].size() == 0); // null row → empty
    CHECK(static_cast<int>(t[ids::inputQuantize]) == 43);
    auto pads = t.getChildWithName(ids::Pads);
    CHECK(!pads.getChild(0).hasProperty(ids::stems)); // 0 → ALL → absent
    CHECK(!pads.getChild(0).hasProperty(ids::gate));  // false → absent
    CHECK(!pads.getChild(0).hasProperty(ids::fadeIn));
    CHECK(static_cast<int>(pads.getChild(1)[ids::stems]) == 5);
    CHECK(!pads.getChild(1).hasProperty(ids::chopId)); // null chop
    CHECK(static_cast<bool>(pads.getChild(1)[ids::reverse]) == true);
    // the writer emits the current shape: sequences[], currentSeqIdx, every scalar with its default, version 2
    auto out = projectToJson(t);
    CHECK(out["sequences"].size() == 1);
    CHECK(static_cast<int>(out["sequences"][0]["resolution"]) == 16);
    CHECK(static_cast<int>(out["currentSeqIdx"]) == 0);
    CHECK(static_cast<double>(out["chopVolume"]) == 1.0);
    CHECK(static_cast<int>(out["metronomeBpm"]) == 120);
    CHECK(static_cast<int>(out["inputQuantize"]) == 43);
    CHECK(out["pads"][1]["chopId"].isVoid());
    CHECK(static_cast<int>(out["version"]) == 2);
    CHECK(out["drums"]["tracks"].isArray()); // opaque blob survives
    CHECK(out["master"]["compStyle"].toString() == "off");
    CHECK(!out.hasProperty("trims"));
    CHECK(!out.hasProperty("stems"));
}

TEST_CASE("project: an empty project writes a valid preset; non-objects are refused", "[model]")
{
    auto p = createEmptyProject();
    auto out = projectToJson(p);
    CHECK(out["videoId"].toString() == "none");
    CHECK(out["chops"].size() == 0);
    CHECK(out["sequences"].size() == 1);
    juce::String err;
    CHECK(!projectFromJsonText("[1,2,3]", err).isValid());
    CHECK(err.isNotEmpty());
    CHECK(!projectFromJsonText("{ not json", err).isValid());
    const auto text = projectToJsonText(p);
    auto back = projectFromJsonText(text, err);
    REQUIRE(back.isValid());
    CHECK(jsonDiff(out, projectToJson(back)).isEmpty());
}

TEST_CASE("project: map helpers keep insertion order and replace in place", "[model]")
{
    auto p = createEmptyProject();
    auto routes = p.getChildWithName(ids::SourceRoutes);
    mapSet(routes, "src:a", "sample2", nullptr);
    mapSet(routes, "src:b", "sample3", nullptr);
    mapSet(routes, "src:a", "sample4", nullptr);
    CHECK(routes.getNumChildren() == 2);
    CHECK(mapGet(routes, "src:a").toString() == "sample4");
    CHECK(mapGet(routes, "src:zzz", "sample").toString() == "sample");
    CHECK(mapHas(routes, "src:b"));
    mapRemove(routes, "src:b", nullptr);
    CHECK(!mapHas(routes, "src:b"));
    auto out = projectToJson(p);
    CHECK(out["sourceRoutes"]["src:a"].toString() == "sample4");
}

TEST_CASE("project: jsonDiff tolerances", "[model]")
{
    juce::var a = parse(R"({"x": 1.0000000000001, "g": [[0], null, [2]], "s": "q", "b": true, "n": null})");
    juce::var b = parse(R"({"x": 1, "g": [[0], [], [2]], "s": "q", "b": true, "n": null})");
    CHECK(jsonDiff(a, b).isEmpty());
    juce::var c = parse(R"({"x": 1.01, "g": [[0], [], [2]], "s": "q", "b": true, "n": null})");
    CHECK(jsonDiff(a, c).isNotEmpty());
    juce::var d = parse(R"({"x": 1, "g": [[0], [], [2]], "s": "q", "b": true})");
    CHECK(jsonDiff(a, d).isNotEmpty());
}
