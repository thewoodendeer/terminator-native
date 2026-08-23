#include "terminator/core/fx/FxPool.h"

#include <cstring>

#include "terminator/core/fx/BasicFx.h"

namespace terminator
{

// ---- the type table (the page's FX_REGISTRY: same keys / ranges / defaults / option strings) ----------------------

namespace
{
const char* const kUtilityModes[] = {"STEREO", "MONO", "MONO-L", "MONO-R"};
const char* const kUtilityPhases[] = {"normal", "inverted"};
const char* const kFilterTypes[] = {"lowpass", "highpass", "bandpass", "notch"};

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

const FxTypeInfo kTypes[] = {
    {FxType::none, "", nullptr, 0, -1},
    {FxType::clip, "clip", nullptr, 0, -1},   // 4.2b
    {FxType::wave, "wave", nullptr, 0, -1},   // 4.2b
    {FxType::sat, "sat", nullptr, 0, -1},     // 4.2b
    {FxType::mbsat, "mbsat", nullptr, 0, -1}, // 4.2b
    {FxType::wide, "wide", kWideParams, 1, -1},
    {FxType::mseq, "mseq", kMseqParams, 4, -1},
    {FxType::pan, "pan", kPanParams, 2, -1},
    {FxType::phaser, "phaser", nullptr, 0, -1},   // 4.2b
    {FxType::flanger, "flanger", nullptr, 0, -1}, // 4.2b
    {FxType::vinyl, "vinyl", nullptr, 0, -1},     // 4.2b
    {FxType::filter, "filter", kFilterParams, 3, -1},
    {FxType::eq, "eq", kEqParams, 3, -1},
    {FxType::comp, "comp", nullptr, 0, -1},     // 4.2b
    {FxType::sccomp, "sccomp", nullptr, 0, -1}, // 4.2b
    {FxType::delay, "delay", nullptr, 0, -1},   // 4.2b
    {FxType::reverb, "reverb", nullptr, 0, -1}, // 4.2b
    {FxType::utility, "utility", kUtilityParams, 3, -1},
};
static_assert(sizeof(kTypes) / sizeof(kTypes[0]) == static_cast<std::size_t>(FxType::count));

/// A pass-through standing in for a device type that is not ported yet: reports the type it stands for, has the
/// type's (empty) param table, passes audio untouched.
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
    case FxType::wide:
    case FxType::mseq:
    case FxType::pan:
        return 32;
    default:
        return 0; // not ported yet
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
    case FxType::wide:
        return std::make_unique<WideFx>();
    case FxType::mseq:
        return std::make_unique<MseqFx>();
    case FxType::pan:
        return std::make_unique<PanFx>();
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
