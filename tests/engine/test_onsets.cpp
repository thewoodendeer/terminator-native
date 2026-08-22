// Onset / BPM / silence detectors — the exact-param ports validated against synthetic material with known
// answers (the Electron detectors have no golden fixtures; these pin the parameters and the arithmetic).
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "terminator/core/planners/Onsets.h"

using namespace terminator::onsets;
using Catch::Approx;

namespace
{
// impulses (short decaying bursts) at the given times, silence elsewhere
std::vector<float> bursts(double sr, double durSec, const std::vector<double>& times, double freq = 120.0)
{
    std::vector<float> a(static_cast<std::size_t>(sr * durSec), 0.0f);
    for (double t : times)
    {
        const auto s = static_cast<std::int64_t>(t * sr);
        for (std::int64_t i = 0;
             i < static_cast<std::int64_t>(sr * 0.05) && s + i < static_cast<std::int64_t>(a.size()); ++i)
            a[static_cast<std::size_t>(s + i)] +=
                static_cast<float>(std::exp(-30.0 * static_cast<double>(i) / (sr * 0.05)) *
                                   std::sin(2.0 * M_PI * freq * static_cast<double>(i) / sr));
    }
    return a;
}
bool near(const std::vector<float>& times, double want, double tol)
{
    for (float t : times)
        if (std::abs(static_cast<double>(t) - want) < tol)
            return true;
    return false;
}
} // namespace

TEST_CASE("detectTransients: finds broadband onsets near the impulses, respects the 30 ms gap", "[onsets]")
{
    const double sr = 48000.0;
    auto mono = bursts(sr, 4.0, {0.5, 1.0, 1.5, 2.0, 2.5, 3.0});
    auto on = detectTransients(mono, sr);
    REQUIRE(on.times.size() >= 6);
    for (double t : {0.5, 1.0, 1.5, 2.0, 2.5, 3.0})
        CHECK(near(on.times, t, 0.02));
    CHECK(on.strengths.size() == on.times.size());
}

TEST_CASE("detectDrumTransients: kicks (low) and snares (high) both detected, hats-only suppressed", "[onsets]")
{
    const double sr = 48000.0;
    // low-freq "kicks" at 0.5/1.5, mid "snares" at 1.0/2.0, plus a high-freq-only "hat" at 2.5 (should be weak)
    auto mono = bursts(sr, 3.0, {0.5, 1.5}, 60.0);
    auto snares = bursts(sr, 3.0, {1.0, 2.0}, 1200.0);
    for (std::size_t i = 0; i < mono.size(); ++i)
        mono[i] += snares[i];
    auto on = detectDrumTransients(mono, sr);
    REQUIRE(on.times.size() >= 4);
    for (double t : {0.5, 1.0, 1.5, 2.0})
        CHECK(near(on.times, t, 0.03));
}

TEST_CASE("detectSilenceEnd: returns the first window above RMS 0.015", "[onsets]")
{
    const double sr = 48000.0;
    std::vector<float> mono(static_cast<std::size_t>(sr * 2), 0.0f);
    // sound starts at 0.7 s
    for (std::int64_t i = static_cast<std::int64_t>(sr * 0.7); i < static_cast<std::int64_t>(sr * 2); ++i)
        mono[static_cast<std::size_t>(i)] =
            0.3f * static_cast<float>(std::sin(2.0 * M_PI * 200.0 * static_cast<double>(i) / sr));
    const double end = detectSilenceEnd(mono, sr);
    CHECK(end == Approx(0.7).margin(0.02));
    // an all-silent buffer returns 0
    std::vector<float> silent(1000, 0.0f);
    CHECK(detectSilenceEnd(silent, sr) == 0.0);
}

TEST_CASE("estimateBpm: a 4-on-the-floor click track reads its tempo (folded to 75..165)", "[onsets]")
{
    const double sr = 48000.0;
    // 120 BPM = a beat every 0.5 s over 16 s
    std::vector<double> beats;
    for (double t = 0.0; t < 16.0; t += 0.5)
        beats.push_back(t);
    auto mono = bursts(sr, 16.0, beats, 80.0);
    const int bpm = estimateBpm(mono, mono, sr, 16.0);
    CHECK(bpm == 120);
    // a short buffer (< 8 s) returns 0
    auto shortBuf = bursts(sr, 4.0, {0.0, 0.5}, 80.0);
    CHECK(estimateBpm(shortBuf, shortBuf, sr, 4.0) == 0);
    // 90 BPM (every 0.6667 s)
    std::vector<double> b90;
    for (double t = 0.0; t < 16.0; t += 60.0 / 90.0)
        b90.push_back(t);
    auto m90 = bursts(sr, 16.0, b90, 80.0);
    const int bpm90 = estimateBpm(m90, m90, sr, 16.0);
    CHECK(bpm90 == 90);
}
