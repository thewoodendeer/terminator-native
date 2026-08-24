#pragma once
// STEMS rate bridge — port of src/main/stemsResample.ts (the Electron worker's band-limited rational
// resampler), kept sample-for-sample compatible on purpose: the stems cache on disk was written by that
// kernel, and a native split must tile with spans the Electron app already produced.
//
// htdemucs is a 44.1k model: its 343980-sample window IS 7.8 seconds only if the audio really is 44.1k. The
// mix arrives at whatever rate the source file / device runs at (48k on most Macs), so it is resampled DOWN
// for the model and back UP before a span is handed out, which keeps the stems sample-aligned with the main
// buffer.
//
// Kernel = windowed sinc (Blackman, 16 zero-crossings up / 32 down), cutoff at the lower of the two
// Nyquists, tabulated per phase: rates are integers, so the ratio is rational (48000/44100 -> 160/147) and
// the fractional phase cycles with a small period — exact tap sets, no interpolation error. Every phase is
// normalised to unity DC gain so a constant stays constant.
//
// Positions come from the GLOBAL output index, never from a per-call start — a range resampled now tiles
// exactly with its neighbour resampled later (a split emits ready spans piecemeal).
//
// UI-free, JUCE-free, not real-time: this runs on the split thread.
#include <cstddef>
#include <cstdint>
#include <vector>

namespace terminator::stems
{
class Resampler
{
  public:
    /// Zero-crossings each side of the kernel. Upsampling is pure interpolation of an already band-limited
    /// signal, so 16 is transparent and cheap; DOWNsampling must also reject everything above the new
    /// Nyquist, and a shallow skirt folds it back into the top octave — hence the wider kernel and the 3 %
    /// cutoff pull-back, which puts the stopband BEFORE the fold point.
    static constexpr int kLobesUp = 16;
    static constexpr int kLobesDown = 32;
    static constexpr double kCutoffTrim = 0.97;
    static constexpr int kMaxPhases = 8192; // above this, taps are computed on the fly (exotic rates)

    Resampler(int inRate, int outRate);

    int inRate() const noexcept { return inRate_; }
    int outRate() const noexcept { return outRate_; }

    /// Kernel reach in INPUT samples — how much context either side of a span the caller should hand over so
    /// the edges interpolate from real audio instead of holding an edge sample.
    std::int64_t halfWidth() const noexcept { return half_; }

    /// Output frame count for `inFrames` of input (duration-preserving).
    std::int64_t outLength(std::int64_t inFrames) const noexcept;

    /// The output frame whose position lands on input frame `inFrame` — the same rounding as outLength, so
    /// ranges map monotonically and tile.
    std::int64_t mapIndex(std::int64_t inFrame) const noexcept { return outLength(inFrame); }

    /// Resample `count` output frames starting at GLOBAL output index `n0`. Input position of output n is
    /// n*L/M; reads are clamped to [lo,hi) of `src`, whose element i holds input frame i + offset.
    void sampleRange(const float* src, std::int64_t lo, std::int64_t hi, std::int64_t n0, std::int64_t count,
                     std::int64_t offset, float* out) const;
    std::vector<float> sampleRange(const std::vector<float>& src, std::int64_t lo, std::int64_t hi, std::int64_t n0,
                                   std::int64_t count, std::int64_t offset = 0) const;

    /// Whole-array convenience: `src` in, resampled copy out.
    std::vector<float> resample(const float* src, std::int64_t frames) const;
    std::vector<float> resample(const std::vector<float>& src) const;

  private:
    double kern(double x) const noexcept;
    void buildTable();

    int inRate_ = 44100;
    int outRate_ = 44100;
    std::int64_t l_ = 1;    // input samples per output sample = L/M
    std::int64_t m_ = 1;    // = number of distinct fractional phases
    double cutoff_ = 1.0;   // normalised to the INPUT Nyquist
    std::int64_t half_ = 1; // kernel half-width, input samples
    std::int64_t taps_ = 2;
    std::vector<float> tab_; // empty = compute taps on the fly
};
} // namespace terminator::stems
