#pragma once
// BassSynth — Terminator's Model D–shaped bass synth, the `bass-synth` AudioWorklet ported 1:1 to C++ (Phase 3.4).
// Reference = ui/public/worklets/bass-synth-worklet.js (dossier-stems-bass-io.md §2): the same equations, the same
// constants, the same per-block / per-sample split:
//   3 PolyBLEP oscillators (TRI · SHARK · SAW · SQUARE · PULSE · NARROW · SINE · MORPH) + SUB + NOISE → the mixer's
//   tanh overdrive → LADDER (D'Angelo–Välimäki, 2× oversampled) | OTA (TPT SVF, ×2 cascade for 24 dB) | DIODE
//   (Zavalishin/Pirkle ZDF) → contour + loudness RC-shaped ADSRs → post DRIVE → TONE → GLUE → VOL → DC blocker →
//   safety clip. Mono (last-note priority, legato, exp glide, FL-style SLIDE notes, the BEND lane) or up to 8-voice
//   poly. The MOD matrix (3 LFOs + 2 trigger envelopes → any knob) is applied per block onto a copy of the patch.
// Timing: everything is an EVENT at an absolute ENGINE SAMPLE (note on/off, slide, timed bend) in a fixed ring,
// fired inside render() at its exact sample — no look-ahead timer. The synth renders in fixed 128-sample QUANTA
// (the worklet's render quantum) aligned to absolute sample 0, so the per-block work (param smoothing, mod
// sources, drift, envelope times) happens at the same instants whatever the host block size → the output is
// BLOCK-SIZE INVARIANT and matches the worklet's block cadence. Randomness (osc start phase, per-voice offsets,
// drift targets, S&H, noise) comes from a seeded xorshift PRNG (prepare() seeds it).
// Everything here is RT (RT-RULES.md): fixed pools, no allocation, no libm beyond what the DSP needs.
#include <cmath>
#include <cstdint>
#include <type_traits>

#include "terminator/core/RtAssert.h"

namespace terminator
{

inline constexpr int kBassMaxVoices = 8;
inline constexpr int kBassQuantum = 128;   // the worklet's render quantum
inline constexpr int kBassMaxMods = 32;    // MOD matrix entries
inline constexpr int kBassMaxEvents = 512; // pending events (live + this block's sequenced ones)
inline constexpr int kBassMaxHeld = 32;    // the mono held-note stack

enum class BassWave : std::uint8_t
{
    tri = 0,
    shark,
    saw,
    square,
    pulse,
    narrow,
    sine,
    morph
};
enum class BassFilterModel : std::uint8_t
{
    ladder = 0,
    ota,
    diode
};
enum class BassFilterMode : std::uint8_t
{
    lp = 0,
    bp,
    hp
};
enum class BassLfoWave : std::uint8_t
{
    tri = 0,
    square,
    saw,
    ramp,
    sine,
    sh
};
enum class BassModSource : std::uint8_t
{
    lfo1 = 0,
    lfo2,
    lfo3,
    trigA,
    trigB
};
enum class BassTrigShape : std::uint8_t
{
    exp = 0,
    lin
};
/// Every numeric leaf of the patch a MOD can target — the dotted paths the UI's knobs carry (BassSection.tsx):
/// `osc.N.{level,semi,fine,pw,morph}`, `sub.level`, `noise.level`, `mixerDrive`, `filter.{cutoff,reso,envAmt,kbd,
/// drive}`, `filtEnv.{a,d,s,r}`, `ampEnv.{a,d,s,r}`, `glide`, `drift`, `velAmp`, `velFilt`, `post.{drive,tone,glue,
/// gain}`, `modSrc.lfo.N.rate`, `modSrc.trig.N.{ramp,fall}`. The shell maps the string to this enum (BassPatchJson).
enum class BassModTarget : std::uint8_t
{
    none = 0,
    osc1Level,
    osc1Semi,
    osc1Fine,
    osc1Pw,
    osc1Morph,
    osc2Level,
    osc2Semi,
    osc2Fine,
    osc2Pw,
    osc2Morph,
    osc3Level,
    osc3Semi,
    osc3Fine,
    osc3Pw,
    osc3Morph,
    subLevel,
    noiseLevel,
    mixerDrive,
    filterCutoff,
    filterReso,
    filterEnvAmt,
    filterKbd,
    filterDrive,
    filtEnvA,
    filtEnvD,
    filtEnvS,
    filtEnvR,
    ampEnvA,
    ampEnvD,
    ampEnvS,
    ampEnvR,
    glide,
    drift,
    velAmp,
    velFilt,
    postDrive,
    postTone,
    postGlue,
    postGain,
    lfo1Rate,
    lfo2Rate,
    lfo3Rate,
    trigARamp,
    trigAFall,
    trigBRamp,
    trigBFall,
    count
};

struct BassOscPatch
{
    bool on = true;
    BassWave wave = BassWave::saw;
    double octave = 0.0; // −2..2 (32'…2')
    double semi = 0.0;   // ±12
    double fine = 0.0;   // ±50 cents
    double level = 0.8;  // 0..1
    double pw = 0.5;     // 0.05..0.5 (NARROW only)
    double morph = 0.33; // SHAPE knob 0 (tri) … 1 (sine), wave == morph
};
struct BassEnvPatch
{
    double a = 0.005, d = 0.2, s = 0.7, r = 0.2;
};

/// The patch (BassEngine.ts `BassPatch` / the worklet's defaultPatch()), trivially copyable, handed to the engine by
/// pointer (the shell keeps a ring alive). `defaults()` = the worklet's defaultPatch(); the shell deep-merges a JSON
/// patch over it (missing keys fill in — old / partial patches load the same way the TS `mergePatch` does).
struct BassPatch
{
    BassOscPatch osc[3];
    double subLevel = 0.5;
    BassWave subWave = BassWave::sine; // sine | square
    int subOctave = 1;                 // 1 | 2 (octaves below osc 1)
    double noiseLevel = 0.0;
    bool noisePink = false;
    double mixerDrive = 0.15;
    BassFilterModel filterModel = BassFilterModel::ladder;
    BassFilterMode filterMode = BassFilterMode::lp;
    double cutoff = 420.0;
    double reso = 0.25;
    double envAmt = 0.45;
    double kbd = 0.3;
    int poles = 4;
    double filterDrive = 0.2;
    BassEnvPatch filtEnv{0.003, 0.28, 0.15, 0.2};
    BassEnvPatch ampEnv{0.004, 0.3, 0.85, 0.12};
    // legacy single LFO (pre-MOD-matrix patches) — honoured, hidden in the UI
    double lfoRate = 4.5;
    BassLfoWave lfoWave = BassLfoWave::tri;
    double lfoToCutoff = 0.0;
    double lfoToPitch = 0.0;
    // MOD sources: three free LFOs (KEY = restart on every note-on) + two trigger envelopes (RAMP up, FALL back)
    struct ModLfo
    {
        double rate = 4.5;
        BassLfoWave wave = BassLfoWave::tri;
        bool key = false;
    } modLfo[3] = {{4.5, BassLfoWave::tri, false}, {0.5, BassLfoWave::sine, false}, {8.0, BassLfoWave::sh, true}};
    struct ModTrig
    {
        double ramp = 0.005;
        double fall = 0.35;
        BassTrigShape shape = BassTrigShape::exp;
    } modTrig[2] = {{0.005, 0.35, BassTrigShape::exp}, {0.12, 0.6, BassTrigShape::exp}};
    struct Mod
    {
        BassModSource src = BassModSource::lfo1;
        BassModTarget target = BassModTarget::none;
        double depth = 0.0; // −1..1
    } mods[kBassMaxMods] = {};
    int numMods = 0;
    double glide = 0.04; // seconds 0..1
    bool legato = true;
    int voices = 1; // 1 = MONO (last-note priority) … 8
    double drift = 0.35;
    double velAmp = 0.5;
    double velFilt = 0.4;
    double postDrive = 0.15;
    double postTone = 20000.0; // Hz (20 k = open)
    double postGlue = 0.2;
    double postGain = 0.8;

    static BassPatch defaults() noexcept { return BassPatch{}; }
    /// The numeric leaf a MOD target addresses (nullptr for none).
    double* leaf(BassModTarget t) noexcept;
    /// The range/taper of a target (the worklet's modRange): log targets modulate in octaves.
    struct Range
    {
        double min, max;
        bool log;
        double oct;
    };
    static Range rangeOf(BassModTarget t) noexcept;
};
static_assert(std::is_trivially_copyable_v<BassPatch>);

/// Event tags — the worklet's message `tag` strings (clear(tag) drops only that tag's pending events).
enum class BassTag : std::uint8_t
{
    any = 0,  // clear: every tag
    seq = 1,  // the pattern sequencer
    live = 2, // MIDI / pads / keyboard
    arr = 3,  // the arranger timeline
    prev = 4, // the roll's audition blip
    x = 5     // exports / tests
};

class BassSynth
{
  public:
    enum class EventKind : std::uint8_t
    {
        off = 0,
        on = 1,
        slide = 2,
        bend = 3
    };

    BassSynth() = default;

    // --- non-RT ---
    /// `keepState` = a device change at the SAME rate: keep the voices, the patch and the phases.
    void prepare(double sampleRate, std::uint64_t seed = 0x9e3779b97f4a7c15ull, bool keepState = false) noexcept;
    void reset() noexcept;

    // --- commands (audio thread) ---
    void setPatch(const BassPatch* p) noexcept TERMINATOR_NONBLOCKING; // nullptr = defaults
    /// Queue an event at an absolute engine sample (≤ the current position = fires at the next rendered sample).
    /// `value` = slide duration in seconds (slide) / semitones (bend). Returns false when the ring is full.
    bool pushEvent(EventKind kind, std::uint64_t atSample, std::uint8_t note, float velocity, double value,
                   BassTag tag) noexcept TERMINATOR_NONBLOCKING;
    /// Drop the pending events of `tag` (any = all); release what is playing when `release`.
    void clear(BassTag tag, bool release) noexcept TERMINATOR_NONBLOCKING;
    void panic() noexcept TERMINATOR_NONBLOCKING; // kill every voice, drop every event
    void setBendNow(double semis) noexcept TERMINATOR_NONBLOCKING { pitchBend_ = semis; }
    void setModWheel(double v) noexcept TERMINATOR_NONBLOCKING { modWheel_ = v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); }

    /// Adds the synth into L/R (mono summed to both; R may be nullptr) for numSamples starting at absolute engine
    /// sample `blockStart`. Renders in kBassQuantum-sized quanta aligned to sample 0.
    void render(float* left, float* right, int numSamples, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING;

    // --- read-back for the snapshot (audio thread) ---
    float meterLevel() const noexcept { return meterLevel_; } // peak over the last completed 1/30 s window
    std::uint32_t meterVoices() const noexcept { return meterVoices_; }
    std::uint32_t activeVoices() const noexcept TERMINATOR_NONBLOCKING;
    /// bit n (of two 64-bit words) = a voice is sounding MIDI note n
    void activeNoteMask(std::uint64_t out[2]) const noexcept TERMINATOR_NONBLOCKING;
    std::uint64_t notesFired() const noexcept { return notesFired_; }
    std::uint64_t eventsDropped() const noexcept { return eventsDropped_; }
    double pitchBend() const noexcept { return pitchBend_; }
    int pendingEvents() const noexcept TERMINATOR_NONBLOCKING;
    std::uint64_t position() const noexcept { return pos_; }

  private:
    // ---- PRNG (JS Math.random stand-in): xorshift64*, uniform [0,1) ----
    double rnd() noexcept TERMINATOR_NONBLOCKING;

    // ---- DSP blocks (the worklet's classes) ----
    struct Osc
    {
        double phase = 0.0;
        double tri = 0.0, triS = 0.0; // leaky integrators (triangle, shark)
        double drift = 0.0, driftTarget = 0.0, driftCount = 0.0;
        double shapeAt(BassWave w, double t, double dt, double pw) const noexcept TERMINATOR_NONBLOCKING;
        double next(double freq, double sr, BassWave w, double pw, double morph) noexcept TERMINATOR_NONBLOCKING;
    };
    struct ADSR
    {
        int stage = 0; // 0 idle 1 attack 2 decay 3 sustain 4 release
        double v = 0.0;
        double a = 0.005, d = 0.2, s = 0.7, r = 0.2;
        double ka = 0.0, kd = 0.0, kr = 0.0; // cached 1−exp(−1/(t·sr·…)) for the current a/d/r
        double cachedSr = 0.0;
        void set(double aa, double dd, double ss, double rr, double sr) noexcept TERMINATOR_NONBLOCKING;
        void gate(bool on) noexcept TERMINATOR_NONBLOCKING;
        bool active() const noexcept { return stage != 0; }
        double next() noexcept TERMINATOR_NONBLOCKING;
    };
    struct Ladder
    {
        double V[4] = {}, dV[4] = {}, tV[4] = {};
        double g = 0.0;
        void reset() noexcept;
        void setCutoff(double hz, double sr2) noexcept TERMINATOR_NONBLOCKING;
        double process(double in, double res, double drive, int poles, double sr2) noexcept TERMINATOR_NONBLOCKING;
    };
    struct Svf
    {
        double ic1 = 0.0, ic2 = 0.0, g = 0.0, k = 1.0, a1 = 0.0, a2 = 0.0, a3 = 0.0;
        void reset() noexcept;
        void set(double hz, double res, double sr) noexcept TERMINATOR_NONBLOCKING;
        double process(double v0, BassFilterMode mode) noexcept TERMINATOR_NONBLOCKING;
    };
    struct Diode
    {
        double z[4] = {}, fb[4] = {};
        double alpha = 0.0, gamma = 0.0;
        double beta[4] = {}, gam[4] = {}, delta[4] = {}, eps[4] = {};
        double a0[4] = {1.0, 0.5, 0.5, 0.5};
        double SG[4] = {0.0, 0.0, 0.0, 1.0};
        void reset() noexcept;
        void set(double hz, double sr) noexcept TERMINATOR_NONBLOCKING;
        double fbOut(int i) const noexcept TERMINATOR_NONBLOCKING;
        double stage(int i, double xn) noexcept TERMINATOR_NONBLOCKING;
        double process(double xn, double K) noexcept TERMINATOR_NONBLOCKING;
    };
    struct Voice
    {
        Osc osc[3];
        Osc sub;
        double noiseB0 = 0.0, noiseB1 = 0.0, noiseB2 = 0.0; // pink filter
        ADSR ampEnv, filtEnv;
        Ladder ladder;
        Svf svfA, svfB;
        Diode diode;
        int note = -1;
        double vel = 1.0;
        double pitch = 48.0, targetPitch = 48.0;
        double slideDur = 0.0, slideT = 0.0, slideFrom = 48.0;
        bool active = false;
        double startedAt = 0.0; // seconds (the steal order)
        double offs[3] = {};    // fixed per-voice analog offsets (cents)
        double driftCents[3] = {};
        void start(int n, double v, bool legato, double glideSec, double when) noexcept TERMINATOR_NONBLOCKING;
        void release() noexcept TERMINATOR_NONBLOCKING;
        void slide(int n, double sec) noexcept TERMINATOR_NONBLOCKING;
        void kill() noexcept TERMINATOR_NONBLOCKING;
    };
    struct Event
    {
        std::uint64_t sample;
        std::uint64_t order; // insertion order (stable among equal samples — the worklet's insertEvent)
        double value;
        float velocity;
        std::uint8_t note;
        EventKind kind;
        BassTag tag;
        bool used;
    };

    void noteOn(int note, double vel, double whenSec) noexcept TERMINATOR_NONBLOCKING;
    void noteOff(int note) noexcept TERMINATOR_NONBLOCKING;
    void slideTo(int note, double sec) noexcept TERMINATOR_NONBLOCKING;
    void applyMods(double blockSec) noexcept TERMINATOR_NONBLOCKING;
    void renderQuantum(float* left, float* right, int n) noexcept TERMINATOR_NONBLOCKING;
    void fireDue(std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING;
    void heldRemove(int note) noexcept TERMINATOR_NONBLOCKING;
    void heldPush(int note) noexcept TERMINATOR_NONBLOCKING;
    void recomputeEarliest() noexcept TERMINATOR_NONBLOCKING;

    double sr_ = 48000.0;
    std::uint64_t rng_ = 0x9e3779b97f4a7c15ull;
    std::uint64_t pos_ = 0;       // absolute sample position rendered so far
    std::uint64_t nextOrder_ = 0; // event insertion counter
    const BassPatch* patch_ = nullptr;
    BassPatch defaults_{};
    BassPatch eff_{}; // the per-block patch with the MOD matrix applied
    bool modsOnCutoff_ = false;
    Voice voices_[kBassMaxVoices];
    Event events_[kBassMaxEvents] = {};
    std::uint64_t earliest_ = ~0ull; // the smallest pending sample (UINT64_MAX = none) — skips the per-sample scan
    int held_[kBassMaxHeld] = {};
    int heldCount_ = 0;
    // smoothed continuous params
    double smCutoff_ = 420.0, smRes_ = 0.25, smDrive_ = 0.15, smGain_ = 0.8, smMixDrive_ = 0.15;
    // legacy LFO
    double lfoPhase_ = 0.0, lastLfo_ = 0.0;
    // MOD sources
    double modLfoPhase_[3] = {}, modLfoSH_[3] = {};
    double trigT_[2] = {-1.0, -1.0};
    double modOut_[5] = {}; // lfo1 lfo2 lfo3 trigA trigB
    // post
    double compEnv_ = 0.0, toneZ_ = 0.0, dcX_ = 0.0, dcY_ = 0.0;
    double pitchBend_ = 0.0, modWheel_ = 0.0;
    // meter
    double meterAcc_ = 0.0;
    std::uint64_t meterCount_ = 0;
    float meterLevel_ = 0.0f;
    std::uint32_t meterVoices_ = 0;
    std::uint64_t notesFired_ = 0;
    std::uint64_t eventsDropped_ = 0;
};

} // namespace terminator
