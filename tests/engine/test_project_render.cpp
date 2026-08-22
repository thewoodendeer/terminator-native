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
