#include "terminator/core/Mixer.h"

#include <algorithm>
#include <cmath>

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

void Mixer::prepare(double sampleRate, int maxBlockSize)
{
    TERMINATOR_RT_ASSERT(sampleRate > 0.0 && maxBlockSize > 0);
    sampleRate_ = sampleRate;
    maxBlock_ = maxBlockSize;
    const auto n = static_cast<std::size_t>(maxBlockSize);
    inputs_.assign(static_cast<std::size_t>(kMaxStrips) * 2 * n, 0.0);
    trash_.assign(2 * n, 0.0);
    outL_.assign(n, 0.0);
    outR_.assign(n, 0.0);
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
    // the settings survive a re-prepare (a device change): only the smoothed state + meters restart at the targets
    for (int i = 0; i < kMaxStrips; ++i)
    {
        auto& s = strips_[i];
        s.faderCur = dbToGain(s.set.faderDb);
        s.panCur = s.set.pan;
        s.widthCur = s.set.width;
        for (int k = 0; k < kMaxSends; ++k)
            s.sendCur[k] = dbToGain(s.set.sendDb[k]);
        s.pre.clear();
        s.post.clear();
        s.meter = StripMeter{};
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
            std::fill_n(inputPtrs_[static_cast<std::size_t>(strip) * 2], n, 0.0);
            std::fill_n(inputPtrs_[static_cast<std::size_t>(strip) * 2 + 1], n, 0.0);
        }
    }
    if (!live)
        s.meter = StripMeter{};
    updateSilence();
    if (live && !wasLive)
        s.muteCur = (silentMask_ >> strip) & 1u ? 0.0f : 1.0f;
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

void Mixer::setMainOut(int pair) noexcept TERMINATOR_NONBLOCKING
{
    mainOut_ = std::clamp(pair, 0, 63);
    strips_[kMasterStrip].set.outKind = StripOutput::hardware;
    strips_[kMasterStrip].set.outIndex = static_cast<std::int16_t>(mainOut_);
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
    for (int k = 0; k < orderCount_; ++k)
    {
        const int idx = order_[k];
        if (strips_[idx].set.kind == StripKind::off)
            continue;
        processStrip(idx, outputs, numOut, n);
    }
}

void Mixer::processStrip(int idx, float* const* outputs, int numOut, int n) noexcept TERMINATOR_NONBLOCKING
{
    auto& s = strips_[idx];
    const bool isMaster = idx == kMasterStrip;
    const double* inL = inputPtrs_[static_cast<std::size_t>(idx) * 2];
    const double* inR = inputPtrs_[static_cast<std::size_t>(idx) * 2 + 1];
    double* oL = outL_.data();
    double* oR = outR_.data();
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

    // ---- [inserts: Phase 4.2] → width → fader × mute → pan ----
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
        double* tL = inputPtrs_[static_cast<std::size_t>(target) * 2];
        double* tR = inputPtrs_[static_cast<std::size_t>(target) * 2 + 1];
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
