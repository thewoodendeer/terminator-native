#pragma once
// The engine. One instance per app/render. Lifecycle: prepare() [non-RT] → process() × N [RT] → release()
// [non-RT]. UI talks to it only through commands() (lock-free queue) and reads back only through
// snapshot(). Phase 1: pad sampler (voices, varispeed, envelopes, choke, per-pad output pair), test tone,
// master gain, transport counter, host-clock mapping, MIDI note map, loopback calibration.
#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

#include "terminator/core/Arp.h"
#include "terminator/core/BassSequencer.h"
#include "terminator/core/BassSynth.h"
#include "terminator/core/ChopSequencer.h"
#include "terminator/core/Command.h"
#include "terminator/core/DrumSequencer.h"
#include "terminator/core/CommandQueue.h"
#include "terminator/core/HostClock.h"
#include "terminator/core/Metronome.h"
#include "terminator/core/MidiClock.h"
#include "terminator/core/Mixer.h"
#include "terminator/core/fx/FxPool.h"
#include "terminator/core/RtAssert.h"
#include "terminator/core/Sampler.h"
#include "terminator/core/StateSnapshot.h"
#include "terminator/io/Recorder.h"

namespace terminator
{

/// A timestamped raw MIDI message from a driver thread (see io/MidiHub). Consumed on the audio thread.
struct MidiEvent
{
    std::uint64_t hostTimeNs = 0;
    std::uint8_t data[3] = {0, 0, 0};
    std::uint8_t size = 0;
    std::uint8_t port = 0;
};
static_assert(std::is_trivially_copyable_v<MidiEvent>);

/// A MIDI message the ENGINE sends (Phase 3.5: the clock OUT — SPP/START/CONTINUE/STOP/ticks), produced on the
/// audio thread at its exact engine sample, stamped with the host time that sample is HEARD (block entry + offset +
/// the device's output latency). Consumed by io/MidiHub's pump thread, which sends it at that host time (0 = send
/// at once: no host clock — tests / offline).
struct MidiOutEvent
{
    std::uint64_t hostTimeNs = 0;
    std::uint64_t sample = 0;
    std::uint8_t data[3] = {0, 0, 0};
    std::uint8_t size = 0;
};
static_assert(std::is_trivially_copyable_v<MidiOutEvent>);

class Engine
{
  public:
    struct Config
    {
        double sampleRate = 48000.0;
        int maxBlockSize = 512;
        int numOutputChannels = 2;
        int numInputChannels = 0;
        int outputLatencySamples = 0; // the device's reported output latency — MIDI OUT stamps "heard at" with it
    };

    static constexpr std::size_t kCommandQueueCapacity = 1024;
    static constexpr std::size_t kMidiQueueCapacity = 1024;
    static constexpr std::size_t kMidiOutQueueCapacity = 1024;
    static constexpr int kMaxMidiPorts = 16;
    static constexpr int kMaxPendingTriggers = 64; // live hits booked past the current block (quantized live record)
    static constexpr std::uint32_t kCalibrationMaxFrames = 2 * 192000; // 2 s at 192 kHz
    static constexpr int kCalibrationClickFrames = 64;

    using Commands = SpscQueue<Command, kCommandQueueCapacity>;
    using MidiQueue = SpscQueue<MidiEvent, kMidiQueueCapacity>;
    using MidiOutQueue = SpscQueue<MidiOutEvent, kMidiOutQueueCapacity>;

    Engine();
    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    // --- non-RT --------------------------------------------------------------------------------
    /// Non-RT. The FIRST call sizes and clears everything. A LATER call is a device change: at the same sample rate
    /// it re-sizes for the new block and keeps the music (transport, patterns, voices, insert chains); a different
    /// sample rate resets, because positions and coefficients are rate-bound.
    void prepare(const Config& config);
    /// Non-RT. The audio device stopped: stop pulling audio, keep the music (prepare() decides what survives).
    void release();
    bool isPrepared() const noexcept { return prepared_; }
    const Config& config() const noexcept { return config_; }

    /// Producer side of the command queue — message thread only.
    Commands& commands() noexcept { return *commands_; }
    /// One MIDI input queue per port (producer = that port's driver thread).
    MidiQueue& midiQueue(int port) noexcept
    {
        const int clamped = port < 0 ? 0 : (port >= kMaxMidiPorts ? kMaxMidiPorts - 1 : port);
        return midiQueues_[static_cast<std::size_t>(clamped)];
    }

    /// MIDI the engine SENDS (the clock OUT, Phase 3.5) — consumer = io/MidiHub's pump thread (any one non-RT thread).
    MidiOutQueue& midiOut() noexcept { return *midiOut_; }

    /// Latest engine state — message thread only.
    const StateSnapshot& snapshot() noexcept { return snapshot_.read(); }

    /// Calibration capture buffer: readable on the message thread once snapshot().calibrationState == 2.
    const float* calibrationCapture() const noexcept { return calibCapture_.data(); }
    std::uint32_t calibrationCaptureFrames() const noexcept { return calibRecorded_; }
    /// The click that was emitted (kCalibrationClickFrames long), for cross-correlation.
    static const float* calibrationClick() noexcept;

    /// Pad read-back for the UI (message thread; pads only change via commands so this is stable enough to read).
    const Pad& pad(int i) const noexcept { return sampler_.pad(i); }
    /// The bass synth (tests render it directly; the app only talks to it through commands).
    BassSynth& bassSynth() noexcept { return bass_; }
    /// The mixer's read-back (settings / meters / masks) — tests; the app reads the snapshot.
    const Mixer& mixer() const noexcept { return *mixer_; }

    // --- RT ------------------------------------------------------------------------------------
    // --- RECORDING (5.1a message thread; 5.1c the arm) ------------------------------------------
    /// When an armed take actually begins. The file is opened by `startRecord` either way — opening it is the slow
    /// part, and a take that has to wait for its sample cannot afford to do it then.
    enum class RecordStart : std::uint8_t
    {
        immediate = 0,       // the next block, as 5.1a did
        atSample = 1,        // an exact engine sample (the page knows the grid)
        countInDownbeat = 2, // the downbeat a pending count-in is counting to — the take lands ON the grid
        transportStart = 3   // the next time the transport starts rolling (its anchor sample, not the block's)
    };
    /// What the take is made OF.
    enum class RecordSource : std::uint8_t
    {
        inputs = 0, // the interface's own inputs (5.1a)
        master = 1  // Terminator's own output, post master gain, pre-click (5.1d: the RESAMPLE take)
    };
    struct RecordArm
    {
        RecordStart mode = RecordStart::immediate;
        RecordSource source = RecordSource::inputs;
        std::uint64_t atSample = 0;      // mode == atSample
        std::uint64_t lengthSamples = 0; // 0 = until stopRecord(); else punch out after exactly this many frames
        /// The round trip (output latency + input latency + the measured driver error). A performance meant for
        /// musical time M reaches the input stream that many samples later, so an INPUT take starts that much after
        /// its musical target and frame 0 is the sound that belongs there. Ignored for a master take (nothing has
        /// left the machine).
        std::uint64_t latencyCompensationSamples = 0;
    };
    /// Start a take from the interface's inputs. The audio callback hands every block to it until `stopRecord()`.
    /// With an arm, the audio thread waits for the take's sample and captures from EXACTLY there.
    bool startRecord(const RecorderConfig& cfg, juce::String& error, const RecordArm& arm);
    /// … starting at once, as 5.1a did.
    bool startRecord(const RecorderConfig& cfg, juce::String& error);
    /// Stop and close the file; returns the frames written.
    std::uint64_t stopRecord();
    const Recorder& recorder() const noexcept { return recorder_; }
    /// Armed, waiting for its sample (the count-in, the transport, a booked position) — nothing captured yet.
    bool recordArmed() const noexcept
    {
        return recorder_.recording() && recRolling_.load(std::memory_order_acquire) == 0;
    }
    /// The engine sample the take began at (0 = it has not begun).
    std::uint64_t recordStartSample() const noexcept { return recStarted_.load(std::memory_order_acquire); }
    /// The TRANSPORT position at that sample — where in the song the take belongs.
    std::uint64_t recordStartPlayhead() const noexcept { return recPlayhead_.load(std::memory_order_acquire); }
    /// A punch-out length has elapsed: the audio thread has stopped capturing and the file wants closing
    /// (the message thread calls `stopRecord()`).
    bool recordComplete() const noexcept { return recComplete_.load(std::memory_order_acquire) != 0; }

    // --- INSTRUMENTS (6.3) ----------------------------------------------------------------------
    // A hosted plugin INSTRUMENT is a SOURCE, like the bass synth: notes go in, audio comes out into a mixer strip.
    // The app owns the instance (PluginRack) and hands the pointer over `Command::setInstrument`; the same lifetime
    // rule as an insert applies — detach, let blocks run, then delete.
    /// The instrument's strip and whether one is attached (message thread read-back / tests).
    int instrumentStrip() const noexcept { return instrumentStrip_; }
    const ExternalProcessor* instrument() const noexcept { return instrument_.load(std::memory_order_acquire); }

    // --- MONITORING (5.1c, message thread → the audio thread over a command) ---------------------
    // `Command::setMonitor` — hear the interface's inputs through the engine while you set a level. It costs no
    // latency beyond the driver's own round trip: the block that arrives is added to the block that leaves.

    /// Renders numSamples into outputs[0..numOut). Always overwrites. inputs may be null / numIn 0. Safe to call
    /// before prepare() (renders silence). hostTimeNs = host time at callback entry (0 = unknown).
    void process(const float* const* inputs, int numIn, float* const* outputs, int numOut, int numSamples,
                 std::uint64_t hostTimeNs) noexcept TERMINATOR_NONBLOCKING;
    /// Output-only convenience (offline renders, tests).
    void process(float* const* outputs, int numChannels, int numSamples) noexcept TERMINATOR_NONBLOCKING
    {
        process(nullptr, 0, outputs, numChannels, numSamples, 0);
    }

  private:
    void drainCommands(int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void drainMidi(int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void apply(const Command& c, int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void setTestToneFrequency(float hz) noexcept TERMINATOR_NONBLOCKING;
    std::int32_t offsetForHostTime(std::uint64_t hostTimeNs, int numSamples) const noexcept TERMINATOR_NONBLOCKING;
    void publish(int numSamples) noexcept TERMINATOR_NONBLOCKING;
    void firePendingTriggers(int numSamples) noexcept TERMINATOR_NONBLOCKING;
    /// What a booked event does when its sample arrives.
    enum class BookKind : std::uint8_t
    {
        trigger = 0,
        release,
        chokeSubHits, // fade the pad's SUB-HIT voices (a roll's self-choke)
        stop          // the pad's own choke fade on every voice
    };
    void bookTrigger(std::uint16_t pad, float velocity, std::uint64_t atSample, bool release, int numSamples,
                     bool hasPan = false, float pan = 0.0f, bool subHit = false,
                     BookKind kind = BookKind::trigger) noexcept TERMINATOR_NONBLOCKING;
    /// Fire one booked event at `offsetInBlock` (shared by bookTrigger's in-block path and firePendingTriggers).
    void fireBooked(BookKind kind, std::uint16_t pad, float velocity, bool hasPan, float pan, bool subHit,
                    std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING;
    void noteLiveHit(std::uint16_t pad, double atSample) noexcept TERMINATOR_NONBLOCKING
    {
        if (pad < kMaxPads)
        {
            liveHitSample_[pad] = atSample;
            lastLiveHitPad_ = pad;
            lastLiveHitSample_ = atSample > 0.0 ? static_cast<std::uint64_t>(atSample) : 0;
        }
    }

    Config config_{};
    bool prepared_ = false;
    bool everPrepared_ = false; // a later prepare() is a DEVICE CHANGE, not a fresh engine (see prepare())

    // The big fixed buffers live on the heap (allocated ONCE in the constructor — non-RT) so an Engine value is
    // small enough for any stack (Windows threads default to 1 MB; the capture buffer alone is 1.5 MB).
    std::unique_ptr<Commands> commands_;
    std::vector<MidiQueue> midiQueues_;
    std::unique_ptr<MidiOutQueue> midiOut_;
    SnapshotPublisher<StateSnapshot> snapshot_;
    Sampler sampler_;
    ChopSequencer seq_;     // the chop sequencer on the sample clock (Phase 3.1)
    DrumSequencer drums_;   // the drum sequencer on the same clock (Phase 3.3) — lanes = pads kDrumPadBase..
    BassSynth bass_;        // the bass synth (Phase 3.4) — dry into outs 1/2 until Phase 4 routes it to its strip
    BassSequencer bassSeq_; // its pattern player on the same clock
    MidiClockOut clockOut_; // MIDI clock OUT from the transport (Phase 3.5) — anchored with seqPlay / drumPlay
    MidiClockOut::Event clockEvents_[MidiClockOut::kMaxEventsPerBlock] = {};
    Metronome metro_; // the click + count-in (Phase 3.6) — beats on the driving sequencer's grid
    Arp arp_;         // the arp (Phase 3.6) — steps on the sample clock
    std::unique_ptr<Mixer>
        mixer_; // the strips / sends / buses / master (Phase 4.1) — pads, drum lanes, the bass and the click
                // (on the heap: 64 strips of meter rings are 177 KB — an Engine VALUE must fit a 1 MB Windows stack)
                // with a strip sum into it in 64-bit; the direct paths (strip −1) stay as in Phase 3
    FxPool fxPool_; // every insert device the chains can hold, built + prepared up front (Phase 4.2)
    std::vector<float> scratchL_, scratchR_; // a source's block on its way into a strip (prepare-sized)
    int bassStrip_ = -1;                     // setSourceStrip 0: the bass synth's strip (−1 = dry into outs 1/2)
    int clickStrip_ = -1;                    // setSourceStrip 1: the metronome's strip (−1 = direct, post master gain)
    GridStep gridLog_[kMaxGridLog] = {};
    bool midiNotesToPads_ = true; // setMidiRouting: MIDI notes play pads on the direct path (off while the page
                                  // routes notes elsewhere — bass MIDI IN, DRUM PADS mode, MIDI OFF, learn)

    // RT state (owned by the audio thread after prepare)
    float masterGainTarget_ = 1.0f;
    float masterGainCurrent_ = 1.0f;
    bool playing_ = false;
    bool seqWasPlaying_ = false;
    bool drumsWasPlaying_ = false;
    std::uint64_t playheadSamples_ = 0;
    std::uint64_t blocksProcessed_ = 0;
    std::uint64_t samplesProcessed_ = 0;
    std::uint64_t commandsApplied_ = 0;
    std::uint64_t blockHostNs_ = 0;     // entry time of the CURRENT block
    std::uint64_t prevBlockHostNs_ = 0; // entry time of the previous block (MIDI offsets are relative to it)
    float outputPeak_[kMaxOutputChannels] = {};
    float inputPeak_[kMaxInputChannels] = {};
    /// RECORDING (5.1a): the take, if one is running. Owned here because the audio callback has to reach it, but
    /// started and stopped from the message thread — `push()` is the only thing the audio thread calls.
    Recorder recorder_;
    // THE ARM (5.1c). Written by the message thread before the recorder is started, then owned by the audio thread;
    // atomics because both read them (a take is armed on one thread and starts on the other).
    std::atomic<std::uint8_t> recArmMode_{0};       // RecordStart
    std::atomic<std::uint8_t> recSource_{0};        // RecordSource
    std::atomic<std::uint64_t> recCompensation_{0}; // the round trip added to a resolved INPUT start
    std::atomic<std::uint64_t> recArmSample_{0};    // the sample capture starts at (0 = not resolved yet)
    std::atomic<std::uint64_t> recLength_{0};       // punch-out length in frames (0 = none)
    std::atomic<std::uint64_t> recStarted_{0};      // the sample capture began at (0 = not yet)
    std::atomic<std::uint64_t> recPlayhead_{0};     // the transport position at that sample
    std::atomic<std::uint8_t> recRolling_{0};       // capture is live (the arm resolved)
    std::atomic<std::uint8_t> recComplete_{0};      // the punch-out fired: the file is finished, close it
    void pushRecordWindow(const float* const* inputs, int numIn, int numSamples) noexcept TERMINATOR_NONBLOCKING;
    const float* recTap_[2] = {nullptr, nullptr}; // a MASTER take's two channels (pointers into the output buffers)
    /// A transport start was applied at `atSample`: a take armed to the transport begins exactly there.
    void noteTransportStart(std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING
    {
        if (recArmMode_.load(std::memory_order_relaxed) == static_cast<std::uint8_t>(RecordStart::transportStart) &&
            recRolling_.load(std::memory_order_relaxed) == 0 && recorder_.recording() &&
            recArmSample_.load(std::memory_order_relaxed) == 0)
            recArmSample_.store(atSample > samplesProcessed_ ? atSample : samplesProcessed_, std::memory_order_release);
    }

    // INSTRUMENTS (6.3): one hosted instrument, rendered into its strip like the bass synth. Notes arrive from MIDI
    // (when the page routes them here) and from `Command::instrumentNote`; they are collected per block, in order.
    std::atomic<ExternalProcessor*> instrument_{nullptr};
    int instrumentStrip_ = -1;      // −1 = dry into outs 1/2
    bool midiToInstrument_ = false; // MIDI notes play the instrument (the page's routing choice)
    static constexpr int kMaxInstrumentNotes = 64;
    ExternalNote instrumentNotes_[kMaxInstrumentNotes] = {};
    int instrumentNoteCount_ = 0;
    float* instChans_[2] = {nullptr, nullptr};
    void addInstrumentNote(std::uint8_t note, std::uint8_t velocity, bool on, std::int32_t offset,
                           int numSamples) noexcept TERMINATOR_NONBLOCKING
    {
        if (instrumentNoteCount_ >= kMaxInstrumentNotes || instrument_.load(std::memory_order_relaxed) == nullptr)
            return;
        auto& n = instrumentNotes_[instrumentNoteCount_++];
        n.offset = static_cast<std::uint32_t>(std::clamp<std::int32_t>(offset, 0, numSamples > 0 ? numSamples - 1 : 0));
        n.note = note;
        n.velocity = velocity;
        n.on = on ? 1 : 0;
        n.channel = 1;
    }

    // MONITORING (5.1c): the interface's inputs through the engine, so you can hear what you are about to record.
    bool monitorEnabled_ = false;
    std::int16_t monitorCh_[2] = {0, 1}; // hardware inputs (−1 = none; one channel feeds both sides, centred)
    int monitorStrip_ = -1;              // a mixer strip (its fader/inserts/console apply) — −1 = straight to outs 1/2
    float monitorGainTarget_ = 1.0f;
    float monitorGainCurrent_ = 0.0f; // ramped over the block: a monitor that clicks on every level move is useless

    // the last LIVE trigger (a command / a booked hit / a MIDI note on the direct path): pad + its engine sample — the
    // page's live-record probe compares it to the landed grid line (3.7)
    std::int32_t lastLiveHitPad_ = -1;
    std::uint64_t lastLiveHitSample_ = 0;
    // MIDI note → pad
    std::int16_t noteToPad_[128];
    // when each pad was last LIVE triggered (command / MIDI — not the sequencer), engine samples; feeds the chop
    // sequencer's one-owner-per-hit rule. A large negative value = never.
    double liveHitSample_[kMaxPads];
    /// triggerPadAtSample / releasePadAtSample aimed past the current block wait here (sample-exact, any lead).
    struct PendingTrigger
    {
        std::uint64_t sample;
        float velocity;
        float pan;
        std::uint16_t pad;
        bool release;
        bool hasPan;
        bool used;
        bool subHit = false;
        BookKind kind = BookKind::trigger;
    };
    PendingTrigger pendingTrig_[kMaxPendingTriggers] = {};

    // test tone — complex phasor rotation (no libm per sample)
    bool toneEnabled_ = false;
    float toneFrequencyHz_ = 440.0f;
    float toneAmplitude_ = 0.5f;
    std::uint8_t toneOutputPair_ = 0;
    double toneCos_ = 1.0, toneSin_ = 0.0;
    double toneRe_ = 1.0, toneIm_ = 0.0;

    // calibration
    std::uint32_t calibState_ = 0; // 0 idle 1 running 2 done 3 failed
    std::uint32_t calibId_ = 0;
    std::uint16_t calibOut_ = 0, calibIn_ = 0;
    std::uint32_t calibTarget_ = 0;   // frames to record
    std::uint32_t calibRecorded_ = 0; // frames recorded so far
    std::uint32_t calibClickPos_ = 0; // frames of the click emitted so far
    std::vector<float> calibCapture_; // kCalibrationMaxFrames, allocated in the constructor
};

} // namespace terminator
