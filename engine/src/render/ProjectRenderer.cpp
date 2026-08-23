#include "terminator/render/ProjectRenderer.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include "terminator/core/fx/ConsoleStage.h"
#include "terminator/core/fx/Effect.h"
#include "terminator/core/planners/LoopRender.h"
#include "terminator/core/planners/StemMask.h"
#include "terminator/model/Ids.h"
#include "terminator/model/ProjectModel.h"
#include "terminator/model/ProjectPlanner.h"

namespace terminator::render
{
using namespace terminator::model;

namespace
{
std::int64_t secToFrame(double sec, double rate) noexcept
{
    return static_cast<std::int64_t>(std::floor(sec * rate + 0.5));
}

/// Stems{readyRanges} / SourceStem{readyRanges} → ReadyRange list (var array of [start,end] pairs).
std::vector<stems::ReadyRange> readyRangesOf(const juce::ValueTree& stemSet)
{
    std::vector<stems::ReadyRange> out;
    if (!stemSet.isValid())
        return out;
    if (const auto* arr = stemSet.getProperty(ids::readyRanges).getArray())
        for (const auto& r : *arr)
            if (const auto* pr = r.getArray(); pr != nullptr && pr->size() >= 2)
                out.push_back({static_cast<double>((*pr)[0]), static_cast<double>((*pr)[1])});
    return out;
}

/// The planes a masked pad reads: every lit plane present + the same length/rate as the base + the span READY →
/// true (the voice sums them); else false = the ORIGINAL plays (TS bufferForPadChop / bufferForPadSource).
bool stemsApply(const StemPlanes& planes, std::uint8_t mask, const SampleBuffer& base,
                const std::vector<stems::ReadyRange>& ready, double startSec, double endSec)
{
    if (mask == 0 || mask == stems::kMaskAll)
        return false;
    if (!stems::spanReady(ready, startSec, endSec))
        return false;
    for (int k = 0; k < stems::kStemCount; ++k)
    {
        if ((mask & (1u << k)) == 0)
            continue;
        const auto& pl = planes[static_cast<std::size_t>(k)];
        if (pl == nullptr || pl->numFrames != base.numFrames || pl->sampleRate != base.sampleRate ||
            pl->numChannels < 1)
            return false;
    }
    return true;
}

} // namespace

std::vector<std::vector<float>> regionChannels(const SampleBuffer& base, const StemPlanes* planes, std::uint8_t mask,
                                               std::int64_t s0, std::int64_t n, bool reverse)
{
    const int channels = planes != nullptr ? std::min(2, base.numChannels) : base.numChannels;
    std::vector<std::vector<float>> out(static_cast<std::size_t>(std::max(1, channels)),
                                        std::vector<float>(static_cast<std::size_t>(n), 0.0f));
    for (int ch = 0; ch < channels; ++ch)
    {
        auto& d = out[static_cast<std::size_t>(ch)];
        if (planes == nullptr)
        {
            const float* src = base.channel(ch);
            for (std::int64_t i = 0; i < n; ++i)
                d[static_cast<std::size_t>(i)] = src[s0 + i];
        }
        else
        {
            for (int k = 0; k < stems::kStemCount; ++k)
            {
                if ((mask & (1u << k)) == 0)
                    continue;
                const auto& pl = *(*planes)[static_cast<std::size_t>(k)];
                const float* src = pl.channel(std::min(ch, pl.numChannels - 1));
                for (std::int64_t i = 0; i < n; ++i)
                    d[static_cast<std::size_t>(i)] += src[s0 + i];
            }
        }
        if (reverse)
            std::reverse(d.begin(), d.end());
    }
    return out;
}

std::shared_ptr<SampleBuffer> renderPadLoop(const SampleBuffer& base, const StemPlanes* planes, std::uint8_t mask,
                                            std::int64_t s0, std::int64_t n, double fadeInSec, double fadeOutSec,
                                            bool reverse, std::int64_t& loopStart, std::int64_t& loopEnd)
{
    const double rate = base.sampleRate;
    const double durSec = static_cast<double>(n) / rate;
    const double fi = std::max(0.0, std::min(durSec, fadeInSec));
    const double fo = std::max(0.0, std::min(durSec, fadeOutSec));
    if (fi <= 0.0 && fo <= 0.0)
        return nullptr;
    const auto chans = regionChannels(base, planes, mask, s0, std::max<std::int64_t>(2, n), reverse);
    std::vector<const float*> ptrs;
    for (const auto& c : chans)
        ptrs.push_back(c.data());
    const auto r = loop::renderCrossfadeLoop(ptrs, 0, static_cast<std::int64_t>(chans[0].size()),
                                             static_cast<std::int64_t>(std::floor(fi * rate + 0.5)),
                                             static_cast<std::int64_t>(std::floor(fo * rate + 0.5)));
    auto out = std::make_shared<SampleBuffer>();
    out->allocate(static_cast<int>(r.frames.size()), static_cast<std::int64_t>(r.frames[0].size()), rate);
    for (std::size_t c = 0; c < r.frames.size(); ++c)
        std::copy(r.frames[c].begin(), r.frames[c].end(), out->channel(static_cast<int>(c)));
    loopStart = r.loopStart;
    loopEnd = r.loopStart + r.period;
    return out;
}

// ── Phase 4.5b: the project's mixer → the render spec ──────────────────────────────────────────────────────────

int StripNamer::operator()(const juce::String& name)
{
    // the page's fixed numbering (nativeMixerShadow.ts FIXED_STRIPS + CLICK_STRIP): a project's strip is the same
    // strip every session, so a saved chain lands where it was saved
    static const std::pair<const char*, int> kFixed[] = {{"sample", 1},  {"kick", 2},   {"snare", 3},  {"hat", 4},
                                                         {"openhat", 5}, {"perc", 6},   {"bass", 7},   {"send1", 8},
                                                         {"send2", 9},   {"send3", 10}, {"send4", 11}, {"click", 12}};
    for (const auto& [n, i] : kFixed)
        if (name == n)
        {
            for (const auto& sn : seen_)
                if (sn.first == name)
                    return sn.second;
            seen_.emplace_back(name, i);
            return i;
        }
    for (const auto& sn : seen_)
        if (sn.first == name)
            return sn.second;
    if (next_ >= kMaxStrips)
        return -1;
    const int i = next_++;
    seen_.emplace_back(name, i);
    return i;
}

juce::String padRouteName(const juce::ValueTree& project, int pad)
{
    const auto padRoutes = project.getChildWithName(ids::PadRoutes);
    const auto own = mapGet(padRoutes, juce::String(pad), {});
    if (own.isString() && own.toString().isNotEmpty())
        return own.toString();
    const ProjectPlanner planner(project);
    const auto key = planner.padSourceKey(pad);
    if (key.isNotEmpty())
    {
        const auto viaSource = mapGet(project.getChildWithName(ids::SourceRoutes), key, {});
        if (viaSource.isString() && viaSource.toString().isNotEmpty())
            return viaSource.toString();
    }
    return "sample";
}

namespace
{
/// One serialized insert ({id, bypassed, params}) → a RenderFxSpec, mapping the page's KEYS and its enum OPTION
/// STRINGS through the same lookups the live bridge uses (fxTypeFromId / fxParamIndex / fxOptionIndex). SC COMP's
/// SOURCE is a channel NAME on the page and a strip INDEX natively, exactly as nativeMixerShadow.fxValue() does it.
bool readFx(const juce::var& v, StripNamer& namer, RenderFxSpec& out)
{
    if (!v.isObject())
        return false;
    const auto id = v.getProperty("id", "").toString();
    const FxType t = fxTypeFromId(id.toRawUTF8());
    if (t == FxType::none)
        return false; // a device this build does not know: skip it rather than shift every slot after it
    out.type = t;
    out.bypass = static_cast<bool>(v.getProperty("bypassed", false));
    const auto params = v.getProperty("params", juce::var());
    if (auto* po = params.getDynamicObject())
        for (const auto& kv : po->getProperties())
        {
            const int idx = fxParamIndex(t, kv.name.toString().toRawUTF8());
            if (idx < 0)
                continue;
            if (kv.value.isString())
            {
                const auto str = kv.value.toString();
                const int opt = fxOptionIndex(t, idx, str.toRawUTF8());
                if (opt >= 0)
                    out.params.emplace_back(idx, static_cast<float>(opt));
                else if (t == FxType::sccomp && idx == 0) // SOURCE: a channel name, or NONE
                    out.params.emplace_back(idx, str == "NONE" ? -1.0f : static_cast<float>(namer(str)));
            }
            else
                out.params.emplace_back(idx, static_cast<float>(static_cast<double>(kv.value)));
        }
    return true;
}
} // namespace

RenderMixerSpec buildMixerSpec(const juce::ValueTree& project, StripNamer& namer,
                               const std::vector<juce::String>& extraChannels,
                               const std::vector<juce::String>& stemChannels, bool masterLimiter)
{
    RenderMixerSpec mix;
    mix.enabled = true;
    mix.limiter = masterLimiter; // the page's master always carries its −1 dBFS safety limiter
    const auto blob = project.getProperty(ids::mixer);

    // the master first (strip 0), then every channel the blob names
    RenderStripSpec master;
    master.index = kMasterStrip;
    master.kind = StripKind::master;
    const auto masterV = blob.getProperty("master", juce::var());
    if (masterV.isObject())
    {
        master.faderDb = static_cast<float>(static_cast<double>(masterV.getProperty("fader", 0.0)));
        if (auto* fxs = masterV.getProperty("fx", juce::var()).getArray())
            for (const auto& f : *fxs)
            {
                RenderFxSpec fx;
                if (readFx(f, namer, fx))
                    master.fx.push_back(std::move(fx));
            }
    }
    mix.strips.push_back(std::move(master));

    std::vector<juce::String> names;
    auto want = [&names](const juce::String& n)
    {
        for (const auto& e : names)
            if (e == n)
                return;
        names.push_back(n);
    };
    const auto channels = blob.getProperty("channels", juce::var());
    if (auto* co = channels.getDynamicObject())
        for (const auto& kv : co->getProperties())
            want(kv.name.toString());
    for (const auto& n : extraChannels)
        want(n);
    for (const auto& n : stemChannels)
        want(n);

    for (const auto& name : names)
    {
        RenderStripSpec st;
        st.index = namer(name);
        if (st.index < 0)
            continue;
        st.kind = StripNamer::isSend(name) ? StripKind::send : StripKind::channel;
        st.seed = ConsoleStage::fnv1a(name.toRawUTF8()); // the page seeds the desk stage by the strip NAME
        const auto c = channels.getProperty(juce::Identifier(name), juce::var());
        if (c.isObject())
        {
            st.faderDb = static_cast<float>(static_cast<double>(c.getProperty("fader", 0.0)));
            st.pan = static_cast<float>(static_cast<double>(c.getProperty("pan", 0.0)));
            st.mute = static_cast<bool>(c.getProperty("mute", false));
            st.solo = static_cast<bool>(c.getProperty("solo", false));
            if (auto* sends = c.getProperty("sends", juce::var()).getArray())
                for (int k = 0; k < kMaxSends && k < sends->size(); ++k)
                    st.sendDb[k] = static_cast<float>(static_cast<double>((*sends)[k]));
            if (auto* fxs = c.getProperty("fx", juce::var()).getArray())
                for (const auto& f : *fxs)
                {
                    RenderFxSpec fx;
                    if (readFx(f, namer, fx))
                        st.fx.push_back(std::move(fx));
                }
        }
        // the four sends always target the send returns, exactly as the page wires them
        for (int k = 0; k < kMaxSends; ++k)
            st.sendTarget[k] = namer("send" + juce::String(k + 1));
        for (std::size_t i = 0; i < stemChannels.size(); ++i)
            if (stemChannels[i] == name)
                st.stemTap = static_cast<int>(i) + 1; // pair 0 is the master's
        mix.strips.push_back(std::move(st));
    }

    const auto con = blob.getProperty("console", juce::var());
    if (con.isObject())
    {
        mix.consoleOn = static_cast<bool>(con.getProperty("on", false));
        mix.consoleAmount = static_cast<float>(static_cast<double>(con.getProperty("amount", 50.0)));
        const auto fl = con.getProperty("flavour", "ssl").toString();
        mix.consoleFlavour = fl == "neve"  ? ConsoleFlavour::neve
                             : fl == "api" ? ConsoleFlavour::api
                                           : ConsoleFlavour::ssl;
    }
    return mix;
}

RenderSpec buildProjectRenderSpec(const juce::ValueTree& project, const SampleBank& bank,
                                  const ProjectRenderOptions& opts)
{
    RenderSpec spec;
    spec.sampleRate = opts.sampleRate;
    spec.blockSize = opts.blockSize;
    spec.numChannels = opts.numChannels;
    spec.masterGain = static_cast<float>(project.getProperty(ids::normalize, false)
                                             ? static_cast<double>(project.getProperty(ids::chopVolume, 1.0)) *
                                                   static_cast<double>(project.getProperty(ids::normalizeGain, 1.0))
                                             : static_cast<double>(project.getProperty(ids::chopVolume, 1.0)));

    ProjectPlanner planner(project);
    StripNamer namer;
    std::vector<juce::String> routed; // every channel a pad actually plays through
    // choke-group strings → stable ints (pads of one source choke each other; 'none' = poly = -2)
    std::map<juce::String, int> chokeIds;
    auto chokeInt = [&](int pad) -> int
    {
        const auto g = planner.chokeGroupOf(pad);
        if (g == "none")
            return -2;
        auto it = chokeIds.find(g);
        if (it != chokeIds.end())
            return it->second;
        const int id = static_cast<int>(chokeIds.size());
        chokeIds[g] = id;
        return id;
    };

    const auto pads = project.getChildWithName(ids::Pads);
    const auto chops = project.getChildWithName(ids::Chops);
    const auto padSources = project.getChildWithName(ids::PadSources);
    const auto sourceNorm = project.getChildWithName(ids::SourceNorm);
    const auto masterN = project.getChildWithName(ids::Master);
    const auto mainStemSet = project.getChildWithName(ids::Stems);
    const auto sourceStemSets = project.getChildWithName(ids::SourceStems);
    const double masterRelease = masterN.isValid() ? static_cast<double>(masterN.getProperty(ids::release, 0.0)) : 0.0;
    const auto mainReady = readyRangesOf(mainStemSet);

    // one RenderSpec pad per occupied project pad, keyed by the SAME pad index the events use
    std::map<int, std::size_t> padSlot; // pad index → spec.pads position
    for (const auto& padN : pads)
    {
        const int idx = static_cast<int>(padN.getProperty(ids::index));
        std::shared_ptr<SampleBuffer> buffer;
        double regStartSec = 0.0, regEndSec = 0.0;
        const StemPlanes* planes = nullptr; // the stems of what this pad plays (main track / its own source)
        std::vector<stems::ReadyRange> ready;
        float sourceNormGain = 1.0f; // per-source NORM rides the voice (normGainFor); main chops stay at 1

        const auto srcN = findChildWithProperty(padSources, ids::pad, idx);
        if (srcN.isValid())
        {
            const auto videoId = srcN.getProperty(ids::videoId).toString();
            buffer = [&]
            {
                auto it = bank.bySourceVideoId.find(videoId);
                return it != bank.bySourceVideoId.end() ? it->second : nullptr;
            }();
            regStartSec = static_cast<double>(srcN.getProperty(ids::start, 0.0));
            regEndSec = static_cast<double>(srcN.getProperty(ids::end, 0.0));
            sourceNormGain = static_cast<float>(static_cast<double>(mapGet(sourceNorm, "src:" + videoId, 1.0)));
            if (auto it = bank.stemsBySourceVideoId.find(videoId); it != bank.stemsBySourceVideoId.end())
            {
                planes = &it->second;
                ready = readyRangesOf(findChildWithProperty(sourceStemSets, ids::videoId, videoId));
            }
        }
        else if (padN.hasProperty(ids::chopId))
        {
            const auto chopN = findChildWithProperty(chops, ids::id, static_cast<int>(padN.getProperty(ids::chopId)));
            if (chopN.isValid() && bank.mainBuffer != nullptr)
            {
                buffer = bank.mainBuffer;
                regStartSec = static_cast<double>(chopN.getProperty(ids::start, 0.0));
                regEndSec = static_cast<double>(chopN.getProperty(ids::end, 0.0));
                planes = &bank.mainStems;
                ready = mainReady;
            }
        }
        if (buffer == nullptr)
            continue;

        RenderPadSpec p;
        p.sample = buffer;
        const double rate = buffer->sampleRate > 0.0 ? buffer->sampleRate : opts.sampleRate;
        p.startFrame = std::clamp<std::int64_t>(secToFrame(regStartSec, rate), 0, buffer->numFrames);
        p.endFrame = std::clamp<std::int64_t>(regEndSec > 0.0 ? secToFrame(regEndSec, rate) : buffer->numFrames,
                                              p.startFrame, buffer->numFrames);
        p.params.pad = static_cast<std::uint16_t>(idx);
        // STEMS: the pad's mask picks its layers (same region, different audio); ALL / unready = the original
        const auto mask = stems::normalizeMask(
            padN.hasProperty(ids::stems) ? static_cast<long long>(static_cast<int>(padN.getProperty(ids::stems))) : 15);
        const double regionEndSec = regEndSec > 0.0 ? regEndSec : static_cast<double>(buffer->numFrames) / rate;
        const bool useStems = planes != nullptr && stemsApply(*planes, mask, *buffer, ready, regStartSec, regionEndSec);
        if (useStems)
        {
            for (std::size_t k = 0; k < 4; ++k)
                p.stems[k] = (*planes)[k];
            p.stemMask = mask;
        }
        // pitch = pad PITCH + source PITCH + FINE/100 (pitchFor); reversed baked as a voice flag
        const auto srcKey = planner.padSourceKey(idx);
        double srcPitch = 0.0, srcFine = 0.0;
        double srcAttack = static_cast<double>(
            [&]
            {
                const auto m = project.getChildWithName(ids::Master);
                return m.isValid() ? m.getProperty(ids::attack, 0.003) : juce::var(0.003);
            }());
        if (srcKey == "main")
        {
            const auto m = project.getChildWithName(ids::Master);
            if (m.isValid())
            {
                srcPitch = static_cast<double>(m.getProperty(ids::pitch, 0));
                srcFine = static_cast<double>(m.getProperty(ids::fine, 0));
            }
        }
        else
        {
            const auto fx = findChildWithProperty(project.getChildWithName(ids::SourceFx), ids::key, srcKey);
            if (fx.isValid())
            {
                srcPitch = static_cast<double>(fx.getProperty(ids::pitch, 0));
                srcFine = static_cast<double>(fx.getProperty(ids::fine, 0));
                srcAttack = static_cast<double>(fx.getProperty(ids::attack, srcAttack));
            }
        }
        const double totalSemis = static_cast<double>(padN.getProperty(ids::pitch, 0)) + srcPitch + srcFine / 100.0;
        p.params.pitchSemitones = static_cast<float>(totalSemis);
        const bool looping = padN.getProperty(ids::mode).toString() == "loop";
        const bool reversed = planner.reversedFor(idx);
        // the pad's own fades (BUFFER seconds inside the region): LOOP renders them into the loop buffer; a
        // one-shot plays the fade-in as its envelope — it lengthens the source ATTACK (context seconds → ÷ rate)
        const double playDur = static_cast<double>(p.endFrame - p.startFrame) / rate;
        const double fadeIn = std::max(0.0, std::min(playDur, static_cast<double>(padN.getProperty(ids::fadeIn, 0.0))));
        const double fadeOut =
            std::max(0.0, std::min(playDur, static_cast<double>(padN.getProperty(ids::fadeOut, 0.0))));
        const double playbackRate = std::pow(2.0, totalSemis / 12.0);
        p.params.attackSec = static_cast<float>(std::max(srcAttack, looping ? 0.0 : fadeIn / playbackRate));
        p.params.releaseSec = static_cast<float>(std::clamp(masterRelease, 0.0, 0.5)); // RELEASE fades at the REAL end
        p.params.gain = sourceNormGain; // master gain carries chopVolume×main NORM for every bus (routeOutput)
        p.params.mode = looping ? PadMode::loop : PadMode::oneShot;
        p.params.reverse = reversed ? 1 : 0;
        p.params.chokeGroup = static_cast<std::int16_t>(chokeInt(idx));
        p.params.interpolation = opts.classicInterpolation ? Interpolation::linear : Interpolation::hermite;
        if (opts.useMixer)
        {
            // the page's padRoute: this pad sums into its channel's strip, not straight to the outs
            const auto route = padRouteName(project, idx);
            const int strip = namer(route);
            p.params.strip = static_cast<std::int16_t>(strip);
            if (strip >= 0)
                routed.push_back(route);
        }
        if (looping && p.endFrame > p.startFrame)
            p.loopSample = renderPadLoop(*buffer, useStems ? planes : nullptr, mask, p.startFrame,
                                         p.endFrame - p.startFrame, fadeIn, fadeOut, reversed, p.loopStart, p.loopEnd);
        padSlot[idx] = spec.pads.size();
        spec.pads.push_back(std::move(p));
    }

    // events: the current sequence, repeated `loops` times
    const auto seq = planner.currentSequence();
    const int bars = static_cast<int>(seq.getProperty(ids::bars, 1));
    const int resolution = static_cast<int>(seq.getProperty(ids::resolution, 16));
    const double tempo = planner.tempoBpm();
    const double patternDur = bars * (60.0 / tempo) * 4.0; // bars × seconds-per-bar
    double lastEnd = 0.0;
    for (int loop = 0; loop < std::max(1, opts.loops); ++loop)
    {
        const auto evs = planner.patternToEvents(seq, loop * patternDur);
        for (const auto& e : evs)
        {
            if (padSlot.find(e.pad) == padSlot.end())
                continue; // pad has no audio in the bank
            RenderEvent on;
            on.pad = static_cast<std::uint16_t>(e.pad);
            on.timeSec = e.time;
            on.velocity = e.velocity;
            on.type = RenderEvent::Type::on;
            spec.events.push_back(on);
            // stop at the tail-group boundary (matches the sequencer's cut; a shorter one-shot ends on its own)
            RenderEvent stop;
            stop.pad = on.pad;
            stop.timeSec = e.time + e.maxDur;
            stop.type = RenderEvent::Type::stop;
            spec.events.push_back(stop);
            lastEnd = std::max(lastEnd, e.time + e.maxDur);
        }
    }
    (void)resolution;
    spec.lengthSeconds = std::max(patternDur * std::max(1, opts.loops), lastEnd) + opts.tailSeconds;
    // the mix LAST: the strips a pad routed to must exist, and the namer has been handing out their indices as the
    // pads asked for them, so the blob's channels and the routed ones land on the same numbering
    if (opts.useMixer)
        spec.mixer = buildMixerSpec(project, namer, routed, opts.stemChannels, opts.masterLimiter);
    return spec;
}

RenderResult renderProject(const juce::ValueTree& project, const SampleBank& bank, const ProjectRenderOptions& opts)
{
    return renderOffline(buildProjectRenderSpec(project, bank, opts));
}
} // namespace terminator::render
