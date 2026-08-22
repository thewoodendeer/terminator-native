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

juce::WebBrowserComponent::Options
makeOptions(WebShell& self,
            std::function<std::optional<juce::WebBrowserComponent::Resource>(const juce::String&)> provider,
            std::function<juce::var()> info, std::function<juce::var(const juce::var&)> command)
{
    juce::ignoreUnused(self);
    auto opts =
        juce::WebBrowserComponent::Options{}
            .withNativeIntegrationEnabled()
            .withKeepPageLoadedWhenBrowserIsHidden()
            .withResourceProvider(std::move(provider))
            .withNativeFunction("terminatorInfo", [info](const juce::Array<juce::var>&,
                                                         juce::WebBrowserComponent::NativeFunctionCompletion complete)
                                { complete(info()); })
            .withNativeFunction("terminatorCommand",
                                [command](const juce::Array<juce::var>& args,
                                          juce::WebBrowserComponent::NativeFunctionCompletion complete)
                                { complete(command(args.size() > 0 ? args[0] : juce::var())); });
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
} // namespace

WebShell::WebShell(Engine& engine, AudioIO& audioIO, juce::String audioError)
    : engine_(engine), audioIO_(audioIO), audioError_(std::move(audioError))
{
    const auto probePath = juce::SystemStats::getEnvironmentVariable("TERMINATOR_PROBE_FILE", {});
    if (probePath.isNotEmpty())
        probeFile_ = juce::File::getCurrentWorkingDirectory().getChildFile(probePath);

    browser_ = std::make_unique<Browser>(makeOptions(
                                             *this, [this](const juce::String& url) { return provideResource(url); },
                                             [this] { return engineInfo(); },
                                             [this](const juce::var& json)
                                             {
                                                 juce::String err;
                                                 const bool ok = applyJsonCommand(json, err);
                                                 auto* obj = new juce::DynamicObject();
                                                 obj->setProperty("ok", ok);
                                                 if (!ok)
                                                     obj->setProperty("error", err);
                                                 return juce::var(obj);
                                             }),
                                         [this](const juce::String& url) { pageLoaded(url); });
    addAndMakeVisible(*browser_);

    const auto devUrl = juce::SystemStats::getEnvironmentVariable("TERMINATOR_UI_URL", {});
    browser_->goToURL(devUrl.isNotEmpty() ? devUrl : juce::WebBrowserComponent::getResourceProviderRoot());

    startTimerHz(kSnapshotHz);
    setSize(1100, 720);
}

WebShell::~WebShell()
{
    stopTimer();
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
    obj->setProperty("bridgeProtocol", 0);

    const auto dev = audioIO_.currentDevice();
    auto* d = new juce::DynamicObject();
    d->setProperty("type", dev.typeName);
    d->setProperty("name", dev.deviceName);
    d->setProperty("sampleRate", dev.sampleRate);
    d->setProperty("bufferSize", dev.bufferSize);
    d->setProperty("inputs", dev.numInputs);
    d->setProperty("outputs", dev.numOutputs);
    d->setProperty("inputLatencySamples", dev.inputLatencySamples);
    d->setProperty("outputLatencySamples", dev.outputLatencySamples);
    d->setProperty("open", dev.open);
    d->setProperty("error", audioError_);
    obj->setProperty("device", juce::var(d));
    return juce::var(obj);
}

bool WebShell::applyJsonCommand(const juce::var& json, juce::String& error)
{
    if (!json.isObject())
    {
        error = "command must be an object";
        return false;
    }
    const auto type = json["type"].toString();
    Command c;
    if (type == "setMasterGain")
        c = Command::setMasterGain(static_cast<float>(static_cast<double>(json["gain"])));
    else if (type == "setTestTone")
        c = Command::setTestTone(static_cast<bool>(json["enabled"]),
                                 static_cast<float>(static_cast<double>(json.getProperty("frequencyHz", 440.0))),
                                 static_cast<float>(static_cast<double>(json.getProperty("amplitude", 0.25))));
    else if (type == "transportPlay")
        c = Command::transportPlay();
    else if (type == "transportStop")
        c = Command::transportStop();
    else if (type == "panic")
        c = Command::panic();
    else
    {
        error = "unknown command type '" + type + "'";
        return false;
    }
    if (!engine_.commands().push(c))
    {
        error = "command queue full";
        return false;
    }
    return true;
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
                                peak: t('peakTxt') });
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
    if (!pageReady_)
        return;

    const auto& s = engine_.snapshot();
    auto* obj = new juce::DynamicObject();
    obj->setProperty("prepared", static_cast<bool>(s.prepared));
    obj->setProperty("sampleRate", s.sampleRate);
    obj->setProperty("blockSize", static_cast<int>(s.blockSize));
    obj->setProperty("outputs", static_cast<int>(s.numOutputChannels));
    obj->setProperty("playing", static_cast<bool>(s.playing));
    obj->setProperty("playheadSamples", static_cast<juce::int64>(s.playheadSamples));
    obj->setProperty("blocksProcessed", static_cast<juce::int64>(s.blocksProcessed));
    obj->setProperty("masterGain", static_cast<double>(s.masterGain));
    obj->setProperty("testToneEnabled", static_cast<bool>(s.testToneEnabled));
    obj->setProperty("testToneFrequencyHz", static_cast<double>(s.testToneFrequencyHz));
    obj->setProperty("peakL", static_cast<double>(s.peak[0]));
    obj->setProperty("peakR", static_cast<double>(s.peak[1]));
    obj->setProperty("commandsApplied", static_cast<juce::int64>(s.commandsApplied));
    obj->setProperty("commandsDropped", static_cast<juce::int64>(s.commandsDropped));
    obj->setProperty("cpuLoad", audioIO_.cpuLoad());
    obj->setProperty("xruns", audioIO_.xrunCount());
    browser_->emitEventIfBrowserIsVisible("terminator.snapshot", juce::var(obj));
}

} // namespace terminator::app
