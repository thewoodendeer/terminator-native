#pragma once
// ProjectRenderer — the "export = what you hear" bridge: a project ValueTree + a bank of decoded sample buffers
// → a RenderSpec the existing renderOffline() drives through the same Engine. Pads resolve to buffer+region
// (a pad's own sample, or a main-track chop of the main buffer), their params carry pitch/gain/mode/reverse/
// choke, and the current sequence becomes on/stop events via ProjectPlanner::patternToEvents (swing, velocity,
// tail-group length preserved). No second DSP path — one engine renders playback and exports.
#include <array>
#include <map>
#include <memory>
#include <vector>

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
    /// Phase 4.5c: the drum machine's lane audio, keyed by the page's lane key ('kick', 'snare', … or a user lane's).
    /// The renderer never resolves the drum CATALOG itself (sampleIndex + genre → a bundled/R2 file is the shell's
    /// job) — the caller decodes and hands the buffers in, exactly as it does for pad sources.
    std::map<juce::String, std::shared_ptr<SampleBuffer>> drumLanes;
};

struct ProjectRenderOptions
{
    double sampleRate = 48000.0;
    int blockSize = 512;
    int numChannels = 2;
    int loops = 1;                    // how many times the current pattern repeats
    double tailSeconds = 0.5;         // extra time after the last note so tails ring out
    bool classicInterpolation = true; // linear = golden-match the Web Audio engine; false = hermite (native default)
    /// Phase 4.5b: build the mix from the project's `mixer` blob (strips, sends, inserts, console) and route every
    /// pad into its strip, so the export carries what the mixer is doing. False = the Phase-3 direct path.
    bool useMixer = false;
    /// TRACKOUTS: channel names to tap, in order, onto hardware pairs 1, 2, 3 … (pair 0 is the master). Every
    /// tapped channel needs its own pair, so `numChannels` must be 2 × (1 + stemChannels.size()).
    std::vector<juce::String> stemChannels;
    /// Phase 4.5c: render the project's DRUM MACHINE too, through the engine's own DrumSequencer. False = chops
    /// only, which is what every pre-4.5c project render did.
    bool renderDrums = false;
    /// The master's −1 dBFS safety limiter. The page always has it in, so exports carry it by default; off gives an
    /// UNLIMITED master bounce, which is also what makes the master exactly the sum of its trackouts.
    bool masterLimiter = true;
};

/// The page's strip numbering (renderer/native/nativeMixerShadow.ts): the fixed names take fixed indices so a
/// project's strip is the same strip session after session, and anything else takes the next free slot from 13.
/// Shared by the export path and the tests.
class StripNamer
{
  public:
    /// The index for a channel name, allocating one on first sight. −1 when all 63 are taken.
    int operator()(const juce::String& name);
    /// Every name seen so far, with its index and whether it is a send return.
    const std::vector<std::pair<juce::String, int>>& seen() const noexcept { return seen_; }
    static bool isSend(const juce::String& name) { return name.startsWith("send"); }

  private:
    std::vector<std::pair<juce::String, int>> seen_;
    int next_ = 13;
};

/// The strip a pad plays through — the page's `padRoute`: the pad's own override, else its source's route, else
/// 'sample'.
juce::String padRouteName(const juce::ValueTree& project, int pad);

/// The project's `drums` blob (the page's DrumPreset: tracks / sequences / the four step graphs / swing / master)
/// → the drum machine for an export. Lane order follows the preset's `tracks` array, which is how the page hands
/// slots out. Lanes whose key is missing from `bank.drumLanes` still take their slot (silent) so the graphs and the
/// mute groups keep their lane indices. `namer` gives each lane its mixer strip when `useMixer` is on.
RenderDrumsSpec buildDrumsSpec(const juce::ValueTree& project, const SampleBank& bank, StripNamer* namer);

/// The project's `mixer` blob (the page's MixerPreset: channels / master / console) → a RenderMixerSpec. Channels
/// the blob does not mention still get a default strip if `extraChannels` names them (a pad routed to a channel the
/// user never touched). `namer` carries the name → index allocation.
RenderMixerSpec buildMixerSpec(const juce::ValueTree& project, StripNamer& namer,
                               const std::vector<juce::String>& extraChannels,
                               const std::vector<juce::String>& stemChannels, bool masterLimiter = true);

/// The region's audio as the voice will read it (base, or the lit planes summed), reversed when the pad is —
/// the input to the LOOP render (TS loopBufferFor renders from the resolved, already-reversed source buffer).
/// `planes` null = the base buffer alone. [s0, s0+n) in base frames; every channel returned has n frames.
std::vector<std::vector<float>> regionChannels(const SampleBuffer& base, const StemPlanes* planes, std::uint8_t mask,
                                               std::int64_t s0, std::int64_t n, bool reverse);

/// TS loopBufferFor: the rendered crossfade loop of a LOOP pad's region (fades in BUFFER seconds) as a fresh
/// SampleBuffer `[warm-up | steady period]`, with [loopStart, loopEnd) bracketing the steady period in its
/// frames. No fades → nullptr (the sampler hard-wraps the raw region, exactly like TS looping the raw region).
/// Message-thread / offline use (allocates). Shared by the offline ProjectRenderer and the live shell.
std::shared_ptr<SampleBuffer> renderPadLoop(const SampleBuffer& base, const StemPlanes* planes, std::uint8_t mask,
                                            std::int64_t s0, std::int64_t n, double fadeInSec, double fadeOutSec,
                                            bool reverse, std::int64_t& loopStart, std::int64_t& loopEnd);

/// Assemble the RenderSpec (pads + events) from the project + bank. Missing sources → silent pads.
RenderSpec buildProjectRenderSpec(const juce::ValueTree& project, const SampleBank& bank,
                                  const ProjectRenderOptions& opts);

/// Convenience: build + renderOffline.
RenderResult renderProject(const juce::ValueTree& project, const SampleBank& bank, const ProjectRenderOptions& opts);
} // namespace terminator::render
