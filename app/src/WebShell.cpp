#include "WebShell.h"

#include <algorithm>
#include <cmath>
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
constexpr int kProbeDelayTicksReact = 420; // 21 s — the React UI: fonts + first render + engines constructing, then
                                           // the async checks (start at kProbeAsyncLeadTicks = 17 s before the read)
constexpr int kProbeAsyncLeadTicks = 340;  // the shim round-trip checks start 17 s before the final read (the shadow's
                                           // self-test alone runs ~11 s since 3.2–3.7 drive the native sequencers, the
                                           // count-in, the arp and the live-record landing)

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

// ---- the bass patch / pattern / timeline from the page's JSON (Phase 3.4, BRIDGE-PROTOCOL.md) ----
BassWave bassWaveOf(const juce::String& w, BassWave fallback)
{
    if (w == "tri")
        return BassWave::tri;
    if (w == "shark")
        return BassWave::shark;
    if (w == "saw")
        return BassWave::saw;
    if (w == "square")
        return BassWave::square;
    if (w == "pulse")
        return BassWave::pulse;
    if (w == "narrow")
        return BassWave::narrow;
    if (w == "sine")
        return BassWave::sine;
    if (w == "morph")
        return BassWave::morph;
    return fallback;
}
BassLfoWave bassLfoWaveOf(const juce::String& w, BassLfoWave fallback)
{
    if (w == "tri")
        return BassLfoWave::tri;
    if (w == "square")
        return BassLfoWave::square;
    if (w == "saw")
        return BassLfoWave::saw;
    if (w == "ramp")
        return BassLfoWave::ramp;
    if (w == "sine")
        return BassLfoWave::sine;
    if (w == "sh")
        return BassLfoWave::sh;
    return fallback;
}
/// The dotted knob path the MOD matrix targets → the engine's enum (none = unknown path, ignored).
BassModTarget bassModTargetOf(const juce::String& path)
{
    static const std::pair<const char*, BassModTarget> table[] = {
        {"osc.0.level", BassModTarget::osc1Level},
        {"osc.0.semi", BassModTarget::osc1Semi},
        {"osc.0.fine", BassModTarget::osc1Fine},
        {"osc.0.pw", BassModTarget::osc1Pw},
        {"osc.0.morph", BassModTarget::osc1Morph},
        {"osc.1.level", BassModTarget::osc2Level},
        {"osc.1.semi", BassModTarget::osc2Semi},
        {"osc.1.fine", BassModTarget::osc2Fine},
        {"osc.1.pw", BassModTarget::osc2Pw},
        {"osc.1.morph", BassModTarget::osc2Morph},
        {"osc.2.level", BassModTarget::osc3Level},
        {"osc.2.semi", BassModTarget::osc3Semi},
        {"osc.2.fine", BassModTarget::osc3Fine},
        {"osc.2.pw", BassModTarget::osc3Pw},
        {"osc.2.morph", BassModTarget::osc3Morph},
        {"sub.level", BassModTarget::subLevel},
        {"noise.level", BassModTarget::noiseLevel},
        {"mixerDrive", BassModTarget::mixerDrive},
        {"filter.cutoff", BassModTarget::filterCutoff},
        {"filter.reso", BassModTarget::filterReso},
        {"filter.envAmt", BassModTarget::filterEnvAmt},
        {"filter.kbd", BassModTarget::filterKbd},
        {"filter.drive", BassModTarget::filterDrive},
        {"filtEnv.a", BassModTarget::filtEnvA},
        {"filtEnv.d", BassModTarget::filtEnvD},
        {"filtEnv.s", BassModTarget::filtEnvS},
        {"filtEnv.r", BassModTarget::filtEnvR},
        {"ampEnv.a", BassModTarget::ampEnvA},
        {"ampEnv.d", BassModTarget::ampEnvD},
        {"ampEnv.s", BassModTarget::ampEnvS},
        {"ampEnv.r", BassModTarget::ampEnvR},
        {"glide", BassModTarget::glide},
        {"drift", BassModTarget::drift},
        {"velAmp", BassModTarget::velAmp},
        {"velFilt", BassModTarget::velFilt},
        {"post.drive", BassModTarget::postDrive},
        {"post.tone", BassModTarget::postTone},
        {"post.glue", BassModTarget::postGlue},
        {"post.gain", BassModTarget::postGain},
        {"modSrc.lfo.0.rate", BassModTarget::lfo1Rate},
        {"modSrc.lfo.1.rate", BassModTarget::lfo2Rate},
        {"modSrc.lfo.2.rate", BassModTarget::lfo3Rate},
        {"modSrc.trig.0.ramp", BassModTarget::trigARamp},
        {"modSrc.trig.0.fall", BassModTarget::trigAFall},
        {"modSrc.trig.1.ramp", BassModTarget::trigBRamp},
        {"modSrc.trig.1.fall", BassModTarget::trigBFall},
    };
    for (const auto& [name, t] : table)
        if (path == name)
            return t;
    return BassModTarget::none;
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
bool boolOr(const juce::var& o, const char* key, bool fallback)
{
    if (!o.isObject() || !o.hasProperty(key))
        return fallback;
    return static_cast<bool>(o[key]);
}
juce::String strOr(const juce::var& o, const char* key, const juce::String& fallback)
{
    if (!o.isObject() || !o.hasProperty(key) || !o[key].isString())
        return fallback;
    return o[key].toString();
}
/// deep-merge a (possibly partial) JSON patch over the defaults — the worklet's mergePatch(defaultPatch(), patch)
BassPatch bassPatchFromVar(const juce::var& j)
{
    BassPatch p = BassPatch::defaults();
    if (!j.isObject())
        return p;
    if (const auto* oscs = j.getProperty("osc", juce::var()).getArray())
        for (int i = 0; i < 3 && i < oscs->size(); ++i)
        {
            const auto& o = (*oscs)[i];
            auto& d = p.osc[i];
            d.on = boolOr(o, "on", d.on);
            d.wave = bassWaveOf(strOr(o, "wave", ""), d.wave);
            d.octave = numOr(o, "octave", d.octave);
            d.semi = numOr(o, "semi", d.semi);
            d.fine = numOr(o, "fine", d.fine);
            d.level = numOr(o, "level", d.level);
            d.pw = numOr(o, "pw", d.pw);
            d.morph = numOr(o, "morph", d.morph);
        }
    const auto sub = j.getProperty("sub", juce::var());
    p.subLevel = numOr(sub, "level", p.subLevel);
    {
        const auto w = strOr(sub, "wave", "");
        p.subWave = w == "square" ? BassWave::square : (w == "sine" ? BassWave::sine : p.subWave);
    }
    p.subOctave = static_cast<int>(numOr(sub, "octave", p.subOctave)) >= 2 ? 2 : 1;
    const auto noise = j.getProperty("noise", juce::var());
    p.noiseLevel = numOr(noise, "level", p.noiseLevel);
    p.noisePink = strOr(noise, "color", p.noisePink ? "pink" : "white") == "pink";
    p.mixerDrive = numOr(j, "mixerDrive", p.mixerDrive);
    const auto f = j.getProperty("filter", juce::var());
    {
        const auto m = strOr(f, "model", "");
        p.filterModel = m == "ota" ? BassFilterModel::ota
                                   : (m == "diode" ? BassFilterModel::diode
                                                   : (m == "ladder" ? BassFilterModel::ladder : p.filterModel));
        const auto mo = strOr(f, "mode", "");
        p.filterMode = mo == "bp"
                           ? BassFilterMode::bp
                           : (mo == "hp" ? BassFilterMode::hp : (mo == "lp" ? BassFilterMode::lp : p.filterMode));
        p.cutoff = numOr(f, "cutoff", p.cutoff);
        p.reso = numOr(f, "reso", p.reso);
        p.envAmt = numOr(f, "envAmt", p.envAmt);
        p.kbd = numOr(f, "kbd", p.kbd);
        p.poles = static_cast<int>(numOr(f, "poles", p.poles));
        p.filterDrive = numOr(f, "drive", p.filterDrive);
    }
    auto env = [&](const char* key, BassEnvPatch& e)
    {
        const auto o = j.getProperty(key, juce::var());
        e.a = numOr(o, "a", e.a);
        e.d = numOr(o, "d", e.d);
        e.s = numOr(o, "s", e.s);
        e.r = numOr(o, "r", e.r);
    };
    env("filtEnv", p.filtEnv);
    env("ampEnv", p.ampEnv);
    const auto lfo = j.getProperty("lfo", juce::var());
    p.lfoRate = numOr(lfo, "rate", p.lfoRate);
    p.lfoWave = bassLfoWaveOf(strOr(lfo, "wave", ""), p.lfoWave);
    p.lfoToCutoff = numOr(lfo, "toCutoff", p.lfoToCutoff);
    p.lfoToPitch = numOr(lfo, "toPitch", p.lfoToPitch);
    const auto ms = j.getProperty("modSrc", juce::var());
    if (const auto* lfos = ms.getProperty("lfo", juce::var()).getArray())
        for (int i = 0; i < 3 && i < lfos->size(); ++i)
        {
            const auto& o = (*lfos)[i];
            p.modLfo[i].rate = numOr(o, "rate", p.modLfo[i].rate);
            p.modLfo[i].wave = bassLfoWaveOf(strOr(o, "wave", ""), p.modLfo[i].wave);
            p.modLfo[i].key = boolOr(o, "key", p.modLfo[i].key);
        }
    if (const auto* trigs = ms.getProperty("trig", juce::var()).getArray())
        for (int i = 0; i < 2 && i < trigs->size(); ++i)
        {
            const auto& o = (*trigs)[i];
            p.modTrig[i].ramp = numOr(o, "ramp", p.modTrig[i].ramp);
            p.modTrig[i].fall = numOr(o, "fall", p.modTrig[i].fall);
            const auto sh = strOr(o, "shape", "");
            p.modTrig[i].shape =
                sh == "lin" ? BassTrigShape::lin : (sh == "exp" ? BassTrigShape::exp : p.modTrig[i].shape);
        }
    if (const auto* mods = j.getProperty("mods", juce::var()).getArray())
    {
        p.numMods = 0; // `mods` is replaced wholesale (the worklet's merge does the same)
        for (const auto& m : *mods)
        {
            if (p.numMods >= kBassMaxMods)
                break;
            const auto src = strOr(m, "src", "");
            const BassModSource sv = src == "lfo2"    ? BassModSource::lfo2
                                     : src == "lfo3"  ? BassModSource::lfo3
                                     : src == "trigA" ? BassModSource::trigA
                                     : src == "trigB" ? BassModSource::trigB
                                                      : BassModSource::lfo1;
            const BassModTarget t = bassModTargetOf(strOr(m, "target", ""));
            if (t == BassModTarget::none)
                continue;
            p.mods[p.numMods++] = {sv, t, std::clamp(numOr(m, "depth", 0.0), -1.0, 1.0)};
        }
    }
    p.glide = numOr(j, "glide", p.glide);
    p.legato = boolOr(j, "legato", p.legato);
    p.voices = std::clamp(static_cast<int>(numOr(j, "voices", p.voices)), 1, kBassMaxVoices);
    p.drift = numOr(j, "drift", p.drift);
    p.velAmp = numOr(j, "velAmp", p.velAmp);
    p.velFilt = numOr(j, "velFilt", p.velFilt);
    const auto post = j.getProperty("post", juce::var());
    p.postDrive = numOr(post, "drive", p.postDrive);
    p.postTone = numOr(post, "tone", p.postTone);
    p.postGlue = numOr(post, "glue", p.postGlue);
    p.postGain = numOr(post, "gain", p.postGain);
    return p;
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
        auto patch = std::make_shared<BassPatch>(bassPatchFromVar(json.getProperty("patch", juce::var())));
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
        pat->clear();
        pat->bars = std::clamp(static_cast<int>(json.getProperty("bars", 2)), 1, kBassMaxBars);
        pat->loopTicks = std::max(kBassPpq, pat->bars * 4 * kBassPpq);
        if (const auto* notes = json.getProperty("notes", juce::var()).getArray())
            for (const auto& n : *notes)
                pat->addNote(static_cast<std::int32_t>(numOr(n, "id", 0)), static_cast<int>(numOr(n, "note", 36)),
                             numOr(n, "start", 0.0), std::max(0.05, numOr(n, "dur", 0.25)),
                             std::clamp(numOr(n, "vel", 0.9), 0.05, 1.0), boolOr(n, "slide", false));
        if (const auto* bend = json.getProperty("bend", juce::var()).getArray())
            if (bend->size() > 0)
            {
                pat->hasBend = true;
                for (int t = 0; t < pat->loopTicks && t < kBassMaxLoopTicks; ++t)
                {
                    const double v = t < bend->size() ? static_cast<double>((*bend)[t]) : 0.0;
                    pat->bend[t] = static_cast<float>(std::isfinite(v) ? v : 0.0);
                }
            }
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
    browser_->emitEventIfBrowserIsVisible("terminator.snapshot", juce::var(obj));
}

} // namespace terminator::app
