#include "WebShell.h"

#include <algorithm>
#include <iostream>

#include "WebResources.h"
#include "terminator/Version.h"

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
    void closeButtonPressed() override { setVisible(false); }
    Browser& browser() noexcept { return *browser_; }

  private:
    std::unique_ptr<Browser> browser_;
};

namespace
{
constexpr int kSnapshotHz = 20;
constexpr int kProbeDelayTicks = 50;       // 2.5 s at 20 Hz — enough for info() + a few snapshots
constexpr int kProbeDelayTicksReact = 140; // 7 s — the React UI: fonts + first render + engines constructing
constexpr int kProbeAsyncLeadTicks = 60;   // the shim round-trip checks start 3 s before the final read

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
    { emitToAll("terminator.settingsChanged", settings); };
    audioIO_.onDeviceChanged = [this] { emitToAll("terminator.devicesChanged", deviceInfoVar()); };
    midi_.onPortsChanged = [this]
    { emitToAll("terminator.midiChanged", handleMidi(juce::var(new juce::DynamicObject()))); };
    // every note the engine got from a device, mirrored to the page (LEDs, step/live record, the playhead) — the
    // sound already fired on the direct MidiHub → engine path; the page's shadow marks its hit nativeOwned
    midi_.onNote = [this](int note, int velocity, bool on, int channel)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty("note", note);
        o->setProperty("velocity", velocity);
        o->setProperty("on", on);
        o->setProperty("channel", channel);
        emitToAll("terminator.midiNote", juce::var(o));
    };

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
            // window.__TERMINATOR_NATIVE__ = { version, settings, dirs } before any page script (sync boot reads)
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
                        if (prefsWindow_ != nullptr)
                            prefsWindow_->setVisible(false);
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
    }
    prefsWindow_->setVisible(true);
    prefsWindow_->toFront(true);
}

WebShell::~WebShell()
{
    stopTimer();
    audioIO_.onDeviceChanged = nullptr;
    midi_.onPortsChanged = nullptr;
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
    obj->setProperty("maxPads", kMaxPads);
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
    Command c;
    if (type == "seqPlay")
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
        c = Command::triggerPad(static_cast<std::uint16_t>(static_cast<int>(json["pad"])),
                                static_cast<float>(static_cast<double>(json.getProperty("velocity", 1.0))));
    else if (type == "releasePad")
        c = Command::releasePad(static_cast<std::uint16_t>(static_cast<int>(json["pad"])));
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
        c = Command::setPadParams(p);
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

juce::var WebShell::handleMidi(const juce::var& req)
{
    const auto verb = req.isObject() ? req.getProperty("verb", "list").toString() : juce::String("list");
    juce::String err;
    if (verb == "inject") // tests / the probe: a note as if it arrived on port 0 (engine queue + the page event)
    {
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
    o->setProperty("messages", static_cast<juce::int64>(midi_.messageCount()));
    o->setProperty("lastLagMs", midi_.lastInputLagMs());
    o->setProperty("medianLagMs", midi_.medianInputLagMs());
    o->setProperty("last", midi_.lastMessageDescription());
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
    juce::Array<juce::var> activePads;
    for (int i = 0; i < kMaxPads; ++i)
        if ((s.padActiveMask >> i) & 1u)
            activePads.add(i);
    obj->setProperty("activePads", juce::var(activePads));
    obj->setProperty("lastTriggeredPad", s.lastTriggeredPad);
    obj->setProperty("lastTriggeredPadPositionSec", s.lastTriggeredPadPositionSec);
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
    obj->setProperty("calibrationState", static_cast<int>(s.calibrationState));
    obj->setProperty("calibrationSamples", calibrationResultSamples_);
    obj->setProperty("calibrationMs", calibrationResultMs_);
    obj->setProperty("midiMessages", static_cast<juce::int64>(midi_.messageCount()));
    obj->setProperty("midiLagMs", midi_.medianInputLagMs());
    obj->setProperty("midiLast", midi_.lastMessageDescription());
    browser_->emitEventIfBrowserIsVisible("terminator.snapshot", juce::var(obj));
}

} // namespace terminator::app
