#include "terminator/core/Mixer.h"

#include <algorithm>
#include <cmath>

#include "terminator/core/fx/FxPool.h"

namespace terminator
{

namespace
{
constexpr double kHalfPi = 1.57079632679489661923;

struct PanMatrix
{
    double ll, rl, lr, rr; // L' = L·ll + R·rl ; R' = R·rr + L·lr
};

/// The Web Audio StereoPanner law for a STEREO input (spec §StereoPannerNode "stereo"): pan ≤ 0 → x = pan+1,
/// L' = L + R·cos(x·π/2), R' = R·sin(x·π/2); pan > 0 → x = pan, L' = L·cos(x·π/2), R' = R + L·sin(x·π/2).
PanMatrix panMatrix(double pan) noexcept
{
    pan = std::clamp(pan, -1.0, 1.0);
    if (pan == 0.0)
        return {1.0, 0.0, 0.0, 1.0};
    if (pan <= 0.0)
    {
        const double x = (pan + 1.0) * kHalfPi;
        return {1.0, std::cos(x), 0.0, std::sin(x)};
    }
    const double x = pan * kHalfPi;
    return {std::cos(x), 0.0, std::sin(x), 1.0};
}
} // namespace

// ---- MeterTap ---------------------------------------------------------------------------------------

void Mixer::MeterTap::push(float peakL, float peakR, double sumSq, int count) noexcept
{
    pkL[head] = peakL;
    pkR[head] = peakR;
    ss[head] = sumSq;
    n[head] = count;
    head = (head + 1) % kMeterRing;
}

void Mixer::MeterTap::read(float& outPkL, float& outPkR, float& outRms) const noexcept
{
    float l = 0.0f, r = 0.0f;
    double s = 0.0;
    int count = 0;
    for (int k = 0; k < kMeterRing && count < kMeterWindowSamples; ++k)
    {
        const int i = (head - 1 - k + kMeterRing * 2) % kMeterRing;
        if (n[i] <= 0)
            break; // never written (ring not full yet)
        l = std::max(l, pkL[i]);
        r = std::max(r, pkR[i]);
        s += ss[i];
        count += n[i];
    }
    outPkL = l;
    outPkR = r;
    outRms = count > 0 ? static_cast<float>(std::sqrt(s / (2.0 * static_cast<double>(count)))) : 0.0f;
}

void Mixer::MeterTap::clear() noexcept
{
    for (int i = 0; i < kMeterRing; ++i)
    {
        pkL[i] = pkR[i] = 0.0f;
        ss[i] = 0.0;
        n[i] = 0;
    }
    head = 0;
}

// ---- lifecycle ---------------------------------------------------------------------------------------

float Mixer::dbToGain(float db) noexcept
{
    if (db <= kFaderMinDb + 0.5f) // ≤ −59.5 dB snaps to −∞ (the TS fader's own rule)
        return 0.0f;
    return std::exp(std::min(db, kFaderMaxDb) * 0.11512925464970229f); // ln(10)/20
}

void Mixer::saveChains()
{
    savedChains_.assign(static_cast<std::size_t>(kMaxStrips) * kMaxInserts, SavedSlot{});
    savedChainCount_.assign(static_cast<std::size_t>(kMaxStrips), 0);
    for (int i = 0; i < kMaxStrips; ++i)
    {
        const auto& st = strips_[i];
        savedChainCount_[static_cast<std::size_t>(i)] = st.fxCount;
        for (int k = 0; k < st.fxCount; ++k)
        {
            if (st.fx[k] == nullptr)
                continue;
            auto& sv = savedChains_[static_cast<std::size_t>(i) * kMaxInserts + static_cast<std::size_t>(k)];
            sv.type = st.fx[k]->type();
            sv.bypass = st.fxBypass[k];
            sv.numParams = std::min(st.fx[k]->numParams(), kMaxFxParams);
            for (int q = 0; q < sv.numParams; ++q)
                sv.params[q] = st.fx[k]->param(q);
        }
    }
    haveSavedChains_ = true;
}

void Mixer::prepare(double sampleRate, int maxBlockSize, bool keepState)
{
    const bool restoreChains = keepState && haveSavedChains_;

    TERMINATOR_RT_ASSERT(sampleRate > 0.0 && maxBlockSize > 0);
    sampleRate_ = sampleRate;
    maxBlock_ = maxBlockSize;
    const auto n = static_cast<std::size_t>(maxBlockSize);
    inputs_.assign(static_cast<std::size_t>(kMaxStrips) * 2 * n, 0.0);
    trash_.assign(2 * n, 0.0);
    outL_.assign(n, 0.0);
    outR_.assign(n, 0.0);
    wetL_.assign(n, 0.0);
    msA_.assign(n, 0.0);
    msB_.assign(n, 0.0);
    compDelays_.resize(static_cast<std::size_t>(kMaxRoutedLatencySlots));
    for (auto& c : compDelays_)
    {
        c.a.prepare(kMaxPdcSamples, maxBlockSize);
        c.b.prepare(kMaxPdcSamples, maxBlockSize);
        c.used = false;
    }
    keys_.assign(static_cast<std::size_t>(kMaxStrips) * 2 * n, 0.0);
    silence_.assign(n, 0.0);
    wetR_.assign(n, 0.0);
    inputPtrs_.assign(static_cast<std::size_t>(kMaxStrips) * 2, nullptr);
    if (!prepared_)
    {
        for (auto& s : strips_)
            s = Strip{};
        strips_[kMasterStrip].set.kind = StripKind::master;
        strips_[kMasterStrip].set.outKind = StripOutput::hardware;
        strips_[kMasterStrip].set.outIndex = 0;
        mainOut_ = 0;
        rejected_ = 0;
    }
    limiter_.prepare(static_cast<float>(sampleRate));
    limiter_.setPreDelayTime(0.006f);
    loudness_.prepare(sampleRate);
    toMasterL_.prepare(kMaxPdcSamples, maxBlock_);
    toMasterR_.prepare(kMaxPdcSamples, maxBlock_);
    masterDirectL_.assign(static_cast<std::size_t>(n), 0.0);
    masterDirectR_.assign(static_cast<std::size_t>(n), 0.0);
    pdcMaxChan_ = pdcMaxBus_ = 0;
    // the settings survive a re-prepare (a device change): only the smoothed state + meters restart at the targets;
    // the insert chains are DROPPED (the pool re-prepares and frees every device — the page re-sends its chains)
    for (int i = 0; i < kMaxStrips; ++i)
    {
        auto& s = strips_[i];
        for (int k = 0; k < kMaxInserts; ++k)
        {
            s.fx[k] = nullptr;
            s.fxBypass[k] = false;
        }
        s.fxCount = 0;
        s.faderCur = dbToGain(s.set.faderDb);
        s.panCur = s.set.pan;
        s.widthCur = s.set.width;
        for (int k = 0; k < kMaxSends; ++k)
            s.sendCur[k] = dbToGain(s.set.sendDb[k]);
        s.pre.clear();
        s.post.clear();
        s.meter = StripMeter{};
        s.console.prepare(sampleRate);
        s.console.configure(i == kMasterStrip, s.seed);
        s.console.set(consoleFlavour_, consoleAmount_ * 0.01f, true);
        s.pdc = 0;
        s.pdcL.prepare(kMaxPdcSamples, maxBlock_);
        s.pdcR.prepare(kMaxPdcSamples, maxBlock_);
        const bool live = s.set.kind != StripKind::off;
        inputPtrs_[static_cast<std::size_t>(i) * 2] =
            live ? inputs_.data() + static_cast<std::size_t>(i) * 2 * n : trash_.data();
        inputPtrs_[static_cast<std::size_t>(i) * 2 + 1] =
            live ? inputs_.data() + (static_cast<std::size_t>(i) * 2 + 1) * n : trash_.data() + n;
    }
    prepared_ = true;
    updateSilence();
    for (int i = 0; i < kMaxStrips; ++i)
        strips_[i].muteCur = ((silentMask_ >> i) & 1u) ? 0.0f : 1.0f;
    if (restoreChains)
    {
        haveSavedChains_ = false;
        // the pool is prepared and every chain was just dropped — put each strip's devices back, in order, with
        // their params and bypass (the page never learns the device changed)
        for (int i = 0; i < kMaxStrips; ++i)
        {
            for (int k = 0; k < savedChainCount_[static_cast<std::size_t>(i)]; ++k)
            {
                const auto& sv = savedChains_[static_cast<std::size_t>(i) * kMaxInserts + static_cast<std::size_t>(k)];
                if (sv.type == FxType::none || !addFx(i, sv.type))
                    continue;
                const int slot = strips_[i].fxCount - 1;
                for (int q = 0; q < sv.numParams; ++q)
                    setFxParam(i, slot, q, sv.params[q], true);
                setFxBypass(i, slot, sv.bypass);
            }
        }
    }
    rebuildPdc();
    rebuildOrder();
}

void Mixer::reset() noexcept
{
    for (auto& s : strips_)
    {
        s.pre.clear();
        s.post.clear();
        s.meter = StripMeter{};
    }
}

// ---- commands ----------------------------------------------------------------------------------------

void Mixer::setStripKind(int strip, StripKind kind) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    if (strip == kMasterStrip)
        kind = StripKind::master; // the master is always the master
    else if (kind == StripKind::master)
        kind = StripKind::channel; // only strip 0 is
    auto& s = strips_[strip];
    const bool wasLive = s.set.kind != StripKind::off;
    s.set.kind = kind;
    const bool live = kind != StripKind::off;
    if (prepared_)
    {
        const auto n = static_cast<std::size_t>(maxBlock_);
        inputPtrs_[static_cast<std::size_t>(strip) * 2] =
            live ? inputs_.data() + static_cast<std::size_t>(strip) * 2 * n : trash_.data();
        inputPtrs_[static_cast<std::size_t>(strip) * 2 + 1] =
            live ? inputs_.data() + (static_cast<std::size_t>(strip) * 2 + 1) * n : trash_.data() + n;
        if (live && !wasLive)
        {
            // a (re)activated strip starts AT its targets — no ramp from a stale state, no meter history
            s.faderCur = dbToGain(s.set.faderDb);
            s.panCur = s.set.pan;
            s.widthCur = s.set.width;
            for (int k = 0; k < kMaxSends; ++k)
                s.sendCur[k] = dbToGain(s.set.sendDb[k]);
            s.pre.clear();
            s.post.clear();
            s.meter = StripMeter{};
            s.console.reset();
            s.console.set(consoleFlavour_, consoleAmount_ * 0.01f, true);
            s.pdcL.reset();
            s.pdcR.reset();
            std::fill_n(inputPtrs_[static_cast<std::size_t>(strip) * 2], n, 0.0);
            std::fill_n(inputPtrs_[static_cast<std::size_t>(strip) * 2 + 1], n, 0.0);
        }
    }
    if (!live)
    {
        s.meter = StripMeter{};
        s.stemTap = -1;
        clearFx(strip); // the devices go back to the pool (the page re-adds them with the channel)
    }
    updateSilence();
    if (live && !wasLive)
        s.muteCur = (silentMask_ >> strip) & 1u ? 0.0f : 1.0f;
    rebuildPdc(); // a strip joining / leaving the mix changes maxChan / maxBus
    rebuildOrder();
}

void Mixer::setFader(int strip, float db) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    strips_[strip].set.faderDb = std::clamp(db, kFaderMinDb, kFaderMaxDb);
}

void Mixer::setPan(int strip, float pan) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    strips_[strip].set.pan = std::clamp(pan, -1.0f, 1.0f);
}

void Mixer::setWidth(int strip, float width) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    strips_[strip].set.width = std::clamp(width, 0.0f, 2.0f);
}

void Mixer::setMute(int strip, bool on) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    strips_[strip].set.mute = on ? 1 : 0;
    updateSilence();
}

void Mixer::setSolo(int strip, bool on) noexcept TERMINATOR_NONBLOCKING
{
    if (strip <= kMasterStrip || strip >= kMaxStrips) // the master has no solo
        return;
    strips_[strip].set.solo = on ? 1 : 0;
    updateSilence();
}

bool Mixer::setSend(int strip, int send, float db, int target) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips || send < 0 || send >= kMaxSends)
        return false;
    auto& s = strips_[strip];
    s.set.sendDb[send] = std::clamp(db, kFaderMinDb, kFaderMaxDb);
    if (target >= kMaxStrips)
        target = -1;
    if (target < 0)
    {
        s.set.sendTarget[send] = -1;
        rebuildOrder();
        return true;
    }
    // the guard: never to itself, never to the master through a send (the master is the output leg), never a loop
    if (target == strip || target == kMasterStrip || strip == kMasterStrip || reaches(target, strip))
    {
        ++rejected_;
        return false;
    }
    s.set.sendTarget[send] = static_cast<std::int16_t>(target);
    rebuildOrder();
    return true;
}

bool Mixer::setOutput(int strip, StripOutput kind, int index) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return false;
    auto& s = strips_[strip];
    if (strip == kMasterStrip)
    {
        // the master only goes to hardware (setMainOut) — anything else is refused
        if (kind != StripOutput::hardware)
        {
            ++rejected_;
            return false;
        }
        setMainOut(index);
        return true;
    }
    switch (kind)
    {
    case StripOutput::master:
        s.set.outKind = kind;
        s.set.outIndex = kMasterStrip;
        break;
    case StripOutput::strip:
        if (index < 0 || index >= kMaxStrips || index == strip || reaches(index, strip))
        {
            ++rejected_;
            return false;
        }
        s.set.outKind = kind;
        s.set.outIndex = static_cast<std::int16_t>(index);
        break;
    case StripOutput::hardware:
        s.set.outKind = kind;
        s.set.outIndex = static_cast<std::int16_t>(std::clamp(index, 0, 63));
        break;
    case StripOutput::none:
        s.set.outKind = kind;
        s.set.outIndex = -1;
        break;
    }
    rebuildOrder();
    return true;
}

void Mixer::setStripSeed(int strip, std::uint32_t seed) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    auto& s = strips_[strip];
    if (s.seed == seed)
        return;
    s.seed = seed;
    s.console.configure(strip == kMasterStrip, seed);
    s.console.set(consoleFlavour_, consoleAmount_ * 0.01f, true);
}

void Mixer::setMasterLimiter(bool on) noexcept TERMINATOR_NONBLOCKING
{
    if (on && !limiterOn_)
    {
        limiter_.reset(); // a fresh node (Blink's: the detector from 0 — its start-up dip, the page's)
        limiter_.setPreDelayTime(0.006f);
    }
    limiterOn_ = on;
}

void Mixer::setConsole(bool on, ConsoleFlavour flavour, float amount) noexcept TERMINATOR_NONBLOCKING
{
    const bool wasOn = consoleOn_;
    consoleOn_ = on;
    consoleFlavour_ = flavour;
    consoleAmount_ = std::clamp(amount, 0.0f, 100.0f);
    for (auto& s : strips_)
    {
        if (on && !wasOn)
            s.console.reset(); // the page builds a fresh stage when CONSOLE comes on — it starts AT the setting
        s.console.set(flavour, consoleAmount_ * 0.01f, on && !wasOn);
    }
}

void Mixer::setMainOut(int pair) noexcept TERMINATOR_NONBLOCKING
{
    mainOut_ = std::clamp(pair, 0, 63);
    strips_[kMasterStrip].set.outKind = StripOutput::hardware;
    strips_[kMasterStrip].set.outIndex = static_cast<std::int16_t>(mainOut_);
}

// ---- the insert chain (4.2) -------------------------------------------------------------------------

bool Mixer::addFx(int strip, FxType type) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips || pool_ == nullptr)
        return false;
    auto& s = strips_[strip];
    if (s.set.kind == StripKind::off || s.fxCount >= kMaxInserts)
    {
        ++fxRejected_;
        return false;
    }
    Effect* e = pool_->acquire(type);
    if (e == nullptr)
    {
        ++fxRejected_;
        return false;
    }
    s.fx[s.fxCount] = e;
    s.fxBypass[s.fxCount] = false;
    ++s.fxCount;
    rebuildKeyMask();
    rebuildPdc();
    return true;
}

bool Mixer::removeFx(int strip, int index) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return false;
    auto& s = strips_[strip];
    if (index < 0 || index >= s.fxCount)
        return false;
    if (pool_ != nullptr)
        pool_->release(s.fx[index]);
    for (int k = index; k + 1 < s.fxCount; ++k)
    {
        s.fx[k] = s.fx[k + 1];
        s.fxBypass[k] = s.fxBypass[k + 1];
    }
    --s.fxCount;
    s.fx[s.fxCount] = nullptr;
    s.fxBypass[s.fxCount] = false;
    rebuildKeyMask();
    rebuildPdc();
    return true;
}

float Mixer::fxGainReductionDb(int strip, int index) const noexcept TERMINATOR_NONBLOCKING
{
    const auto& s = strips_[clampIdx(strip)];
    return (index >= 0 && index < s.fxCount && s.fx[index] != nullptr) ? s.fx[index]->gainReductionDb() : 0.0f;
}

void Mixer::rebuildPdc() noexcept TERMINATOR_NONBLOCKING
{
    // tier 1 = channels, tier 2 = sends + buses; the master is neither (its own chain latency is the mix's latency)
    int maxChan = 0, maxBus = 0;
    for (int i = 1; i < kMaxStrips; ++i)
    {
        const auto& s = strips_[i];
        if (s.set.kind == StripKind::off)
            continue;
        const int own = std::min(chainLatencySamples(i), kMaxPdcSamples);
        if (s.set.kind == StripKind::channel)
            maxChan = std::max(maxChan, own);
        else
            maxBus = std::max(maxBus, own);
    }
    pdcMaxChan_ = maxChan;
    pdcMaxBus_ = maxBus;
    for (int i = 0; i < kMaxStrips; ++i)
    {
        auto& s = strips_[i];
        if (i == kMasterStrip || s.set.kind == StripKind::off)
        {
            s.pdc = 0;
            continue;
        }
        const int own = std::min(chainLatencySamples(i), kMaxPdcSamples);
        s.pdc = std::max(0, (s.set.kind == StripKind::channel ? maxChan : maxBus) - own);
    }
}

void Mixer::setPdc(bool on) noexcept TERMINATOR_NONBLOCKING
{
    pdcOn_ = on;
}

void Mixer::setStemTap(int strip, int pair) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    strips_[strip].stemTap = pair < 0 ? -1 : pair;
}

int Mixer::outputLatencySamples(int strip) const noexcept
{
    const int i = clampIdx(strip);
    const auto& s = strips_[i];
    // the strip's own chain plus the alignment delay behind it: for a live strip with PDC on those add up to the
    // TIER (maxChan for a channel, maxBus for a send/bus on top of maxChan), which is the point of the plan
    const int own = std::min(chainLatencySamples(i), kMaxPdcSamples);
    const int aligned = own + (pdcOn_ ? s.pdc : 0);
    if (i != kMasterStrip)
        return aligned;
    // the master: what reached its INPUT (tier 1 + tier 2), then its own chain, then the limiter's look-ahead
    const int upstream = pdcOn_ ? pdcMaxChan_ + pdcMaxBus_ : 0;
    return upstream + own + masterLatencySamples();
}

void Mixer::rebuildKeyMask() noexcept TERMINATOR_NONBLOCKING
{
    std::uint64_t m = 0;
    for (const auto& s : strips_)
        for (int k = 0; k < s.fxCount; ++k)
            if (s.fx[k] != nullptr)
            {
                const int src = s.fx[k]->sidechainSource();
                if (src >= 0 && src < kMaxStrips)
                    m |= std::uint64_t{1} << src;
            }
    keyMask_ = m;
}

void Mixer::setFxBypass(int strip, int index, bool on) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    auto& s = strips_[strip];
    if (index < 0 || index >= s.fxCount)
        return;
    s.fxBypass[index] = on;
    rebuildPdc(); // a bypassed device contributes no latency — the plan moves
}

void Mixer::setFxRoute(int strip, int index, FxRoute route) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    auto& s = strips_[strip];
    if (index < 0 || index >= s.fxCount || s.fx[index] == nullptr)
        return;
    // hand back whatever this slot was holding before deciding what it needs now
    if (s.fxCompDelay[index] >= 0)
    {
        compDelays_[static_cast<std::size_t>(s.fxCompDelay[index])].used = false;
        s.fxCompDelay[index] = -1;
    }
    if (route != FxRoute::stereo && s.fx[index]->latencySamples() > 0)
    {
        int slot = -1;
        for (int i = 0; i < static_cast<int>(compDelays_.size()); ++i)
            if (!compDelays_[static_cast<std::size_t>(i)].used)
            {
                slot = i;
                break;
            }
        if (slot < 0)
        {
            // No line free. Routing anyway would comb-filter the two halves against each other, which sounds like
            // a broken plugin and is impossible to diagnose by ear — so the slot stays STEREO and says so.
            s.fxRoute[index] = FxRoute::stereo;
            ++routeRejected_;
            return;
        }
        compDelays_[static_cast<std::size_t>(slot)].used = true;
        compDelays_[static_cast<std::size_t>(slot)].a.reset();
        compDelays_[static_cast<std::size_t>(slot)].b.reset();
        s.fxCompDelay[index] = slot;
    }
    s.fxRoute[index] = route;
}

FxRoute Mixer::fxRoute(int strip, int index) const noexcept
{
    const auto& s = strips_[clampIdx(strip)];
    return (index >= 0 && index < s.fxCount) ? s.fxRoute[index] : FxRoute::stereo;
}

void Mixer::setFxParam(int strip, int index, int param, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    auto& s = strips_[strip];
    if (index < 0 || index >= s.fxCount || s.fx[index] == nullptr)
        return;
    if (param < 0 || param >= s.fx[index]->numParams())
        return;
    // A PARAM CAN CHANGE A DEVICE'S LATENCY (the LIMITER's LOOKAHEAD, its TRUE-PEAK switch). PDC is only rebuilt
    // when a device is added / removed / bypassed, so without this the plan would keep compensating for the old
    // number and that strip would sit off the grid — silently, because nothing sounds broken, it just is not where
    // the others are. Rebuild only when the number actually moved, so a knob drag costs one comparison.
    const int before = s.fx[index]->latencySamples();
    s.fx[index]->setParam(param, value, immediate);
    if (s.fx[index]->latencySamples() != before)
        rebuildPdc();
    if (s.fx[index]->type() == FxType::sccomp)
        rebuildKeyMask();
}

bool Mixer::reorderFx(int strip, int from, int to) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return false;
    auto& s = strips_[strip];
    if (from < 0 || from >= s.fxCount || to < 0 || to >= s.fxCount)
        return false;
    if (from == to)
        return true;
    Effect* e = s.fx[from];
    const bool b = s.fxBypass[from];
    if (from < to)
        for (int k = from; k < to; ++k)
        {
            s.fx[k] = s.fx[k + 1];
            s.fxBypass[k] = s.fxBypass[k + 1];
        }
    else
        for (int k = from; k > to; --k)
        {
            s.fx[k] = s.fx[k - 1];
            s.fxBypass[k] = s.fxBypass[k - 1];
        }
    s.fx[to] = e;
    s.fxBypass[to] = b;
    return true;
}

void Mixer::clearFx(int strip) noexcept TERMINATOR_NONBLOCKING
{
    if (strip < 0 || strip >= kMaxStrips)
        return;
    auto& s = strips_[strip];
    for (int k = 0; k < s.fxCount; ++k)
    {
        if (pool_ != nullptr)
            pool_->release(s.fx[k]);
        s.fx[k] = nullptr;
        s.fxBypass[k] = false;
        s.fxRoute[k] = FxRoute::stereo;
        if (s.fxCompDelay[k] >= 0)
        {
            compDelays_[static_cast<std::size_t>(s.fxCompDelay[k])].used = false;
            s.fxCompDelay[k] = -1;
        }
    }
    s.fxCount = 0;
    rebuildKeyMask();
    rebuildPdc();
}

FxType Mixer::fxType(int strip, int index) const noexcept
{
    const auto& s = strips_[clampIdx(strip)];
    return (index >= 0 && index < s.fxCount && s.fx[index] != nullptr) ? s.fx[index]->type() : FxType::none;
}

bool Mixer::fxBypassed(int strip, int index) const noexcept
{
    const auto& s = strips_[clampIdx(strip)];
    return index >= 0 && index < s.fxCount && s.fxBypass[index];
}

const Effect* Mixer::fx(int strip, int index) const noexcept
{
    const auto& s = strips_[clampIdx(strip)];
    return (index >= 0 && index < s.fxCount) ? s.fx[index] : nullptr;
}

int Mixer::chainLatencySamples(int strip) const noexcept
{
    const auto& s = strips_[clampIdx(strip)];
    int total = 0;
    for (int k = 0; k < s.fxCount; ++k)
        if (s.fx[k] != nullptr && !s.fxBypass[k])
            total += s.fx[k]->latencySamples();
    return total;
}

// ---- the graph ----------------------------------------------------------------------------------------

bool Mixer::reaches(int from, int to) const noexcept TERMINATOR_NONBLOCKING
{
    if (from < 0 || from >= kMaxStrips || to < 0 || to >= kMaxStrips)
        return false;
    if (from == to)
        return true;
    int stack[kMaxStrips];
    int sp = 0;
    std::uint64_t seen = 0;
    stack[sp++] = from;
    seen |= 1ull << from;
    while (sp > 0)
    {
        const int i = stack[--sp];
        const auto& st = strips_[i].set;
        int next[kMaxSends + 1];
        int nn = 0;
        if (i != kMasterStrip)
        {
            if (st.outKind == StripOutput::master)
                next[nn++] = kMasterStrip;
            else if (st.outKind == StripOutput::strip && st.outIndex >= 0)
                next[nn++] = st.outIndex;
            for (int k = 0; k < kMaxSends; ++k)
                if (st.sendTarget[k] >= 0)
                    next[nn++] = st.sendTarget[k];
        }
        for (int k = 0; k < nn; ++k)
        {
            const int j = next[k];
            if (j == to)
                return true;
            if ((seen >> j) & 1u)
                continue;
            seen |= 1ull << j;
            if (sp < kMaxStrips)
                stack[sp++] = j;
        }
    }
    return false;
}

void Mixer::rebuildOrder() noexcept TERMINATOR_NONBLOCKING
{
    // Kahn over every strip (dead ones included — harmless, they are skipped in process): edges = outputs + sends
    int indeg[kMaxStrips] = {};
    for (int i = 0; i < kMaxStrips; ++i)
    {
        if (i == kMasterStrip)
            continue;
        const auto& st = strips_[i].set;
        if (st.outKind == StripOutput::master)
            ++indeg[kMasterStrip];
        else if (st.outKind == StripOutput::strip && st.outIndex >= 0 && st.outIndex < kMaxStrips)
            ++indeg[st.outIndex];
        for (int k = 0; k < kMaxSends; ++k)
            if (st.sendTarget[k] >= 0 && st.sendTarget[k] < kMaxStrips)
                ++indeg[st.sendTarget[k]];
    }
    int queue[kMaxStrips];
    int qh = 0, qt = 0;
    for (int i = 0; i < kMaxStrips; ++i)
        if (indeg[i] == 0)
            queue[qt++] = i;
    int count = 0;
    while (qh < qt)
    {
        const int i = queue[qh++];
        order_[count++] = i;
        if (i == kMasterStrip)
            continue;
        const auto& st = strips_[i].set;
        auto relax = [&](int j) noexcept
        {
            if (j >= 0 && j < kMaxStrips && --indeg[j] == 0 && qt < kMaxStrips)
                queue[qt++] = j;
        };
        if (st.outKind == StripOutput::master)
            relax(kMasterStrip);
        else if (st.outKind == StripOutput::strip)
            relax(st.outIndex);
        for (int k = 0; k < kMaxSends; ++k)
            if (st.sendTarget[k] >= 0)
                relax(st.sendTarget[k]);
    }
    if (count == kMaxStrips)
    {
        orderCount_ = count;
        orderValid_ = true;
        return;
    }
    // a cycle slipped through (cannot with the guard) — fall back: index order, master last
    orderValid_ = false;
    orderCount_ = 0;
    for (int i = 1; i < kMaxStrips; ++i)
        order_[orderCount_++] = i;
    order_[orderCount_++] = kMasterStrip;
}

void Mixer::updateSilence() noexcept TERMINATOR_NONBLOCKING
{
    bool anySolo = false;
    std::uint64_t active = 0;
    for (int i = 0; i < kMaxStrips; ++i)
    {
        const auto& st = strips_[i].set;
        if (st.kind == StripKind::off)
            continue;
        active |= 1ull << i;
        if (i != kMasterStrip && st.solo != 0)
            anySolo = true;
    }
    std::uint64_t silent = 0;
    for (int i = 0; i < kMaxStrips; ++i)
    {
        const auto& st = strips_[i].set;
        if (st.kind == StripKind::off)
            continue;
        const bool s = st.mute != 0 || (i != kMasterStrip && anySolo && st.solo == 0);
        if (s)
            silent |= 1ull << i;
    }
    activeMask_ = active;
    silentMask_ = silent;
}

// ---- the block --------------------------------------------------------------------------------------

void Mixer::clearInputs(int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    if (!prepared_)
        return;
    const auto n = static_cast<std::size_t>(std::clamp(numSamples, 0, maxBlock_));
    for (int i = 0; i < kMaxStrips; ++i)
    {
        if (strips_[i].set.kind == StripKind::off)
            continue;
        std::fill_n(inputPtrs_[static_cast<std::size_t>(i) * 2], n, 0.0);
        std::fill_n(inputPtrs_[static_cast<std::size_t>(i) * 2 + 1], n, 0.0);
    }
    std::fill_n(trash_.data(), n, 0.0);
    std::fill_n(trash_.data() + static_cast<std::size_t>(maxBlock_), n, 0.0);
}

void Mixer::addToStrip(int strip, const float* l, const float* r, int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    if (!prepared_ || strip < 0 || strip >= kMaxStrips || l == nullptr || strips_[strip].set.kind == StripKind::off)
        return;
    const int n = std::clamp(numSamples, 0, maxBlock_);
    double* L = inputPtrs_[static_cast<std::size_t>(strip) * 2];
    double* R = inputPtrs_[static_cast<std::size_t>(strip) * 2 + 1];
    const float* rr = r != nullptr ? r : l;
    for (int i = 0; i < n; ++i)
    {
        L[i] += static_cast<double>(l[i]);
        R[i] += static_cast<double>(rr[i]);
    }
}

void Mixer::process(float* const* outputs, int numOut, int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    if (!prepared_ || numSamples <= 0)
        return;
    const int n = std::min(numSamples, maxBlock_);
    processedMask_ = 0;
    if (pdcOn_ && pdcMaxBus_ > 0)
    {
        // the tier-2 direct leg is summed apart this block, then delayed once (see processStrip)
        std::fill_n(masterDirectL_.data(), n, 0.0);
        std::fill_n(masterDirectR_.data(), n, 0.0);
    }
    for (int k = 0; k < orderCount_; ++k)
    {
        const int idx = order_[k];
        if (strips_[idx].set.kind == StripKind::off)
            continue;
        processStrip(idx, outputs, numOut, n);
        processedMask_ |= std::uint64_t{1} << idx;
    }
}

void Mixer::processStrip(int idx, float* const* outputs, int numOut, int n) noexcept TERMINATOR_NONBLOCKING
{
    auto& s = strips_[idx];
    const bool isMaster = idx == kMasterStrip;
    double* inL = inputPtrs_[static_cast<std::size_t>(idx) * 2];
    double* inR = inputPtrs_[static_cast<std::size_t>(idx) * 2 + 1];
    double* oL = outL_.data();
    double* oR = outR_.data();
    // ---- PDC tier 2 (4.4): the CHANNELS' direct leg to the master was summed apart this block; it arrives delayed
    // by maxBus so it lands with the bus / send returns (which carry maxChan + their own tier-2 alignment). One line
    // on the sum, not one per strip — linear, so identical to the page's per-strip toMaster delays and far cheaper.
    if (isMaster && pdcOn_ && pdcMaxBus_ > 0)
    {
        toMasterL_.process(masterDirectL_.data(), n, pdcMaxBus_);
        toMasterR_.process(masterDirectR_.data(), n, pdcMaxBus_);
        for (int i = 0; i < n; ++i)
        {
            inL[i] += masterDirectL_[static_cast<std::size_t>(i)];
            inR[i] += masterDirectR_[static_cast<std::size_t>(i)];
        }
    }
    const double invN = 1.0 / static_cast<double>(n);
    // one exp per strip per block: the closed-form one-pole (setTargetAtTime τ) from the block start to its end
    const float a = std::exp(-static_cast<float>(n) / (kMixerSmoothSec * static_cast<float>(sampleRate_)));
    // the one-pole never REACHES its target on its own: within 1e-6 (−120 dB of full scale) it takes it — a fader at
    // −60 dB is exact silence, a fader back at 0 dB is exactly unity again (bit-identical to the direct path)
    auto approach = [a](float cur, float target) noexcept
    {
        const float e = target + (cur - target) * a;
        return (e - target <= 1e-6f && target - e <= 1e-6f) ? target : e;
    };

    // ---- the sidechain key: a strip some SC COMP listens to keeps a copy of its input BEFORE its own inserts ----
    if ((keyMask_ >> idx) & 1u)
    {
        std::copy_n(inL, n, keys_.data() + static_cast<std::size_t>(idx) * 2 * static_cast<std::size_t>(maxBlock_));
        std::copy_n(inR, n,
                    keys_.data() + (static_cast<std::size_t>(idx) * 2 + 1) * static_cast<std::size_t>(maxBlock_));
    }

    // ---- pre meter (the strip's input, what the sources summed) ----
    {
        float pl = 0.0f, pr = 0.0f;
        double ss = 0.0;
        for (int i = 0; i < n; ++i)
        {
            const float l = static_cast<float>(inL[i]), r = static_cast<float>(inR[i]);
            const float al = l < 0.0f ? -l : l, ar = r < 0.0f ? -r : r;
            pl = al > pl ? al : pl;
            pr = ar > pr ? ar : pr;
            ss += inL[i] * inL[i] + inR[i] * inR[i];
        }
        s.pre.push(pl, pr, ss, n);
    }

    // ---- CONSOLE (4.2c): the desk stage — channel role on every strip, bus role on the master ----
    if (consoleOn_)
        s.console.process(inL, inR, n);

    // ---- the inserts (4.2): in place on the strip's input, in order; bypass = skipped (dry, bit-exact); a device
    // with a WET param crossfades (dry 1−mix + wet mix — the TS WetDry, a true crossfade) ----
    for (int k = 0; k < s.fxCount; ++k)
    {
        Effect* e = s.fx[k];
        if (e == nullptr || s.fxBypass[k])
            continue;
        const int src = e->sidechainSource();
        if (src >= 0)
        {
            // the key = the source strip's pre-insert input: the copy if that strip already ran this block (or is
            // this one — its input is being mutated right here), its live accumulator otherwise; a dead source =
            // silence
            const bool liveSrc = src < kMaxStrips && strips_[src].set.kind != StripKind::off;
            const bool copied = src == idx || ((processedMask_ >> src) & 1u);
            const double* kl =
                !liveSrc ? silence_.data()
                : copied ? keys_.data() + static_cast<std::size_t>(src) * 2 * static_cast<std::size_t>(maxBlock_)
                         : inputPtrs_[static_cast<std::size_t>(src) * 2];
            const double* kr =
                !liveSrc ? silence_.data()
                : copied ? keys_.data() + (static_cast<std::size_t>(src) * 2 + 1) * static_cast<std::size_t>(maxBlock_)
                         : inputPtrs_[static_cast<std::size_t>(src) * 2 + 1];
            e->setSidechainKey(kl, kr);
        }
        const float mix = e->wetMix();
        const FxRoute route = s.fxRoute[k];
        if (route == FxRoute::stereo && mix >= 1.0f)
        {
            e->process(inL, inR, n); // the common path, untouched: in place, no copy
            continue;
        }
        double* wl = wetL_.data();
        double* wr = wetR_.data();
        std::copy_n(inL, n, wl);
        std::copy_n(inR, n, wr);
        if (route == FxRoute::stereo)
            e->process(wl, wr, n);
        else
        {
            // M/S (4.7a): pull out the part this slot is aimed at, run the device on it ALONE (both channels the
            // same, so a stereo device behaves), then put it back.
            double* ca = msA_.data();
            double* cb = msB_.data();
            for (int i = 0; i < n; ++i)
            {
                const double v = route == FxRoute::mid    ? 0.5 * (wl[i] + wr[i])
                                 : route == FxRoute::side ? 0.5 * (wl[i] - wr[i])
                                 : route == FxRoute::left ? wl[i]
                                                          : wr[i];
                ca[i] = v;
                cb[i] = v;
            }
            e->process(ca, cb, n);
            // The part we did NOT process has to be delayed by whatever the device cost, or the two halves comb
            // against each other when they are recombined. This is why a routed device with latency holds one of
            // the compensation lines.
            const int comp = s.fxCompDelay[k];
            if (comp >= 0)
            {
                const int lat = std::min(e->latencySamples(), Mixer::kMaxPdcSamples);
                auto& cd = compDelays_[static_cast<std::size_t>(comp)];
                cd.a.process(wl, n, lat);
                cd.b.process(wr, n, lat);
            }
            for (int i = 0; i < n; ++i)
            {
                const double p = ca[i];
                if (route == FxRoute::mid)
                {
                    const double sd = 0.5 * (wl[i] - wr[i]);
                    wl[i] = p + sd;
                    wr[i] = p - sd;
                }
                else if (route == FxRoute::side)
                {
                    const double md = 0.5 * (wl[i] + wr[i]);
                    wl[i] = md + p;
                    wr[i] = md - p;
                }
                else if (route == FxRoute::left)
                    wl[i] = p;
                else
                    wr[i] = p;
            }
        }
        if (mix >= 1.0f)
        {
            std::copy_n(wl, n, inL);
            std::copy_n(wr, n, inR);
            continue;
        }
        const double m = static_cast<double>(mix), d = 1.0 - m;
        for (int i = 0; i < n; ++i)
        {
            inL[i] = inL[i] * d + wl[i] * m;
            inR[i] = inR[i] * d + wr[i] * m;
        }
    }

    // ---- PDC tier 1/2 (4.4): this strip's alignment delay, AFTER the inserts and BEFORE the fader, in whole
    // samples and instant (a glide would pitch-bend). 0 = untouched and bit-exact, which is every strip until a
    // device with latency is in the mix. ----
    if (pdcOn_ && s.pdc > 0)
    {
        s.pdcL.process(inL, n, s.pdc);
        s.pdcR.process(inR, n, s.pdc);
    }

    // ---- width → fader × mute → pan ----
    const float wS = s.widthCur, wT = s.set.width;
    const float wE = approach(wS, wT);
    const float fS = s.faderCur, fT = dbToGain(s.set.faderDb);
    const float fE = approach(fS, fT);
    const float mS = s.muteCur, mT = ((silentMask_ >> idx) & 1u) ? 0.0f : 1.0f;
    const float mE = approach(mS, mT);
    const float pS = s.panCur, pT = isMaster ? 0.0f : s.set.pan;
    const float pE = approach(pS, pT);
    const bool doWidth = !(wS == 1.0f && wE == 1.0f && wT == 1.0f);
    const bool doPan = !(pS == 0.0f && pE == 0.0f && pT == 0.0f);
    const PanMatrix mA = panMatrix(static_cast<double>(pS)), mB = panMatrix(static_cast<double>(pE));
    for (int i = 0; i < n; ++i)
    {
        const double t = static_cast<double>(i) * invN;
        double l = inL[i], r = inR[i];
        if (doWidth)
        {
            const double w = static_cast<double>(wS) + (static_cast<double>(wE) - static_cast<double>(wS)) * t;
            const double m = (l + r) * 0.5, sd = (l - r) * 0.5 * w;
            l = m + sd;
            r = m - sd;
        }
        const double f = static_cast<double>(fS) + (static_cast<double>(fE) - static_cast<double>(fS)) * t;
        const double mu = static_cast<double>(mS) + (static_cast<double>(mE) - static_cast<double>(mS)) * t;
        const double g = f * mu;
        l *= g;
        r *= g;
        if (doPan)
        {
            const double ll = mA.ll + (mB.ll - mA.ll) * t, rl = mA.rl + (mB.rl - mA.rl) * t;
            const double lr = mA.lr + (mB.lr - mA.lr) * t, rr = mA.rr + (mB.rr - mA.rr) * t;
            const double nl = l * ll + r * rl;
            const double nr = r * rr + l * lr;
            l = nl;
            r = nr;
        }
        oL[i] = l;
        oR[i] = r;
    }
    s.widthCur = wE;
    s.faderCur = fE;
    s.muteCur = mE;
    s.panCur = pE;

    // ---- the master's safety limiter (4.2c): the page's DynamicsCompressor −1 / 0 / 20 / 1 ms / 50 ms ----
    if (isMaster && limiterOn_)
    {
        const double* src[2] = {oL, oR};
        double* dst[2] = {oL, oR};
        limiter_.process(src, dst, 2, n, -1.0f, 0.0f, 20.0f, 0.001f, 0.05f, 0.006f, 0.0f, 1.0f, 0.09f, 0.16f, 0.42f,
                         0.98f);
    }

    // ---- the master's loudness meter (4.3): BS.1770-4 on what leaves the master ----
    if (isMaster)
        loudness_.push(oL, oR, n);

    // ---- post meter (what leaves the strip) ----
    {
        float pl = 0.0f, pr = 0.0f;
        double ss = 0.0;
        for (int i = 0; i < n; ++i)
        {
            const float l = static_cast<float>(oL[i]), r = static_cast<float>(oR[i]);
            const float al = l < 0.0f ? -l : l, ar = r < 0.0f ? -r : r;
            pl = al > pl ? al : pl;
            pr = ar > pr ? ar : pr;
            ss += oL[i] * oL[i] + oR[i] * oR[i];
        }
        s.post.push(pl, pr, ss, n);
        s.pre.read(s.meter.peakPre[0], s.meter.peakPre[1], s.meter.rmsPre);
        s.post.read(s.meter.peakPost[0], s.meter.peakPost[1], s.meter.rmsPost);
    }

    // ---- the stem tap (4.5): an EXTRA copy to a hardware pair; the normal output target still happens ----
    if (s.stemTap >= 0)
    {
        const int cl = s.stemTap * 2, cr = s.stemTap * 2 + 1;
        if (cl >= 0 && cl < numOut && outputs[cl] != nullptr)
            for (int i = 0; i < n; ++i)
                outputs[cl][i] += static_cast<float>(oL[i]);
        if (cr >= 0 && cr < numOut && outputs[cr] != nullptr)
            for (int i = 0; i < n; ++i)
                outputs[cr][i] += static_cast<float>(oR[i]);
    }

    // ---- sends (post-fader/mute/pan taps, each with its own τ-8 ms level) ----
    if (!isMaster)
    {
        for (int k = 0; k < kMaxSends; ++k)
        {
            const float gS = s.sendCur[k], gT = dbToGain(s.set.sendDb[k]);
            const float gE = approach(gS, gT);
            s.sendCur[k] = gE;
            const int target = s.set.sendTarget[k];
            if (target < 0 || target >= kMaxStrips || strips_[target].set.kind == StripKind::off)
                continue;
            if (gS == 0.0f && gE == 0.0f)
                continue;
            double* tL = inputPtrs_[static_cast<std::size_t>(target) * 2];
            double* tR = inputPtrs_[static_cast<std::size_t>(target) * 2 + 1];
            for (int i = 0; i < n; ++i)
            {
                const double g = static_cast<double>(gS) +
                                 (static_cast<double>(gE) - static_cast<double>(gS)) * (static_cast<double>(i) * invN);
                tL[i] += oL[i] * g;
                tR[i] += oR[i] * g;
            }
        }
    }

    // ---- the output target ----
    StripOutput ok = s.set.outKind;
    int oi = s.set.outIndex;
    if (isMaster)
    {
        ok = StripOutput::hardware;
        oi = mainOut_;
    }
    switch (ok)
    {
    case StripOutput::master:
    case StripOutput::strip:
    {
        const int target = ok == StripOutput::master ? kMasterStrip : oi;
        if (target < 0 || target >= kMaxStrips || strips_[target].set.kind == StripKind::off)
            break;
        // PDC: a CHANNEL straight to the master is the tier-2 direct leg (delayed by maxBus at the master); a send /
        // bus return is already aligned and goes in as it is. With PDC off / no bus latency nothing is diverted, so
        // the sum order is unchanged and the mix stays bit-exact.
        const bool directLeg = pdcOn_ && pdcMaxBus_ > 0 && target == kMasterStrip && s.set.kind == StripKind::channel;
        double* tL = directLeg ? masterDirectL_.data() : inputPtrs_[static_cast<std::size_t>(target) * 2];
        double* tR = directLeg ? masterDirectR_.data() : inputPtrs_[static_cast<std::size_t>(target) * 2 + 1];
        for (int i = 0; i < n; ++i)
        {
            tL[i] += oL[i];
            tR[i] += oR[i];
        }
        break;
    }
    case StripOutput::hardware:
    {
        const int cl = oi * 2, cr = oi * 2 + 1;
        float* hl = (cl >= 0 && cl < numOut) ? outputs[cl] : nullptr;
        float* hr = (cr >= 0 && cr < numOut) ? outputs[cr] : nullptr;
        if (hl != nullptr)
            for (int i = 0; i < n; ++i)
                hl[i] += static_cast<float>(oL[i]);
        if (hr != nullptr)
            for (int i = 0; i < n; ++i)
                hr[i] += static_cast<float>(oR[i]);
        break;
    }
    case StripOutput::none:
        break;
    }
}

} // namespace terminator
