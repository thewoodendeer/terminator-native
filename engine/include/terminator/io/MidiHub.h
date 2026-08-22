#pragma once
// MidiHub — opens MIDI inputs (CoreMIDI / WinMM / WinRT via JUCE) and pushes every message, stamped with the
// shared host clock, into the engine's per-port lock-free queues (consumed on the audio thread). Message
// thread owns enable/disable; the driver thread only does `queue.push`. Also keeps the latency-meter stat
// (driver timestamp → handler) and the last-message monitor for the UI.
#include <atomic>
#include <functional>
#include <memory>
#include <vector>

#include <juce_audio_devices/juce_audio_devices.h>

#include "terminator/core/Engine.h"

namespace terminator
{

class MidiHub : private juce::MidiInputCallback, private juce::Timer
{
  public:
    struct PortInfo
    {
        juce::String identifier;
        juce::String name;
        bool enabled = false;
        bool open = false;
    };

    explicit MidiHub(Engine& engine);
    ~MidiHub() override;

    std::vector<PortInfo> inputs() const; // every available input + whether we have it open
    juce::String enableInput(const juce::String& identifier, bool enabled); // returns error or empty
    void enableAllInputs();
    void refresh(); // re-scan devices; reopen enabled ones that re-appeared

    // stats (message thread)
    double lastInputLagMs() const noexcept { return lastLagMs_.load(std::memory_order_relaxed); }
    double medianInputLagMs() const;
    std::uint64_t messageCount() const noexcept { return messageCount_.load(std::memory_order_relaxed); }
    juce::String lastMessageDescription() const; // e.g. "Note On C3 vel 100 (port 0)"

    std::function<void()> onPortsChanged; // message thread

    static constexpr int kLagHistory = 48;

  private:
    void handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message) override;
    void timerCallback() override;

    struct OpenPort
    {
        juce::String identifier;
        juce::String name;
        std::unique_ptr<juce::MidiInput> input;
        int queueIndex = 0;
    };

    Engine& engine_;
    std::vector<OpenPort> open_;
    juce::StringArray enabledIds_;
    juce::StringArray lastSeenIds_;
    std::atomic<double> lastLagMs_{0.0};
    std::atomic<std::uint64_t> messageCount_{0};
    double lagHistory_[kLagHistory] = {};
    std::atomic<int> lagCount_{0};
    std::atomic<std::uint32_t> lastStatus_{0};
    std::atomic<std::uint32_t> lastData1_{0};
    std::atomic<std::uint32_t> lastData2_{0};
    std::atomic<int> lastPort_{-1};
};

} // namespace terminator
