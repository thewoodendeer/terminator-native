#include "terminator/io/AudioIO.h"

namespace terminator
{

namespace
{
juce::BigInteger maskFrom(const std::vector<int>& channels)
{
    juce::BigInteger m;
    for (int c : channels)
        if (c >= 0 && c < 256)
            m.setBit(c);
    return m;
}
} // namespace

std::uint64_t AudioIO::hostTimeNowNs() noexcept
{
    const auto ticks = juce::Time::getHighResolutionTicks();
    const auto perSec = juce::Time::getHighResolutionTicksPerSecond();
    if (perSec <= 0)
        return 0;
    // ticks → ns without overflow for large tick counts
    const auto whole = ticks / perSec;
    const auto rem = ticks % perSec;
    return static_cast<std::uint64_t>(whole) * 1000000000ull + static_cast<std::uint64_t>(rem * 1000000000ll / perSec);
}

AudioIO::AudioIO(Engine& engine) : engine_(engine)
{
    deviceManager_.addChangeListener(this);
}

AudioIO::~AudioIO()
{
    deviceManager_.removeChangeListener(this);
    close();
}

void AudioIO::ensureCallback()
{
    if (!callbackAdded_)
    {
        deviceManager_.addAudioCallback(this);
        callbackAdded_ = true;
    }
}

juce::String AudioIO::openDefault(int numInputs, int numOutputs)
{
    close();
    const auto err = deviceManager_.initialiseWithDefaultDevices(numInputs, numOutputs);
    if (err.isNotEmpty())
    {
        lastError_ = err;
        return err;
    }
    ensureCallback();
    return {};
}

juce::String AudioIO::apply(const DeviceSetup& setup)
{
    if (setup.deviceType.isNotEmpty() && setup.deviceType != deviceManager_.getCurrentAudioDeviceType())
        deviceManager_.setCurrentAudioDeviceType(setup.deviceType, true);

    juce::AudioDeviceManager::AudioDeviceSetup s = deviceManager_.getAudioDeviceSetup();
    s.inputDeviceName = setup.inputDevice;
    s.outputDeviceName = setup.outputDevice;
    s.sampleRate = setup.sampleRate;
    s.bufferSize = setup.bufferSize;
    if (setup.inputChannels.empty())
        s.useDefaultInputChannels = true;
    else
    {
        s.useDefaultInputChannels = false;
        s.inputChannels = maskFrom(setup.inputChannels);
    }
    if (setup.outputChannels.empty())
        s.useDefaultOutputChannels = true;
    else
    {
        s.useDefaultOutputChannels = false;
        s.outputChannels = maskFrom(setup.outputChannels);
    }
    const auto err = deviceManager_.setAudioDeviceSetup(s, true);
    lastError_ = err;
    if (err.isEmpty())
        ensureCallback();
    return err;
}

void AudioIO::close()
{
    if (callbackAdded_)
    {
        deviceManager_.removeAudioCallback(this);
        callbackAdded_ = false;
    }
    deviceManager_.closeAudioDevice();
}

juce::StringArray AudioIO::deviceTypes()
{
    juce::StringArray out;
    for (auto* t : deviceManager_.getAvailableDeviceTypes())
        out.add(t->getTypeName());
    return out;
}

juce::StringArray AudioIO::inputDevices(const juce::String& deviceType)
{
    for (auto* t : deviceManager_.getAvailableDeviceTypes())
        if (t->getTypeName() == deviceType)
        {
            t->scanForDevices();
            return t->getDeviceNames(true);
        }
    return {};
}

juce::StringArray AudioIO::outputDevices(const juce::String& deviceType)
{
    for (auto* t : deviceManager_.getAvailableDeviceTypes())
        if (t->getTypeName() == deviceType)
        {
            t->scanForDevices();
            return t->getDeviceNames(false);
        }
    return {};
}

juce::String AudioIO::currentDeviceType() const
{
    return deviceManager_.getCurrentAudioDeviceType();
}

AudioIO::DeviceSetup AudioIO::currentSetup() const
{
    DeviceSetup d;
    const auto s = deviceManager_.getAudioDeviceSetup();
    d.deviceType = deviceManager_.getCurrentAudioDeviceType();
    d.inputDevice = s.inputDeviceName;
    d.outputDevice = s.outputDeviceName;
    d.sampleRate = s.sampleRate;
    d.bufferSize = s.bufferSize;
    if (auto* dev = deviceManager_.getCurrentAudioDevice())
    {
        const auto in = dev->getActiveInputChannels();
        const auto out = dev->getActiveOutputChannels();
        for (int i = 0; i <= in.getHighestBit(); ++i)
            if (in[i])
                d.inputChannels.push_back(i);
        for (int i = 0; i <= out.getHighestBit(); ++i)
            if (out[i])
                d.outputChannels.push_back(i);
    }
    return d;
}

AudioIO::DeviceInfo AudioIO::currentDevice() const
{
    DeviceInfo info;
    info.lastError = lastError_;
    info.xruns = deviceManager_.getXRunCount();
    info.cpuLoad = deviceManager_.getCpuUsage();
    if (auto* dev = deviceManager_.getCurrentAudioDevice())
    {
        const auto setup = deviceManager_.getAudioDeviceSetup();
        info.typeName = dev->getTypeName();
        info.inputDeviceName = setup.inputDeviceName;
        info.outputDeviceName = setup.outputDeviceName;
        info.sampleRate = dev->getCurrentSampleRate();
        info.bufferSize = dev->getCurrentBufferSizeSamples();
        info.activeInputChannels = dev->getActiveInputChannels();
        info.activeOutputChannels = dev->getActiveOutputChannels();
        info.numInputs = info.activeInputChannels.countNumberOfSetBits();
        info.numOutputs = info.activeOutputChannels.countNumberOfSetBits();
        info.inputLatencySamples = dev->getInputLatencyInSamples();
        info.outputLatencySamples = dev->getOutputLatencyInSamples();
        info.inputChannelNames = dev->getInputChannelNames();
        info.outputChannelNames = dev->getOutputChannelNames();
        info.availableSampleRates = dev->getAvailableSampleRates();
        info.availableBufferSizes = dev->getAvailableBufferSizes();
        info.open = dev->isOpen();
    }
    return info;
}

void AudioIO::audioDeviceIOCallbackWithContext(const float* const* inputChannelData, int numInputChannels,
                                               float* const* outputChannelData, int numOutputChannels, int numSamples,
                                               const juce::AudioIODeviceCallbackContext&)
{
    // One clock for everything (MIDI threads stamp with the same function) — the driver's hostTimeNs is on a
    // different timebase per platform, so we take our own entry timestamp instead.
    engine_.process(inputChannelData, numInputChannels, outputChannelData, numOutputChannels, numSamples,
                    hostTimeNowNs());
}

void AudioIO::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    Engine::Config cfg;
    cfg.sampleRate = device->getCurrentSampleRate();
    cfg.maxBlockSize = device->getCurrentBufferSizeSamples();
    cfg.numOutputChannels = device->getActiveOutputChannels().countNumberOfSetBits();
    cfg.numInputChannels = device->getActiveInputChannels().countNumberOfSetBits();
    engine_.prepare(cfg);
}

void AudioIO::audioDeviceStopped()
{
    engine_.release();
}

void AudioIO::audioDeviceError(const juce::String& errorMessage)
{
    lastError_ = errorMessage;
    juce::MessageManager::callAsync(
        [this]
        {
            if (onDeviceChanged)
                onDeviceChanged();
        });
}

void AudioIO::changeListenerCallback(juce::ChangeBroadcaster*)
{
    if (onDeviceChanged)
        onDeviceChanged();
}

} // namespace terminator
