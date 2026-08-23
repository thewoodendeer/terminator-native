// THE BASS IN THE EXPORT (Phase 4.5d) — the last of the three instruments to reach a bounce. The engine's own
// BassSequencer + BassSynth render it, so the patch, the slides and the BEND lane in an export are the ones that
// were playing. The parser is now SHARED with the live bridge (render/BassSpec.h): one patch reader, so a patch can
// never sound different in a bounce than it does live. It has to accept the bend lane in BOTH shapes — the bridge
// sends it already sampled per tick, a project file stores the page's breakpoints.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "terminator/model/Ids.h"
#include "terminator/model/ProjectModel.h"
#include "terminator/render/BassSpec.h"
#include "terminator/render/ProjectRenderer.h"

using namespace terminator;
using namespace terminator::render;
using namespace terminator::model;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;

juce::var note(int id, int midi, double start, double dur, double vel, bool slide = false)
{
    auto* n = new juce::DynamicObject();
    n->setProperty("id", id);
    n->setProperty("note", midi);
    n->setProperty("start", start);
    n->setProperty("dur", dur);
    n->setProperty("vel", vel);
    if (slide)
        n->setProperty("slide", true);
    return juce::var(n);
}

/// The page's BassPreset blob: one 2-bar pattern with a note on beat 0 and one on beat 2.
juce::var bassBlob(bool withNotes = true, const juce::var& bend = {})
{
    juce::Array<juce::var> notes;
    if (withNotes)
    {
        notes.add(note(1, 36, 0.0, 0.5, 0.9));
        notes.add(note(2, 43, 2.0, 0.5, 0.8));
    }
    auto* pat = new juce::DynamicObject();
    pat->setProperty("bars", 2);
    pat->setProperty("notes", juce::var(notes));
    if (!bend.isVoid())
        pat->setProperty("bend", bend);
    juce::Array<juce::var> patterns;
    patterns.add(juce::var(pat));

    auto* filter = new juce::DynamicObject();
    filter->setProperty("cutoff", 800.0);
    filter->setProperty("model", "diode");
    auto* patch = new juce::DynamicObject();
    patch->setProperty("filter", juce::var(filter));
    patch->setProperty("mixerDrive", 3.0);

    auto* blob = new juce::DynamicObject();
    blob->setProperty("patch", juce::var(patch));
    blob->setProperty("patterns", juce::var(patterns));
    blob->setProperty("currentIdx", 0);
    return juce::var(blob);
}

juce::ValueTree bassProject(const juce::var& blob)
{
    auto p = model::createEmptyProject();
    p.setProperty(ids::bass, blob, nullptr);
    p.setProperty(ids::metronomeBpm, 120, nullptr);
    auto seqs = p.getChildWithName(ids::Sequences);
    seqs.removeAllChildren(nullptr);
    juce::ValueTree seq(ids::Sequence);
    seq.setProperty(ids::bars, 2, nullptr);
    seq.setProperty(ids::resolution, 16, nullptr);
    seq.setProperty(ids::viewResolution, 16, nullptr);
    seq.setProperty(ids::loop, true, nullptr);
    seq.setProperty(ids::grid, juce::var(juce::Array<juce::var>()), nullptr);
    seq.setProperty(ids::velGrid, juce::var(juce::Array<juce::var>()), nullptr);
    seq.setProperty(ids::revGrid, juce::var(juce::Array<juce::var>()), nullptr);
    seqs.appendChild(seq, nullptr);
    p.setProperty(ids::currentSeqIdx, 0, nullptr);
    return p;
}

ProjectRenderOptions bassOpts()
{
    ProjectRenderOptions o;
    o.sampleRate = kSr;
    o.blockSize = 128;
    o.loops = 1;
    o.tailSeconds = 0.3;
    o.renderBass = true;
    return o;
}

double peakIn(const juce::AudioBuffer<float>& b, double t0, double t1, int ch = 0)
{
    const int a = std::max(0, static_cast<int>(t0 * kSr));
    const int z = std::min(b.getNumSamples(), static_cast<int>(t1 * kSr));
    double pk = 0.0;
    for (int i = a; i < z; ++i)
        pk = std::max(pk, std::abs(static_cast<double>(b.getSample(ch, i))));
    return pk;
}
} // namespace

TEST_CASE("bass export: the preset blob becomes the engine's own patch and pattern", "[export][bass]")
{
    const auto b = buildBassSpec(bassProject(bassBlob()), nullptr);
    REQUIRE(b.enabled);
    REQUIRE(b.patch != nullptr);
    REQUIRE(b.pattern != nullptr);
    REQUIRE(b.pattern->bars == 2);
    REQUIRE(b.pattern->numNotes == 2);
    REQUIRE(b.pattern->notes[0].note == 36);
    REQUIRE(b.pattern->notes[0].onTick == 0);
    REQUIRE(b.pattern->notes[1].note == 43);
    REQUIRE(b.pattern->notes[1].onTick == 2 * kBassPpq); // beat 2
    // the patch really is the project's, not the defaults
    REQUIRE(b.patch->cutoff == Approx(800.0));
    REQUIRE(b.patch->filterModel == BassFilterModel::diode);
    REQUIRE(b.patch->mixerDrive == Approx(3.0));
}

TEST_CASE("bass export: an empty roll renders nothing", "[export][bass]")
{
    const auto b = buildBassSpec(bassProject(bassBlob(false)), nullptr);
    REQUIRE(!b.enabled);
}

TEST_CASE("bass export: the BEND lane is read in BOTH shapes - per tick and as the preset's breakpoints",
          "[export][bass]")
{
    // the bridge's shape: the lane already sampled per tick
    juce::Array<juce::var> perTick;
    for (int t = 0; t < 4 * kBassPpq; ++t)
        perTick.add(static_cast<double>(t) / static_cast<double>(kBassPpq)); // +1 semitone per beat
    // the project file's shape: the page's breakpoints, linear between
    auto point = [](double beat, double semis)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("beat", beat);
        o->setProperty("semis", semis);
        return juce::var(o);
    };
    juce::Array<juce::var> points;
    points.add(point(0.0, 0.0));
    points.add(point(4.0, 4.0)); // the same ramp, as two breakpoints

    auto build = [](const juce::var& bend)
    {
        auto* pat = new juce::DynamicObject();
        pat->setProperty("bars", 1);
        juce::Array<juce::var> notes;
        notes.add(note(1, 36, 0.0, 0.5, 0.9));
        pat->setProperty("notes", juce::var(notes));
        pat->setProperty("bend", bend);
        BassPattern out;
        bassPatternFromVar(juce::var(pat), out);
        return out;
    };
    const auto a = build(juce::var(perTick));
    const auto b = build(juce::var(points));
    REQUIRE(a.hasBend);
    REQUIRE(b.hasBend);
    // 1 bar = 4 beats = 4 × kBassPpq ticks; both describe the same ramp
    for (int t = 0; t < a.loopTicks; ++t)
        REQUIRE(b.bend[t] == Approx(a.bend[t]).margin(1.0e-4));
    REQUIRE(b.bend[kBassPpq] == Approx(1.0).margin(1.0e-4)); // one beat in = +1 semitone
}

TEST_CASE("bass export: breakpoints are flat before the first and after the last", "[export][bass]")
{
    auto point = [](double beat, double semis)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("beat", beat);
        o->setProperty("semis", semis);
        return juce::var(o);
    };
    juce::Array<juce::var> points;
    points.add(point(1.0, 2.0));
    points.add(point(2.0, -2.0));
    auto* pat = new juce::DynamicObject();
    pat->setProperty("bars", 1);
    juce::Array<juce::var> notes;
    notes.add(note(1, 36, 0.0, 0.5, 0.9));
    pat->setProperty("notes", juce::var(notes));
    pat->setProperty("bend", juce::var(points));
    BassPattern out;
    bassPatternFromVar(juce::var(pat), out);
    REQUIRE(out.bend[0] == Approx(2.0).margin(1.0e-4));                  // flat before the first
    REQUIRE(out.bend[kBassPpq] == Approx(2.0).margin(1.0e-4));           // at the first
    REQUIRE(out.bend[3 * kBassPpq / 2] == Approx(0.0).margin(1.0e-3));   // half way = linear
    REQUIRE(out.bend[out.loopTicks - 1] == Approx(-2.0).margin(1.0e-4)); // flat after the last
}

TEST_CASE("bass export: the bass is IN the bounce, and silent without renderBass", "[export][bass]")
{
    auto p = bassProject(bassBlob());
    const auto on = renderProject(p, SampleBank{}, bassOpts());
    REQUIRE(peakIn(on.buffer, 0.0, 0.5) > 0.01); // the note on beat 0
    REQUIRE(peakIn(on.buffer, 1.0, 1.5) > 0.01); // beat 2 = 1.0 s at 120 BPM

    auto off = bassOpts();
    off.renderBass = false;
    const auto none = renderProject(p, SampleBank{}, off);
    REQUIRE(peakIn(none.buffer, 0.0, 2.0) == 0.0);
}

TEST_CASE("bass export: the synth sums into the bass strip and comes out as a trackout", "[export][bass]")
{
    auto p = bassProject(bassBlob());
    auto opts = bassOpts();
    opts.useMixer = true;
    opts.masterLimiter = false;
    opts.stemChannels = {"bass"};
    opts.numChannels = 4;
    const auto r = renderProject(p, SampleBank{}, opts);
    REQUIRE(peakIn(r.buffer, 0.0, 0.5, 2) > 0.01); // the bass trackout has the bass
    double worst = 0.0;
    for (int i = 0; i < r.buffer.getNumSamples(); ++i)
        worst = std::max(worst, std::abs(static_cast<double>(r.buffer.getSample(0, i)) -
                                         static_cast<double>(r.buffer.getSample(2, i))));
    INFO("worst master-vs-trackout difference: " << worst);
    REQUIRE(worst < 1.0e-6); // the bass is the whole mix here, so the master IS its trackout
}

TEST_CASE("bass export: the bass lands on the page's strip numbering", "[export][bass]")
{
    StripNamer namer;
    const auto b = buildBassSpec(bassProject(bassBlob()), &namer);
    REQUIRE(b.strip == 7); // 'bass'
}
