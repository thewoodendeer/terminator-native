#pragma once
// ShellServices — the native functions behind the UI's `window.terminator` shim (ui/src/renderer/native/
// ipc-native.ts): generic, small, message-thread file/dialog/settings verbs the React app composes into the
// Electron-era IPC surface (projects, recents, EULA, layout/MIDI-map/bass-patch files, presets, session).
// Protocol: docs/native/BRIDGE-PROTOCOL.md §terminatorFs / §terminatorSettings. Nothing here touches the engine.
#include <functional>
#include <memory>

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

    /// `terminatorFs(req)` — req.verb ∈ dirs · readText · writeText · exists · list · mkdir · trash · reveal ·
    /// openExternal · openDialog · saveDialog · clipboardReadText. Dialogs complete asynchronously.
    void handleFs(const juce::var& req, Completion complete);
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
};

} // namespace terminator::app
