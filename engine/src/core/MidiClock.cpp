#include "terminator/core/MidiClock.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

double midiClockSecondsPerTick(double bpm) noexcept
{
    const double b = (std::isfinite(bpm) && bpm != 0.0) ? bpm : 120.0; // TS: `bpm || 120`
    const double c = std::max(20.0, std::min(400.0, b));
    return 60.0 / c / static_cast<double>(kMidiClockPpqn);
}

// ───────────────────────────────── OUT ─────────────────────────────────

void MidiClockOut::prepare(double sampleRate, bool keepState) noexcept
{
    sr_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    if (!keepState)
        reset();
}

void MidiClockOut::reset() noexcept
{
    // the transport state only — `enabled_` (the preference) and `bpm_` survive a device restart
    running_ = started_ = paused_ = false;
    nextTickSample_ = phaseToNext_ = 0.0;
    tickCount_ = 0;
    for (auto& c : control_)
        c.used = false;
}

double MidiClockOut::tickSamples() const noexcept TERMINATOR_NONBLOCKING
{
    return midiClockSecondsPerTick(bpm_) * sr_;
}

void MidiClockOut::pushControl(std::uint64_t sample, std::uint8_t b0, std::uint8_t b1, std::uint8_t b2,
                               std::uint8_t size) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& c : control_)
        if (!c.used)
        {
            c.used = true;
            c.sample = sample;
            c.data[0] = b0;
            c.data[1] = b1;
            c.data[2] = b2;
            c.size = size;
            return;
        }
    ++controlDropped_;
}

int MidiClockOut::nextControlIndex() const noexcept TERMINATOR_NONBLOCKING
{
    // FIFO: the controls are pushed in time order (stop/pause clear the ring before pushing), so the first used slot
    // is the earliest — ties keep push order (SPP before START before the tick)
    for (int i = 0; i < kMaxControl; ++i)
        if (control_[i].used)
            return i;
    return -1;
}

void MidiClockOut::setEnabled(bool on, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING
{
    if (enabled_ == on)
        return;
    enabled_ = on;
    if (!on && running_)
    {
        for (auto& c : control_)
            c.used = false;
        pushControl(blockStart, kMidiStopByte);
        running_ = started_ = paused_ = false;
    }
}

void MidiClockOut::setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING
{
    if (std::isfinite(bpm) && bpm > 0.0)
        bpm_ = bpm;
}

void MidiClockOut::start(std::uint64_t anchorSample, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING
{
    if (!enabled_)
        return;
    for (auto& c : control_)
        c.used = false; // a pending SPP/START/CONTINUE is moot
    if (running_)
        pushControl(blockStart, kMidiStopByte); // a restart: STOP first (TS stop() → start())
    const auto anchor = std::max(anchorSample, blockStart);
    pushControl(anchor, kMidiSppByte, 0, 0, 3);
    pushControl(anchor, kMidiStartByte);
    running_ = true;
    started_ = false; // ticks flow once the START control fired (same sample, control first)
    paused_ = false;
    nextTickSample_ = static_cast<double>(anchor);
    tickCount_ = 0;
}

void MidiClockOut::stop(std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING
{
    if (!running_)
        return;
    for (auto& c : control_)
        c.used = false;
    pushControl(atSample, kMidiStopByte);
    running_ = started_ = paused_ = false;
}

void MidiClockOut::pause(std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING
{
    if (!running_ || paused_)
        return;
    for (auto& c : control_)
        c.used = false;
    pushControl(atSample, kMidiStopByte);
    paused_ = true;
    phaseToNext_ = std::max(0.0, nextTickSample_ - static_cast<double>(atSample));
}

void MidiClockOut::resume(std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING
{
    if (!running_ || !paused_)
        return;
    paused_ = false;
    const std::uint64_t beats16 = tickCount_ / static_cast<std::uint64_t>(kMidiTicksPerBeat16); // the song position
    const auto lsb = static_cast<std::uint8_t>(beats16 & 0x7Fu);
    const auto msb = static_cast<std::uint8_t>((beats16 >> 7) & 0x7Fu);
    pushControl(atSample, kMidiSppByte, lsb, msb, 3);
    pushControl(atSample, kMidiContinueByte);
    started_ = false; // ticks resume once CONTINUE fired
    nextTickSample_ = static_cast<double>(atSample) + phaseToNext_;
}

int MidiClockOut::process(std::uint64_t blockStart, int numSamples, Event* out,
                          int maxOut) noexcept TERMINATOR_NONBLOCKING
{
    if (out == nullptr || maxOut <= 0 || numSamples <= 0)
        return 0;
    const std::uint64_t blockEnd = blockStart + static_cast<std::uint64_t>(numSamples);
    const double blockEndD = static_cast<double>(blockEnd);
    int written = 0;
    for (;;)
    {
        if (written >= maxOut)
            break; // the rest waits for the next block (never in practice: 128 events per block)
        const int ci = nextControlIndex();
        const bool haveCtl = ci >= 0 && control_[ci].sample < blockEnd;
        const bool haveTick = running_ && started_ && !paused_ && nextTickSample_ < blockEndD;
        if (!haveCtl && !haveTick)
            break;
        const bool emitCtl = haveCtl && (!haveTick || static_cast<double>(control_[ci].sample) <= nextTickSample_);
        Event& e = out[written++];
        if (emitCtl)
        {
            Control& c = control_[ci];
            e.sample = std::max(c.sample, blockStart);
            e.data[0] = c.data[0];
            e.data[1] = c.data[1];
            e.data[2] = c.data[2];
            e.size = c.size;
            if (c.data[0] == kMidiStartByte || c.data[0] == kMidiContinueByte)
                started_ = true;
            else if (c.data[0] == kMidiStopByte)
                started_ = false;
            c.used = false;
        }
        else
        {
            const double t = std::floor(nextTickSample_ + 1e-6);
            const auto s = t > 0.0 ? static_cast<std::uint64_t>(t) : 0u;
            e.sample = std::max(s, blockStart);
            e.data[0] = kMidiClockByte;
            e.data[1] = 0;
            e.data[2] = 0;
            e.size = 1;
            ++tickCount_;
            ++ticksSent_;
            nextTickSample_ += tickSamples(); // the spacing re-read per tick: a BPM change lands at the next tick
        }
    }
    return written;
}

// ───────────────────────────────── IN ──────────────────────────────────

double MidiClockFollower::onTick(double atMs) noexcept
{
    const bool havePrev = count_ > 0;
    const double prev = havePrev ? times_[count_ - 1] : 0.0;
    // A long gap = the clock stopped and started again: start the window over (never read the gap as a crawl).
    if (havePrev && atMs - prev > kDropoutMs)
        reset();
    // A tempo JUMP on the master (the interval leaves the window's mean by > 15 % for three ticks running): drop the
    // old tempo's ticks so the new one reads within a beat instead of blending across the whole window.
    if (count_ >= kMinTicks && havePrev)
    {
        const double mean = (times_[count_ - 1] - times_[0]) / static_cast<double>(count_ - 1);
        const double iv = atMs - prev;
        if (std::fabs(iv - mean) > 0.15 * mean)
        {
            if (++jumpRun_ >= 3)
            {
                // keep the last 3
                times_[0] = times_[count_ - 3];
                times_[1] = times_[count_ - 2];
                times_[2] = times_[count_ - 1];
                count_ = 3;
                jumpRun_ = 0;
            }
        }
        else
            jumpRun_ = 0;
    }
    if (count_ == kWindowTicks)
    {
        for (int i = 1; i < kWindowTicks; ++i)
            times_[i - 1] = times_[i];
        --count_;
    }
    times_[count_++] = atMs;
    ++sinceReport_;
    if (count_ < kMinTicks)
        return 0.0;
    // least-squares slope (ms per tick) over the window — averages USB jitter
    const int n = count_;
    const double mi = static_cast<double>(n - 1) / 2.0;
    double mt = 0.0;
    for (int i = 0; i < n; ++i)
        mt += times_[i];
    mt /= static_cast<double>(n);
    double num = 0.0, den = 0.0;
    for (int i = 0; i < n; ++i)
    {
        const double di = static_cast<double>(i) - mi;
        num += di * (times_[i] - mt);
        den += di * di;
    }
    const double perTick = den > 0.0 ? num / den : 0.0;
    if (!(perTick > 0.0))
        return 0.0;
    const double bpm = std::floor((60000.0 / (perTick * static_cast<double>(kMidiClockPpqn))) * 10.0 + 0.5) / 10.0;
    if (bpm < 20.0 || bpm > 400.0)
        return 0.0;
    const bool fresh = last_ == 0.0 || std::fabs(bpm - last_) >= kHysteresisBpm;
    if (!fresh || (last_ != 0.0 && sinceReport_ < kMidiClockPpqn))
        return 0.0;
    last_ = bpm;
    sinceReport_ = 0;
    return bpm;
}

} // namespace terminator
