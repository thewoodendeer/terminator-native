#pragma once
// ShellServices — the native functions behind the UI's `window.terminator` shim (ui/src/renderer/native/
// ipc-native.ts): generic, small, message-thread file/dialog/settings verbs the React app composes into the
// Electron-era IPC surface (projects, recents, EULA, layout/MIDI-map/bass-patch files, presets, session).
// Protocol: docs/native/BRIDGE-PROTOCOL.md §terminatorFs / §terminatorSettings. Nothing here touches the engine.
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <vector>

#include <juce_gui_basics/juce_gui_basics.h>
#include <juce_gui_extra/juce_gui_extra.h>

#include "terminator/io/Settings.h"

namespace terminator::app
{

class ShellServices
{
  public:
    using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;

    explicit ShellServices(Settings& settings);

    /// `terminatorFs(req)` — req.verb ∈ dirs · readText · readBinary · writeText · writeBinary · exists · stat ·
    /// list · mkdir · move · copy · trash · reveal · openPath · openExternal · openDialog · saveDialog ·
    /// clipboardReadText · serveRoots. Dialogs complete asynchronously.
    void handleFs(const juce::var& req, Completion complete);

    /// LARGE REPLIES: JUCE's emitEvent escapes every C++→JS payload into a JS string literal with a quadratic
    /// String::replace — a 230 KB library.json took minutes (caught by the probe 2026-08-22). Replies bigger than
    /// kLargeReplyBytes are stashed and answered as { ok:true, __largeReply:"/blob/<token>" }; the page fetches the
    /// JSON through the resource provider (juceBridge.ts does this transparently) — one-shot, 60 s expiry.
    static constexpr int kLargeReplyBytes = 24 * 1024;
    juce::var maybeLarge(const juce::var& reply);
    /// The resource provider's side: the stashed bytes for a token (consumed), or nullopt. A JSON stash
    /// (maybeLarge) or a FILE stash (`readBinary` — the page fetches the file's bytes through /blob/<token>).
    struct BlobData
    {
        std::vector<std::byte> bytes;
        juce::String mime;
    };
    std::optional<BlobData> takeBlob(const juce::String& token);

    /// Files the resource provider may serve at `/lib/b64/<base64url(path)>`: anything under a root the page
    /// registered with `serveRoots` (the sample-library root + its linked folders — the page's own library
    /// module decides, the shell enforces). Nothing is servable until the page registers roots.
    bool mayServe(const juce::File& f) const;
    /// `terminatorSettings(req)` — req.verb ∈ get · set{patch}. The UI's settings live under settings.json `app`
    /// (the Electron terminator-settings.json keys, verbatim — Phase 8 imports that file here).
    juce::var handleSettings(const juce::var& req);

    /// The app data dir (<userApplicationData>/Terminator3) and the projects dir (settings app.projectsDir or
    /// <dataDir>/projects).
    juce::File dataDir() const;
    juce::File projectsDir() const;
    bool projectsDirIsDefault() const;
    juce::var appSettings() const; // the `app` object (never void)
    juce::var dirsVar() const;

    /// JS injected before every page script: `window.__TERMINATOR_NATIVE__ = { version, settings, dirs }` — the
    /// synchronous boot reads (getSettingsSync) the Electron preload offered.
    juce::String bootUserScript(const juce::String& version) const;

    /// Fired after `set` so the shell can broadcast `terminator.settingsChanged` to every window.
    std::function<void(const juce::var& settings)> onSettingsChanged;

  private:
    static juce::var ok(bool okFlag, const juce::String& error = {});
    static juce::File fileFromVar(const juce::var& v);

    Settings& settings_;
    std::unique_ptr<juce::FileChooser> chooser_;
    std::vector<juce::File> servableRoots_;
    struct Blob
    {
        juce::String json; // a JSON reply (maybeLarge) …
        juce::File file;   // … or a file to stream (readBinary)
        juce::String mime;
        juce::int64 expiresMs;
    };
    juce::String stash(Blob blob);
    std::map<juce::String, Blob> blobs_;
    juce::Random blobRandom_;
};

} // namespace terminator::app
