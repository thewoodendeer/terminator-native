#pragma once
// ProcessHub — `terminatorProcess`: the page runs the BUNDLED command-line tools (today: yt-dlp, for YouTube
// import — the Electron youtubeDownloader.ts logic lives in the page, see ui/src/renderer/native/youtubeNative.ts)
// as child processes. Protocol (BRIDGE-PROTOCOL.md §terminatorProcess):
//   spawn {id, tool:"ytdlp", args:[…]} → {ok}        the ONLY executables are the bundled ones (`tool` is a name,
//                                                     never a path); the shell prepends yt-dlp's fixed flags
//                                                     (--no-update, --js-runtimes quickjs:<bundled qjs dir>)
//   kill {id} → {ok} · list → {ok, running:[ids]} · tools → {ok, ytdlp, qjs, lame, ytdlpDir, qjsDir}
//   events: terminator.processOutput {id, data}   merged stdout+stderr, ≤ 8 KB per event (JUCE's emitEvent escape
//           is quadratic in the payload — keep events small);  terminator.processExit {id, code}
// A reader thread per child blocks on readProcessOutput and posts to the message thread; kill() from the message
// thread; the hub owns every child for the app's lifetime and kills them on destruction.
#include <functional>
#include <map>
#include <memory>

#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

namespace terminator::app
{

class ProcessHub
{
  public:
    using Emit = std::function<void(const juce::String& event, const juce::var& payload)>;
    explicit ProcessHub(Emit emit);
    ~ProcessHub();

    juce::var handle(const juce::var& req);

    /// The bundled tools (empty when not bundled — e.g. an engine-only / -DTERMINATOR_BUNDLE_TOOLS=OFF build).
    static juce::File bundledBinDir();
    static juce::File ytdlpLauncher();
    static juce::File qjsBinary();
    /// The bundled `lame` MP3 encoder — driven by the engine's file writer, never spawned through this hub.
    static juce::File lameBinary();

  private:
    struct Job;
    static juce::var ok(bool okFlag, const juce::String& error = {});
    juce::var spawn(const juce::var& req);
    juce::var kill(const juce::var& req);
    juce::var list() const;
    juce::var tools() const;
    void onOutput(const juce::String& id, const juce::String& data);
    void onExit(const juce::String& id, int code);

    Emit emit_;
    std::shared_ptr<bool> alive_ = std::make_shared<bool>(true);
    std::map<juce::String, std::shared_ptr<Job>> jobs_;
};

} // namespace terminator::app
