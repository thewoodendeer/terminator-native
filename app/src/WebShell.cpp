#include "WebShell.h"

#include <algorithm>
#include <cmath>
#include <thread>
#include <iostream>

#include "Perf.h"
#include "WebResources.h"
#include "terminator/Version.h"
#include "terminator/model/ProjectModel.h"
#include "terminator/render/AudioFileWriter.h"
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
      plugins_(settings.file().getSiblingFile("plugins.xml")), rack_(engine, plugins_),
#if TERMINATOR_STEMS
      stems_(engine, registry_, services_.dataDir(),
             [this](std::vector<std::byte> bytes) { return services_.stashBytes(std::move(bytes)); }),
#endif
      audioError_(std::move(audioError))
{
    plugins_.onEvent = [this](const juce::String& ev, const juce::var& payload) { emitToAll(ev, payload); };
    license_.onEvent = [this](const juce::String& ev, const juce::var& payload) { emitToAll(ev, payload); };
#if TERMINATOR_STEMS
    stems_.onEvent = [this](const juce::String& ev, const juce::var& payload) { emitToAll(ev, payload); };
#endif
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
    const juce::String probeLicense =
        juce::SystemStats::getEnvironmentVariable("TERMINATOR_LICENSE_FAKE", {}).isNotEmpty()
            ? "window.__terminatorProbeLicense = true;"
            : "void 0;";
    const juce::String probeAudio =
        juce::String(juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_AUDIO", {}).isNotEmpty()
                         ? "window.__terminatorProbeAudio = true;"
                         : "void 0;") +
        juce::String(juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_STEMS", {}).isNotEmpty()
                         ? "window.__terminatorProbeStems = true;"
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
            .withUserScript(probeLicense)
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
            // RECORDING (5.1a): {verb:'start', path, channels, inputs[], bitDepth} / {verb:'stop'} /
            // {verb:'status'}. The take runs in the ENGINE, from the interface's own inputs — not through the
            // page's getUserMedia, which is what the shipping app still does.
            .withNativeFunction("terminatorRecord", [this](const juce::Array<juce::var>& args,
                                                           juce::WebBrowserComponent::NativeFunctionCompletion complete)
                                { complete(handleRecord(args.size() > 0 ? args[0] : juce::var())); })
            // THE LICENCE (8.5): status / signIn / signOut / buy. The token never crosses this boundary — the
            // page is answered {unlocked, email} and nothing else.
            .withNativeFunction(
                "terminatorLicense",
                [this](const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion complete)
                { license_.handle(args.size() > 0 ? args[0] : juce::var(), std::move(complete)); })
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
                "terminatorPlugins",
                [this](const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion complete)
                {
                    // The scan + the list are PluginHub's; anything touching a LOADED plugin is the rack's.
                    const auto req = args.size() > 0 ? args[0] : juce::var();
                    complete(PluginRack::ownsVerb(req.getProperty("verb", "").toString()) ? rack_.handle(req)
                                                                                          : plugins_.handle(req));
                })
            .withNativeFunction(
                "terminatorStems",
                [this](const juce::Array<juce::var>& args, juce::WebBrowserComponent::NativeFunctionCompletion complete)
                {
#if TERMINATOR_STEMS
                    complete(stems_.handle(args.size() > 0 ? args[0] : juce::var()));
#else
                    juce::ignoreUnused(args);
                    auto* o = new juce::DynamicObject();
                    o->setProperty("ok", true);
                    o->setProperty("available", false);
                    o->setProperty("unavailable", "this build has no stem separation");
                    complete(juce::var(o));
#endif
                })
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

bool WebShell::handleOpenRequest(const juce::String& urlOrPath)
{
    // 8.5: `terminator://auth?code=…&state=…` from the browser sign-in. Everything about it — the nonce match,
    // the token exchange, the store — belongs to the hub; the shell only routes.
    if (urlOrPath.startsWithIgnoreCase("terminator://"))
        return license_.handleDeepLink(urlOrPath);
    // 8.6: a double-clicked project. It rides the contract the page has always had for "open this file" (the
    // one Open Recent uses), so a file from Finder and a file from the menu take exactly the same path in.
    const juce::File f(urlOrPath);
    if (!f.existsAsFile())
        return false;
    // A COLD start hands the file over while the page is still loading, and an event emitted then reaches
    // nobody — so hold it until the page says it is ready (pageLoaded flushes it).
    if (!pageReady_)
    {
        pendingOpenFile_ = f.getFullPathName();
        return true;
    }
    menuOpenRecent(f.getFullPathName());
    return true;
}

void WebShell::menuCommand(const juce::String& key)
{
    auto* o = new juce::DynamicObject();
    o->setProperty("key", key);
    emitToAll("terminator.menu", juce::var(o));
}

void WebShell::menuOpenRecent(const juce::String& path)
{
    auto* o = new juce::DynamicObject();
    o->setProperty("key", "openRecent");
    o->setProperty("path", path);
    emitToAll("terminator.menu", juce::var(o));
}

void WebShell::openPreferencesFromMenu()
{
    openPreferences();
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
    // 0c. the drum library shipped inside the app: /drums/<id>.<flac|mp3> — the native twin of the Electron
    // app's terminator-drums://sample/<id>.<ext>, same rule. The id is a fixed-width hex token and nothing else,
    // so there is no path handling to get wrong; a miss is a plain 404 and the page falls through to R2. The
    // shape is deliberate: `drumIdFromUrl` (drumR2.ts) already reads an id out of a `/drums/<id>.<ext>` URL, so
    // a project saved with one still resolves to its id — and to the R2 fallbacks — anywhere else.
    if (url.startsWith("/drums/"))
    {
        const auto name = url.fromFirstOccurrenceOf("/drums/", false, false)
                              .upToFirstOccurrenceOf("?", false, false)
                              .upToFirstOccurrenceOf("#", false, false);
        const auto id = name.upToLastOccurrenceOf(".", false, false);
        const auto ext = name.fromLastOccurrenceOf(".", false, false);
        if (id.length() != 16 || !id.containsOnly("0123456789abcdef") || (ext != "flac" && ext != "mp3"))
            return std::nullopt;
        const auto dir = ShellServices::bundledDrumsDir();
        if (dir == juce::File())
            return std::nullopt;
        const auto f = dir.getChildFile(id + "." + ext);
        juce::MemoryBlock mb;
        if (!f.existsAsFile() || !f.loadFileAsData(mb))
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

/// RECORDING (5.1a) — start / stop / status for a native take.
// The round trip a take aimed at a musical position has to be shifted by (5.1d). The MEASURED one wins — that is
// what the loopback calibration is for — and only at the rate it was measured at; otherwise the driver's own
// reported in + out latency, which is what every DAW falls back to.
std::uint64_t WebShell::recordLatencyCompensation() const
{
    const auto dev = audioIO_.currentDevice();
    const double sr = dev.sampleRate > 0.0 ? dev.sampleRate : 48000.0;
    const int measured = static_cast<int>(settings_.get("calibration.roundTripSamples", juce::var(-1)));
    const double calSr = static_cast<double>(settings_.get("calibration.sampleRate", juce::var(0.0)));
    if (measured > 0 && std::abs(calSr - sr) < 1.0)
        return static_cast<std::uint64_t>(measured);
    const int reported = dev.inputLatencySamples + dev.outputLatencySamples;
    return reported > 0 ? static_cast<std::uint64_t>(reported) : 0;
}

juce::var WebShell::handleRecord(const juce::var& req)
{
    auto* obj = new juce::DynamicObject();
    const auto verb = req.getProperty("verb", "status").toString();
    const auto& rec = engine_.recorder();
    const auto status = [&](juce::DynamicObject* o)
    {
        o->setProperty("recording", rec.recording());
        o->setProperty("frames", static_cast<double>(rec.framesWritten()));
        o->setProperty("captured", static_cast<double>(rec.framesCaptured()));
        // DROPPED is reported to the page on purpose: a take with a hole in it has to be visible, not discovered
        // later in the mix.
        o->setProperty("dropped", static_cast<double>(rec.framesDropped()));
        o->setProperty("peakL", static_cast<double>(rec.peak(0)));
        o->setProperty("peakR", static_cast<double>(rec.peak(1)));
        // THE ARM (5.1c): armed = the file is open and the take is waiting for its sample (the count-in's downbeat,
        // the transport, a booked position). The page shows the wait rather than pretending it is already recording.
        o->setProperty("armed", engine_.recordArmed());
        o->setProperty("startSample", static_cast<double>(engine_.recordStartSample()));
        o->setProperty("startPlayhead", static_cast<double>(engine_.recordStartPlayhead()));
        o->setProperty("complete", engine_.recordComplete());
    };
    if (verb == "start")
    {
        RecorderConfig cfg;
        cfg.file = juce::File(req.getProperty("path", "").toString());
        cfg.sampleRate = engine_.config().sampleRate > 0 ? engine_.config().sampleRate : 48000.0;
        cfg.numChannels = std::clamp(static_cast<int>(req.getProperty("channels", 2)), 1, 32);
        cfg.bitDepth = static_cast<int>(req.getProperty("bitDepth", 24));
        if (auto* ins = req.getProperty("inputs", juce::var()).getArray())
            for (const auto& v : *ins)
                cfg.inputChannels.push_back(static_cast<int>(v));
        // WHAT THE TAKE IS MADE OF (5.1d): the interface's inputs, or Terminator's OWN OUTPUT (the RESAMPLE take —
        // post master fader, before the click). The page's Web Audio tap cannot do the second one in the shell at
        // all: the TS engine's voices are muted here, so its master node carries silence.
        const bool master = req.getProperty("source", "inputs").toString().equalsIgnoreCase("master");
        // THE ARM (5.1c). `countIn` beats -> the take starts on the downbeat the count is counting to (and the
        // shell books the clicks itself, so the count-in can never be booked after the arm and missed);
        // `atSample` -> an exact engine sample; `atTransport` -> the next transport start, on its own anchor;
        // `lengthSeconds` -> a punch-out, ending the take on its own frame.
        Engine::RecordArm arm;
        const double sr = cfg.sampleRate;
        const int countIn = std::clamp(static_cast<int>(req.getProperty("countIn", 0)), 0, 16);
        const auto atSample = static_cast<double>(req.getProperty("atSample", 0.0));
        if (countIn > 0)
            arm.mode = Engine::RecordStart::countInDownbeat;
        else if (atSample > 0.0)
        {
            arm.mode = Engine::RecordStart::atSample;
            arm.atSample = static_cast<std::uint64_t>(atSample);
        }
        else if (static_cast<bool>(req.getProperty("atTransport", false)))
            arm.mode = Engine::RecordStart::transportStart;
        const auto lengthSeconds = static_cast<double>(req.getProperty("lengthSeconds", 0.0));
        if (lengthSeconds > 0.0)
            arm.lengthSamples = static_cast<std::uint64_t>(lengthSeconds * sr);
        arm.source = master ? Engine::RecordSource::master : Engine::RecordSource::inputs;
        if (master)
        {
            cfg.numChannels = 2; // the master pair, whatever the request said
            cfg.inputChannels.clear();
        }
        // LATENCY COMPENSATION (5.1d): only for a take aimed at a MUSICAL position. A free-running take has no
        // target to be late for, and shifting it would just clip its first milliseconds off.
        if (arm.mode != Engine::RecordStart::immediate && static_cast<bool>(req.getProperty("compensate", true)))
            arm.latencyCompensationSamples = recordLatencyCompensation();
        juce::String err;
        const bool ok = cfg.file.getFullPathName().isNotEmpty() && engine_.startRecord(cfg, err, arm);
        if (ok)
        {
            recordPath_ = cfg.file.getFullPathName();
            if (countIn > 0)
                engine_.commands().push(Command::countIn(countIn));
        }
        obj->setProperty("ok", ok);
        obj->setProperty("armed", engine_.recordArmed());
        obj->setProperty("source", master ? "master" : "inputs");
        obj->setProperty("compensationSamples", static_cast<double>(arm.latencyCompensationSamples));
        if (!ok)
            obj->setProperty("error", err.isNotEmpty() ? err : juce::String("no path"));
        obj->setProperty("path", cfg.file.getFullPathName());
        status(obj);
        return juce::var(obj);
    }
    if (verb == "monitor")
    {
        // INPUT MONITORING (5.1c): hear the interface through the engine while you set the level. `strip` routes it
        // through a mixer strip (its fader, inserts and console apply); -1 is straight to outs 1/2.
        const bool on = static_cast<bool>(req.getProperty("enabled", false));
        int ch0 = 0, ch1 = 1;
        if (auto* ins = req.getProperty("inputs", juce::var()).getArray())
        {
            ch0 = ins->size() > 0 ? static_cast<int>((*ins)[0]) : 0;
            ch1 = ins->size() > 1 ? static_cast<int>((*ins)[1]) : -1;
        }
        const auto gainDb = static_cast<double>(req.getProperty("gainDb", 0.0));
        const auto gain = static_cast<float>(std::pow(10.0, gainDb / 20.0));
        const int strip = static_cast<int>(req.getProperty("strip", -1));
        engine_.commands().push(Command::setMonitor(on, ch0, ch1, gain, strip));
        obj->setProperty("ok", true);
        obj->setProperty("monitoring", on);
        status(obj);
        return juce::var(obj);
    }
    if (verb == "stop")
    {
        const auto frames = engine_.stopRecord();
        recordPath_ = {};
        obj->setProperty("ok", true);
        obj->setProperty("frames", static_cast<double>(frames));
        const double sr = engine_.config().sampleRate > 0 ? engine_.config().sampleRate : 48000.0;
        obj->setProperty("seconds", static_cast<double>(frames) / sr);
        obj->setProperty("dropped", static_cast<double>(rec.framesDropped()));
        obj->setProperty("recording", false);
        return juce::var(obj);
    }
    obj->setProperty("ok", true);
    status(obj);
    return juce::var(obj);
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
    // STEMS (7.1c): a pad reads the planes of a source key through its 4-bit mask; the audio never leaves C++.
    if (type == "setPadStems")
#if TERMINATOR_STEMS
        return stems_.setPadStems(json);
#else
        return ok(false, "this build has no stem separation");
#endif
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
    // INSTRUMENTS (6.3): whether MIDI notes play the hosted instrument instead of the pads (OFF by default — the
    // standing rule is that keys and MIDI trigger pads), and a note from the page's own keyboard.
    else if (type == "setInstrumentMidi")
        c = Command::setInstrumentMidi(static_cast<bool>(json.getProperty("on", false)));
    else if (type == "instrumentNote")
        c = Command::instrumentNote(
            std::clamp(static_cast<int>(json.getProperty("note", 60)), 0, 127),
            std::clamp(static_cast<float>(static_cast<double>(json.getProperty("velocity", 1.0))), 0.0f, 1.0f),
            static_cast<bool>(json.getProperty("on", true)),
            static_cast<std::uint64_t>(static_cast<double>(json.getProperty("atSample", 0.0))));
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
        const auto interp = json.getProperty("interpolation", "sinc").toString();
        p.interpolation = interp == "linear"    ? Interpolation::linear
                          : interp == "hermite" ? Interpolation::hermite
                                                : Interpolation::sinc;
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
        // The parity three and their PREMIUM re-models (4.6i). Unknown = SSL, so an older page cannot pick a
        // flavour the engine does not have.
        const auto f = json.getProperty("flavour", "SSL").toString().toUpperCase();
        const std::uint8_t flavour = f == "NEVE"    ? 1
                                     : f == "API"   ? 2
                                     : f == "SSL+"  ? 3
                                     : f == "NEVE+" ? 4
                                     : f == "API+"  ? 5
                                                    : 0;
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
    else if (type == "mixerSetFxRoute")
    {
        // M/S everywhere (4.7a): the SLOT's route, not a device param — 'STEREO' | 'MID' | 'SIDE' | 'LEFT' | 'RIGHT'
        const auto rt = json.getProperty("route", "STEREO").toString().toUpperCase();
        const std::uint8_t route = rt == "MID" ? 1 : rt == "SIDE" ? 2 : rt == "LEFT" ? 3 : rt == "RIGHT" ? 4 : 0;
        c = Command::mixerSetFxRoute(stripOf(json), std::clamp(static_cast<int>(json.getProperty("index", 0)), 0, 7),
                                     route);
    }
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
        {
            value = static_cast<float>(static_cast<double>(v));
            // An ENUM param's value is an INDEX here. The page names some of its options by their VALUE rather
            // than their position — the phaser's STAGES are 4 / 6 / 8 / 12 — so a number that is not a valid
            // index is matched against the option NAMES before it is used. Without this every STAGES choice
            // clamped to the last option and the control did nothing (his report 2026-08-25); a number that is
            // neither an index nor an option is now an error rather than a silent clamp.
            if (const auto& def = fxTypeInfo(t).params[param];
                def.isEnum() && (value < 0.0f || value >= static_cast<float>(def.numOptions)))
            {
                const auto asName = std::abs(value - std::round(value)) < 1.0e-6f
                                        ? juce::String(static_cast<int>(std::lround(value)))
                                        : juce::String(value);
                const int opt = fxOptionIndex(t, param, asName.toRawUTF8());
                if (opt < 0)
                    return ok(false, "value '" + asName + "' is not an option of " + id + "." + key);
                value = static_cast<float>(opt);
            }
        }
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
    // `{verb: 'transcode', from, to, format, bitDepth?, mp3Kbps?}` — re-encode a file the PAGE rendered. The page's
    // arrangement renderer is the authority on WHAT the audio is (it alone knows the Beat Finisher arrangement);
    // this only changes the container, through the same writer + the same app-parity dither as a native export. It
    // is what lets MP3 exist at all without a second render path.
    if (req.getProperty("verb", "").toString() == "transcode")
    {
        const juce::File from(req.getProperty("from", "").toString());
        juce::File to(req.getProperty("to", "").toString());
        if (!from.existsAsFile())
        {
            complete(ok(false, "nothing to transcode at " + from.getFullPathName()));
            return;
        }
        const auto fmt = render::audioFileFormatFromName(req.getProperty("format", "mp3").toString());
        to = to.withFileExtension(render::audioFileExtension(fmt));
        const auto lameBin = render::findLameBinary(ProcessHub::bundledBinDir().getChildFile("lame"));
        if (fmt == render::AudioFileFormat::mp3 && !lameBin.existsAsFile())
        {
            complete(ok(false, "MP3 needs the `lame` encoder and this build has none — export WAV or FLAC"));
            return;
        }
        juce::AudioFormatManager fm;
        fm.registerBasicFormats();
        std::unique_ptr<juce::AudioFormatReader> reader(fm.createReaderFor(from));
        if (reader == nullptr)
        {
            complete(ok(false, "cannot read " + from.getFileName()));
            return;
        }
        juce::AudioBuffer<float> buf(static_cast<int>(reader->numChannels), static_cast<int>(reader->lengthInSamples));
        reader->read(&buf, 0, buf.getNumSamples(), 0, true, true);
        const double rate = reader->sampleRate;
        reader.reset();
        juce::String werr;
        const int depth = std::clamp(static_cast<int>(req.getProperty("bitDepth", 16)), 16, 32);
        const int kbps = std::clamp(static_cast<int>(req.getProperty("mp3Kbps", 320)), 32, 320);
        if (!render::writeAudioFile(to, buf, rate, fmt, depth, werr, kbps, lameBin))
        {
            complete(ok(false, werr));
            return;
        }
        auto* o = new juce::DynamicObject();
        o->setProperty("ok", true);
        o->setProperty("path", to.getFullPathName());
        o->setProperty("bytes", static_cast<juce::int64>(to.getSize()));
        complete(juce::var(o));
        return;
    }
    // `{verb: 'cancel', id}` — flip the job's flag; the render thread notices at its next progress report
    if (req.getProperty("verb", "").toString() == "cancel")
    {
        const auto id = req.getProperty("id", "").toString();
        const auto it = exportCancels_.find(id);
        if (it == exportCancels_.end())
        {
            complete(ok(false, "no export running with id '" + id + "'"));
            return;
        }
        it->second->store(true);
        complete(ok(true));
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
    // `padSamples: {"<pad>": "<store key>"}` — audio the PAGE derived for one pad and the renderer cannot make
    // itself: the TIME-STRETCHED slice (SoundTouch lives in the page). Without it a bounce plays the dry chop
    // while the pads play the stretched one — the export would not be what he just heard.
    readMap(req.getProperty("padSamples", juce::var()),
            [&bank](const juce::String& pad, std::shared_ptr<SampleBuffer> b)
            {
                const int idx = pad.getIntValue();
                if (idx >= 0 && idx < 256)
                    bank.padOverrides[idx] = std::move(b);
            });

    render::ProjectRenderOptions opts;
    opts.sampleRate = static_cast<double>(req.getProperty("sampleRate", 48000.0));
    opts.blockSize = std::clamp(static_cast<int>(req.getProperty("blockSize", 512)), 32, 4096);
    opts.loops = std::clamp(static_cast<int>(req.getProperty("loops", 1)), 1, 64);
    opts.tailSeconds = std::clamp(static_cast<double>(req.getProperty("tail", 2.5)), 0.0, 30.0);
    // The bounce reads the audio the way the PADS do (band-limited): the same varispeed that folds the top
    // octave back into a pitched chop live would do it in the file, and a file is forever. `interpolation`
    // can override it for an A/B ("linear" is what the Web Audio engine did).
    {
        const auto interp = req.getProperty("interpolation", "sinc").toString();
        opts.interpolation = interp == "linear"    ? Interpolation::linear
                             : interp == "hermite" ? Interpolation::hermite
                                                   : Interpolation::sinc;
    }
    opts.useMixer = static_cast<bool>(req.getProperty("mixer", true));
    opts.renderDrums = static_cast<bool>(req.getProperty("drums", true));
    opts.renderBass = static_cast<bool>(req.getProperty("bass", true));
    opts.masterLimiter = static_cast<bool>(req.getProperty("limiter", true));
    // `song` = every sequence back to back (the app's Master Mixdown); off = the current pattern on repeat
    opts.allSequences = static_cast<bool>(req.getProperty("song", false));
    // ARRANGEMENT (Phase 4.7): `arrangement` = the Beat Finisher song, flattened by the page into absolute-time
    // hits — the same flattening its own arranger preview runs, so there is ONE implementation of what plays when.
    // Everything about the sound still comes from the project; only the schedule is the arrangement's.
    //   { lengthSec, hits: [{pad, t, vel?, pan?, sub?, rev?, stop?}], bass: [{kind, t, note?, vel?, value?}],
    //     bassPatch? }
    // `stop` is an absolute time: a chop's cut at the next hit (stopAt — a one-shot ignores a note-off) or a REPEAT
    // sub-hit's self-choke (chokeSubHits). Mute-group choke is NOT sent: the drum pads carry their groups, so the
    // engine chokes in the same order playback does.
    if (const auto arrangement = req.getProperty("arrangement", juce::var()); arrangement.isObject())
    {
        opts.arrangementLengthSeconds = std::max(0.0, static_cast<double>(arrangement.getProperty("lengthSec", 0.0)));
        if (const auto* hits = arrangement.getProperty("hits", juce::var()).getArray())
        {
            opts.arrangementEvents.reserve(static_cast<std::size_t>(hits->size()) * 2);
            for (const auto& h : *hits)
            {
                if (!h.isObject())
                    continue;
                RenderEvent e;
                e.pad = static_cast<std::uint16_t>(std::clamp(static_cast<int>(h.getProperty("pad", 0)), 0, 255));
                e.timeSec = std::max(0.0, static_cast<double>(h.getProperty("t", 0.0)));
                e.velocity = std::clamp(static_cast<float>(static_cast<double>(h.getProperty("vel", 1.0))), 0.0f, 4.0f);
                if (h.hasProperty("pan"))
                {
                    e.hasPan = true;
                    e.pan = std::clamp(static_cast<float>(static_cast<double>(h.getProperty("pan", 0.0))), -1.0f, 1.0f);
                }
                e.subHit = static_cast<bool>(h.getProperty("sub", false));
                if (h.hasProperty("rev"))
                    e.reverse = static_cast<bool>(h.getProperty("rev", false)) ? 1 : 0;
                opts.arrangementEvents.push_back(e);
                if (h.hasProperty("stop"))
                {
                    const double at = static_cast<double>(h.getProperty("stop", 0.0));
                    if (at > e.timeSec)
                    {
                        RenderEvent cut;
                        cut.pad = e.pad;
                        cut.timeSec = at;
                        cut.type = e.subHit ? RenderEvent::Type::chokeSubHits : RenderEvent::Type::stopAt;
                        opts.arrangementEvents.push_back(cut);
                    }
                }
            }
        }
        if (const auto* bass = arrangement.getProperty("bass", juce::var()).getArray();
            bass != nullptr && !bass->isEmpty())
        {
            auto tl = std::make_shared<BassTimeline>();
            for (const auto& b : *bass)
            {
                if (!b.isObject())
                    continue;
                const auto kindName = b.getProperty("kind", "on").toString();
                const auto kind = kindName == "off"     ? BassSynth::EventKind::off
                                  : kindName == "slide" ? BassSynth::EventKind::slide
                                  : kindName == "bend"  ? BassSynth::EventKind::bend
                                                        : BassSynth::EventKind::on;
                const auto at = static_cast<std::uint64_t>(
                    std::max(0.0, static_cast<double>(b.getProperty("t", 0.0)) * opts.sampleRate));
                if (!tl->add(kind, at, std::clamp(static_cast<int>(b.getProperty("note", 40)), 0, 127),
                             std::clamp(static_cast<float>(static_cast<double>(b.getProperty("vel", 1.0))), 0.0f, 1.0f),
                             static_cast<double>(b.getProperty("value", 0.0))))
                    break; // the timeline is full (4096 events) — the rest of the line cannot be scheduled
            }
            opts.arrangementBass = tl;
        }
        // the patch travels WITH the arrangement (the Beat Finisher bakes what the sections were written with)
        if (const auto patch = arrangement.getProperty("bassPatch", juce::var()); patch.isObject())
            opts.arrangementBassPatch = std::make_shared<BassPatch>(render::bassPatchFromVar(patch));
    }
    if (const auto* stems = req.getProperty("stems", juce::var()).getArray())
        for (const auto& s : *stems)
            opts.stemChannels.push_back(s.toString());
    opts.numChannels = 2 + 2 * static_cast<int>(opts.stemChannels.size());
    const int bitDepth = [&]
    {
        const int b = static_cast<int>(req.getProperty("bitDepth", 24));
        return (b == 16 || b == 24 || b == 32) ? b : 24;
    }();
    const auto format = render::audioFileFormatFromName(req.getProperty("format", "wav").toString());
    const int mp3Kbps = std::clamp(static_cast<int>(req.getProperty("mp3Kbps", 320)), 32, 320);
    // MP3 rides a `lame` EXECUTABLE (nothing links liblame): bundled first, then whatever the machine has
    const auto lame = render::findLameBinary(ProcessHub::lameBinary());
    if (format == render::AudioFileFormat::mp3 && !lame.existsAsFile())
    {
        complete(ok(false, "MP3 export needs the `lame` encoder and this build has none — export WAV or FLAC"));
        return;
    }

    const auto jobId = req.getProperty("id", "export").toString();
    auto cancel = std::make_shared<std::atomic<bool>>(false);
    exportCancels_[jobId] = cancel;

    auto alive = alive_;
    auto shared = std::make_shared<juce::WebBrowserComponent::NativeFunctionCompletion>(std::move(complete));
    // progress rides the normal event stream, throttled to whole percents — the page draws a bar, not a firehose
    auto lastPct = std::make_shared<std::atomic<int>>(-1);
    RenderCallbacks callbacks;
    callbacks.onProgress = [this, alive, cancel, lastPct, jobId](double p)
    {
        if (cancel->load())
            return false;
        const int pct = std::clamp(static_cast<int>(p * 100.0), 0, 100);
        if (pct != lastPct->exchange(pct))
            juce::MessageManager::callAsync(
                [this, alive, jobId, pct]
                {
                    if (!alive->load())
                        return;
                    auto* e = new juce::DynamicObject();
                    e->setProperty("id", jobId);
                    e->setProperty("pct", pct);
                    emitToAll("terminator.exportProgress", juce::var(e));
                });
        return true;
    };
    // PLUGINS IN THE EXPORT (6.4). The render gets its OWN instances — the live ones are being played through —
    // loaded on the MESSAGE thread (the only place a plugin may be created) with the state the project saved. The
    // set is held by the render thread's lambda, so the instances outlive the render and go when it is done.
    auto pluginSet = std::make_shared<std::unique_ptr<PluginRack::OfflineSet>>();
    opts.prepareMixer = [this, alive, pluginSet, sr = opts.sampleRate, block = opts.blockSize](RenderMixerSpec& mix)
    {
        juce::MessageManager::callSync(
            [&]
            {
                if (alive->load())
                    *pluginSet = rack_.loadForRender(mix, sr, block);
            });
    };
    std::thread(
        // `this` is only ever dereferenced inside the message-thread callbacks below, and only after alive_ says we
        // are still here — the destructor clears that flag on the same thread, so there is no window between them.
        [this, project, bank = std::move(bank), opts = std::move(opts), out, bitDepth, format, mp3Kbps, lame, alive,
         shared, callbacks = std::move(callbacks), jobId, pluginSet]() mutable
        {
            juce::var result;
            {
                const auto rendered = render::renderProject(project, bank, opts, &callbacks);
                if (rendered.cancelled)
                {
                    // a cancelled render is a PARTIAL buffer: nothing is written, and no half file is left behind
                    auto* o = new juce::DynamicObject();
                    o->setProperty("ok", false);
                    o->setProperty("cancelled", true);
                    o->setProperty("files", juce::var(juce::Array<juce::var>()));
                    result = juce::var(o);
                    juce::MessageManager::callAsync(
                        [this, alive, shared, result, jobId, pluginSet]
                        {
                            pluginSet->reset(); // the export's plugins go on the MESSAGE thread, where they were made
                            if (!alive->load())
                                return;
                            exportCancels_.erase(jobId);
                            (*shared)(result);
                        });
                    return;
                }
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
                    if (!render::writeAudioFile(f, pair, rendered.sampleRate, format, bitDepth, err, mp3Kbps, lame))
                        return false;
                    files.add(f.getFullPathName());
                    return true;
                };
                wrote = writePair(0, out.withFileExtension(render::audioFileExtension(format)));
                for (std::size_t i = 0; wrote && i < opts.stemChannels.size(); ++i)
                {
                    const int first = 2 + 2 * static_cast<int>(i);
                    if (first + 1 >= rendered.buffer.getNumChannels())
                        break;
                    wrote =
                        writePair(first, out.getSiblingFile(out.getFileNameWithoutExtension() + " - " +
                                                            opts.stemChannels[i] + render::audioFileExtension(format)));
                }
                o->setProperty("ok", wrote);
                if (!wrote)
                    o->setProperty("error", err);
                // A plugin the project asked for that would not load is SAID — an export quietly missing one is a
                // file that does not match what you heard.
                if (*pluginSet != nullptr)
                {
                    o->setProperty("plugins", (*pluginSet)->loaded());
                    if (!(*pluginSet)->missing().isEmpty())
                        o->setProperty("pluginsMissing", (*pluginSet)->missing().joinIntoString(", "));
                }
                o->setProperty("files", juce::var(files));
                o->setProperty("seconds", rendered.buffer.getNumSamples() / std::max(1.0, rendered.sampleRate));
                // the master's peak: a render that wrote a file full of silence is a FAILED export, not a pass
                float peak = 0.0f;
                for (int ch = 0; ch < std::min(2, rendered.buffer.getNumChannels()); ++ch)
                    peak = std::max(peak, rendered.buffer.getMagnitude(ch, 0, rendered.buffer.getNumSamples()));
                o->setProperty("peak", static_cast<double>(peak));
                o->setProperty("sampleRate", rendered.sampleRate);
                o->setProperty("bitDepth", bitDepth);
                o->setProperty("format", render::audioFileExtension(format).substring(1));
                result = juce::var(o);
            }
            juce::MessageManager::callAsync(
                [this, alive, shared, result, jobId, pluginSet]
                {
                    pluginSet->reset(); // …and the export's plugins are destroyed where they were made
                    if (!alive->load())
                        return;
                    exportCancels_.erase(jobId); // the job is done: cancelling it from here on is a no-op
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
    perf::mark(perf::Mark::page); // the UI is on screen and can be used
    // A project the OS asked us to open before the page existed (8.6, a double-clicked .tproj on a cold start).
    if (pendingOpenFile_.isNotEmpty())
    {
        const auto path = pendingOpenFile_;
        pendingOpenFile_.clear();
        menuOpenRecent(path);
    }
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
                    // Preferences -> FOLDERS (7.4): the size chips and the YouTube row. The chips themselves
                    // are only a SHAPE check — a fresh machine's folders are legitimately empty (CI's are), so
                    // the `du` walk is proven against a folder the probe fills itself.
                    r.folderSizes = t.getFolderSizes ? await t.getFolderSizes() : null;
                    r.cacheDir = t.getCacheDirInfo ? await t.getCacheDirInfo() : null;
                    try {
                        const nb = window.__TERMINATOR_BOOT__ || {};
                        const sep = (nb.dirs && nb.dirs.sep) || '/';
                        const duDir = ((nb.dirs && nb.dirs.temp) || '/tmp') + sep + 'terminator-du-probe';
                        await window.__terminatorNativeIpc.fs({ verb: 'mkdir', path: duDir });
                        await window.__terminatorNativeIpc.fs({ verb: 'writeText', path: duDir + sep + 'a.txt', text: 'x'.repeat(5000) });
                        const du = await window.__terminatorNativeIpc.fs({ verb: 'du', path: duDir });
                        r.duBytes = du && du.ok ? du.bytes : -1;
                        await window.__terminatorNativeIpc.fs({ verb: 'trash', path: duDir });
                    } catch (e) { r.duBytes = -1; }
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
                    // STEMS (7.1c): the verb answers, the models are reported, the cache round-trips — and with
                    // TERMINATOR_PROBE_STEMS=1 (and a model on the machine) a real split runs end to end
                    const st = window.__terminatorNativeStems;
                    r.stems = st && st.selfTest ? await st.selfTest() : { error: 'no stems' };
                    // DRUMS (8.2): the library bundled inside the app is served at /drums/<id>.<ext> and a bogus
                    // path is refused; the MY DRUMS walk runs over a folder the probe fills in temp
                    const dr = window.__terminatorNativeDrums;
                    r.drums = dr && dr.selfTest ? await dr.selfTest() : { error: 'no drums' };
                    // THE LICENCE (8.5): the bridge is there and a forged callback is refused; with the fake
                    // seam armed (TERMINATOR_LICENSE_FAKE) the whole sign-in round trip runs too
                    // 8.3: the curated-playlist CACHE is not native, so its controls must not be ON SCREEN in
                    // this build — a DL PLAYLIST button that can only answer 0 of 0 is worse than no button.
                    r.playlistCacheHidden = !document.querySelector('.btn-cache-dl') && !document.querySelector('.btn-cache-del');
                    const lic = window.__terminatorNativeLicense;
                    r.license = lic && lic.selfTest ? await lic.selfTest() : { error: 'no license' };
                    if (lic && lic.seamTest && window.__terminatorProbeLicense) r.licenseSeam = await lic.seamTest();
                    r.done = true;
                } catch (e) { r.error = String(e && (e.stack || e.message) || e); }
            })();
        })();)JS";
        browser_->evaluateJavascript(kAsyncChecks, nullptr);
    }
    // THE MENU (8.6) end to end: the shell fires the HELP item and the final read looks for the page's help window.
    // A menu that renders but reaches nobody is exactly the shape the old `onShortcut` stub had.
    menuCommand("help");
}

// PROBE (5.1c): the ARM and the MONITOR over the real bridge handler — the engine's own behaviour is gated in
// ctest; what this checks is the JSON path the page actually calls. The take is armed a minute into the future, so
// it must report ARMED and capture nothing, and the file is dropped again.
// PROBE (6.2): a REAL plugin, all the way through — scanned, opened on a strip, attached to the engine's insert
// slot (checked on the mixer itself, not on the reply), its state read back, then closed. Needs a plugin to point
// at: TERMINATOR_PROBE_PLUGIN=<a .vst3>. Without one it reports skipped, because CI runners have no plugins.
juce::var WebShell::probePluginRack()
{
    auto* o = new juce::DynamicObject();
    const auto path = juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_PLUGIN", {});
    o->setProperty("skipped", path.isEmpty());
    if (path.isEmpty())
        return juce::var(o);
    // the id of whatever the scanFile check added
    juce::String id;
    {
        auto* req = new juce::DynamicObject();
        req->setProperty("verb", "list");
        const auto list = plugins_.handle(juce::var(req));
        if (const auto* arr = list.getProperty("plugins", juce::var()).getArray())
            for (const auto& p : *arr)
                if (p.getProperty("file", "").toString() == path)
                    id = p.getProperty("id", "").toString();
    }
    o->setProperty("id", id);
    if (id.isEmpty())
        return juce::var(o);
    constexpr int kStrip = 20; // a strip the page's mixer does not use
    engine_.commands().push(Command::mixerSetStrip(kStrip, static_cast<std::uint8_t>(StripKind::channel)));
    engine_.commands().push(Command::mixerAddFx(kStrip, static_cast<std::uint8_t>(FxType::plugin)));
    juce::Thread::sleep(60); // let the audio thread drain those two
    auto* open = new juce::DynamicObject();
    open->setProperty("verb", "open");
    open->setProperty("strip", kStrip);
    open->setProperty("slot", 0);
    open->setProperty("id", id);
    const auto opened = rack_.handle(juce::var(open));
    o->setProperty("opened", opened.getProperty("ok", false));
    o->setProperty("name", opened.getProperty("plugin", juce::var()).getProperty("name", ""));
    juce::Thread::sleep(60); // …and the attach command
    // THE REAL CHECK: the engine's own slot is holding the app's processor
    const auto* fx = engine_.mixer().fx(kStrip, 0);
    o->setProperty("slotIsPlugin", fx != nullptr && fx->type() == FxType::plugin);
    o->setProperty("attached", fx != nullptr && fx->type() == FxType::plugin &&
                                   static_cast<const PluginFx*>(fx)->processor() != nullptr);
    o->setProperty("chainLatency", engine_.mixer().chainLatencySamples(kStrip));
    auto* state = new juce::DynamicObject();
    state->setProperty("verb", "state");
    state->setProperty("strip", kStrip);
    state->setProperty("slot", 0);
    o->setProperty("stateBytes", rack_.handle(juce::var(state)).getProperty("bytes", -1));
    auto* close = new juce::DynamicObject();
    close->setProperty("verb", "close");
    close->setProperty("strip", kStrip);
    close->setProperty("slot", 0);
    o->setProperty("closed", rack_.handle(juce::var(close)).getProperty("ok", false));
    juce::Thread::sleep(60);
    const auto* after = engine_.mixer().fx(kStrip, 0);
    o->setProperty("detached", after == nullptr || after->type() != FxType::plugin ||
                                   static_cast<const PluginFx*>(after)->processor() == nullptr);
    engine_.commands().push(Command::mixerRemoveFx(kStrip, 0));
    // 6.3: the INSTRUMENT path, when a real one is pointed at (TERMINATOR_PROBE_INSTRUMENT=<a synth .vst3>): it is
    // scanned, opened on the strip and the ENGINE must be holding it as its instrument.
    if (const auto instPath = juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_INSTRUMENT", {});
        instPath.isNotEmpty())
    {
        auto* scan = new juce::DynamicObject();
        scan->setProperty("verb", "scanFile");
        scan->setProperty("file", instPath);
        scan->setProperty("format", "VST3");
        const auto scanned = plugins_.handle(juce::var(scan));
        o->setProperty("instrumentScanAdded", scanned.getProperty("added", -1));
        juce::String instId;
        if (const auto* ids = scanned.getProperty("ids", juce::var()).getArray(); ids != nullptr && !ids->isEmpty())
            instId = (*ids)[0].toString();
        o->setProperty("instrumentId", instId);
        if (instId.isNotEmpty())
        {
            auto* openInst = new juce::DynamicObject();
            openInst->setProperty("verb", "openInstrument");
            openInst->setProperty("strip", kStrip);
            openInst->setProperty("id", instId);
            const auto opened2 = rack_.handle(juce::var(openInst));
            o->setProperty("instrumentOpened", opened2.getProperty("ok", false));
            juce::Thread::sleep(80);
            o->setProperty("instrumentAttached", engine_.instrument() != nullptr);
            o->setProperty("instrumentStrip", engine_.instrumentStrip());
            auto* closeInst = new juce::DynamicObject();
            closeInst->setProperty("verb", "closeInstrument");
            rack_.handle(juce::var(closeInst));
            juce::Thread::sleep(80);
            o->setProperty("instrumentDetached", engine_.instrument() == nullptr);
        }
    }
    engine_.commands().push(Command::mixerSetStrip(kStrip, static_cast<std::uint8_t>(StripKind::off)));
    o->setProperty("ok", true);
    return juce::var(o);
}

juce::var WebShell::probeRecordArm()
{
    auto* o = new juce::DynamicObject();
    const auto f = juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("terminator-probe-take.wav");
    f.deleteFile();
    const double sr = engine_.config().sampleRate > 0 ? engine_.config().sampleRate : 48000.0;
    auto* start = new juce::DynamicObject();
    start->setProperty("verb", "start");
    start->setProperty("path", f.getFullPathName());
    start->setProperty("atSample", static_cast<double>(engine_.snapshot().samplesProcessed) + sr * 60.0);
    const auto startReply = handleRecord(juce::var(start));
    o->setProperty("startOk", startReply.getProperty("ok", false));
    o->setProperty("armed", startReply.getProperty("armed", false));
    auto* mon = new juce::DynamicObject();
    mon->setProperty("verb", "monitor");
    mon->setProperty("enabled", true);
    o->setProperty("monitorOk", handleRecord(juce::var(mon)).getProperty("monitoring", false));
    auto* monOff = new juce::DynamicObject();
    monOff->setProperty("verb", "monitor");
    monOff->setProperty("enabled", false);
    handleRecord(juce::var(monOff));
    auto* stop = new juce::DynamicObject();
    stop->setProperty("verb", "stop");
    o->setProperty("frames", handleRecord(juce::var(stop)).getProperty("frames", -1.0));
    f.deleteFile();
    return juce::var(o);
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
                                // 8.6: the shell fired the menu's HELP item — the page opened its help window
                                menuReachedPage: !!document.querySelector('.tt-help-backdrop'),
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
                    // PERF (9.3): what the native build is for. Reported, never gated — a CI runner's clock is
                    // not a user's machine — but a change that doubles startup shows up here in the build.
                    auto* pf = new juce::DynamicObject();
                    pf->setProperty("msToWindow", juce::roundToInt(perf::markMs(perf::Mark::window)));
                    pf->setProperty("msToPage", juce::roundToInt(perf::markMs(perf::Mark::page)));
                    pf->setProperty("msToEngine", juce::roundToInt(perf::markMs(perf::Mark::engine)));
                    pf->setProperty("msNow", juce::roundToInt(perf::sinceStartMs()));
                    pf->setProperty("rssAtPageMb", juce::roundToInt(perf::residentAtPageMb()));
                    pf->setProperty("rssMb", juce::roundToInt(perf::residentMb()));
                    const auto dev = audioIO_.currentDevice();
                    pf->setProperty("cpuLoad", juce::roundToInt(dev.cpuLoad * 1000.0) / 10.0); // %, one decimal
                    pf->setProperty("bufferSize", dev.bufferSize);
                    pf->setProperty("sampleRate", dev.sampleRate);
                    pf->setProperty("xruns", static_cast<int>(dev.xruns));
                    o->setProperty("perf", juce::var(pf));
                    o->setProperty("prefsWindow", prefsWindow_ != nullptr && prefsWindow_->isVisible());
                    o->setProperty("prefsReady", prefsReady_);
                    o->setProperty("registryKeys", static_cast<int>(registry_.keyCount()));
                    o->setProperty("enginePrepared", static_cast<bool>(engine_.snapshot().prepared));
                    o->setProperty("lastTriggeredPad", engine_.snapshot().lastTriggeredPad);
                    o->setProperty("record51c", probeRecordArm());
#if JUCE_MAC
                    // the mac main menu is the app's; on Windows the menu lives on the window (no getter to ask)
                    o->setProperty("menuInstalled", juce::MenuBarModel::getMacMainMenu() != nullptr);
#else
                    o->setProperty("menuInstalled", true);
#endif
                    {
                        // 6.1: the plugin list over the real handler (a SCAN is not run — that is minutes of other
                        // people's code; what the probe proves is that the hub loaded and answers).
                        auto* req = new juce::DynamicObject();
                        req->setProperty("verb", "list");
                        const auto reply = plugins_.handle(juce::var(req));
                        auto* p61 = new juce::DynamicObject();
                        p61->setProperty("ok", reply.getProperty("ok", false));
                        // …and the SCAN MACHINERY end to end on one file: the child process is spawned, its XML
                        // comes back and the list takes it. TERMINATOR_PROBE_PLUGIN=<a real .vst3> makes that a real
                        // plugin; without it the app's own binary stands in — a file that is definitely not a
                        // plugin, which must come back "0 added" rather than hanging or crashing.
                        {
                            const auto probePlugin =
                                juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_PLUGIN", {});
                            auto* one = new juce::DynamicObject();
                            one->setProperty("verb", "scanFile");
                            one->setProperty("file", probePlugin.isNotEmpty() ? probePlugin
                                                                              : juce::File::getSpecialLocation(
                                                                                    juce::File::currentExecutableFile)
                                                                                    .getFullPathName());
                            const auto scanReply = plugins_.handle(juce::var(one));
                            p61->setProperty("scanFileOk", scanReply.getProperty("ok", false));
                            p61->setProperty("scanFileAdded", scanReply.getProperty("added", -1));
                            p61->setProperty("scanFileReal", probePlugin.isNotEmpty());
                        }
                        const auto* formats = reply.getProperty("formats", juce::var()).getArray();
                        p61->setProperty("formats", formats != nullptr ? formats->size() : 0);
                        const auto* known = reply.getProperty("plugins", juce::var()).getArray();
                        p61->setProperty("known", known != nullptr ? known->size() : 0);
                        o->setProperty("plugins61", juce::var(p61));
                        o->setProperty("plugins62", probePluginRack());
                    }
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

    // The engine is only "running" once it is on a real device and pulling blocks — that is the moment the app
    // can make a sound, and the one worth measuring.
    if (perf::markMs(perf::Mark::engine) < 0.0 && audioIO_.currentDevice().open)
        perf::mark(perf::Mark::engine);
    samples_.collect(engine_.snapshot());
    finishCalibration();
    // A PUNCH-OUT fired (5.1c): the audio thread stopped capturing on its own frame, so the file is closed here and
    // the page is told — a take with a length has to land without anybody pressing STOP.
    if (engine_.recordComplete())
    {
        const auto path = recordPath_;
        const auto dropped = engine_.recorder().framesDropped();
        const auto frames = engine_.stopRecord();
        recordPath_ = {};
        auto* done = new juce::DynamicObject();
        done->setProperty("path", path);
        done->setProperty("frames", static_cast<double>(frames));
        done->setProperty("dropped", static_cast<double>(dropped));
        const double sr = engine_.config().sampleRate > 0 ? engine_.config().sampleRate : 48000.0;
        done->setProperty("seconds", static_cast<double>(frames) / sr);
        emitToAll("terminator.recordFinished", juce::var(done));
    }

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
    // recording + monitoring (5.1a/5.1c)
    obj->setProperty("recordState", static_cast<int>(s.recordState)); // 0 idle 1 armed 2 rolling 3 punched out
    obj->setProperty("recordStartSample", static_cast<juce::int64>(s.recordStartSample));
    obj->setProperty("recordStartPlayhead", static_cast<juce::int64>(s.recordStartPlayhead));
    obj->setProperty("recordFrames", static_cast<juce::int64>(s.recordFrames));
    obj->setProperty("recordDropped", static_cast<juce::int64>(s.recordDropped));
    obj->setProperty("monitorOn", static_cast<bool>(s.monitorOn));
    obj->setProperty("monitorStrip", s.monitorStrip);
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
