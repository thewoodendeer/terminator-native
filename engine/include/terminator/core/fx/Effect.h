#pragma once
// The insert-effect contract (Phase 4.2). An Effect is one device in a strip's insert chain (≤ 8 per strip,
// core/Mixer.h): prepared once (non-RT, sized for the max block), then driven on the audio thread — setParam /
// process / reset never allocate, lock or call out. Params are a fixed table per type (key + range + default — the
// SAME ids / ranges / defaults as the page's FX_REGISTRY so presets load unchanged); enum params hold the option
// INDEX. Numeric params glide with the TS constant (FX τ 10 ms, `setParam(… 0.01)`) unless the effect documents
// otherwise (a WIDTH gain set instantly stays instant). process() is the WET path in place; the chain applies the
// WET/dry crossfade (a true crossfade: dry 1−mix, wet mix) when the effect has a WET param, and bypass = dry.
// latencySamples() is the effect's own group delay in samples (the PDC plan, 4.4): the 4× shapers' oversampler, COMP's
// look-ahead, VINYL's base delays; 0 for the rest.
#include <cmath>
#include <cstdint>

#include "terminator/core/RtAssert.h"

namespace terminator
{

/// The mixer FX ids in the page's FX_ORDER (FxId). `none` = an empty slot.
enum class FxType : std::uint8_t
{
    none = 0,
    clip,
    wave,
    sat,
    mbsat,
    wide,
    mseq,
    pan,
    phaser,
    flanger,
    vinyl,
    filter,
    eq,
    comp,
    sccomp,
    delay,
    reverb,
    utility,
    ladder,    // 4.6 premium: ANALOG FILTER (native-only — appended so every existing type keeps its index)
    fetcomp,   // 4.6 premium: FET COMP
    tapeecho,  // 4.6 premium: TAPE ECHO (RE-201)
    plateverb, // 4.6 premium: HALL 224
    saturator, // 4.6 premium: SATURATOR
    limiter,   // 4.6 premium: LIMITER
    retro,     // 4.6 premium: RETRO (RC-20 shaped)
    count
};

inline constexpr int kMaxFxParams = 12;
inline constexpr int kMaxFxOptions = 8;

struct FxParamDef
{
    const char* key;                      // the page's param key ("GAIN", "CUTOFF", …)
    float min, max;                       // numeric range (enum: 0 .. numOptions−1)
    float def;                            // default
    const char* const* options = nullptr; // non-null = an enum param (the page's string values)
    int numOptions = 0;
    bool isEnum() const noexcept { return options != nullptr; }
};

struct FxTypeInfo
{
    FxType type;
    const char* id; // the page's FxId string
    const FxParamDef* params;
    int numParams;
    int wetParam; // the WET (0..100) param the CHAIN crossfades; −1 = the chain runs the device fully wet (no WET
                  // param, or the device blends internally with a latency-matched dry leg: MB SAT, COMP)
};

/// The type table (core/fx/FxPool.cpp): the params of every type, by FxType; `id` → FxType; "KEY" → index.
const FxTypeInfo& fxTypeInfo(FxType t) noexcept TERMINATOR_NONBLOCKING;
FxType fxTypeFromId(const char* id) noexcept;
int fxParamIndex(FxType t, const char* key) noexcept;                // −1 = unknown
int fxOptionIndex(FxType t, int param, const char* option) noexcept; // −1 = unknown / not an enum

/// A one-pole glide with the TS setTargetAtTime semantics (closed form per block, snapped within eps of the target).
struct Glide
{
    float cur = 0.0f;
    float target = 0.0f;
    void set(float v, bool immediate) noexcept TERMINATOR_NONBLOCKING
    {
        target = v;
        if (immediate)
            cur = v;
    }
    /// Advance to the block end for `n` samples with time constant `tauSec`; returns the new current value.
    float advance(int n, double sampleRate, float tauSec, float eps = 1e-6f) noexcept TERMINATOR_NONBLOCKING
    {
        if (cur == target)
            return cur;
        const float a = std::exp(-static_cast<float>(n) / (tauSec * static_cast<float>(sampleRate)));
        const float e = target + (cur - target) * a;
        cur = (e - target <= eps && target - e <= eps) ? target : e;
        return cur;
    }
    bool moving() const noexcept { return cur != target; }
};

/// A Web Audio BiquadFilterNode (the spec's RBJ forms, coefficients in double, Direct Form I like Blink). Q is in
/// dB for lowpass/highpass (the spec), linear for the rest; shelves ignore Q (S = 1).
class Biquad
{
  public:
    enum class Type : std::uint8_t
    {
        lowpass = 0,
        highpass,
        bandpass,
        notch,
        allpass,
        peaking,
        lowshelf,
        highshelf
    };
    void reset() noexcept TERMINATOR_NONBLOCKING { x1_ = x2_ = y1_ = y2_ = 0.0; }
    /// Recompute for (type, frequency Hz, Q, gain dB) at `sampleRate`.
    void set(Type type, double freqHz, double q, double gainDb, double sampleRate) noexcept TERMINATOR_NONBLOCKING;
    void setIdentity() noexcept
    {
        b0_ = 1.0;
        b1_ = b2_ = a1_ = a2_ = 0.0;
        identity_ = true;
    }
    /// A 0 dB shelf / bell (b = a) passes the signal BIT-EXACT (the state still runs, so a later move is seamless).
    double process(double x) noexcept TERMINATOR_NONBLOCKING
    {
        const double y = identity_ ? x : b0_ * x + b1_ * x1_ + b2_ * x2_ - a1_ * y1_ - a2_ * y2_;
        x2_ = x1_;
        x1_ = x;
        y2_ = y1_;
        y1_ = y;
        return y;
    }
    /// |H(e^jw)| at `freqHz` — for gates.
    double magnitudeAt(double freqHz, double sampleRate) const noexcept;

  private:
    double b0_ = 1.0, b1_ = 0.0, b2_ = 0.0, a1_ = 0.0, a2_ = 0.0;
    double x1_ = 0.0, x2_ = 0.0, y1_ = 0.0, y2_ = 0.0;
    bool identity_ = true;
};

class Effect
{
  public:
    virtual ~Effect() = default;
    virtual FxType type() const noexcept TERMINATOR_NONBLOCKING = 0;
    /// Non-RT: size for the rate / block; params at their defaults, state cleared.
    virtual void prepare(double sampleRate, int maxBlockSize) = 0;
    /// RT: clear the state and put every param at its default IMMEDIATELY (a freshly inserted device).
    virtual void reset() noexcept TERMINATOR_NONBLOCKING = 0;
    /// RT: set param `index` (enum params: the option index). `immediate` skips the glide (the first set / a restore).
    virtual void setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING = 0;
    /// The param's TARGET value.
    virtual float param(int index) const noexcept TERMINATOR_NONBLOCKING = 0;
    virtual int latencySamples() const noexcept TERMINATOR_NONBLOCKING { return 0; }
    /// The strip whose pre-insert INPUT keys this device (SC COMP), −1 = none. When ≥ 0 the chain hands the key in
    /// through setSidechainKey (the block's L / R, or nullptr for silence) right before process().
    virtual int sidechainSource() const noexcept TERMINATOR_NONBLOCKING { return -1; }
    virtual void setSidechainKey(const double* /*l*/, const double* /*r*/) noexcept TERMINATOR_NONBLOCKING {}
    /// A dynamics device's gain reduction (dB ≤ 0, the page's meters) — 0 for everything else.
    virtual float gainReductionDb() const noexcept TERMINATOR_NONBLOCKING { return 0.0f; }
    /// RT: the wet path, in place.
    virtual void process(double* l, double* r, int numSamples) noexcept TERMINATOR_NONBLOCKING = 0;

    const FxTypeInfo& info() const noexcept TERMINATOR_NONBLOCKING { return fxTypeInfo(type()); }
    int numParams() const noexcept TERMINATOR_NONBLOCKING { return info().numParams; }
    /// The WET param's value 0..1 (1 when the type has none).
    float wetMix() const noexcept TERMINATOR_NONBLOCKING
    {
        const int w = info().wetParam;
        return w < 0 ? 1.0f : param(w) * 0.01f;
    }
};

} // namespace terminator
