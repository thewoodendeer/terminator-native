#include "terminator/core/LoudnessMeter.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr double kPi = 3.14159265358979323846;
constexpr double kHopSec = 0.1;

void highShelf(double* c, double fs, double f0, double Q, double gainDb) noexcept
{
    const double K = std::tan(kPi * f0 / fs);
    const double Vh = std::pow(10.0, gainDb / 20.0);
    const double Vb = std::pow(Vh, 0.4996667741545416);
    const double a0 = 1.0 + K / Q + K * K;
    c[0] = (Vh + Vb * K / Q + K * K) / a0;
    c[1] = 2.0 * (K * K - Vh) / a0;
    c[2] = (Vh - Vb * K / Q + K * K) / a0;
    c[3] = 2.0 * (K * K - 1.0) / a0;
    c[4] = (1.0 - K / Q + K * K) / a0;
}
void highPass(double* c, double fs, double f0, double Q) noexcept
{
    const double K = std::tan(kPi * f0 / fs);
    const double a0 = 1.0 + K / Q + K * K;
    c[0] = 1.0;
    c[1] = -2.0;
    c[2] = 1.0;
    c[3] = 2.0 * (K * K - 1.0) / a0;
    c[4] = (1.0 - K / Q + K * K) / a0;
}
double besselI0(double x) noexcept
{
    double s = 1.0, t = 1.0;
    for (int k = 1; k < 30; ++k)
    {
        t *= (x / (2.0 * k)) * (x / (2.0 * k));
        s += t;
    }
    return s;
}
/// An in-place heapsort (no recursion, no allocation — the STL sort is not marked nonblocking).
void heapSort(double* a, int n) noexcept TERMINATOR_NONBLOCKING
{
    auto siftDown = [a](int start, int end) noexcept
    {
        int root = start;
        while (2 * root + 1 <= end)
        {
            int child = 2 * root + 1;
            if (child + 1 <= end && a[child] < a[child + 1])
                ++child;
            if (a[root] < a[child])
            {
                const double t = a[root];
                a[root] = a[child];
                a[child] = t;
                root = child;
            }
            else
                return;
        }
    };
    for (int start = (n - 2) / 2; start >= 0; --start)
        siftDown(start, n - 1);
    for (int end = n - 1; end > 0; --end)
    {
        const double t = a[0];
        a[0] = a[end];
        a[end] = t;
        siftDown(0, end - 1);
    }
}
float lufsOf(double ms) noexcept TERMINATOR_NONBLOCKING
{
    return ms > 0.0 ? static_cast<float>(-0.691 + 10.0 * std::log10(ms)) : -1000.0f;
}
} // namespace

void LoudnessMeter::prepare(double sampleRate)
{
    sr_ = sampleRate;
    double sh[5], hp[5];
    highShelf(sh, sampleRate, 1681.974450955533, 0.7071752369554196, 3.99984385397);
    highPass(hp, sampleRate, 38.13547087602444, 0.5003270373238773);
    for (int i = 0; i < 5; ++i)
    {
        kL_[0].c[i] = kR_[0].c[i] = sh[i];
        kL_[1].c[i] = kR_[1].c[i] = hp[i];
    }
    // the true-peak interpolator: 4 phases × 12 taps of a Kaiser (β 8) windowed sinc, each phase unity at DC
    constexpr int N = kTpPhases * kTpTaps;
    double h[N];
    const double c = (N - 1) / 2.0;
    const double i0b = besselI0(8.0);
    for (int n = 0; n < N; ++n)
    {
        const double x = (n - c) / kTpPhases;
        const double sinc = x == 0.0 ? 1.0 : std::sin(kPi * x) / (kPi * x);
        const double r = (n - c) / c;
        const double w = besselI0(8.0 * std::sqrt(std::max(0.0, 1.0 - r * r))) / i0b;
        h[n] = sinc * w;
    }
    for (int p = 0; p < kTpPhases; ++p)
    {
        double sum = 0.0;
        for (int k = 0; k < kTpTaps; ++k)
        {
            tpPhase_[p][k] = h[k * kTpPhases + p];
            sum += tpPhase_[p][k];
        }
        for (int k = 0; k < kTpTaps; ++k)
            tpPhase_[p][k] /= sum;
    }
    hopLen_ = std::max(1, static_cast<int>(std::lround(sampleRate * kHopSec)));
    blocks_.assign(static_cast<std::size_t>(kMaxBlocks), 0.0);
    blocksDb_.assign(static_cast<std::size_t>(kMaxBlocks), -1000.0f);
    shorts_.assign(static_cast<std::size_t>(kMaxShorts), 0.0);
    scratch_.assign(static_cast<std::size_t>(kMaxShorts), 0.0);
    reset();
}

void LoudnessMeter::reset() noexcept TERMINATOR_NONBLOCKING
{
    for (auto* b : {&kL_[0], &kL_[1], &kR_[0], &kR_[1]})
        b->z1 = b->z2 = 0.0;
    for (auto* t : {&tpL_, &tpR_})
    {
        for (auto& v : t->hist)
            v = 0.0;
        t->pos = 0;
    }
    hopPos_ = 0;
    sqL_ = sqR_ = pkL_ = pkR_ = tpkL_ = tpkR_ = cLL_ = cRR_ = cLR_ = 0.0;
    hopCount_ = 0;
    blockCount_ = 0;
    shortCount_ = shortPos_ = 0;
    reading_ = LoudnessReading{};
}

double LoudnessMeter::truePeak(TruePeak& t, double x) const noexcept TERMINATOR_NONBLOCKING
{
    t.hist[t.pos] = x;
    t.pos = (t.pos + 1) % kTpTaps;
    double peak = 0.0;
    for (int p = 0; p < kTpPhases; ++p)
    {
        double acc = 0.0;
        for (int k = 0; k < kTpTaps; ++k)
        {
            const int idx = (t.pos - 1 - k + kTpTaps * 2) % kTpTaps;
            acc += tpPhase_[p][k] * t.hist[idx];
        }
        const double a = acc < 0.0 ? -acc : acc;
        if (a > peak)
            peak = a;
    }
    return peak;
}

void LoudnessMeter::push(const double* l, const double* r, int n) noexcept TERMINATOR_NONBLOCKING
{
    for (int i = 0; i < n; ++i)
    {
        const double a = l[i], b = r != nullptr ? r[i] : l[i];
        const double al = a < 0.0 ? -a : a, ar = b < 0.0 ? -b : b;
        if (al > pkL_)
            pkL_ = al;
        if (ar > pkR_)
            pkR_ = ar;
        const double tl = truePeak(tpL_, a), tr = truePeak(tpR_, b);
        if (tl > tpkL_)
            tpkL_ = tl;
        if (tr > tpkR_)
            tpkR_ = tr;
        cLL_ += a * a;
        cRR_ += b * b;
        cLR_ += a * b;
        const double kl = kL_[1].run(kL_[0].run(a));
        const double kr = kR_[1].run(kR_[0].run(b));
        sqL_ += kl * kl;
        sqR_ += kr * kr;
        if (++hopPos_ >= hopLen_)
            endHop();
    }
}

void LoudnessMeter::endHop() noexcept TERMINATOR_NONBLOCKING
{
    const double ms = (sqL_ + sqR_) / static_cast<double>(hopLen_); // channel weights 1 + 1
    // the 30-hop sliding window
    if (hopCount_ < 30)
        hops_[hopCount_++] = ms;
    else
    {
        for (int i = 1; i < 30; ++i)
            hops_[i - 1] = hops_[i];
        hops_[29] = ms;
    }
    auto mean = [this](int from) noexcept
    {
        double s = 0.0;
        for (int i = from; i < hopCount_; ++i)
            s += hops_[i];
        return s / static_cast<double>(hopCount_ - from);
    };
    const float mVal = hopCount_ >= 4 ? lufsOf(mean(hopCount_ - 4)) : -1000.0f;
    const float sVal = hopCount_ > 0 ? lufsOf(mean(0)) : -1000.0f;
    // integrated: every 400 ms block above the absolute gate (a ring of the last kMaxBlocks hops)
    if (hopCount_ >= 4)
    {
        const double blockMs = mean(hopCount_ - 4);
        const float blockDb = lufsOf(blockMs);
        if (blockDb > -70.0f)
        {
            if (blockCount_ < kMaxBlocks)
            {
                blocks_[static_cast<std::size_t>(blockCount_)] = blockMs;
                blocksDb_[static_cast<std::size_t>(blockCount_)] = blockDb;
                ++blockCount_;
            }
            else
            {
                // full: drop the oldest (2 hours of history — the page keeps everything, we keep the last 2 h)
                for (int i = 1; i < kMaxBlocks; ++i)
                {
                    blocks_[static_cast<std::size_t>(i - 1)] = blocks_[static_cast<std::size_t>(i)];
                    blocksDb_[static_cast<std::size_t>(i - 1)] = blocksDb_[static_cast<std::size_t>(i)];
                }
                blocks_[static_cast<std::size_t>(kMaxBlocks - 1)] = blockMs;
                blocksDb_[static_cast<std::size_t>(kMaxBlocks - 1)] = blockDb;
            }
        }
        if (hopCount_ >= 30 && sVal > -70.0f)
        {
            shorts_[static_cast<std::size_t>(shortPos_)] = static_cast<double>(sVal);
            shortPos_ = (shortPos_ + 1) % kMaxShorts;
            if (shortCount_ < kMaxShorts)
                ++shortCount_;
        }
    }
    float iVal = -1000.0f, lra = 0.0f;
    if (blockCount_ > 0)
    {
        double absMean = 0.0;
        for (int i = 0; i < blockCount_; ++i)
            absMean += blocks_[static_cast<std::size_t>(i)];
        absMean /= static_cast<double>(blockCount_);
        const float rel = lufsOf(absMean) - 10.0f;
        double s = 0.0;
        int c = 0;
        for (int i = 0; i < blockCount_; ++i)
        {
            if (blocksDb_[static_cast<std::size_t>(i)] > rel)
            {
                s += blocks_[static_cast<std::size_t>(i)];
                ++c;
            }
        }
        iVal = c > 0 ? lufsOf(s / static_cast<double>(c)) : -1000.0f;
    }
    if (shortCount_ >= 2)
    {
        // relative gate −20 LU below the (absolute-gated) mean of short-term power
        double p = 0.0;
        for (int i = 0; i < shortCount_; ++i)
            p += std::pow(10.0, (shorts_[static_cast<std::size_t>(i)] + 0.691) / 10.0);
        const float relS = lufsOf(p / static_cast<double>(shortCount_)) - 20.0f;
        int kept = 0;
        for (int i = 0; i < shortCount_; ++i)
            if (static_cast<float>(shorts_[static_cast<std::size_t>(i)]) > relS)
                scratch_[static_cast<std::size_t>(kept++)] = shorts_[static_cast<std::size_t>(i)];
        if (kept >= 2)
        {
            heapSort(scratch_.data(), kept);
            auto q = [&](double f) noexcept
            {
                const int idx = std::min(kept - 1, std::max(0, static_cast<int>(std::floor(f * (kept - 1)))));
                return scratch_[static_cast<std::size_t>(idx)];
            };
            lra = static_cast<float>(std::max(0.0, q(0.95) - q(0.10)));
        }
    }
    const float corr = (cLL_ > 0.0 && cRR_ > 0.0) ? static_cast<float>(cLR_ / std::sqrt(cLL_ * cRR_)) : 1.0f;
    LoudnessReading& o = reading_;
    o.m = mVal;
    o.s = sVal;
    o.i = iVal;
    o.lra = lra;
    o.peakL = static_cast<float>(pkL_);
    o.peakR = static_cast<float>(pkR_);
    o.tpL = static_cast<float>(tpkL_);
    o.tpR = static_cast<float>(tpkR_);
    o.corr = corr;
    o.holdPeak = std::max({o.holdPeak, o.peakL, o.peakR});
    o.holdTp = std::max({o.holdTp, o.tpL, o.tpR});
    o.maxM = std::max(o.maxM, mVal);
    o.maxS = std::max(o.maxS, sVal);
    o.hops = static_cast<std::uint32_t>(blockCount_);
    hopPos_ = 0;
    sqL_ = sqR_ = pkL_ = pkR_ = tpkL_ = tpkR_ = 0.0;
    cLL_ = cRR_ = cLR_ = 0.0;
}

} // namespace terminator
