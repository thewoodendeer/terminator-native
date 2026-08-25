#pragma once
// StemHub — the app's side of stem separation (Phase 7.1c): `terminatorStems` on the bridge, the models on
// disk, the split running on its own thread, and the four planes it fills living where the ENGINE can read
// them (`Command::setPadStems` → the voice sums the lit stems per hit).
//
// HOW A READY SPAN REACHES THE PAGE. The Electron contract hands the renderer eight Float32Arrays per span and
// lets it own the stems — its waveform composite, its asset saving, its cache all read them. Native keeps that
// contract (so none of that has to be rebuilt) but does NOT put the audio in the event: JUCE's `emitEvent`
// escapes every C++→JS payload into a JS string literal with a quadratic String::replace, which a megabyte of
// floats would never survive. The span's PCM is stashed as bytes and the event carries `/blob/<token>`; the
// page fetches it binary and copies it into its buffers.
//
// The planes (`StemSet`) are the OTHER half, for the engine: with `planes:true` a split also keeps the four
// full-length buffers here so `setPadStems` can point a pad straight at them and the voice sums the lit stems
// per hit — no mixing on the page, no re-upload. Off by default until the page stops taking the audio (7.3),
// because a set costs four times the source in memory.
//
// THREADS. One split at a time on `worker_`; everything the page sees is posted to an outbox and drained by a
// Timer on the message thread. The split writes a span into the planes BEFORE the range that covers it is
// published, so by the time the page can ask a pad to read those frames they are written and visible — the
// engine never reads a frame that is still being filled. `setsMutex_` guards the map and the ranges.
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include <juce_events/juce_events.h>

#include "terminator/core/Engine.h"
#include "terminator/stems/SplitSession.h"
#include "terminator/stems/StemModel.h"
#include "terminator/stems/StemModels.h"
#include "terminator/stems/StemSet.h"

namespace terminator::app
{
class SampleRegistry;

class StemHub : private juce::Timer
{
  public:
    /// `stashBytes` is how a span's PCM gets to the page (ShellServices::stashBytes → `/blob/<token>`).
    StemHub(Engine& engine, SampleRegistry& registry, const juce::File& dataDir,
            std::function<juce::String(std::vector<std::byte>)> stashBytes);
    ~StemHub() override;

    /// Progress / ready spans / done / errors → the page. Set by the shell.
    std::function<void(const juce::String& event, const juce::var& payload)> onEvent;

    /// `terminatorStems(req)` — req.verb ∈ status · split · queueWindow · cancel · downloadModels ·
    /// deleteModels · modelsDir · forget. Message thread.
    juce::var handle(const juce::var& req);

    /// `setPadStems {pad, key, mask}` — attach the stems of source `key` to a pad (mask 0/15 or an unknown key
    /// detaches, and the ORIGINAL plays). Message thread; the shell routes the JSON command here.
    juce::var setPadStems(const juce::var& cmd);

    /// The stems of a source key, or nullptr. Message thread.
    const stems::StemSet* setFor(const juce::String& key) const;
    bool busy() const { return running_.load(std::memory_order_relaxed); }
    /// For the app's self-test: what the hub can do on this machine right now.
    juce::var statusVar() const;

  private:
    void timerCallback() override;
    void post(const juce::String& event, juce::var payload, std::vector<std::byte> bytes = {});
    juce::var startSplit(const juce::var& req);
    void runSplit(std::shared_ptr<SampleBuffer> source, juce::String key, stems::Quality quality,
                  std::vector<stems::Span> windows, bool sweep, bool keepPlanes);
    void stopWorker();
    juce::var rangesVar(const juce::String& key) const;
    /// If our own folder is empty and the Electron app's on this machine is not, THAT is our folder (same
    /// files, same SHA-256s). Runs at startup and again whenever the folder is reset to the default.
    void adoptElectronModels();

    Engine& engine_;
    SampleRegistry& registry_;
    juce::File dataDir_;
    std::function<juce::String(std::vector<std::byte>)> stashBytes_;
    stems::StemModels models_;
    /// Did the USER pick this folder (Preferences → CHANGE…)? The auto-adopted Electron folder does not count —
    /// USE DEFAULT is about undoing a choice, and re-adopting is what "default" means on such a machine.
    bool modelsDirChosen_ = false;
    stems::StemModel model_;
    bool modelLoaded_ = false;
    stems::Quality loadedQuality_ = stems::Quality::fast;

    mutable std::mutex setsMutex_;
    std::map<juce::String, std::shared_ptr<stems::StemSet>> sets_;

    std::thread worker_;
    std::shared_ptr<stems::SplitSession> session_; // the live one (cancel reaches it from the message thread)
    std::atomic<bool> running_{false};
    std::atomic<bool> cancelDownload_{false};
    juce::String currentKey_;

    struct Outgoing
    {
        juce::String event;
        juce::var payload;
        /// A ready span's PCM: stashed on the message thread (the blob table is not thread-safe) and turned
        /// into the `blob` property just before the event goes out.
        std::vector<std::byte> bytes;
    };
    std::mutex outboxMutex_;
    std::vector<Outgoing> outbox_;
};
} // namespace terminator::app
