#include "terminator/core/Sampler.h"

#include <algorithm>
#include <array>
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

// ── the band-limited read (Interpolation::sinc) ──────────────────────────────────────────────────────────
// Reading at rate r > 1 (a chop pitched UP) folds everything above the new Nyquist back into the band as
// inharmonic ringing. Neither linear nor Hermite band-limits at all — nor does an AudioBufferSourceNode — and
// it is not subtle: measured, a 15 kHz tone at +12 st comes back at 18 kHz at the SAME level as the music
// (0 dB). This read squeezes a windowed-sinc kernel by 1/rate so that content is gone before it can fold:
// measured -77.6 dB on the same signal.
//
// WHY IT IS A TABLE OF PHASES rather than a kernel evaluated per tap. Evaluating the sinc and the Kaiser
// window per tap cost 43x a Hermite read (measured) — nothing that expensive belongs on the audio thread. The
// kernel is precomputed instead, once, as PHASES x TAPS: a read picks its phase row and does one multiply-add
// per tap. What decides the stopband is how many sinc lobes fit in the window, and the cutoff squeeze
// stretches them, so the tap count has to grow with the rate as well — hence one table per rate BUCKET.
constexpr int kSincLobes = 8;          // half-width in SOURCE samples at rate 1 (16 taps)
constexpr int kSincHalfMax = 32;       // ... capped (rate 4 and above): 64 taps
constexpr int kSincPhases = 512;       // fractional positions per input sample; the phase is picked, never lerped
constexpr int kSincBuckets = 8;        // rate buckets: 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4+
constexpr double kSincCutMargin = 0.9; // a finite kernel needs a transition band; the top 10% is the cheap loss

/// Modified Bessel I0 — the Kaiser window's shape parameter (series; it converges fast for the betas here).
inline double besselI0(double x)
{
    double sum = 1.0, term = 1.0;
    for (int k = 1; k < 40; ++k)
    {
        term *= (x * x) / (4.0 * static_cast<double>(k) * static_cast<double>(k));
        sum += term;
        if (term < 1.0e-16 * sum)
            break;
    }
    return sum;
}

struct SincBucket
{
    int half = kSincLobes;                                 // half-width in taps
    std::array<float, kSincPhases * 2 * kSincHalfMax> w{}; // [phase][tap], already normalised to unity gain
};

/// The rate a bucket is built for (the bucket a rate lands in is the first whose rate is >= it).
constexpr std::array<double, kSincBuckets> kBucketRate{1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0};

/// Built at static-init (never on the audio thread, and never as a function-local static — that would put a
/// thread-safe-init guard in the RT path).
const std::array<SincBucket, kSincBuckets> kSincBucketTable = []
{
    constexpr double beta = 9.0;
    const double i0b = besselI0(beta);
    std::array<SincBucket, kSincBuckets> out{};
    for (int b = 0; b < kSincBuckets; ++b)
    {
        const double rate = kBucketRate[static_cast<std::size_t>(b)];
        const double cut = rate > 1.0 ? kSincCutMargin / rate : 1.0;
        const int half =
            rate > 1.0 ? std::min(kSincHalfMax, static_cast<int>(std::ceil(kSincLobes * rate))) : kSincLobes;
        out[static_cast<std::size_t>(b)].half = half;
        for (int ph = 0; ph < kSincPhases; ++ph)
        {
            const double t = static_cast<double>(ph) / kSincPhases; // the fractional read position
            double sum = 0.0;
            const int n = 2 * half;
            for (int j = 0; j < n; ++j)
            {
                const double d = static_cast<double>(j - half + 1) - t; // tap distance from the read point
                const double x = d * cut;
                const double sinc = std::abs(x) < 1.0e-9 ? 1.0 : std::sin(M_PI * x) / (M_PI * x);
                const double u = std::abs(d) / half;
                const double win = u >= 1.0 ? 0.0 : besselI0(beta * std::sqrt(std::max(0.0, 1.0 - u * u))) / i0b;
                const double v = sinc * win;
                out[static_cast<std::size_t>(b)].w[static_cast<std::size_t>(ph * 2 * kSincHalfMax + j)] =
                    static_cast<float>(v);
                sum += v;
            }
            // Normalise the ROW: a truncated kernel must still have unity DC gain, at every phase and every
            // cutoff, or the level would move with the pitch.
            const float norm = sum != 0.0 ? static_cast<float>(1.0 / sum) : 0.0f;
            for (int j = 0; j < n; ++j)
                out[static_cast<std::size_t>(b)].w[static_cast<std::size_t>(ph * 2 * kSincHalfMax + j)] *= norm;
        }
    }
    return out;
}();

/// The bucket for a read rate (rates at or below 1 need no band-limiting — bucket 0 is a plain interpolator).
inline const SincBucket& bucketFor(float rate) noexcept
{
    for (int b = 0; b < kSincBuckets; ++b)
        if (static_cast<double>(rate) <= kBucketRate[static_cast<std::size_t>(b)])
            return kSincBucketTable[static_cast<std::size_t>(b)];
    return kSincBucketTable[kSincBuckets - 1];
}

/// One tap summed over the voice's read set (the stem combo = the exact per-sample sum of its lit planes).
inline float readTap(const float* const* chans, int n, std::int64_t numFrames, std::int64_t i) noexcept
{
    if (i < 0 || i >= numFrames)
        return 0.0f;
    float acc = 0.0f;
    for (int k = 0; k < n; ++k)
        acc += chans[k][i];
    return acc;
}

inline bool sameReadSet(const Voice& v, const SampleBuffer* const* set, int n) noexcept
{
    if (v.numSrc != n)
        return false;
    for (int k = 0; k < n; ++k)
        if (v.src[k] != set[k])
            return false;
    return true;
}
} // namespace

void Sampler::prepare(double sampleRate, int maxBlockSize, int numOutputChannels, bool keepState) noexcept
{
    sampleRate_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    numOutputChannels_ = numOutputChannels;
    maxBlock_ = maxBlockSize > 0 ? maxBlockSize : 0;
    scratchL_.assign(static_cast<std::size_t>(maxBlock_), 0.0f); // non-RT (prepare)
    scratchR_.assign(static_cast<std::size_t>(maxBlock_), 0.0f);
    if (!keepState)
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
    auto& p = pads_[pad];
    // ONLY when the BUFFER changes: the previous one may be freed soon (the shell unretains it after a grace
    // period), so fade out anything still reading it, and drop the stem planes (they belong to the buffer they were
    // split from). A REGION-only change frees nothing and invalidates nothing — the page sends one of these to a
    // sounding pad every time a chop point is dropped in (the source chop's end moves), and a voice snapshots its
    // own sample + region + planes at trigger, so it must play on undisturbed.
    const bool bufferChanged = p.sample != sample;
    if (bufferChanged)
    {
        for (auto& v : voices_)
            if (v.active() && v.pad == pad)
                beginFade(v, kStopFadeSec);
        for (auto& plane : p.stemPlanes)
            plane = nullptr;
    }
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
    q.pitchSemitones = std::clamp(q.pitchSemitones, -48.0f, 48.0f);
    q.fineCents = std::clamp(q.fineCents, -50.0f, 50.0f);
    q.attackSec = std::clamp(q.attackSec, 0.0f, 0.5f);
    q.releaseSec = std::clamp(q.releaseSec, 0.0f, 0.5f);
    q.fadeOutSec = std::clamp(q.fadeOutSec, 0.0f, 60.0f);
    q.gain = std::clamp(q.gain, 0.0f, 4.0f);
    q.pan = std::clamp(q.pan, -1.0f, 1.0f);
    q.chokeFadeSec = std::clamp(q.chokeFadeSec, 0.001f, 0.05f);
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

int Sampler::resolveReadSet(const Pad& p, const SampleBuffer* (&out)[kStemPlanes]) noexcept TERMINATOR_NONBLOCKING
{
    out[0] = p.sample;
    out[1] = out[2] = out[3] = nullptr;
    const auto mask = static_cast<std::uint8_t>(p.stemMask & kStemMaskAll);
    if (mask == 0 || mask == kStemMaskAll)
        return 1;
    int n = 0;
    for (int k = 0; k < kStemPlanes; ++k)
    {
        if ((mask & (1u << k)) == 0)
            continue;
        if (p.stemPlanes[k] == nullptr) // a lit stem is missing (not split / not decoded) → the ORIGINAL plays
        {
            out[0] = p.sample;
            out[1] = out[2] = out[3] = nullptr;
            return 1;
        }
        out[n++] = p.stemPlanes[k];
    }
    return n > 0 ? n : 1;
}

void Sampler::setPadStems(std::uint16_t pad, const SampleBuffer* const planes[kStemPlanes],
                          std::uint8_t mask) noexcept TERMINATOR_NONBLOCKING
{
    if (pad >= kMaxPads)
        return;
    auto& p = pads_[pad];
    p.stemMask = static_cast<std::uint8_t>(mask & kStemMaskAll);
    for (int k = 0; k < kStemPlanes; ++k)
    {
        const SampleBuffer* b = planes != nullptr ? planes[k] : nullptr;
        // a plane must be the base buffer's twin: same length + rate, ≥1 channel
        if (b != nullptr && (p.sample == nullptr || b->numFrames != p.sample->numFrames ||
                             b->sampleRate != p.sample->sampleRate || b->numChannels < 1))
            b = nullptr;
        p.stemPlanes[k] = b;
    }
    if (!p.hasSample())
        return;

    // LIVE restem (restemVoice): every ringing voice of the pad whose read set changed swaps to the new one at
    // its current position — a twin voice fades in over 12 ms while the old one fades out. Loop renders carry
    // their own mix (the message thread re-renders + re-sends them), so rendered-loop voices keep playing.
    const SampleBuffer* set[kStemPlanes];
    const int n = resolveReadSet(p, set);
    const int xf = std::max(1, static_cast<int>(static_cast<double>(kRestemFadeSec) * sampleRate_));
    for (auto& v : voices_)
    {
        if (!v.active() || v.pad != pad || v.stage == Voice::Stage::fading || v.loopRendered)
            continue;
        if (v.sample != p.sample || sameReadSet(v, set, n))
            continue;
        if (!v.started) // scheduled in this block but not yet rendered: just re-point it (TS: "not started yet")
        {
            for (int k = 0; k < kStemPlanes; ++k)
                v.src[k] = set[k];
            v.numSrc = static_cast<std::uint8_t>(n);
            v.stemMask = p.stemMask;
            continue;
        }
        Voice* t = allocateVoice();
        if (t == nullptr || t == &v) // could only steal the very voice we are swapping: swap in place instead
        {
            if (t == &v)
                ++activeVoices_; // allocateVoice un-counted it as a steal
            for (int k = 0; k < kStemPlanes; ++k)
                v.src[k] = set[k];
            v.numSrc = static_cast<std::uint8_t>(n);
            v.stemMask = p.stemMask;
            continue;
        }
        *t = v; // same position / rate / envelope / pending offsets — the twin continues the note
        t->serial = nextSerial_++;
        for (int k = 0; k < kStemPlanes; ++k)
            t->src[k] = set[k];
        t->numSrc = static_cast<std::uint8_t>(n);
        t->stemMask = p.stemMask;
        t->startOffset = 0;
        t->fadeOffset = -1;
        t->xfGain = 0.0f;
        t->xfStep = 1.0f / static_cast<float>(xf);
        t->xfRemaining = xf;
        ++activeVoices_;
        beginFadeNow(v, kRestemFadeSec); // linear env → 0 over the same 12 ms: the sum stays continuous
    }
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
    {
        v.fadeOffset = offsetInBlock; // the fade starts when the block reaches the choking hit's position …
        v.fadeSeconds = seconds;      // … and keeps the cutter's length (a deferred fade used to fall back to 3 ms)
    }
    else
        beginFadeNow(v, seconds);
}

void Sampler::chokeGroupOf(std::uint16_t pad, std::int16_t group, const Voice* keep, std::int32_t offsetInBlock,
                           float fadeSec) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& v : voices_)
    {
        if (!v.active() || &v == keep || v.subHit)
            continue;
        if (group == -1)
        {
            if (v.pad == pad) // own pad only (the lane's retrigger chain)
                beginFade(v, fadeSec, offsetInBlock);
            continue;
        }
        if (v.chokeGroup != group || v.pad == pad)
            continue; // (the own pad is handled by the −1 pass)
        // a group mate that starts at the SAME sample of this block (triggered earlier in this block, not yet
        // rendered) is a deliberate layer, not a cut (muteGroups.ts: strictly-later hits cut)
        if (!v.started && v.startOffset == offsetInBlock)
            continue;
        beginFade(v, fadeSec, offsetInBlock);
    }
}

void Sampler::trigger(std::uint16_t pad, float velocity, std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING
{
    if (pad >= kMaxPads)
        return;
    triggerEx(pad, velocity, offsetInBlock, pads_[pad].params.pan, false);
}

void Sampler::triggerEx(std::uint16_t pad, float velocity, std::int32_t offsetInBlock, float pan,
                        bool subHit) noexcept TERMINATOR_NONBLOCKING
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
    // previous voice); −2 = poly: nothing is choked. A note-repeat SUB-HIT chokes nothing (TS: it bypasses the lane
    // registry; its predecessor's end is booked by the sequencer — stopSubHitsAt)
    if (!subHit)
    {
        if (p.params.chokeGroup == -1)
            chokeGroupOf(pad, -1, v, offsetInBlock, p.params.chokeFadeSec);
        else if (p.params.chokeGroup >= 0)
        {
            chokeGroupOf(pad, p.params.chokeGroup, v, offsetInBlock, p.params.chokeFadeSec);
            chokeGroupOf(pad, -1, v, offsetInBlock, p.params.chokeFadeSec);
        }
    }

    *v = Voice{};
    v->subHit = subHit;
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
    if (useLoopRender)
    {
        v->src[0] = p.loopSample;
        v->numSrc = 1;
        v->stemMask = kStemMaskAll;
    }
    else
    {
        const int n = resolveReadSet(p, v->src);
        v->numSrc = static_cast<std::uint8_t>(n);
        v->stemMask = p.stemMask;
    }
    v->reverse = useLoopRender ? 0 : p.params.reverse;
    v->mode = p.params.mode;
    v->gate = p.params.gate != 0 || p.params.mode == PadMode::gate;
    // the one-shot/gate fade-OUT tail, in the BUFFER's frames (the region's own time) — never for LOOP pads
    v->fadeOutFrames = (p.params.mode == PadMode::loop || p.params.fadeOutSec <= 0.0f)
                           ? 0.0f
                           : static_cast<float>(static_cast<double>(p.params.fadeOutSec) * p.sample->sampleRate);
    v->interpolation = p.params.interpolation;
    v->outputPair = p.params.outputPair;
    v->strip = p.params.strip;
    v->chokeGroup = p.params.chokeGroup;
    v->velocity = std::clamp(velocity, 0.0f, 1.0f);
    v->gain = v->velocity * p.params.gain;
    // PAN: the StereoPanner law (Web Audio spec §StereoPannerNode), resolved now for the voice's read set. pan 0 =
    // identity (no panner — the TS only inserts one when pan ≠ 0, so a centred mono drum plays at unity on both outs)
    {
        const float pn = std::clamp(pan, -1.0f, 1.0f);
        if (pn != 0.0f)
        {
            bool stereo = false;
            for (int k = 0; k < v->numSrc; ++k)
                stereo = stereo || (v->src[k] != nullptr && v->src[k]->numChannels > 1);
            constexpr float kHalfPi = 1.57079632679489661923f;
            v->panned = true;
            if (!stereo)
            {
                const float x = (pn + 1.0f) * 0.5f; // 0..1
                v->mLL = std::cos(x * kHalfPi);
                v->mRL = 0.0f;
                v->mRR = std::sin(x * kHalfPi);
                v->mLR = 0.0f;
            }
            else if (pn <= 0.0f)
            {
                const float x = pn + 1.0f; // 0..1
                v->mLL = 1.0f;
                v->mRL = std::cos(x * kHalfPi); // L gets the right's share
                v->mRR = std::sin(x * kHalfPi);
                v->mLR = 0.0f;
            }
            else
            {
                const float x = pn; // 0..1
                v->mLL = std::cos(x * kHalfPi);
                v->mRL = 0.0f;
                v->mRR = 1.0f;
                v->mLR = std::sin(x * kHalfPi); // R gets the left's share
            }
        }
    }
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
    v->releaseSamples = std::max(
        1, static_cast<int>(static_cast<double>(std::max(p.params.releaseSec, v->gate ? kMinReleaseSec : 0.0f)) *
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
        if (!v.active() || v.pad != pad || !v.gate || v.released)
            continue;
        v.released = true;
        if (offsetInBlock > 0)
            v.releaseOffset = offsetInBlock; // applied inside renderVoice when the block reaches it
        else
            beginRelease(v);
    }
}

void Sampler::stopPadAt(std::uint16_t pad, std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING
{
    const float fade = pad < kMaxPads ? pads_[pad].params.chokeFadeSec : kStopFadeSec;
    for (auto& v : voices_)
        if (v.active() && v.pad == pad && v.stage != Voice::Stage::fading && v.fadeOffset < 0)
            beginFade(v, fade, offsetInBlock);
}

void Sampler::stopSubHitsAt(std::uint16_t pad, std::int32_t offsetInBlock) noexcept TERMINATOR_NONBLOCKING
{
    const float fade = pad < kMaxPads ? pads_[pad].params.chokeFadeSec : kStopFadeSec;
    for (auto& v : voices_)
        if (v.active() && v.subHit && v.pad == pad && v.stage != Voice::Stage::fading && v.fadeOffset < 0)
            beginFade(v, fade, offsetInBlock);
}

void Sampler::stopPad(std::uint16_t pad) noexcept TERMINATOR_NONBLOCKING
{
    const float fade = pad < kMaxPads ? pads_[pad].params.chokeFadeSec : kStopFadeSec;
    for (auto& v : voices_)
        if (v.active() && v.pad == pad)
            beginFade(v, fade);
}

void Sampler::stopAll() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& v : voices_)
        if (v.active())
            beginFade(v, kStopFadeSec);
}

void Sampler::stopPadRange(std::uint16_t first, std::uint16_t count) noexcept TERMINATOR_NONBLOCKING
{
    const int lo = first, hi = std::min<int>(kMaxPads, first + count);
    for (auto& v : voices_)
        if (v.active() && v.pad >= lo && v.pad < hi)
            beginFade(v, pads_[v.pad].params.chokeFadeSec);
}

void Sampler::renderVoice(Voice& v, float* l, float* r, int numSamples) noexcept TERMINATOR_NONBLOCKING
{
    // l / r may be null (the output pair is not on this device): the voice keeps running silently
    const auto* s = v.sample;
    const std::int64_t nFrames = s->numFrames;
    // the read set: 1 buffer (base / loop render) or the lit stem planes, summed per tap; a mono plane among
    // stereo ones repeats its only channel on the right (mixMaskChannels semantics)
    const int nSrc = std::clamp<int>(v.numSrc, 1, kStemPlanes);
    const float* chL[kStemPlanes];
    const float* chR[kStemPlanes];
    bool stereo = false;
    for (int k = 0; k < nSrc; ++k)
    {
        const SampleBuffer* b = v.src[k] != nullptr ? v.src[k] : s;
        chL[k] = b->channel(0);
        chR[k] = b->numChannels > 1 ? b->channel(1) : chL[k];
        stereo = stereo || b->numChannels > 1;
    }
    const double regionStart = static_cast<double>(v.startFrame);
    const double regionEnd = static_cast<double>(v.endFrame); // exclusive
    const double regionLen = regionEnd - regionStart;

    int i = v.startOffset;
    v.startOffset = 0;
    for (; i < numSamples; ++i)
    {
        if (v.fadeOffset >= 0 && i >= v.fadeOffset)
            beginFadeNow(v, v.fadeSeconds);
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

        // ---- restem crossfade (twin voice fading in) ----
        if (v.xfRemaining > 0)
        {
            v.xfGain += v.xfStep;
            if (--v.xfRemaining == 0)
                v.xfGain = 1.0f;
        }

        // ---- read + interpolate ----
        float outSampleL = 0.0f, outSampleR = 0.0f;
        const double fpos = v.position;
        const auto i0 = static_cast<std::int64_t>(std::floor(fpos));
        const float t = static_cast<float>(fpos - static_cast<double>(i0));
        if (v.interpolation == Interpolation::sinc)
        {
            // one phase row, one multiply-add per tap; the row is already normalised, so no division here
            const float rate = static_cast<float>(v.rate <= 0.0 ? 1.0 : v.rate);
            const SincBucket& bk = bucketFor(rate);
            const auto ph = std::min(kSincPhases - 1, static_cast<int>(t * static_cast<float>(kSincPhases)));
            const float* w = bk.w.data() + static_cast<std::size_t>(ph) * 2 * kSincHalfMax;
            const int n = 2 * bk.half;
            const std::int64_t base = i0 - bk.half + 1;
            float accL = 0.0f, accR = 0.0f;
            for (int j = 0; j < n; ++j)
            {
                const float g = w[j];
                accL += g * readTap(chL, nSrc, nFrames, base + j);
                if (stereo)
                    accR += g * readTap(chR, nSrc, nFrames, base + j);
            }
            outSampleL = accL;
            outSampleR = stereo ? accR : accL;
        }
        else if (v.interpolation == Interpolation::hermite)
        {
            outSampleL = hermite4(readTap(chL, nSrc, nFrames, i0 - 1), readTap(chL, nSrc, nFrames, i0),
                                  readTap(chL, nSrc, nFrames, i0 + 1), readTap(chL, nSrc, nFrames, i0 + 2), t);
            outSampleR = stereo ? hermite4(readTap(chR, nSrc, nFrames, i0 - 1), readTap(chR, nSrc, nFrames, i0),
                                           readTap(chR, nSrc, nFrames, i0 + 1), readTap(chR, nSrc, nFrames, i0 + 2), t)
                                : outSampleL;
        }
        else
        {
            const float a = readTap(chL, nSrc, nFrames, i0), b = readTap(chL, nSrc, nFrames, i0 + 1);
            outSampleL = a + (b - a) * t;
            if (stereo)
            {
                const float c = readTap(chR, nSrc, nFrames, i0), d = readTap(chR, nSrc, nFrames, i0 + 1);
                outSampleR = c + (d - c) * t;
            }
            else
                outSampleR = outSampleL;
        }
        v.started = true;
        if (v.panned)
        {
            const float a = outSampleL, b = outSampleR;
            outSampleL = a * v.mLL + b * v.mRL;
            outSampleR = b * v.mRR + a * v.mLR;
        }
        float g = v.env * v.gain * v.xfGain;
        if (v.fadeOutFrames > 0.0f && !v.loopRendered && v.mode != PadMode::loop)
        {
            // linear to silence over the last fadeOutFrames of the region (forward: to the end; reverse: to the start)
            const double remain = v.reverse ? (v.position - regionStart) : (regionEnd - v.position);
            if (remain < static_cast<double>(v.fadeOutFrames))
                g *= static_cast<float>(std::max(0.0, remain) / static_cast<double>(v.fadeOutFrames));
        }
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

void Sampler::render(float* const* outputs, int numOutputChannels, int numSamples, double* const* stripInputs,
                     int numStrips) noexcept TERMINATOR_NONBLOCKING
{
    const int n = std::min(numSamples, maxBlock_ > 0 ? maxBlock_ : numSamples);
    for (auto& v : voices_)
    {
        if (!v.active())
            continue;
        if (stripInputs != nullptr && v.strip >= 0 && v.strip < numStrips && maxBlock_ >= numSamples)
        {
            // into a mixer strip: render alone into the scratch, then accumulate in 64-bit (the strip's input)
            float* sl = scratchL_.data();
            float* sr = scratchR_.data();
            std::fill_n(sl, n, 0.0f);
            std::fill_n(sr, n, 0.0f);
            renderVoice(v, sl, sr, n);
            double* L = stripInputs[static_cast<std::size_t>(v.strip) * 2];
            double* R = stripInputs[static_cast<std::size_t>(v.strip) * 2 + 1];
            for (int i = 0; i < n; ++i)
            {
                L[i] += static_cast<double>(sl[i]);
                R[i] += static_cast<double>(sr[i]);
            }
            continue;
        }
        const int outL = static_cast<int>(v.outputPair) * 2;
        const int outR = outL + 1;
        float* l = outL < numOutputChannels ? outputs[outL] : nullptr;
        float* r = outR < numOutputChannels ? outputs[outR] : nullptr;
        renderVoice(v, l, r, numSamples);
    }
}

std::uint64_t Sampler::padActiveMask() const noexcept TERMINATOR_NONBLOCKING
{
    std::uint64_t m = 0;
    for (const auto& v : voices_)
        if (v.active() && v.stage != Voice::Stage::fading && v.pad < kChopPads)
            m |= (std::uint64_t{1} << v.pad);
    return m;
}

std::uint64_t Sampler::drumActiveMask() const noexcept TERMINATOR_NONBLOCKING
{
    std::uint64_t m = 0;
    for (const auto& v : voices_)
        if (v.active() && v.stage != Voice::Stage::fading && v.pad >= kDrumPadBase && v.pad < kDrumPadBase + kDrumLanes)
            m |= (std::uint64_t{1} << (v.pad - kDrumPadBase));
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
