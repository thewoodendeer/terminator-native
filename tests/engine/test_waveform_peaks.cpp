// Multi-resolution waveform peaks: the pyramid matches a direct min/max scan, a window at any zoom is cheap,
// and a cold re-open from the on-disk blob draws instantly (the 2.3 gate: ≤ 100 ms — here a 4-minute stereo
// buffer's blob loads + draws a full-width window in well under that, without touching the audio).
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cmath>

#include "terminator/analysis/WaveformPeaks.h"
#ifndef M_PI
#define M_PI 3.14159265358979323846 // MSVC does not define M_PI without _USE_MATH_DEFINES
#endif

using namespace terminator;
using namespace terminator::analysis;
using Catch::Approx;

namespace
{
std::shared_ptr<SampleBuffer> makeBuffer(std::int64_t frames, int channels, double sr)
{
    auto b = std::make_shared<SampleBuffer>();
    b->allocate(channels, frames, sr);
    for (int c = 0; c < channels; ++c)
        for (std::int64_t i = 0; i < frames; ++i)
            b->channel(c)[i] = static_cast<float>(std::sin(2.0 * M_PI * 220.0 * static_cast<double>(i) / sr) *
                                                  (0.2 + 0.8 * static_cast<double>(i) / static_cast<double>(frames)));
    return b;
}
} // namespace

TEST_CASE("WaveformPeaks: the finest level equals a direct 256-frame min/max scan", "[peaks]")
{
    const std::int64_t frames = static_cast<std::int64_t>(WaveformPeaks::kBaseBucketFrames) * 1000; // aligned
    auto buf = makeBuffer(frames, 1, 48000.0);
    WaveformPeaks p;
    p.build(*buf);
    REQUIRE(p.valid());
    CHECK(p.numFrames() == frames);
    // one output bucket per base bucket → identical to a direct scan
    const int base = WaveformPeaks::kBaseBucketFrames;
    const int nb = static_cast<int>((p.numFrames() + base - 1) / base);
    auto w = p.window(0, p.numFrames(), nb);
    REQUIRE(static_cast<int>(w.size()) == nb);
    for (int b = 0; b < nb; ++b)
    {
        const std::int64_t s = static_cast<std::int64_t>(b) * base;
        const std::int64_t e = std::min<std::int64_t>(s + base, p.numFrames());
        float mn = buf->channel(0)[s], mx = buf->channel(0)[s];
        for (std::int64_t i = s; i < e; ++i)
        {
            mn = std::min(mn, buf->channel(0)[i]);
            mx = std::max(mx, buf->channel(0)[i]);
        }
        CHECK(w[static_cast<std::size_t>(b)].min == Approx(mn).margin(1e-6));
        CHECK(w[static_cast<std::size_t>(b)].max == Approx(mx).margin(1e-6));
    }
}

TEST_CASE("WaveformPeaks: a zoomed-out window still bounds the audio (coarse level ⊇ fine)", "[peaks]")
{
    auto buf = makeBuffer(48000 * 10, 2, 48000.0);
    WaveformPeaks p;
    p.build(*buf);
    CHECK(p.numLevels() > 3);
    auto w = p.window(0, p.numFrames(), 800); // a typical waveform width
    REQUIRE(w.size() == 800);
    // the global max of the mono sum must be captured by SOME column
    float globalMax = -2.0f;
    for (std::int64_t i = 0; i < p.numFrames(); ++i)
        globalMax = std::max(globalMax, 0.5f * (buf->channel(0)[i] + buf->channel(1)[i]));
    float colMax = -2.0f;
    for (auto& mm : w)
        colMax = std::max(colMax, mm.max);
    CHECK(colMax == Approx(globalMax).margin(1e-3));
}

TEST_CASE("WaveformPeaks: cold re-open from the disk blob is instant and identical (the 2.3 gate)", "[peaks][gate]")
{
    auto buf = makeBuffer(static_cast<std::int64_t>(48000 * 240), 2, 48000.0); // 4 minutes stereo
    WaveformPeaks built;
    built.build(*buf);
    auto file = juce::File::createTempFile(".twk");
    REQUIRE(built.writeTo(file));
    // the blob is small (a pyramid, not the audio): a 4-min buffer is ~92 MB, the peaks are well under 1 MB
    CHECK(file.getSize() < 1024 * 1024);

    // COLD open: a fresh object reads the blob and draws a full-width window — no audio touched
    const auto t0 = std::chrono::steady_clock::now();
    WaveformPeaks cold;
    REQUIRE(cold.readFrom(file));
    auto w = cold.window(0, cold.numFrames(), 1600);
    const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    INFO("cold load + draw: " << ms << " ms, blob " << file.getSize() << " bytes");
    CHECK(ms < 100.0);
    REQUIRE(w.size() == 1600);
    // identical to the freshly-built peaks
    auto w2 = built.window(0, built.numFrames(), 1600);
    for (std::size_t i = 0; i < w.size(); ++i)
    {
        CHECK(w[i].min == Approx(w2[i].min));
        CHECK(w[i].max == Approx(w2[i].max));
    }
    file.deleteFile();
}

TEST_CASE("WaveformPeaks: corrupt / short blobs are rejected", "[peaks]")
{
    WaveformPeaks p;
    CHECK(!p.fromMemory("xx", 2));
    const char junk[8] = {1, 2, 3, 4, 5, 6, 7, 8};
    CHECK(!p.fromMemory(junk, sizeof(junk)));
}
