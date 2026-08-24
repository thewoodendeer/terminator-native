#include "terminator/core/fx/FxPool.h"

#include <cstring>

#include "terminator/core/fx/AnalogFx.h"
#include "terminator/core/fx/BasicFx.h"
#include "terminator/core/fx/DynamicsFx.h"
#include "terminator/core/fx/ModFx.h"
#include "terminator/core/fx/ReverbFx.h"
#include "terminator/core/fx/ShaperFx.h"

namespace terminator
{

// ---- the type table (the page's FX_REGISTRY: same keys / ranges / defaults / option strings) ----------------------

namespace
{
const char* const kUtilityModes[] = {"STEREO", "MONO", "MONO-L", "MONO-R"};
const char* const kUtilityPhases[] = {"normal", "inverted"};
const char* const kFilterTypes[] = {"lowpass", "highpass", "bandpass", "notch"};
const char* const kPhaserStages[] = {"4", "6", "8", "12"};
const char* const kCompStyles[] = {"OFF", "LIGHT", "PUNCHY", "NY-PARALLEL", "AGGRESSIVE"};
const char* const kLadderModes[] = {"LP24", "LP18", "LP12", "LP6", "HP24", "HP12", "BP24", "BP12"};
const char* const kFetRatios[] = {"1:1", "2:1", "3:1", "4:1", "6:1", "10:1", "20:1", "NUKE"};
const char* const kFetDetect[] = {"FLAT", "HP1", "HP2", "BAND"};
const char* const kFetModes[] = {"CLEAN", "DIST 2", "DIST 3", "BRITISH"};
const char* const kTapeHeads[] = {"H1", "H2", "H3", "H1+2", "H2+3", "H1+3", "H1+2+3"};
const char* const kVerbPrograms[] = {"HALL", "CHAMBER", "PLATE", "ROOM", "AMBIENCE"};
const char* const kSatStyles[] = {"A TUBE", "E GERM", "N BRIT", "T XFMR", "P PUNISH"};
const char* const kOffOn[] = {"OFF", "ON"};
const char* const kLimStyleNames[] = {"TRANSPARENT", "PUNCHY", "DYNAMIC", "ALLROUND", "AGGRESSIVE", "BUS", "SAFE"};
const char* const kRetroNoise[] = {"VINYL", "TAPE", "STATIC", "RADIO"};
const char* const kRetroDist[] = {"TUBE", "TAPE", "FUZZ", "DIODE", "FOLD", "BITS", "TRANSISTOR", "CRUSH"};

const FxParamDef kClipParams[] = {
    {"AMT", 0.0f, 100.0f, 0.0f},
};
const FxParamDef kWaveParams[] = {
    {"DRIVE", 0.0f, 100.0f, 0.0f},
};
const FxParamDef kSatParams[] = {
    {"DRIVE", 0.0f, 100.0f, 0.0f},
};
const FxParamDef kMbsatParams[] = {
    {"LOW", 0.0f, 100.0f, 0.0f},      {"MID", 0.0f, 100.0f, 0.0f},         {"HIGH", 0.0f, 100.0f, 0.0f},
    {"LO_X", 40.0f, 2000.0f, 200.0f}, {"HI_X", 500.0f, 16000.0f, 3000.0f}, {"WET", 0.0f, 100.0f, 100.0f},
};
const FxParamDef kUtilityParams[] = {
    {"GAIN", -20.0f, 20.0f, 0.0f},
    {"MODE", 0.0f, 3.0f, 0.0f, kUtilityModes, 4},
    {"PHASE", 0.0f, 1.0f, 0.0f, kUtilityPhases, 2},
};
const FxParamDef kEqParams[] = {
    {"LOW", -12.0f, 12.0f, 0.0f},
    {"MID", -12.0f, 12.0f, 0.0f},
    {"HIGH", -12.0f, 12.0f, 0.0f},
};
const FxParamDef kFilterParams[] = {
    {"TYPE", 0.0f, 3.0f, 0.0f, kFilterTypes, 4},
    {"CUTOFF", 20.0f, 20000.0f, 20000.0f},
    {"RESO", 0.0f, 30.0f, 1.0f},
};
const FxParamDef kWideParams[] = {
    {"WIDTH", 0.0f, 200.0f, 100.0f},
};
const FxParamDef kMseqParams[] = {
    {"MID_HZ", 20.0f, 20000.0f, 1000.0f},
    {"MID_DB", -18.0f, 18.0f, 0.0f},
    {"SIDE_HZ", 20.0f, 20000.0f, 4000.0f},
    {"SIDE_DB", -18.0f, 18.0f, 0.0f},
};
const FxParamDef kPanParams[] = {
    {"RATE", 0.1f, 10.0f, 1.0f},
    {"DEPTH", 0.0f, 100.0f, 50.0f},
};
const FxParamDef kPhaserParams[] = {
    {"RATE", 0.02f, 10.0f, 0.4f},
    {"DEPTH", 0.0f, 100.0f, 70.0f},
    {"CENTER", 100.0f, 8000.0f, 900.0f},
    {"FEEDBACK", 0.0f, 90.0f, 30.0f},
    {"STAGES", 0.0f, 3.0f, 1.0f, kPhaserStages, 4},
    {"WET", 0.0f, 100.0f, 50.0f},
};
const FxParamDef kFlangerParams[] = {
    {"RATE", 0.02f, 8.0f, 0.25f},       {"DEPTH", 0.0f, 100.0f, 60.0f}, {"DELAY", 0.3f, 12.0f, 3.0f},
    {"FEEDBACK", -95.0f, 95.0f, 40.0f}, {"WET", 0.0f, 100.0f, 50.0f},
};
const FxParamDef kVinylParams[] = {
    {"WARMTH", 0.0f, 10.0f, 4.0f},  {"DRIVE", 0.0f, 10.0f, 2.0f}, {"WOW", 0.0f, 10.0f, 3.0f},
    {"FLUTTER", 0.0f, 10.0f, 3.0f}, {"AGE", 0.0f, 10.0f, 3.0f},
};
const FxParamDef kCompParams[] = {
    {"STYLE", 0.0f, 4.0f, 2.0f, kCompStyles, 5},
    {"THRESHOLD", -60.0f, 0.0f, -20.0f},
    {"RATIO", 1.0f, 20.0f, 4.0f},
    {"ATTACK", 0.1f, 100.0f, 10.0f},
    {"RELEASE", 10.0f, 1000.0f, 80.0f},
    {"MAKEUP", 0.0f, 24.0f, 4.0f},
};
const FxParamDef kSccompParams[] = {
    {"SOURCE", -1.0f, 63.0f, -1.0f}, // the key strip's index (−1 = NONE; the page maps its strip NAME to this)
    {"THRESH", -60.0f, 0.0f, -24.0f},   {"RATIO", 1.0f, 20.0f, 4.0f}, {"ATTACK", 0.1f, 100.0f, 5.0f},
    {"RELEASE", 5.0f, 1000.0f, 120.0f}, {"HOLD", 0.0f, 500.0f, 0.0f}, {"MAKEUP", 0.0f, 24.0f, 0.0f},
    {"KEYHP", 20.0f, 500.0f, 20.0f},
};
const FxParamDef kDelayParams[] = {
    {"TIME", 1.0f, 2000.0f, 300.0f},
    {"FEEDBACK", 0.0f, 95.0f, 35.0f},
    {"WET", 0.0f, 100.0f, 30.0f},
    {"PINGPONG", 0.0f, 1.0f, 0.0f},
};
const FxParamDef kLadderParams[] = {
    {"MODE", 0.0f, 7.0f, 0.0f, kLadderModes, 8},
    {"CUTOFF", 20.0f, 20000.0f, 20000.0f},
    {"RESO", 0.0f, 100.0f, 0.0f},
    {"DRIVE", 0.0f, 100.0f, 0.0f},
    {"WET", 0.0f, 100.0f, 100.0f},
};
const FxParamDef kFetCompParams[] = {
    {"RATIO", 0.0f, 7.0f, 3.0f, kFetRatios, 8}, // the switch IS the character; 4:1 is the default
    {"INPUT", -12.0f, 24.0f, 0.0f},             // no THRESHOLD: you drive into a fixed one, like the hardware
    {"ATTACK", 0.05f, 50.0f, 3.0f},
    {"RELEASE", 20.0f, 2000.0f, 150.0f},
    {"DETECT", 0.0f, 3.0f, 0.0f, kFetDetect, 4},
    {"MODE", 0.0f, 3.0f, 0.0f, kFetModes, 4},
    {"OUTPUT", -24.0f, 24.0f, 0.0f},
    {"WET", 0.0f, 100.0f, 100.0f},
};
const FxParamDef kTapeEchoParams[] = {
    {"MODE", 0.0f, 6.0f, 6.0f, kTapeHeads, 7}, // which of the three heads are reading the loop
    {"TIME", 20.0f, 1500.0f, 350.0f},          // the MOTOR SPEED — it glides, so a move bends the pitch
    {"INTENSITY", 0.0f, 100.0f, 35.0f},        // feedback; past ~90 it self-oscillates
    {"WOW", 0.0f, 100.0f, 25.0f},
    {"SAT", 0.0f, 100.0f, 30.0f},
    {"BASS", -12.0f, 12.0f, 0.0f},
    {"TREBLE", -12.0f, 12.0f, 0.0f},
    {"SPRING", 0.0f, 100.0f, 0.0f},
    {"WET", 0.0f, 100.0f, 35.0f},
};
const FxParamDef kPlateVerbParams[] = {
    {"PROGRAM", 0.0f, 4.0f, 0.0f, kVerbPrograms, 5},
    {"PREDELAY", 0.0f, 250.0f, 0.0f},
    {"DECAY", 0.2f, 20.0f, 2.0f}, // SECONDS — the loop gain is solved for this RT60
    {"SIZE", 0.0f, 100.0f, 70.0f},
    {"DIFFUSION", 0.0f, 100.0f, 70.0f},
    {"BASS", 0.2f, 4.0f, 1.0f}, // the bass decay MULTIPLIER
    {"DAMP", 0.0f, 100.0f, 40.0f},
    {"MOD", 0.0f, 100.0f, 50.0f},
    {"WET", 0.0f, 100.0f, 30.0f},
};
const FxParamDef kSaturatorParams[] = {
    {"STYLE", 0.0f, 4.0f, 0.0f, kSatStyles, 5},
    {"DRIVE", 0.0f, 100.0f, 0.0f}, // 0 = bit-clean
    {"TONE", -100.0f, 100.0f, 0.0f},
    {"LOWCUT", 20.0f, 1000.0f, 20.0f},
    {"HIGHCUT", 1000.0f, 20000.0f, 20000.0f},
    {"PUNISH", 0.0f, 1.0f, 0.0f, kOffOn, 2},
    {"OUTPUT", -24.0f, 24.0f, 0.0f},
    {"WET", 0.0f, 100.0f, 100.0f},
};
const FxParamDef kLimiterParams[] = {
    {"STYLE", 0.0f, 6.0f, 3.0f, kLimStyleNames, 7},
    {"GAIN", 0.0f, 24.0f, 0.0f},
    {"CEILING", -12.0f, 0.0f, -0.3f},
    {"RELEASE", 1.0f, 1000.0f, 120.0f},
    {"LOOKAHEAD", 0.0f, 20.0f, 3.0f}, // reported as the device's latency, so PDC lines the strip back up
    {"TP", 0.0f, 1.0f, 0.0f, kOffOn, 2},
    {"LINK", 0.0f, 100.0f, 100.0f},
};
const FxParamDef kRetroParams[] = {
    {"NOISE", 0.0f, 100.0f, 0.0f},
    {"NTYPE", 0.0f, 3.0f, 0.0f, kRetroNoise, 4},
    {"WOBBLE", 0.0f, 100.0f, 0.0f},
    {"DISTORT", 0.0f, 100.0f, 0.0f},
    {"DTYPE", 0.0f, 7.0f, 0.0f, kRetroDist, 8},
    {"DIGITAL", 0.0f, 100.0f, 0.0f},
    {"SPACE", 0.0f, 100.0f, 0.0f},
    {"MAGNETIC", 0.0f, 100.0f, 0.0f},
    {"WET", 0.0f, 100.0f, 100.0f},
};
const FxParamDef kReverbParams[] = {
    {"ROOM", 0.0f, 100.0f, 50.0f},
    {"PREDELAY", 0.0f, 100.0f, 10.0f},
    {"DECAY", 0.1f, 10.0f, 2.0f},
    {"WET", 0.0f, 100.0f, 30.0f},
};

// wetParam: the WET the CHAIN crossfades (−1 = fully wet in the chain: no WET, or the device blends internally with
// a latency-matched dry leg — MB SAT, COMP)
const FxTypeInfo kTypes[] = {
    {FxType::none, "", nullptr, 0, -1},
    {FxType::clip, "clip", kClipParams, 1, -1},
    {FxType::wave, "wave", kWaveParams, 1, -1},
    {FxType::sat, "sat", kSatParams, 1, -1},
    {FxType::mbsat, "mbsat", kMbsatParams, 6, -1},
    {FxType::wide, "wide", kWideParams, 1, -1},
    {FxType::mseq, "mseq", kMseqParams, 4, -1},
    {FxType::pan, "pan", kPanParams, 2, -1},
    {FxType::phaser, "phaser", kPhaserParams, 6, 5},
    {FxType::flanger, "flanger", kFlangerParams, 5, 4},
    {FxType::vinyl, "vinyl", kVinylParams, 5, -1},
    {FxType::filter, "filter", kFilterParams, 3, -1},
    {FxType::eq, "eq", kEqParams, 3, -1},
    {FxType::comp, "comp", kCompParams, 6, -1},
    {FxType::sccomp, "sccomp", kSccompParams, 8, -1},
    {FxType::delay, "delay", kDelayParams, 4, 2},
    {FxType::reverb, "reverb", kReverbParams, 4, 3},
    {FxType::utility, "utility", kUtilityParams, 3, -1},
    {FxType::ladder, "ladder", kLadderParams, 5, 4},
    {FxType::fetcomp, "fetcomp", kFetCompParams, 8, 7},
    {FxType::tapeecho, "tapeecho", kTapeEchoParams, 9, 8},
    {FxType::plateverb, "plateverb", kPlateVerbParams, 9, 8},
    {FxType::saturator, "saturator", kSaturatorParams, 8, 7},
    {FxType::limiter, "limiter", kLimiterParams, 7, -1}, // fully wet: a limiter is not a parallel device
    {FxType::retro, "retro", kRetroParams, 9, 8},
};
static_assert(sizeof(kTypes) / sizeof(kTypes[0]) == static_cast<std::size_t>(FxType::count));

/// A pass-through standing in for a device type with no implementation (none left after 4.2b — kept so an unknown
/// type still keeps a page chain's slot indices aligned): reports the type it stands for, passes audio untouched.
class PassFx final : public Effect
{
  public:
    void standFor(FxType t) noexcept TERMINATOR_NONBLOCKING { for_ = t; }
    FxType type() const noexcept TERMINATOR_NONBLOCKING override { return for_; }
    void prepare(double /*sampleRate*/, int /*maxBlockSize*/) override {}
    void reset() noexcept TERMINATOR_NONBLOCKING override {}
    void setParam(int /*index*/, float /*value*/, bool /*immediate*/) noexcept TERMINATOR_NONBLOCKING override {}
    float param(int /*index*/) const noexcept TERMINATOR_NONBLOCKING override { return 0.0f; }
    void process(double* /*l*/, double* /*r*/, int /*numSamples*/) noexcept TERMINATOR_NONBLOCKING override {}

  private:
    FxType for_ = FxType::none;
};

constexpr int kPassCapacity = 64;

int capacityOf(FxType t) noexcept
{
    switch (t)
    {
    case FxType::utility:
    case FxType::eq:
    case FxType::filter:
        return 64;
    case FxType::ladder:
        return 24;
    case FxType::fetcomp:
        return 24;
    case FxType::tapeecho:
        return 12; // a 1.5 s tape at ×2.2 is a few MB of line per instance
    case FxType::plateverb:
        return 8; // the tank is a dozen delay lines, sized for SIZE 100
    case FxType::saturator:
        return 32;
    case FxType::limiter:
        return 16;
    case FxType::retro:
        return 16;
    case FxType::wide:
    case FxType::mseq:
    case FxType::pan:
    case FxType::clip:
    case FxType::wave:
    case FxType::sat:
    case FxType::comp:
    case FxType::sccomp:
        return 32;
    case FxType::mbsat:
    case FxType::phaser:
    case FxType::flanger:
    case FxType::vinyl:
    case FxType::delay:
        return 16;
    case FxType::reverb:
        return 6; // ~27 MB each at 48 k (pre-sized for DECAY 10 s), untouched until used
    default:
        return 0;
    }
}

std::unique_ptr<Effect> make(FxType t)
{
    switch (t)
    {
    case FxType::utility:
        return std::make_unique<UtilityFx>();
    case FxType::eq:
        return std::make_unique<EqFx>();
    case FxType::filter:
        return std::make_unique<FilterFx>();
    case FxType::ladder:
        return std::make_unique<LadderFx>();
    case FxType::fetcomp:
        return std::make_unique<FetCompFx>();
    case FxType::tapeecho:
        return std::make_unique<TapeEchoFx>();
    case FxType::plateverb:
        return std::make_unique<PlateVerbFx>();
    case FxType::saturator:
        return std::make_unique<SaturatorFx>();
    case FxType::limiter:
        return std::make_unique<LimiterFx>();
    case FxType::retro:
        return std::make_unique<RetroFx>();
    case FxType::wide:
        return std::make_unique<WideFx>();
    case FxType::mseq:
        return std::make_unique<MseqFx>();
    case FxType::pan:
        return std::make_unique<PanFx>();
    case FxType::clip:
        return std::make_unique<ClipFx>();
    case FxType::wave:
        return std::make_unique<WaveFx>();
    case FxType::sat:
        return std::make_unique<SatFx>();
    case FxType::mbsat:
        return std::make_unique<MbSatFx>();
    case FxType::phaser:
        return std::make_unique<PhaserFx>();
    case FxType::flanger:
        return std::make_unique<FlangerFx>();
    case FxType::vinyl:
        return std::make_unique<VinylFx>();
    case FxType::comp:
        return std::make_unique<CompFx>();
    case FxType::sccomp:
        return std::make_unique<SidechainFx>();
    case FxType::delay:
        return std::make_unique<DelayFx>();
    case FxType::reverb:
        return std::make_unique<ReverbFx>();
    default:
        return nullptr;
    }
}
} // namespace

const FxTypeInfo& fxTypeInfo(FxType t) noexcept TERMINATOR_NONBLOCKING
{
    const auto i = static_cast<std::size_t>(t);
    return kTypes[i < static_cast<std::size_t>(FxType::count) ? i : 0];
}

FxType fxTypeFromId(const char* id) noexcept
{
    if (id == nullptr)
        return FxType::none;
    for (std::size_t i = 1; i < static_cast<std::size_t>(FxType::count); ++i)
        if (std::strcmp(kTypes[i].id, id) == 0)
            return kTypes[i].type;
    return FxType::none;
}

int fxParamIndex(FxType t, const char* key) noexcept
{
    if (key == nullptr)
        return -1;
    const auto& info = fxTypeInfo(t);
    for (int i = 0; i < info.numParams; ++i)
        if (std::strcmp(info.params[i].key, key) == 0)
            return i;
    return -1;
}

int fxOptionIndex(FxType t, int param, const char* option) noexcept
{
    if (option == nullptr)
        return -1;
    const auto& info = fxTypeInfo(t);
    if (param < 0 || param >= info.numParams || !info.params[param].isEnum())
        return -1;
    for (int i = 0; i < info.params[param].numOptions; ++i)
        if (std::strcmp(info.params[param].options[i], option) == 0)
            return i;
    return -1;
}

// ---- the pool ------------------------------------------------------------------------------------------------

bool FxPool::isPorted(FxType type) noexcept
{
    return capacityOf(type) > 0;
}

void FxPool::prepare(double sampleRate, int maxBlockSize)
{
    if (static_cast<int>(pass_.size()) != kPassCapacity)
    {
        pass_.clear();
        pass_.resize(static_cast<std::size_t>(kPassCapacity));
        for (auto& s : pass_)
            s.fx = std::make_unique<PassFx>();
    }
    for (auto& s : pass_)
        s.used = false;
    for (int t = 0; t < static_cast<int>(FxType::count); ++t)
    {
        auto& v = slots_[t];
        const int cap = capacityOf(static_cast<FxType>(t));
        if (static_cast<int>(v.size()) != cap)
        {
            v.clear();
            v.resize(static_cast<std::size_t>(cap));
            for (auto& s : v)
                s.fx = make(static_cast<FxType>(t));
        }
        for (auto& s : v)
        {
            if (s.fx)
                s.fx->prepare(sampleRate, maxBlockSize);
            s.used = false;
        }
    }
    prepared_ = true;
}

void FxPool::release() noexcept
{
    for (auto& v : slots_)
        v.clear();
    pass_.clear();
    prepared_ = false;
}

Effect* FxPool::acquire(FxType type) noexcept TERMINATOR_NONBLOCKING
{
    const auto i = static_cast<std::size_t>(type);
    if (!prepared_ || i == 0 || i >= static_cast<std::size_t>(FxType::count))
        return nullptr;
    if (!isPorted(type))
    {
        for (auto& s : pass_)
            if (!s.used && s.fx)
            {
                s.used = true;
                static_cast<PassFx*>(s.fx.get())->standFor(type);
                return s.fx.get();
            }
        return nullptr;
    }
    for (auto& s : slots_[i])
        if (!s.used && s.fx)
        {
            s.used = true;
            s.fx->reset();
            return s.fx.get();
        }
    return nullptr;
}

void FxPool::release(Effect* fx) noexcept TERMINATOR_NONBLOCKING
{
    if (fx == nullptr)
        return;
    for (auto& s : pass_)
        if (s.fx.get() == fx)
        {
            s.used = false;
            return;
        }
    const auto i = static_cast<std::size_t>(fx->type());
    if (i >= static_cast<std::size_t>(FxType::count))
        return;
    for (auto& s : slots_[i])
        if (s.fx.get() == fx)
        {
            s.used = false;
            return;
        }
}

int FxPool::capacity(FxType type) const noexcept
{
    const auto i = static_cast<std::size_t>(type);
    return i < static_cast<std::size_t>(FxType::count) ? static_cast<int>(slots_[i].size()) : 0;
}

int FxPool::inUse(FxType type) const noexcept
{
    const auto i = static_cast<std::size_t>(type);
    if (i >= static_cast<std::size_t>(FxType::count))
        return 0;
    int n = 0;
    for (const auto& s : slots_[i])
        n += s.used ? 1 : 0;
    return n;
}

} // namespace terminator
