#pragma once
// AudioIO — the device layer. Wraps juce::AudioDeviceManager and feeds Engine::process from the device
// callback. Non-RT surface (open/close/query) is message-thread only. Phase 0: default output device,
// 0 inputs. Phase 1 grows this into the full Preferences → AUDIO model (types, channels, rates, hot-plug).
#include <memory>

#include <juce_audio_devices/juce_audio_devices.h>

#include "terminator/core/Engine.h"

namespace terminator
{

class AudioIO : private juce::AudioIODeviceCallback
{
  public:
    struct DeviceInfo
    {
        juce::String typeName;
        juce::String deviceName;
        double sampleRate = 0.0;
        int bufferSize = 0;
        int numInputs = 0;
        int numOutputs = 0;
        int inputLatencySamples = 0;
        int outputLatencySamples = 0;
        bool open = false;
    };

    explicit AudioIO(Engine& engine);
    ~AudioIO() override;

    /// Opens the default device. Returns an empty string on success, an error message otherwise.
    juce::String open(int numInputs, int numOutputs);
    void close();

    DeviceInfo currentDevice() const;
    juce::AudioDeviceManager& deviceManager() noexcept { return deviceManager_; }
    double cpuLoad() const { return deviceManager_.getCpuUsage(); }
    int xrunCount() const { return deviceManager_.getXRunCount(); }

  private:
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData, int numInputChannels,
                                          float* const* outputChannelData, int numOutputChannels, int numSamples,
                                          const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;
    void audioDeviceError(const juce::String& errorMessage) override;

    Engine& engine_;
    juce::AudioDeviceManager deviceManager_;
    bool callbackAdded_ = false;
    juce::String lastError_;
};

} // namespace terminator
