#pragma once
// ProjectRenderer — the "export = what you hear" bridge: a project ValueTree + a bank of decoded sample buffers
// → a RenderSpec the existing renderOffline() drives through the same Engine. Pads resolve to buffer+region
// (a pad's own sample, or a main-track chop of the main buffer), their params carry pitch/gain/mode/reverse/
// choke, and the current sequence becomes on/stop events via ProjectPlanner::patternToEvents (swing, velocity,
// tail-group length preserved). No second DSP path — one engine renders playback and exports.
#include <array>
#include <map>
#include <memory>

#include <juce_data_structures/juce_data_structures.h>

#include "terminator/core/SampleBuffer.h"
#include "terminator/render/OfflineRenderer.h"

namespace terminator::render
{
/// Decoded audio for a project: the main track (for main-track chops) + each pad source, keyed by its videoId.
/// Four decoded stem planes (drums, bass, other, vocals — StemMask.h bit order); a missing stem stays null.
using StemPlanes = std::array<std::shared_ptr<SampleBuffer>, 4>;

struct SampleBank
{
    std::shared_ptr<SampleBuffer> mainBuffer;                              // 'main' pads read this
    std::map<juce::String, std::shared_ptr<SampleBuffer>> bySourceVideoId; // pad-source pads (padBufferMeta.videoId)
    // Decoded stems (the cached stem assets named by Stems{StemAssets} / SourceStems{...StemAssets}), each plane
    // the matching buffer's length/rate (effective time — the loader applies trims to stems and original alike).
    // A masked pad attaches them when its span is inside the tree's readyRanges; otherwise the original plays.
    StemPlanes mainStems{};
    std::map<juce::String, StemPlanes> stemsBySourceVideoId;
};

struct ProjectRenderOptions
{
    double sampleRate = 48000.0;
    int blockSize = 512;
    int numChannels = 2;
    int loops = 1;                    // how many times the current pattern repeats
    double tailSeconds = 0.5;         // extra time after the last note so tails ring out
    bool classicInterpolation = true; // linear = golden-match the Web Audio engine; false = hermite (native default)
};

/// Assemble the RenderSpec (pads + events) from the project + bank. Missing sources → silent pads.
RenderSpec buildProjectRenderSpec(const juce::ValueTree& project, const SampleBank& bank,
                                  const ProjectRenderOptions& opts);

/// Convenience: build + renderOffline.
RenderResult renderProject(const juce::ValueTree& project, const SampleBank& bank, const ProjectRenderOptions& opts);
} // namespace terminator::render
