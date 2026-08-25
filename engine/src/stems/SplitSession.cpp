#include "terminator/stems/SplitSession.h"

#include <algorithm>
#include <cmath>

namespace terminator::stems
{
SplitSession::SplitSession(const float* left, const float* right, std::int64_t srcFrames, double srcRate)
    : srcFrames_(std::max<std::int64_t>(0, srcFrames)), srcRate_(srcRate > 0.0 ? srcRate : kModelRate)
{
    // Fade window: ramp over kOverlap samples at both edges, flat 1 between — the edges of the TRACK
    // normalise out through the weight division.
    win_.resize(static_cast<std::size_t>(kSegment));
    for (std::int64_t i = 0; i < kSegment; ++i)
        win_[static_cast<std::size_t>(i)] =
            static_cast<float>(std::min({1.0, static_cast<double>(i + 1) / static_cast<double>(kOverlap),
                                         static_cast<double>(kSegment - i) / static_cast<double>(kOverlap)}));

    const int rate = static_cast<int>(std::llround(srcRate_));
    if (rate == kModelRate || srcFrames_ == 0)
    {
        // The model hears 44.1k or it hears the wrong song: at 48k in, an un-resampled mix plays ~1.5
        // semitones flat to htdemucs and the second->frame maths lands off the chop.
        frames_ = srcFrames_;
        l_.assign(left, left + srcFrames_);
        r_.assign(right, right + srcFrames_);
    }
    else
    {
        const Resampler down(rate, kModelRate);
        frames_ = down.outLength(srcFrames_);
        l_ = down.resample(left, srcFrames_);
        r_ = down.resample(right, srcFrames_);
        up_.emplace(kModelRate, rate);
    }

    nChunks_ = static_cast<int>(
        std::max<std::int64_t>(1, (frames_ + kStride - 1) / kStride)); // ceil(frames / stride), at least one chunk
    done_.assign(static_cast<std::size_t>(nChunks_), false);
    acc_.assign(static_cast<std::size_t>(kStemPlanes), std::vector<float>(static_cast<std::size_t>(frames_), 0.0f));
    weight_.assign(static_cast<std::size_t>(frames_), 0.0f);
}

std::vector<int> SplitSession::chunksFor(const Span& span) const
{
    const auto a = std::max<std::int64_t>(0, static_cast<std::int64_t>(std::floor(span.startSec * kModelRate)));
    const auto b = std::min<std::int64_t>(frames_, static_cast<std::int64_t>(std::ceil(span.endSec * kModelRate)));
    std::vector<int> out;
    for (int i = 0; i < nChunks_; ++i)
    {
        const std::int64_t s = static_cast<std::int64_t>(i) * kStride;
        if (s < b && s + kSegment > a)
            out.push_back(i);
    }
    return out;
}

void SplitSession::enqueue(const std::vector<int>& idxs, bool front)
{
    const std::lock_guard lock(queueMutex_);
    std::vector<int> fresh;
    for (int i : idxs)
    {
        if (i < 0 || i >= nChunks_ || done_[static_cast<std::size_t>(i)])
            continue;
        if (std::find(fresh.begin(), fresh.end(), i) != fresh.end())
            continue;
        const auto seen = std::find(queue_.begin(), queue_.end(), i);
        if (seen != queue_.end())
        {
            // Already queued. A BACK enqueue leaves it alone; a FRONT one is the pad he just focused, so it
            // moves to the head instead of waiting out the sweep behind it (the Electron worker skipped it
            // here — a focused chop mid-sweep never jumped the queue). It is not counted twice.
            if (!front)
                continue;
            queue_.erase(seen);
        }
        else
        {
            queuedTotal_ += 1;
        }
        fresh.push_back(i);
    }
    if (fresh.empty())
        return;
    if (front)
        queue_.insert(queue_.begin(), fresh.begin(), fresh.end());
    else
        queue_.insert(queue_.end(), fresh.begin(), fresh.end());
}

void SplitSession::queueWindows(const std::vector<Span>& windows, bool front)
{
    std::vector<int> idxs;
    for (const auto& w : windows)
        for (int i : chunksFor(w))
            idxs.push_back(i);
    enqueue(idxs, front);
}

void SplitSession::queueSweep()
{
    std::vector<int> all(static_cast<std::size_t>(nChunks_));
    for (int i = 0; i < nChunks_; ++i)
        all[static_cast<std::size_t>(i)] = i;
    enqueue(all, false);
}

int SplitSession::queuedTotal() const
{
    const std::lock_guard lock(queueMutex_);
    return queuedTotal_;
}

double SplitSession::doneCount() const
{
    const std::lock_guard lock(queueMutex_);
    return doneCount_;
}

int SplitSession::pending() const
{
    const std::lock_guard lock(queueMutex_);
    return static_cast<int>(queue_.size());
}

void SplitSession::reportPartial(double fraction)
{
    if (!progress_)
        return;
    double done = 0.0;
    int total = 0;
    {
        const std::lock_guard lock(queueMutex_);
        done = doneCount_ + std::clamp(fraction, 0.0, 1.0);
        total = queuedTotal_;
    }
    progress_(done, total);
}

std::vector<Range> SplitSession::readyRanges() const
{
    // The stretch [i*stride, (i+1)*stride) is ready iff chunk i is done AND (for its head) chunk i-1 is done
    // or absent — the head is the first kOverlap samples, covered by chunk i-1's tail.
    std::vector<Range> out;
    std::int64_t start = -1;
    for (int i = 0; i < nChunks_; ++i)
    {
        const bool headOk = i == 0 || done_[static_cast<std::size_t>(i - 1)];
        const bool ok = done_[static_cast<std::size_t>(i)] && headOk;
        const std::int64_t s = static_cast<std::int64_t>(i) * kStride;
        const std::int64_t e = i == nChunks_ - 1 ? frames_ : std::min(frames_, s + kStride);
        if (ok && start < 0)
            start = s;
        if (!ok && start >= 0)
        {
            out.push_back({start, s});
            start = -1;
        }
        if (ok && i == nChunks_ - 1)
            out.push_back({start, e});
    }
    return out;
}

std::vector<Range> SplitSession::subtractReported(const Range& r) const
{
    std::vector<Range> spans{r};
    for (const auto& [a, b] : reported_)
    {
        std::vector<Range> next;
        for (const auto& [x, y] : spans)
        {
            if (b <= x || a >= y)
            {
                next.push_back({x, y});
                continue;
            }
            if (x < a)
                next.push_back({x, a});
            if (b < y)
                next.push_back({b, y});
        }
        spans = std::move(next);
    }
    std::erase_if(spans, [](const Range& s) { return s.end <= s.begin; });
    return spans;
}

void SplitSession::emitReady(const ChunkFn& onChunk)
{
    for (const auto& range : readyRanges())
    {
        for (const auto& [a, b] : subtractReported(range))
        {
            const std::int64_t n = b - a;
            // Source-frame window this span becomes. mapIndex rounds the same way on both edges, so
            // neighbouring spans tile with no gap or overlap; the model-tail span is pinned to the real end.
            const std::int64_t as = up_ ? std::min(srcFrames_, up_->mapIndex(a)) : a;
            const std::int64_t bs = up_ ? (b >= frames_ ? srcFrames_ : std::min(srcFrames_, up_->mapIndex(b))) : b;
            if (bs <= as)
            {
                reported_.push_back({a, b});
                continue;
            }
            // Hand the kernel MARGIN either side of the span: just past a ready edge the accumulator still
            // holds this chunk's own (fully weighted) estimate, so the interpolator continues into real audio
            // instead of holding the edge sample — that is what keeps seams click-free.
            const std::int64_t pad = up_ ? up_->halfWidth() : 0;
            const std::int64_t a2 = std::max<std::int64_t>(0, a - pad);
            const std::int64_t b2 = std::min(frames_, b + pad);
            ReadyChunk chunk;
            chunk.startFrame = as;
            chunk.endFrame = bs;
            chunk.stems.reserve(static_cast<std::size_t>(kStemPlanes));
            std::vector<float> norm(static_cast<std::size_t>(b2 - a2), 0.0f);
            for (int p = 0; p < kStemPlanes; ++p)
            {
                const auto& src = acc_[static_cast<std::size_t>(p)];
                for (std::int64_t i = 0; i < b2 - a2; ++i)
                    norm[static_cast<std::size_t>(i)] = src[static_cast<std::size_t>(a2 + i)] /
                                                        std::max(weight_[static_cast<std::size_t>(a2 + i)], 1e-8f);
                if (up_)
                {
                    chunk.stems.push_back(up_->sampleRange(norm, 0, b2 - a2, as, bs - as, a2));
                }
                else
                {
                    const auto first = norm.begin() + static_cast<std::ptrdiff_t>(a - a2);
                    chunk.stems.emplace_back(first, first + static_cast<std::ptrdiff_t>(n));
                }
            }
            onChunk(chunk);
            reported_.push_back({a, b});
        }
    }
}

bool SplitSession::buildChunkMix(int idx, float* mix) const
{
    if (mix == nullptr || idx < 0 || idx >= nChunks_)
        return false;
    const std::int64_t s = static_cast<std::int64_t>(idx) * kStride;
    const std::int64_t n = std::min(kSegment, frames_ - s);
    std::fill(mix, mix + 2 * kSegment, 0.0f);
    if (n > 0)
    {
        std::copy(l_.begin() + static_cast<std::ptrdiff_t>(s), l_.begin() + static_cast<std::ptrdiff_t>(s + n), mix);
        std::copy(r_.begin() + static_cast<std::ptrdiff_t>(s), r_.begin() + static_cast<std::ptrdiff_t>(s + n),
                  mix + kSegment);
    }
    return true;
}

void SplitSession::runChunk(int idx, const InferFn& infer, const ChunkFn& onChunk, std::vector<float>& mix,
                            std::vector<float>& rows, bool& ok)
{
    const std::int64_t s = static_cast<std::int64_t>(idx) * kStride;
    const std::int64_t n = std::min(kSegment, frames_ - s);
    buildChunkMix(idx, mix.data());
    std::fill(rows.begin(), rows.end(), 0.0f);
    ok = infer(mix.data(), rows.data());
    if (!ok)
        return;

    for (int k = 0; k < kStemRows; ++k)
    {
        auto& aL = acc_[static_cast<std::size_t>(k * 2)];
        auto& aR = acc_[static_cast<std::size_t>(k * 2 + 1)];
        const float* rL = rows.data() + static_cast<std::ptrdiff_t>(k) * 2 * kSegment;
        const float* rR = rL + kSegment;
        for (std::int64_t i = 0; i < n; ++i)
        {
            const float w = win_[static_cast<std::size_t>(i)];
            aL[static_cast<std::size_t>(s + i)] += rL[i] * w;
            aR[static_cast<std::size_t>(s + i)] += rR[i] * w;
        }
    }
    for (std::int64_t i = 0; i < n; ++i)
        weight_[static_cast<std::size_t>(s + i)] += win_[static_cast<std::size_t>(i)];

    double done = 0.0;
    int total = 0;
    {
        const std::lock_guard lock(queueMutex_);
        done_[static_cast<std::size_t>(idx)] = true;
        doneCount_ += 1.0;
        done = doneCount_;
        total = queuedTotal_;
    }
    if (progress_)
        progress_(done, total);
    emitReady(onChunk);
}

bool SplitSession::run(const InferFn& infer, const ChunkFn& onChunk, const ProgressFn& onProgress)
{
    progress_ = onProgress;
    std::vector<float> mix(static_cast<std::size_t>(2 * kSegment), 0.0f);
    std::vector<float> rows(static_cast<std::size_t>(kStemRows) * 2 * static_cast<std::size_t>(kSegment), 0.0f);
    for (;;)
    {
        if (cancelled())
            return false;
        int idx = -1;
        {
            const std::lock_guard lock(queueMutex_);
            while (!queue_.empty())
            {
                const int next = queue_.front();
                queue_.erase(queue_.begin());
                if (!done_[static_cast<std::size_t>(next)])
                {
                    idx = next;
                    break;
                }
            }
        }
        if (idx < 0)
            return true;
        bool ok = true;
        runChunk(idx, infer, onChunk, mix, rows, ok);
        if (!ok)
            return false;
    }
}
} // namespace terminator::stems
