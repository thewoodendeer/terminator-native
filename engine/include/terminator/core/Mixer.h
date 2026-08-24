#pragma once
// The mixer (Phase 4.1): a fixed pool of strips summed in 64-bit, processed in dependency order through a FREE
// routing graph (any strip → master / another strip (a bus) / a hardware output pair / nowhere; 4 post-fader sends
// per strip to any strip) with a cycle guard. JUCE-free and RT: every buffer is sized in prepare(), nothing allocates
// or locks on the callback.
//
// Strip = input (the 64-bit accumulator the sources add into) → [inserts — Phase 4.2] → M/S width → fader → mute →
// pan → output; output → its sends (post-fader/mute/pan, the TS tap) + its output target. Strip 0 is the MASTER
// (fader + mute; its output target is a hardware pair, `mainOut`). Solo law = the TS: silent = muted || (anySolo &&
// !soloed), over every non-master strip. Smoothing = the TS setTargetAtTime constants (fader / pan / send / mute
// τ 8 ms), evaluated in closed form at the block end and ramped linearly inside the block (block-size invariant once
// settled; during a move the intra-block shape differs from an AudioParam by < the ramp's curvature).
// Pan = the Web Audio StereoPanner stereo law (the strip input is explicit 2-ch: mono sources land on both channels
// before the strip, so the stereo law is the only law). pan 0 = identity (bit-exact — no panner, the TS rule).
// Width = M/S: M = (L+R)/2, S = (L−R)/2·width; L' = M+S, R' = M−S; width 1 = identity (bit-exact, skipped).
// Meters = per strip pre (input) and post (output) peak per channel + RMS over a 4096-sample window (the TS
// peak-meter worklet's window), computed in the callback, published in the snapshot.
#include <cstdint>
#include <vector>

#include "terminator/core/RtAssert.h"
#include "terminator/core/StateSnapshot.h"
#include "terminator/core/fx/ConsoleStage.h"
#include "terminator/core/LoudnessMeter.h"
#include "terminator/core/fx/DynamicsFx.h"
#include "terminator/core/fx/FxDsp.h"
#include "terminator/core/fx/Effect.h"

namespace terminator
{

// kMaxStrips lives in StateSnapshot.h (the snapshot carries per-strip meters): 0 = master, 1..63 = channels / sends /
// buses (the page names them)
inline constexpr int kMasterStrip = 0;
inline constexpr int kMaxInserts = 8; // the TS: ≤ 8 inserts per strip (Phase 4.2)

/// WHAT PART OF THE STEREO IMAGE an insert works on (Phase 4.7a — B4's "mid/side everywhere"). This is a property
/// of the SLOT, not of the device: it applies to all 25 of them at once, which is the only way "everywhere" is
/// maintainable. STEREO is the default and is bit-exact — nothing below runs unless the slot asks for it.
enum class FxRoute : std::uint8_t
{
    stereo = 0,
    mid,  // (L+R)/2 — the centre: vocals, kick, snare, bass
    side, // (L−R)/2 — everything that is not the centre
    left,
    right
};

/// How many slots can route a device that HAS latency. A routed device delays only the part it processes, so the
/// part it does not has to be delayed to match or the two comb-filter when they are put back together; that needs
/// a delay line per such slot, and this is how many are kept ready. Slots past this fall back to STEREO rather
/// than to a quietly wrong sound.
inline constexpr int kMaxRoutedLatencySlots = 8;
inline constexpr int kMaxSends = 4;          // the TS: 4 post-fader sends per regular strip
inline constexpr float kFaderMinDb = -60.0f; // at/below = −∞ (gain 0) — FADER_MIN_DB / SEND_MIN_DB
inline constexpr float kFaderMaxDb = 6.0f;
inline constexpr float kMixerSmoothSec = 0.008f; // fader / pan / send / mute τ (setTargetAtTime 0.008)
inline constexpr int kMeterWindowSamples = 4096; // the peak-meter worklet's window
inline constexpr int kMeterRing = 64;            // per-block partials kept (≥ 4096 samples at any block ≥ 64)

enum class StripKind : std::uint8_t
{
    off = 0,     // not part of the mix: anything added to its input is dropped
    channel = 1, // a regular strip (sample / kick / … / sampleN / a user lane / bass / click)
    send = 2,    // an aux return (the TS send1..4: WET forced 100 in its inserts — Phase 4.2)
    bus = 3,     // a group bus (strips route INTO it; multi-select → bus)
    master = 4,  // strip 0 only
};

enum class StripOutput : std::uint8_t
{
    master = 0,   // → strip 0
    strip = 1,    // → outIndex (a bus / any strip)
    hardware = 2, // → the device's output pair outIndex (0 = outs 1/2, 1 = outs 3/4, …), post-fader, no master
    none = 3,     // dropped (a strip used only through its sends / a sidechain key)
};

/// One strip's SETTINGS (the targets the commands set) — read-back for tests.
struct StripSettings
{
    StripKind kind = StripKind::off;
    float faderDb = 0.0f;
    float pan = 0.0f;   // −1..1
    float width = 1.0f; // 0 = mono .. 1 = as is .. 2 = double side
    std::uint8_t mute = 0;
    std::uint8_t solo = 0;
    float sendDb[kMaxSends] = {kFaderMinDb, kFaderMinDb, kFaderMinDb, kFaderMinDb};
    std::int16_t sendTarget[kMaxSends] = {-1, -1, -1, -1}; // strip index (−1 = unwired)
    StripOutput outKind = StripOutput::master;
    std::int16_t outIndex = 0; // strip index / hardware pair
};

/// One strip's meter reading (the block the snapshot was published in).
struct StripMeter
{
    float peakPre[2] = {0.0f, 0.0f};  // over the window
    float peakPost[2] = {0.0f, 0.0f}; // post fader/mute/pan (what leaves the strip)
    float rmsPre = 0.0f;              // √mean-square over the window, both channels pooled
    float rmsPost = 0.0f;
};

class FxPool;

class Mixer
{
  public:
    Mixer() = default;
    Mixer(const Mixer&) = delete;
    Mixer& operator=(const Mixer&) = delete;

    /// Non-RT: sizes every buffer for maxBlockSize; (re)sets the topology to the default (master alone, → pair 0).
    /// `keepState` = a device change at the SAME rate: re-size the buffers for the new block and rebuild each
    /// strip's insert chain from the snapshot `saveChains()` took (see below).
    void prepare(double sampleRate, int maxBlockSize, bool keepState = false);
    /// Non-RT, call BEFORE the FxPool re-prepares: snapshot every strip's chain (type, params, bypass, order). The
    /// pool's re-prepare resets each device's params, so the snapshot must be taken while they are still live;
    /// `prepare(…, keepState = true)` then puts the chains back.
    void saveChains();
    /// Non-RT: drop the topology + smoothed state (release()).
    void reset() noexcept;

    // --- commands (audio thread) ---------------------------------------------------------------
    /// Activate / retype / deactivate a strip. Strip 0 is always the master (kind ignored there). Deactivating
    /// keeps the settings (reactivating brings them back), drops nothing else: routes INTO a dead strip are dropped
    /// at the dead strip (its input is never summed).
    void setStripKind(int strip, StripKind kind) noexcept TERMINATOR_NONBLOCKING;
    /// The strip's CONSOLE seed (the page: FNV-1a of the strip NAME → its six tolerances); 0 = not set.
    void setStripSeed(int strip, std::uint32_t seed) noexcept TERMINATOR_NONBLOCKING;
    /// CONSOLE (4.2c): the desk stage on every live strip (channel role; the master = bus role), global
    /// on / flavour / amount 0..100 (the amount glides ~23 ms; switching on starts AT the setting).
    void setConsole(bool on, ConsoleFlavour flavour, float amount) noexcept TERMINATOR_NONBLOCKING;
    bool consoleOn() const noexcept { return consoleOn_; }
    ConsoleFlavour consoleFlavour() const noexcept { return consoleFlavour_; }
    float consoleAmount() const noexcept { return consoleAmount_; }
    const ConsoleStage& console(int strip) const noexcept { return strips_[clampIdx(strip)].console; }
    /// The master's safety limiter (4.2c) — the page's DynamicsCompressor −1 dBFS / knee 0 / 20:1 / 1 ms / 50 ms on
    /// Blink's kernel (its 6 ms look-ahead = the master's latency, `masterLatencySamples()`; its perceptual makeup
    /// lifts the mix +0.57 dB — the page's). OFF by default (the engine's tests keep a bit-exact master); the page
    /// shadow turns it on.
    void setMasterLimiter(bool on) noexcept TERMINATOR_NONBLOCKING;
    bool masterLimiter() const noexcept { return limiterOn_; }
    int masterLatencySamples() const noexcept { return limiterOn_ ? limiter_.preDelayFrames() : 0; }
    float masterLimiterGrDb() const noexcept { return limiter_.meteringGainDb(); }
    /// The master's BS.1770-4 loudness (4.3) — fed post limiter, always on (cheap).
    const LoudnessReading& loudness() const noexcept { return loudness_.reading(); }
    void resetLoudness() noexcept TERMINATOR_NONBLOCKING { loudness_.reset(); }
    /// A dynamics insert's gain reduction (dB ≤ 0), 0 for any other slot.
    float fxGainReductionDb(int strip, int index) const noexcept TERMINATOR_NONBLOCKING;
    /// PDC (4.4) — the page's two-tier plan in integer samples on the exact chain latencies: tier 1 (channels) is
    /// aligned at maxChan (each strip delayed by maxChan − own before its fader), tier 2 (sends + buses) at maxBus,
    /// and the channels' direct leg to the master is delayed by maxBus (once, on their sum) so it lands with the bus
    /// returns. Recomputed on every chain / strip change; instant (a glide would pitch-bend); delays cap at
    /// kMaxPdcSamples. Default ON (the page's; with no latency insert every delay is 0 = bit-exact).
    static constexpr int kMaxPdcSamples = 4096;
    void setPdc(bool on) noexcept TERMINATOR_NONBLOCKING;
    bool pdcOn() const noexcept { return pdcOn_; }
    int pdcDelay(int strip) const noexcept { return pdcOn_ ? strips_[clampIdx(strip)].pdc : 0; }
    int pdcToMaster() const noexcept { return pdcOn_ ? pdcMaxBus_ : 0; }
    int pdcMaxChan() const noexcept { return pdcOn_ ? pdcMaxChan_ : 0; }
    void setFader(int strip, float db) noexcept TERMINATOR_NONBLOCKING;
    void setPan(int strip, float pan) noexcept TERMINATOR_NONBLOCKING;
    void setWidth(int strip, float width) noexcept TERMINATOR_NONBLOCKING;
    void setMute(int strip, bool on) noexcept TERMINATOR_NONBLOCKING;
    void setSolo(int strip, bool on) noexcept TERMINATOR_NONBLOCKING;
    /// A send: level (≤ −60 dB = off) + its destination strip (−1 = unwired). A destination that would close a loop
    /// (or the strip itself / the master) is REFUSED — the level is kept, the target stays what it was.
    bool setSend(int strip, int send, float db, int target) noexcept TERMINATOR_NONBLOCKING;
    /// The output target. strip/master targets that would close a loop (or the strip itself) are REFUSED.
    bool setOutput(int strip, StripOutput kind, int index) noexcept TERMINATOR_NONBLOCKING;
    /// The master's hardware pair (0 = outs 1/2).
    /// EXPORTS (4.5): ALSO copy this strip's output to a hardware pair, without changing where it normally goes — so
    /// ONE offline render produces the master AND every trackout stem, aligned by construction. pair < 0 = off.
    /// The tap is post insert / PDC / width / fader / mute / pan (what the strip contributes), pre the master's own
    /// chain and limiter — a trackout is a post-strip stem.
    void setStemTap(int strip, int pair) noexcept TERMINATOR_NONBLOCKING;
    int stemTap(int strip) const noexcept { return strips_[clampIdx(strip)].stemTap; }
    /// EXPORTS (4.5): how late this strip's output runs against true zero, in whole samples — everything the
    /// alignment plan and the chains put in front of it. A channel tap carries maxChan, a send/bus tap maxChan +
    /// maxBus, and the master additionally its own chain and the limiter's look-ahead. The offline renderer renders
    /// this many extra samples and drops them off the head of each pair, so the master and every stem start on the
    /// same sample ("master impulse == stem impulse"). With PDC off this is just the strip's own chain latency.
    int outputLatencySamples(int strip) const noexcept;
    void setMainOut(int pair) noexcept TERMINATOR_NONBLOCKING;

    // --- the insert chain (Phase 4.2) --------------------------------------------------------------
    /// Non-RT (prepare): the pool the chains take their devices from.
    void setPool(FxPool* pool) noexcept { pool_ = pool; }
    /// Append a device (the TS addFx pushes to the end). false = the strip is dead / full (8) / the pool has none
    /// left / the type is not ported (fxRejected++).
    bool addFx(int strip, FxType type) noexcept TERMINATOR_NONBLOCKING;
    bool removeFx(int strip, int index) noexcept TERMINATOR_NONBLOCKING;
    void setFxBypass(int strip, int index, bool on) noexcept TERMINATOR_NONBLOCKING;
    /// M/S (4.7a): what part of the image this slot's device works on. A device with LATENCY also takes one of the
    /// `kMaxRoutedLatencySlots` compensation delays so the untouched part stays aligned with the processed part;
    /// when none is free the slot stays STEREO (and `routeRejected()` counts it) rather than comb-filtering.
    void setFxRoute(int strip, int index, FxRoute route) noexcept TERMINATOR_NONBLOCKING;
    FxRoute fxRoute(int strip, int index) const noexcept;
    std::uint32_t routeRejected() const noexcept { return routeRejected_; }
    /// `immediate` = no glide (a restore / the page's first set).
    void setFxParam(int strip, int index, int param, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING;
    bool reorderFx(int strip, int from, int to) noexcept TERMINATOR_NONBLOCKING;
    void clearFx(int strip) noexcept TERMINATOR_NONBLOCKING;
    int fxCount(int strip) const noexcept { return strips_[clampIdx(strip)].fxCount; }
    FxType fxType(int strip, int index) const noexcept;
    bool fxBypassed(int strip, int index) const noexcept;
    const Effect* fx(int strip, int index) const noexcept;
    std::uint32_t fxRejected() const noexcept { return fxRejected_; }
    /// Σ latencySamples of the strip's non-bypassed inserts (the PDC plan, 4.4).
    int chainLatencySamples(int strip) const noexcept;
    /// The strips some SC COMP keys from (their pre-insert input is copied aside each block — the key is the input
    /// BEFORE that strip's own inserts run in place on it).
    std::uint64_t sidechainKeyMask() const noexcept { return keyMask_; }

    // --- sources (audio thread, before process()) -----------------------------------------------
    /// Zero every active strip's accumulator for this block — call first.
    void clearInputs(int numSamples) noexcept TERMINATOR_NONBLOCKING;
    /// The per-strip accumulators as a flat pointer table: inputs()[2k] / [2k+1] = strip k's L / R (doubles, add
    /// into them). A dead strip's entries point at a trash buffer (zeroed every block, never read).
    double* const* inputs() const noexcept { return inputPtrs_.data(); }
    /// Add a float stereo block into strip k (r == nullptr → mono: l on both). Dead / invalid strips drop it.
    void addToStrip(int strip, const float* l, const float* r, int numSamples) noexcept TERMINATOR_NONBLOCKING;

    // --- the block --------------------------------------------------------------------------
    /// Process every active strip in dependency order and ADD the results into outputs[0..numOut) (hardware pairs +
    /// the master's main out). outputs must already hold whatever the caller wants under the mix.
    void process(float* const* outputs, int numOut, int numSamples) noexcept TERMINATOR_NONBLOCKING;

    // --- read-back (audio thread, after process — the snapshot copies these) -----------------------
    const StripSettings& settings(int strip) const noexcept { return strips_[clampIdx(strip)].set; }
    const StripMeter& meter(int strip) const noexcept { return strips_[clampIdx(strip)].meter; }
    /// The strip's current (smoothed) fader × mute gain at the block end (1 = unity).
    float currentGain(int strip) const noexcept
    {
        const auto& s = strips_[clampIdx(strip)];
        return s.faderCur * s.muteCur;
    }
    std::uint64_t activeMask() const noexcept { return activeMask_; }
    std::uint64_t silentMask() const noexcept { return silentMask_; } // mute/solo-law silenced (target)
    std::uint32_t routesRejected() const noexcept { return rejected_; }
    bool orderValid() const noexcept { return orderValid_; }
    int mainOut() const noexcept { return mainOut_; }
    int numStrips() const noexcept { return kMaxStrips; }
    bool isActive(int strip) const noexcept
    {
        return strip >= 0 && strip < kMaxStrips && strips_[strip].set.kind != StripKind::off;
    }
    /// True when `to` is reachable from `from` through outputs + sends (the cycle guard's question).
    bool reaches(int from, int to) const noexcept TERMINATOR_NONBLOCKING;

  private:
    struct MeterTap
    {
        float pkL[kMeterRing] = {};
        float pkR[kMeterRing] = {};
        double ss[kMeterRing] = {}; // sum of squares, both channels
        int n[kMeterRing] = {};
        int head = 0;
        void push(float peakL, float peakR, double sumSq, int count) noexcept;
        void read(float& outPkL, float& outPkR, float& outRms) const noexcept;
        void clear() noexcept;
    };
    struct Strip
    {
        StripSettings set;
        // smoothed state (current values at the block end)
        float faderCur = 1.0f; // linear
        float muteCur = 1.0f;  // 0/1 target
        float panCur = 0.0f;
        float widthCur = 1.0f;
        float sendCur[kMaxSends] = {0.0f, 0.0f, 0.0f, 0.0f}; // linear
        MeterTap pre, post;
        StripMeter meter;
        // the insert chain (4.2)
        Effect* fx[kMaxInserts] = {};
        FxRoute fxRoute[kMaxInserts] = {};
        int fxCompDelay[kMaxInserts] = {-1, -1, -1, -1, -1, -1, -1, -1}; // index into compDelays_, −1 = none
        bool fxBypass[kMaxInserts] = {};
        int fxCount = 0;
        // the desk stage (4.2c): between the pre meter and the inserts
        ConsoleStage console;
        std::uint32_t seed = 0;
        // PDC (4.4): this strip's delay before its fader (samples) + its lines
        int pdc = 0;
        IntDelay pdcL, pdcR;
        // exports (4.5): an extra hardware pair this strip's output is copied to (−1 = none)
        int stemTap = -1;
    };

    static int clampIdx(int i) noexcept { return i < 0 ? 0 : (i >= kMaxStrips ? kMaxStrips - 1 : i); }
    static float dbToGain(float db) noexcept;
    void rebuildOrder() noexcept TERMINATOR_NONBLOCKING;
    void updateSilence() noexcept TERMINATOR_NONBLOCKING;
    void rebuildKeyMask() noexcept TERMINATOR_NONBLOCKING;
    void rebuildPdc() noexcept TERMINATOR_NONBLOCKING;
    void processStrip(int idx, float* const* outputs, int numOut, int numSamples) noexcept TERMINATOR_NONBLOCKING;

    double sampleRate_ = 48000.0;
    int maxBlock_ = 0;
    bool prepared_ = false;
    Strip strips_[kMaxStrips]{};
    int order_[kMaxStrips] = {};
    int orderCount_ = 0;
    bool orderValid_ = true;
    std::uint64_t activeMask_ = 0;
    std::uint64_t silentMask_ = 0;
    std::uint32_t rejected_ = 0;
    std::uint32_t fxRejected_ = 0;
    FxPool* pool_ = nullptr;
    struct SavedSlot
    {
        FxType type = FxType::none;
        bool bypass = false;
        int numParams = 0;
        float params[kMaxFxParams] = {};
    };
    std::vector<SavedSlot> savedChains_; // kMaxStrips × kMaxInserts, filled by saveChains()
    std::vector<int> savedChainCount_;   // per strip
    bool haveSavedChains_ = false;
    bool limiterOn_ = false;
    BlinkCompressorKernel limiter_;
    LoudnessMeter loudness_;
    bool pdcOn_ = true;
    int pdcMaxChan_ = 0, pdcMaxBus_ = 0;
    IntDelay toMasterL_, toMasterR_; // the channels' direct leg to the master, delayed by maxBus (their sum)
    std::vector<double> masterDirectL_, masterDirectR_; // that sum, this block
    bool consoleOn_ = false;
    ConsoleFlavour consoleFlavour_ = ConsoleFlavour::ssl;
    float consoleAmount_ = 50.0f;
    std::uint64_t keyMask_ = 0;       // strips that key an SC COMP somewhere (their input is copied to keys_)
    std::uint64_t processedMask_ = 0; // strips already processed this block (their input has been mutated)
    int mainOut_ = 0;
    // buffers (prepare)
    std::vector<double> inputs_;      // kMaxStrips × 2 × maxBlock
    std::vector<double> trash_;       // 2 × maxBlock (dead strips)
    std::vector<double*> inputPtrs_;  // 2 × kMaxStrips
    std::vector<double> outL_, outR_; // the strip being processed
    std::vector<double> wetL_, wetR_; // an insert's wet path when it crossfades (WET < 100)
    std::vector<double> msA_, msB_;   // M/S (4.7a): the component a routed device works on
    /// The compensation delays for routed devices that have latency (see kMaxRoutedLatencySlots).
    struct CompDelay
    {
        IntDelay a, b;
        bool used = false;
    };
    std::vector<CompDelay> compDelays_;
    std::uint32_t routeRejected_ = 0;
    std::vector<double> keys_;    // kMaxStrips × 2 × maxBlock: the sidechain keys (pre-insert inputs)
    std::vector<double> silence_; // maxBlock zeros (a key with no live source)
};

} // namespace terminator
