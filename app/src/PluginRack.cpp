#include "PluginRack.h"

namespace terminator::app
{

// ---- the adapter: a juce::AudioPluginInstance behind the engine's ExternalProcessor -------------------------
// The engine hands two float channels and expects them back. A plugin that can be stereo in / stereo out is
// wrapped in place with no copy at all; anything else (mono, or more channels than we feed it) gets a scratch
// buffer sized once, because the audio thread must not allocate on behalf of somebody else's plugin either.
class PluginRack::Adapter final : public ExternalProcessor
{
  public:
    Adapter(juce::AudioPluginInstance& p, int maxBlock) : plugin_(p) { resize(maxBlock); }

    void resize(int maxBlock)
    {
        maxBlock_ = maxBlock > 0 ? maxBlock : 512;
        channels_ = juce::jmax(2, plugin_.getTotalNumInputChannels(), plugin_.getTotalNumOutputChannels());
        scratch_.setSize(channels_, maxBlock_, false, true, true);
        midi_.ensureSize(256);
    }

    void processBlock(float* const* channels, int numChannels, int numSamples) noexcept override
    {
        if (numSamples > maxBlock_ || numChannels < 2)
            return;
        midi_.clear();
        if (channels_ == 2)
        {
            juce::AudioBuffer<float> wrapped(const_cast<float**>(channels), 2, numSamples);
            plugin_.processBlock(wrapped, midi_);
            return;
        }
        // more channels than we drive: feed ours, silence the rest, take the first two back
        for (int c = 0; c < channels_; ++c)
        {
            auto* dst = scratch_.getWritePointer(c);
            if (c < 2)
                std::copy_n(channels[c], numSamples, dst);
            else
                std::fill_n(dst, numSamples, 0.0f);
        }
        juce::AudioBuffer<float> view(scratch_.getArrayOfWritePointers(), channels_, numSamples);
        plugin_.processBlock(view, midi_);
        for (int c = 0; c < 2; ++c)
            std::copy_n(scratch_.getReadPointer(c), numSamples, channels[c]);
    }

    int latencySamples() const noexcept override { return plugin_.getLatencySamples(); }

  private:
    juce::AudioPluginInstance& plugin_;
    juce::AudioBuffer<float> scratch_;
    juce::MidiBuffer midi_;
    int maxBlock_ = 512;
    int channels_ = 2;
};

// ---- the editor window ---------------------------------------------------------------------------------------
class PluginRack::EditorWindow final : public juce::DocumentWindow
{
  public:
    EditorWindow(const juce::String& name, juce::AudioProcessorEditor* editor, std::function<void()> onClose)
        : juce::DocumentWindow(name, juce::Colours::black, juce::DocumentWindow::closeButton),
          onClose_(std::move(onClose))
    {
        setUsingNativeTitleBar(true);
        setContentOwned(editor, true);
        setResizable(editor->isResizable(), false);
        centreWithSize(getWidth(), getHeight());
        setVisible(true);
        toFront(true);
    }
    void closeButtonPressed() override
    {
        if (onClose_)
            onClose_();
    }

  private:
    std::function<void()> onClose_;
};

// ---- the rack --------------------------------------------------------------------------------------------------
PluginRack::PluginRack(Engine& engine, PluginHub& hub) : engine_(engine), hub_(hub)
{
    startTimer(250);
}

PluginRack::~PluginRack()
{
    stopTimer();
    // Detach everything first, then let the instances go: the audio thread must never be handed a dangling
    // pointer, not even on the way out.
    for (auto& e : entries_)
        engine_.commands().push(Command::mixerSetFxProcessor(e->strip, e->slot, nullptr));
    entries_.clear();
    retired_.clear();
}

bool PluginRack::ownsVerb(const juce::String& verb)
{
    return verb == "open" || verb == "close" || verb == "editor" || verb == "state" || verb == "setState" ||
           verb == "params" || verb == "setParam" || verb == "rack";
}

PluginRack::Entry* PluginRack::find(int strip, int slot)
{
    for (auto& e : entries_)
        if (e->strip == strip && e->slot == slot)
            return e.get();
    return nullptr;
}

juce::var PluginRack::entryVar(const Entry& e) const
{
    auto* o = new juce::DynamicObject();
    o->setProperty("strip", e.strip);
    o->setProperty("slot", e.slot);
    o->setProperty("id", e.id);
    o->setProperty("name", e.name);
    o->setProperty("editorOpen", e.editor != nullptr);
    o->setProperty("latency", e.instance != nullptr ? e.instance->getLatencySamples() : 0);
    o->setProperty("hasEditor", e.instance != nullptr && e.instance->hasEditor());
    return juce::var(o);
}

void PluginRack::retire(std::unique_ptr<Entry> e)
{
    e->editor = nullptr; // the window goes now; the audio has not touched it
    engine_.commands().push(Command::mixerSetFxProcessor(e->strip, e->slot, nullptr));
    retired_.push_back({std::move(e), engine_.snapshot().blocksProcessed});
}

void PluginRack::timerCallback()
{
    const auto& s = engine_.snapshot();
    for (auto it = retired_.begin(); it != retired_.end();)
    {
        // Four blocks after the detach the audio thread has provably read the null; an engine that is not running
        // is not reading anything at all.
        if (s.prepared == 0 || s.blocksProcessed > it->blocksAt + 4)
            it = retired_.erase(it);
        else
            ++it;
    }
}

void PluginRack::prepareAll(double sampleRate, int blockSize)
{
    for (auto& e : entries_)
    {
        if (e->instance == nullptr)
            continue;
        // Detach across the re-prepare: releaseResources/prepareToPlay on a plugin the audio thread is calling is
        // exactly the crash this whole design exists to avoid.
        engine_.commands().push(Command::mixerSetFxProcessor(e->strip, e->slot, nullptr));
        e->instance->releaseResources();
        e->instance->setRateAndBufferSizeDetails(sampleRate, blockSize);
        e->instance->prepareToPlay(sampleRate, blockSize);
        e->adapter->resize(blockSize);
        engine_.commands().push(Command::mixerSetFxProcessor(e->strip, e->slot, e->adapter.get()));
    }
}

juce::var PluginRack::handle(const juce::var& req)
{
    const auto verb = req.getProperty("verb", "").toString();
    const int strip = static_cast<int>(req.getProperty("strip", -1));
    const int slot = static_cast<int>(req.getProperty("slot", -1));
    auto* reply = new juce::DynamicObject();

    if (verb == "rack")
    {
        juce::Array<juce::var> list;
        for (const auto& e : entries_)
            list.add(entryVar(*e));
        reply->setProperty("ok", true);
        reply->setProperty("rack", list);
        return juce::var(reply);
    }

    if (verb == "open")
    {
        const auto id = req.getProperty("id", "").toString();
        const double sr = engine_.config().sampleRate > 0 ? engine_.config().sampleRate : 48000.0;
        const int block = engine_.config().maxBlockSize > 0 ? engine_.config().maxBlockSize : 512;
        juce::String error;
        auto instance = hub_.create(id, sr, block, error);
        if (instance == nullptr)
        {
            reply->setProperty("ok", false);
            reply->setProperty("error", error.isNotEmpty() ? error : juce::String("the plugin would not load"));
            return juce::var(reply);
        }
        // Stereo in / stereo out when the plugin will take it — then the engine's two channels are wrapped with no
        // copy at all. A plugin that refuses keeps its own layout and the adapter feeds it through a scratch.
        instance->enableAllBuses();
        auto layout = instance->getBusesLayout();
        for (auto& b : layout.inputBuses)
            b = juce::AudioChannelSet::stereo();
        for (auto& b : layout.outputBuses)
            b = juce::AudioChannelSet::stereo();
        instance->setBusesLayout(layout);
        instance->setRateAndBufferSizeDetails(sr, block);
        instance->prepareToPlay(sr, block);
        if (const auto stateB64 = req.getProperty("state", "").toString(); stateB64.isNotEmpty())
        {
            juce::MemoryOutputStream bytes;
            if (juce::Base64::convertFromBase64(bytes, stateB64))
                instance->setStateInformation(bytes.getData(), static_cast<int>(bytes.getDataSize()));
        }
        auto entry = std::make_unique<Entry>();
        entry->name = instance->getName();
        entry->id = id;
        entry->strip = strip;
        entry->slot = slot;
        entry->adapter = std::make_unique<Adapter>(*instance, block);
        entry->instance = std::move(instance);
        // If the slot already held one, that one goes — after the engine has moved on (retire()).
        for (auto it = entries_.begin(); it != entries_.end();)
        {
            if ((*it)->strip == strip && (*it)->slot == slot)
            {
                retire(std::move(*it));
                it = entries_.erase(it);
            }
            else
                ++it;
        }
        engine_.commands().push(Command::mixerSetFxProcessor(strip, slot, entry->adapter.get()));
        reply->setProperty("ok", true);
        reply->setProperty("plugin", entryVar(*entry));
        entries_.push_back(std::move(entry));
        return juce::var(reply);
    }

    if (verb == "close")
    {
        for (auto it = entries_.begin(); it != entries_.end();)
        {
            if ((*it)->strip == strip && ((*it)->slot == slot || slot < 0))
            {
                retire(std::move(*it));
                it = entries_.erase(it);
            }
            else
                ++it;
        }
        reply->setProperty("ok", true);
        return juce::var(reply);
    }

    auto* e = find(strip, slot);
    if (e == nullptr || e->instance == nullptr)
    {
        reply->setProperty("ok", false);
        reply->setProperty("error", "no plugin on strip " + juce::String(strip) + " slot " + juce::String(slot));
        return juce::var(reply);
    }

    if (verb == "editor")
    {
        const bool show = static_cast<bool>(req.getProperty("show", true));
        if (!show)
            e->editor = nullptr;
        else if (e->editor == nullptr)
        {
            if (auto* ed = e->instance->createEditorAndMakeActive())
                e->editor = std::make_unique<EditorWindow>(e->name, ed,
                                                           [this, strip, slot]
                                                           {
                                                               if (auto* found = find(strip, slot))
                                                                   found->editor = nullptr;
                                                           });
            else
            {
                reply->setProperty("ok", false);
                reply->setProperty("error", "this plugin has no editor");
                return juce::var(reply);
            }
        }
        else
            e->editor->toFront(true);
        reply->setProperty("ok", true);
        reply->setProperty("plugin", entryVar(*e));
        return juce::var(reply);
    }

    if (verb == "state")
    {
        // The plugin's own state, base64 — this is what a project has to carry for a plugin to come back the way
        // it was left.
        juce::MemoryBlock block;
        e->instance->getStateInformation(block);
        reply->setProperty("ok", true);
        reply->setProperty("state", block.toBase64Encoding());
        reply->setProperty("bytes", static_cast<int>(block.getSize()));
        return juce::var(reply);
    }

    if (verb == "setState")
    {
        juce::MemoryOutputStream bytes;
        if (!juce::Base64::convertFromBase64(bytes, req.getProperty("state", "").toString()))
        {
            reply->setProperty("ok", false);
            reply->setProperty("error", "the state was not base64");
            return juce::var(reply);
        }
        e->instance->setStateInformation(bytes.getData(), static_cast<int>(bytes.getDataSize()));
        reply->setProperty("ok", true);
        return juce::var(reply);
    }

    if (verb == "params")
    {
        juce::Array<juce::var> list;
        const auto& params = e->instance->getParameters();
        for (int i = 0; i < params.size(); ++i)
        {
            auto* p = params[i];
            auto* o = new juce::DynamicObject();
            o->setProperty("index", i);
            o->setProperty("name", p->getName(64));
            o->setProperty("value", static_cast<double>(p->getValue())); // 0..1, the format's own normalisation
            o->setProperty("text", p->getText(p->getValue(), 32));
            o->setProperty("label", p->getLabel());
            list.add(juce::var(o));
        }
        reply->setProperty("ok", true);
        reply->setProperty("params", list);
        return juce::var(reply);
    }

    if (verb == "setParam")
    {
        const int index = static_cast<int>(req.getProperty("index", -1));
        const auto value = static_cast<float>(static_cast<double>(req.getProperty("value", 0.0)));
        const auto& params = e->instance->getParameters();
        if (index < 0 || index >= params.size())
        {
            reply->setProperty("ok", false);
            reply->setProperty("error", "no such parameter");
            return juce::var(reply);
        }
        params[index]->setValueNotifyingHost(juce::jlimit(0.0f, 1.0f, value));
        reply->setProperty("ok", true);
        return juce::var(reply);
    }

    reply->setProperty("ok", false);
    reply->setProperty("error", "unknown plugin verb '" + verb + "'");
    return juce::var(reply);
}

} // namespace terminator::app
