#pragma once
// MidiHub — opens MIDI inputs (CoreMIDI / WinMM / WinRT via JUCE) and pushes every message, stamped with the
// shared host clock, into the engine's per-port lock-free queues (consumed on the audio thread). Message
// thread owns enable/disable; the driver thread only does `queue.push`. Also keeps the latency-meter stat
// (driver timestamp → handler) and the last-message monitor for the UI.
//
// Phase 3.5 adds: MIDI OUTPUTS (per-port enable, the Preferences "MIDI Outputs" toggles — default ON) fed by a
// high-priority PUMP thread that drains `Engine::midiOut()` (the clock OUT the audio callback generated at exact
// samples, stamped with the host time each sample is heard) and sends every message to every open output AT its
// stamp (sleeps to ~1.5 ms before, spins the rest); MIDI CLOCK IN on the driver thread — `MidiClockSourceLock` (one
// port owns the clock) + `MidiClockFollower` fed the driver's timestamps, reporting a settled BPM to the message
// thread (≤ 1 per beat) while START/CONTINUE/STOP (the lock's verdict) and every other non-realtime message are
// mirrored to the page through `onMessage` (the page routes: pads / bass / drum pads / learn / transport).
#include <atomic>
#include <functional>
#include <memory>
#include <vector>

#include <juce_audio_devices/juce_audio_devices.h>

#include "terminator/core/Engine.h"
#include "terminator/core/MidiClock.h"

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

    // ── inputs ──
    std::vector<PortInfo> inputs() const; // every available input + whether we have it open
    juce::String enableInput(const juce::String& identifier, bool enabled); // returns error or empty
    void enableAllInputs();
    void refresh(); // re-scan devices (in + out); reopen enabled ones that re-appeared

    // ── outputs (3.5) ──
    std::vector<PortInfo> outputs() const; // every available output; enabled = not turned off, open = we hold it
    juce::String enableOutput(const juce::String& identifier, bool enabled);
    /// The Preferences map {identifier: bool}: an output missing from it is ON (the TS default — every connected
    /// output unless its toggle was turned off). Opens / closes accordingly.
    void applyOutputPrefs(const juce::var& map);
    int openOutputCount() const;

    // ── stats (message thread) ──
    double lastInputLagMs() const noexcept { return lastLagMs_.load(std::memory_order_relaxed); }
    double medianInputLagMs() const;
    std::uint64_t messageCount() const noexcept { return messageCount_.load(std::memory_order_relaxed); }
    juce::String lastMessageDescription() const; // e.g. "Note On C3 vel 100 (port 0)"
    std::uint64_t sentCount() const noexcept { return sentCount_.load(std::memory_order_relaxed); } // pump sends
    /// How late the pump's last send was against its stamp (ms; negative never — it waits). Diagnostic.
    double lastSendLatenessMs() const noexcept { return lastLateMs_.load(std::memory_order_relaxed); }
    double maxSendLatenessMs() const noexcept { return maxLateMs_.load(std::memory_order_relaxed); }
    // clock IN
    double clockInBpm() const noexcept { return clockInBpm_.load(std::memory_order_relaxed); }    // 0 = none yet
    int clockInOwnerPort() const noexcept { return clockOwner_.load(std::memory_order_relaxed); } // −1 = nobody
    bool clockInStarted() const noexcept
    {
        return clockStarted_.load(std::memory_order_relaxed);
    } // START seen, no STOP

    std::function<void()> onPortsChanged; // message thread
    /// Every message a device sent — notes, CCs, pitch bend, aftertouch, program, and the transport bytes the clock
    /// lock accepted (START/CONTINUE/STOP) — mirrored to the message thread AFTER the engine already got it on the
    /// driver thread (clock ticks + active sensing are not mirrored: the follower eats the ticks). The page runs
    /// its one MIDI router on it (the native app's page has no Web MIDI). `portName` = the input's name.
    std::function<void(const MidiEvent& e, const juce::String& portName)> onMessage; // message thread
    /// The clock-IN follower settled on a NEW tempo from the owning port (≤ once per beat). Message thread.
    std::function<void(double bpm, int port)> onClockBpm;
    /// Feed a note as if it arrived on port 0 (tests / the probe): the engine queue + onMessage, exactly like a device.
    void injectNote(int note, int velocity, bool on, int channel = 1);
    /// Feed raw bytes (1..3) as if they arrived on port 0 — transport bytes / CCs / clock ticks for the probe.
    void inject(const std::uint8_t* data, int size);

    static constexpr int kLagHistory = 48;

  private:
    void handleIncomingMidiMessage(juce::MidiInput* source, const juce::MidiMessage& message) override;
    void timerCallback() override;
    /// The one dispatch for a device message and an injected one (driver thread / message thread).
    void dispatch(int port, const juce::MidiMessage& message, std::uint64_t hostNs, double lagSec);
    void mirror(const MidiEvent& e, int port);
    juce::String openOutput(const juce::String& identifier);
    void closeOutput(const juce::String& identifier);

    struct OpenPort
    {
        juce::String identifier;
        juce::String name;
        std::unique_ptr<juce::MidiInput> input;
        int queueIndex = 0;
    };
    struct OutPort
    {
        juce::String identifier;
        juce::String name;
        std::unique_ptr<juce::MidiOutput> output;
    };
    /// Drains Engine::midiOut() and sends each message at its host-time stamp to every open output.
    class Pump final : public juce::Thread
    {
      public:
        explicit Pump(MidiHub& hub) : juce::Thread("Terminator MIDI out"), hub_(hub) {}
        void run() override;

      private:
        MidiHub& hub_;
    };
    void send(const MidiOutEvent& e); // pump thread

    Engine& engine_;
    std::vector<OpenPort> open_;
    juce::StringArray enabledIds_;
    juce::StringArray lastSeenIds_;
    juce::StringArray lastSeenOutIds_;
    // outputs: the OFF set (everything else is on) + the open ports, read by the pump under the lock
    juce::StringArray outDisabledIds_;
    std::vector<OutPort> outOpen_;
    mutable juce::CriticalSection outLock_;
    Pump pump_;
    std::atomic<std::uint64_t> sentCount_{0};
    std::atomic<double> lastLateMs_{0.0};
    std::atomic<double> maxLateMs_{0.0};
    // clock in (driver thread state; atomics mirror it for the UI)
    MidiClockSourceLock clockLock_;
    MidiClockFollower clockFollow_;
    std::atomic<double> clockInBpm_{0.0};
    std::atomic<int> clockOwner_{-1};
    std::atomic<bool> clockStarted_{false};
    // stats
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
