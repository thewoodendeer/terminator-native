#include "PluginProcessor.h"

#include "PluginEditor.h"

namespace terminator::app
{

TerminatorProcessor::TerminatorProcessor()
    : juce::AudioProcessor(BusesProperties().withOutput("Output", juce::AudioChannelSet::stereo(), true))
{
    settings_.load();
    // MIDI: the same "every input on first run" rule the app uses. In a plugin the host also sends MIDI, which
    // Phase 11 will route — for now a controller reaches the pads directly, exactly as in the standalone app.
    const auto midiSaved = settings_.get("midi.inputs");
    if (midiSaved.isObject())
    {
        for (const auto& p : midi_.inputs())
            if (static_cast<bool>(midiSaved.getProperty(p.identifier, false)))
                midi_.enableInput(p.identifier, true);
    }
    else
        midi_.enableAllInputs();
}

TerminatorProcessor::~TerminatorProcessor() = default;

void TerminatorProcessor::prepareToPlay(double sampleRate, int maxBlockSize)
{
    Engine::Config cfg;
    cfg.sampleRate = sampleRate;
    cfg.maxBlockSize = maxBlockSize;
    cfg.numOutputChannels = 2;
    cfg.numInputChannels = 0;
    cfg.outputLatencySamples = 0;
    engine_.prepare(cfg);
}

void TerminatorProcessor::releaseResources()
{
    engine_.release();
}

bool TerminatorProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const
{
    return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
}

void TerminatorProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    buffer.clear();
    // The same call the audio device makes in the standalone app — one engine, one render path.
    engine_.process(nullptr, 0, buffer.getArrayOfWritePointers(), buffer.getNumChannels(), buffer.getNumSamples(),
                    AudioIO::hostTimeNowNs());
}

juce::AudioProcessorEditor* TerminatorProcessor::createEditor()
{
    return new TerminatorEditor(*this);
}

} // namespace terminator::app

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new terminator::app::TerminatorProcessor();
}
