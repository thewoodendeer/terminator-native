#include "terminator/core/Metronome.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr double kPi = 3.14159265358979323846;
constexpr double kDownbeatToleranceSec = 0.005; // a beat within 5 ms before the count-in's downbeat IS the downbeat
} // namespace

void Metronome::prepare(double sampleRate, bool keepState) noexcept
{
    sr_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    // the TS noiseBuffer: 0.2 s of white noise, played from frame 0 on every click — a fixed seeded table here so a
    // render is deterministic (xorshift64*, uniform in [−1, 1))
    noiseFrames_ = static_cast<std::int32_t>(std::min<double>(kMaxNoiseFrames, std::round(kNoiseSec * sr_)));
    std::uint64_t x = 0x9E3779B97F4A7C15ull;
    for (std::int32_t i = 0; i < noiseFrames_; ++i)
    {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        const std::uint64_t r = x * 0x2545F4914F6CDD1Dull;
        noise_[i] = static_cast<float>(static_cast<double>(r >> 11) * (1.0 / 9007199254740992.0) * 2.0 - 1.0);
    }
    if (!keepState)
        reset();
}

void Metronome::reset() noexcept
{
    // the transport state only — `enabled_`, `sound_`, `bpm_` (preferences / the session tempo) survive a restart
    for (auto& p : pending_)
        p.used = false;
    for (auto& e : elements_)
        e.active = false;
    lastBeat_ = -1;
    lastClickSample_ = 0;
    lastClickAccent_ = lastClickCountIn_ = false;
    countInPending_ = false;
    countInBeats_ = countInFired_ = 0;
    countInDownbeatD_ = 0.0;
    countInDownbeat_ = 0;
}

std::int32_t Metronome::toSamples(double sec) const noexcept TERMINATOR_NONBLOCKING
{
    return static_cast<std::int32_t>(std::llround(sec * sr_));
}

void Metronome::setEnabled(bool on) noexcept TERMINATOR_NONBLOCKING
{
    if (enabled_ == on)
        return;
    enabled_ = on;
    if (!on)
        transportStopped(); // the booked beats go; a count-in is not METRO's (TS: count-in clicks regardless)
}

void Metronome::setSound(ClickSound s) noexcept TERMINATOR_NONBLOCKING
{
    sound_ = s;
}

void Metronome::setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING
{
    if (std::isfinite(bpm) && bpm > 0.0)
        bpm_ = std::clamp(bpm, 20.0, 300.0);
}

void Metronome::pushPending(double sample, std::uint8_t beatIdx, bool accent,
                            bool countIn) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& p : pending_)
        if (!p.used)
        {
            p.used = true;
            p.sample = sample;
            p.beatIdx = beatIdx;
            p.accent = accent;
            p.countIn = countIn;
            return;
        }
    // a full ring (64 clicks waiting): drop — the drums' 110 ms look-ahead books at most a few beats ahead
}

int Metronome::pendingCount() const noexcept TERMINATOR_NONBLOCKING
{
    int n = 0;
    for (const auto& p : pending_)
        n += p.used ? 1 : 0;
    return n;
}

void Metronome::countIn(int beats, std::uint64_t atSample, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING
{
    cancelCountIn();
    const int n = std::clamp(beats, 1, 16);
    const auto at = static_cast<double>(std::max(atSample, blockStart));
    const double beatSamples = 60.0 / bpm_ * sr_; // the TS: beatDur read once when the count-in is scheduled
    for (int i = 0; i < n; ++i)
        pushPending(at + static_cast<double>(i) * beatSamples, static_cast<std::uint8_t>(i), i == 0, true);
    countInPending_ = true;
    countInBeats_ = n;
    countInFired_ = 0;
    countInDownbeatD_ = at + static_cast<double>(n) * beatSamples;
    countInDownbeat_ = static_cast<std::uint64_t>(std::llround(countInDownbeatD_));
}

void Metronome::cancelCountIn() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& p : pending_)
        if (p.used && p.countIn)
            p.used = false;
    countInPending_ = false;
    countInBeats_ = countInFired_ = 0;
    countInDownbeatD_ = 0.0;
    countInDownbeat_ = 0;
}

void Metronome::transportStopped() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& p : pending_)
        if (p.used && !p.countIn)
            p.used = false;
}

void Metronome::onGridStep(const GridStep& step) noexcept TERMINATOR_NONBLOCKING
{
    if (!enabled_ || step.stepsPerBar <= 0 || !(step.dur > 0.0) || step.index < 0)
        return;
    const double spb = static_cast<double>(step.stepsPerBar);
    const double beatStart = static_cast<double>(step.index) * 4.0 / spb;
    const double beatEnd = static_cast<double>(step.index + 1) * 4.0 / spb;
    const double samplesPerBeat = spb / 4.0 * step.dur; // at THIS step's tempo
    const double dedupe = kDedupeSec * sr_;
    for (double b = std::ceil(beatStart - 1e-9); b < beatEnd - 1e-9; b += 1.0)
    {
        const double t = step.sample + (b - beatStart) * samplesPerBeat;
        // a pending count-in owns the clicks up to its downbeat (the TS "don't also schedule metronome clicks")
        if (countInPending_ && t < countInDownbeatD_ - kDownbeatToleranceSec * sr_)
            continue;
        // the same beat reported twice (a driver hand-over: drums → chop seq at one anchor) is one click
        bool dup = std::abs(t - static_cast<double>(lastClickSample_)) < dedupe && clicks_ > 0 && !lastClickCountIn_;
        for (const auto& p : pending_)
            dup = dup || (p.used && !p.countIn && std::abs(p.sample - t) < dedupe);
        if (dup)
            continue;
        const int beatIdx = static_cast<int>(std::llround(b)) % 4;
        pushPending(t, static_cast<std::uint8_t>(beatIdx < 0 ? beatIdx + 4 : beatIdx), beatIdx == 0, false);
    }
}

Metronome::Element* Metronome::allocate() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& e : elements_)
        if (!e.active)
            return &e;
    // every slot busy (impossible at musical tempi — 24 elements = 8 claps): steal the oldest
    Element* oldest = &elements_[0];
    for (auto& e : elements_)
        if (e.pos > oldest->pos)
            oldest = &e;
    return oldest;
}

void Metronome::startSine(double hz, double sweepToHz, double sweepSec, float peak, double attackSec, double decaySec,
                          double stopSec, std::int32_t offset) noexcept TERMINATOR_NONBLOCKING
{
    Element* e = allocate();
    *e = Element{};
    e->active = true;
    e->kind = Kind::sine;
    e->startOffset = offset;
    e->pos = 0;
    e->stopAt = std::max<std::int32_t>(1, toSamples(stopSec));
    e->peak = peak;
    e->attackEnd = std::max<std::int32_t>(0, toSamples(attackSec));
    e->decayEnd = std::max<std::int32_t>(e->attackEnd + 1, toSamples(decaySec));
    e->phase = 0.0;
    e->phaseInc = 2.0 * kPi * hz / sr_;
    if (sweepToHz > 0.0 && sweepSec > 0.0 && hz > 0.0)
    {
        e->sweepEnd = std::max<std::int32_t>(1, toSamples(sweepSec));
        e->sweepRate = std::pow(sweepToHz / hz, 1.0 / static_cast<double>(e->sweepEnd));
    }
    else
    {
        e->sweepEnd = 0;
        e->sweepRate = 1.0;
    }
}

void Metronome::startNoise(bool bandpass, double hz, double q, float peak, double decaySec, double stopSec,
                           std::int32_t offset) noexcept TERMINATOR_NONBLOCKING
{
    Element* e = allocate();
    *e = Element{};
    e->active = true;
    e->kind = bandpass ? Kind::noiseBp : Kind::noiseHp;
    e->startOffset = offset;
    e->pos = 0;
    e->stopAt = std::max<std::int32_t>(1, toSamples(stopSec));
    e->peak = peak;
    e->attackEnd = 0;
    e->decayEnd = std::max<std::int32_t>(1, toSamples(decaySec));
    // the Web Audio BiquadFilterNode formulas: highpass takes Q in dB (default 1), bandpass a linear Q
    const double fc = std::min(hz, 0.49 * sr_);
    const double w0 = 2.0 * kPi * fc / sr_;
    const double cs = std::cos(w0), sn = std::sin(w0);
    double b0, b1, b2, a0, a1, a2;
    if (bandpass)
    {
        const double alpha = sn / (2.0 * std::max(1e-6, q));
        b0 = alpha;
        b1 = 0.0;
        b2 = -alpha;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cs;
        a2 = 1.0 - alpha;
    }
    else
    {
        const double alpha = sn / (2.0 * std::pow(10.0, q / 20.0));
        b0 = (1.0 + cs) / 2.0;
        b1 = -(1.0 + cs);
        b2 = (1.0 + cs) / 2.0;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cs;
        a2 = 1.0 - alpha;
    }
    e->b0 = b0 / a0;
    e->b1 = b1 / a0;
    e->b2 = b2 / a0;
    e->a1 = a1 / a0;
    e->a2 = a2 / a0;
    e->x1 = e->x2 = e->y1 = e->y2 = 0.0;
}

void Metronome::fireClick(bool accent, std::int32_t offset) noexcept TERMINATOR_NONBLOCKING
{
    // the TS scheduleMetronomeClick graphs, per sound (gains straight into the destination)
    switch (sound_)
    {
    case ClickSound::click:
        startSine(accent ? 1400.0 : 900.0, 0.0, 0.0, accent ? 0.6f : 0.4f, 0.001, 0.06, 0.07, offset);
        break;
    case ClickSound::hihat:
        startNoise(false, accent ? 9000.0 : 7000.0, 1.0, accent ? 0.4f : 0.25f, accent ? 0.08 : 0.05, 0.1, offset);
        break;
    case ClickSound::rimshot:
        startNoise(true, 1200.0, 0.5, accent ? 0.5f : 0.35f, 0.05, 0.06, offset);
        startSine(200.0, 0.0, 0.0, accent ? 0.3f : 0.2f, 0.0, 0.04, 0.05, offset);
        break;
    case ClickSound::kick:
        startSine(accent ? 180.0 : 140.0, 40.0, 0.25, accent ? 0.8f : 0.6f, 0.0, 0.3, 0.35, offset);
        break;
    case ClickSound::clap:
        startNoise(true, 1800.0, 0.8, accent ? 0.45f : 0.3f, 0.06, 0.07, offset);
        startNoise(true, 1800.0, 0.8, accent ? 0.45f : 0.3f, 0.06, 0.07, offset + toSamples(0.008));
        startNoise(true, 1800.0, 0.8, accent ? 0.45f : 0.3f, 0.06, 0.07, offset + toSamples(0.016));
        break;
    }
}

float Metronome::renderElements(int numSamples, float* outL, float* outR) noexcept TERMINATOR_NONBLOCKING
{
    float peak = 0.0f;
    for (auto& e : elements_)
    {
        if (!e.active)
            continue;
        if (e.startOffset >= numSamples)
        {
            e.startOffset -= numSamples; // a clap burst booked past this block
            continue;
        }
        const int first = std::max<std::int32_t>(0, e.startOffset);
        e.startOffset = 0;
        for (int i = first; i < numSamples; ++i)
        {
            if (e.pos >= e.stopAt)
            {
                e.active = false;
                break;
            }
            // the gain automation: linear 0 → peak over the attack, exponential peak → floor over the decay, the floor
            // held until the source stops (Web Audio: the last ramp's end value stays)
            float g;
            if (e.pos < e.attackEnd)
                g = e.peak * static_cast<float>(e.pos) / static_cast<float>(e.attackEnd);
            else if (e.pos < e.decayEnd)
            {
                const double frac =
                    static_cast<double>(e.pos - e.attackEnd) / static_cast<double>(e.decayEnd - e.attackEnd);
                g = e.peak *
                    static_cast<float>(std::pow(static_cast<double>(kDecayFloor) / static_cast<double>(e.peak), frac));
            }
            else
                g = kDecayFloor;
            float v;
            if (e.kind == Kind::sine)
            {
                v = static_cast<float>(std::sin(e.phase));
                e.phase += e.phaseInc;
                if (e.phase > 2.0 * kPi)
                    e.phase -= 2.0 * kPi;
                if (e.pos < e.sweepEnd)
                    e.phaseInc *= e.sweepRate;
            }
            else
            {
                const double x = static_cast<double>(noise_[noiseFrames_ > 0 ? e.pos % noiseFrames_ : 0]);
                const double y = e.b0 * x + e.b1 * e.x1 + e.b2 * e.x2 - e.a1 * e.y1 - e.a2 * e.y2;
                e.x2 = e.x1;
                e.x1 = x;
                e.y2 = e.y1;
                e.y1 = y;
                v = static_cast<float>(y);
            }
            const float s = v * g;
            if (outL != nullptr)
                outL[i] += s;
            if (outR != nullptr)
                outR[i] += s;
            const float a = s < 0.0f ? -s : s;
            peak = a > peak ? a : peak;
            ++e.pos;
        }
    }
    return peak;
}

float Metronome::process(std::uint64_t blockStart, int numSamples, float* outL,
                         float* outR) noexcept TERMINATOR_NONBLOCKING
{
    if (numSamples <= 0)
        return 0.0f;
    const double bStart = static_cast<double>(blockStart);
    const double bEnd = bStart + static_cast<double>(numSamples);
    // the clicks inside this block, in time order
    for (;;)
    {
        Pending* best = nullptr;
        for (auto& p : pending_)
            if (p.used && p.sample < bEnd && (best == nullptr || p.sample < best->sample))
                best = &p;
        if (best == nullptr)
            break;
        const auto off =
            static_cast<std::int32_t>(std::clamp(best->sample - bStart, 0.0, static_cast<double>(numSamples - 1)));
        fireClick(best->accent, off);
        ++clicks_;
        lastClickSample_ = blockStart + static_cast<std::uint64_t>(off);
        lastClickAccent_ = best->accent;
        lastClickCountIn_ = best->countIn;
        if (best->countIn)
            ++countInFired_;
        else
            lastBeat_ = best->beatIdx;
        best->used = false;
    }
    // the count-in's downbeat passed: the transport (started by the page at that sample) owns the beats again
    if (countInPending_ && countInDownbeatD_ < bEnd)
        countInPending_ = false;
    return renderElements(numSamples, outL, outR);
}

int Metronome::countInBeat() const noexcept TERMINATOR_NONBLOCKING
{
    if (!countInPending_)
        return -1;
    return countInFired_ == 0 ? countInBeats_ : countInBeats_ - (countInFired_ - 1);
}

} // namespace terminator
