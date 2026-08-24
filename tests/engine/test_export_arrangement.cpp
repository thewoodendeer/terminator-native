// THE ARRANGEMENT IN THE EXPORT (Phase 4.7a) — the Beat Finisher's song (sections × bars, each with its own chop
// row, drum rows and bass) is a PAGE structure: the arranger preview has always flattened it to absolute-time hits
// itself, and that flattening is the one implementation. What was missing is the other half — an engine render that
// takes those hits and plays them through the real voices, mixer and master, so the FILE is what the app makes a
// sound with instead of a second Web Audio graph's opinion of it.
//
// These are the properties that flattening relies on: a hit lands on its sample, a drum hit carries its own PAN, a
// note-repeat SUB-HIT chokes nothing until its own choke event, a chop can be cut where the next one starts, a
// per-hit REVERSE flips only that hit, and the drum lanes can be bound (samples, mute groups, strips) without the
// sequencer running at all.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include "terminator/core/BassSequencer.h"
#include "terminator/model/Ids.h"
#include "terminator/model/ProjectModel.h"
#include "terminator/render/ProjectRenderer.h"
#include "terminator/render/OfflineRenderer.h"

using namespace terminator;
using namespace terminator::render;
using namespace terminator::model;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;

/// A DC block of `durSec` at `amp` — level and edges are trivial to measure.
std::shared_ptr<SampleBuffer> dcBlock(double durSec, float amp = 0.5f)
{
    auto b = std::make_shared<SampleBuffer>();
    const auto n = static_cast<std::int64_t>(kSr * durSec);
    b->allocate(1, n, kSr);
    for (std::int64_t i = 0; i < n; ++i)
        b->channel(0)[i] = amp;
    return b;
}

/// A ramp 0…1 over its length: the sample INDEX is readable from the output, so a reverse is unmistakable.
std::shared_ptr<SampleBuffer> ramp(double durSec)
{
    auto b = std::make_shared<SampleBuffer>();
    const auto n = static_cast<std::int64_t>(kSr * durSec);
    b->allocate(1, n, kSr);
    for (std::int64_t i = 0; i < n; ++i)
        b->channel(0)[i] = static_cast<float>(i) / static_cast<float>(n - 1);
    return b;
}

RenderPadSpec padOf(int pad, std::shared_ptr<SampleBuffer> buf, PadMode mode = PadMode::oneShot)
{
    RenderPadSpec p;
    p.params.pad = static_cast<std::uint16_t>(pad);
    p.params.mode = mode;
    p.params.attackSec = 0.0f;
    p.params.releaseSec = 0.0f;
    p.params.gain = 1.0f;
    p.params.chokeGroup = -2; // poly: nothing chokes unless the test asks for it
    p.sample = std::move(buf);
    return p;
}

RenderEvent on(int pad, double t, float vel = 1.0f)
{
    RenderEvent e;
    e.pad = static_cast<std::uint16_t>(pad);
    e.timeSec = t;
    e.velocity = vel;
    e.type = RenderEvent::Type::on;
    return e;
}

/// The first sample whose |value| is above `thresh`.
std::int64_t firstAbove(const juce::AudioBuffer<float>& b, float thresh, int ch = 0)
{
    for (int i = 0; i < b.getNumSamples(); ++i)
        if (std::abs(b.getSample(ch, i)) > thresh)
            return i;
    return -1;
}

/// Peak over [from, to).
float peak(const juce::AudioBuffer<float>& b, int from, int to, int ch = 0)
{
    float m = 0.0f;
    for (int i = std::max(0, from); i < std::min(to, b.getNumSamples()); ++i)
        m = std::max(m, std::abs(b.getSample(ch, i)));
    return m;
}

RenderSpec baseSpec(double lengthSec)
{
    RenderSpec s;
    s.sampleRate = kSr;
    s.blockSize = 128;
    s.numChannels = 2;
    s.lengthSeconds = lengthSec;
    return s;
}
} // namespace

TEST_CASE("an arrangement hit lands on its sample, whatever the block size", "[export][arrangement]")
{
    // Deliberately off-grid times: 0.3333 s is inside a block, not on a boundary.
    for (const int block : {32, 128, 512, 1024})
    {
        auto spec = baseSpec(1.0);
        spec.blockSize = block;
        spec.pads.push_back(padOf(0, dcBlock(0.05)));
        spec.events.push_back(on(0, 0.3333));
        const auto r = renderOffline(spec);
        const auto want = static_cast<std::int64_t>(0.3333 * kSr + 0.5);
        const auto got = firstAbove(r.buffer, 0.01f);
        REQUIRE(got >= 0);
        CHECK(got == want);
    }
}

TEST_CASE("a drum hit carries its own PAN", "[export][arrangement]")
{
    auto spec = baseSpec(0.5);
    spec.pads.push_back(padOf(0, dcBlock(0.05)));
    auto hard = on(0, 0.1);
    hard.hasPan = true;
    hard.pan = -1.0f; // fully left
    spec.events.push_back(hard);
    auto right = on(0, 0.3);
    right.hasPan = true;
    right.pan = 1.0f;
    spec.events.push_back(right);
    const auto r = renderOffline(spec);
    const int a = static_cast<int>(0.1 * kSr), b = static_cast<int>(0.3 * kSr);
    CHECK(peak(r.buffer, a + 32, a + 512, 0) > 0.2f);
    CHECK(peak(r.buffer, a + 32, a + 512, 1) < 1e-4f); // nothing on the right
    CHECK(peak(r.buffer, b + 32, b + 512, 1) > 0.2f);
    CHECK(peak(r.buffer, b + 32, b + 512, 0) < 1e-4f);

    // …and a hit with no pan of its own is untouched (both channels, the pad's own setting).
    auto plain = baseSpec(0.3);
    plain.pads.push_back(padOf(0, dcBlock(0.05)));
    plain.events.push_back(on(0, 0.1));
    const auto r2 = renderOffline(plain);
    CHECK(peak(r2.buffer, a + 32, a + 512, 0) == Approx(peak(r2.buffer, a + 32, a + 512, 1)).epsilon(1e-6));
}

TEST_CASE("a REPEAT sub-hit chokes nothing until its own choke event", "[export][arrangement]")
{
    // The pad chokes its own previous voice (chokeGroup −1, the lane default). A roll's sub-hits must NOT: live they
    // bypass the lane registry and the sequencer books their end instead. Four 20 ms sub-hits of a 100 ms block:
    // with self-choke suppressed all four overlap, so the level climbs.
    const double t0 = 0.05, step = 0.02;
    auto withSub = baseSpec(0.4);
    withSub.pads.push_back(padOf(0, dcBlock(0.2, 0.25f)));
    withSub.pads.back().params.chokeGroup = -1;
    withSub.pads.back().params.chokeFadeSec = 0.004f;
    for (int i = 0; i < 4; ++i)
    {
        auto e = on(0, t0 + step * static_cast<double>(i));
        e.subHit = true;
        withSub.events.push_back(e);
    }
    const auto sub = renderOffline(withSub);

    auto plain = baseSpec(0.4);
    plain.pads.push_back(padOf(0, dcBlock(0.2, 0.25f)));
    plain.pads.back().params.chokeGroup = -1;
    plain.pads.back().params.chokeFadeSec = 0.004f;
    for (int i = 0; i < 4; ++i)
        plain.events.push_back(on(0, t0 + step * static_cast<double>(i)));
    const auto flat = renderOffline(plain);

    const int tail = static_cast<int>((t0 + step * 3.0 + 0.005) * kSr);
    const float subPeak = peak(sub.buffer, tail, tail + 256);
    const float flatPeak = peak(flat.buffer, tail, tail + 256);
    CHECK(subPeak > flatPeak * 2.0f); // four voices stacked vs one survivor

    // The choke event ends them, and only them, with the pad's choke fade.
    auto choked = withSub;
    RenderEvent ch;
    ch.pad = 0;
    ch.timeSec = t0 + step * 3.0 + 0.01;
    ch.type = RenderEvent::Type::chokeSubHits;
    choked.events.push_back(ch);
    const auto cut = renderOffline(choked);
    const int after = static_cast<int>((ch.timeSec + 0.006) * kSr);
    CHECK(peak(cut.buffer, after, after + 256) < 1e-3f);
    CHECK(peak(cut.buffer, static_cast<int>(ch.timeSec * kSr) - 256, static_cast<int>(ch.timeSec * kSr)) > 0.2f);
}

TEST_CASE("a chop can be cut where the next one starts", "[export][arrangement]")
{
    // `stopAt` is the arrangement's maxDur: a one-shot ignores a note-off, so cutting it needs the choke fade.
    auto spec = baseSpec(1.0);
    spec.pads.push_back(padOf(0, dcBlock(0.5)));
    spec.pads.back().params.chokeFadeSec = 0.003f;
    spec.events.push_back(on(0, 0.1));
    RenderEvent cut;
    cut.pad = 0;
    cut.timeSec = 0.2;
    cut.type = RenderEvent::Type::stopAt;
    spec.events.push_back(cut);
    const auto r = renderOffline(spec);
    CHECK(peak(r.buffer, static_cast<int>(0.15 * kSr), static_cast<int>(0.19 * kSr)) > 0.4f);
    CHECK(peak(r.buffer, static_cast<int>(0.21 * kSr), static_cast<int>(0.45 * kSr)) < 1e-3f);

    // Without the cut the same pad rings on — so the silence above is the event, not the sample running out.
    auto uncut = baseSpec(1.0);
    uncut.pads.push_back(padOf(0, dcBlock(0.5)));
    uncut.events.push_back(on(0, 0.1));
    const auto r2 = renderOffline(uncut);
    CHECK(peak(r2.buffer, static_cast<int>(0.21 * kSr), static_cast<int>(0.45 * kSr)) > 0.4f);
}

TEST_CASE("a per-hit REVERSE flips only that hit", "[export][arrangement]")
{
    // The ramp reads 0 → 1. Forward, the hit starts near 0; reversed it starts near 1. Two hits of the SAME pad,
    // one of each, and the second must not inherit the first's flip.
    auto spec = baseSpec(1.0);
    spec.pads.push_back(padOf(0, ramp(0.1)));
    auto rev = on(0, 0.1);
    rev.reverse = 1;
    spec.events.push_back(rev);
    auto fwd = on(0, 0.4);
    fwd.reverse = 0;
    spec.events.push_back(fwd);
    const auto r = renderOffline(spec);
    const int a = static_cast<int>(0.1 * kSr) + 8, b = static_cast<int>(0.4 * kSr) + 8;
    CHECK(r.buffer.getSample(0, a) > 0.9f);  // reversed: starts at the tail of the ramp
    CHECK(r.buffer.getSample(0, b) < 0.05f); // forward again
}

TEST_CASE("drum lanes can be bound without the sequencer running", "[export][arrangement]")
{
    // eventDriven: the lanes get their samples, mute groups, choke fades and strips, but nothing plays until an
    // event says so. (A pattern left in the spec must be ignored — the arrangement is not one looping pattern.)
    auto spec = baseSpec(0.6);
    spec.tempoBpm = 120.0;
    spec.drums.enabled = true;
    spec.drums.eventDriven = true;
    RenderDrumLane kick;
    kick.lane = 0;
    kick.key = "kick";
    kick.sample = dcBlock(0.05, 0.5f);
    kick.muteGroup = 0;
    spec.drums.lanes.push_back(kick);
    RenderDrumLane hat;
    hat.lane = 1;
    hat.key = "hat";
    hat.sample = dcBlock(0.05, 0.5f);
    hat.muteGroup = 3; // hat + openhat share a group live
    spec.drums.lanes.push_back(hat);
    RenderDrumLane openhat;
    openhat.lane = 2;
    openhat.key = "openhat";
    openhat.sample = dcBlock(0.2, 0.5f);
    openhat.muteGroup = 3;
    spec.drums.lanes.push_back(openhat);

    const auto silent = renderOffline(spec);
    CHECK(peak(silent.buffer, 0, silent.buffer.getNumSamples()) < 1e-6f); // no pattern ran

    // Now the hits, as the page flattens them: lane L is pad kDrumPadBase + L.
    spec.events.push_back(on(kDrumPadBase + 0, 0.05, 0.8f));
    spec.events.push_back(on(kDrumPadBase + 2, 0.10)); // openhat rings 200 ms…
    spec.events.push_back(on(kDrumPadBase + 1, 0.15)); // …until the hat in its mute group cuts it
    const auto r = renderOffline(spec);
    CHECK(peak(r.buffer, static_cast<int>(0.05 * kSr) + 16, static_cast<int>(0.07 * kSr)) > 0.2f);
    // The group choke is the ENGINE's: 4 ms after the hat, the open hat's own 200 ms tail is gone (only the hat's
    // 50 ms remains, so by 60 ms after the hat everything is silent).
    CHECK(peak(r.buffer, static_cast<int>(0.22 * kSr), static_cast<int>(0.29 * kSr)) < 1e-3f);
}

TEST_CASE("the arrangement's BASS is a timeline, not an 8-bar loop", "[export][arrangement][bass]")
{
    // A BassPattern tops out at 8 bars / 512 notes, so a song's bass line cannot BE a pattern. The same
    // `BassTimeline` the live arranger preview sends drives it instead: absolute samples, no pattern transport.
    auto spec = baseSpec(2.0);
    spec.tempoBpm = 90.0;
    spec.bass.enabled = true;
    spec.bass.patch = std::make_shared<BassPatch>();
    auto tl = std::make_shared<BassTimeline>();
    const auto at = static_cast<std::uint64_t>(0.5 * kSr);
    REQUIRE(tl->add(BassSynth::EventKind::on, at, 40, 1.0f, 0.0));
    REQUIRE(tl->add(BassSynth::EventKind::off, at + static_cast<std::uint64_t>(0.4 * kSr), 40, 0.0f, 0.0));
    spec.bass.timeline = tl;
    const auto r = renderOffline(spec);

    // Silent before the note, sounding through it, and gone well after the off (no pattern loop underneath).
    CHECK(peak(r.buffer, 0, static_cast<int>(0.49 * kSr)) < 1e-4f);
    CHECK(peak(r.buffer, static_cast<int>(0.52 * kSr), static_cast<int>(0.85 * kSr)) > 0.02f);
    CHECK(peak(r.buffer, static_cast<int>(1.5 * kSr), static_cast<int>(2.0 * kSr)) < 1e-3f);

    // With NO timeline and no pattern the bass is silent — the timeline is what made the sound.
    auto quiet = spec;
    quiet.bass.timeline.reset();
    const auto r2 = renderOffline(quiet);
    CHECK(peak(r2.buffer, 0, r2.buffer.getNumSamples()) < 1e-4f);
}

// ---- the project-level path: arrangement TIMING, project SOUND -------------------------------------------------

namespace
{
/// A project with one drum lane ('kick', mute group 0) and a 2-bar 1/16 sequence that fires pad 0 on step 0 — so a
/// SEQUENCE render makes exactly one chop hit at t = 0, and an ARRANGEMENT render must ignore that and play its own.
juce::ValueTree seqProject()
{
    auto p = model::createEmptyProject();
    p.setProperty(ids::metronomeBpm, 120, nullptr);
    auto* track = new juce::DynamicObject();
    track->setProperty("key", "kick");
    track->setProperty("volume", 1.0);
    juce::Array<juce::var> tracks;
    tracks.add(juce::var(track));
    auto* seqRow = new juce::DynamicObject();
    juce::Array<juce::var> row;
    for (int i = 0; i < 192; ++i)
        row.add(false);
    seqRow->setProperty("kick", juce::var(row));
    juce::Array<juce::var> dseqs;
    dseqs.add(juce::var(seqRow));
    auto* drums = new juce::DynamicObject();
    drums->setProperty("tracks", juce::var(tracks));
    drums->setProperty("sequences", juce::var(dseqs));
    drums->setProperty("seqIndex", 0);
    drums->setProperty("bars", 2);
    drums->setProperty("masterVolume", 1.0);
    drums->setProperty("gridRes", 96);
    drums->setProperty("ppq", 96);
    p.setProperty(ids::drums, juce::var(drums), nullptr);

    auto pads = p.getChildWithName(ids::Pads);
    juce::ValueTree pad(ids::Pad);
    pad.setProperty(ids::index, 0, nullptr);
    pad.setProperty(ids::mode, "oneshot", nullptr);
    pads.appendChild(pad, nullptr);
    auto srcs = p.getChildWithName(ids::PadSources);
    juce::ValueTree src(ids::PadSource);
    src.setProperty(ids::pad, 0, nullptr);
    src.setProperty(ids::videoId, "src", nullptr);
    src.setProperty(ids::title, "src", nullptr);
    src.setProperty(ids::start, 0.0, nullptr);
    src.setProperty(ids::end, 0.1, nullptr);
    srcs.appendChild(src, nullptr);

    auto seqs = p.getChildWithName(ids::Sequences);
    seqs.removeAllChildren(nullptr);
    juce::ValueTree seq(ids::Sequence);
    seq.setProperty(ids::bars, 2, nullptr);
    seq.setProperty(ids::resolution, 16, nullptr);
    seq.setProperty(ids::viewResolution, 16, nullptr);
    seq.setProperty(ids::loop, true, nullptr);
    juce::Array<juce::var> stepRow;
    juce::Array<juce::var> firstStep;
    firstStep.add(0);
    stepRow.add(juce::var(firstStep));
    seq.setProperty(ids::grid, juce::var(stepRow), nullptr);
    seq.setProperty(ids::velGrid, juce::var(juce::Array<juce::var>()), nullptr);
    seq.setProperty(ids::revGrid, juce::var(juce::Array<juce::var>()), nullptr);
    seqs.appendChild(seq, nullptr);
    p.setProperty(ids::currentSeqIdx, 0, nullptr);
    return p;
}

SampleBank arrBank()
{
    SampleBank b;
    b.bySourceVideoId["src"] = dcBlock(0.1, 0.5f);
    b.drumLanes["kick"] = dcBlock(0.05, 0.5f);
    return b;
}
} // namespace

TEST_CASE("arrangement mode replaces the sequence schedule and keeps the project's sound", "[export][arrangement]")
{
    const auto project = seqProject();
    const auto bank = arrBank();
    ProjectRenderOptions opts;
    opts.sampleRate = kSr;
    opts.blockSize = 128;
    opts.tailSeconds = 0.2;
    opts.renderDrums = true;

    // SEQUENCE mode: the one chop hit is at t = 0 and the render is the pattern's length. (A project pad has its
    // own short attack, so the level crosses a threshold a sample or two after the trigger — the SAMPLE-exact
    // landing is gated on bare specs above, where the attack is 0.)
    const auto seqRender = renderProject(project, bank, opts);
    CHECK(firstAbove(seqRender.buffer, 0.01f) <= 4);

    // ARRANGEMENT mode: the page's flattened song. Chop pad 0 at 1.5 s, the drum lane at 1.75 s — nothing at 0,
    // because the project's sequence is not what is being rendered.
    auto arr = opts;
    arr.arrangementEvents.push_back(on(0, 1.5));
    arr.arrangementEvents.push_back(on(kDrumPadBase + 0, 1.75));
    arr.arrangementLengthSeconds = 2.0;
    const auto r = renderProject(project, bank, arr);
    CHECK(peak(r.buffer, 0, static_cast<int>(1.49 * kSr)) < 1e-6f);
    CHECK(std::abs(firstAbove(r.buffer, 0.01f) - static_cast<std::int64_t>(1.5 * kSr)) <= 4);
    CHECK(peak(r.buffer, static_cast<int>(1.76 * kSr), static_cast<int>(1.79 * kSr)) > 0.2f);
    // The length is the SONG's (2 s + the tail), not the project pattern's.
    CHECK(r.buffer.getNumSamples() == static_cast<int>((2.0 + 0.2) * kSr + 0.5));

    // A hit on a pad the bank has no audio for is dropped, exactly as a sequence hit is — not a crash, not silence
    // where the rest of the song should be.
    auto ghost = arr;
    ghost.arrangementEvents.insert(ghost.arrangementEvents.begin(), on(37, 0.5));
    const auto r2 = renderProject(project, bank, ghost);
    CHECK(peak(r2.buffer, 0, static_cast<int>(1.49 * kSr)) < 1e-6f);
    CHECK(std::abs(firstAbove(r2.buffer, 0.01f) - static_cast<std::int64_t>(1.5 * kSr)) <= 4);
}
