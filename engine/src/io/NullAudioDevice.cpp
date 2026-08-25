#include "terminator/io/NullAudioDevice.h"

namespace terminator
{
namespace
{
constexpr double kRate = 48000.0;
constexpr int kBlock = 512;
constexpr int kChannels = 2;

/// The device itself: a thread that calls the callback with silence, paced to the wall clock.
class NullAudioDevice final : public juce::AudioIODevice, private juce::Thread
{
  public:
    NullAudioDevice()
        : juce::AudioIODevice(NullAudioDeviceType::kDeviceName, NullAudioDeviceType::kTypeName),
          juce::Thread("terminator offline audio")
    {
    }

    ~NullAudioDevice() override { close(); }

    juce::StringArray getOutputChannelNames() override { return {"Out 1", "Out 2"}; }
    juce::StringArray getInputChannelNames() override { return {"In 1", "In 2"}; }
    juce::Array<double> getAvailableSampleRates() override { return {44100.0, 48000.0, 88200.0, 96000.0}; }
    juce::Array<int> getAvailableBufferSizes() override { return {64, 128, 256, 512, 1024}; }
    int getDefaultBufferSize() override { return kBlock; }

    juce::String open(const juce::BigInteger& inputs, const juce::BigInteger& outputs, double sampleRate,
                      int bufferSize) override
    {
        rate_ = sampleRate > 0.0 ? sampleRate : kRate;
        block_ = bufferSize > 0 ? bufferSize : kBlock;
        activeIn_ = inputs;
        activeOut_ = outputs;
        if (activeOut_.isZero())
            activeOut_.setRange(0, kChannels, true);
        // The manager checks the callback's channel COUNTS against these masks (CallbackMaxSizeEnforcer), so
        // what the run loop passes has to be exactly what the masks say — including zero inputs.
        numIn_ = juce::jlimit(0, kChannels, activeIn_.countNumberOfSetBits());
        numOut_ = juce::jlimit(1, kChannels, activeOut_.countNumberOfSetBits());
        in_.setSize(kChannels, block_);
        out_.setSize(kChannels, block_);
        in_.clear();
        open_ = true;
        return {};
    }

    void close() override
    {
        stop();
        open_ = false;
    }

    bool isOpen() override { return open_; }
    bool isPlaying() override { return playing_.load(); }
    juce::String getLastError() override { return {}; }

    void start(juce::AudioIODeviceCallback* newCallback) override
    {
        if (!open_)
            return;
        stop();
        callback_ = newCallback;
        if (callback_ != nullptr)
            callback_->audioDeviceAboutToStart(this);
        playing_ = true;
        startThread(juce::Thread::Priority::highest);
    }

    void stop() override
    {
        playing_ = false;
        stopThread(2000);
        if (auto* cb = callback_)
        {
            callback_ = nullptr;
            cb->audioDeviceStopped();
        }
    }

    int getCurrentBufferSizeSamples() override { return block_; }
    double getCurrentSampleRate() override { return rate_; }
    int getCurrentBitDepth() override { return 32; }
    juce::BigInteger getActiveOutputChannels() const override { return activeOut_; }
    juce::BigInteger getActiveInputChannels() const override { return activeIn_; }
    int getOutputLatencyInSamples() override { return 0; }
    int getInputLatencyInSamples() override { return 0; }
    int getXRunCount() const noexcept override { return 0; }

  private:
    void run() override
    {
        const auto blockNs = static_cast<double>(block_) * 1.0e9 / rate_;
        auto nextNs = static_cast<double>(juce::Time::getHighResolutionTicks()) *
                      (1.0e9 / static_cast<double>(juce::Time::getHighResolutionTicksPerSecond()));
        const float* inPtrs[kChannels] = {in_.getReadPointer(0), in_.getReadPointer(1)};
        float* outPtrs[kChannels] = {out_.getWritePointer(0), out_.getWritePointer(1)};
        while (!threadShouldExit() && playing_.load())
        {
            if (auto* cb = callback_)
            {
                juce::AudioIODeviceCallbackContext ctx;
                cb->audioDeviceIOCallbackWithContext(inPtrs, numIn_, outPtrs, numOut_, block_, ctx);
            }
            nextNs += blockNs;
            const auto nowNs = static_cast<double>(juce::Time::getHighResolutionTicks()) *
                               (1.0e9 / static_cast<double>(juce::Time::getHighResolutionTicksPerSecond()));
            const auto waitMs = static_cast<int>((nextNs - nowNs) / 1.0e6);
            if (waitMs > 0)
                wait(waitMs);
            else if (nextNs < nowNs - blockNs * 8.0)
                nextNs = nowNs; // fell far behind (a stalled runner) — re-anchor instead of sprinting to catch up
        }
    }

    juce::AudioIODeviceCallback* callback_ = nullptr;
    std::atomic<bool> playing_{false};
    bool open_ = false;
    double rate_ = kRate;
    int block_ = kBlock;
    juce::BigInteger activeIn_, activeOut_;
    int numIn_ = 0, numOut_ = kChannels;
    juce::AudioBuffer<float> in_, out_;
};
} // namespace

NullAudioDeviceType::NullAudioDeviceType() : juce::AudioIODeviceType(kTypeName) {}

juce::StringArray NullAudioDeviceType::getDeviceNames(bool) const
{
    return {kDeviceName};
}

int NullAudioDeviceType::getDefaultDeviceIndex(bool) const
{
    return 0;
}

int NullAudioDeviceType::getIndexOfDevice(juce::AudioIODevice* device, bool) const
{
    return device != nullptr && device->getName() == kDeviceName ? 0 : -1;
}

juce::AudioIODevice* NullAudioDeviceType::createDevice(const juce::String& outputDeviceName,
                                                       const juce::String& inputDeviceName)
{
    if (outputDeviceName != kDeviceName && inputDeviceName != kDeviceName)
        return nullptr;
    return new NullAudioDevice();
}

NullAudioMode nullAudioMode()
{
    // `std::getenv` is a build error under MSVC here (/WX) — the whole repo reads the environment through JUCE.
    const auto v = juce::SystemStats::getEnvironmentVariable("TERMINATOR_NULL_AUDIO", {}).trim().toLowerCase();
    if (v == "1" || v == "true" || v == "forced")
        return NullAudioMode::forced;
    if (v == "auto")
        return NullAudioMode::autoFallback;
    return NullAudioMode::off;
}

} // namespace terminator
