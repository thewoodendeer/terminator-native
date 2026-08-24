#pragma once
// STEMS split session — the native port of src/main/stemsWorkerChild.ts (minus onnxruntime). It owns the
// chunk GRID, the overlap-add accumulators and the ready-range bookkeeping; the model itself is injected as
// an `InferFn`, so the whole pipeline is testable headlessly and the ORT sessions stay in the app layer.
//
// The grid mirrors the reference infer.py::separate and the Electron worker EXACTLY: segment 343980 samples
// (7.8 s @ 44.1k), overlap = segment/4, stride = segment - overlap, a fade window ramping over the overlap at
// both edges, and a GLOBAL chunk index (chunk i starts at i*stride) — so a window computed now composes with
// a neighbour computed later, and stems cached by the Electron app stay valid.
//
// A span is handed out only when every chunk covering it is done ("ready ranges"), normalised by the summed
// window weight, resampled back to the source rate and reported ONCE (spans already reported are subtracted).
//
// Threading: `run()` pumps on the split thread; `queueWindows()` / `cancel()` may be called from any thread.
// UI-free, JUCE-free, never on the audio thread.
#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <vector>

#include "terminator/stems/Resampler.h"

namespace terminator::stems
{
/// The model's fixed window: 343980 samples = 7.8 s at 44.1k.
inline constexpr std::int64_t kSegment = 343980;
inline constexpr std::int64_t kOverlap = kSegment / 4;
inline constexpr std::int64_t kStride = kSegment - kOverlap;
inline constexpr int kModelRate = 44100;
/// Stem rows the model returns, in order: drums, bass, other, vocals (kStemNames in StemMask.h).
inline constexpr int kStemRows = 4;
/// Emitted planes: [drumsL, drumsR, bassL, bassR, otherL, otherR, vocalsL, vocalsR].
inline constexpr int kStemPlanes = kStemRows * 2;

struct Span
{
    double startSec = 0.0;
    double endSec = 0.0;
};

struct Range
{
    std::int64_t begin = 0;
    std::int64_t end = 0;
    bool operator==(const Range&) const = default;
};

/// A newly ready span, in SOURCE frames at the source rate, 8 planes of (end - begin) floats.
struct ReadyChunk
{
    std::int64_t startFrame = 0;
    std::int64_t endFrame = 0;
    std::vector<std::vector<float>> stems;
};

class SplitSession
{
  public:
    /// Fill `rows` (kStemRows * 2 * kSegment floats: row k = [L(kSegment), R(kSegment)]) from `mix`
    /// (2 * kSegment floats: L then R). Return false to abort the run (a cancel or a model error).
    using InferFn = std::function<bool(const float* mix, float* rows)>;
    using ChunkFn = std::function<void(const ReadyChunk&)>;
    /// (chunks done — fractional while a chunk is mid-flight, chunks queued).
    using ProgressFn = std::function<void(double done, int total)>;

    /// Takes the source mix (planar, `srcFrames` each) at `srcRate` and resamples it to the model's 44.1k
    /// when needed. A mono source may pass the same pointer twice.
    SplitSession(const float* left, const float* right, std::int64_t srcFrames, double srcRate);

    std::int64_t modelFrames() const noexcept { return frames_; }
    std::int64_t sourceFrames() const noexcept { return srcFrames_; }
    int chunkCount() const noexcept { return nChunks_; }
    /// Bytes the accumulators hold (8 planes + the weight plane) — the memory cap lives on this.
    std::int64_t accumulatorBytes() const noexcept
    {
        return frames_ * static_cast<std::int64_t>(sizeof(float)) * (kStemPlanes + 1);
    }

    /// Chunk indices covering a span (source seconds). Public for the queue gates.
    std::vector<int> chunksFor(const Span& span) const;

    /// Queue chunks covering `windows` (in order). `front` jumps the queue — a chop the user just focused.
    void queueWindows(const std::vector<Span>& windows, bool front);
    /// Queue every remaining chunk, in order (the background sweep).
    void queueSweep();

    int queuedTotal() const;
    double doneCount() const;
    /// Chunks still waiting.
    int pending() const;

    /// Ask the run to stop after the chunk in flight. Sticky.
    void cancel() noexcept { cancelled_.store(true, std::memory_order_relaxed); }
    bool cancelled() const noexcept { return cancelled_.load(std::memory_order_relaxed); }

    /// Report progress INSIDE a chunk (FINE runs four specialists per chunk — a tick per specialist keeps a
    /// long track moving every ~2 s instead of every ~8 s). `fraction` is 0..1 of the chunk in flight.
    void reportPartial(double fraction);

    /// Pump the queue until it is empty, `infer` returns false, or cancel() lands. Emits every newly ready
    /// span through `onChunk`. Returns false if it stopped early.
    bool run(const InferFn& infer, const ChunkFn& onChunk, const ProgressFn& onProgress = {});

    /// Maximal sample ranges (MODEL frames) where every covering chunk is done.
    std::vector<Range> readyRanges() const;
    /// `r` minus every span already reported.
    std::vector<Range> subtractReported(const Range& r) const;

  private:
    void enqueue(const std::vector<int>& idxs, bool front);
    void runChunk(int idx, const InferFn& infer, const ChunkFn& onChunk, std::vector<float>& mix,
                  std::vector<float>& rows, bool& ok);
    void emitReady(const ChunkFn& onChunk);

    std::vector<float> l_, r_; // MODEL-rate (44.1k) mix
    std::int64_t frames_ = 0;
    std::int64_t srcFrames_ = 0;
    double srcRate_ = kModelRate;
    std::optional<Resampler> up_; // model rate -> source rate (absent when they match)
    int nChunks_ = 0;

    std::vector<float> win_;              // fade window over kSegment
    std::vector<std::vector<float>> acc_; // 8 planes, model-rate frames
    std::vector<float> weight_;           // summed window per frame
    std::vector<bool> done_;
    std::vector<Range> reported_;

    mutable std::mutex queueMutex_;
    std::vector<int> queue_;
    int queuedTotal_ = 0;
    double doneCount_ = 0.0;
    std::atomic<bool> cancelled_{false};
    ProgressFn progress_;
};
} // namespace terminator::stems
