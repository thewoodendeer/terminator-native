#include "terminator/core/ChopSequencer.h"

#include <algorithm>
#include <cmath>

#include "terminator/core/planners/Swing.h"

namespace terminator
{

void ChopSequencer::prepare(double sampleRate) noexcept
{
    sr_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    reset();
}

void ChopSequencer::reset() noexcept
{
    playing_ = paused_ = false;
    pat_ = queued_ = nullptr;
    nextStep_ = 0;
    nextStepSample_ = loopStart_ = 0.0;
    currentStep_ = -1;
    currentStepStart_ = 0.0;
    currentStepDur_ = 1.0;
    stopAfter_ = -1.0;
    for (auto& h : pending_)
        h.used = false;
}

void ChopSequencer::setPattern(const SeqPattern* p) noexcept TERMINATOR_NONBLOCKING
{
    pat_ = p;
    loopOverride_ = -1;
    if (loop())
        stopAfter_ = -1.0;
    if (pat_ != nullptr && nextStep_ >= pat_->stepCount)
        nextStep_ = 0; // a shorter pattern: wrap at its new end
}

void ChopSequencer::queuePattern(const SeqPattern* p) noexcept TERMINATOR_NONBLOCKING
{
    if (!playing_ || pat_ == nullptr)
        setPattern(p); // not playing: just take it
    else
        queued_ = p;
}

void ChopSequencer::setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING
{
    bpm_ = std::clamp(bpm, 20.0, 300.0);
}

void ChopSequencer::setLoop(bool loop) noexcept TERMINATOR_NONBLOCKING
{
    loopOverride_ = loop ? 1 : 0;
    if (loop)
        stopAfter_ = -1.0;
}

double ChopSequencer::stepDurSamples(const SeqPattern& p) const noexcept TERMINATOR_NONBLOCKING
{
    const double res = p.resolution > 0 ? static_cast<double>(p.resolution) : 16.0;
    return (60.0 / bpm_) * (4.0 / res) * sr_;
}

void ChopSequencer::play(std::uint64_t atSample, std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING
{
    const auto start = static_cast<double>(std::max(atSample, blockStart));
    playing_ = true;
    paused_ = false;
    nextStep_ = 0;
    nextStepSample_ = start;
    loopStart_ = start;
    currentStep_ = -1;
    currentStepStart_ = start;
    stopAfter_ = -1.0;
    for (auto& h : pending_)
        h.used = false;
}

void ChopSequencer::stop() noexcept TERMINATOR_NONBLOCKING
{
    playing_ = false;
    paused_ = false;
    queued_ = nullptr;
    stopAfter_ = -1.0;
    currentStep_ = -1;
    for (auto& h : pending_)
        h.used = false;
}

void ChopSequencer::pause(std::uint64_t blockStart, Sampler& sampler) noexcept TERMINATOR_NONBLOCKING
{
    if (!playing_ || paused_)
        return;
    paused_ = true;
    pausedAt_ = static_cast<double>(blockStart);
    // the notes the sequencer started stop now (their pending ends are dropped); pending hits wait for resume
    for (auto& h : pending_)
        if (h.used && h.kind == 0)
        {
            sampler.stopPad(h.pad);
            h.used = false;
        }
}

void ChopSequencer::shiftTimes(double delta) noexcept TERMINATOR_NONBLOCKING
{
    nextStepSample_ += delta;
    loopStart_ += delta;
    currentStepStart_ += delta;
    if (stopAfter_ >= 0.0)
        stopAfter_ += delta;
    for (auto& h : pending_)
        if (h.used)
            h.sample += delta;
}

void ChopSequencer::resume(std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING
{
    if (!playing_ || !paused_)
        return;
    paused_ = false;
    shiftTimes(static_cast<double>(blockStart) - pausedAt_);
}

int ChopSequencer::tailKey(int pad, const Sampler& sampler) const noexcept TERMINATOR_NONBLOCKING
{
    const auto g = sampler.pad(pad).params.chokeGroup;
    return g >= 0 ? 1000 + static_cast<int>(g) : 2000 + pad; // a group, or the pad itself ('pad:<i>')
}

void ChopSequencer::scheduleStep(const SeqPattern& p, int step, double gridSample,
                                 const Sampler& sampler) noexcept TERMINATOR_NONBLOCKING
{
    const std::uint64_t row = p.grid[step];
    if (row == 0)
        return;
    const double stepDur = stepDurSamples(p);
    const double swingOff = swing::seqSwingOffsetSec(step, p.resolution, bpm_, p.swing) * sr_;
    const double hitSample = gridSample + swingOff;
    for (int pad = 0; pad < kSeqMaxPads; ++pad)
    {
        if (((row >> pad) & 1u) == 0)
            continue;
        // note length: until the next step where a pad of the SAME tail group fires (wrapping if looping), else
        // the pattern end — in steps × the CURRENT stepDur (TS maxDurFor)
        const int myKey = tailKey(pad, sampler);
        int lengthSteps = p.stepCount - step;
        int nextIdx = -1; // the step of the next same-group hit (its own swing decides the exact end)
        bool found = false;
        for (int s = step + 1; s < p.stepCount && !found; ++s)
        {
            const std::uint64_t r = p.grid[s];
            if (r == 0)
                continue;
            for (int q = 0; q < kSeqMaxPads; ++q)
                if (((r >> q) & 1u) != 0 && tailKey(q, sampler) == myKey)
                {
                    lengthSteps = s - step;
                    nextIdx = s;
                    found = true;
                    break;
                }
        }
        if (!found && loop())
            for (int s = 0; s <= step && !found; ++s)
            {
                const std::uint64_t r = p.grid[s];
                if (r == 0)
                    continue;
                for (int q = 0; q < kSeqMaxPads; ++q)
                    if (((r >> q) & 1u) != 0 && tailKey(q, sampler) == myKey)
                    {
                        lengthSteps = s + p.stepCount - step;
                        nextIdx = s;
                        found = true;
                        break;
                    }
            }
        // the note ends where the NEXT same-group hit actually lands (its grid time + its own swing), else at the
        // pattern end — the GRID time of this step + whole steps, never "this swung hit + steps"
        const double nextSwing = found ? swing::seqSwingOffsetSec(nextIdx, p.resolution, bpm_, p.swing) * sr_ : 0.0;
        const double endSample = gridSample + static_cast<double>(lengthSteps) * stepDur + nextSwing;
        pushEvent(hitSample, pad, std::clamp(p.velocity[step][pad], 0.05f, 1.0f), 1);
        // the 3 ms fade ends AT the next hit (TS: the tail's 5 ms ramp ends at startAt+realDur)
        pushEvent(std::max(hitSample, endSample - kTailFadeSec * sr_), pad, 0.0f, 0);
    }
}

void ChopSequencer::pushEvent(double sample, int pad, float velocity, std::uint8_t kind) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& h : pending_)
        if (!h.used)
        {
            h.used = true;
            h.sample = sample;
            h.pad = static_cast<std::uint16_t>(pad);
            h.velocity = velocity;
            h.kind = kind;
            return;
        }
    // a full ring (512 events waiting) drops the event — impossible at musical resolutions
}

void ChopSequencer::process(std::uint64_t blockStart, int numSamples, Sampler& sampler) noexcept TERMINATOR_NONBLOCKING
{
    if (!playing_ || paused_ || pat_ == nullptr || numSamples <= 0)
        return;
    const double bStart = static_cast<double>(blockStart);
    const double bEnd = bStart + static_cast<double>(numSamples);

    // 1. schedule every step whose grid time falls inside this block (hits may land later — swing)
    int guard = 0;
    while (nextStepSample_ < bEnd && guard++ < kSeqMaxSteps + 4)
    {
        const SeqPattern* p = pat_;
        if (nextStep_ >= p->stepCount)
        {
            if (!loop())
            {
                // non-loop: the transport stops once the last slot has passed (hits already pending still fire)
                stopAfter_ = nextStepSample_;
                break;
            }
            nextStep_ = 0;
        }
        if (nextStep_ == 0)
        {
            if (queued_ != nullptr)
            {
                pat_ = queued_;
                queued_ = nullptr;
                p = pat_;
            }
            loopStart_ = nextStepSample_;
        }
        const double stepDur = stepDurSamples(*p);
        scheduleStep(*p, nextStep_, nextStepSample_, sampler);
        currentStep_ = nextStep_;
        currentStepStart_ = nextStepSample_;
        currentStepDur_ = stepDur;
        nextStepSample_ += stepDur;
        ++nextStep_;
    }

    // 2. every event inside this block, in TIME order (a note end before a hit at the same sample) — the pending
    //    ring is small; a repeated min pick is fine
    for (;;)
    {
        PendingEvent* best = nullptr;
        for (auto& h : pending_)
            if (h.used && h.sample < bEnd &&
                (best == nullptr || h.sample < best->sample || (h.sample == best->sample && h.kind < best->kind)))
                best = &h;
        if (best == nullptr)
            break;
        const int off = static_cast<int>(std::clamp(best->sample - bStart, 0.0, static_cast<double>(numSamples - 1)));
        if (best->kind == 1)
        {
            sampler.trigger(best->pad, best->velocity, off);
            ++hitsFired_;
        }
        else
            sampler.stopPadAt(best->pad, off);
        best->used = false;
    }

    // 3. loop off: stop after the last slot passed (once its hits have fired; trailing note ends may stay pending)
    if (stopAfter_ >= 0.0 && stopAfter_ < bEnd)
    {
        bool hitPending = false;
        for (const auto& h : pending_)
            hitPending = hitPending || (h.used && h.kind == 1);
        if (!hitPending)
            stop();
    }
}

double ChopSequencer::stepPhase(std::uint64_t atSample) const noexcept TERMINATOR_NONBLOCKING
{
    if (!playing_ || currentStep_ < 0 || currentStepDur_ <= 0.0)
        return 0.0;
    const double pos = (paused_ ? pausedAt_ : static_cast<double>(atSample)) - currentStepStart_;
    return std::clamp(pos / currentStepDur_, 0.0, 1.0);
}

} // namespace terminator
