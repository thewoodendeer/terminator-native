// THE PROJECT'S MIX IN THE EXPORT (Phase 4.5b) — the project file carries the mixer as an opaque blob (the page's
// MixerPreset: channels / master / console). This turns it into the render spec, routes every pad into the strip
// its route names, and keeps the page's strip NUMBERING so a saved chain lands where it was saved. Once that is
// true, `renderProject` produces the bytes the mixer is actually making, and trackouts fall out of the same render.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "terminator/model/Ids.h"
#include "terminator/model/ProjectModel.h"
#include "terminator/render/ProjectRenderer.h"
#ifndef M_PI
#define M_PI 3.14159265358979323846
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
    for (std::int64_t i = 0; i < n; ++i)
        b->channel(0)[i] = amp * static_cast<float>(std::exp(-8.0 * static_cast<double>(i) / static_cast<double>(n)) *
                                                    std::sin(2.0 * M_PI * 200.0 * static_cast<double>(i) / sr));
    return b;
}
double peakOf(const juce::AudioBuffer<float>& b, int ch)
{
    double pk = 0.0;
    for (int i = 0; i < b.getNumSamples(); ++i)
        pk = std::max(pk, std::abs(static_cast<double>(b.getSample(ch, i))));
    return pk;
}

/// Two pads, each its own source, one hit apiece; pad 0 routed to 'kick' and pad 1 to 'snare'.
juce::ValueTree twoPadProject()
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
    // the page's routes: pad 0 → the 'kick' strip, pad 1 → the 'snare' strip
    auto routes = p.getChildWithName(ids::PadRoutes);
    for (int i = 0; i < 2; ++i)
    {
        juce::ValueTree e(ids::Entry);
        e.setProperty(ids::key, juce::String(i), nullptr);
        e.setProperty(ids::value, i == 0 ? "kick" : "snare", nullptr);
        routes.appendChild(e, nullptr);
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
            row.add(1);
            vrow.add(1.0);
        } // both pads on the 1
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

/// The page's MixerPreset blob.
juce::var mixerBlob(double kickFaderDb, bool consoleOn = false)
{
    auto* kick = new juce::DynamicObject();
    kick->setProperty("fader", kickFaderDb);
    kick->setProperty("pan", 0.0);
    kick->setProperty("mute", false);
    kick->setProperty("solo", false);
    auto* channels = new juce::DynamicObject();
    channels->setProperty("kick", juce::var(kick));
    auto* master = new juce::DynamicObject();
    master->setProperty("fader", 0.0);
    auto* con = new juce::DynamicObject();
    con->setProperty("on", consoleOn);
    con->setProperty("flavour", "neve");
    con->setProperty("amount", 80.0);
    auto* blob = new juce::DynamicObject();
    blob->setProperty("channels", juce::var(channels));
    blob->setProperty("master", juce::var(master));
    blob->setProperty("console", juce::var(con));
    return juce::var(blob);
}

ProjectRenderOptions mixOpts(double sr)
{
    ProjectRenderOptions o;
    o.sampleRate = sr;
    o.blockSize = 128;
    o.loops = 1;
    o.tailSeconds = 0.3;
    o.useMixer = true;
    return o;
}
} // namespace

TEST_CASE("project export: the page's strip numbering is kept, so a saved chain lands where it was saved", "[export]")
{
    StripNamer n;
    REQUIRE(n("sample") == 1);
    REQUIRE(n("kick") == 2);
    REQUIRE(n("snare") == 3);
    REQUIRE(n("hat") == 4);
    REQUIRE(n("openhat") == 5);
    REQUIRE(n("perc") == 6);
    REQUIRE(n("bass") == 7);
    REQUIRE(n("send1") == 8);
    REQUIRE(n("send4") == 11);
    REQUIRE(n("click") == 12);
    // anything else takes the next free slot from 13, and keeps it
    REQUIRE(n("sample2") == 13);
    REQUIRE(n("my lane") == 14);
    REQUIRE(n("sample2") == 13);
    REQUIRE(n("kick") == 2);
    REQUIRE(StripNamer::isSend("send2"));
    REQUIRE(!StripNamer::isSend("snare"));
}

TEST_CASE("project export: padRoute is the pad's override, then its source's, then 'sample'", "[export]")
{
    auto p = twoPadProject();
    REQUIRE(padRouteName(p, 0) == "kick");
    REQUIRE(padRouteName(p, 1) == "snare");
    REQUIRE(padRouteName(p, 7) == "sample"); // an unrouted pad falls back
    // a SOURCE route covers every pad of that source
    p.getChildWithName(ids::PadRoutes).removeAllChildren(nullptr);
    juce::ValueTree e(ids::Entry);
    e.setProperty(ids::key, "src:kick", nullptr);
    e.setProperty(ids::value, "perc", nullptr);
    p.getChildWithName(ids::SourceRoutes).appendChild(e, nullptr);
    REQUIRE(padRouteName(p, 0) == "perc");
    REQUIRE(padRouteName(p, 1) == "sample");
}

TEST_CASE("project export: the mixer blob becomes the render spec", "[export]")
{
    auto p = twoPadProject();
    p.setProperty(ids::mixer, mixerBlob(-6.0, true), nullptr);
    StripNamer namer;
    const auto mix = buildMixerSpec(p, namer, {"snare"}, {});
    REQUIRE(mix.enabled);
    REQUIRE(mix.limiter); // the page's master always carries its safety limiter
    REQUIRE(mix.consoleOn);
    REQUIRE(mix.consoleFlavour == ConsoleFlavour::neve);
    REQUIRE(mix.consoleAmount == Approx(80.0));

    auto stripOf = [&](int index) -> const RenderStripSpec*
    {
        for (const auto& s : mix.strips)
            if (s.index == index)
                return &s;
        return nullptr;
    };
    REQUIRE(stripOf(0) != nullptr); // the master is always there
    REQUIRE(stripOf(0)->kind == StripKind::master);
    const auto* kick = stripOf(2);
    REQUIRE(kick != nullptr);
    REQUIRE(kick->kind == StripKind::channel);
    REQUIRE(kick->faderDb == Approx(-6.0));
    REQUIRE(kick->seed == ConsoleStage::fnv1a("kick")); // the desk stage is seeded by the strip NAME
    // a channel the blob never mentioned still gets a default strip when a pad routes to it
    const auto* snare = stripOf(3);
    REQUIRE(snare != nullptr);
    REQUIRE(snare->faderDb == Approx(0.0));
    // every strip's four sends target the send returns, as the page wires them
    REQUIRE(kick->sendTarget[0] == 8);
    REQUIRE(kick->sendTarget[3] == 11);
}

TEST_CASE("project export: a serialized chain becomes real devices, keys and enum options included", "[export]")
{
    auto p = twoPadProject();
    auto* params = new juce::DynamicObject();
    params->setProperty("THRESHOLD", -18.0);
    params->setProperty("STYLE", "PUNCHY"); // an enum by its page OPTION string
    auto* fx = new juce::DynamicObject();
    fx->setProperty("id", "comp");
    fx->setProperty("bypassed", false);
    fx->setProperty("params", juce::var(params));
    juce::Array<juce::var> chain;
    chain.add(juce::var(fx));
    auto* kick = new juce::DynamicObject();
    kick->setProperty("fader", 0.0);
    kick->setProperty("fx", juce::var(chain));
    auto* channels = new juce::DynamicObject();
    channels->setProperty("kick", juce::var(kick));
    auto* blob = new juce::DynamicObject();
    blob->setProperty("channels", juce::var(channels));
    p.setProperty(ids::mixer, juce::var(blob), nullptr);

    StripNamer namer;
    const auto mix = buildMixerSpec(p, namer, {}, {});
    const RenderStripSpec* k = nullptr;
    for (const auto& s : mix.strips)
        if (s.index == 2)
            k = &s;
    REQUIRE(k != nullptr);
    REQUIRE(k->fx.size() == 1);
    REQUIRE(k->fx[0].type == FxType::comp);
    REQUIRE(!k->fx[0].bypass);
    auto valueOf = [&](int param) -> float
    {
        for (const auto& kv : k->fx[0].params)
            if (kv.first == param)
                return kv.second;
        return -12345.0f;
    };
    REQUIRE(valueOf(fxParamIndex(FxType::comp, "THRESHOLD")) == Approx(-18.0));
    const int styleIdx = fxParamIndex(FxType::comp, "STYLE");
    REQUIRE(fxOptionIndex(FxType::comp, styleIdx, "PUNCHY") == 2);
    REQUIRE(valueOf(styleIdx) == Approx(2.0));
}

TEST_CASE("project export: an SC COMP's SOURCE channel NAME becomes the key strip's INDEX", "[export]")
{
    auto p = twoPadProject();
    auto* params = new juce::DynamicObject();
    params->setProperty("SOURCE", "kick"); // the page names the channel
    auto* fx = new juce::DynamicObject();
    fx->setProperty("id", "sccomp");
    fx->setProperty("params", juce::var(params));
    juce::Array<juce::var> chain;
    chain.add(juce::var(fx));
    auto* bass = new juce::DynamicObject();
    bass->setProperty("fader", 0.0);
    bass->setProperty("fx", juce::var(chain));
    auto* channels = new juce::DynamicObject();
    channels->setProperty("bass", juce::var(bass));
    auto* blob = new juce::DynamicObject();
    blob->setProperty("channels", juce::var(channels));
    p.setProperty(ids::mixer, juce::var(blob), nullptr);

    StripNamer namer;
    const auto mix = buildMixerSpec(p, namer, {}, {});
    for (const auto& s : mix.strips)
        if (s.index == 7) // 'bass'
        {
            REQUIRE(s.fx.size() == 1);
            REQUIRE(s.fx[0].params.size() == 1);
            REQUIRE(s.fx[0].params[0].first == fxParamIndex(FxType::sccomp, "SOURCE"));
            REQUIRE(s.fx[0].params[0].second == Approx(2.0)); // 'kick' = strip 2
        }
}

TEST_CASE("project export: the render carries the project's fader", "[export]")
{
    const double sr = 48000.0;
    SampleBank bank;
    bank.bySourceVideoId["kick"] = click(sr, 0.2, 0.9f);
    bank.bySourceVideoId["snare"] = click(sr, 0.2, 0.9f);

    auto flat = twoPadProject();
    flat.setProperty(ids::mixer, mixerBlob(0.0), nullptr);
    auto pulled = twoPadProject();
    pulled.setProperty(ids::mixer, mixerBlob(-60.0), nullptr); // the kick strip all the way down = silence

    const auto a = renderProject(flat, bank, mixOpts(sr));
    const auto b = renderProject(pulled, bank, mixOpts(sr));
    REQUIRE(peakOf(a.buffer, 0) > 0.05);
    REQUIRE(peakOf(b.buffer, 0) > 0.0);                        // the snare is still there…
    REQUIRE(peakOf(b.buffer, 0) < peakOf(a.buffer, 0) * 0.95); // …but the kick is gone from the bytes
}

TEST_CASE("project export: trackouts come out of the same render, aligned with the master", "[export]")
{
    const double sr = 48000.0;
    SampleBank bank;
    bank.bySourceVideoId["kick"] = click(sr, 0.2, 0.9f);
    bank.bySourceVideoId["snare"] = click(sr, 0.2, 0.9f);
    auto p = twoPadProject();
    p.setProperty(ids::mixer, mixerBlob(0.0), nullptr);

    auto opts = mixOpts(sr);
    opts.stemChannels = {"kick", "snare"};
    opts.numChannels = 6;       // master + two trackouts
    opts.masterLimiter = false; // an UNLIMITED master bounce: then the master IS the sum of its trackouts, exactly
    const auto r = renderProject(p, bank, opts);
    REQUIRE(r.buffer.getNumChannels() == 6);
    REQUIRE(peakOf(r.buffer, 2) > 0.05); // the kick trackout has audio
    REQUIRE(peakOf(r.buffer, 4) > 0.05); // …and the snare's
    // ALIGNMENT is the gate, measured by CROSS-CORRELATION rather than by an onset threshold: the master and the
    // summed trackouts must peak at lag 0. They are NOT equal in level and must not be — the master carries the
    // −1 dBFS safety limiter (its makeup alone lifts the mix +0.57 dB, and Blink's kernel shapes the first
    // transient), while a trackout is post-strip, pre-master. Stems sum to the master PRE-limiter, by design; a
    // threshold crossing moves with that shaping, a correlation peak does not.
    const int n = r.buffer.getNumSamples();
    std::vector<double> master(static_cast<std::size_t>(n)), stems(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
    {
        master[static_cast<std::size_t>(i)] = static_cast<double>(r.buffer.getSample(0, i));
        stems[static_cast<std::size_t>(i)] =
            static_cast<double>(r.buffer.getSample(2, i)) + static_cast<double>(r.buffer.getSample(4, i));
    }
    int bestLag = -999;
    double best = -1.0;
    for (int lag = -64; lag <= 64; ++lag)
    {
        double dot = 0.0;
        for (int i = 0; i < n; ++i)
        {
            const int j = i + lag;
            if (j < 0 || j >= n)
                continue;
            dot += master[static_cast<std::size_t>(i)] * stems[static_cast<std::size_t>(j)];
        }
        if (dot > best)
        {
            best = dot;
            bestLag = lag;
        }
    }
    INFO("best correlation lag: " << bestLag);
    REQUIRE(bestLag == 0); // the head-trim put the master and its trackouts on the same sample
    // with no limiter in the way the master is the trackouts summed, sample for sample
    double worst = 0.0;
    for (int i = 0; i < n; ++i)
        worst = std::max(worst, std::abs(master[static_cast<std::size_t>(i)] - stems[static_cast<std::size_t>(i)]));
    INFO("worst master-vs-stems difference: " << worst);
    REQUIRE(worst < 1.0e-6);
    // …and the master really is those two strips and nothing else: within the limiter's own makeup
    double mp = 0.0, sp = 0.0;
    for (int i = 0; i < n; ++i)
    {
        mp = std::max(mp, std::abs(master[static_cast<std::size_t>(i)]));
        sp = std::max(sp, std::abs(stems[static_cast<std::size_t>(i)]));
    }
    const double db = 20.0 * std::log10(mp / sp);
    INFO("master vs summed stems: " << db << " dB");
    REQUIRE(db == Approx(0.0).margin(0.001));
}

TEST_CASE("project export: the master's safety limiter is in the bounce by default, and can be taken out", "[export]")
{
    const double sr = 48000.0;
    SampleBank bank;
    bank.bySourceVideoId["kick"] = click(sr, 0.2, 0.9f);
    bank.bySourceVideoId["snare"] = click(sr, 0.2, 0.9f);
    auto p = twoPadProject();
    p.setProperty(ids::mixer, mixerBlob(0.0), nullptr);
    auto limited = mixOpts(sr);
    auto raw = mixOpts(sr);
    raw.masterLimiter = false;
    const auto a = renderProject(p, bank, limited);
    const auto b = renderProject(p, bank, raw);
    // the page's master always carries it, so a bounce does too — and it is really doing something
    REQUIRE(peakOf(a.buffer, 0) != Approx(peakOf(b.buffer, 0)).margin(1.0e-6));
    REQUIRE(peakOf(a.buffer, 0) < 1.2); // it is a safety limiter: nothing runs away
}
