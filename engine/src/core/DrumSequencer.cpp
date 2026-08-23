#include "terminator/core/DrumSequencer.h"

#include <algorithm>
#include <cmath>

#include "terminator/core/planners/JsMath.h"
#include "terminator/core/planners/Swing.h"

namespace terminator
{

void DrumSequencer::prepare(double sampleRate) noexcept
{
    sr_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    reset();
}

void DrumSequencer::reset() noexcept
{
    playing_ = false;
    pat_ = nullptr;
    graphs_ = nullptr;
    for (auto& s : swaps_)
        s.used = false;
    nextStep_ = 0;
    nextStepSample_ = schedLoopStart_ = audibleLoopStart_ = 0.0;
    currentStep_ = -1;
    currentPhase_ = 0.0;
    for (auto& h : pending_)
        h.used = false;
    gridLogCount_ = 0;
}

int DrumSequencer::takeGridLog(GridStep* out, int maxOut) noexcept TERMINATOR_NONBLOCKING
{
    const int n = std::min(gridLogCount_, maxOut);
    for (int i = 0; i < n; ++i)
        out[i] = gridLog_[i];
    gridLogCount_ = 0;
    return n;
}

void DrumSequencer::setPattern(const DrumPattern* p) noexcept TERMINATOR_NONBLOCKING
{
    pat_ = p;
    if (pat_ != nullptr && nextStep_ >= pat_->stepCount)
        nextStep_ = 0; // a shorter pattern (fewer bars): wrap at its new end
}

void DrumSequencer::schedulePattern(const DrumPattern* p, std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING
{
    if (p == nullptr)
        return;
    const auto at = static_cast<double>(atSample);
    const double tol = 1e-4 * sr_; // TS: a swap within 1e-4 s of an existing one replaces it
    Swap* slot = nullptr;
    for (auto& s : swaps_)
    {
        if (s.used && std::abs(s.atSample - at) <= tol)
        {
            slot = &s;
            break;
        }
        if (!s.used && slot == nullptr)
            slot = &s;
    }
    if (slot == nullptr)
        return; // 64 swaps already booked — an arrangement longer than anything the UI builds
    slot->used = true;
    slot->pattern = p;
    slot->atSample = at;
}

void DrumSequencer::clearScheduled() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& s : swaps_)
        s.used = false;
}

void DrumSequencer::setGraphs(const DrumGraphs* g) noexcept TERMINATOR_NONBLOCKING
{
    graphs_ = g;
}

void DrumSequencer::setLane(int lane, float volume, bool audible, std::int16_t group) noexcept TERMINATOR_NONBLOCKING
{
    if (lane < 0 || lane >= kDrumLanes)
        return;
    lanes_[lane].volume = std::clamp(volume, 0.0f, 1.0f);
    lanes_[lane].audible = audible;
    lanes_[lane].group = group;
}

void DrumSequencer::setParams(double swing, float masterVolume, int ppq) noexcept TERMINATOR_NONBLOCKING
{
    swing_ = std::clamp(swing, 0.0, 1.0);
    master_ = std::clamp(masterVolume, 0.0f, 1.0f);
    ppq_ = std::clamp(ppq, 1, 3840);
}

void DrumSequencer::setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING
{
    bpm_ = std::clamp(bpm, 20.0, 300.0);
}

int DrumSequencer::total() const noexcept TERMINATOR_NONBLOCKING
{
    return pat_ != nullptr ? std::clamp(pat_->stepCount, 1, kDrumMaxSteps) : 2 * kDrumStepsPerBar;
}

double DrumSequencer::stepDurSamples(const DrumPattern* p) const noexcept TERMINATOR_NONBLOCKING
{
    const double spb = (p != nullptr && p->stepsPerBar > 0) ? static_cast<double>(p->stepsPerBar)
                                                            : static_cast<double>(kDrumStepsPerBar);
    return (60.0 / bpm_) * (4.0 / spb) * sr_;
}

const DrumPattern* DrumSequencer::patternAt(double sample) const noexcept TERMINATOR_NONBLOCKING
{
    // the last swap at or before `sample` (TS patternFor), else the live pattern
    const DrumPattern* best = pat_;
    double bestAt = -1.0;
    for (const auto& s : swaps_)
        if (s.used && s.atSample <= sample && s.atSample > bestAt)
        {
            best = s.pattern;
            bestAt = s.atSample;
        }
    return best;
}

void DrumSequencer::play(std::uint64_t atSample, int stepOffset,
                         std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING
{
    const auto start = static_cast<double>(std::max(atSample, blockStart));
    const int n = total();
    const int off = ((stepOffset % n) + n) % n;
    playing_ = true;
    nextStep_ = off;
    nextStepSample_ = start;
    schedLoopStart_ = audibleLoopStart_ = start - static_cast<double>(off) * stepDurSamples(pat_);
    currentStep_ = off;
    currentPhase_ = 0.0;
    for (auto& h : pending_)
        h.used = false;
}

void DrumSequencer::stop(Sampler& sampler) noexcept TERMINATOR_NONBLOCKING
{
    playing_ = false;
    currentStep_ = -1;
    currentPhase_ = 0.0;
    for (auto& h : pending_)
        h.used = false;
    for (auto& s : swaps_)
        s.used = false; // TS stop(): the arranged timeline is dropped
    gridLogCount_ = 0;
    sampler.stopPadRange(static_cast<std::uint16_t>(kDrumPadBase), static_cast<std::uint16_t>(kDrumLanes));
}

void DrumSequencer::pushEvent(double sample, int lane, float velocity, float pan,
                              std::uint8_t kind) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& h : pending_)
        if (!h.used)
        {
            h.used = true;
            h.sample = sample;
            h.lane = static_cast<std::uint16_t>(lane);
            h.velocity = velocity;
            h.pan = pan;
            h.kind = kind;
            return;
        }
    // a full ring (1024 events waiting) drops the event — impossible at musical resolutions
}

void DrumSequencer::scheduleStep(const DrumPattern& p, int step, double gridSample,
                                 const Sampler& sampler) noexcept TERMINATOR_NONBLOCKING
{
    const std::uint64_t row = p.grid[step];
    if (row == 0)
        return;
    const double stepDur = stepDurSamples(&p);
    // SWING indexes 16ths: the 16th slot this internal step sits in (floor(step / 6) at 96/bar) — a 32nd between two
    // 16ths moves with the slot that contains it (DrumEngine.swingOffset)
    const int per16 = std::max(1, p.stepsPerBar / 16);
    const double swingSamples = swing::swingOffsetSec(step / per16, bpm_, swing_) * sr_;
    const double baseSample = gridSample + swingSamples;
    // the next step's STRAIGHT grid time bounds a note-repeat roll (the grid itself is never swung)
    const double nextStepSample = gridSample + stepDur;
    const double pulseSamples = ppq_ > 0 ? (60.0 / bpm_) / static_cast<double>(ppq_) * sr_ : 0.0;
    const double guard = kSubHitGuardSec * sr_;
    for (int lane = 0; lane < kDrumLanes; ++lane)
    {
        if (((row >> lane) & 1u) == 0)
            continue;
        const Lane& ln = lanes_[lane];
        if (!ln.audible || ln.volume <= 0.0f)
            continue;
        const int pad = kDrumPadBase + lane;
        // SHIFT (ms) snapped to the PPQ pulse (960 ≈ continuous, 24 = SP-1200 coarse), on top of the swung time
        double shiftSamples =
            graphs_ != nullptr ? static_cast<double>(graphs_->shiftMs[step][lane]) / 1000.0 * sr_ : 0.0;
        if (pulseSamples > 0.0)
            shiftSamples = js::round(shiftSamples / pulseSamples) * pulseSamples;
        const double hitSample = baseSample + shiftSamples; // may precede the grid (fired early, or clamped at play)
        const float stepVel = graphs_ != nullptr ? graphs_->velocity[step][lane] : 1.0f;
        const float vel = ln.volume * std::clamp(stepVel, 0.0f, 1.0f) * master_;
        if (vel <= 0.0f)
            continue;
        const float pan = graphs_ != nullptr ? std::clamp(graphs_->pan[step][lane], -1.0f, 1.0f) : 0.0f;
        const int rep = graphs_ != nullptr ? std::clamp<int>(graphs_->repeat[step][lane], 0, kDrumRepeatRates - 1) : 0;
        const double beats = kDrumRepeatBeats[rep];
        const double interval = beats > 0.0 ? beats * (60.0 / bpm_) * sr_ : 0.0;
        int count = 0;
        if (interval > guard)
            for (double t = hitSample; t < nextStepSample - guard; t += interval)
                ++count;
        if (count < 2)
        {
            // no real subdivision (repeat off, rate ≥ the slot, or a heavy shift pushed the step past its boundary):
            // one normal full-length voice (the lane's retrigger + mute-group chain applies at the hit)
            pushEvent(hitSample, lane, vel, pan, 1);
            continue;
        }
        // a roll: each sub-hit self-chokes INTO the next (the last into the step boundary); the fade (the lane's
        // 4 ms) ENDS at `ch = max(when + attack + fade, next)` and starts at max(when + attack, ch − fade) — TS
        // emitVoice
        const auto& pp = sampler.pad(pad).params;
        // whole samples (the params are float32: 0.004f × 48000 = 192.0000091 would push the end a sample early)
        const double fade = std::round(static_cast<double>(pp.chokeFadeSec) * sr_);
        const double atk = std::round(static_cast<double>(pp.attackSec) * sr_);
        double t = hitSample;
        for (int i = 0; i < count; ++i)
        {
            const double next = (i + 1 < count) ? t + interval : nextStepSample;
            const double ch = std::max(t + atk + fade, next);
            pushEvent(t, lane, vel, pan, 2);
            pushEvent(std::max(t + atk, ch - fade), lane, 0.0f, 0.0f, 0);
            t += interval;
        }
    }
}

void DrumSequencer::process(std::uint64_t blockStart, int numSamples, Sampler& sampler,
                            const double* liveHitSample) noexcept TERMINATOR_NONBLOCKING
{
    if (!playing_ || numSamples <= 0)
        return;
    const double bStart = static_cast<double>(blockStart);
    const double bEnd = bStart + static_cast<double>(numSamples);
    const double horizon = bEnd + kLookaheadSec * sr_;

    // 1. schedule every step whose STRAIGHT grid time falls before the horizon (hits land earlier with a negative
    //    SHIFT, later with swing / a positive SHIFT)
    int guard = 0;
    while (nextStepSample_ < horizon && guard++ < kDrumMaxSteps + 4)
    {
        const int n = total();
        if (nextStep_ >= n)
            nextStep_ = 0; // drums always loop
        if (nextStep_ == 0)
            schedLoopStart_ = nextStepSample_;
        // the pattern active at this step's play time — resolved HALF A STEP late (the TS tolerance: a swap sits on a
        // step boundary; the two times can disagree by rounding)
        const DrumPattern* live = pat_;
        const double stepDur = stepDurSamples(live);
        const DrumPattern* p = patternAt(nextStepSample_ + stepDur * 0.5);
        if (p != nullptr && nextStep_ < p->stepCount)
            scheduleStep(*p, nextStep_, nextStepSample_, sampler);
        if (gridLogCount_ < kMaxGridLog)
            gridLog_[gridLogCount_++] =
                GridStep{nextStepSample_, stepDur, nextStep_,
                         (live != nullptr && live->stepsPerBar > 0) ? live->stepsPerBar : kDrumStepsPerBar};
        nextStepSample_ += stepDur;
        ++nextStep_;
    }

    // 2. every event inside this block, in TIME order (a sub-hit end before a hit at the same sample)
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
        const auto pad = static_cast<std::uint16_t>(kDrumPadBase + best->lane);
        if (best->kind == 0)
            sampler.stopSubHitsAt(pad, off);
        else
        {
            // one owner per hit: a live hit of this lane within the window (before OR after) already is this hit
            const bool liveOwned = liveHitSample != nullptr && pad < kMaxPads &&
                                   std::abs(best->sample - liveHitSample[pad]) < kLiveOwnerWindowSec * sr_;
            if (liveOwned)
                ++hitsSkipped_;
            else
            {
                sampler.triggerEx(pad, best->velocity, off, best->pan, best->kind == 2);
                ++hitsFired_;
            }
        }
        best->used = false;
    }

    // 3. the audible position: the pass the playhead is in (the scheduled pass runs up to kLookaheadSec ahead) and
    //    the step inside it — the TS getStep() formula on the sample clock
    if (schedLoopStart_ <= bEnd && schedLoopStart_ > audibleLoopStart_)
        audibleLoopStart_ = schedLoopStart_;
    const int n = total();
    const double stepDur = stepDurSamples(pat_);
    if (stepDur > 0.0)
    {
        const double elapsed = bEnd - audibleLoopStart_;
        const double raw = elapsed > 0.0 ? elapsed / stepDur : 0.0;
        const double fl = std::floor(raw);
        currentStep_ = static_cast<int>(std::fmod(fl, static_cast<double>(n)));
        if (currentStep_ < 0)
            currentStep_ += n;
        currentPhase_ = std::clamp(raw - fl, 0.0, 1.0);
    }
}

} // namespace terminator
