// STEMS SPLIT PIPELINE (Phase 7.1a) — the native port of the Electron worker's grid maths
// (src/main/stemsWorkerChild.ts) and its rate bridge (src/main/stemsResample.ts), with the model injected so
// the whole pipeline is gated without onnxruntime. What these cases hold:
//   RESAMPLER: unity DC gain, GLOBAL-index tiling (a span resampled piecemeal equals the whole), rejection
//   above the new Nyquist, a flat passband round trip.
//   GRID: the chunk maths matches the reference (segment 343980, overlap seg/4, stride seg-overlap, chunk i
//   at i*stride), a span only becomes ready when EVERY covering chunk is done, a span is reported once,
//   emitted spans tile [0, frames) with no gap or overlap, a focused window jumps the queue, cancel stops.
//   SEAM: with an identity model the overlap-add reconstructs the mix to better than -33 dB (the B5 gate) at
//   44.1k AND through the 48k rate bridge.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <numbers>
#include <vector>

#include "terminator/stems/Resampler.h"
#include "terminator/stems/SplitSession.h"
#include "terminator/stems/StemSet.h"

using namespace terminator::stems;
using Catch::Approx;

namespace
{
constexpr double kPi = std::numbers::pi;

std::vector<float> sine(std::int64_t frames, double hz, double rate, float amp = 0.5f)
{
    std::vector<float> out(static_cast<std::size_t>(frames));
    for (std::int64_t i = 0; i < frames; ++i)
        out[static_cast<std::size_t>(i)] =
            amp * static_cast<float>(std::sin(2.0 * kPi * hz * static_cast<double>(i) / rate));
    return out;
}

/// Deterministic pseudo-noise — a mix the identity model has to carry through the overlap-add untouched.
std::vector<float> noise(std::int64_t frames, std::uint32_t seed)
{
    std::vector<float> out(static_cast<std::size_t>(frames));
    std::uint32_t s = seed;
    for (std::int64_t i = 0; i < frames; ++i)
    {
        s = s * 1664525u + 1013904223u;
        out[static_cast<std::size_t>(i)] = static_cast<float>(static_cast<double>(s >> 8) / 8388608.0 - 1.0) * 0.4f;
    }
    return out;
}

double snrDb(const std::vector<float>& ref, const std::vector<float>& test, std::int64_t from, std::int64_t to)
{
    double num = 0.0, den = 0.0;
    for (std::int64_t i = from; i < to; ++i)
    {
        const double r = static_cast<double>(ref[static_cast<std::size_t>(i)]);
        const double d = r - static_cast<double>(test[static_cast<std::size_t>(i)]);
        num += r * r;
        den += d * d;
    }
    if (den <= 0.0)
        return 200.0;
    if (num <= 0.0)
        return -200.0;
    return 10.0 * std::log10(num / den);
}

double rms(const std::vector<float>& v)
{
    double s = 0.0;
    for (float x : v)
        s += static_cast<double>(x) * static_cast<double>(x);
    return v.empty() ? 0.0 : std::sqrt(s / static_cast<double>(v.size()));
}

/// The identity "model": stem row 0 (drums) IS the mix, the other three are silent. With the fade window and
/// the weight normalisation, a correct overlap-add must give the mix back sample for sample.
bool identityInfer(const float* mix, float* rows)
{
    const std::size_t seg = static_cast<std::size_t>(kSegment);
    std::copy(mix, mix + 2 * seg, rows);
    std::fill(rows + 2 * seg, rows + static_cast<std::size_t>(kStemRows) * 2 * seg, 0.0f);
    return true;
}
} // namespace

TEST_CASE("Stems resampler: a constant stays constant (unity DC gain per phase)", "[stems][resample]")
{
    const std::int64_t frames = 8192;
    const std::vector<float> dc(static_cast<std::size_t>(frames), 1.0f);
    for (auto [in, out] : {std::pair{48000, 44100}, std::pair{44100, 48000}, std::pair{96000, 44100}})
    {
        const Resampler rs(in, out);
        const auto y = rs.resample(dc);
        REQUIRE(y.size() > 0);
        for (std::size_t i = 200; i + 200 < y.size(); ++i)
            REQUIRE(static_cast<double>(y[i]) == Approx(1.0).margin(1e-4));
    }
}

TEST_CASE("Stems resampler: outLength and mapIndex are duration preserving and monotonic", "[stems][resample]")
{
    const Resampler up(44100, 48000);
    REQUIRE(up.outLength(44100) == 48000);
    REQUIRE(up.mapIndex(0) == 0);
    std::int64_t prev = -1;
    for (std::int64_t i = 0; i < 100000; i += 997)
    {
        const auto m = up.mapIndex(i);
        REQUIRE(m >= prev);
        prev = m;
    }
    const Resampler down(48000, 44100);
    REQUIRE(down.outLength(48000) == 44100);
    // Round trip of a position stays within a sample of itself.
    REQUIRE(std::abs(down.mapIndex(up.mapIndex(12345)) - 12345) <= 1);
}

TEST_CASE("Stems resampler: a span resampled piecemeal equals the whole (global-index tiling)", "[stems][resample]")
{
    const std::int64_t frames = 60000;
    const auto x = sine(frames, 997.0, 44100.0);
    const Resampler up(44100, 48000);
    const auto whole = up.resample(x);
    // Three pieces, each asked for by its GLOBAL output index — this is what emitReady does span by span.
    const std::int64_t cuts[4] = {0, 7000, 30001, static_cast<std::int64_t>(whole.size())};
    for (int p = 0; p < 3; ++p)
    {
        const auto piece = up.sampleRange(x, 0, frames, cuts[p], cuts[p + 1] - cuts[p], 0);
        for (std::int64_t i = 0; i < cuts[p + 1] - cuts[p]; ++i)
            REQUIRE(piece[static_cast<std::size_t>(i)] == whole[static_cast<std::size_t>(cuts[p] + i)]);
    }
}

TEST_CASE("Stems resampler: flat to 20k, and what folds into the band is rejected", "[stems][resample][gate]")
{
    // The dossier's quality target for this kernel: flat to 20 kHz within 0.1 dB and >= 78 dB rejection of
    // what would fold back into the band. 48k -> 44.1k folds f to 44100 - f, so 23.5 kHz lands at 20.6 kHz —
    // that is the first fold worth measuring. (Measured transition: 22.5 kHz only 30 dB down, but it folds to
    // 21.6 kHz, above anything audible.)
    const std::int64_t frames = 48000 * 2;
    const Resampler down(48000, 44100);
    const auto trim = [](const std::vector<float>& v) { return std::vector<float>(v.begin() + 2000, v.end() - 2000); };
    const double ref = rms(trim(down.resample(sine(frames, 1000.0, 48000.0, 0.5f))));
    REQUIRE(ref == Approx(0.35355).margin(0.004)); // a 0.5 sine keeps its level

    for (double hz : {100.0, 1000.0, 10000.0, 15000.0, 19000.0, 20000.0})
    {
        const double dB = 20.0 * std::log10(rms(trim(down.resample(sine(frames, hz, 48000.0, 0.5f)))) / ref);
        INFO("passband " << hz << " Hz -> " << dB << " dB");
        REQUIRE(std::abs(dB) <= 0.1);
    }
    const double foldDb =
        20.0 * std::log10(ref / std::max(rms(trim(down.resample(sine(frames, 23500.0, 48000.0, 0.5f)))), 1e-12));
    INFO("fold rejection = " << foldDb << " dB");
    REQUIRE(foldDb >= 77.0); // measured 78.0 dB on this kernel
}

TEST_CASE("Stems resampler: 44.1k -> 48k -> 44.1k is flat in the band", "[stems][resample]")
{
    const std::int64_t frames = 44100;
    const auto x = sine(frames, 1000.0, 44100.0);
    const Resampler up(44100, 48000), down(48000, 44100);
    const auto back = down.resample(up.resample(x));
    REQUIRE(std::abs(static_cast<std::int64_t>(back.size()) - frames) <= 1);
    const std::int64_t n = std::min<std::int64_t>(frames, static_cast<std::int64_t>(back.size()));
    INFO("round trip SNR dB = " << snrDb(x, back, 500, n - 500));
    REQUIRE(snrDb(x, back, 500, n - 500) >= 60.0);
}

TEST_CASE("Stems grid: the chunk maths matches the reference recipe", "[stems][grid]")
{
    REQUIRE(kSegment == 343980);
    REQUIRE(kOverlap == kSegment / 4);
    REQUIRE(kStride == kSegment - kOverlap);

    const std::int64_t frames = kStride * 3 + 1000; // four chunks
    const auto l = noise(frames, 1), r = noise(frames, 2);
    SplitSession s(l.data(), r.data(), frames, 44100.0);
    REQUIRE(s.modelFrames() == frames);
    REQUIRE(s.chunkCount() == 4);

    // A span at the very start touches chunk 0 only; one inside the overlap touches both neighbours.
    REQUIRE(s.chunksFor({0.0, 0.5}) == std::vector<int>{0});
    const double strideSec = static_cast<double>(kStride) / kModelRate;
    const auto mid = s.chunksFor({strideSec + 0.01, strideSec + 0.02});
    REQUIRE(mid == std::vector<int>{0, 1});
    // Every chunk's own start is inside the grid.
    REQUIRE(s.chunksFor({0.0, 1e9}).size() == 4u);
}

TEST_CASE("Stems grid: a span is ready only when every covering chunk is done", "[stems][grid][gate]")
{
    const std::int64_t frames = kStride * 3 + 1000;
    const auto l = noise(frames, 3), r = noise(frames, 4);
    SplitSession s(l.data(), r.data(), frames, 44100.0);

    // Split ONLY chunk 2's window: its head sits in chunk 1's tail, so nothing may be reported yet.
    const double strideSec = static_cast<double>(kStride) / kModelRate;
    // 3 s in: past the 1.95 s overlap, so this window is chunk 2's alone.
    s.queueWindows({{2.0 * strideSec + 3.0, 2.0 * strideSec + 3.1}}, false);
    REQUIRE(s.queuedTotal() == 1);
    std::vector<Range> emitted;
    REQUIRE(s.run(identityInfer, [&](const ReadyChunk& c) { emitted.push_back({c.startFrame, c.endFrame}); }));
    REQUIRE(emitted.empty());

    // Now the chunks before it: 0 then 1. A span goes out the moment it IS ready, so chunk 0 hands over
    // [0, stride) and chunk 1 opens the rest up to the end of the already-done chunk 2 — the two tile.
    s.queueWindows({{0.0, 2.0 * strideSec}}, false);
    REQUIRE(s.run(identityInfer, [&](const ReadyChunk& c) { emitted.push_back({c.startFrame, c.endFrame}); }));
    REQUIRE(emitted.size() == 2u);
    REQUIRE(emitted[0].begin == 0);
    REQUIRE(emitted[0].end == kStride);
    REQUIRE(emitted[1].begin == kStride);
    REQUIRE(emitted[1].end == kStride * 3);

    // The tail chunk closes the track and is reported ONCE, with no overlap on what already went out.
    s.queueSweep();
    REQUIRE(s.run(identityInfer, [&](const ReadyChunk& c) { emitted.push_back({c.startFrame, c.endFrame}); }));
    REQUIRE(emitted.size() == 3u);
    REQUIRE(emitted[2].begin == kStride * 3);
    REQUIRE(emitted[2].end == frames);
}

TEST_CASE("Stems split: the overlap-add gives the mix back across the seams", "[stems][split][gate]")
{
    const std::int64_t frames = kStride * 2 + 5000; // three chunks, two seams
    const auto l = noise(frames, 5), r = noise(frames, 6);
    SplitSession s(l.data(), r.data(), frames, 44100.0);
    s.queueSweep();
    REQUIRE(s.chunkCount() == 3);

    std::vector<float> outL(static_cast<std::size_t>(frames), 0.0f), outR = outL;
    std::vector<int> cover(static_cast<std::size_t>(frames), 0);
    std::vector<double> otherEnergy(3, 0.0);
    REQUIRE(s.run(identityInfer,
                  [&](const ReadyChunk& c)
                  {
                      REQUIRE(c.stems.size() == static_cast<std::size_t>(kStemPlanes));
                      const std::int64_t n = c.endFrame - c.startFrame;
                      REQUIRE(static_cast<std::int64_t>(c.stems[0].size()) == n);
                      for (std::int64_t i = 0; i < n; ++i)
                      {
                          outL[static_cast<std::size_t>(c.startFrame + i)] = c.stems[0][static_cast<std::size_t>(i)];
                          outR[static_cast<std::size_t>(c.startFrame + i)] = c.stems[1][static_cast<std::size_t>(i)];
                          cover[static_cast<std::size_t>(c.startFrame + i)]++;
                      }
                      for (int k = 1; k < kStemRows; ++k)
                          for (float v : c.stems[static_cast<std::size_t>(k * 2)])
                              otherEnergy[static_cast<std::size_t>(k - 1)] +=
                                  static_cast<double>(v) * static_cast<double>(v);
                  }));

    // Every frame reported exactly once — spans tile the track.
    for (int c : cover)
        REQUIRE(c == 1);
    INFO("seam SNR L = " << snrDb(l, outL, 0, frames) << " dB");
    REQUIRE(snrDb(l, outL, 0, frames) >= 33.0);
    REQUIRE(snrDb(r, outR, 0, frames) >= 33.0);
    // A silent stem row stays silent (nothing leaks between rows in the accumulate).
    for (double e : otherEnergy)
        REQUIRE(e == 0.0);
}

TEST_CASE("Stems split: the 48k rate bridge keeps the stems sample-aligned", "[stems][split][gate]")
{
    const std::int64_t frames = 48000 * 14; // two chunks' worth at 44.1k
    const auto l = sine(frames, 220.0, 48000.0, 0.4f), r = sine(frames, 330.0, 48000.0, 0.4f);
    SplitSession s(l.data(), r.data(), frames, 48000.0);
    REQUIRE(s.sourceFrames() == frames);
    REQUIRE(s.modelFrames() == Resampler(48000, 44100).outLength(frames));
    s.queueSweep();

    std::vector<float> outL(static_cast<std::size_t>(frames), 0.0f);
    std::vector<int> cover(static_cast<std::size_t>(frames), 0);
    REQUIRE(s.run(identityInfer,
                  [&](const ReadyChunk& c)
                  {
                      for (std::int64_t i = 0; i < c.endFrame - c.startFrame; ++i)
                      {
                          outL[static_cast<std::size_t>(c.startFrame + i)] = c.stems[0][static_cast<std::size_t>(i)];
                          cover[static_cast<std::size_t>(c.startFrame + i)]++;
                      }
                  }));
    // The spans still tile the SOURCE track exactly, end pinned to the real end of the audio.
    for (int c : cover)
        REQUIRE(c == 1);
    // Down to 44.1k and back is a band-limited round trip: the 220 Hz tone survives it.
    INFO("rate-bridge SNR = " << snrDb(l, outL, 2000, frames - 2000) << " dB");
    REQUIRE(snrDb(l, outL, 2000, frames - 2000) >= 33.0);
}

TEST_CASE("Stems queue: a focused window jumps ahead, and cancel stops the run", "[stems][grid]")
{
    const std::int64_t frames = kStride * 4;
    const auto l = noise(frames, 7), r = noise(frames, 8);
    const double strideSec = static_cast<double>(kStride) / kModelRate;

    SplitSession s(l.data(), r.data(), frames, 44100.0);
    s.queueSweep();
    REQUIRE(s.queuedTotal() == 4);
    // The pad he just tapped, 3 s into chunk 3 (past the 1.95 s overlap, so chunk 3 alone). It is ALREADY in
    // the sweep queue: a front enqueue moves it to the head rather than skipping it, and does not double-count.
    s.queueWindows({{3.0 * strideSec + 3.0, 3.0 * strideSec + 3.1}}, true);
    REQUIRE(s.queuedTotal() == 4);

    // Which chunk a call is looking at: chunk i's first sample is l[i * stride].
    std::vector<int> order;
    const auto whichChunk = [&](const float* mix)
    {
        for (int i = 0; i < 4; ++i)
            if (mix[0] == l[static_cast<std::size_t>(static_cast<std::int64_t>(i) * kStride)])
                return i;
        return -1;
    };
    std::vector<Range> emitted;
    const auto onChunk = [&](const ReadyChunk& c) { emitted.push_back({c.startFrame, c.endFrame}); };
    const auto cancelAfterFirst = [&](const float* mix, float* rows)
    {
        order.push_back(whichChunk(mix));
        s.cancel(); // stop after this one — the run must not take another chunk off the queue
        return identityInfer(mix, rows);
    };
    REQUIRE_FALSE(s.run(cancelAfterFirst, onChunk));
    REQUIRE(order == std::vector<int>{3});
    REQUIRE(s.doneCount() == Approx(1.0));
    REQUIRE(s.pending() == 3);
    REQUIRE(emitted.empty()); // chunk 3 alone: its head needs chunk 2, so nothing is ready yet
}

TEST_CASE("Stems split: progress counts the chunks queued, sub-chunk ticks included", "[stems][grid]")
{
    const std::int64_t frames = kStride * 2;
    const auto l = noise(frames, 9), r = noise(frames, 10);
    SplitSession s(l.data(), r.data(), frames, 44100.0);
    s.queueSweep();
    const int total = s.queuedTotal();
    REQUIRE(total == 2);

    std::vector<double> ticks;
    const auto infer = [&](const float* mix, float* rows)
    {
        s.reportPartial(0.25); // what FINE does per specialist
        return identityInfer(mix, rows);
    };
    REQUIRE(s.run(
        infer, [](const ReadyChunk&) {},
        [&](double done, int t)
        {
            REQUIRE(t == total);
            ticks.push_back(done);
        }));
    REQUIRE(ticks.size() == 4u);
    REQUIRE(ticks[0] == Approx(0.25));
    REQUIRE(ticks[1] == Approx(1.0));
    REQUIRE(ticks[2] == Approx(1.25));
    REQUIRE(ticks[3] == Approx(2.0));
    REQUIRE(s.doneCount() == Approx(static_cast<double>(total)));
}

// ---------------------------------------------------------------------------------------------------------
// THE STEM SET (7.1c) — where a split's spans land: four full-length planes the engine can read straight, plus
// the ready ranges (seconds, merged) that decide whether a pad plays its stem mix or the original.
TEST_CASE("Stem set: a split's spans land in the planes, and the ranges say where", "[stems][set]")
{
    const std::int64_t frames = kStride * 2 + 5000;
    const auto l = noise(frames, 11), r = noise(frames, 12);
    SplitSession session(l.data(), r.data(), frames, 44100.0);
    StemSet set(frames, 2, 44100.0);
    REQUIRE(set.valid());
    REQUIRE(set.ranges().empty());
    REQUIRE_FALSE(set.ready(0.0, 1.0)); // nothing separated yet: the ORIGINAL plays

    // Only the first chunk's window, so the track is PARTLY separated — the normal state mid-split.
    session.queueWindows({{0.1, 0.2}}, false);
    REQUIRE(session.run(identityInfer, [&](const ReadyChunk& c) { set.write(c); }));

    REQUIRE(set.ranges().size() == 1u);
    REQUIRE(set.ranges()[0].start == Approx(0.0));
    REQUIRE(set.ranges()[0].end == Approx(static_cast<double>(kStride) / kModelRate));
    REQUIRE(set.ready(0.5, 1.5));
    REQUIRE_FALSE(set.ready(5.0, 7.0)); // past the ready edge
    REQUIRE(set.readySeconds() == Approx(static_cast<double>(kStride) / kModelRate));

    // The drums plane IS the mix over that span (the identity model), and the untouched tail is still silent.
    const auto drums = set.plane(0);
    REQUIRE(drums != nullptr);
    REQUIRE(drums->numFrames == frames);
    REQUIRE(drums->numChannels == 2);
    REQUIRE(drums->sampleRate == Approx(44100.0));
    for (std::int64_t i = 0; i < kStride; i += 97)
    {
        REQUIRE(drums->channel(0)[i] == Approx(l[static_cast<std::size_t>(i)]).margin(1e-5));
        REQUIRE(drums->channel(1)[i] == Approx(r[static_cast<std::size_t>(i)]).margin(1e-5));
    }
    for (std::int64_t i = kStride + 1000; i < frames; i += 997)
        REQUIRE(drums->channel(0)[i] == 0.0f);
    // A silent stem row stays a silent plane.
    REQUIRE(set.plane(1)->channel(0)[100] == 0.0f);

    // Finishing the track merges into ONE range covering everything.
    session.queueSweep();
    REQUIRE(session.run(identityInfer, [&](const ReadyChunk& c) { set.write(c); }));
    REQUIRE(set.ranges().size() == 1u);
    REQUIRE(set.ranges()[0].end == Approx(static_cast<double>(frames) / 44100.0));
    REQUIRE(set.ready(0.0, static_cast<double>(frames) / 44100.0 - 0.01));

    // What the voice checks before it sums anything: four planes, same length, rate and channels as the base.
    const auto pointers = set.planePointers();
    for (const auto* p : pointers)
    {
        REQUIRE(p != nullptr);
        REQUIRE(p->numFrames == frames);
        REQUIRE(p->numChannels == 2);
    }
}

TEST_CASE("Stem set: a mono source keeps mono planes, and a span past the end is clipped", "[stems][set]")
{
    const std::int64_t frames = 20000;
    StemSet set(frames, 1, 44100.0);
    REQUIRE(set.plane(0)->numChannels == 1);

    ReadyChunk chunk;
    chunk.startFrame = frames - 1000;
    chunk.endFrame = frames + 5000; // runs off the end
    chunk.stems.assign(static_cast<std::size_t>(kStemPlanes), std::vector<float>(6000, 0.25f));
    set.write(chunk);
    REQUIRE(set.plane(0)->channel(0)[frames - 1] == Approx(0.25f));
    REQUIRE(set.ranges().size() == 1u);
    REQUIRE(set.ranges()[0].end == Approx(static_cast<double>(frames) / 44100.0));

    // A chunk with too few planes is ignored rather than read out of bounds.
    ReadyChunk bad;
    bad.startFrame = 0;
    bad.endFrame = 100;
    bad.stems.assign(3, std::vector<float>(100, 1.0f));
    set.write(bad);
    REQUIRE(set.plane(0)->channel(0)[0] == 0.0f);
}
