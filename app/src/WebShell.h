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
#include <atomic>
#include <map>
#include <memory>
#include <vector>

#include <juce_gui_extra/juce_gui_extra.h>

#include "terminator/core/Engine.h"
#include "terminator/io/AudioIO.h"
#include "terminator/io/MidiHub.h"
#include "terminator/io/SampleLoader.h"
#include "terminator/io/SampleStore.h"
#include "terminator/io/Settings.h"

#include "PluginHub.h"
#include "PluginRack.h"
#include "ProcessHub.h"
#include "SampleRegistry.h"
#if TERMINATOR_STEMS
#include "StemHub.h"
#endif
#include "CloudPresets.h"
#include "LicenseHub.h"
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

    /// Something the OS handed the app: a `terminator://…` deep link (8.5, the browser sign-in's auth callback)
    /// or a PROJECT FILE to open (8.6, double-clicked in Finder / Explorer). True when it was handled.
    /// Message thread.
    bool handleOpenRequest(const juce::String& urlOrPath);

    /// THE MENU (8.6) — the app's menu bar forwards here, and these forward to the PAGE (it owns projects, exports
    /// and the layout; the menu is a second way in, never a second implementation).
    void menuCommand(const juce::String& key);
    void menuOpenRecent(const juce::String& path);
    void openPreferencesFromMenu();

  private:
    class Browser;
    class PrefsWindow;
    juce::WebBrowserComponent::Options makeOptions();         // the bridge (native functions, user scripts, resources)
    juce::String startUrlFor(const juce::String& page) const; // "" = the root page, "preferences/preferences.html"
    void emitToAll(const juce::String& event, const juce::var& payload); // main window + Preferences (when open)
    void openPreferences();
    /// Preferences is a second always-on-top window; hiding it does NOT hand keyboard focus back, so the main
    /// window stays un-keyed and the page never sees a keydown — pads went dead until the user clicked something.
    /// Called from both close paths (the title-bar button and the page's closePreferences verb).
    void closePreferences();
    void timerCallback() override;
    void pageLoaded(const juce::String& url);
    void runProbe();
    void runProbeAsyncChecks();
    std::optional<juce::WebBrowserComponent::Resource> provideResource(const juce::String& url);
    /// Where the built React UI lives (ui/dist copied into the bundle at build time, or TERMINATOR_UI_DIR).
    static juce::File resolveUiDir();

    juce::var engineInfo() const;
    /// RECORDING (5.1a): the `terminatorRecord` bridge function — start / stop / status for a native take.
    juce::var handleRecord(const juce::var& req);
    juce::var probeRecordArm();
    juce::var probePluginRack(); // probe: a REAL plugin opened on a strip and attached (6.2)                      //
                                 // probe: the 5.1c arm + monitor over the bridge handler
    std::uint64_t recordLatencyCompensation() const; // 5.1d: the measured round trip, else the reported latencies
    juce::String recordPath_; // the take in progress (5.1c: a punch-out closes it here and tells the page which file)
    juce::var deviceInfoVar() const;
    juce::var applyJsonCommand(const juce::var& json);
    juce::var handleAudio(const juce::var& req);
    juce::var handleMidi(const juce::var& req);
    void applyMidiSettings(const juce::var& appSettings); // app.midi.clock → the engine, app.midi.outputs → the hub
    /// `terminatorExport(req)` — render the page's project OFFLINE through the same engine + mixer and write WAVs.
    /// Runs on its own thread against an INDEPENDENT Engine (renderOffline builds its own), so the live engine and
    /// the audio callback are untouched; the sample buffers are held by shared_ptr for the duration.
    void handleExport(const juce::var& req, juce::WebBrowserComponent::NativeFunctionCompletion complete);
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
    std::shared_ptr<std::atomic<bool>> alive_ = std::make_shared<std::atomic<bool>>(true); // export threads outlive us
    /// Cancel flags for exports in flight, by the page's job id. Message thread only; the render thread reads its
    /// own shared_ptr, so a job can be cancelled after the map entry is gone.
    std::map<juce::String, std::shared_ptr<std::atomic<bool>>> exportCancels_;
    SampleRegistry registry_; // terminatorSamples + setPadSample/setPadLoop — the page's audio in the SampleStore
    ProcessHub processes_;    // terminatorProcess — the bundled yt-dlp as a child process (YouTube import)
    LicenseHub license_;      // terminatorLicense — browser sign-in, the device token in the OS store (8.5)
    CloudPresets cloud_;      // terminatorCloud — your presets on your KCC account, authorised with that token
    PluginHub plugins_;       // terminatorPlugins — the VST3/AU scan (in child processes) + the known list (6.1)
    PluginRack rack_;         // …and the loaded ones: instances, editors, state (6.2). MUST be declared after
                              // plugins_ (it holds a reference) and destroyed before the engine stops
#if TERMINATOR_STEMS
    StemHub stems_; // terminatorStems — htdemucs in process, the planes the pads read (7.1c). After
                    // registry_ (it holds a reference), destroyed before the engine stops
#endif
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
    /// A project the OS handed us before the page was ready (cold-start double-click) — flushed by pageLoaded.
    juce::String pendingOpenFile_;
    juce::File probeFile_;
    juce::File uiDir_;        // invalid = no built UI present → the embedded Phase-1 static page is served
    bool pageReady_ = false;  // no events to the page before it has loaded (window.__JUCE__ is injected with it)
    bool prefsReady_ = false; // the Preferences page has loaded (events may be sent to it)
    bool probeArmed_ = false;
    int probeCountdown_ = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(WebShell)
};

} // namespace terminator::app
