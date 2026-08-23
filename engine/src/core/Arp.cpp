#include "terminator/core/Arp.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

void Arp::prepare(double sampleRate, bool keepState) noexcept
{
    sr_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    if (!keepState)
        reset();
}

void Arp::reset() noexcept
{
    // the hold state only — the settings (enabled / rate / direction / random / padCount) and the tempo survive
    holdPad_ = -1;
    step_ = 0;
    nextFire_ = 0.0;
    lastPad_ = -1;
}

void Arp::setParams(bool enabled, int rate, bool down, bool random, int padCount) noexcept TERMINATOR_NONBLOCKING
{
    enabled_ = enabled;
    rate_ = std::max(1, rate); // TS setArpRate: max(1, rate)
    down_ = down;
    random_ = random;
    padCount_ = padCount <= 0 ? kChopPads : std::clamp(padCount, 1, kChopPads);
    if (!enabled_)
        stop(); // TS toggleArp off → stopArp
}

void Arp::setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING
{
    if (std::isfinite(bpm) && bpm > 0.0)
        bpm_ = std::clamp(bpm, 20.0, 300.0);
}

double Arp::intervalSamples() const noexcept TERMINATOR_NONBLOCKING
{
    return 60.0 / bpm_ / static_cast<double>(rate_) * sr_;
}

void Arp::hold(int pad, float velocity, std::uint64_t atSample,
               std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING
{
    if (pad < 0 || pad >= kChopPads)
        return;
    holdPad_ = pad;
    velocity_ = std::clamp(velocity, 0.0f, 1.0f);
    step_ = 0;
    nextFire_ = static_cast<double>(std::max(atSample, blockStart));
}

void Arp::release(int pad) noexcept TERMINATOR_NONBLOCKING
{
    if (holdPad_ < 0)
        return;
    if (pad < 0 || pad == holdPad_)
        stop();
}

void Arp::stop() noexcept TERMINATOR_NONBLOCKING
{
    holdPad_ = -1;
    step_ = 0;
}

int Arp::pickPad() noexcept TERMINATOR_NONBLOCKING
{
    const int n = std::max(1, padCount_);
    if (random_)
    {
        // xorshift64* → Math.floor(Math.random() * padCount)
        rng_ ^= rng_ >> 12;
        rng_ ^= rng_ << 25;
        rng_ ^= rng_ >> 27;
        const std::uint64_t r = rng_ * 0x2545F4914F6CDD1Dull;
        const double u = static_cast<double>(r >> 11) * (1.0 / 9007199254740992.0);
        return std::min(n - 1, static_cast<int>(u * static_cast<double>(n)));
    }
    if (!down_)
        return (holdPad_ + step_) % n;
    return ((holdPad_ - step_) % n + n) % n;
}

void Arp::process(std::uint64_t blockStart, int numSamples, Sampler& sampler,
                  double* liveHitSample) noexcept TERMINATOR_NONBLOCKING
{
    if (holdPad_ < 0 || numSamples <= 0)
        return;
    const double bStart = static_cast<double>(blockStart);
    const double bEnd = bStart + static_cast<double>(numSamples);
    int guard = 0;
    while (nextFire_ < bEnd && guard++ < 4096)
    {
        const int pad = pickPad();
        const auto off =
            static_cast<std::int32_t>(std::clamp(nextFire_ - bStart, 0.0, static_cast<double>(numSamples - 1)));
        sampler.trigger(static_cast<std::uint16_t>(pad), velocity_, off);
        if (liveHitSample != nullptr && pad >= 0 && pad < kMaxPads)
            liveHitSample[pad] = std::max(nextFire_, bStart);
        lastPad_ = pad;
        ++step_;
        ++hits_;
        // the next step: the interval at the CURRENT tempo from this step (a tempo change lands at the next step,
        // the phase is kept — no burst to "catch up" with a re-gridded start)
        nextFire_ = std::max(nextFire_, bStart) + intervalSamples();
    }
}

} // namespace terminator
