#include "terminator/core/Sampler.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
inline float hermite4(float xm1, float x0, float x1, float x2, float t) noexcept
{
    // 4-point, 3rd-order Hermite (Catmull-Rom) — the classic high-quality varispeed interpolator
    const float c0 = x0;
    const float c1 = 0.5f * (x1 - xm1);
    const float c2 = xm1 - 2.5f * x0 + 2.0f * x1 - 0.5f * x2;
    const float c3 = 0.5f * (x2 - xm1) + 1.5f * (x0 - x1);
    return ((c3 * t + c2) * t + c1) * t + c0;
}

inline float readSample(const float* ch, std::int64_t numFrames, std::int64_t i) noexcept
{
    return (i < 0 || i >= numFrames) ? 0.0f : ch[i];
}
} // namespace

void Sampler::prepare(double sampleRate, int /*maxBlockSize*/, int numOutputChannels) noexcept
{
    sampleRate_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    numOutputChannels_ = numOutputChannels;
    reset();
}

void Sampler::reset() noexcept
{
    for (auto& v : voices_)
        v = Voice{};
    activeVoices_ = 0;
}

void Sampler::setPadSample(std::uint16_t pad, const SampleBuffer* sample, std::int64_t startFrame,
                           std::int64_t endFrame) noexcept TERMINATOR_NONBLOCKING
{
    if (pad >= kMaxPads)
        return;
    // the previous sample may be freed soon: fade out anything still reading it
    for (auto& v : voices_)
        if (v.active() && v.pad == pad)
            beginFade(v, kStopFadeSec);
    auto& p = pads_[pad];
    p.sample = sample;
    if (sample == nullptr)
    {
        p.startFrame = p.endFrame = 0;
        return;
    }
    const auto n = sample->numFrames;
    if (endFrame <= 0 || endFrame > n)
        endFrame = n;
    startFrame = std::clamp<std::int64_t>(startFrame, 0, n);
    if (endFrame < startFrame)
        endFrame = startFrame;
    p.startFrame = startFrame;
    p.endFrame = endFrame;
}

void Sampler::setPadParams(const PadParams& p) noexcept TERMINATOR_NONBLOCKING
{
    if (p.pad >= kMaxPads)
        return;
    auto q = p;
    q.pitchSemitones = std::clamp(q.pitchSemitones, -24.0f, 24.0f);
    q.fineCents = std::clamp(q.fineCents, -50.0f, 50.0f);
    q.attackSec = std::clamp(q.attackSec, 0.0f, 0.5f);
    q.releaseSec = std::clamp(q.releaseSec, 0.0f, 0.5f);
    q.gain = std::clamp(q.gain, 0.0f, 4.0f);
    pads_[p.pad].params = q;
}

void Sampler::setPadLoopBuffer(std::uint16_t pad, const SampleBuffer* sample, std::int64_t loopStart,
                               std::int64_t loopEnd) noexcept TERMINATOR_NONBLOCKING
{
    if (pad >= kMaxPads)
        return;
    auto& p = pads_[pad];
    p.loopSample = sample;
    if (sample == nullptr)
    {
        p.loopStartFrame = p.loopEndFrame = 0;
        return;
    }
    p.loopStartFrame = std::clamp<std::int64_t>(loopStart, 0, sample->numFrames);
    p.loopEndFrame = std::clamp<std::int64_t>(loopEnd, p.loopStartFrame + 1, sample->numFrames);
}

Voice* Sampler::allocateVoice() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& v : voices_)
        if (!v.active())
            return &v;
    // steal: the oldest voice that is already fading/releasing, else the oldest overall
    Voice* best = nullptr;
    for (auto& v : voices_)
        if (v.stage == Voice::Stage::fading || v.stage == Voice::Stage::release)
            if (best == nullptr || v.serial < best->serial)
                best = &v;
    if (best == nullptr)
        for (auto& v : voices_)
            if (best == nullptr || v.serial < best->serial)
                best = &v;
    ++steals_;
    if (best != nullptr)
        --activeVoices_; // it is about to be replaced (counted again by the caller)
    return best;
}

void Sampler::beginFadeNow(Voice& v, float seconds) noexcept TERMINATOR_NONBLOCKING
{
    if (!v.active() || v.stage == Voice::Stage::fading)
        return;
    const int n = std::max(1, static_cast<int>(static_cast<double>(seconds) * sampleRate_));
    v.stage = Voice::Stage::fading;
    v.envRemaining = n;
    v.envStep = -v.env / static_cast<float>(n);
    v.fadeOffset = -1;
}

void Sampler::beginFade(Voice& v, float seconds, std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING
{
    if (!v.active() || v.stage == Voice::Stage::fading)
        return;
    if (offsetInBlock > 0)
        v.fadeOffset = offsetInBlock; // the fade starts when the block reaches the choking hit's position
    else
        beginFadeNow(v, seconds);
}

void Sampler::chokeGroupOf(std::uint16_t pad, std::int16_t group, const Voice* keep,
                           std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& v : voices_)
    {
        if (!v.active() || &v == keep)
            continue;
        const bool same = (group == -1) ? (v.pad == pad) // own pad only
                                        : (v.chokeGroup == group);
        if (same)
            beginFade(v, kStopFadeSec, offsetInBlock);
    }
}

void Sampler::trigger(std::uint16_t pad, float velocity, std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING
{
    if (pad >= kMaxPads)
        return;
    const auto& p = pads_[pad];
    if (!p.hasSample())
        return;
    lastTriggeredPad_ = pad;

    // retrigger of an un-gated LOOP pad while looping = stop (toggle) — dossier §2.3
    if (p.params.mode == PadMode::loop)
    {
        bool wasLooping = false;
        for (auto& v : voices_)
            if (v.active() && v.pad == pad && v.mode == PadMode::loop && v.stage != Voice::Stage::fading &&
                v.fadeOffset < 0)
            {
                beginFade(v, kStopFadeSec, offsetInBlock);
                wasLooping = true;
            }
        if (wasLooping)
            return;
    }

    Voice* v = allocateVoice();
    if (v == nullptr)
        return;
    // choke, at the hit's position: −1 = the pad's own previous voice; ≥0 = the whole mute group (and its own
    // previous voice); −2 = poly: nothing is choked
    if (p.params.chokeGroup == -1)
        chokeGroupOf(pad, -1, v, offsetInBlock);
    else if (p.params.chokeGroup >= 0)
    {
        chokeGroupOf(pad, p.params.chokeGroup, v, offsetInBlock);
        chokeGroupOf(pad, -1, v, offsetInBlock);
    }

    *v = Voice{};
    v->stage = Voice::Stage::attack;
    v->pad = pad;
    v->serial = nextSerial_++;
    // A LOOP pad with a rendered crossfade-loop buffer plays THAT buffer from frame 0 (warm-up), then wraps its
    // steady period; reverse is baked into the loop render on the message side, so the voice reads it forward.
    const bool useLoopRender = p.params.mode == PadMode::loop && p.loopSample != nullptr;
    v->loopRendered = useLoopRender;
    v->sample = useLoopRender ? p.loopSample : p.sample;
    v->startFrame = useLoopRender ? 0 : p.startFrame;
    v->endFrame = useLoopRender ? p.loopSample->numFrames : p.endFrame;
    v->loopLo = p.loopStartFrame;
    v->loopHi = p.loopEndFrame;
    v->reverse = useLoopRender ? 0 : p.params.reverse;
    v->mode = p.params.mode;
    v->interpolation = p.params.interpolation;
    v->outputPair = p.params.outputPair;
    v->chokeGroup = p.params.chokeGroup;
    v->velocity = std::clamp(velocity, 0.0f, 1.0f);
    v->gain = v->velocity * p.params.gain;
    const double semis = static_cast<double>(p.params.pitchSemitones) + static_cast<double>(p.params.fineCents) / 100.0;
    v->rate = std::pow(2.0, semis / 12.0) * (p.sample->sampleRate > 0.0 ? p.sample->sampleRate / sampleRate_ : 1.0);
    v->position = v->reverse ? static_cast<double>(v->endFrame) - 1.0 : static_cast<double>(v->startFrame);
    v->startOffset = std::max(0, offsetInBlock);
    const int atk = static_cast<int>(static_cast<double>(p.params.attackSec) * sampleRate_);
    if (atk > 0)
    {
        v->env = 0.0f;
        v->envRemaining = atk;
        v->envStep = 1.0f / static_cast<float>(atk);
    }
    else
    {
        v->env = 1.0f;
        v->envRemaining = 0;
        v->stage = Voice::Stage::sustain;
    }
    v->releaseSamples =
        std::max(1, static_cast<int>(static_cast<double>(std::max(
                                         p.params.releaseSec, p.params.mode == PadMode::gate ? kMinReleaseSec : 0.0f)) *
                                     sampleRate_));
    ++activeVoices_;
}

void Sampler::beginRelease(Voice& v) noexcept TERMINATOR_NONBLOCKING
{
    if (v.stage == Voice::Stage::attack || v.stage == Voice::Stage::sustain)
    {
        v.stage = Voice::Stage::release;
        v.envRemaining = v.releaseSamples;
        v.envStep = -v.env / static_cast<float>(v.releaseSamples);
    }
}

void Sampler::release(std::uint16_t pad, std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& v : voices_)
    {
        if (!v.active() || v.pad != pad || v.mode != PadMode::gate || v.released)
            continue;
        v.released = true;
        if (offsetInBlock > 0)
            v.releaseOffset = offsetInBlock; // applied inside renderVoice when the block reaches it
        else
            beginRelease(v);
    }
}

void Sampler::stopPad(std::uint16_t pad) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& v : voices_)
        if (v.active() && v.pad == pad)
            beginFade(v, kStopFadeSec);
}

void Sampler::stopAll() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& v : voices_)
        if (v.active())
            beginFade(v, kStopFadeSec);
}

void Sampler::renderVoice(Voice& v, float* const* outputs, int numOutputChannels,
                          int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    const int outL = static_cast<int>(v.outputPair) * 2;
    const int outR = outL + 1;
    float* l = outL < numOutputChannels ? outputs[outL] : nullptr;
    float* r = outR < numOutputChannels ? outputs[outR] : nullptr;
    if (l == nullptr && r == nullptr)
    {
        // output pair not available on this device: keep the voice running silently
    }
    const auto* s = v.sample;
    const std::int64_t nFrames = s->numFrames;
    const int nCh = s->numChannels;
    const float* chL = s->channel(0);
    const float* chR = nCh > 1 ? s->channel(1) : chL;
    const double regionStart = static_cast<double>(v.startFrame);
    const double regionEnd = static_cast<double>(v.endFrame); // exclusive
    const double regionLen = regionEnd - regionStart;

    int i = v.startOffset;
    v.startOffset = 0;
    for (; i < numSamples; ++i)
    {
        if (v.fadeOffset >= 0 && i >= v.fadeOffset)
            beginFadeNow(v, kStopFadeSec);
        if (v.releaseOffset >= 0 && i >= v.releaseOffset)
        {
            v.releaseOffset = -1;
            beginRelease(v);
        }
        // ---- envelope ----
        if (v.envRemaining > 0)
        {
            v.env += v.envStep;
            if (--v.envRemaining == 0)
            {
                if (v.stage == Voice::Stage::attack)
                {
                    v.env = 1.0f;
                    v.stage = Voice::Stage::sustain;
                }
                else // release or fading finished
                {
                    v.env = 0.0f;
                    v.stage = Voice::Stage::idle;
                    --activeVoices_;
                    return;
                }
            }
        }

        // ---- position / end handling ----
        bool pastEnd = v.loopRendered ? (v.position >= static_cast<double>(v.loopHi))
                                      : (v.reverse ? (v.position < regionStart) : (v.position >= regionEnd));
        if (pastEnd)
        {
            if (v.mode == PadMode::loop && v.loopRendered)
            {
                // rendered crossfade loop: the steady period is [loopLo, loopHi); after the warm-up the position
                // wraps within it, so every pass is the identical crossfaded period (no seam click)
                const double period = static_cast<double>(v.loopHi - v.loopLo);
                if (period > 0.0 && v.position >= static_cast<double>(v.loopHi))
                {
                    v.position -= period;
                    pastEnd = false;
                }
            }
            else if (v.mode == PadMode::loop && regionLen > 0.0)
            {
                // raw hard wrap of the region (no fades set → no render)
                if (v.reverse)
                    v.position += regionLen;
                else
                    v.position -= regionLen;
                pastEnd = false;
            }
            else if (!v.tailStarted)
            {
                // one-shot / gate reached the region end: the release tail fades whatever follows (dossier §2.3 step 7)
                v.tailStarted = true;
                if (v.stage != Voice::Stage::fading && v.stage != Voice::Stage::release)
                {
                    v.stage = Voice::Stage::release;
                    v.envRemaining = v.releaseSamples;
                    v.envStep = -v.env / static_cast<float>(v.releaseSamples);
                }
            }
        }

        // ---- read + interpolate ----
        float outSampleL = 0.0f, outSampleR = 0.0f;
        const double fpos = v.position;
        const auto i0 = static_cast<std::int64_t>(std::floor(fpos));
        const float t = static_cast<float>(fpos - static_cast<double>(i0));
        if (v.interpolation == Interpolation::hermite)
        {
            outSampleL = hermite4(readSample(chL, nFrames, i0 - 1), readSample(chL, nFrames, i0),
                                  readSample(chL, nFrames, i0 + 1), readSample(chL, nFrames, i0 + 2), t);
            outSampleR = (nCh > 1) ? hermite4(readSample(chR, nFrames, i0 - 1), readSample(chR, nFrames, i0),
                                              readSample(chR, nFrames, i0 + 1), readSample(chR, nFrames, i0 + 2), t)
                                   : outSampleL;
        }
        else
        {
            const float a = readSample(chL, nFrames, i0), b = readSample(chL, nFrames, i0 + 1);
            outSampleL = a + (b - a) * t;
            if (nCh > 1)
            {
                const float c = readSample(chR, nFrames, i0), d = readSample(chR, nFrames, i0 + 1);
                outSampleR = c + (d - c) * t;
            }
            else
                outSampleR = outSampleL;
        }
        const float g = v.env * v.gain;
        if (l != nullptr)
            l[i] += outSampleL * g;
        if (r != nullptr)
            r[i] += outSampleR * g;

        v.position += v.reverse ? -v.rate : v.rate;

        // a one-shot past its tail window (region end + release) ends itself once the tail ramp finished —
        // handled by the envelope above; a reversed/forward voice that runs off the buffer reads zeros.
        if (v.position >= static_cast<double>(nFrames) + 4.0 || v.position < -4.0)
        {
            v.stage = Voice::Stage::idle;
            v.env = 0.0f;
            --activeVoices_;
            return;
        }
    }
}

void Sampler::render(float* const* outputs, int numOutputChannels, int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& v : voices_)
        if (v.active())
            renderVoice(v, outputs, numOutputChannels, numSamples);
}

std::uint64_t Sampler::padActiveMask() const noexcept TERMINATOR_NONBLOCKING
{
    std::uint64_t m = 0;
    for (const auto& v : voices_)
        if (v.active() && v.stage != Voice::Stage::fading && v.pad < 64)
            m |= (std::uint64_t{1} << v.pad);
    return m;
}

double Sampler::lastTriggeredPadPositionSec() const noexcept TERMINATOR_NONBLOCKING
{
    if (lastTriggeredPad_ < 0)
        return 0.0;
    const Voice* newest = nullptr;
    for (const auto& v : voices_)
        if (v.active() && v.pad == lastTriggeredPad_ && v.stage != Voice::Stage::fading)
            if (newest == nullptr || v.serial > newest->serial)
                newest = &v;
    if (newest == nullptr || newest->sample == nullptr || newest->sample->sampleRate <= 0.0)
        return 0.0;
    return (newest->position - static_cast<double>(newest->startFrame)) / newest->sample->sampleRate;
}

} // namespace terminator
