#pragma once
// MIDI clock on the sample clock (Phase 3.5).
//
// OUT — `MidiClockOut`: Terminator as the master clock for outboard gear / a DAW. Generated INSIDE the audio
// callback from the transport (no look-ahead timers, no Worker pump — the Electron `midiClockOut.ts` booked ticks
// 150 ms ahead off a 25 ms tick): PLAY → Song Position + START stamped AT the anchor sample, then 24 ticks per
// quarter note from that anchor, the spacing re-read per tick from the session BPM (a tempo change lands at the
// next tick, continuous — never a double or a missing tick); STOP → STOP; pause → STOP, resume → Song Position (the
// tick count IS the song position: 1 MIDI beat = 6 ticks) + CONTINUE. Every event carries its exact engine sample;
// the Engine stamps it with host time (block entry + offset + the device's output latency = when that sample is
// HEARD) and hands it to the io/MidiHub pump thread, which sends it at that host time. A late block (the device
// glitched) makes the pump send the due ticks at once, bunched — the COUNT stays true (the TS "short stall" rule);
// the callback never stalls for seconds, so the TS "skip whole ticks after 1 s" rule has no native equivalent.
//
// IN — `MidiClockSourceLock` + `MidiClockFollower`: the Electron `midiClockIn.ts` ported 1:1 (same constants, same
// least-squares estimator, same hysteresis / jump / drop-out rules, same one-port lock), fed the DRIVER's
// timestamps (ms) on the MIDI thread instead of Web MIDI event times through Chromium. Pure — no allocation (fixed
// 48-tick window), no JUCE — so the io layer can run them on the CoreMIDI/WinMM thread and the tests can feed them
// straight from `MidiClockOut` (the loopback gate: OUT → IN reads the same BPM).
#include <cstdint>

#include "terminator/core/RtAssert.h"

namespace terminator
{

inline constexpr std::uint8_t kMidiClockByte = 0xF8;
inline constexpr std::uint8_t kMidiStartByte = 0xFA;
inline constexpr std::uint8_t kMidiContinueByte = 0xFB;
inline constexpr std::uint8_t kMidiStopByte = 0xFC;
inline constexpr std::uint8_t kMidiSppByte = 0xF2;
inline constexpr int kMidiClockPpqn = 24;     // ticks per quarter note
inline constexpr int kMidiTicksPerBeat16 = 6; // ticks per MIDI beat (a 16th) — the Song Position unit

/// Seconds per clock tick at `bpm` (TS `secondsPerTick`: BPM clamped 20..400, 0/NaN → 120).
double midiClockSecondsPerTick(double bpm) noexcept;

class MidiClockOut
{
  public:
    struct Event
    {
        std::uint64_t sample; // absolute engine sample the bytes belong to
        std::uint8_t data[3];
        std::uint8_t size;
    };
    static constexpr int kMaxEventsPerBlock = 128; // 400 BPM = 160 ticks/s; a 4096-sample block at 44.1 k = 15 ticks
    static constexpr int kMaxControl = 16;         // SPP/START/CONTINUE/STOP waiting for their sample

    void prepare(double sampleRate, bool keepState = false) noexcept;
    void reset() noexcept;

    // --- commands (audio thread, from Engine::apply) ---
    /// Preferences → MIDI → "MIDI Clock (send)". Turning it off while running sends STOP at `blockStart` and goes
    /// quiet; turning it on does not start ticks until the next PLAY (the TS semantics).
    void setEnabled(bool on, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING;
    void setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING; // applies at the next tick
    /// PLAY: Song Position 0 + START + the first tick at `anchorSample` (≥ blockStart; the transport's anchor), ticks
    /// from there. Running already = a RESTART: STOP at `blockStart` first (TS stop() → start()).
    void start(std::uint64_t anchorSample, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING;
    /// STOP at `atSample` (the block start); no tick at or after it.
    void stop(std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING;
    /// Transport pause: STOP, the tick count + the phase to the next tick are kept.
    void pause(std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING;
    /// Transport resume at `atSample`: Song Position (ticks/6) + CONTINUE, ticks go on from the kept phase.
    void resume(std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING;

    /// The events inside [blockStart, blockStart+numSamples), in time order (control bytes before a tick at the same
    /// sample: SPP, START, tick — the TS order). Returns the count written (≤ maxOut).
    int process(std::uint64_t blockStart, int numSamples, Event* out, int maxOut) noexcept TERMINATOR_NONBLOCKING;

    // --- read-back (audio thread) ---
    bool enabled() const noexcept { return enabled_; }
    bool running() const noexcept { return running_; }
    bool paused() const noexcept { return paused_; }
    double bpm() const noexcept { return bpm_; }
    std::uint64_t ticksSent() const noexcept { return ticksSent_; } // lifetime count
    std::uint64_t tickCount() const noexcept { return tickCount_; } // since the last START (= the song position × 6)
    std::uint64_t controlDropped() const noexcept { return controlDropped_; } // control ring refusals (should stay 0)

  private:
    struct Control
    {
        std::uint64_t sample;
        std::uint8_t data[3];
        std::uint8_t size;
        bool used;
    };
    void pushControl(std::uint64_t sample, std::uint8_t b0, std::uint8_t b1 = 0, std::uint8_t b2 = 0,
                     std::uint8_t size = 1) noexcept TERMINATOR_NONBLOCKING;
    int nextControlIndex() const noexcept TERMINATOR_NONBLOCKING; // the earliest waiting control event (−1 = none)
    double tickSamples() const noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    double bpm_ = 120.0;
    bool enabled_ = false;
    bool running_ = false; // between START and STOP (ticks flow once `started_`)
    bool started_ = false; // the START control fired (ticks may go out)
    bool paused_ = false;
    double nextTickSample_ = 0.0; // absolute engine sample of the next tick (double: fractional spacing)
    double phaseToNext_ = 0.0;    // while paused: samples from the pause point to the next tick
    std::uint64_t tickCount_ = 0;
    std::uint64_t ticksSent_ = 0;
    std::uint64_t controlDropped_ = 0;
    Control control_[kMaxControl] = {};
};

/// ONE PORT OWNS THE CLOCK (TS `MidiClockSourceLock`): an MPC sends START + clock on EVERY port it exposes, so the
/// same press arrived twice (24 ppqn read as 48, 89 BPM showed 177–178). The port that sends START/CONTINUE owns
/// the transport and the clock until its STOP; the same message from another port inside kDuplicateMs is the same
/// press seen twice and is ignored; ticks from any other port are dropped. Ports are small integers (the hub's
/// queue index); −1 = nobody.
class MidiClockSourceLock
{
  public:
    static constexpr double kDuplicateMs = 500.0;
    void reset() noexcept
    {
        owner_ = -1;
        startedAtMs_ = 0.0;
    }
    /// START / CONTINUE from `port` at `atMs`: act on it?
    bool onStart(int port, double atMs) noexcept
    {
        if (owner_ >= 0 && owner_ != port && atMs - startedAtMs_ < kDuplicateMs)
            return false; // the same press on another port
        owner_ = port;
        startedAtMs_ = atMs;
        return true;
    }
    /// A clock tick from `port`: count it? (Only the owner's ticks count.)
    bool onTick(int port) const noexcept { return owner_ < 0 || owner_ == port; }
    /// STOP from `port`: act on it? Any port may stop, and the lock clears so the next START can come from anywhere.
    bool onStop(int /*port*/) noexcept
    {
        reset();
        return true;
    }
    int ownerPort() const noexcept { return owner_; }

  private:
    int owner_ = -1;
    double startedAtMs_ = 0.0;
};

/// The tempo estimator (TS `MidiClockFollower`): feed tick receive times (ms — the driver's stamp), get back a BPM
/// when there is a settled NEW value — at most once per beat, never from fewer than a beat of ticks, reset on a
/// drop-out so a pause can't read as a crawl, rounded to 0.1 BPM with a little hysteresis so USB jitter does not
/// wobble the display. Returns 0 when there is nothing new to say.
class MidiClockFollower
{
  public:
    static constexpr int kWindowTicks = 48;      // two beats of history → ~0.1 % with ±1 ms jitter
    static constexpr int kMinTicks = 25;         // a full beat before the first estimate
    static constexpr double kDropoutMs = 1000.0; // a gap this long = the clock stopped; start over
    static constexpr double kHysteresisBpm = 0.3;

    void reset() noexcept
    {
        count_ = 0;
        sinceReport_ = 0;
        jumpRun_ = 0;
    }
    /// The BPM the clock has settled on, when it is NEW — else 0.
    double onTick(double atMs) noexcept;
    double current() const noexcept { return last_; }

  private:
    double times_[kWindowTicks] = {};
    int count_ = 0;
    double last_ = 0.0;
    int sinceReport_ = 0;
    int jumpRun_ = 0;
};

} // namespace terminator
