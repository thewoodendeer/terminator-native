#include "terminator/core/BassSequencer.h"

#include <algorithm>
#include <cmath>

#include "terminator/core/planners/JsMath.h"

namespace terminator
{

// ───────────────────────────────── BassPattern ─────────────────────────────────
bool BassPattern::addNote(std::int32_t id, int midiNote, double startBeats, double durBeats, double vel,
                          bool slide) noexcept
{
    if (numNotes >= kBassMaxNotes || loopTicks <= 0)
        return false;
    // rebuildTickMap: onT = round(start·PPQ) % loopTicks; offT = round((start+dur)·PPQ); offT ≤ onT → onT+1; an off
    // past the loop end fires at its wrap
    const auto onRaw = js::roundToInt(startBeats * kBassPpq);
    const std::int64_t onT = ((onRaw % loopTicks) + loopTicks) % loopTicks;
    std::int64_t offT = js::roundToInt((startBeats + durBeats) * kBassPpq);
    if (offT <= onT)
        offT = onT + 1;
    Note& n = notes[numNotes++];
    n.id = id;
    n.onTick = static_cast<std::int32_t>(onT);
    n.offTick = slide ? -1 : static_cast<std::int32_t>(offT >= loopTicks ? offT % loopTicks : offT);
    n.vel = static_cast<float>(vel);
    n.slideBeats = slide ? static_cast<float>(durBeats) : 0.0f;
    n.note = static_cast<std::uint8_t>(std::clamp(midiNote, 0, 127));
    n.slide = slide;
    return true;
}

// ───────────────────────────────── BassTimeline ─────────────────────────────────
bool BassTimeline::add(BassSynth::EventKind kind, std::uint64_t sample, int note, float vel, double value) noexcept
{
    if (count >= kBassMaxTimeline)
        return false;
    // sorted insert by sample; among equal samples the insertion order is kept (the worklet's insertEvent is stable:
    // a note's on precedes its off, an earlier note's off precedes a later note's on when they share a time)
    int i = count;
    while (i > 0 && events[i - 1].sample > sample)
    {
        events[i] = events[i - 1];
        --i;
    }
    events[i] = Event{sample, value, vel, static_cast<std::uint8_t>(std::clamp(note, 0, 127)), kind};
    ++count;
    return true;
}

// ───────────────────────────────── BassSequencer ─────────────────────────────────
void BassSequencer::prepare(double sampleRate, bool keepState) noexcept
{
    sr_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    if (!keepState)
        reset();
}

void BassSequencer::reset() noexcept
{
    playing_ = false;
    arrangerDriven_ = false;
    bendLane_ = true;
    pat_ = nullptr;
    timeline_ = nullptr;
    timelineCursor_ = 0;
    nextTick_ = 0;
    nextTickSample_ = passStart_ = 0.0;
    currentTick_ = -1;
    bendSentValid_ = false;
    soundingCount_ = 0;
    ticks_ = 0;
    timelineFired_ = 0;
}

void BassSequencer::soundingAdd(std::int32_t id, std::uint8_t note) noexcept TERMINATOR_NONBLOCKING
{
    if (soundingCount_ >= kBassMaxSounding)
    {
        for (int j = 0; j + 1 < soundingCount_; ++j) // the TS keeps the last 64 — drop the oldest
            sounding_[j] = sounding_[j + 1];
        --soundingCount_;
    }
    sounding_[soundingCount_++] = Sounding{id, note};
}
void BassSequencer::soundingRemove(std::int32_t id) noexcept TERMINATOR_NONBLOCKING
{
    int w = 0;
    for (int r = 0; r < soundingCount_; ++r)
        if (sounding_[r].id != id)
            sounding_[w++] = sounding_[r];
    soundingCount_ = w;
}

void BassSequencer::setPattern(const BassPattern* p, BassSynth& synth) noexcept TERMINATOR_NONBLOCKING
{
    pat_ = p;
    bendSentValid_ = false; // lastBendSent = NaN: the lane re-posts its value at the next tick
    if (!playing_ || p == nullptr)
    {
        soundingCount_ = 0;
        return;
    }
    // editing while playing: release every sounding note whose pitch changed or whose off vanished (rebuildTickMap)
    int w = 0;
    for (int r = 0; r < soundingCount_; ++r)
    {
        const Sounding s = sounding_[r];
        bool keep = false;
        for (int i = 0; i < p->numNotes; ++i)
            if (p->notes[i].id == s.id)
            {
                keep = !p->notes[i].slide && p->notes[i].note == s.note; // still has an off, same pitch
                break;
            }
        if (keep)
            sounding_[w++] = s;
        else
            synth.pushEvent(BassSynth::EventKind::off, 0, s.note, 0.0f, 0.0, BassTag::seq); // now
    }
    soundingCount_ = w;
    // the TS also wraps nextTick to the new loop length implicitly (inLoop = tick % loopTicks) — same here
}

void BassSequencer::setTimeline(const BassTimeline* t) noexcept TERMINATOR_NONBLOCKING
{
    timeline_ = t;
    timelineCursor_ = 0;
}

void BassSequencer::clearTimeline(BassSynth& synth) noexcept TERMINATOR_NONBLOCKING
{
    timeline_ = nullptr;
    timelineCursor_ = 0;
    synth.clear(BassTag::arr, true); // clearTimeline: clear tag 'arr' release:true + bend 0
    synth.setBendNow(0.0);
}

void BassSequencer::setBendLane(bool on) noexcept TERMINATOR_NONBLOCKING
{
    bendLane_ = on;
    bendSentValid_ = false;
}

void BassSequencer::setBpm(double bpm) noexcept TERMINATOR_NONBLOCKING
{
    bpm_ = std::clamp(bpm, 20.0, 300.0);
}

void BassSequencer::play(std::uint64_t atSample, int offsetTicks,
                         std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING
{
    const auto start = static_cast<double>(std::max(atSample, blockStart));
    playing_ = true;
    nextTick_ = offsetTicks;
    nextTickSample_ = start;
    passStart_ = start - static_cast<double>(offsetTicks) * tickDurSamples();
    currentTick_ = loopTicks() > 0 ? static_cast<int>(((offsetTicks % loopTicks()) + loopTicks()) % loopTicks()) : 0;
    soundingCount_ = 0;
    bendSentValid_ = false;
}

void BassSequencer::stop(BassSynth& synth) noexcept TERMINATOR_NONBLOCKING
{
    playing_ = false;
    currentTick_ = -1;
    soundingCount_ = 0;
    bendSentValid_ = false;
    synth.clear(BassTag::seq, true); // stop(): clear tag 'seq' release:true, then bend 0
    synth.setBendNow(0.0);
}

void BassSequencer::process(std::uint64_t blockStart, int numSamples, BassSynth& synth) noexcept TERMINATOR_NONBLOCKING
{
    if (numSamples <= 0)
        return;
    const double bStart = static_cast<double>(blockStart);
    const double bEnd = bStart + static_cast<double>(numSamples);

    // the arranger's timeline (absolute events) — independent of the pattern transport
    if (timeline_ != nullptr)
    {
        const BassTimeline& t = *timeline_;
        while (timelineCursor_ < t.count && timelineCursor_ < kBassMaxTimeline &&
               static_cast<double>(t.events[timelineCursor_].sample) < bEnd)
        {
            const auto& e = t.events[timelineCursor_++];
            // events already in the past fire now (the TS: at ≤ currentTime → fire now) — a seek mid-preview
            synth.pushEvent(e.kind, e.sample, e.note, e.vel, e.value, BassTag::arr);
            ++timelineFired_;
        }
    }

    if (!playing_ || pat_ == nullptr)
        return;
    const BassPattern& p = *pat_;
    const int loop = p.loopTicks > 0 ? p.loopTicks : 1;
    int guard = 0;
    while (nextTickSample_ < bEnd && guard++ < kBassMaxLoopTicks + 4)
    {
        const std::int64_t tick = nextTick_;
        const int inLoop = static_cast<int>(((tick % loop) + loop) % loop);
        if (inLoop == 0)
            passStart_ = nextTickSample_;
        const auto at = static_cast<std::uint64_t>(std::max(0.0, std::round(nextTickSample_)));
        if (!arrangerDriven_)
        {
            // offs first so a retrigger of the same pitch at this tick isn't eaten
            for (int i = 0; i < p.numNotes; ++i)
            {
                const auto& n = p.notes[i];
                if (!n.slide && n.offTick == inLoop)
                {
                    synth.pushEvent(BassSynth::EventKind::off, at, n.note, 0.0f, 0.0, BassTag::seq);
                    soundingRemove(n.id);
                }
            }
            for (int i = 0; i < p.numNotes; ++i)
            {
                const auto& n = p.notes[i];
                if (n.onTick != inLoop)
                    continue;
                if (n.slide)
                {
                    // SLIDE: bend what's sounding over slideBeats (in seconds at the current tempo)
                    const double sec = static_cast<double>(n.slideBeats) * (tickDurSamples() / sr_) * kBassPpq;
                    synth.pushEvent(BassSynth::EventKind::slide, at, n.note, 0.0f, sec, BassTag::seq);
                    continue;
                }
                synth.pushEvent(BassSynth::EventKind::on, at, n.note, n.vel, 0.0, BassTag::seq);
                soundingAdd(n.id, n.note);
            }
            // the BEND lane: post the bend for this tick when it moved (the wheel owns it while ● REC)
            if (p.hasBend && bendLane_)
            {
                const double b = static_cast<double>(p.bend[std::min(inLoop, kBassMaxLoopTicks - 1)]);
                if (!bendSentValid_ || std::abs(b - lastBendSent_) > 0.002)
                {
                    synth.pushEvent(BassSynth::EventKind::bend, at, 0, 0.0f, b, BassTag::seq);
                    lastBendSent_ = b;
                    bendSentValid_ = true;
                }
            }
        }
        ++ticks_;
        nextTick_ = tick + 1;
        nextTickSample_ += tickDurSamples();
    }
    // the playhead: the tick the block end falls in
    const double td = tickDurSamples();
    if (td > 0.0)
    {
        const double elapsed = bEnd - passStart_;
        const double raw = elapsed > 0.0 ? elapsed / td : 0.0;
        const auto fl = static_cast<std::int64_t>(std::floor(raw));
        currentTick_ = static_cast<int>(((fl % loop) + loop) % loop);
    }
}

} // namespace terminator
