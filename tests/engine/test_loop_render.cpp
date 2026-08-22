// LOOP crossfade render — the pure-math half of scripts/pad-loop.test.mts, re-asserted in C++.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "terminator/core/planners/LoopRender.h"
#ifndef M_PI
#define M_PI 3.14159265358979323846 // MSVC does not define M_PI without _USE_MATH_DEFINES
#endif

using Catch::Approx;
using namespace terminator::loop;

namespace
{
double at(const std::vector<float>& a, std::int64_t i)
{
    return static_cast<double>(a[static_cast<std::size_t>(i)]);
}
double maxStep(const std::vector<float>& a, std::int64_t from, std::int64_t to)
{
    double m = 0;
    for (std::int64_t i = from + 1; i < to; ++i)
        m = std::max(m, std::abs(at(a, i) - at(a, i - 1)));
    return m;
}
double rms(const std::vector<float>& a, std::int64_t from, std::int64_t to)
{
    double e = 0;
    for (std::int64_t i = from; i < to; ++i)
        e += at(a, i) * at(a, i);
    return std::sqrt(e / static_cast<double>(to - from));
}
} // namespace

TEST_CASE("renderCrossfadeLoop: no fades = raw region; crossfaded loops are seamless; caps + power hold",
          "[loop][planners]")
{
    const int SR = 44100;
    std::vector<float> src(SR);
    for (int i = 0; i < SR; ++i)
        src[static_cast<std::size_t>(i)] = static_cast<float>(std::sin(2 * M_PI * 137.3 * i / SR));
    const std::int64_t s0 = 1000, n = 12000;
    const double natural = maxStep(src, s0, s0 + n);

    {
        auto r = renderCrossfadeLoop({src.data()}, s0, n, 0, 0);
        CHECK(r.period == n);
        CHECK(r.frames[0].size() == static_cast<std::size_t>(2 * n));
        const double seam = std::abs(at(r.frames[0], 2 * n - 1) - at(r.frames[0], n));
        CHECK(seam > natural * 3);
    }
    for (auto [fi, fo] : std::vector<std::pair<std::int64_t, std::int64_t>>{
             {2000, 2000}, {500, 3000}, {3000, 500}, {12000, 6000}, {9000, 11000}, {12000, 11900}})
    {
        auto r = renderCrossfadeLoop({src.data()}, s0, n, fi, fo);
        const auto& b = r.frames[0];
        const auto P = r.period;
        const auto L = r.loopStart;
        CHECK(P == n - std::min<std::int64_t>(fo, n - 64));
        const double seamLoop = std::abs(at(b, L + P - 1) - at(b, L));
        const double seamIntro = std::abs(at(b, L - 1) - at(b, L));
        CHECK(seamLoop <= natural * 1.5);
        CHECK(seamIntro <= natural * 1.5);
        CHECK(std::abs(at(b, 0)) < 1e-6);
        const auto passes = static_cast<std::int64_t>(std::ceil(static_cast<double>(n) / static_cast<double>(P)));
        CHECK(maxStep(b, 0, static_cast<std::int64_t>(b.size())) <= natural * (static_cast<double>(passes) + 0.05));
    }
    {
        auto r = renderCrossfadeLoop({src.data()}, s0, n, 100000, 100000);
        CHECK(r.period == 64);
        CHECK(r.frames[0].size() == static_cast<std::size_t>((std::ceil(n / 64.0) + 1) * 64));
    }
    {
        std::vector<float> noise(SR);
        long long seed = 7;
        auto rnd = [&]
        {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return static_cast<double>(seed) / 0x7fffffff * 2 - 1;
        };
        for (int i = 0; i < SR; ++i)
            noise[static_cast<std::size_t>(i)] = static_cast<float>(rnd() * 0.5);
        const double one = rms(noise, s0, s0 + n);
        for (auto [fi, fo] :
             std::vector<std::pair<std::int64_t, std::int64_t>>{{2000, 2000}, {12000, 11900}, {6000, 11000}})
        {
            auto r = renderCrossfadeLoop({noise.data()}, s0, n, fi, fo);
            const double steady = rms(r.frames[0], r.loopStart, r.loopStart + r.period);
            CHECK(steady < one * 1.6);
            CHECK(steady > one * 0.4);
        }
    }
}
