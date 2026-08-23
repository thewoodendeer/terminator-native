#include "terminator/core/fx/ReverbFx.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr float kFxTau = 0.01f;
constexpr int kHist = 16384; // ≥ 2·kP3, power of two
constexpr int kHistMask = kHist - 1;
constexpr int kB1 = ReverbFx::kP1 + 1, kB2 = ReverbFx::kP2 + 1, kB3 = ReverbFx::kP3 + 1; // bins per half spectrum

float clampf(float v, float lo, float hi) noexcept
{
    return v < lo ? lo : (v > hi ? hi : v);
}
int ceilDiv(int a, int b) noexcept
{
    return a <= 0 ? 0 : (a + b - 1) / b;
}
} // namespace

// ---- the generator + Blink's normalisation (static, shared with the gates) ---------------------------------------

int ReverbFx::generateIr(double room01, double decaySec, double sampleRate, float* outL, float* outR,
                         int capacity) noexcept
{
    const double decay = std::clamp(decaySec, 0.1, kMaxDecaySec);
    const double room = std::clamp(room01, 0.0, 1.0);
    const int length = std::max(1, static_cast<int>(std::floor(sampleRate * decay)));
    const int len = std::min(length, capacity);
    const int buildUp = std::max(1, static_cast<int>(std::floor(sampleRate * (0.002 + room * 0.03))));
    const double fcStart = 14000.0 - room * 6000.0, fcEnd = 1800.0;
    const double k = -6.9078 / decay;
    std::uint32_t seed = kSeed;
    for (int c = 0; c < 2; ++c)
    {
        float* data = c == 0 ? outL : outR;
        double y = 0.0;
        for (int i = 0; i < length; ++i)
        {
            const double t = static_cast<double>(i) / sampleRate;
            const double frac = static_cast<double>(i) / static_cast<double>(length);
            const double fc = fcStart + (fcEnd - fcStart) * std::sqrt(frac);
            const double a = 1.0 - std::exp(-6.2832 * fc / sampleRate);
            seed = seed * 1664525u + 1013904223u;
            const double r = static_cast<double>(seed) / 4294967296.0 * 2.0 - 1.0;
            y += a * (r - y);
            const double onset = i < buildUp ? static_cast<double>(i) / static_cast<double>(buildUp) : 1.0;
            if (i < len)
                data[i] = static_cast<float>(y * std::exp(k * t) * onset);
        }
    }
    return len;
}

float ReverbFx::normalisationScale(double sumSquares, int len, double sampleRate) noexcept
{
    double power = std::sqrt(sumSquares / (2.0 * static_cast<double>(std::max(1, len))));
    if (!std::isfinite(power) || power < 0.000125)
        power = 0.000125;
    double scale = 1.0 / power;
    scale *= std::pow(10.0, -58.0 * 0.05); // calibrate to make perceived volume same as unprocessed
    scale *= 44100.0 / sampleRate;         // scale depends on sample-rate
    return static_cast<float>(scale);
}

// ---- lifecycle -----------------------------------------------------------------------------------------------

void ReverbFx::prepare(double sampleRate, int maxBlockSize)
{
    sr_ = sampleRate;
    maxBlock_ = std::max(1, maxBlockSize);
    maxIr_ = std::max(1, static_cast<int>(std::floor(sampleRate * kMaxDecaySec)));
    k3Max_ = ceilDiv(maxIr_ - kO3, kP3);
    const int maxPre = static_cast<int>(std::ceil(0.5 * sampleRate)) + 2;
    preL_.prepare(maxPre);
    preR_.prepare(maxPre);
    hist_.assign(static_cast<std::size_t>(2 * kHist), 0.0);
    fdl1_.assign(static_cast<std::size_t>(2 * kK1 * kB1 * 2), 0.0f);
    fdl2_.assign(static_cast<std::size_t>(2 * kK2 * kB2 * 2), 0.0f);
    fdl3_.reset(k3Max_ > 0 ? new float[static_cast<std::size_t>(2 * k3Max_ * kB3 * 2)] : nullptr);
    fft1_.prepare(2 * kP1);
    fft2_.prepare(2 * kP2);
    fft3_.prepare(2 * kP3);
    re_.assign(static_cast<std::size_t>(2 * kP3), 0.0);
    im_.assign(static_cast<std::size_t>(2 * kP3), 0.0);
    for (auto& s : slot_)
    {
        s.head.assign(static_cast<std::size_t>(2 * kHead), 0.0);
        s.h1.assign(static_cast<std::size_t>(2 * kK1 * kB1 * 2), 0.0f);
        s.h2.assign(static_cast<std::size_t>(2 * kK2 * kB2 * 2), 0.0f);
        s.h3.reset(k3Max_ > 0 ? new float[static_cast<std::size_t>(2 * k3Max_ * kB3 * 2)] : nullptr);
        s.tail1.assign(static_cast<std::size_t>(2 * kP1), 0.0);
        s.tail2.assign(static_cast<std::size_t>(2 * kP2), 0.0);
        s.tail3.assign(static_cast<std::size_t>(2 * kP3), 0.0);
        s.tail3Next.assign(static_cast<std::size_t>(2 * kP3), 0.0);
        s.acc.assign(static_cast<std::size_t>(2 * kB3 * 2), 0.0);
    }
    irTime_.reset(new float[static_cast<std::size_t>(2 * maxIr_)]);
    reset();
}

void ReverbFx::reset() noexcept TERMINATOR_NONBLOCKING
{
    room_ = 50.0f;
    decay_ = 2.0f;
    wet_ = 30.0f;
    pre_.set(0.01f, true);
    preL_.reset();
    preR_.reset();
    std::fill(hist_.begin(), hist_.end(), 0.0);
    pos_ = 0;
    fdl1Pos_ = fdl2Pos_ = fdl3Pos_ = 0;
    fdl1Count_ = fdl2Count_ = fdl3Count_ = 0;
    for (auto& s : slot_)
    {
        s.len = s.k1 = s.k2 = s.k3 = 0;
        s.scale = 0.0f;
        std::fill(s.tail1.begin(), s.tail1.end(), 0.0);
        std::fill(s.tail2.begin(), s.tail2.end(), 0.0);
        std::fill(s.tail3.begin(), s.tail3.end(), 0.0);
        std::fill(s.tail3Next.begin(), s.tail3Next.end(), 0.0);
        s.jobDone = 0;
        s.jobOpen = false;
    }
    active_ = fading_ = pending_ = -1;
    pendingArmed_ = false;
    fadeLeft_ = 0;
    fadeLen_ = std::max(1, static_cast<int>(std::lround(kFadeSec * sr_)));
    stage_ = Stage::idle;
    dirty_ = true; // the first IR
    buildSlot_ = -1;
}

void ReverbFx::setParam(int index, float value, bool immediate) noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
    {
        const float v = clampf(value, 0.0f, 100.0f);
        if (v != room_)
            dirty_ = true;
        room_ = v;
        break;
    }
    case 1:
        pre_.set(clampf(value, 0.0f, 100.0f) * 0.001f, immediate);
        break;
    case 2:
    {
        const float v = clampf(value, 0.1f, 10.0f);
        if (v != decay_)
            dirty_ = true;
        decay_ = v;
        break;
    }
    case 3:
        wet_ = clampf(value, 0.0f, 100.0f);
        break;
    default:
        break;
    }
}
float ReverbFx::param(int index) const noexcept TERMINATOR_NONBLOCKING
{
    switch (index)
    {
    case 0:
        return room_;
    case 1:
        return pre_.target * 1000.0f;
    case 2:
        return decay_;
    case 3:
        return wet_;
    default:
        return 0.0f;
    }
}

// ---- the incremental build -------------------------------------------------------------------------------------

void ReverbFx::startBuild() noexcept TERMINATOR_NONBLOCKING
{
    // the idle slot: not heard, not fading, not pending
    int s = -1;
    for (int i = 0; i < 2; ++i)
        if (i != active_ && i != fading_ && i != pending_)
            s = i;
    if (s < 0)
        return; // both busy (a fade + a pending) — try again next block
    buildSlot_ = s;
    dirty_ = false;
    bRoom_ = static_cast<double>(room_) / 100.0;
    bDecay_ = static_cast<double>(decay_);
    bLen_ = std::min(maxIr_, std::max(1, static_cast<int>(std::floor(sr_ * bDecay_))));
    bBuildUp_ = std::max(1, static_cast<int>(std::floor(sr_ * (0.002 + bRoom_ * 0.03))));
    bFcStart_ = 14000.0 - bRoom_ * 6000.0;
    bK_ = -6.9078 / bDecay_;
    seed_ = kSeed;
    genPos_ = 0;
    genY_ = 0.0;
    power_ = 0.0;
    partPos_ = 0;
    stage_ = Stage::gen;
}

void ReverbFx::transformPartition(const float* ir, int len, int start, int P, float* outHalf,
                                  float scale) noexcept TERMINATOR_NONBLOCKING
{
    const int n2 = 2 * P;
    double* re = re_.data();
    double* im = im_.data();
    for (int i = 0; i < n2; ++i)
    {
        const int idx = start + i;
        re[i] = (i < P && idx < len) ? static_cast<double>(ir[idx]) * static_cast<double>(scale) : 0.0;
        im[i] = 0.0;
    }
    fftFor(P).transform(re, im, false);
    for (int b = 0; b <= P; ++b)
    {
        outHalf[2 * b] = static_cast<float>(re[b]);
        outHalf[2 * b + 1] = static_cast<float>(im[b]);
    }
}

void ReverbFx::buildStep(int n) noexcept TERMINATOR_NONBLOCKING
{
    if (stage_ == Stage::idle)
    {
        if (dirty_ && fading_ < 0)
            startBuild();
        if (stage_ == Stage::idle)
            return;
    }
    const int boost = active_ < 0 ? 4 : 1; // nothing is heard yet: build faster
    if (dirty_)
    {
        // a param moved under a running build: restart it from scratch (the page debounces the same way)
        stage_ = Stage::idle;
        buildSlot_ = -1;
        return;
    }
    Slot& s = slot_[buildSlot_];
    if (stage_ == Stage::gen)
    {
        int budget = 32 * std::max(1, n) * boost;
        const int total = 2 * bLen_;
        while (budget-- > 0 && genPos_ < total)
        {
            const int c = genPos_ / bLen_;
            const int i = genPos_ - c * bLen_;
            if (i == 0)
                genY_ = 0.0;
            const double t = static_cast<double>(i) / sr_;
            const double frac = static_cast<double>(i) / static_cast<double>(bLen_);
            const double fc = bFcStart_ + (1800.0 - bFcStart_) * std::sqrt(frac);
            const double a = 1.0 - std::exp(-6.2832 * fc / sr_);
            genY_ += a * (rnd() - genY_);
            const double onset = i < bBuildUp_ ? static_cast<double>(i) / static_cast<double>(bBuildUp_) : 1.0;
            const float v = static_cast<float>(genY_ * std::exp(bK_ * t) * onset);
            irTime_[static_cast<std::size_t>(c * maxIr_ + i)] = v;
            power_ += static_cast<double>(v) * static_cast<double>(v);
            ++genPos_;
        }
        if (genPos_ < total)
            return;
        // sized + normalised
        s.len = bLen_;
        s.scale = normalisationScale(power_, bLen_, sr_);
        s.k1 = std::clamp(ceilDiv(bLen_ - kP1, kP1), 0, kK1);
        s.k2 = std::clamp(ceilDiv(bLen_ - kP2, kP2), 0, kK2);
        s.k3 = std::clamp(ceilDiv(bLen_ - kO3, kP3), 0, k3Max_);
        stage_ = Stage::small;
        partPos_ = 0;
        return;
    }
    if (stage_ == Stage::small)
    {
        // the head taps + the two small tiers — ≤ 2 × (128 + 3 + 15) units, a few per block
        int budget = 8 * std::max(1, n / 128 + 1) * boost;
        const int perCh = 1 + s.k1 + s.k2; // 0 = the head, 1..k1 = tier-1 partitions, then tier-2
        const int total = 2 * perCh;
        while (budget-- > 0 && partPos_ < total)
        {
            const int c = partPos_ / perCh;
            const int j = partPos_ - c * perCh;
            const float* ir = irTime_.get() + static_cast<std::size_t>(c * maxIr_);
            if (j == 0)
            {
                for (int i = 0; i < kHead; ++i)
                    s.head[static_cast<std::size_t>(c * kHead + i)] =
                        i < s.len ? static_cast<double>(ir[i]) * static_cast<double>(s.scale) : 0.0;
            }
            else if (j <= s.k1)
            {
                const int k = j - 1;
                transformPartition(ir, s.len, kP1 + k * kP1, kP1,
                                   s.h1.data() + static_cast<std::size_t>((c * kK1 + k) * kB1 * 2), s.scale);
            }
            else
            {
                const int k = j - 1 - s.k1;
                transformPartition(ir, s.len, kP2 + k * kP2, kP2,
                                   s.h2.data() + static_cast<std::size_t>((c * kK2 + k) * kB2 * 2), s.scale);
            }
            ++partPos_;
        }
        if (partPos_ < total)
            return;
        stage_ = Stage::tier3;
        partPos_ = 0;
        return;
    }
    // Stage::tier3 — the 8192-point partitions, a couple per block
    {
        int budget = std::max(1, n / 256) * boost;
        const int total = 2 * s.k3;
        while (budget-- > 0 && partPos_ < total)
        {
            const int c = partPos_ / std::max(1, s.k3);
            const int k = partPos_ - c * s.k3;
            const float* ir = irTime_.get() + static_cast<std::size_t>(c * maxIr_);
            transformPartition(ir, s.len, kO3 + k * kP3, kP3,
                               s.h3.get() + static_cast<std::size_t>((c * k3Max_ + k) * kB3 * 2), s.scale);
            ++partPos_;
        }
        if (partPos_ < total)
            return;
        // complete: the slot is pending — it arms at the next tier-3 boundary, is heard from the one after
        std::fill(s.tail1.begin(), s.tail1.end(), 0.0);
        std::fill(s.tail2.begin(), s.tail2.end(), 0.0);
        std::fill(s.tail3.begin(), s.tail3.end(), 0.0);
        std::fill(s.tail3Next.begin(), s.tail3Next.end(), 0.0);
        s.jobOpen = false;
        s.jobDone = 0;
        pending_ = buildSlot_;
        pendingArmed_ = false;
        buildSlot_ = -1;
        stage_ = Stage::idle;
    }
}

// ---- the convolution -------------------------------------------------------------------------------------------

void ReverbFx::forwardInput(int c, int P, float* outHalf) noexcept TERMINATOR_NONBLOCKING
{
    const int n2 = 2 * P;
    double* re = re_.data();
    double* im = im_.data();
    const double* h = hist_.data() + static_cast<std::size_t>(c * kHist);
    const std::uint64_t base = pos_ - static_cast<std::uint64_t>(n2);
    for (int i = 0; i < n2; ++i)
    {
        re[i] =
            h[static_cast<std::size_t>((base + static_cast<std::uint64_t>(i)) & static_cast<std::uint64_t>(kHistMask))];
        im[i] = 0.0;
    }
    fftFor(P).transform(re, im, false);
    for (int b = 0; b <= P; ++b)
    {
        outHalf[2 * b] = static_cast<float>(re[b]);
        outHalf[2 * b + 1] = static_cast<float>(im[b]);
    }
}

/// One small-tier step for channel c: Y = Σ_k H_k · X_{j−k} over the FDL, IFFT, the last P samples → tail.
void ReverbFx::smallTierStep(int c, int P, int K, int kMax, const float* fdl, int fdlPos, int fdlCount, const float* h,
                             double* tail) noexcept TERMINATOR_NONBLOCKING
{
    const int bins = P + 1;
    double* re = re_.data();
    double* im = im_.data();
    for (int b = 0; b < bins; ++b)
        re[b] = im[b] = 0.0;
    const int kk = std::min(K, fdlCount);
    for (int k = 0; k < kk; ++k)
    {
        const int j = (fdlPos - k + kMax) % kMax;
        const float* X = fdl + static_cast<std::size_t>((c * kMax + j) * bins * 2);
        const float* H = h + static_cast<std::size_t>((c * kMax + k) * bins * 2);
        for (int b = 0; b < bins; ++b)
        {
            const double xr = static_cast<double>(X[2 * b]), xi = static_cast<double>(X[2 * b + 1]);
            const double hr = static_cast<double>(H[2 * b]), hi = static_cast<double>(H[2 * b + 1]);
            re[b] += hr * xr - hi * xi;
            im[b] += hr * xi + hi * xr;
        }
    }
    for (int b = P + 1; b < 2 * P; ++b)
    {
        re[b] = re[2 * P - b];
        im[b] = -im[2 * P - b];
    }
    fftFor(P).transform(re, im, true);
    for (int i = 0; i < P; ++i)
        tail[i] = re[P + i];
}

void ReverbFx::tier3Begin() noexcept TERMINATOR_NONBLOCKING
{
    // 1. every slot with a job: finish it (normally finished long ago); its next window's tail comes due
    for (int i = 0; i < 2; ++i)
    {
        Slot& s = slot_[i];
        const bool live = i == active_ || i == fading_ || (i == pending_ && pendingArmed_);
        if (!live)
            continue;
        if (s.jobOpen)
            tier3Finish(s);
        std::copy(s.tail3Next.begin(), s.tail3Next.end(), s.tail3.begin());
    }
    // 2. promote an armed pending slot: it is heard from now (crossfade); the old active fades
    if (pending_ >= 0 && pendingArmed_)
    {
        if (fading_ >= 0)
        {
            fading_ = -1; // a fade still running would need a third slot — cut it (never happens: builds take longer)
            fadeLeft_ = 0;
        }
        fading_ = active_;
        active_ = pending_;
        pending_ = -1;
        pendingArmed_ = false;
        fadeLeft_ = fading_ >= 0 ? fadeLen_ : 0;
    }
    if (k3Max_ <= 0)
        return;
    // 3. this window's input block → the FDL
    fdl3Pos_ = (fdl3Pos_ + 1) % k3Max_;
    for (int c = 0; c < 2; ++c)
        forwardInput(c, kP3, fdl3_.get() + static_cast<std::size_t>((c * k3Max_ + fdl3Pos_) * kB3 * 2));
    if (fdl3Count_ < k3Max_)
        ++fdl3Count_;
    // 4. open the jobs: the live slots, and an unarmed pending slot (its result is due when it is promoted)
    for (int i = 0; i < 2; ++i)
    {
        Slot& s = slot_[i];
        const bool want = i == active_ || i == fading_ || i == pending_;
        if (!want)
            continue;
        if (i == pending_)
            pendingArmed_ = true;
        if (s.k3 <= 0)
        {
            std::fill(s.tail3Next.begin(), s.tail3Next.end(), 0.0);
            continue;
        }
        std::fill(s.acc.begin(), s.acc.end(), 0.0);
        s.jobDone = 0;
        s.jobOpen = true;
    }
}

void ReverbFx::tier3Slice(Slot& s) noexcept TERMINATOR_NONBLOCKING
{
    if (!s.jobOpen)
        return;
    const int per = std::max(1, (s.k3 + kP3 / kP1 - 1) / (kP3 / kP1)); // finish within the window's 32 ticks
    const int kk = std::min(s.k3, fdl3Count_);
    const int end = std::min(s.jobDone + per, s.k3);
    for (int c = 0; c < 2; ++c)
    {
        double* acc = s.acc.data() + static_cast<std::size_t>(c * kB3 * 2);
        for (int k = s.jobDone; k < end; ++k)
        {
            if (k >= kk)
                break;
            const int j = (fdl3Pos_ - k + k3Max_) % k3Max_;
            const float* X = fdl3_.get() + static_cast<std::size_t>((c * k3Max_ + j) * kB3 * 2);
            const float* H = s.h3.get() + static_cast<std::size_t>((c * k3Max_ + k) * kB3 * 2);
            for (int b = 0; b < kB3; ++b)
            {
                const double xr = static_cast<double>(X[2 * b]), xi = static_cast<double>(X[2 * b + 1]);
                const double hr = static_cast<double>(H[2 * b]), hi = static_cast<double>(H[2 * b + 1]);
                acc[2 * b] += hr * xr - hi * xi;
                acc[2 * b + 1] += hr * xi + hi * xr;
            }
        }
    }
    s.jobDone = end;
    if (s.jobDone >= s.k3)
        tier3Finish(s);
}

void ReverbFx::tier3Finish(Slot& s) noexcept TERMINATOR_NONBLOCKING
{
    if (!s.jobOpen)
        return;
    // anything left (a job cut short): accumulate it now
    if (s.jobDone < s.k3)
    {
        const int kk = std::min(s.k3, fdl3Count_);
        for (int c = 0; c < 2; ++c)
        {
            double* acc = s.acc.data() + static_cast<std::size_t>(c * kB3 * 2);
            for (int k = s.jobDone; k < kk; ++k)
            {
                const int j = (fdl3Pos_ - k + k3Max_) % k3Max_;
                const float* X = fdl3_.get() + static_cast<std::size_t>((c * k3Max_ + j) * kB3 * 2);
                const float* H = s.h3.get() + static_cast<std::size_t>((c * k3Max_ + k) * kB3 * 2);
                for (int b = 0; b < kB3; ++b)
                {
                    const double xr = static_cast<double>(X[2 * b]), xi = static_cast<double>(X[2 * b + 1]);
                    const double hr = static_cast<double>(H[2 * b]), hi = static_cast<double>(H[2 * b + 1]);
                    acc[2 * b] += hr * xr - hi * xi;
                    acc[2 * b + 1] += hr * xi + hi * xr;
                }
            }
        }
        s.jobDone = s.k3;
    }
    double* re = re_.data();
    double* im = im_.data();
    for (int c = 0; c < 2; ++c)
    {
        const double* acc = s.acc.data() + static_cast<std::size_t>(c * kB3 * 2);
        for (int b = 0; b < kB3; ++b)
        {
            re[b] = acc[2 * b];
            im[b] = acc[2 * b + 1];
        }
        for (int b = kP3 + 1; b < 2 * kP3; ++b)
        {
            re[b] = re[2 * kP3 - b];
            im[b] = -im[2 * kP3 - b];
        }
        fft3_.transform(re, im, true);
        double* next = s.tail3Next.data() + static_cast<std::size_t>(c * kP3);
        for (int i = 0; i < kP3; ++i)
            next[i] = re[kP3 + i];
    }
    s.jobOpen = false;
}

void ReverbFx::process(double* l, double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    n = std::min(n, maxBlock_);
    buildStep(n);
    // the pre-delay (the DelayNode, τ 10 ms glide, linear interpolation)
    const double pS = static_cast<double>(pre_.cur) * sr_, pE = static_cast<double>(pre_.advance(n, sr_, kFxTau)) * sr_;
    const double invN = 1.0 / static_cast<double>(std::max(1, n));
    for (int i = 0; i < n; ++i)
    {
        const double d = pS + (pE - pS) * static_cast<double>(i) * invN;
        l[i] = preL_.process(l[i], d);
        r[i] = preR_.process(r[i], d);
    }
    double* hL = hist_.data();
    double* hR = hist_.data() + kHist;
    for (int i = 0; i < n; ++i)
    {
        const int hp = static_cast<int>(pos_ & static_cast<std::uint64_t>(kHistMask));
        hL[hp] = l[i];
        hR[hp] = r[i];
        double outL = 0.0, outR = 0.0;
        for (int which = 0; which < 2; ++which)
        {
            const int si = which == 0 ? active_ : fading_;
            if (si < 0)
                continue;
            const Slot& s = slot_[si];
            // the direct head
            double aL = 0.0, aR = 0.0;
            const double* headL = s.head.data();
            const double* headR = s.head.data() + kHead;
            for (int k = 0; k < kHead; ++k)
            {
                const int idx = (hp - k) & kHistMask;
                aL += headL[k] * hL[idx];
                aR += headR[k] * hR[idx];
            }
            const int i1 = static_cast<int>(pos_ % static_cast<std::uint64_t>(kP1));
            const int i2 = static_cast<int>(pos_ % static_cast<std::uint64_t>(kP2));
            const int i3 = static_cast<int>(pos_ % static_cast<std::uint64_t>(kP3));
            aL += s.tail1[static_cast<std::size_t>(i1)] + s.tail2[static_cast<std::size_t>(i2)] +
                  s.tail3[static_cast<std::size_t>(i3)];
            aR += s.tail1[static_cast<std::size_t>(kP1 + i1)] + s.tail2[static_cast<std::size_t>(kP2 + i2)] +
                  s.tail3[static_cast<std::size_t>(kP3 + i3)];
            double g = 1.0;
            if (fadeLeft_ > 0)
            {
                const double p = 1.0 - static_cast<double>(fadeLeft_) / static_cast<double>(fadeLen_);
                g = which == 0 ? p : 1.0 - p;
            }
            else if (which == 1)
                g = 0.0;
            outL += aL * g;
            outR += aR * g;
        }
        if (fadeLeft_ > 0 && --fadeLeft_ == 0)
            fading_ = -1;
        l[i] = outL;
        r[i] = outR;
        ++pos_;
        if ((pos_ % static_cast<std::uint64_t>(kP1)) == 0)
        {
            if ((pos_ % static_cast<std::uint64_t>(kP3)) == 0)
                tier3Begin();
            // tier 1 (both channels → the FDL, then the live slots)
            fdl1Pos_ = (fdl1Pos_ + 1) % kK1;
            for (int c = 0; c < 2; ++c)
                forwardInput(c, kP1, fdl1_.data() + static_cast<std::size_t>((c * kK1 + fdl1Pos_) * kB1 * 2));
            if (fdl1Count_ < kK1)
                ++fdl1Count_;
            for (int si = 0; si < 2; ++si)
            {
                if (si != active_ && si != fading_)
                    continue;
                Slot& s = slot_[si];
                for (int c = 0; c < 2; ++c)
                    smallTierStep(c, kP1, s.k1, kK1, fdl1_.data(), fdl1Pos_, fdl1Count_, s.h1.data(),
                                  s.tail1.data() + static_cast<std::size_t>(c * kP1));
            }
            if ((pos_ % static_cast<std::uint64_t>(kP2)) == 0)
            {
                fdl2Pos_ = (fdl2Pos_ + 1) % kK2;
                for (int c = 0; c < 2; ++c)
                    forwardInput(c, kP2, fdl2_.data() + static_cast<std::size_t>((c * kK2 + fdl2Pos_) * kB2 * 2));
                if (fdl2Count_ < kK2)
                    ++fdl2Count_;
                for (int si = 0; si < 2; ++si)
                {
                    if (si != active_ && si != fading_)
                        continue;
                    Slot& s = slot_[si];
                    for (int c = 0; c < 2; ++c)
                        smallTierStep(c, kP2, s.k2, kK2, fdl2_.data(), fdl2Pos_, fdl2Count_, s.h2.data(),
                                      s.tail2.data() + static_cast<std::size_t>(c * kP2));
                }
            }
            // tier 3: a slice of every open job
            for (auto& s : slot_)
                tier3Slice(s);
        }
    }
}

} // namespace terminator
