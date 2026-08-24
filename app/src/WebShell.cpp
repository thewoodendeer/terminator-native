#include "WebShell.h"

#include <algorithm>
#include <cmath>
#include <thread>
#include <iostream>

#include "WebResources.h"
#include "terminator/Version.h"
#include "terminator/model/ProjectModel.h"
#include "terminator/render/BassSpec.h"
#include "terminator/render/ProjectRenderer.h"

namespace terminator::app
{

/// WebBrowserComponent with a page-loaded hook (needed for probe mode and, later, for bridge handshakes).
class WebShell::Browser final : public juce::WebBrowserComponent
{
  public:
    Browser(const juce::WebBrowserComponent::Options& options, std::function<void(const juce::String&)> onLoaded)
        : juce::WebBrowserComponent(options), onLoaded_(std::move(onLoaded))
    {
    }
    void pageFinishedLoading(const juce::String& url) override
    {
        if (onLoaded_)
            onLoaded_(url);
    }

  private:
    std::function<void(const juce::String&)> onLoaded_;
};

// Preferences: a second DocumentWindow hosting the React preferences page (ui/dist/preferences/preferences.html)
// through the SAME bridge options as the main window — one backend, two pages. Closing hides it (the page keeps
// its state); the shell owns it for the app's lifetime.
class WebShell::PrefsWindow final : public juce::DocumentWindow
{
  public:
    PrefsWindow(const juce::WebBrowserComponent::Options& options, const juce::String& url,
                std::function<void(const juce::String&)> onLoaded)
        : juce::DocumentWindow("Terminator Preferences", juce::Colours::black, juce::DocumentWindow::closeButton),
          browser_(std::make_unique<Browser>(options, std::move(onLoaded)))
    {
        setUsingNativeTitleBar(true);
        setContentNonOwned(browser_.get(), false);
        setResizable(false, false);
        centreWithSize(560, 680);
        setAlwaysOnTop(true);
        browser_->goToURL(url);
    }
    ~PrefsWindow() override { browser_ = nullptr; }
    void closeButtonPressed() override
    {
        setVisible(false);
        if (onClosed)
            onClosed();
    }
    std::function<void()> onClosed;
    Browser& browser() noexcept { return *browser_; }

  private:
    std::unique_ptr<Browser> browser_;
};

namespace
{
constexpr int kSnapshotHz = 20;
constexpr int kProbeDelayTicks = 50;       // 2.5 s at 20 Hz — enough for info() + a few snapshots
constexpr int kProbeDelayTicksReact = 600; // 30 s — the React UI: fonts + first render + engines constructing, then
                                           // the async checks (start at kProbeAsyncLeadTicks = 26 s before the read)
constexpr int kProbeAsyncLeadTicks = 520;  // the shim round-trip checks start 26 s before the final read (the shadow's
                                           // self-test alone runs ~15 s since 3.2–4.2 drive the native sequencers, the
                                           // count-in, the arp, the live-record landing and the mixer round trips; the
                                           // self-test reports its per-part `timing`)

juce::var arrayVar(const juce::StringArray& a)
{
    juce::Array<juce::var> out;
    for (const auto& s : a)
        out.add(s);
    return juce::var(out);
}
template <typename T> juce::var arrayVar(const juce::Array<T>& a)
{
    juce::Array<juce::var> out;
    for (const auto& s : a)
        out.add(s);
    return juce::var(out);
}
juce::var maskVar(const juce::BigInteger& m)
{
    juce::Array<juce::var> out;
    for (int i = 0; i <= m.getHighestBit(); ++i)
        if (m[i])
            out.add(i);
    return juce::var(out);
}
std::vector<int> intVector(const juce::var& v)
{
    std::vector<int> out;
    if (const auto* a = v.getArray())
        for (const auto& x : *a)
            out.push_back(static_cast<int>(x));
    return out;
}

const char* mimeForExtension(const juce::String& extWithDot)
{
    const auto e = extWithDot.toLowerCase();
    if (e == ".html" || e == ".htm")
        return "text/html";
    if (e == ".js" || e == ".mjs")
        return "text/javascript";
    if (e == ".css")
        return "text/css";
    if (e == ".json" || e == ".webmanifest" || e == ".map")
        return "application/json";
    if (e == ".svg")
        return "image/svg+xml";
    if (e == ".png")
        return "image/png";
    if (e == ".jpg" || e == ".jpeg")
        return "image/jpeg";
    if (e == ".gif")
        return "image/gif";
    if (e == ".webp")
        return "image/webp";
    if (e == ".ico")
        return "image/x-icon";
    if (e == ".mp4")
        return "video/mp4";
    if (e == ".webm")
        return "video/webm";
    if (e == ".mp3")
        return "audio/mpeg";
    if (e == ".wav")
        return "audio/wav";
    if (e == ".flac")
        return "audio/flac";
    if (e == ".ogg")
        return "audio/ogg";
    if (e == ".m4a")
        return "audio/mp4";
    if (e == ".aac")
        return "audio/aac";
    if (e == ".aif" || e == ".aiff")
        return "audio/aiff";
    if (e == ".opus")
        return "audio/ogg";
    if (e == ".caf")
        return "audio/x-caf";
    if (e == ".woff2")
        return "font/woff2";
    if (e == ".woff")
        return "font/woff";
    if (e == ".ttf")
        return "font/ttf";
    if (e == ".otf")
        return "font/otf";
    if (e == ".wasm")
        return "application/wasm";
    if (e == ".txt")
        return "text/plain";
    return "application/octet-stream";
}

double numOr(const juce::var& o, const char* key, double fallback)
{
    if (!o.isObject() || !o.hasProperty(key))
        return fallback;
    const auto& v = o[key];
    if (!v.isDouble() && !v.isInt() && !v.isInt64() && !v.isBool())
        return fallback;
    const double d = static_cast<double>(v);
    return std::isfinite(d) ? d : fallback;
}
juce::String strOr(const juce::var& o, const char* key, const juce::String& fallback)
{
    if (!o.isObject() || !o.hasProperty(key) || !o[key].isString())
        return fallback;
    return o[key].toString();
}
std::uint8_t bassTagOf(const juce::var& j, std::uint8_t fallback)
{
    const auto t = strOr(j, "tag", "");
    if (t == "seq")
        return 1;
    if (t == "live")
        return 2;
    if (t == "arr")
        return 3;
    if (t == "prev")
        return 4;
    if (t == "x")
        return 5;
    return fallback;
}
/// `strip` 0..kMaxStrips−1 (the mixer, Phase 4.1).
int stripOf(const juce::var& j)
{
    return std::clamp(static_cast<int>(j.getProperty("strip", 0)), 0, kMaxStrips - 1);
}

std::uint64_t atSampleOf(const juce::var& j)
{
    const auto at = static_cast<juce::int64>(j.getProperty("atSample", 0));
    return at > 0 ? static_cast<std::uint64_t>(at) : 0;
}
} // namespace

juce::var WebShell::ok(bool okFlag, const juce::String& error)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("ok", okFlag);
    if (!okFlag)
        obj->setProperty("error", error);
    return juce::var(obj);
}

WebShell::WebShell(Engine& engine, AudioIO& audioIO, MidiHub& midi, SampleStore& samples, SampleLoader& loader,
                   Settings& settings, juce::String audioError)
    : engine_(engine), audioIO_(audioIO), midi_(midi), samples_(samples), loader_(loader), settings_(settings),
      services_(settings), registry_(engine, samples, loader),
      processes_([this](const juce::String& ev, const juce::var& payload) { emitToAll(ev, payload); }),
      audioError_(std::move(audioError))
{
    const auto probePath = juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_FILE", {});
    if (probePath.isNotEmpty())
    {
        probeFile_ = juce::File::getCurrentWorkingDirectory().getChildFile(probePath);
        // headless smoke: the React UI shows the EULA on a first launch (as it should) — pre-accept it IN MEMORY
        // for this run only (nothing is saved unless the page writes settings) so ChopperView renders.
        settings_.set("app.eula.accepted", true);
    }

    uiDir_ = resolveUiDir();

    browser_ = std::make_unique<Browser>(makeOptions(), [this](const juce::String& url) { pageLoaded(url); });
    addAndMakeVisible(*browser_);

    services_.onSettingsChanged = [this](const juce::var& settings)
    {
        applyMidiSettings(settings); // Preferences → MIDI: clock send + the output toggles live in `app.midi`
        emitToAll("terminator.settingsChanged", settings);
    };
    audioIO_.onDeviceChanged = [this] { emitToAll("terminator.devicesChanged", deviceInfoVar()); };
    midi_.onPortsChanged = [this]
    { emitToAll("terminator.midiChanged", handleMidi(juce::var(new juce::DynamicObject()))); };
    // every message a device sent (notes, CCs, bend, the transport bytes the clock lock accepted), mirrored to the
    // page AFTER the engine got it on the direct MidiHub → engine path (notes → pads when the routing allows) — the
    // page runs its one MIDI router on it (pads marked nativeOwned, bass MIDI IN, DRUM PADS, learn, START/STOP)
    midi_.onMessage = [this](const MidiEvent& e, const juce::String& portName)
    {
        auto* o = new juce::DynamicObject();
        juce::Array<juce::var> data;
        for (int i = 0; i < static_cast<int>(e.size); ++i)
            data.add(static_cast<int>(e.data[i]));
        o->setProperty("data", juce::var(data));
        o->setProperty("hostNs", static_cast<juce::int64>(e.hostTimeNs));
        o->setProperty("port", static_cast<int>(e.port));
        o->setProperty("portName", portName);
        emitToAll("terminator.midiMessage", juce::var(o));
    };
    // the clock-IN follower settled on a new tempo (≤ 1 per beat) — the page applies its "follow tempo" preference
    midi_.onClockBpm = [this](double bpm, int port)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("bpm", bpm);
        o->setProperty("port", port);
        emitToAll("terminator.midiClock", juce::var(o));
    };
    applyMidiSettings(services_.appSettings());

    browser_->goToURL(startUrlFor({}));

    startTimerHz(kSnapshotHz);
    setSize(1200, 800);
}

juce::WebBrowserComponent::Options WebShell::makeOptions()
{
    // Runs before every page script: collect uncaught errors + unhandled rejections so the headless probe (and a
    // future crash-report) can read them — the WebView has no console we can see in CI.
    static const char* kErrorCollector = R"JS((function(){
        if (window.__terminatorErrors) return;
        const errs = []; window.__terminatorErrors = errs;
        const push = (m) => { if (errs.length < 50) errs.push(String(m).slice(0, 400)); };
        window.addEventListener('error', (e) => push((e && e.message) || 'error'), true);
        window.addEventListener('unhandledrejection', (e) => push('unhandledrejection: ' + ((e && e.reason && (e.reason.stack || e.reason.message || e.reason)) || '')));
    })();)JS";

    // TERMINATOR_PROBE_AUDIO=1: the library self-test also tries an <audio> load through the resource provider
    // (kept opt-in: a media load through the scheme handler is the one thing that can stall the page)
    // TERMINATOR_PROBE_NET=1: the library self-test also pulls one short public YouTube video through the bundled
    // yt-dlp into a TEMP root (network; never the user's library) — the end-to-end YouTube import smoke test
    const juce::String probeAudio =
        juce::String(juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_AUDIO", {}).isNotEmpty()
                         ? "window.__terminatorProbeAudio = true;"
                         : "void 0;") +
        juce::String(juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_NET", {}).isNotEmpty()
                         ? "window.__terminatorProbeNet = true;"
                         : "void 0;");
    auto opts =
        juce::WebBrowserComponent::Options{}
            .withNativeIntegrationEnabled()
            .withKeepPageLoadedWhenBrowserIsHidden()
            .withUserScript(kErrorCollector)
            .withUserScript(probeAudio)
            // window.__TERMINATOR_BOOT__ = { version, settings, dirs } before any page script (sync boot reads)
            .withUserScript(services_.bootUserScript(terminator::versionString()))
            .withResourceProvider([this](const juce::String& url) { return provideResource(url); })
            .withNativeFunction("terminatorFs", [this](const juce::Array<juce::var>& args,
                                                       juce::WebBrowserComponent::NativeFunctionCompletion complete)
                                { services_.handleFs(args.size() > 0 ? args[0] : juce::var(), std::move(complete)); })
            .withNativeFunction(
                "terminatorSettings",
                [this](const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion complete)
                { complete(services_.handleSettings(args.size() > 0 ? args[0] : juce::var())); })
            .withNativeFunction("terminatorInfo", [this](const juce::Array<juce::var>&,
                                                         juce::WebBrowserComponent::NativeFunctionCompletion complete)
                                { complete(engineInfo()); })
            .withNativeFunction(
                "terminatorCommand",
                [this](const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion complete)
                { complete(applyJsonCommand(args.size() > 0 ? args[0] : juce::var())); })
            .withNativeFunction("terminatorAudio", [this](const juce::Array<juce::var>& args,
                                                          juce::WebBrowserComponent::NativeFunctionCompletion complete)
                                { complete(handleAudio(args.size() > 0 ? args[0] : juce::var())); })
            .withNativeFunction("terminatorMidi", [this](const juce::Array<juce::var>& args,
                                                         juce::WebBrowserComponent::NativeFunctionCompletion complete)
                                { complete(handleMidi(args.size() > 0 ? args[0] : juce::var())); })
            .withNativeFunction("terminatorPads", [this](const juce::Array<juce::var>& args,
                                                         juce::WebBrowserComponent::NativeFunctionCompletion complete)
                                { handlePads(args.size() > 0 ? args[0] : juce::var(), std::move(complete)); })
            .withNativeFunction("terminatorExport", [this](const juce::Array<juce::var>& args,
                                                           juce::WebBrowserComponent::NativeFunctionCompletion complete)
                                { handleExport(args.size() > 0 ? args[0] : juce::var(), std::move(complete)); })
            .withNativeFunction(
                "terminatorSamples",
                [this](const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion complete)
                { complete(registry_.handle(args.size() > 0 ? args[0] : juce::var())); })
            .withNativeFunction(
                "terminatorProcess",
                [this](const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion complete)
                { complete(processes_.handle(args.size() > 0 ? args[0] : juce::var())); })
            .withNativeFunction(
                "terminatorWindow",
                [this](const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion complete)
                {
                    const auto verb =
                        args.size() > 0 ? args[0].getProperty("verb", juce::var()).toString() : juce::String();
                    if (verb == "preferences")
                    {
                        openPreferences();
                        complete(ok(true));
                    }
                    else if (verb == "closePreferences")
                    {
                        closePreferences();
                        complete(ok(true));
                    }
                    else
                        complete(ok(false, "unknown window verb '" + verb + "'"));
                });
#if JUCE_WINDOWS
    opts = opts.withBackend(juce::WebBrowserComponent::Options::Backend::webview2)
               .withWinWebView2Options(
                   juce::WebBrowserComponent::Options::WinWebView2{}
                       .withUserDataFolder(
                           juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("TerminatorWebView2"))
                       .withStatusBarDisabled()
                       .withBackgroundColour(juce::Colours::black));
#endif
    return opts;
}

juce::String WebShell::startUrlFor(const juce::String& page) const
{
    const auto devUrl = juce::SystemStats::getEnvironmentVariable("TERMINATOR_UI_URL", {});
    auto root = devUrl.isNotEmpty() ? devUrl : juce::WebBrowserComponent::getResourceProviderRoot();
    if (!root.endsWithChar('/'))
        root += "/";
    return root + page;
}

void WebShell::emitToAll(const juce::String& event, const juce::var& payload)
{
    if (pageReady_)
        browser_->emitEventIfBrowserIsVisible(event, payload);
    if (prefsWindow_ != nullptr && prefsReady_)
        prefsWindow_->browser().emitEventIfBrowserIsVisible(event, payload);
}

void WebShell::openPreferences()
{
    if (prefsWindow_ == nullptr)
    {
        prefsReady_ = false;
        prefsWindow_ = std::make_unique<PrefsWindow>(makeOptions(), startUrlFor("preferences/preferences.html"),
                                                     [this](const juce::String&) { prefsReady_ = true; });
        prefsWindow_->onClosed = [this] { closePreferences(); };
    }
    prefsWindow_->setVisible(true);
    prefsWindow_->toFront(true);
}

void WebShell::closePreferences()
{
    if (prefsWindow_ != nullptr)
        prefsWindow_->setVisible(false);
    if (browser_ == nullptr)
        return;
    // Bring the APPLICATION forward first: on macOS toFront()/grabKeyboardFocus() do nothing at all while Terminator
    // is not the frontmost app, which is why closing Preferences still needed a click on the main window.
    juce::Process::makeForegroundProcess();
    // Make the main window key again and put the focus back inside it…
    if (auto* top = browser_->getTopLevelComponent())
        top->toFront(true);
    browser_->grabKeyboardFocus();
    // …and tell the PAGE to take keyboard focus too: the native view can be key while the document is not focused,
    // which is exactly the "keys do nothing until I click a pad" symptom.
    browser_->emitEventIfBrowserIsVisible("terminator.focusMain", juce::var());
}

WebShell::~WebShell()
{
    alive_->store(false); // an export thread may still be running: its callback must not touch us
    stopTimer();
    audioIO_.onDeviceChanged = nullptr;
    midi_.onPortsChanged = nullptr;
    midi_.onMessage = nullptr;
    midi_.onClockBpm = nullptr;
    services_.onSettingsChanged = nullptr;
    prefsWindow_ = nullptr;
    browser_ = nullptr;
}

void WebShell::resized()
{
    browser_->setBounds(getLocalBounds());
}

std::optional<juce::WebBrowserComponent::Resource> WebShell::provideResource(const juce::String& url)
{
    struct Entry
    {
        const char* path;
        const char* data;
        int size;
        const char* mime;
    };
    static const Entry entries[] = {
        {"/", WebResources::index_html, WebResources::index_htmlSize, "text/html"},
        {"/index.html", WebResources::index_html, WebResources::index_htmlSize, "text/html"},
        {"/juce/index.js", WebResources::index_js, WebResources::index_jsSize, "text/javascript"},
    };
    // 0a. a large native-function reply stashed by ShellServices::maybeLarge (one-shot JSON)
    if (url.startsWith("/blob/"))
    {
        const auto token = url.fromFirstOccurrenceOf("/blob/", false, false).upToFirstOccurrenceOf("?", false, false);
        if (auto blob = services_.takeBlob(token))
        {
            juce::WebBrowserComponent::Resource r;
            r.data = std::move(blob->bytes);
            r.mimeType = blob->mime;
            return r;
        }
        return std::nullopt;
    }
    // 0b. library files: /lib/b64/<base64url(absolute path)> — only under roots the page registered (serveRoots)
    if (url.startsWith("/lib/b64/"))
    {
        auto token = url.fromFirstOccurrenceOf("/lib/b64/", false, false)
                         .upToFirstOccurrenceOf("?", false, false)
                         .upToFirstOccurrenceOf("#", false, false)
                         .replaceCharacter('-', '+')
                         .replaceCharacter('_', '/');
        while (token.length() % 4 != 0)
            token += "=";
        juce::MemoryOutputStream raw;
        if (!juce::Base64::convertFromBase64(raw, token))
            return std::nullopt;
        const auto path =
            juce::String::fromUTF8(static_cast<const char*>(raw.getData()), static_cast<int>(raw.getDataSize()));
        if (!juce::File::isAbsolutePath(path))
            return std::nullopt;
        const juce::File f(path);
        if (!services_.mayServe(f))
            return std::nullopt;
        juce::MemoryBlock mb;
        if (!f.loadFileAsData(mb))
            return std::nullopt;
        juce::WebBrowserComponent::Resource r;
        r.data.assign(static_cast<const std::byte*>(mb.getData()),
                      static_cast<const std::byte*>(mb.getData()) + mb.getSize());
        r.mimeType = mimeForExtension(f.getFileExtension());
        return r;
    }
    // 1. the built React UI from disk (ui/dist) — when present it owns "/" and everything under it
    if (uiDir_ != juce::File())
    {
        auto path = url.upToFirstOccurrenceOf("?", false, false).upToFirstOccurrenceOf("#", false, false);
        if (path == "/" || path.isEmpty())
            path = "/index.html";
        else if (path.endsWithChar('/'))
            path += "index.html";
        // never leave the UI dir (no "..", no absolute Windows paths)
        if (!path.contains("..") && !path.containsChar(':') && path.startsWithChar('/'))
        {
            auto f = uiDir_.getChildFile(path.substring(1));
            if (f.isDirectory())
                f = f.getChildFile("index.html");
            if (f.existsAsFile() && f.isAChildOf(uiDir_))
            {
                juce::MemoryBlock mb;
                if (f.loadFileAsData(mb))
                {
                    juce::WebBrowserComponent::Resource r;
                    r.data.assign(static_cast<const std::byte*>(mb.getData()),
                                  static_cast<const std::byte*>(mb.getData()) + mb.getSize());
                    r.mimeType = mimeForExtension(f.getFileExtension());
                    return r;
                }
            }
        }
        if (url != "/juce/index.js")
            return std::nullopt; // a real 404 inside the UI; /juce/index.js stays available below
    }
    // 2. the embedded Phase-1 static page + the JUCE webview ESM
    for (const auto& e : entries)
    {
        if (url == e.path)
        {
            juce::WebBrowserComponent::Resource r;
            r.data.assign(reinterpret_cast<const std::byte*>(e.data),
                          reinterpret_cast<const std::byte*>(e.data) + e.size);
            r.mimeType = e.mime;
            return r;
        }
    }
    return std::nullopt;
}

juce::File WebShell::resolveUiDir()
{
    const auto env = juce::SystemStats::getEnvironmentVariable("TERMINATOR_UI_DIR", {});
    if (env.isNotEmpty())
    {
        const auto d = juce::File::getCurrentWorkingDirectory().getChildFile(env);
        return d.getChildFile("index.html").existsAsFile() ? d : juce::File();
    }
#if JUCE_MAC
    const auto d = juce::File::getSpecialLocation(juce::File::currentApplicationFile)
                       .getChildFile("Contents")
                       .getChildFile("Resources")
                       .getChildFile("ui");
#else
    const auto d =
        juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory().getChildFile("ui");
#endif
    return d.getChildFile("index.html").existsAsFile() ? d : juce::File();
}

juce::var WebShell::deviceInfoVar() const
{
    const auto dev = audioIO_.currentDevice();
    auto* d = new juce::DynamicObject();
    d->setProperty("type", dev.typeName);
    d->setProperty("inputDevice", dev.inputDeviceName);
    d->setProperty("outputDevice", dev.outputDeviceName);
    d->setProperty("name", dev.outputDeviceName.isNotEmpty() ? dev.outputDeviceName : dev.inputDeviceName);
    d->setProperty("sampleRate", dev.sampleRate);
    d->setProperty("bufferSize", dev.bufferSize);
    d->setProperty("inputs", dev.numInputs);
    d->setProperty("outputs", dev.numOutputs);
    d->setProperty("inputLatencySamples", dev.inputLatencySamples);
    d->setProperty("outputLatencySamples", dev.outputLatencySamples);
    d->setProperty("inputLatencyMs", dev.sampleRate > 0 ? dev.inputLatencySamples * 1000.0 / dev.sampleRate : 0.0);
    d->setProperty("outputLatencyMs", dev.sampleRate > 0 ? dev.outputLatencySamples * 1000.0 / dev.sampleRate : 0.0);
    d->setProperty("open", dev.open);
    d->setProperty("error", dev.lastError.isNotEmpty() ? dev.lastError : audioError_);
    d->setProperty("inputChannelNames", arrayVar(dev.inputChannelNames));
    d->setProperty("outputChannelNames", arrayVar(dev.outputChannelNames));
    d->setProperty("activeInputChannels", maskVar(dev.activeInputChannels));
    d->setProperty("activeOutputChannels", maskVar(dev.activeOutputChannels));
    d->setProperty("availableSampleRates", arrayVar(dev.availableSampleRates));
    d->setProperty("availableBufferSizes", arrayVar(dev.availableBufferSizes));
    d->setProperty("xruns", dev.xruns);
    d->setProperty("cpuLoad", dev.cpuLoad);
    d->setProperty("calibrationSamples", calibrationResultSamples_);
    d->setProperty("calibrationMs", calibrationResultMs_);
    d->setProperty("calibrationReportedSamples", calibrationReportedSamples_);
    return juce::var(d);
}

juce::var WebShell::engineInfo() const
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("app", "Terminator");
    obj->setProperty("version", terminator::versionString());
    obj->setProperty("juce", juce::String(JUCE_MAJOR_VERSION) + "." + juce::String(JUCE_MINOR_VERSION) + "." +
                                 juce::String(JUCE_BUILDNUMBER));
    obj->setProperty("os", juce::SystemStats::getOperatingSystemName());
    obj->setProperty("cpu", juce::SystemStats::getCpuModel());
#if JUCE_ARM
    obj->setProperty("arch", "arm64");
#elif JUCE_INTEL
    obj->setProperty("arch", "x86_64");
#else
    obj->setProperty("arch", "unknown");
#endif
    obj->setProperty("bridgeProtocol", 1);
    obj->setProperty("maxPads", kMaxPads); // 128: 0..63 the chopper grid, 64..127 the drum lanes (3.3)
    obj->setProperty("chopPads", kChopPads);
    obj->setProperty("drumPadBase", kDrumPadBase);
    obj->setProperty("drumLanes", kDrumLanes);
    obj->setProperty("bassPpq", kBassPpq); // the bass sequencer's tick resolution (3.4)
    obj->setProperty("bassMaxBars", kBassMaxBars);
    obj->setProperty("bassMaxVoices", kBassMaxVoices);
    obj->setProperty("maxVoices", kMaxVoices);
    obj->setProperty("device", deviceInfoVar());
    obj->setProperty("settingsFile", settings_.file().getFullPathName());
    return juce::var(obj);
}

juce::var WebShell::applyJsonCommand(const juce::var& json)
{
    if (!json.isObject())
        return ok(false, "command must be an object");
    const auto type = json["type"].toString();
    // the pad-binding commands resolve page keys → SampleStore buffers in the registry (it pushes the commands)
    if (type == "setPadSample")
        return registry_.setPadSample(json);
    if (type == "setPadLoop")
        return registry_.setPadLoop(json);
    // the chop sequencer (Phase 3.1): a whole pattern → SeqPattern (grid bit masks + per-cell velocity), by pointer
    if (type == "queueSequence" && static_cast<bool>(json.getProperty("cancel", false)))
    {
        // the UI re-selected the playing pattern: drop the pending switch (no-op when stopped)
        if (!engine_.commands().push(Command::seqQueuePattern(nullptr)))
            return ok(false, "command queue full");
        return ok(true);
    }
    if (type == "setSequence" || type == "queueSequence")
    {
        auto pat = std::make_shared<SeqPattern>();
        pat->clear();
        pat->index = static_cast<int>(json.getProperty("index", 0));
        pat->bars = std::clamp(static_cast<int>(json.getProperty("bars", 2)), 1, 4);
        pat->resolution = std::clamp(static_cast<int>(json.getProperty("resolution", 16)), 1, 384);
        pat->stepCount = std::min(kSeqMaxSteps, pat->bars * pat->resolution);
        pat->loop = static_cast<bool>(json.getProperty("loop", true));
        pat->swing = std::clamp(static_cast<double>(json.getProperty("swing", 0.0)), 0.0, 1.0);
        const auto* grid = json.getProperty("grid", juce::var()).getArray();
        const auto* vel = json.getProperty("velGrid", juce::var()).getArray();
        if (grid != nullptr)
            for (int st = 0; st < pat->stepCount && st < grid->size(); ++st)
            {
                const auto* row = (*grid)[st].getArray();
                if (row == nullptr)
                    continue;
                const auto* vrow = (vel != nullptr && st < vel->size()) ? (*vel)[st].getArray() : nullptr;
                for (int k = 0; k < row->size(); ++k)
                {
                    const int pad = static_cast<int>((*row)[k]);
                    if (pad < 0 || pad >= kSeqMaxPads)
                        continue;
                    pat->grid[st] |= (1ull << pad);
                    const double v = (vrow != nullptr && k < vrow->size()) ? static_cast<double>((*vrow)[k]) : 1.0;
                    pat->velocity[st][pad] = static_cast<float>(std::clamp(v, 0.05, 1.0));
                }
            }
        const Command c =
            type == "queueSequence" ? Command::seqQueuePattern(pat.get()) : Command::seqSetPattern(pat.get());
        if (!engine_.commands().push(c))
            return ok(false, "command queue full");
        patternRing_.push_back(std::move(pat));
        while (patternRing_.size() > 8)
            patternRing_.erase(patternRing_.begin());
        return ok(true);
    }
    // the drum sequencer (Phase 3.3): the pattern grid + the four graphs by pointer, like the chop patterns
    if (type == "setDrumPattern" || type == "scheduleDrumPattern")
    {
        auto pat = std::make_shared<DrumPattern>();
        pat->clear();
        pat->bars = std::clamp(static_cast<int>(json.getProperty("bars", 2)), 1, 4);
        pat->stepsPerBar =
            std::clamp(static_cast<int>(json.getProperty("stepsPerBar", kDrumStepsPerBar)), 1, kDrumStepsPerBar);
        pat->stepCount = std::min(kDrumMaxSteps, pat->bars * pat->stepsPerBar);
        if (const auto* lanes = json.getProperty("lanes", juce::var()).getArray())
            for (const auto& lv : *lanes)
            {
                const int lane = static_cast<int>(lv.getProperty("lane", -1));
                const auto* steps = lv.getProperty("steps", juce::var()).getArray();
                if (lane < 0 || lane >= kDrumLanes || steps == nullptr)
                    continue;
                for (const auto& sv : *steps)
                {
                    const int st = static_cast<int>(sv);
                    if (st >= 0 && st < pat->stepCount)
                        pat->grid[st] |= (1ull << lane);
                }
            }
        const auto at = static_cast<std::uint64_t>(static_cast<juce::int64>(json.getProperty("atSample", 0)));
        const Command c = type == "scheduleDrumPattern" ? Command::drumSchedulePattern(pat.get(), at)
                                                        : Command::drumSetPattern(pat.get());
        if (!engine_.commands().push(c))
            return ok(false, "command queue full");
        drumPatternRing_.push_back(std::move(pat));
        while (drumPatternRing_.size() > 48)
            drumPatternRing_.erase(drumPatternRing_.begin());
        return ok(true);
    }
    if (type == "setDrumGraphs")
    {
        auto g = std::make_shared<DrumGraphs>();
        g->clear();
        if (const auto* lanes = json.getProperty("lanes", juce::var()).getArray())
            for (const auto& lv : *lanes)
            {
                const int lane = static_cast<int>(lv.getProperty("lane", -1));
                if (lane < 0 || lane >= kDrumLanes)
                    continue;
                auto fill = [&](const char* name, auto&& put)
                {
                    if (const auto* arr = lv.getProperty(name, juce::var()).getArray())
                        for (int st = 0; st < arr->size() && st < kDrumMaxSteps; ++st)
                            put(st, static_cast<double>((*arr)[st]));
                };
                fill("velocity",
                     [&](int st, double v) { g->velocity[st][lane] = static_cast<float>(std::clamp(v, 0.0, 1.0)); });
                fill("shift",
                     [&](int st, double v) { g->shiftMs[st][lane] = static_cast<float>(std::clamp(v, -50.0, 50.0)); });
                fill("pan", [&](int st, double v) { g->pan[st][lane] = static_cast<float>(std::clamp(v, -1.0, 1.0)); });
                fill("repeat",
                     [&](int st, double v)
                     {
                         g->repeat[st][lane] = static_cast<std::uint8_t>(
                             std::clamp(static_cast<int>(std::lround(v)), 0, kDrumRepeatRates - 1));
                     });
            }
        if (!engine_.commands().push(Command::drumSetGraphs(g.get())))
            return ok(false, "command queue full");
        drumGraphsRing_.push_back(std::move(g));
        while (drumGraphsRing_.size() > 4)
            drumGraphsRing_.erase(drumGraphsRing_.begin());
        return ok(true);
    }
    // the bass (Phase 3.4): the patch (deep-merged over the defaults), the pattern as a PPQ-96 tick map + its BEND lane
    // per tick, the arranger's absolute timeline — by pointer (rings of 8 / 16 / 4)
    if (type == "setBassPatch")
    {
        auto patch = std::make_shared<BassPatch>(render::bassPatchFromVar(json.getProperty("patch", juce::var())));
        if (!engine_.commands().push(Command::bassSetPatch(patch.get())))
            return ok(false, "command queue full");
        bassPatchRing_.push_back(std::move(patch));
        while (bassPatchRing_.size() > 8)
            bassPatchRing_.erase(bassPatchRing_.begin());
        return ok(true);
    }
    if (type == "setBassPattern")
    {
        auto pat = std::make_shared<BassPattern>();
        render::bassPatternFromVar(json, *pat); // the SAME parser the offline exporter uses
        if (!engine_.commands().push(Command::bassSetPattern(pat.get())))
            return ok(false, "command queue full");
        bassPatternRing_.push_back(std::move(pat));
        while (bassPatternRing_.size() > 16)
            bassPatternRing_.erase(bassPatternRing_.begin());
        return ok(true);
    }
    if (type == "setBassTimeline")
    {
        // the arranger's absolute-time events: [{kind on|off|slide|bend, atSample, note, vel, dur (slide s), semis}]
        auto tl = std::make_shared<BassTimeline>();
        if (const auto* events = json.getProperty("events", juce::var()).getArray())
            for (const auto& e : *events)
            {
                const auto kind = strOr(e, "kind", "");
                const int note = static_cast<int>(numOr(e, "note", 36));
                const auto at = atSampleOf(e);
                if (kind == "on")
                    tl->add(BassSynth::EventKind::on, at, note,
                            static_cast<float>(std::clamp(numOr(e, "vel", 0.9), 0.05, 1.0)), 0.0);
                else if (kind == "off")
                    tl->add(BassSynth::EventKind::off, at, note, 0.0f, 0.0);
                else if (kind == "slide")
                    tl->add(BassSynth::EventKind::slide, at, note, 0.0f, std::max(0.005, numOr(e, "dur", 0.25)));
                else if (kind == "bend")
                    tl->add(BassSynth::EventKind::bend, at, 0, 0.0f, numOr(e, "semis", 0.0));
            }
        if (!engine_.commands().push(Command::bassSetTimeline(tl.get())))
            return ok(false, "command queue full");
        bassTimelineRing_.push_back(std::move(tl));
        while (bassTimelineRing_.size() > 4)
            bassTimelineRing_.erase(bassTimelineRing_.begin());
        return ok(true);
    }
    Command c;
    if (type == "clearDrumPatterns")
        c = Command::drumClearScheduled();
    else if (type == "setDrumLane")
        c = Command::drumSetLane(static_cast<std::uint16_t>(static_cast<int>(json.getProperty("lane", 0))),
                                 static_cast<float>(static_cast<double>(json.getProperty("volume", 1.0))),
                                 static_cast<bool>(json.getProperty("audible", true)),
                                 static_cast<std::int16_t>(static_cast<int>(json.getProperty("group", 0))));
    else if (type == "setDrumParams")
        c = Command::drumSetParams(static_cast<double>(json.getProperty("swing", 0.0)),
                                   static_cast<float>(static_cast<double>(json.getProperty("masterVolume", 1.0))),
                                   static_cast<std::uint16_t>(static_cast<int>(json.getProperty("ppq", 960))));
    else if (type == "drumPlay")
        c = Command::drumPlay(static_cast<std::uint64_t>(static_cast<juce::int64>(json.getProperty("atSample", 0))),
                              static_cast<std::int32_t>(static_cast<int>(json.getProperty("stepOffset", 0))));
    else if (type == "drumStop")
        c = Command::drumStop();
    else if (type == "clearBassTimeline")
        c = Command::bassClearTimeline();
    else if (type == "bassArrangerDriven")
        c = Command::bassArrangerDriven(static_cast<bool>(json.getProperty("on", false)));
    else if (type == "bassBendLane")
        c = Command::bassBendLane(static_cast<bool>(json.getProperty("on", true)));
    else if (type == "bassPlay")
        c = Command::bassPlay(atSampleOf(json),
                              static_cast<std::int32_t>(static_cast<int>(json.getProperty("offsetTicks", 0))));
    else if (type == "bassStop")
        c = Command::bassStop();
    else if (type == "bassNote")
        c = Command::bassNote(
            static_cast<bool>(json.getProperty("on", true)),
            static_cast<std::uint8_t>(std::clamp(static_cast<int>(json.getProperty("note", 36)), 0, 127)),
            static_cast<float>(std::clamp(static_cast<double>(json.getProperty("velocity", 1.0)), 0.0, 1.0)),
            atSampleOf(json), bassTagOf(json, 2));
    else if (type == "bassSlide")
        c = Command::bassSlide(
            static_cast<std::uint8_t>(std::clamp(static_cast<int>(json.getProperty("note", 36)), 0, 127)),
            std::max(0.005, static_cast<double>(json.getProperty("dur", 0.25))), atSampleOf(json), bassTagOf(json, 2));
    else if (type == "bassBend")
        c = Command::bassBend(static_cast<double>(json.getProperty("semis", 0.0)), atSampleOf(json),
                              bassTagOf(json, 2));
    else if (type == "bassMod")
        c = Command::bassMod(static_cast<double>(json.getProperty("value", 0.0)));
    else if (type == "bassClear")
        c = Command::bassClear(bassTagOf(json, 0), static_cast<bool>(json.getProperty("release", true)));
    else if (type == "bassPanic")
        c = Command::bassPanic();
    else if (type == "midiClockEnable")
        c = Command::midiClockEnable(static_cast<bool>(json.getProperty("on", false)));
    else if (type == "setMidiRouting")
        c = Command::setMidiRouting(static_cast<bool>(json.getProperty("pads", true)));
    // the metronome + count-in + arp (Phase 3.6, core/Metronome.h + core/Arp.h)
    else if (type == "setMetronome")
    {
        const auto snd = json.getProperty("sound", "click").toString();
        const std::uint8_t sound = snd == "hihat"     ? 1
                                   : snd == "rimshot" ? 2
                                   : snd == "kick"    ? 3
                                   : snd == "clap"    ? 4
                                                      : 0;
        c = Command::setMetronome(static_cast<bool>(json.getProperty("enabled", false)), sound);
    }
    else if (type == "countIn")
        c = Command::countIn(std::clamp(static_cast<int>(json.getProperty("beats", 4)), 1, 16), atSampleOf(json));
    else if (type == "cancelCountIn")
        c = Command::cancelCountIn();
    else if (type == "setArp")
        c = Command::setArp(static_cast<bool>(json.getProperty("enabled", false)),
                            std::clamp(static_cast<int>(json.getProperty("rate", 4)), 1, 64),
                            json.getProperty("direction", "up").toString() == "down",
                            static_cast<bool>(json.getProperty("random", false)),
                            std::clamp(static_cast<int>(json.getProperty("padCount", 0)), 0, kChopPads));
    else if (type == "arpHold")
        c = Command::arpHold(
            static_cast<std::uint16_t>(std::clamp(static_cast<int>(json.getProperty("pad", 0)), 0, kChopPads - 1)),
            static_cast<float>(std::clamp(static_cast<double>(json.getProperty("velocity", 1.0)), 0.0, 1.0)),
            atSampleOf(json));
    else if (type == "arpRelease")
        c = Command::arpRelease(
            static_cast<std::int16_t>(std::clamp(static_cast<int>(json.getProperty("pad", -1)), -1, kChopPads - 1)));
    else if (type == "seqPlay")
        c = Command::seqPlay(static_cast<std::uint64_t>(static_cast<juce::int64>(json.getProperty("atSample", 0))));
    else if (type == "seqStop")
        c = Command::seqStop();
    else if (type == "seqPause")
        c = Command::seqPause();
    else if (type == "seqResume")
        c = Command::seqResume();
    else if (type == "setBpm")
        c = Command::seqSetBpm(static_cast<double>(json.getProperty("bpm", 120.0)));
    else if (type == "seqLoop")
        c = Command::seqSetLoop(static_cast<bool>(json.getProperty("on", true)));
    else if (type == "setMasterGain")
        c = Command::setMasterGain(static_cast<float>(static_cast<double>(json["gain"])));
    else if (type == "setTestTone")
        c = Command::setTestTone(static_cast<bool>(json["enabled"]),
                                 static_cast<float>(static_cast<double>(json.getProperty("frequencyHz", 440.0))),
                                 static_cast<float>(static_cast<double>(json.getProperty("amplitude", 0.25))),
                                 static_cast<std::uint8_t>(static_cast<int>(json.getProperty("outputPair", 0))));
    else if (type == "transportPlay")
        c = Command::transportPlay();
    else if (type == "transportStop")
        c = Command::transportStop();
    else if (type == "panic")
        c = Command::panic();
    else if (type == "triggerPad")
    {
        // atSample > 0 = an ENGINE SAMPLE position (the page's NativeClock maps ctx time → samples): inside the
        // current block it fires at that offset, past it the engine books it and fires it sample-exact (quantized
        // live-record hits — "quantize what I hear" with no timer jitter)
        const auto at = static_cast<juce::int64>(json.getProperty("atSample", 0));
        const auto pad = static_cast<std::uint16_t>(static_cast<int>(json["pad"]));
        const auto vel = static_cast<float>(static_cast<double>(json.getProperty("velocity", 1.0)));
        c = at > 0 ? Command::triggerPadAtSample(pad, vel, static_cast<std::uint64_t>(at))
                   : Command::triggerPad(pad, vel);
        if (json.hasProperty("pan")) // a drum lane's PAN for this hit (overrides the pad's PadParams::pan)
        {
            c.payload.trigger.hasPan = 1;
            c.payload.trigger.pan = static_cast<float>(static_cast<double>(json["pan"]));
        }
    }
    else if (type == "releasePad")
    {
        const auto at = static_cast<juce::int64>(json.getProperty("atSample", 0));
        const auto pad = static_cast<std::uint16_t>(static_cast<int>(json["pad"]));
        c = at > 0 ? Command::releasePadAtSample(pad, static_cast<std::uint64_t>(at)) : Command::releasePad(pad);
    }
    else if (type == "stopPad")
        c = Command::stopPad(static_cast<std::uint16_t>(static_cast<int>(json["pad"])));
    else if (type == "setNoteMap")
        c = Command::setNoteMap(static_cast<std::uint8_t>(static_cast<int>(json["note"])),
                                static_cast<std::int16_t>(static_cast<int>(json.getProperty("pad", -1))));
    else if (type == "setPadParams")
    {
        PadParams p;
        p.pad = static_cast<std::uint16_t>(static_cast<int>(json["pad"]));
        p.pitchSemitones = static_cast<float>(static_cast<double>(json.getProperty("pitch", 0.0)));
        p.fineCents = static_cast<float>(static_cast<double>(json.getProperty("fine", 0.0)));
        p.attackSec = static_cast<float>(static_cast<double>(json.getProperty("attack", 0.003)));
        p.releaseSec = static_cast<float>(static_cast<double>(json.getProperty("release", 0.0)));
        p.fadeOutSec = static_cast<float>(static_cast<double>(json.getProperty("fadeOut", 0.0)));
        p.gain = static_cast<float>(static_cast<double>(json.getProperty("gain", 1.0)));
        p.outputPair = static_cast<std::uint8_t>(static_cast<int>(json.getProperty("outputPair", 0)));
        const auto mode = json.getProperty("mode", "oneshot").toString();
        p.mode = mode == "gate" ? PadMode::gate : mode == "loop" ? PadMode::loop : PadMode::oneShot;
        p.reverse = static_cast<bool>(json.getProperty("reverse", false)) ? 1 : 0;
        p.gate = static_cast<bool>(json.getProperty("gate", false)) ? 1 : 0;
        p.chokeGroup = static_cast<std::int16_t>(static_cast<int>(json.getProperty("chokeGroup", -1)));
        p.interpolation = json.getProperty("interpolation", "hermite").toString() == "linear" ? Interpolation::linear
                                                                                              : Interpolation::hermite;
        p.pan = static_cast<float>(static_cast<double>(json.getProperty("pan", 0.0)));
        p.chokeFadeSec = static_cast<float>(static_cast<double>(json.getProperty("chokeFade", 0.003)));
        p.strip = static_cast<std::int16_t>(
            std::clamp(static_cast<int>(json.getProperty("strip", -1)), -1, kMaxStrips - 1)); // 4.1: the mixer strip
        c = Command::setPadParams(p);
    }
    // the mixer (Phase 4.1, core/Mixer.h) — strips by index (0 = the master; the page names them)
    else if (type == "mixerSetStrip")
    {
        const auto k = json.getProperty("kind", "channel").toString();
        const std::uint8_t kind = k == "off"    ? static_cast<std::uint8_t>(StripKind::off)
                                  : k == "send" ? static_cast<std::uint8_t>(StripKind::send)
                                  : k == "bus"  ? static_cast<std::uint8_t>(StripKind::bus)
                                                : static_cast<std::uint8_t>(StripKind::channel);
        // 4.2c: the CONSOLE seed (the page's FNV-1a of the strip NAME; absent / 0 = leave as is)
        const auto seed = static_cast<std::uint32_t>(
            std::clamp(static_cast<double>(json.getProperty("seed", 0.0)), 0.0, 4294967295.0));
        c = Command::mixerSetStrip(stripOf(json), kind, seed);
    }
    else if (type == "loudnessReset")
        c = Command::loudnessReset();
    else if (type == "mixerSetLimiter")
        c = Command::mixerSetLimiter(static_cast<bool>(json.getProperty("on", true)));
    else if (type == "mixerSetPdc")
        c = Command::mixerSetPdc(static_cast<bool>(json.getProperty("on", true)));
    else if (type == "mixerSetConsole")
    {
        const auto f = json.getProperty("flavour", "SSL").toString();
        const std::uint8_t flavour = f == "NEVE" ? 1 : (f == "API" ? 2 : 0);
        c = Command::mixerSetConsole(static_cast<bool>(json.getProperty("on", false)), flavour,
                                     static_cast<float>(static_cast<double>(json.getProperty("amount", 50.0))));
    }
    else if (type == "mixerSetFader")
        c = Command::mixerSetFader(stripOf(json), static_cast<float>(static_cast<double>(json.getProperty("db", 0.0))));
    else if (type == "mixerSetPan")
        c = Command::mixerSetPan(stripOf(json), static_cast<float>(static_cast<double>(json.getProperty("pan", 0.0))));
    else if (type == "mixerSetWidth")
        c = Command::mixerSetWidth(stripOf(json),
                                   static_cast<float>(static_cast<double>(json.getProperty("width", 1.0))));
    else if (type == "mixerSetMute")
        c = Command::mixerSetMute(stripOf(json), static_cast<bool>(json.getProperty("on", false)));
    else if (type == "mixerSetSolo")
        c = Command::mixerSetSolo(stripOf(json), static_cast<bool>(json.getProperty("on", false)));
    else if (type == "mixerSetSend")
        c = Command::mixerSetSend(stripOf(json), std::clamp(static_cast<int>(json.getProperty("send", 0)), 0, 3),
                                  static_cast<float>(static_cast<double>(json.getProperty("db", -60.0))),
                                  std::clamp(static_cast<int>(json.getProperty("target", -1)), -1, kMaxStrips - 1));
    else if (type == "mixerSetOutput")
    {
        const auto to = json.getProperty("to", "master").toString();
        const std::uint8_t kind = to == "strip"      ? static_cast<std::uint8_t>(StripOutput::strip)
                                  : to == "hardware" ? static_cast<std::uint8_t>(StripOutput::hardware)
                                  : to == "none"     ? static_cast<std::uint8_t>(StripOutput::none)
                                                     : static_cast<std::uint8_t>(StripOutput::master);
        c = Command::mixerSetOutput(stripOf(json), kind,
                                    std::clamp(static_cast<int>(json.getProperty("index", 0)), 0, kMaxStrips - 1));
    }
    else if (type == "mixerSetMainOut")
        c = Command::mixerSetMainOut(std::clamp(static_cast<int>(json.getProperty("pair", 0)), 0, 63));
    // the insert chain (Phase 4.2, core/fx/Effect.h) — devices by the page's FxId, params by the page's key
    else if (type == "mixerAddFx")
    {
        const auto id = json.getProperty("fx", "").toString();
        const FxType t = fxTypeFromId(id.toRawUTF8());
        if (t == FxType::none)
            return ok(false, "unknown fx '" + id + "'");
        c = Command::mixerAddFx(stripOf(json), static_cast<std::uint8_t>(t));
    }
    else if (type == "mixerRemoveFx")
        c = Command::mixerRemoveFx(stripOf(json), std::clamp(static_cast<int>(json.getProperty("index", 0)), 0, 7));
    else if (type == "mixerSetFxBypass")
        c = Command::mixerSetFxBypass(stripOf(json), std::clamp(static_cast<int>(json.getProperty("index", 0)), 0, 7),
                                      static_cast<bool>(json.getProperty("on", false)));
    else if (type == "mixerSetFxParam")
    {
        // the page names the device type so the key → index / option → index lookup is exact
        const auto id = json.getProperty("fx", "").toString();
        const FxType t = fxTypeFromId(id.toRawUTF8());
        const auto key = json.getProperty("key", "").toString();
        const int param = fxParamIndex(t, key.toRawUTF8());
        if (t == FxType::none || param < 0)
            return ok(false, "unknown fx param '" + id + "." + key + "'");
        const auto& v = json.getProperty("value", 0.0);
        float value;
        if (v.isString())
        {
            const int opt = fxOptionIndex(t, param, v.toString().toRawUTF8());
            if (opt < 0)
                return ok(false, "unknown option '" + v.toString() + "' for " + id + "." + key);
            value = static_cast<float>(opt);
        }
        else
            value = static_cast<float>(static_cast<double>(v));
        c = Command::mixerSetFxParam(stripOf(json), std::clamp(static_cast<int>(json.getProperty("index", 0)), 0, 7),
                                     param, value, static_cast<bool>(json.getProperty("immediate", false)));
    }
    else if (type == "mixerReorderFx")
        c = Command::mixerReorderFx(stripOf(json), std::clamp(static_cast<int>(json.getProperty("from", 0)), 0, 7),
                                    std::clamp(static_cast<int>(json.getProperty("to", 0)), 0, 7));
    else if (type == "mixerClearFx")
        c = Command::mixerClearFx(stripOf(json));
    else if (type == "setSourceStrip")
    {
        const auto src = json.getProperty("source", "bass").toString();
        c = Command::setSourceStrip(src == "click" ? 1 : 0,
                                    std::clamp(static_cast<int>(json.getProperty("strip", -1)), -1, kMaxStrips - 1));
    }
    else
        return ok(false, "unknown command type '" + type + "'");
    if (!engine_.commands().push(c))
        return ok(false, "command queue full");
    return ok(true);
}

void WebShell::persistAudioSetup()
{
    const auto s = audioIO_.currentSetup();
    auto* o = new juce::DynamicObject();
    o->setProperty("deviceType", s.deviceType);
    o->setProperty("inputDevice", s.inputDevice);
    o->setProperty("outputDevice", s.outputDevice);
    o->setProperty("sampleRate", s.sampleRate);
    o->setProperty("bufferSize", s.bufferSize);
    juce::Array<juce::var> in, out;
    for (int c : s.inputChannels)
        in.add(c);
    for (int c : s.outputChannels)
        out.add(c);
    o->setProperty("inputChannels", juce::var(in));
    o->setProperty("outputChannels", juce::var(out));
    settings_.set("audio", juce::var(o));
    settings_.save();
}

juce::var WebShell::handleAudio(const juce::var& req)
{
    const auto verb = req.isObject() ? req["verb"].toString() : juce::String("list");
    if (verb == "clock")
    {
        // the page's NativeClock calibrates host time ↔ performance.now() by round trip (keeps the best-RTT sample)
        const auto& s = engine_.snapshot();
        auto* o = new juce::DynamicObject();
        o->setProperty("ok", true);
        o->setProperty("hostNs", static_cast<juce::int64>(AudioIO::hostTimeNowNs()));
        o->setProperty("clockHostNs", static_cast<juce::int64>(s.clock.hostNs));
        o->setProperty("clockSample", static_cast<juce::int64>(s.clock.samplePosition));
        o->setProperty("sampleRate", s.sampleRate);
        o->setProperty("prepared", static_cast<bool>(s.prepared));
        const auto dev = audioIO_.currentDevice();
        o->setProperty("outputLatencyMs",
                       dev.sampleRate > 0 ? dev.outputLatencySamples * 1000.0 / dev.sampleRate : 0.0);
        return juce::var(o);
    }
    if (verb == "list" || verb == "apply" || verb == "enableAll" || verb == "default")
    {
        juce::String err;
        if (verb == "apply")
        {
            AudioIO::DeviceSetup s;
            s.deviceType = req.getProperty("deviceType", audioIO_.currentDeviceType()).toString();
            s.inputDevice = req["inputDevice"].toString();
            s.outputDevice = req["outputDevice"].toString();
            s.sampleRate = static_cast<double>(req.getProperty("sampleRate", 0.0));
            s.bufferSize = static_cast<int>(req.getProperty("bufferSize", 0));
            s.inputChannels = intVector(req["inputChannels"]);
            s.outputChannels = intVector(req["outputChannels"]);
            err = audioIO_.apply(s);
            if (err.isEmpty())
                persistAudioSetup();
        }
        else if (verb == "enableAll")
        {
            auto s = audioIO_.currentSetup();
            const auto dev = audioIO_.currentDevice();
            s.inputChannels.clear();
            s.outputChannels.clear();
            for (int i = 0; i < dev.inputChannelNames.size(); ++i)
                s.inputChannels.push_back(i);
            for (int i = 0; i < dev.outputChannelNames.size(); ++i)
                s.outputChannels.push_back(i);
            err = audioIO_.apply(s);
            if (err.isEmpty())
                persistAudioSetup();
        }
        else if (verb == "default")
        {
            err = audioIO_.openDefault(0, 2);
            if (err.isEmpty())
                persistAudioSetup();
        }
        auto* o = new juce::DynamicObject();
        o->setProperty("ok", err.isEmpty());
        if (err.isNotEmpty())
            o->setProperty("error", err);
        o->setProperty("deviceTypes", arrayVar(audioIO_.deviceTypes()));
        const auto type = audioIO_.currentDeviceType();
        const auto listType = req.isObject() && req.hasProperty("forType") ? req["forType"].toString() : type;
        o->setProperty("currentType", type);
        o->setProperty("listType", listType);
        o->setProperty("inputDevices", arrayVar(audioIO_.inputDevices(listType)));
        o->setProperty("outputDevices", arrayVar(audioIO_.outputDevices(listType)));
        o->setProperty("device", deviceInfoVar());
        return juce::var(o);
    }
    if (verb == "calibrate")
    {
        const auto dev = audioIO_.currentDevice();
        if (!dev.open || dev.numInputs == 0)
            return ok(false, "enable at least one INPUT channel (Channel Configuration) and connect it to the chosen "
                             "output with a cable");
        const int outCh = static_cast<int>(req.getProperty("outputChannel", 0));
        const int inCh = static_cast<int>(req.getProperty("inputChannel", 0));
        const auto frames = static_cast<std::uint32_t>(
            std::min<double>(dev.sampleRate * 1.0, Engine::kCalibrationMaxFrames)); // 1 s window
        calibrationPending_ = ++calibrationCounter_;
        calibrationResultSamples_ = -1.0;
        calibrationResultMs_ = -1.0;
        calibrationReportedSamples_ = dev.inputLatencySamples + dev.outputLatencySamples;
        if (!engine_.commands().push(Command::startCalibration(
                static_cast<std::uint16_t>(outCh), static_cast<std::uint16_t>(inCh), frames, calibrationPending_)))
            return ok(false, "command queue full");
        return ok(true);
    }
    return ok(false, "unknown audio verb '" + verb + "'");
}

void WebShell::finishCalibration()
{
    const auto& s = engine_.snapshot();
    if (calibrationPending_ == 0 || s.calibrationId != calibrationPending_)
        return;
    if (s.calibrationState == 3)
    {
        calibrationPending_ = 0;
        calibrationResultSamples_ = -2.0; // failed marker
        return;
    }
    if (s.calibrationState != 2)
        return;
    // cross-correlate capture × click → round trip in samples (engine-relative: click emitted at capture start)
    const float* cap = engine_.calibrationCapture();
    const int n = static_cast<int>(engine_.calibrationCaptureFrames());
    const float* click = Engine::calibrationClick();
    int bestLag = -1;
    double best = 0.0, energy = 0.0;
    for (int i = 0; i < n; ++i)
        energy += static_cast<double>(cap[i]) * static_cast<double>(cap[i]);
    for (int lag = 0; lag + Engine::kCalibrationClickFrames <= n; ++lag)
    {
        double acc = 0.0;
        for (int k = 0; k < Engine::kCalibrationClickFrames; ++k)
            acc += static_cast<double>(cap[lag + k]) * static_cast<double>(click[k]);
        if (acc > best)
        {
            best = acc;
            bestLag = lag;
        }
    }
    calibrationPending_ = 0;
    if (bestLag < 0 || energy < 1e-9)
    {
        calibrationResultSamples_ = -3.0; // nothing heard
        return;
    }
    calibrationResultSamples_ = bestLag;
    calibrationResultMs_ = s.sampleRate > 0 ? bestLag * 1000.0 / s.sampleRate : 0.0;
    settings_.set("calibration.roundTripSamples", bestLag);
    settings_.set("calibration.sampleRate", s.sampleRate);
    settings_.set("calibration.device", audioIO_.currentDevice().outputDeviceName);
    settings_.save();
}

void WebShell::applyMidiSettings(const juce::var& app)
{
    // Preferences → MIDI (the page's `app.midi` object, the Electron keys verbatim): "MIDI Clock (send)" → the
    // engine's clock OUT; the "MIDI Outputs" toggles (missing = ON) → which ports the pump sends to. "follow tempo"
    // stays the page's own gate (it owns the BPM state — it applies the `terminator.midiClock` reports).
    const auto midi = app.isObject() ? app.getProperty("midi", juce::var()) : juce::var();
    const bool clock = midi.isObject() && static_cast<bool>(midi.getProperty("clock", false));
    engine_.commands().push(Command::midiClockEnable(clock));
    midi_.applyOutputPrefs(midi.isObject() ? midi.getProperty("outputs", juce::var()) : juce::var());
}

juce::var WebShell::handleMidi(const juce::var& req)
{
    const auto verb = req.isObject() ? req.getProperty("verb", "list").toString() : juce::String("list");
    juce::String err;
    if (verb == "inject") // tests / the probe: a note as if it arrived on port 0 (engine queue + the page event)
    {
        if (const auto* raw = req.getProperty("data", juce::var()).getArray()) // raw bytes: transport / CC / clock
        {
            std::uint8_t bytes[3] = {0, 0, 0};
            const int n = std::min(3, raw->size());
            for (int i = 0; i < n; ++i)
                bytes[i] = static_cast<std::uint8_t>(static_cast<int>((*raw)[i]) & 0xFF);
            midi_.inject(bytes, n);
        }
        else
            midi_.injectNote(
                static_cast<int>(req.getProperty("note", 36)), static_cast<int>(req.getProperty("velocity", 100)),
                static_cast<bool>(req.getProperty("on", true)), static_cast<int>(req.getProperty("channel", 1)));
        return ok(true);
    }
    if (verb == "enable")
        err = midi_.enableInput(req["id"].toString(), static_cast<bool>(req.getProperty("enabled", true)));
    else if (verb == "enableAll")
        midi_.enableAllInputs();
    else if (verb == "refresh")
        midi_.refresh();
    else if (verb == "enableOutput")
    {
        // the same `app.midi.outputs` map the page's Preferences keep (missing = ON): persist + broadcast so every
        // window's toggle and the pump agree
        err = midi_.enableOutput(req["id"].toString(), static_cast<bool>(req.getProperty("enabled", true)));
        auto app = services_.appSettings();
        auto midi = app.getProperty("midi", juce::var());
        if (!midi.isObject())
            midi = juce::var(new juce::DynamicObject());
        auto outs = midi.getProperty("outputs", juce::var());
        if (!outs.isObject())
            outs = juce::var(new juce::DynamicObject());
        outs.getDynamicObject()->setProperty(req["id"].toString(), static_cast<bool>(req.getProperty("enabled", true)));
        midi.getDynamicObject()->setProperty("outputs", outs);
        auto* patch = new juce::DynamicObject();
        patch->setProperty("midi", midi);
        auto* set = new juce::DynamicObject();
        set->setProperty("verb", "set");
        set->setProperty("patch", juce::var(patch));
        services_.handleSettings(juce::var(set)); // → onSettingsChanged → applyMidiSettings + settingsChanged
    }
    if (verb == "enable" || verb == "enableAll")
    {
        auto* m = new juce::DynamicObject();
        for (const auto& p : midi_.inputs())
            m->setProperty(p.identifier, p.enabled);
        settings_.set("midi.inputs", juce::var(m));
        settings_.save();
    }
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", err.isEmpty());
    if (err.isNotEmpty())
        o->setProperty("error", err);
    juce::Array<juce::var> ports;
    for (const auto& p : midi_.inputs())
    {
        auto* po = new juce::DynamicObject();
        po->setProperty("id", p.identifier);
        po->setProperty("name", p.name);
        po->setProperty("enabled", p.enabled);
        po->setProperty("open", p.open);
        ports.add(juce::var(po));
    }
    o->setProperty("inputs", juce::var(ports));
    juce::Array<juce::var> outs;
    for (const auto& p : midi_.outputs())
    {
        auto* po = new juce::DynamicObject();
        po->setProperty("id", p.identifier);
        po->setProperty("name", p.name);
        po->setProperty("enabled", p.enabled);
        po->setProperty("open", p.open);
        outs.add(juce::var(po));
    }
    o->setProperty("outputs", juce::var(outs));
    o->setProperty("messages", static_cast<juce::int64>(midi_.messageCount()));
    o->setProperty("lastLagMs", midi_.lastInputLagMs());
    o->setProperty("medianLagMs", midi_.medianInputLagMs());
    o->setProperty("last", midi_.lastMessageDescription());
    const auto& s = engine_.snapshot();
    auto* clock = new juce::DynamicObject();
    clock->setProperty("enabled", static_cast<bool>(s.midiClockEnabled));
    clock->setProperty("running", static_cast<bool>(s.midiClockRunning));
    clock->setProperty("ticks", static_cast<juce::int64>(s.midiClockTicks));
    clock->setProperty("sent", static_cast<juce::int64>(midi_.sentCount()));
    clock->setProperty("lateMs", midi_.lastSendLatenessMs());
    clock->setProperty("maxLateMs", midi_.maxSendLatenessMs());
    clock->setProperty("inBpm", midi_.clockInBpm());
    clock->setProperty("inPort", midi_.clockInOwnerPort());
    clock->setProperty("inStarted", midi_.clockInStarted());
    o->setProperty("clock", juce::var(clock));
    return juce::var(o);
}

juce::var WebShell::padsVar() const
{
    juce::Array<juce::var> pads;
    for (int i = 0; i < kMaxPads; ++i)
    {
        const auto& p = engine_.pad(i);
        auto* o = new juce::DynamicObject();
        o->setProperty("pad", i);
        o->setProperty("hasSample", p.hasSample());
        o->setProperty("name", padSampleNames_[i]);
        o->setProperty("file", padSampleFiles_[i].getFullPathName());
        o->setProperty("frames", static_cast<juce::int64>(p.lengthFrames()));
        o->setProperty("sampleRate", p.sample != nullptr ? p.sample->sampleRate : 0.0);
        o->setProperty("channels", p.sample != nullptr ? p.sample->numChannels : 0);
        o->setProperty("pitch", static_cast<double>(p.params.pitchSemitones));
        o->setProperty("fine", static_cast<double>(p.params.fineCents));
        o->setProperty("attack", static_cast<double>(p.params.attackSec));
        o->setProperty("release", static_cast<double>(p.params.releaseSec));
        o->setProperty("gain", static_cast<double>(p.params.gain));
        o->setProperty("outputPair", static_cast<int>(p.params.outputPair));
        o->setProperty("mode", p.params.mode == PadMode::gate   ? "gate"
                               : p.params.mode == PadMode::loop ? "loop"
                                                                : "oneshot");
        o->setProperty("reverse", p.params.reverse != 0);
        o->setProperty("chokeGroup", static_cast<int>(p.params.chokeGroup));
        pads.add(juce::var(o));
    }
    return juce::var(pads);
}

// ---- the offline exporter (Phase 4.5e) -----------------------------------------------------------------------
//
// `terminatorExport({project, main, sources{}, drumLanes{}, path, …})`. The page owns the project, so it hands the
// JSON over; the audio is already in the SampleStore (the page uploaded it), so it hands over KEY MAPS rather than
// bytes. The render is `render::renderProject` — the same engine, the same mixer, the same sequencers as playback.
//
// It runs on its own std::thread: renderOffline builds an Engine of its OWN, so nothing here touches the live engine
// or the audio callback. The only shared state is the sample buffers, which we hold by shared_ptr for the duration.
void WebShell::handleExport(const juce::var& req, juce::WebBrowserComponent::NativeFunctionCompletion complete)
{
    if (!req.isObject())
    {
        complete(ok(false, "export needs an object"));
        return;
    }
    juce::String error;
    auto project = model::projectFromJson(req.getProperty("project", juce::var()), error);
    if (!project.isValid())
    {
        complete(ok(false, error.isNotEmpty() ? error : juce::String("could not read the project")));
        return;
    }
    const juce::File out(req.getProperty("path", "").toString());
    if (out.getFullPathName().isEmpty())
    {
        complete(ok(false, "export needs a path"));
        return;
    }
    if (!out.getParentDirectory().isDirectory())
    {
        complete(ok(false, "no such folder: " + out.getParentDirectory().getFullPathName()));
        return;
    }

    // the audio: the page names the store keys, we take a shared_ptr of each so the render owns what it reads
    render::SampleBank bank;
    if (const auto mainKey = req.getProperty("main", "").toString(); mainKey.isNotEmpty())
        bank.mainBuffer = registry_.shared(mainKey);
    auto readMap = [this](const juce::var& v, auto&& put)
    {
        if (auto* o = v.getDynamicObject())
            for (const auto& kv : o->getProperties())
                if (auto buf = registry_.shared(kv.value.toString()))
                    put(kv.name.toString(), std::move(buf));
    };
    readMap(req.getProperty("sources", juce::var()), [&bank](const juce::String& id, std::shared_ptr<SampleBuffer> b)
            { bank.bySourceVideoId[id] = std::move(b); });
    readMap(req.getProperty("drumLanes", juce::var()),
            [&bank](const juce::String& lane, std::shared_ptr<SampleBuffer> b)
            { bank.drumLanes[lane] = std::move(b); });

    render::ProjectRenderOptions opts;
    opts.sampleRate = static_cast<double>(req.getProperty("sampleRate", 48000.0));
    opts.blockSize = std::clamp(static_cast<int>(req.getProperty("blockSize", 512)), 32, 4096);
    opts.loops = std::clamp(static_cast<int>(req.getProperty("loops", 1)), 1, 64);
    opts.tailSeconds = std::clamp(static_cast<double>(req.getProperty("tail", 2.5)), 0.0, 30.0);
    opts.useMixer = static_cast<bool>(req.getProperty("mixer", true));
    opts.renderDrums = static_cast<bool>(req.getProperty("drums", true));
    opts.renderBass = static_cast<bool>(req.getProperty("bass", true));
    opts.masterLimiter = static_cast<bool>(req.getProperty("limiter", true));
    if (const auto* stems = req.getProperty("stems", juce::var()).getArray())
        for (const auto& s : *stems)
            opts.stemChannels.push_back(s.toString());
    opts.numChannels = 2 + 2 * static_cast<int>(opts.stemChannels.size());
    const int bitDepth = [&]
    {
        const int b = static_cast<int>(req.getProperty("bitDepth", 24));
        return (b == 16 || b == 24 || b == 32) ? b : 24;
    }();

    auto alive = alive_;
    auto shared = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(complete));
    std::thread(
        [project, bank = std::move(bank), opts = std::move(opts), out, bitDepth, alive, shared]() mutable
        {
            juce::var result;
            {
                const auto rendered = render::renderProject(project, bank, opts);
                auto* o = new juce::DynamicObject();
                juce::Array<juce::var> files;
                juce::String err;
                bool wrote = true;
                // the master, then one file per trackout named after its channel
                juce::AudioBuffer<float> pair(2, rendered.buffer.getNumSamples());
                auto writePair = [&](int firstChannel, const juce::File& f)
                {
                    for (int ch = 0; ch < 2; ++ch)
                        pair.copyFrom(ch, 0, rendered.buffer, firstChannel + ch, 0, rendered.buffer.getNumSamples());
                    if (!writeWav(f, pair, rendered.sampleRate, bitDepth, err))
                        return false;
                    files.add(f.getFullPathName());
                    return true;
                };
                wrote = writePair(0, out);
                for (std::size_t i = 0; wrote && i < opts.stemChannels.size(); ++i)
                {
                    const int first = 2 + 2 * static_cast<int>(i);
                    if (first + 1 >= rendered.buffer.getNumChannels())
                        break;
                    wrote = writePair(first, out.getSiblingFile(out.getFileNameWithoutExtension() + " - " +
                                                                opts.stemChannels[i] + out.getFileExtension()));
                }
                o->setProperty("ok", wrote);
                if (!wrote)
                    o->setProperty("error", err);
                o->setProperty("files", juce::var(files));
                o->setProperty("seconds", rendered.buffer.getNumSamples() / std::max(1.0, rendered.sampleRate));
                // the master's peak: a render that wrote a file full of silence is a FAILED export, not a pass
                float peak = 0.0f;
                for (int ch = 0; ch < std::min(2, rendered.buffer.getNumChannels()); ++ch)
                    peak = std::max(peak, rendered.buffer.getMagnitude(ch, 0, rendered.buffer.getNumSamples()));
                o->setProperty("peak", static_cast<double>(peak));
                o->setProperty("sampleRate", rendered.sampleRate);
                o->setProperty("bitDepth", bitDepth);
                result = juce::var(o);
            }
            juce::MessageManager::callAsync(
                [alive, shared, result]
                {
                    if (alive->load())
                        (*shared)(result);
                });
        })
        .detach();
}

void WebShell::handlePads(const juce::var& req, juce::WebBrowserComponent::NativeFunctionCompletion complete)
{
    const auto verb = req.isObject() ? req.getProperty("verb", "list").toString() : juce::String("list");
    if (verb == "list")
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("ok", true);
        o->setProperty("pads", padsVar());
        o->setProperty("samplesLive", static_cast<int>(samples_.liveCount()));
        o->setProperty("bytesLive", static_cast<juce::int64>(samples_.bytesLive()));
        complete(juce::var(o));
        return;
    }
    const int pad = static_cast<int>(req.getProperty("pad", 0));
    if (pad < 0 || pad >= kMaxPads)
    {
        complete(ok(false, "pad out of range"));
        return;
    }
    auto loadInto = [this, pad](const juce::File& f) -> juce::var
    {
        juce::String err;
        auto sample = loader_.load(f, err);
        if (sample == nullptr)
            return ok(false, err);
        const auto id = samples_.add(sample);
        if (padSampleIds_[pad] != 0)
            samples_.retire(padSampleIds_[pad], engine_.snapshot().blocksProcessed);
        padSampleIds_[pad] = id;
        padSampleNames_[pad] = f.getFileNameWithoutExtension();
        padSampleFiles_[pad] = f;
        engine_.commands().push(Command::setPadSample(static_cast<std::uint16_t>(pad), sample.get()));
        auto* o = new juce::DynamicObject();
        o->setProperty("ok", true);
        o->setProperty("pad", pad);
        o->setProperty("name", padSampleNames_[pad]);
        o->setProperty("frames", static_cast<juce::int64>(sample->numFrames));
        o->setProperty("sampleRate", sample->sampleRate);
        o->setProperty("channels", sample->numChannels);
        return juce::var(o);
    };
    if (verb == "loadFile")
    {
        complete(loadInto(juce::File(req["path"].toString())));
        return;
    }
    if (verb == "choose")
    {
        chooser_ = std::make_unique<juce::FileChooser>("Load a sample onto pad " + juce::String(pad + 1), juce::File{},
                                                       loader_.supportedExtensions());
        chooser_->launchAsync(juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                              [loadInto, complete](const juce::FileChooser& fc)
                              {
                                  const auto f = fc.getResult();
                                  if (f == juce::File())
                                      complete(ok(false, "cancelled"));
                                  else
                                      complete(loadInto(f));
                              });
        return;
    }
    if (verb == "clear")
    {
        if (padSampleIds_[pad] != 0)
            samples_.retire(padSampleIds_[pad], engine_.snapshot().blocksProcessed);
        padSampleIds_[pad] = 0;
        padSampleNames_[pad].clear();
        padSampleFiles_[pad] = juce::File();
        engine_.commands().push(Command::setPadSample(static_cast<std::uint16_t>(pad), nullptr));
        complete(ok(true));
        return;
    }
    complete(ok(false, "unknown pads verb '" + verb + "'"));
}

void WebShell::pageLoaded(const juce::String& url)
{
    pageReady_ = true;
    if (probeFile_ != juce::File())
        std::cerr << "probe: page loaded " << url << std::endl;
    if (probeFile_ != juce::File() && !probeArmed_)
    {
        probeArmed_ = true;
        // the React UI needs a moment longer than the static page (fonts, first render, engines constructing)
        probeCountdown_ = uiDir_ != juce::File() ? kProbeDelayTicksReact : kProbeDelayTicks;
    }
}

void WebShell::runProbeAsyncChecks()
{
    // phase 1 (≈ 3 s before the final read, after the ESM modules have run): exercise the window.terminator shim's
    // native round-trips; the results land in window.__terminatorProbeAsync for the final probe
    {
        static const char* kAsyncChecks = R"JS((function(){
            const r = { started: true }; window.__terminatorProbeAsync = r;
            const t = window.terminator; if (!t) { r.error = 'no window.terminator'; return; }
            (async () => {
                try {
                    r.nativeIpc = !!(window.__terminatorNativeIpc && window.__terminatorNativeIpc.installed);
                    r.projectsDir = t.getProjectsDir ? await t.getProjectsDir() : null;
                    r.settingsKeys = t.getSettings ? Object.keys(await t.getSettings()).length : -1;
                    r.eula = t.eulaStatus ? await t.eulaStatus() : null;
                    r.projectFiles = t.listProjectFiles ? (await t.listProjectFiles()).length : -1;
                    r.layout = t.loadLayout ? await t.loadLayout() : undefined;
                    r.openPreferences = t.openPreferences ? await t.openPreferences() : null;
                    // the native-engine shadow (ui/src/renderer/native/nativeEngineShadow.ts): upload a synthetic
                    // buffer through terminatorSamples, bind + trigger a pad, read the engine back
                    const sh = window.__terminatorNativeShadow;
                    r.shadow = sh && sh.selfTest ? await sh.selfTest() : { error: 'no shadow' };
                    // the Sample Library (libraryNative.ts): the tree loads, files are served under the
                    // registered roots only (read-only on the user's library)
                    const lb = window.__terminatorNativeLibrary;
                    r.library = lb && lb.selfTest ? await lb.selfTest() : { error: 'no library' };
                    // the asset store + project bundles (assetsNative.ts): put/has/get round-trip + readBinary
                    const as = window.__terminatorNativeAssets;
                    r.assets = as && as.selfTest ? await as.selfTest() : { error: 'no assets' };
                    // the OFFLINE EXPORTER (4.5e): a tiny project rendered through the real engine + mixer and
                    // written to a real WAV on disk
                    const ex = window.__terminatorNativeExport;
                    r.export = ex && ex.selfTest ? await ex.selfTest() : { error: 'no export' };
                    r.done = true;
                } catch (e) { r.error = String(e && (e.stack || e.message) || e); }
            })();
        })();)JS";
        browser_->evaluateJavascript(kAsyncChecks, nullptr);
    }
}

void WebShell::runProbe()
{
    static const char* kScript = R"JS((function(){
        const t = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
        const root = document.getElementById('root');
        const chopper = document.querySelector('.chopper-view');
        return JSON.stringify({ title: document.title, hasJuce: !!(window.__JUCE__ && window.__JUCE__.backend),
                                bridge: t('bridge'), engine: t('engine'), device: t('device'), snapshot: t('snap'),
                                peak: t('peakTxt'), midi: t('midiTxt'), pads: document.querySelectorAll('.pad').length,
                                // the React UI (ui/dist): uiMode 'react' once App mounted, chopperView once ChopperView rendered
                                uiMode: root ? 'react' : 'static', rootChildren: root ? root.childElementCount : -1,
                                chopperView: !!chopper, padGrid: document.querySelectorAll('.pad-grid .pad, .pad-cell, [class*="pad-grid"]').length,
                                href: String(location.href), secureContext: !!window.isSecureContext,
                                audioWorklet: (typeof AudioContext !== 'undefined') && ('audioWorklet' in AudioContext.prototype),
                                errors: window.__terminatorErrors || [], asyncChecks: window.__terminatorProbeAsync || null,
                                shadow: (window.__terminatorNativeShadow && window.__terminatorNativeShadow.stats) ? window.__terminatorNativeShadow.stats() : null });
    })())JS";
    browser_->evaluateJavascript(
        kScript,
        [this](juce::WebBrowserComponent::EvaluationResult result)
        {
            juce::String out;
            if (const auto* v = result.getResult())
            {
                // merge what only the shell knows (the Preferences window state)
                auto parsed = juce::JSON::parse(v->toString());
                if (auto* o = parsed.getDynamicObject())
                {
                    o->setProperty("prefsWindow", prefsWindow_ != nullptr && prefsWindow_->isVisible());
                    o->setProperty("prefsReady", prefsReady_);
                    o->setProperty("registryKeys", static_cast<int>(registry_.keyCount()));
                    o->setProperty("enginePrepared", static_cast<bool>(engine_.snapshot().prepared));
                    o->setProperty("lastTriggeredPad", engine_.snapshot().lastTriggeredPad);
                    out = juce::JSON::toString(parsed, true);
                }
                else
                    out = v->toString();
            }
            else if (const auto* e = result.getError())
                out = "{\"error\":" + juce::JSON::toString(e->message) + "}";
            probeFile_.deleteFile();
            probeFile_.replaceWithText(out + "\n");
            juce::JUCEApplication::getInstance()->systemRequestedQuit();
        });
}

void WebShell::timerCallback()
{
    if (probeArmed_ && probeCountdown_ > 0)
    {
        --probeCountdown_;
        if (probeCountdown_ == kProbeAsyncLeadTicks)
        {
            std::cerr << "probe: async checks" << std::endl;
            runProbeAsyncChecks();
        }
        if (probeCountdown_ == 0)
        {
            std::cerr << "probe: final read" << std::endl;
            runProbe();
        }
    }

    samples_.collect(engine_.snapshot());
    finishCalibration();

    if (!pageReady_)
        return;

    const auto& s = engine_.snapshot();
    auto* obj = new juce::DynamicObject();
    obj->setProperty("prepared", static_cast<bool>(s.prepared));
    obj->setProperty("sampleRate", s.sampleRate);
    obj->setProperty("blockSize", static_cast<int>(s.blockSize));
    obj->setProperty("outputs", static_cast<int>(s.numOutputChannels));
    obj->setProperty("inputs", static_cast<int>(s.numInputChannels));
    obj->setProperty("playing", static_cast<bool>(s.playing));
    obj->setProperty("playheadSamples", static_cast<juce::int64>(s.playheadSamples));
    obj->setProperty("blocksProcessed", static_cast<juce::int64>(s.blocksProcessed));
    obj->setProperty("samplesProcessed", static_cast<juce::int64>(s.samplesProcessed));
    // the host-clock ↔ sample anchor of the last block + the host time of THIS emit: the page's NativeClock maps
    // engine samples ↔ performance.now() ↔ AudioContext time with it (the chop-seq cursor, the drums/bass
    // re-anchor, quantized live hits). hostNs = juce::Time::getHighResolutionTicks() in ns (monotonic).
    obj->setProperty("clockHostNs", static_cast<juce::int64>(s.clock.hostNs));
    obj->setProperty("clockSample", static_cast<juce::int64>(s.clock.samplePosition));
    obj->setProperty("clockBlockSize", static_cast<int>(s.clock.blockSize));
    obj->setProperty("emitHostNs", static_cast<juce::int64>(AudioIO::hostTimeNowNs()));
    obj->setProperty("masterGain", static_cast<double>(s.masterGain));
    obj->setProperty("testToneEnabled", static_cast<bool>(s.testToneEnabled));
    obj->setProperty("testToneFrequencyHz", static_cast<double>(s.testToneFrequencyHz));
    obj->setProperty("peakL", static_cast<double>(s.peak[0]));
    obj->setProperty("peakR", static_cast<double>(s.peak[1]));
    juce::Array<juce::var> outPeaks, inPeaks;
    for (std::uint32_t ch = 0; ch < s.numOutputChannels && ch < kMaxOutputChannels; ++ch)
        outPeaks.add(static_cast<double>(s.outputPeak[ch]));
    for (std::uint32_t ch = 0; ch < s.numInputChannels && ch < kMaxInputChannels; ++ch)
        inPeaks.add(static_cast<double>(s.inputPeak[ch]));
    obj->setProperty("outputPeaks", juce::var(outPeaks));
    obj->setProperty("inputPeaks", juce::var(inPeaks));
    obj->setProperty("commandsApplied", static_cast<juce::int64>(s.commandsApplied));
    obj->setProperty("commandsDropped", static_cast<juce::int64>(s.commandsDropped));
    obj->setProperty("cpuLoad", audioIO_.cpuLoad());
    obj->setProperty("xruns", audioIO_.xrunCount());
    obj->setProperty("activeVoices", static_cast<int>(s.activeVoices));
    obj->setProperty("voiceStealing", static_cast<int>(s.voiceStealing));
    obj->setProperty("padActiveMask",
                     static_cast<juce::int64>(s.padActiveMask)); // (JS loses bits ≥ 53 — use activePads)
    juce::Array<juce::var> activePads; // 0..63 the chopper grid, 64..127 the drum lanes (pad = 64 + lane)
    for (int i = 0; i < kChopPads; ++i)
        if ((s.padActiveMask >> i) & 1u)
            activePads.add(i);
    for (int l = 0; l < kDrumLanes; ++l)
        if ((s.drumActiveMask >> l) & 1u)
            activePads.add(kDrumPadBase + l);
    obj->setProperty("activePads", juce::var(activePads));
    obj->setProperty("drumActiveMask", static_cast<juce::int64>(s.drumActiveMask));
    obj->setProperty("lastTriggeredPad", s.lastTriggeredPad);
    obj->setProperty("lastTriggeredPadPositionSec", s.lastTriggeredPadPositionSec);
    obj->setProperty("lastLiveHitPad", s.lastLiveHitPad);
    obj->setProperty("lastLiveHitSample", static_cast<juce::int64>(s.lastLiveHitSample));
    obj->setProperty("seqPlaying", static_cast<bool>(s.seqPlaying));
    obj->setProperty("seqPaused", static_cast<bool>(s.seqPaused));
    obj->setProperty("seqLoop", static_cast<bool>(s.seqLoop));
    obj->setProperty("seqStep", s.seqStep);
    obj->setProperty("seqStepCount", s.seqStepCount);
    obj->setProperty("seqPatternIndex", s.seqPatternIndex);
    obj->setProperty("seqStepPhase", s.seqStepPhase);
    obj->setProperty("seqBpm", s.seqBpm);
    obj->setProperty("seqLoopStartSample", static_cast<juce::int64>(s.seqLoopStartSample));
    obj->setProperty("seqHitsFired", static_cast<juce::int64>(s.seqHitsFired));
    obj->setProperty("seqHitsSkipped", static_cast<juce::int64>(s.seqHitsSkipped));
    obj->setProperty("drumPlaying", static_cast<bool>(s.drumPlaying));
    obj->setProperty("drumStep", s.drumStep);
    obj->setProperty("drumStepCount", s.drumStepCount);
    obj->setProperty("drumStepPhase", s.drumStepPhase);
    obj->setProperty("drumLoopStartSample", static_cast<juce::int64>(s.drumLoopStartSample));
    obj->setProperty("drumHitsFired", static_cast<juce::int64>(s.drumHitsFired));
    obj->setProperty("drumHitsSkipped", static_cast<juce::int64>(s.drumHitsSkipped));
    obj->setProperty("bassPlaying", static_cast<bool>(s.bassPlaying));
    obj->setProperty("bassArrangerDriven", static_cast<bool>(s.bassArrangerDriven));
    obj->setProperty("bassTick", s.bassTick);
    obj->setProperty("bassLoopTicks", s.bassLoopTicks);
    obj->setProperty("bassLoopStartSample", static_cast<juce::int64>(s.bassLoopStartSample));
    obj->setProperty("bassVoices", static_cast<int>(s.bassVoices));
    obj->setProperty("bassLevel", static_cast<double>(s.bassLevel));
    obj->setProperty("bassNotesFired", static_cast<juce::int64>(s.bassNotesFired));
    obj->setProperty("bassEventsDropped", static_cast<juce::int64>(s.bassEventsDropped));
    obj->setProperty("bassTimelineFired", static_cast<juce::int64>(s.bassTimelineFired));
    obj->setProperty("bassBend", s.bassBend);
    juce::Array<juce::var> bassNotes; // the MIDI notes a bass voice sounds (the roll's dim keys)
    for (int n = 0; n < 128; ++n)
        if ((s.bassNoteMask[n >> 6] >> (n & 63)) & 1u)
            bassNotes.add(n);
    obj->setProperty("bassNotes", juce::var(bassNotes));
    obj->setProperty("calibrationState", static_cast<int>(s.calibrationState));
    obj->setProperty("calibrationSamples", calibrationResultSamples_);
    obj->setProperty("calibrationMs", calibrationResultMs_);
    obj->setProperty("midiMessages", static_cast<juce::int64>(midi_.messageCount()));
    obj->setProperty("midiLagMs", midi_.medianInputLagMs());
    obj->setProperty("midiLast", midi_.lastMessageDescription());
    // MIDI clock OUT / IN (3.5)
    obj->setProperty("midiClockEnabled", static_cast<bool>(s.midiClockEnabled));
    obj->setProperty("midiClockRunning", static_cast<bool>(s.midiClockRunning));
    obj->setProperty("midiClockTicks", static_cast<juce::int64>(s.midiClockTicks));
    obj->setProperty("midiClockPosition", static_cast<juce::int64>(s.midiClockPosition));
    obj->setProperty("midiOutDropped", static_cast<juce::int64>(s.midiOutDropped));
    obj->setProperty("midiNotesToPads", static_cast<bool>(s.midiNotesToPads));
    obj->setProperty("midiSent", static_cast<juce::int64>(midi_.sentCount()));
    obj->setProperty("midiSendLateMs", midi_.lastSendLatenessMs());
    obj->setProperty("midiClockInBpm", midi_.clockInBpm());
    obj->setProperty("midiClockInPort", midi_.clockInOwnerPort());
    obj->setProperty("midiClockInStarted", midi_.clockInStarted());
    // the metronome + count-in + arp (3.6)
    obj->setProperty("metronomeEnabled", static_cast<bool>(s.metronomeEnabled));
    obj->setProperty("metronomeSound", static_cast<int>(s.metronomeSound));
    obj->setProperty("metronomeBeat", s.metronomeBeat);
    obj->setProperty("metronomeClicks", static_cast<juce::int64>(s.metronomeClicks));
    obj->setProperty("metronomeLastClickSample", static_cast<juce::int64>(s.metronomeLastClickSample));
    obj->setProperty("metronomeLastClickAccent", static_cast<bool>(s.metronomeLastClickAccent));
    obj->setProperty("countInBeat", s.countInBeat);
    obj->setProperty("countInPending", static_cast<bool>(s.countInPending));
    obj->setProperty("countInDownbeatSample", static_cast<juce::int64>(s.countInDownbeatSample));
    obj->setProperty("arpEnabled", static_cast<bool>(s.arpEnabled));
    obj->setProperty("arpHoldPad", s.arpHoldPad);
    obj->setProperty("arpStep", s.arpStep);
    obj->setProperty("arpLastPad", s.arpLastPad);
    obj->setProperty("arpHits", static_cast<juce::int64>(s.arpHits));
    // the mixer (4.1): the live strips + their meters (dead strips are omitted)
    {
        auto* mx = new juce::DynamicObject();
        juce::Array<juce::var> active, silent;
        auto* strips = new juce::DynamicObject();
        for (int i = 0; i < kMaxStrips; ++i)
        {
            if (((s.mixerActiveMask >> i) & 1u) == 0)
                continue;
            active.add(i);
            if ((s.mixerSilentMask >> i) & 1u)
                silent.add(i);
            juce::Array<juce::var> m;
            m.add(static_cast<double>(s.stripPeakPre[i][0]));
            m.add(static_cast<double>(s.stripPeakPre[i][1]));
            m.add(static_cast<double>(s.stripPeakPost[i][0]));
            m.add(static_cast<double>(s.stripPeakPost[i][1]));
            m.add(static_cast<double>(s.stripRmsPre[i]));
            m.add(static_cast<double>(s.stripRmsPost[i]));
            m.add(static_cast<double>(s.stripGain[i]));
            m.add(static_cast<int>(s.stripFxCount[i]));
            strips->setProperty(juce::String(i), juce::var(m));
        }
        mx->setProperty("active", juce::var(active));
        mx->setProperty("silent", juce::var(silent));
        mx->setProperty("strips", juce::var(strips)); // "<index>": [preL, preR, postL, postR, rmsPre, rmsPost, gain]
        mx->setProperty("rejected", static_cast<int>(s.mixerRoutesRejected));
        mx->setProperty("fxRejected", static_cast<int>(s.mixerFxRejected));
        mx->setProperty("console", static_cast<bool>(s.mixerConsoleOn));
        mx->setProperty("limiter", static_cast<bool>(s.mixerLimiterOn));
        // 4.3 meters: per-slot gain reduction of the live strips' chains, the limiter's GR, the master's loudness
        auto* gr = new juce::DynamicObject();
        for (int i = 0; i < kMaxStrips; ++i)
        {
            if (!((s.mixerActiveMask >> i) & 1u) || s.stripFxCount[i] == 0)
                continue;
            juce::Array<juce::var> g;
            for (int k = 0; k < static_cast<int>(s.stripFxCount[i]) && k < 8; ++k)
                g.add(static_cast<double>(s.stripFxGr[i][k]));
            gr->setProperty(juce::String(i), juce::var(g));
        }
        mx->setProperty("fxGr", juce::var(gr));
        mx->setProperty("limiterGr", static_cast<double>(s.masterLimiterGr));
        // PDC (4.4): the plan in whole samples — `pdc` on/off, the two tiers, and every strip with a real delay
        mx->setProperty("pdc", static_cast<bool>(s.mixerPdcOn));
        mx->setProperty("pdcMaxChan", static_cast<int>(s.mixerPdcMaxChan));
        mx->setProperty("pdcToMaster", static_cast<int>(s.mixerPdcToMaster));
        auto* pd = new juce::DynamicObject();
        for (int i = 0; i < kMaxStrips; ++i)
            if (((s.mixerActiveMask >> i) & 1u) && s.stripPdc[i] != 0)
                pd->setProperty(juce::String(i), static_cast<int>(s.stripPdc[i]));
        mx->setProperty("pdcPlan", juce::var(pd));
        auto* lo = new juce::DynamicObject();
        lo->setProperty("m", static_cast<double>(s.lufsM));
        lo->setProperty("s", static_cast<double>(s.lufsS));
        lo->setProperty("i", static_cast<double>(s.lufsI));
        lo->setProperty("lra", static_cast<double>(s.lra));
        lo->setProperty("peakL", static_cast<double>(s.loudPeakL));
        lo->setProperty("peakR", static_cast<double>(s.loudPeakR));
        lo->setProperty("tpL", static_cast<double>(s.loudTpL));
        lo->setProperty("tpR", static_cast<double>(s.loudTpR));
        lo->setProperty("corr", static_cast<double>(s.loudCorr));
        lo->setProperty("holdPeak", static_cast<double>(s.loudHoldPeak));
        lo->setProperty("holdTp", static_cast<double>(s.loudHoldTp));
        lo->setProperty("maxM", static_cast<double>(s.loudMaxM));
        lo->setProperty("maxS", static_cast<double>(s.loudMaxS));
        lo->setProperty("hops", static_cast<int>(s.loudHops));
        mx->setProperty("loudness", juce::var(lo));
        mx->setProperty("orderValid", static_cast<bool>(s.mixerOrderValid));
        mx->setProperty("mainOut", s.mixerMainOut);
        mx->setProperty("bassStrip", s.bassStrip);
        mx->setProperty("clickStrip", s.clickStrip);
        obj->setProperty("mixer", juce::var(mx));
    }
    browser_->emitEventIfBrowserIsVisible("terminator.snapshot", juce::var(obj));
}

} // namespace terminator::app
