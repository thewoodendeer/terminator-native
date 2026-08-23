// THE DRUM MACHINE IN THE EXPORT (Phase 4.5c) — until now a project render was CHOPS ONLY: a bounce of a real beat
// had no drums in it at all. The project keeps the drum machine as an opaque blob (the page's DrumPreset: tracks /
// sequences / the four step graphs / swing / master); this turns it into the engine's OWN DrumSequencer, so the
// exported bytes carry the same swing, the same per-step VELOCITY / SHIFT / PAN / REPEAT and the same mute-group
// choke order as playback. No second sequencer, no approximation.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "terminator/model/Ids.h"
#include "terminator/model/ProjectModel.h"
#include "terminator/render/ProjectRenderer.h"

using namespace terminator;
using namespace terminator::render;
using namespace terminator::model;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;

std::shared_ptr<SampleBuffer> burst(double durSec, float amp)
{
    auto b = std::make_shared<SampleBuffer>();
    const auto n = static_cast<std::int64_t>(kSr * durSec);
    b->allocate(1, n, kSr);
    for (std::int64_t i = 0; i < n; ++i)
        b->channel(0)[i] = amp * static_cast<float>(std::exp(-30.0 * static_cast<double>(i) / kSr));
    return b;
}

/// A DrumPreset blob: two lanes ('kick', 'snare'), one 2-bar sequence at INTERNAL_SPB, kick on the given internal
/// steps and snare on its own.
juce::var drumBlob(const std::vector<int>& kickSteps, const std::vector<int>& snareSteps, int gridRes = 96,
                   bool snareSolo = false, bool kickMuted = false)
{
    auto laneRow = [&](const std::vector<int>& on, int len)
    {
        juce::Array<juce::var> row;
        for (int i = 0; i < len; ++i)
        {
            bool hit = false;
            for (int s : on)
                if (s == i)
                    hit = true;
            row.add(hit);
        }
        return juce::var(row);
    };
    const int len = gridRes * 2; // two bars
    auto* seq = new juce::DynamicObject();
    seq->setProperty("kick", laneRow(kickSteps, len));
    seq->setProperty("snare", laneRow(snareSteps, len));
    juce::Array<juce::var> sequences;
    sequences.add(juce::var(seq));

    auto track = [](const char* key, bool muted, bool solo, double vol, int group)
    {
        auto* t = new juce::DynamicObject();
        t->setProperty("key", key);
        t->setProperty("muted", muted);
        t->setProperty("solo", solo);
        t->setProperty("volume", vol);
        if (group > 0)
            t->setProperty("muteGroup", group);
        return juce::var(t);
    };
    juce::Array<juce::var> tracks;
    tracks.add(track("kick", kickMuted, false, 0.8, 0));
    tracks.add(track("snare", false, snareSolo, 0.6, 0));

    auto* blob = new juce::DynamicObject();
    blob->setProperty("tracks", juce::var(tracks));
    blob->setProperty("sequences", juce::var(sequences));
    blob->setProperty("seqIndex", 0);
    blob->setProperty("bars", 2);
    blob->setProperty("masterVolume", 0.9);
    blob->setProperty("drumSwing", 0.0);
    blob->setProperty("gridRes", gridRes);
    blob->setProperty("ppq", 96);
    return juce::var(blob);
}

juce::ValueTree drumProject(const juce::var& blob)
{
    auto p = model::createEmptyProject();
    p.setProperty(ids::drums, blob, nullptr);
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

SampleBank drumBank()
{
    SampleBank b;
    b.drumLanes["kick"] = burst(0.15, 0.8f);
    b.drumLanes["snare"] = burst(0.15, 0.6f);
    return b;
}

ProjectRenderOptions drumOpts()
{
    ProjectRenderOptions o;
    o.sampleRate = kSr;
    o.blockSize = 128;
    o.loops = 1;
    o.tailSeconds = 0.3;
    o.renderDrums = true;
    return o;
}

/// Peak of |x| in the window [t0, t1) seconds, both channels.
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

TEST_CASE("drum export: the preset blob becomes the engine's own pattern, graphs and lanes", "[export][drums]")
{
    auto p = drumProject(drumBlob({0, 48}, {24}));
    const auto bank = drumBank();
    const auto d = buildDrumsSpec(p, bank, nullptr);
    REQUIRE(d.enabled);
    REQUIRE(d.lanes.size() == 2);
    REQUIRE(d.lanes[0].key == "kick");
    REQUIRE(d.lanes[0].lane == 0);
    REQUIRE(d.lanes[0].volume == Approx(0.8));
    REQUIRE(d.lanes[0].sample != nullptr); // the bank supplied it
    REQUIRE(d.lanes[1].key == "snare");
    REQUIRE(d.lanes[1].lane == 1);
    REQUIRE(d.masterVolume == Approx(0.9));
    REQUIRE(d.ppq == 96);
    REQUIRE(d.pattern != nullptr);
    REQUIRE(d.pattern->bars == 2);
    REQUIRE(d.pattern->stepsPerBar == kDrumStepsPerBar);
    REQUIRE(d.pattern->stepCount == 2 * kDrumStepsPerBar);
    // lane 0 = bit 0, lane 1 = bit 1, at the internal steps the preset stored
    REQUIRE((d.pattern->grid[0] & 1u) != 0);
    REQUIRE((d.pattern->grid[48] & 1u) != 0);
    REQUIRE((d.pattern->grid[24] & 2u) != 0);
    REQUIRE(d.pattern->grid[1] == 0);
}

TEST_CASE("drum export: an old preset stored at its VIEW resolution is upscaled, not played at the wrong speed",
          "[export][drums]")
{
    // no `gridRes` = written before storage was decoupled from the view: the rows are at `stepDivision` (16), so
    // step i lands on internal step i × 96/16 = i × 6 — the same upscale the page does on load
    auto blob = drumBlob({0, 4}, {2}, 16);
    blob.getDynamicObject()->removeProperty("gridRes");
    blob.getDynamicObject()->setProperty("stepDivision", 16);
    auto p = drumProject(blob);
    const auto d = buildDrumsSpec(p, drumBank(), nullptr);
    REQUIRE((d.pattern->grid[0] & 1u) != 0);
    REQUIRE((d.pattern->grid[24] & 1u) != 0); // step 4 × 6
    REQUIRE((d.pattern->grid[12] & 2u) != 0); // step 2 × 6
    REQUIRE(d.pattern->grid[4] == 0);         // NOT left where it was stored
}

TEST_CASE("drum export: mute and solo are resolved before the engine sees them", "[export][drums]")
{
    {
        const auto d = buildDrumsSpec(drumProject(drumBlob({0}, {24}, 96, false, true)), drumBank(), nullptr);
        REQUIRE(!d.lanes[0].audible); // a solo anywhere silences the un-soloed
        REQUIRE(d.lanes[1].audible);
    }
    {
        const auto d = buildDrumsSpec(drumProject(drumBlob({0}, {24}, 96, false, true)), drumBank(), nullptr);
        REQUIRE(!d.lanes[0].audible); // muted
        REQUIRE(d.lanes[1].audible);
    }
}

TEST_CASE("drum export: a lane with no audio still holds its slot, so the graphs keep their lanes", "[export][drums]")
{
    SampleBank bank;
    bank.drumLanes["snare"] = burst(0.15, 0.6f); // the kick's audio is missing
    const auto d = buildDrumsSpec(drumProject(drumBlob({0}, {24})), bank, nullptr);
    REQUIRE(d.lanes.size() == 2);
    REQUIRE(d.lanes[0].sample == nullptr);
    REQUIRE(d.lanes[0].lane == 0);
    REQUIRE(d.lanes[1].lane == 1); // the snare did NOT slide down into lane 0
    REQUIRE(d.lanes[1].sample != nullptr);
}

TEST_CASE("drum export: the drums are IN the bounce, at the sequenced times", "[export][drums]")
{
    // 120 BPM, 96 internal steps per bar → a bar is 2 s, one internal step is 2/96 s. Kick at 0, snare at step 48
    // (= 1.0 s).
    auto p = drumProject(drumBlob({0}, {48}));
    const auto r = renderProject(p, drumBank(), drumOpts());
    REQUIRE(r.buffer.getNumSamples() > static_cast<int>(2.0 * kSr));
    REQUIRE(peakIn(r.buffer, 0.0, 0.05) > 0.05); // the kick lands on the 1
    REQUIRE(peakIn(r.buffer, 0.6, 0.95) < 0.02); // …and nothing between
    REQUIRE(peakIn(r.buffer, 1.0, 1.05) > 0.05); // the snare a second later
}

TEST_CASE("drum export: without renderDrums a project render is chops only, exactly as before", "[export][drums]")
{
    auto p = drumProject(drumBlob({0}, {48}));
    auto opts = drumOpts();
    opts.renderDrums = false;
    const auto r = renderProject(p, drumBank(), opts);
    REQUIRE(peakIn(r.buffer, 0.0, 2.0) == 0.0); // silent: the drums were never rendered
}

TEST_CASE("drum export: each lane sums into its own mixer strip, and can be taken as a trackout", "[export][drums]")
{
    auto p = drumProject(drumBlob({0}, {48}));
    auto opts = drumOpts();
    opts.useMixer = true;
    opts.masterLimiter = false;
    opts.stemChannels = {"kick", "snare"};
    opts.numChannels = 6;
    const auto r = renderProject(p, drumBank(), opts);
    // the kick's trackout has the kick and only the kick; the snare's has the snare
    REQUIRE(peakIn(r.buffer, 0.0, 0.05, 2) > 0.05);
    REQUIRE(peakIn(r.buffer, 1.0, 1.05, 2) < 0.02);
    REQUIRE(peakIn(r.buffer, 0.0, 0.05, 4) < 0.02);
    REQUIRE(peakIn(r.buffer, 1.0, 1.05, 4) > 0.05);
    // …and the master is the two of them summed, sample for sample (no limiter in the way)
    double worst = 0.0;
    for (int i = 0; i < r.buffer.getNumSamples(); ++i)
    {
        const double sum =
            static_cast<double>(r.buffer.getSample(2, i)) + static_cast<double>(r.buffer.getSample(4, i));
        worst = std::max(worst, std::abs(static_cast<double>(r.buffer.getSample(0, i)) - sum));
    }
    INFO("worst master-vs-trackouts difference: " << worst);
    REQUIRE(worst < 1.0e-6);
}

TEST_CASE("drum export: the lanes land on the page's strip numbering", "[export][drums]")
{
    StripNamer namer;
    const auto d = buildDrumsSpec(drumProject(drumBlob({0}, {48})), drumBank(), &namer);
    REQUIRE(d.lanes[0].strip == 2); // 'kick'
    REQUIRE(d.lanes[1].strip == 3); // 'snare'
}
