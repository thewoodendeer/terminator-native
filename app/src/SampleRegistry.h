#pragma once
// SampleRegistry — the shell's side of `terminatorSamples` + the pad-binding commands (BRIDGE-PROTOCOL.md
// §terminatorSamples / §setPadSample / §setPadLoop): decoded audio the PAGE holds (Web Audio AudioBuffers) or
// files on disk become SampleBuffers in the SampleStore under a page-chosen KEY, and pads are bound to a key +
// a region in seconds. Message thread only. Lifetime: a key owns its store id; `release` retires it through the
// store's quarantine (after first unbinding every pad that still points at it) — so a voice can never read freed
// memory. LOOP pads get their crossfade render (render::renderPadLoop, the same code the offline renderer uses)
// built here and handed to the engine like a sample.
#include <cstdint>
#include <map>
#include <memory>

#include <juce_core/juce_core.h>

#include "terminator/core/Engine.h"
#include "terminator/io/SampleLoader.h"
#include "terminator/io/SampleStore.h"

namespace terminator::app
{

class SampleRegistry
{
  public:
    SampleRegistry(Engine& engine, SampleStore& store, SampleLoader& loader);

    /// `terminatorSamples(req)` — req.verb ∈ begin · chunk · end · loadFile · release · list · stats.
    juce::var handle(const juce::var& req);

    /// `setPadSample {pad, key, startSec, endSec}` — bind (key "" / missing = clear). Pushes the engine command.
    juce::var setPadSample(const juce::var& cmd);
    /// `setPadLoop {pad, key, startSec, endSec, fadeInSec, fadeOutSec, reverse}` — render + attach the crossfade
    /// loop of that region (no fades / `clear: true` = detach → raw hard-wrap of the region).
    juce::var setPadLoop(const juce::var& cmd);

    const SampleBuffer* find(const juce::String& key) const;
    std::size_t keyCount() const { return ids_.size(); }
    std::size_t pendingCount() const { return pending_.size(); }

    static constexpr std::int64_t kMaxFloats = 400LL * 1024 * 1024; // 1.6 GB per buffer — a UI bug, not a use

  private:
    static juce::var ok(bool okFlag, const juce::String& error = {});
    juce::var begin(const juce::var& req);
    juce::var chunk(const juce::var& req);
    juce::var end(const juce::var& req);
    juce::var loadFile(const juce::var& req);
    juce::var release(const juce::var& req);
    juce::var list() const;
    juce::var describe(const juce::String& key, const SampleBuffer& b) const;
    void install(const juce::String& key, std::shared_ptr<SampleBuffer> buffer);
    void unbindKey(const juce::String& key); // pads bound to the key → cleared (sample + loop)
    void clearPadLoop(int pad);

    struct Pending
    {
        std::shared_ptr<SampleBuffer> buffer;
        std::int64_t framesReceived = 0;
    };

    Engine& engine_;
    SampleStore& store_;
    SampleLoader& loader_;
    std::map<juce::String, std::uint32_t> ids_;
    std::map<juce::String, Pending> pending_;
    juce::String padKeys_[kMaxPads];
    std::uint32_t padLoopIds_[kMaxPads] = {};
    std::uint64_t chunksReceived_ = 0;
    std::uint64_t bytesReceived_ = 0;
};

} // namespace terminator::app
