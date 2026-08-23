#pragma once
// Metronome + count-in on the sample clock (Phase 3.6). The Electron metronome (ChopperEngine
// `metronomeSchedulerTick` / `scheduleMetronomeClick` / `scheduleCountIn`) ran a 25 ms Worker tick booking Web Audio
// clicks 0.25 s ahead straight into `ctx.destination`; here the clicks are SYNTHESISED inside the audio callback at
// their exact sample and — the change that matters — placed on the DRIVING SEQUENCER'S OWN GRID:
//   • while the chop sequencer plays, every step it schedules (`ChopSequencer::takeGridLog`) tells the metronome
//     "step k starts at sample s and lasts d"; the beats inside that step fall at s + (b − k·4/res)·(res/4)·d — so a
//     tempo change (applied by the sequencer at its next step) can never put the click off the pattern, at any
//     resolution (a beat between two triplet steps is interpolated with the step's own duration);
//   • when only the drum machine plays, its 96-steps/bar grid drives the beats the same way;
//   • paused / stopped → no clicks (the TS gate: "clicks only while seqPlaying && !seqPaused, or the drum-only
//     take"), a pending beat click is dropped on pause/stop; METRO toggled ON mid-play → the first click is the next
//     beat (the TS phase-lock), toggled OFF → pending beat clicks dropped;
//   • the accent (the TS `beat === 0`) is beat 0 of the bar — patterns are whole bars, so (beat index mod 4);
//   • COUNT-IN: `countIn(beats, atSample)` books `beats` clicks at atSample + i·(60/bpm) (the first accented — the
//     TS `scheduleCountIn`), publishes the countdown (`countInBeat` N..1 then −1) and the DOWNBEAT sample the page
//     starts the transport at; the regular train is silent until that downbeat (the TS "ITS clicks are the count");
//     `cancelCountIn()` = the TS cancelCountIn.
// The five sounds are the Web Audio graphs ported per sample (OscillatorNode sine phase from 0, the exponential
// ramps' v0·(v1/v0)^t law, BiquadFilterNode highpass (Q in dB) / bandpass (Q linear) per the Web Audio spec, the
// 0.2 s white-noise buffer read from 0 each click — seeded here so a render is deterministic). The clicks bypass the
// master gain like the TS clicks bypassed the mixer (`Engine::process` adds them after the gain ramp); Phase 4 routes
// them to the mixer's CLICK bus. Pure C++20, no JUCE, no allocation after prepare() (RT-RULES.md).
#include <cstdint>

#include "terminator/core/RtAssert.h"

namespace terminator
{

enum class ClickSound : std::uint8_t
{
    click = 0,
    hihat = 1,
    rimshot = 2,
    kick = 3,
    clap = 4,
};

/// One step a sequencer scheduled: its STRAIGHT grid time, its duration (at the tempo it was scheduled with), its
/// index in the pattern and the pattern's steps per bar. The metronome places the beats inside it.
struct GridStep
{
    double sample; // absolute engine sample of the step's grid time
    double dur;    // samples
    int index;     // 0..stepCount−1
    int stepsPerBar;
};
inline constexpr int kMaxGridLog = 256; // steps a sequencer can log per block (drums: ≤ 110 ms ahead at 96/bar)

class Metronome
{
  public:
    static constexpr int kMaxPending = 64;        // clicks waiting for their sample (beats booked ahead + a count-in)
    static constexpr int kMaxElements = 24;       // sounding click elements (a clap is 3, a rimshot 2; ≤ 350 ms each)
    static constexpr double kNoiseSec = 0.2;      // the TS noiseBuffer length
    static constexpr int kMaxNoiseFrames = 38400; // 0.2 s at 192 kHz
    static constexpr double kDedupeSec = 0.001;   // two beat clicks within 1 ms = the same beat (driver hand-over)

    void prepare(double sampleRate, bool keepState = false) noexcept; // allocates nothing at run time
    void reset() noexcept;

    // --- commands (audio thread, from Engine::apply) ---
    void setEnabled(bool on) noexcept TERMINATOR_NONBLOCKING; // METRO: off drops the pending beat clicks
    void setSound(ClickSound s) noexcept TERMINATOR_NONBLOCKING;
    void setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING; // the count-in beat length (the session BPM)
    /// Book `beats` count-in clicks from `atSample` (≥ blockStart; 0 = the block start); the downbeat follows the
    /// last one by a beat. Replaces a pending count-in.
    void countIn(int beats, std::uint64_t atSample, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING;
    void cancelCountIn() noexcept TERMINATOR_NONBLOCKING;
    /// The driving sequencer scheduled a step: book the beat clicks inside it (when enabled, and not before a pending
    /// count-in's downbeat).
    void onGridStep(const GridStep& step) noexcept TERMINATOR_NONBLOCKING;
    /// The transport stopped / paused / restarted: drop the pending BEAT clicks (the count-in stays).
    void transportStopped() noexcept TERMINATOR_NONBLOCKING;

    /// Fire this block's clicks at their samples and ADD the sounding elements into outL/outR (either may be null).
    /// Returns the block's peak of what was added.
    float process(std::uint64_t blockStart, int numSamples, float* outL, float* outR) noexcept TERMINATOR_NONBLOCKING;

    // --- read-back (audio thread) ---
    bool enabled() const noexcept { return enabled_; }
    ClickSound sound() const noexcept { return sound_; }
    double bpm() const noexcept { return bpm_; }
    int beat() const noexcept { return lastBeat_; }           // the last beat click's index 0..3 (−1 = none yet)
    std::uint64_t clicks() const noexcept { return clicks_; } // lifetime clicks fired (beats + count-in)
    std::uint64_t lastClickSample() const noexcept { return lastClickSample_; }
    bool lastClickAccent() const noexcept { return lastClickAccent_; }
    bool lastClickWasCountIn() const noexcept { return lastClickCountIn_; }
    /// The count-in display: −1 idle; while counting, N..1 (the full count until the first click fired, then
    /// N − (clicks fired − 1)) — the TS `countInBeat`.
    int countInBeat() const noexcept TERMINATOR_NONBLOCKING;
    bool countInPending() const noexcept { return countInPending_; }
    std::uint64_t countInDownbeatSample() const noexcept { return countInDownbeat_; }
    int countInBeats() const noexcept { return countInBeats_; }
    int pendingCount() const noexcept TERMINATOR_NONBLOCKING;

  private:
    struct Pending
    {
        double sample;
        std::uint8_t beatIdx; // 0..3 (beat clicks), i (count-in clicks)
        bool accent;
        bool countIn;
        bool used;
    };
    enum class Kind : std::uint8_t
    {
        sine = 0,    // OscillatorNode sine from phase 0, optional exponential frequency sweep
        noiseHp = 1, // the noise buffer through a highpass
        noiseBp = 2, // … through a bandpass
    };
    struct Element
    {
        bool active;
        Kind kind;
        std::int32_t startOffset; // samples into the current block before it starts (this block only)
        std::int32_t pos;         // samples rendered so far
        std::int32_t stopAt;      // total length in samples (the osc/src .stop time)
        // envelope (Web Audio automation on the gain): [0, attackEnd) linear 0 → peak; [attackEnd, decayEnd)
        // exponential peak → kDecayFloor; after: the floor (held until stopAt)
        float peak;
        std::int32_t attackEnd;
        std::int32_t decayEnd;
        // sine
        double phase;          // radians
        double phaseInc;       // 2π f / sr at the start frequency
        double sweepRate;      // per-sample multiplier on phaseInc during the sweep (1 = none)
        std::int32_t sweepEnd; // samples; after it the frequency holds
        // biquad (direct form I)
        double b0, b1, b2, a1, a2;
        double x1, x2, y1, y2;
    };
    static constexpr float kDecayFloor = 0.001f;

    void pushPending(double sample, std::uint8_t beatIdx, bool accent, bool countIn) noexcept TERMINATOR_NONBLOCKING;
    void fireClick(bool accent, std::int32_t offset) noexcept TERMINATOR_NONBLOCKING;
    Element* allocate() noexcept TERMINATOR_NONBLOCKING;
    void startSine(double hz, double sweepToHz, double sweepSec, float peak, double attackSec, double decaySec,
                   double stopSec, std::int32_t offset) noexcept TERMINATOR_NONBLOCKING;
    void startNoise(bool bandpass, double hz, double q, float peak, double decaySec, double stopSec,
                    std::int32_t offset) noexcept TERMINATOR_NONBLOCKING;
    float renderElements(int numSamples, float* outL, float* outR) noexcept TERMINATOR_NONBLOCKING;
    std::int32_t toSamples(double sec) const noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    double bpm_ = 120.0;
    bool enabled_ = false;
    ClickSound sound_ = ClickSound::click;
    Pending pending_[kMaxPending] = {};
    Element elements_[kMaxElements] = {};
    float noise_[kMaxNoiseFrames] = {};
    std::int32_t noiseFrames_ = 0;
    int lastBeat_ = -1;
    std::uint64_t clicks_ = 0;
    std::uint64_t lastClickSample_ = 0;
    bool lastClickAccent_ = false;
    bool lastClickCountIn_ = false;
    // count-in
    bool countInPending_ = false;
    int countInBeats_ = 0;
    int countInFired_ = 0;
    double countInDownbeatD_ = 0.0;
    std::uint64_t countInDownbeat_ = 0;
};

} // namespace terminator
