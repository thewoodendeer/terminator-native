#include "terminator/render/ProjectRenderer.h"

#include <algorithm>
#include <cmath>

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
} // namespace

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

    // one RenderSpec pad per occupied project pad, keyed by the SAME pad index the events use
    std::map<int, std::size_t> padSlot; // pad index → spec.pads position
    for (const auto& padN : pads)
    {
        const int idx = static_cast<int>(padN.getProperty(ids::index));
        std::shared_ptr<SampleBuffer> buffer;
        double regStartSec = 0.0, regEndSec = 0.0;

        const auto srcN = findChildWithProperty(padSources, ids::pad, idx);
        if (srcN.isValid())
        {
            buffer = [&]
            {
                auto it = bank.bySourceVideoId.find(srcN.getProperty(ids::videoId).toString());
                return it != bank.bySourceVideoId.end() ? it->second : nullptr;
            }();
            regStartSec = static_cast<double>(srcN.getProperty(ids::start, 0.0));
            regEndSec = static_cast<double>(srcN.getProperty(ids::end, 0.0));
        }
        else if (padN.hasProperty(ids::chopId))
        {
            const auto chopN = findChildWithProperty(chops, ids::id, static_cast<int>(padN.getProperty(ids::chopId)));
            if (chopN.isValid() && bank.mainBuffer != nullptr)
            {
                buffer = bank.mainBuffer;
                regStartSec = static_cast<double>(chopN.getProperty(ids::start, 0.0));
                regEndSec = static_cast<double>(chopN.getProperty(ids::end, 0.0));
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
        p.params.pitchSemitones =
            static_cast<float>(static_cast<double>(padN.getProperty(ids::pitch, 0)) + srcPitch + srcFine / 100.0);
        p.params.attackSec = static_cast<float>(srcAttack);
        p.params.gain = 1.0f; // master gain carries chopVolume×norm; per-source NORM = a later pass
        p.params.mode = padN.getProperty(ids::mode).toString() == "loop" ? PadMode::loop : PadMode::oneShot;
        p.params.reverse = planner.reversedFor(idx) ? 1 : 0;
        p.params.chokeGroup = static_cast<std::int16_t>(chokeInt(idx));
        p.params.interpolation = opts.classicInterpolation ? Interpolation::linear : Interpolation::hermite;
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
    return spec;
}

RenderResult renderProject(const juce::ValueTree& project, const SampleBank& bank, const ProjectRenderOptions& opts)
{
    return renderOffline(buildProjectRenderSpec(project, bank, opts));
}
} // namespace terminator::render
