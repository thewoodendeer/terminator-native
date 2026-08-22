#include "terminator/io/AudioIO.h"

namespace terminator
{

AudioIO::AudioIO(Engine& engine) : engine_(engine) {}

AudioIO::~AudioIO()
{
    close();
}

juce::String AudioIO::open(int numInputs, int numOutputs)
{
    close();
    const auto err = deviceManager_.initialiseWithDefaultDevices(numInputs, numOutputs);
    if (err.isNotEmpty())
    {
        lastError_ = err;
        return err;
    }
    deviceManager_.addAudioCallback(this);
    callbackAdded_ = true;
    return {};
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

AudioIO::DeviceInfo AudioIO::currentDevice() const
{
    DeviceInfo info;
    if (auto* dev = deviceManager_.getCurrentAudioDevice())
    {
        info.typeName = dev->getTypeName();
        info.deviceName = dev->getName();
        info.sampleRate = dev->getCurrentSampleRate();
        info.bufferSize = dev->getCurrentBufferSizeSamples();
        info.numInputs = dev->getActiveInputChannels().countNumberOfSetBits();
        info.numOutputs = dev->getActiveOutputChannels().countNumberOfSetBits();
        info.inputLatencySamples = dev->getInputLatencyInSamples();
        info.outputLatencySamples = dev->getOutputLatencyInSamples();
        info.open = dev->isOpen();
    }
    return info;
}

void AudioIO::audioDeviceIOCallbackWithContext(const float* const* /*inputChannelData*/, int /*numInputChannels*/,
                                               float* const* outputChannelData, int numOutputChannels, int numSamples,
                                               const juce::AudioIODeviceCallbackContext&)
{
    engine_.process(outputChannelData, numOutputChannels, numSamples);
}

void AudioIO::audioDeviceAboutToStart(juce::AudioIODevice* device)
{
    Engine::Config cfg;
    cfg.sampleRate = device->getCurrentSampleRate();
    cfg.maxBlockSize = device->getCurrentBufferSizeSamples();
    cfg.numOutputChannels = device->getActiveOutputChannels().countNumberOfSetBits();
    engine_.prepare(cfg);
}

void AudioIO::audioDeviceStopped()
{
    engine_.release();
}

void AudioIO::audioDeviceError(const juce::String& errorMessage)
{
    lastError_ = errorMessage;
}

} // namespace terminator
