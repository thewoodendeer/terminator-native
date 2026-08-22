#pragma once
// AudioIO — the device layer. Wraps juce::AudioDeviceManager and feeds Engine::process from the device
// callback. Non-RT surface (types/devices/setup/hot-plug) is message-thread only. Preferences → AUDIO
// (Ableton-style: driver type, in/out device, channel config, rate, buffer, latencies) maps 1:1 onto
// DeviceSetup. JUCE 9 ships a rewritten CoreAudio backend (Mac); Windows = ASIO (when the SDK is present)
// + WASAPI (exclusive/shared) + DirectSound.
#include <functional>
#include <memory>
#include <vector>

#include <juce_audio_devices/juce_audio_devices.h>

#include "terminator/core/Engine.h"

namespace terminator
{

class AudioIO : private juce::AudioIODeviceCallback, private juce::ChangeListener
{
  public:
    struct DeviceSetup
    {
        juce::String
            deviceType; // "CoreAudio" · "ASIO" · "Windows Audio" · "Windows Audio (Exclusive Mode)" · "DirectSound"
        juce::String inputDevice; // empty = none
        juce::String outputDevice;
        double sampleRate = 0.0;         // 0 = device default
        int bufferSize = 0;              // 0 = device default
        std::vector<int> inputChannels;  // enabled channel indices (empty = defaults: 0,1)
        std::vector<int> outputChannels; // enabled channel indices (empty = defaults: 0,1)
    };

    struct DeviceInfo
    {
        juce::String typeName;
        juce::String inputDeviceName;
        juce::String outputDeviceName;
        double sampleRate = 0.0;
        int bufferSize = 0;
        int numInputs = 0; // ACTIVE channels
        int numOutputs = 0;
        int inputLatencySamples = 0;
        int outputLatencySamples = 0;
        bool open = false;
        juce::StringArray inputChannelNames; // ALL channels the device has
        juce::StringArray outputChannelNames;
        juce::BigInteger activeInputChannels;
        juce::BigInteger activeOutputChannels;
        juce::Array<double> availableSampleRates;
        juce::Array<int> availableBufferSizes;
        juce::String lastError;
        int xruns = 0;
        double cpuLoad = 0.0;
    };

    explicit AudioIO(Engine& engine);
    ~AudioIO() override;

    /// Opens the default device of the default type. Returns an empty string on success, an error otherwise.
    juce::String openDefault(int numInputs, int numOutputs);
    /// Applies a full setup (type, devices, rate, buffer, channels). Returns an error string or empty.
    juce::String apply(const DeviceSetup& setup);
    void close();

    juce::StringArray deviceTypes();
    juce::StringArray inputDevices(const juce::String& deviceType);
    juce::StringArray outputDevices(const juce::String& deviceType);
    juce::String currentDeviceType() const;
    DeviceSetup currentSetup() const;
    DeviceInfo currentDevice() const;

    /// Called on the message thread whenever the device list or the open device changes (hot-plug, errors).
    std::function<void()> onDeviceChanged;

    juce::AudioDeviceManager& deviceManager() noexcept { return deviceManager_; }
    double cpuLoad() const { return deviceManager_.getCpuUsage(); }
    int xrunCount() const { return deviceManager_.getXRunCount(); }
    juce::String lastError() const { return lastError_; }

    /// Monotonic host time in ns shared by the audio callback and the MIDI threads (juce::Time hi-res ticks).
    static std::uint64_t hostTimeNowNs() noexcept;

  private:
    void audioDeviceIOCallbackWithContext(const float* const* inputChannelData, int numInputChannels,
                                          float* const* outputChannelData, int numOutputChannels, int numSamples,
                                          const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;
    void audioDeviceError(const juce::String& errorMessage) override;
    void changeListenerCallback(juce::ChangeBroadcaster*) override;
    void ensureCallback();

    Engine& engine_;
    juce::AudioDeviceManager deviceManager_;
    bool callbackAdded_ = false;
    juce::String lastError_;
};

} // namespace terminator
