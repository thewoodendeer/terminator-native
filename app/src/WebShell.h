#pragma once
// WebShell — the WebView that renders the UI, plus the bridge (docs/native/BRIDGE-PROTOCOL.md):
//   JS → C++ : native functions  terminatorInfo() · terminatorCommand(cmd) · terminatorAudio(req) ·
//              terminatorMidi(req) · terminatorPads(req) · terminatorSamples(req) · terminatorFs(req) ·
//              terminatorSettings(req) · terminatorWindow(req) · terminatorProcess(req)
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

#include "ProcessHub.h"
#include "SampleRegistry.h"
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
    class PrefsWindow;
    juce::WebBrowserComponent::Options makeOptions();         // the bridge (native functions, user scripts, resources)
    juce::String startUrlFor(const juce::String& page) const; // "" = the root page, "preferences/preferences.html"
    void emitToAll(const juce::String& event, const juce::var& payload); // main window + Preferences (when open)
    void openPreferences();
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
    ShellServices services_;  // terminatorFs / terminatorSettings — the window.terminator shim's backend
    SampleRegistry registry_; // terminatorSamples + setPadSample/setPadLoop — the page's audio in the SampleStore
    ProcessHub processes_;    // terminatorProcess — the bundled yt-dlp as a child process (YouTube import)
    juce::String audioError_;
    std::unique_ptr<Browser> browser_;
    std::unique_ptr<PrefsWindow> prefsWindow_; // Preferences = a second window hosting the React preferences page
    std::unique_ptr<juce::FileChooser> chooser_;
    // chop-seq patterns handed to the engine by pointer: a ring keeps the last few alive (the audio thread may still
    // read a replaced pattern for a block or two; 8 back is far beyond that)
    std::vector<std::shared_ptr<SeqPattern>> patternRing_;
    // drum patterns (the grid) + the four graphs, same pointer hand-over (Phase 3.3): the arranger books up to a few
    // dozen swaps ahead, so the pattern ring is deeper; graphs change rarely
    std::vector<std::shared_ptr<DrumPattern>> drumPatternRing_;
    std::vector<std::shared_ptr<DrumGraphs>> drumGraphsRing_;
    // the bass (Phase 3.4): the patch, the pattern (tick map) and the arranger timeline, same pointer hand-over
    std::vector<std::shared_ptr<BassPatch>> bassPatchRing_;
    std::vector<std::shared_ptr<BassPattern>> bassPatternRing_;
    std::vector<std::shared_ptr<BassTimeline>> bassTimelineRing_;
    std::uint32_t padSampleIds_[kMaxPads] = {};
    juce::String padSampleNames_[kMaxPads];
    juce::File padSampleFiles_[kMaxPads];
    std::uint32_t calibrationCounter_ = 0;
    std::uint32_t calibrationPending_ = 0;
    double calibrationResultSamples_ = -1.0;
    double calibrationResultMs_ = -1.0;
    int calibrationReportedSamples_ = 0;
    juce::File probeFile_;
    juce::File uiDir_;        // invalid = no built UI present → the embedded Phase-1 static page is served
    bool pageReady_ = false;  // no events to the page before it has loaded (window.__JUCE__ is injected with it)
    bool prefsReady_ = false; // the Preferences page has loaded (events may be sent to it)
    bool probeArmed_ = false;
    int probeCountdown_ = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(WebShell)
};

} // namespace terminator::app
