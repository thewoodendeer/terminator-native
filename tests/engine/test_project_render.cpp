// ProjectRenderer: a project + a bank of synthetic samples renders through the SAME offline Engine as playback.
// This is the export spine — it proves the planner→engine→audio path end to end: a two-pad kit with a 1/16
// pattern renders master audio with energy at the sequenced times, velocity scaled, and a chop of the main
// buffer plays its region.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>

#include "terminator/model/Ids.h"
#include "terminator/model/ProjectModel.h"
#include "terminator/render/ProjectRenderer.h"
#ifndef M_PI
#define M_PI 3.14159265358979323846 // MSVC does not define M_PI without _USE_MATH_DEFINES
#endif

using namespace terminator;
using namespace terminator::render;
using namespace terminator::model;
using Catch::Approx;

namespace
{
std::shared_ptr<SampleBuffer> click(double sr, double durSec, float amp)
{
    auto b = std::make_shared<SampleBuffer>();
    const auto n = static_cast<std::int64_t>(sr * durSec);
    b->allocate(1, n, sr);
    for (std::int64_t i = 0; i < n; ++i) // a short decaying burst
        b->channel(0)[i] = amp * static_cast<float>(std::exp(-8.0 * static_cast<double>(i) / static_cast<double>(n)) *
                                                    std::sin(2.0 * M_PI * 200.0 * static_cast<double>(i) / sr));
    return b;
}
double rmsWindow(const juce::AudioBuffer<float>& buf, double sr, double t0, double t1)
{
    const int a = std::max(0, static_cast<int>(t0 * sr));
    const int b = std::min(buf.getNumSamples(), static_cast<int>(t1 * sr));
    double e = 0;
    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
        for (int i = a; i < b; ++i)
            e += static_cast<double>(buf.getSample(ch, i)) * static_cast<double>(buf.getSample(ch, i));
    return b > a ? std::sqrt(e / ((b - a) * buf.getNumChannels())) : 0.0;
}
juce::ValueTree kitProject()
{
    auto p = model::createEmptyProject();
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
        s.setProperty(ids::title, "x", nullptr);
        s.setProperty(ids::start, 0.0, nullptr);
        s.setProperty(ids::end, 0.2, nullptr);
        srcs.appendChild(s, nullptr);
    }
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
        } // kick on the 1
        if (s == 8)
        {
            row.add(1);
            vrow.add(1.0);
        } // snare on the 3 (loud)
        if (s == 12)
        {
            row.add(1);
            vrow.add(0.2);
        } // snare, quiet
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

TEST_CASE("render: a 1/16 kit pattern renders master audio at the sequenced times, velocity scaled", "[render]")
{
    const double sr = 48000.0;
    auto p = kitProject();
    SampleBank bank;
    bank.bySourceVideoId["kick"] = click(sr, 0.2, 0.9f);
    bank.bySourceVideoId["snare"] = click(sr, 0.2, 0.9f);
    ProjectRenderOptions opts;
    opts.sampleRate = sr;
    auto r = renderProject(p, bank, opts);
    REQUIRE(r.buffer.getNumSamples() > 0);
    const double stepDur = (60.0 / 120.0) * (4.0 / 16.0); // 0.125 s
    // energy present just after each hit, silence just before the first
    CHECK(rmsWindow(r.buffer, sr, 0.0, 0.01) > 0.01);                       // kick@0
    CHECK(rmsWindow(r.buffer, sr, 8 * stepDur, 8 * stepDur + 0.01) > 0.01); // snare@8 loud
    const double loud = rmsWindow(r.buffer, sr, 8 * stepDur, 8 * stepDur + 0.03);
    const double quiet = rmsWindow(r.buffer, sr, 12 * stepDur, 12 * stepDur + 0.03);
    CHECK(quiet > 0.001);
    CHECK(quiet < loud * 0.5); // velocity 0.2 vs 1.0
    // a gap with no hit is quiet (between kick@0's decay and snare@8) — check right before snare@8
    CHECK(rmsWindow(r.buffer, sr, 8 * stepDur - 0.01, 8 * stepDur) < loud * 0.5);
}

TEST_CASE("render: a main-track chop plays its region of the main buffer", "[render]")
{
    const double sr = 48000.0;
    auto p = model::createEmptyProject();
    p.setProperty(ids::videoId, "song", nullptr);
    // one chop [1.0, 1.2) on pad 0
    auto chops = p.getChildWithName(ids::Chops);
    juce::ValueTree c(ids::Chop);
    c.setProperty(ids::id, 1, nullptr);
    c.setProperty(ids::start, 1.0, nullptr);
    c.setProperty(ids::end, 1.2, nullptr);
    chops.appendChild(c, nullptr);
    juce::ValueTree pad(ids::Pad);
    pad.setProperty(ids::index, 0, nullptr);
    pad.setProperty(ids::chopId, 1, nullptr);
    pad.setProperty(ids::pitch, 0, nullptr);
    pad.setProperty(ids::mode, "oneshot", nullptr);
    p.getChildWithName(ids::Pads).appendChild(pad, nullptr);
    // sequence fires pad 0 on step 0
    auto seq = p.getChildWithName(ids::Sequences).getChild(0);
    seq.setProperty(ids::resolution, 16, nullptr);
    seq.setProperty(ids::viewResolution, 16, nullptr);
    seq.setProperty(ids::bars, 1, nullptr);
    juce::Array<juce::var> grid;
    for (int s = 0; s < 16; ++s)
    {
        juce::Array<juce::var> row;
        if (s == 0)
            row.add(0);
        grid.add(juce::var(row));
    }
    seq.setProperty(ids::grid, juce::var(grid), nullptr);
    p.setProperty(ids::metronomeBpm, 120, nullptr);

    // main buffer: silent everywhere except a burst inside [1.0, 1.2)
    auto main = std::make_shared<SampleBuffer>();
    main->allocate(1, static_cast<std::int64_t>(sr * 3), sr);
    for (std::int64_t i = static_cast<std::int64_t>(sr * 1.0); i < static_cast<std::int64_t>(sr * 1.2); ++i)
        main->channel(0)[i] = 0.8f * static_cast<float>(std::sin(2.0 * M_PI * 300.0 * static_cast<double>(i) / sr));
    SampleBank bank;
    bank.mainBuffer = main;
    ProjectRenderOptions opts;
    opts.sampleRate = sr;
    auto r = renderProject(p, bank, opts);
    // the chop's region [1.0,1.2) is a burst → the render's start (t≈0) has energy
    CHECK(rmsWindow(r.buffer, sr, 0.0, 0.15) > 0.05);
}

// ── voice-engine tail parity (startVoice: per-source NORM, fadeIn → attack, RELEASE, loop render, stems) ──
namespace
{
/// A one-pad project firing pad 0 on step 0 of a 1-bar 1/16 pattern at 120 BPM (2 s); the caller adds the source.
juce::ValueTree onePadProject(const juce::String& mode = "oneshot")
{
    auto p = model::createEmptyProject();
    p.setProperty(ids::videoId, "song", nullptr);
    juce::ValueTree pad(ids::Pad);
    pad.setProperty(ids::index, 0, nullptr);
    pad.setProperty(ids::pitch, 0, nullptr);
    pad.setProperty(ids::mode, mode, nullptr);
    p.getChildWithName(ids::Pads).appendChild(pad, nullptr);
    auto seq = p.getChildWithName(ids::Sequences).getChild(0);
    seq.setProperty(ids::resolution, 16, nullptr);
    seq.setProperty(ids::viewResolution, 16, nullptr);
    seq.setProperty(ids::bars, 1, nullptr);
    juce::Array<juce::var> grid;
    for (int s = 0; s < 16; ++s)
    {
        juce::Array<juce::var> row;
        if (s == 0)
            row.add(0);
        grid.add(juce::var(row));
    }
    seq.setProperty(ids::grid, juce::var(grid), nullptr);
    p.setProperty(ids::metronomeBpm, 120, nullptr);
    return p;
}
void addMainChop(juce::ValueTree& p, double startSec, double endSec)
{
    juce::ValueTree c(ids::Chop);
    c.setProperty(ids::id, 1, nullptr);
    c.setProperty(ids::start, startSec, nullptr);
    c.setProperty(ids::end, endSec, nullptr);
    p.getChildWithName(ids::Chops).appendChild(c, nullptr);
    p.getChildWithName(ids::Pads).getChild(0).setProperty(ids::chopId, 1, nullptr);
}
void addPadSource(juce::ValueTree& p, const juce::String& videoId, double startSec, double endSec)
{
    juce::ValueTree s(ids::PadSource);
    s.setProperty(ids::pad, 0, nullptr);
    s.setProperty(ids::videoId, videoId, nullptr);
    s.setProperty(ids::title, "x", nullptr);
    s.setProperty(ids::start, startSec, nullptr);
    s.setProperty(ids::end, endSec, nullptr);
    p.getChildWithName(ids::PadSources).appendChild(s, nullptr);
}
juce::var rangesVar(double a, double b)
{
    juce::Array<juce::var> pair;
    pair.add(a);
    pair.add(b);
    juce::Array<juce::var> arr;
    arr.add(juce::var(pair));
    return juce::var(arr);
}
std::shared_ptr<SampleBuffer> dcBuf(double sr, double sec, float v)
{
    auto b = std::make_shared<SampleBuffer>();
    b->allocate(1, static_cast<std::int64_t>(sr * sec), sr);
    std::fill(b->data.begin(), b->data.end(), v);
    return b;
}
double maxStep(const juce::AudioBuffer<float>& buf, int from, int to)
{
    double m = 0.0;
    for (int i = from + 1; i < to; ++i)
        m = std::max(m,
                     std::abs(static_cast<double>(buf.getSample(0, i)) - static_cast<double>(buf.getSample(0, i - 1))));
    return m;
}
} // namespace

TEST_CASE("render: per-source NORM rides the voice — a pad-source pad with SourceNorm 0.5 renders at half level; "
          "a main chop stays at unity",
          "[render][norm]")
{
    const double sr = 48000.0;
    auto p = onePadProject();
    addPadSource(p, "vid", 0.0, 0.5);
    SampleBank bank;
    bank.bySourceVideoId["vid"] = dcBuf(sr, 0.5, 0.5f);
    ProjectRenderOptions opts;
    opts.sampleRate = sr;
    const double plain = rmsWindow(renderProject(p, bank, opts).buffer, sr, 0.01, 0.05);
    CHECK(plain == Approx(0.5).epsilon(0.01));
    mapSet(p.getChildWithName(ids::SourceNorm), "src:vid", 0.5, nullptr); // NORM on that source
    const double normed = rmsWindow(renderProject(p, bank, opts).buffer, sr, 0.01, 0.05);
    CHECK(normed == Approx(plain * 0.5).epsilon(0.01));
    // the spec carries it as the pad gain; a main-track chop keeps gain 1 (main NORM lives on the master bus)
    CHECK(buildProjectRenderSpec(p, bank, opts).pads[0].params.gain == Approx(0.5f));
    auto m = onePadProject();
    addMainChop(m, 0.0, 0.5);
    mapSet(m.getChildWithName(ids::SourceNorm), "src:vid", 0.5, nullptr);
    SampleBank mb;
    mb.mainBuffer = dcBuf(sr, 1.0, 0.5f);
    CHECK(buildProjectRenderSpec(m, mb, opts).pads[0].params.gain == Approx(1.0f));
}

TEST_CASE("render: one-shot attack = max(source attack, fadeIn / playbackRate); RELEASE = Master.release",
          "[render][env]")
{
    const double sr = 48000.0;
    auto p = onePadProject();
    addMainChop(p, 0.0, 1.0);
    auto pad = p.getChildWithName(ids::Pads).getChild(0);
    pad.setProperty(ids::fadeIn, 0.2, nullptr);
    pad.setProperty(ids::pitch, 12, nullptr); // rate 2 → the fade-in is 0.1 s of context time
    auto master = p.getChildWithName(ids::Master);
    if (!master.isValid())
    {
        master = juce::ValueTree(ids::Master);
        p.appendChild(master, nullptr);
    }
    master.setProperty(ids::release, 0.25, nullptr);
    SampleBank bank;
    bank.mainBuffer = dcBuf(sr, 2.0, 0.5f);
    ProjectRenderOptions opts;
    opts.sampleRate = sr;
    const auto spec = buildProjectRenderSpec(p, bank, opts);
    REQUIRE(spec.pads.size() == 1);
    CHECK(spec.pads[0].params.attackSec == Approx(0.1f));
    CHECK(spec.pads[0].params.releaseSec == Approx(0.25f));
    pad.setProperty(ids::fadeIn, 0.001, nullptr); // shorter than the source attack (3 ms default) → attack wins
    CHECK(buildProjectRenderSpec(p, bank, opts).pads[0].params.attackSec == Approx(0.003f));
    pad.setProperty(ids::mode, "loop", nullptr); // LOOP renders the fade-in into the loop buffer, not the attack
    pad.setProperty(ids::fadeIn, 0.2, nullptr);
    CHECK(buildProjectRenderSpec(p, bank, opts).pads[0].params.attackSec == Approx(0.003f));
}

TEST_CASE("render: a LOOP pad with fades renders the crossfade loop and plays a seamless period; without fades the "
          "raw wrap clicks",
          "[render][loop]")
{
    const double sr = 48000.0;
    // a 137.3 Hz sine: the region [1000, 13000) frames is never a whole number of cycles
    auto main = std::make_shared<SampleBuffer>();
    main->allocate(1, static_cast<std::int64_t>(sr * 2), sr);
    for (std::int64_t i = 0; i < main->numFrames; ++i)
        main->channel(0)[i] = static_cast<float>(std::sin(2.0 * M_PI * 137.3 * static_cast<double>(i) / sr));
    double natural = 0.0;
    for (std::int64_t i = 1001; i < 13000; ++i)
        natural = std::max(natural, std::abs(static_cast<double>(main->channel(0)[i] - main->channel(0)[i - 1])));
    SampleBank bank;
    bank.mainBuffer = main;
    ProjectRenderOptions opts;
    opts.sampleRate = sr;
    opts.tailSeconds = 0.0;
    auto p = onePadProject("loop");
    addMainChop(p, 1000.0 / sr, 13000.0 / sr);
    auto pad = p.getChildWithName(ids::Pads).getChild(0);
    {
        // raw loop: the seam is a click (the thing the fades cure)
        const auto spec = buildProjectRenderSpec(p, bank, opts);
        REQUIRE(spec.pads.size() == 1);
        CHECK(spec.pads[0].loopSample == nullptr);
        auto r = renderOffline(spec);
        CHECK(maxStep(r.buffer, 0, static_cast<int>(sr * 1.9)) > natural * 3);
    }
    pad.setProperty(ids::fadeIn, 2000.0 / sr, nullptr);
    pad.setProperty(ids::fadeOut, 2000.0 / sr, nullptr);
    {
        const auto spec = buildProjectRenderSpec(p, bank, opts);
        REQUIRE(spec.pads[0].loopSample != nullptr);
        CHECK(spec.pads[0].loopEnd - spec.pads[0].loopStart == 10000); // period = region − fadeOut
        CHECK(spec.pads[0].loopStart == 20000);                        // M = ceil(12000/10000) = 2 warm-up passes
        auto r = renderOffline(spec);
        // 1.9 s = 91 200 samples ≈ 7 wraps of the steady period: no step anywhere above 2 summed passes
        CHECK(rmsWindow(r.buffer, sr, 1.0, 1.9) > 0.3); // it is really looping for the whole bar
        CHECK(maxStep(r.buffer, 100, static_cast<int>(sr * 1.9)) <= natural * 2.05);
    }
}

TEST_CASE("render: a masked pad renders its stem planes' sum when the span is ready; unready / ALL = the original; "
          "pad sources read SourceStems",
          "[render][stems]")
{
    const double sr = 48000.0;
    SampleBank bank;
    bank.mainBuffer = dcBuf(sr, 3.0, 0.9f);
    bank.mainStems = {dcBuf(sr, 3.0, 0.1f), dcBuf(sr, 3.0, 0.2f), dcBuf(sr, 3.0, 0.3f), dcBuf(sr, 3.0, 0.4f)};
    ProjectRenderOptions opts;
    opts.sampleRate = sr;
    auto p = onePadProject();
    addMainChop(p, 0.5, 1.0);
    auto pad = p.getChildWithName(ids::Pads).getChild(0);
    pad.setProperty(ids::stems, 0b0011, nullptr); // drums + bass
    // no Stems node / no ready ranges → the original (never silence)
    CHECK(rmsWindow(renderProject(p, bank, opts).buffer, sr, 0.01, 0.05) == Approx(0.9).epsilon(0.01));
    auto stemsN = p.getChildWithName(ids::Stems);
    if (!stemsN.isValid())
    {
        stemsN = juce::ValueTree(ids::Stems);
        p.appendChild(stemsN, nullptr);
    }
    stemsN.setProperty(ids::readyRanges, rangesVar(0.0, 0.7), nullptr); // covers only part of the chop
    CHECK(rmsWindow(renderProject(p, bank, opts).buffer, sr, 0.01, 0.05) == Approx(0.9).epsilon(0.01));
    stemsN.setProperty(ids::readyRanges, rangesVar(0.0, 3.0), nullptr); // ready
    CHECK(rmsWindow(renderProject(p, bank, opts).buffer, sr, 0.01, 0.05) == Approx(0.3).epsilon(0.01));
    const auto spec = buildProjectRenderSpec(p, bank, opts);
    CHECK(spec.pads[0].stemMask == 0b0011);
    CHECK(spec.pads[0].stems[0] == bank.mainStems[0]);
    pad.setProperty(ids::stems, 15, nullptr); // ALL = the original again
    CHECK(rmsWindow(renderProject(p, bank, opts).buffer, sr, 0.01, 0.05) == Approx(0.9).epsilon(0.01));
    pad.removeProperty(ids::stems, nullptr);
    CHECK(rmsWindow(renderProject(p, bank, opts).buffer, sr, 0.01, 0.05) == Approx(0.9).epsilon(0.01));

    SECTION("a pad-source pad reads the stems of its OWN sample (SourceStems by videoId)")
    {
        auto q = onePadProject();
        addPadSource(q, "vid", 0.0, 0.5);
        q.getChildWithName(ids::Pads).getChild(0).setProperty(ids::stems, 0b1000, nullptr); // vocals only
        SampleBank sb;
        sb.bySourceVideoId["vid"] = dcBuf(sr, 1.0, 0.9f);
        sb.stemsBySourceVideoId["vid"] = {dcBuf(sr, 1.0, 0.1f), dcBuf(sr, 1.0, 0.2f), dcBuf(sr, 1.0, 0.3f),
                                          dcBuf(sr, 1.0, 0.4f)};
        CHECK(rmsWindow(renderProject(q, sb, opts).buffer, sr, 0.01, 0.05) == Approx(0.9).epsilon(0.01));
        auto ss = q.getChildWithName(ids::SourceStems);
        if (!ss.isValid())
        {
            ss = juce::ValueTree(ids::SourceStems);
            q.appendChild(ss, nullptr);
        }
        juce::ValueTree set(ids::SourceStem);
        set.setProperty(ids::videoId, "vid", nullptr);
        set.setProperty(ids::readyRanges, rangesVar(0.0, 1.0), nullptr);
        ss.appendChild(set, nullptr);
        CHECK(rmsWindow(renderProject(q, sb, opts).buffer, sr, 0.01, 0.05) == Approx(0.4).epsilon(0.01));
    }
    SECTION("a LOOP pad with fades renders its loop from the stem mix")
    {
        auto q = onePadProject("loop");
        addMainChop(q, 0.5, 1.0);
        auto lp = q.getChildWithName(ids::Pads).getChild(0);
        lp.setProperty(ids::stems, 0b0100, nullptr); // other = 0.3
        lp.setProperty(ids::fadeIn, 0.05, nullptr);
        auto sn = q.getChildWithName(ids::Stems);
        if (!sn.isValid())
        {
            sn = juce::ValueTree(ids::Stems);
            q.appendChild(sn, nullptr);
        }
        sn.setProperty(ids::readyRanges, rangesVar(0.0, 3.0), nullptr);
        const auto loopSpec = buildProjectRenderSpec(q, bank, opts);
        REQUIRE(loopSpec.pads[0].loopSample != nullptr);
        // the steady period of the loop render is the stem mix (DC 0.3), not the original (0.9)
        const auto& lb = *loopSpec.pads[0].loopSample;
        CHECK(lb.channel(0)[loopSpec.pads[0].loopStart + 12000] == Approx(0.3f).margin(1e-3)); // past the fade-in
    }
}
