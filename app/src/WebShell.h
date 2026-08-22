#pragma once
// WebShell — the WebView that renders the UI, plus the bridge (docs/native/BRIDGE-PROTOCOL.md):
//   JS → C++ : native functions  terminatorInfo() · terminatorCommand(cmd) · terminatorAudio(req) ·
//              terminatorMidi(req) · terminatorPads(req) · terminatorFs(req) · terminatorSettings(req)
//   C++ → JS : event "terminator.snapshot" at 20 Hz with the engine StateSnapshot + device/MIDI stats
// The page is served at WebBrowserComponent::getResourceProviderRoot(): the built React UI (ui/dist, copied
// into the app bundle's Resources/ui at build time — or TERMINATOR_UI_DIR=<dir> to point at any dist folder)
// when present, else the embedded Phase-1 static page. TERMINATOR_UI_URL=http://localhost:5173 points the view
// at the Vite dev server instead (HMR inside the WebView).
// Probe mode (CI / headless smoke): TERMINATOR_PROBE_FILE=<path> — ~2.5 s after the page loads, the shell
// evaluates JS inside the WebView, writes what the page rendered (bridge/engine/device/snapshot lines) as
// JSON to that file and quits. Proves WebView + bridge + engine end-to-end without a screenshot.
#include <memory>
#include <vector>

#include <juce_gui_extra/juce_gui_extra.h>

#include "terminator/core/Engine.h"
#include "terminator/io/AudioIO.h"
#include "terminator/io/MidiHub.h"
#include "terminator/io/SampleLoader.h"
#include "terminator/io/SampleStore.h"
#include "terminator/io/Settings.h"

#include "ShellServices.h"

namespace terminator::app
{

class WebShell final : public juce::Component, private juce::Timer
{
  public:
    WebShell(Engine& engine, AudioIO& audioIO, MidiHub& midi, SampleStore& samples, SampleLoader& loader,
             Settings& settings, juce::String audioError);
    ~WebShell() override;

    void resized() override;

  private:
    class Browser;
    void timerCallback() override;
    void pageLoaded(const juce::String& url);
    void runProbe();
    void runProbeAsyncChecks();
    std::optional<juce::WebBrowserComponent::Resource> provideResource(const juce::String& url);
    /// Where the built React UI lives (ui/dist copied into the bundle at build time, or TERMINATOR_UI_DIR).
    static juce::File resolveUiDir();

    juce::var engineInfo() const;
    juce::var deviceInfoVar() const;
    juce::var applyJsonCommand(const juce::var& json);
    juce::var handleAudio(const juce::var& req);
    juce::var handleMidi(const juce::var& req);
    void handlePads(const juce::var& req, juce::WebBrowserComponent::NativeFunctionCompletion complete);
    juce::var padsVar() const;
    void persistAudioSetup();
    void finishCalibration();
    static juce::var ok(bool okFlag, const juce::String& error = {});

    Engine& engine_;
    AudioIO& audioIO_;
    MidiHub& midi_;
    SampleStore& samples_;
    SampleLoader& loader_;
    Settings& settings_;
    ShellServices services_; // terminatorFs / terminatorSettings — the window.terminator shim's backend
    juce::String audioError_;
    std::unique_ptr<Browser> browser_;
    std::unique_ptr<juce::FileChooser> chooser_;
    std::uint32_t padSampleIds_[kMaxPads] = {};
    juce::String padSampleNames_[kMaxPads];
    juce::File padSampleFiles_[kMaxPads];
    std::uint32_t calibrationCounter_ = 0;
    std::uint32_t calibrationPending_ = 0;
    double calibrationResultSamples_ = -1.0;
    double calibrationResultMs_ = -1.0;
    int calibrationReportedSamples_ = 0;
    juce::File probeFile_;
    juce::File uiDir_;       // invalid = no built UI present → the embedded Phase-1 static page is served
    bool pageReady_ = false; // no events to the page before it has loaded (window.__JUCE__ is injected with it)
    bool probeArmed_ = false;
    int probeCountdown_ = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(WebShell)
};

} // namespace terminator::app
