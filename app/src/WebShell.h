#pragma once
// WebShell — the WebView that renders the UI, plus bridge v0 (docs/native/BRIDGE-PROTOCOL.md):
//   JS → C++ : native functions  terminator.info()  terminator.command(json)
//   C++ → JS : event "terminator.snapshot" at 20 Hz with the engine StateSnapshot + device info
// The page is served from embedded resources at WebBrowserComponent::getResourceProviderRoot(); set
// TERMINATOR_UI_URL=http://localhost:5173 to point the view at a dev server instead (Phase 2 HMR loop).
// Probe mode (CI / headless smoke): TERMINATOR_PROBE_FILE=<path> — ~2.5 s after the page loads, the shell
// evaluates JS inside the WebView, writes what the page rendered (bridge/engine/device/snapshot lines) as
// JSON to that file and quits. Proves WebView + bridge + engine end-to-end without a screenshot.
#include <juce_gui_extra/juce_gui_extra.h>

#include "terminator/core/Engine.h"
#include "terminator/io/AudioIO.h"

namespace terminator::app
{

class WebShell final : public juce::Component, private juce::Timer
{
  public:
    WebShell(Engine& engine, AudioIO& audioIO, juce::String audioError);
    ~WebShell() override;

    void resized() override;

  private:
    class Browser;
    void timerCallback() override;
    void pageLoaded(const juce::String& url);
    void runProbe();
    std::optional<juce::WebBrowserComponent::Resource> provideResource(const juce::String& url);
    juce::var engineInfo() const;
    bool applyJsonCommand(const juce::var& json, juce::String& error);

    Engine& engine_;
    AudioIO& audioIO_;
    juce::String audioError_;
    std::unique_ptr<Browser> browser_;
    juce::File probeFile_;
    bool pageReady_ = false; // no events to the page before it has loaded (window.__JUCE__ is injected with it)
    bool probeArmed_ = false;
    int probeCountdown_ = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(WebShell)
};

} // namespace terminator::app
