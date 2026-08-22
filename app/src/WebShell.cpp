#include "WebShell.h"

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

namespace
{
constexpr int kSnapshotHz = 20;
constexpr int kProbeDelayTicks = 50; // 2.5 s at 20 Hz — enough for info() + a few snapshots

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
      audioError_(std::move(audioError))
{
    const auto probePath = juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_FILE", {});
    if (probePath.isNotEmpty())
        probeFile_ = juce::File::getCurrentWorkingDirectory().getChildFile(probePath);

    auto opts =
        juce::WebBrowserComponent::Options{}
            .withNativeIntegrationEnabled()
            .withKeepPageLoadedWhenBrowserIsHidden()
            .withResourceProvider([this](const juce::String& url) { return provideResource(url); })
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
                                { handlePads(args.size() > 0 ? args[0] : juce::var(), std::move(complete)); });
#if JUCE_WINDOWS
    opts = opts.withBackend(juce::WebBrowserComponent::Options::Backend::webview2)
               .withWinWebView2Options(
                   juce::WebBrowserComponent::Options::WinWebView2{}
                       .withUserDataFolder(
                           juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("TerminatorWebView2"))
                       .withStatusBarDisabled()
                       .withBackgroundColour(juce::Colours::black));
#endif
    browser_ = std::make_unique<Browser>(opts, [this](const juce::String& url) { pageLoaded(url); });
    addAndMakeVisible(*browser_);

    audioIO_.onDeviceChanged = [this]
    {
        if (pageReady_)
            browser_->emitEventIfBrowserIsVisible("terminator.devicesChanged", deviceInfoVar());
    };
    midi_.onPortsChanged = [this]
    {
        if (pageReady_)
            browser_->emitEventIfBrowserIsVisible("terminator.midiChanged",
                                                  handleMidi(juce::var(new juce::DynamicObject())));
    };

    const auto devUrl = juce::SystemStats::getEnvironmentVariable("TERMINATOR_UI_URL", {});
    browser_->goToURL(devUrl.isNotEmpty() ? devUrl : juce::WebBrowserComponent::getResourceProviderRoot());

    startTimerHz(kSnapshotHz);
    setSize(1200, 800);
}

WebShell::~WebShell()
{
    stopTimer();
    audioIO_.onDeviceChanged = nullptr;
    midi_.onPortsChanged = nullptr;
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
    Command c;
    if (type == "setMasterGain")
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
        p.gain = static_cast<float>(static_cast<double>(json.getProperty("gain", 1.0)));
        p.outputPair = static_cast<std::uint8_t>(static_cast<int>(json.getProperty("outputPair", 0)));
        const auto mode = json.getProperty("mode", "oneshot").toString();
        p.mode = mode == "gate" ? PadMode::gate : mode == "loop" ? PadMode::loop : PadMode::oneShot;
        p.reverse = static_cast<bool>(json.getProperty("reverse", false)) ? 1 : 0;
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

void WebShell::pageLoaded(const juce::String&)
{
    pageReady_ = true;
    if (probeFile_ != juce::File() && !probeArmed_)
    {
        probeArmed_ = true;
        probeCountdown_ = kProbeDelayTicks;
    }
}

void WebShell::runProbe()
{
    static const char* kScript = R"JS((function(){
        const t = (id) => { const e = document.getElementById(id); return e ? e.textContent : null; };
        return JSON.stringify({ title: document.title, hasJuce: !!(window.__JUCE__ && window.__JUCE__.backend),
                                bridge: t('bridge'), engine: t('engine'), device: t('device'), snapshot: t('snap'),
                                peak: t('peakTxt'), midi: t('midiTxt'), pads: document.querySelectorAll('.pad').length });
    })())JS";
    browser_->evaluateJavascript(kScript,
                                 [this](juce::WebBrowserComponent::EvaluationResult result)
                                 {
                                     juce::String out;
                                     if (const auto* v = result.getResult())
                                         out = v->toString();
                                     else if (const auto* e = result.getError())
                                         out = "{\"error\":" + juce::JSON::toString(e->message) + "}";
                                     probeFile_.deleteFile();
                                     probeFile_.replaceWithText(out + "\n");
                                     juce::JUCEApplication::getInstance()->systemRequestedQuit();
                                 });
}

void WebShell::timerCallback()
{
    if (probeArmed_ && probeCountdown_ > 0 && --probeCountdown_ == 0)
        runProbe();

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
    obj->setProperty("padActiveMask", static_cast<juce::int64>(s.padActiveMask));
    obj->setProperty("lastTriggeredPad", s.lastTriggeredPad);
    obj->setProperty("lastTriggeredPadPositionSec", s.lastTriggeredPadPositionSec);
    obj->setProperty("calibrationState", static_cast<int>(s.calibrationState));
    obj->setProperty("calibrationSamples", calibrationResultSamples_);
    obj->setProperty("calibrationMs", calibrationResultMs_);
    obj->setProperty("midiMessages", static_cast<juce::int64>(midi_.messageCount()));
    obj->setProperty("midiLagMs", midi_.medianInputLagMs());
    obj->setProperty("midiLast", midi_.lastMessageDescription());
    browser_->emitEventIfBrowserIsVisible("terminator.snapshot", juce::var(obj));
}

} // namespace terminator::app
