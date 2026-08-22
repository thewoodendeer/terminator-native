#pragma once
// Sequencer storage math — port of the pure parts of ChopperEngine's step sequencer: constants, the grid
// resolutions, clampVel, and refitSeqStorage ("the grid is a lens, not the tape": storage is re-fit to the
// coarsest resolution that is a multiple of the view AND keeps every note on an integer step; lossless both
// ways). The transport-side rescale of a RUNNING loop is the transport's business (Phase 3).
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

#include "terminator/core/planners/JsMath.h"

namespace terminator::seq
{
inline constexpr int kSeqMaxSteps = 1536;    // 4 bars × 384
inline constexpr int kSeqMaxViewSteps = 512; // bars × view the UI can draw
inline constexpr int kSeqMaxBars = 4;
inline constexpr std::array<int, 14> kSeqResolutions = {2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192};

constexpr bool isSeqResolution(int r) noexcept
{
    for (const int x : kSeqResolutions)
        if (x == r)
            return true;
    return false;
}
/// Stored resolutions a loader accepts: the set above, or anything that divides 384 — else 16.
constexpr int acceptStoredResolution(double r) noexcept
{
    const auto i = static_cast<int>(r);
    if (static_cast<double>(i) != r)
        return 16;
    return (isSeqResolution(i) || (i > 0 && 384 % i == 0)) ? i : 16;
}
/// A view resolution must be in the set AND divide the stored resolution; else the view = the storage.
constexpr int acceptViewResolution(double view, int resolution) noexcept
{
    const auto v = static_cast<int>(view);
    return (static_cast<double>(v) == view && v > 0 && isSeqResolution(v) && resolution % v == 0) ? v : resolution;
}
/// Per-cell velocity: never fully silent (a placed note always sounds). Non-finite → 1.
inline float clampVel(double v) noexcept
{
    return std::isfinite(v) ? static_cast<float>(js::clamp(v, 0.05, 1.0)) : 1.0f;
}
constexpr long long gcd(long long a, long long b) noexcept
{
    while (b != 0)
    {
        const long long t = a % b;
        a = b;
        b = t;
    }
    return a;
}
constexpr long long lcm(long long a, long long b) noexcept
{
    return (a / gcd(a, b)) * b;
}
constexpr int stepCount(int bars, int resolution) noexcept
{
    return std::min(kSeqMaxSteps, bars * resolution);
}
constexpr int viewStepCount(int bars, int viewResolution) noexcept
{
    return std::min(kSeqMaxViewSteps, bars * viewResolution);
}
constexpr int columnStride(int resolution, int viewResolution) noexcept
{
    const double r = static_cast<double>(resolution) / static_cast<double>(viewResolution < 1 ? 1 : viewResolution);
    const auto s = static_cast<int>(js::roundToInt(r));
    return s < 1 ? 1 : s;
}

/// The sequencer's stored pattern (per step: the pads firing + aligned rev/vel). Rows may be shorter than the
/// step count (absent rows = empty steps).
struct Storage
{
    int resolution = 16;
    std::vector<std::vector<int>> grid;
    std::vector<std::vector<bool>> rev;
    std::vector<std::vector<float>> vel;
};

/// The new stored resolution for `view` given the notes in `grid` at `oldRes` (+ optional recording floor).
inline int refitResolution(const std::vector<std::vector<int>>& grid, int oldRes, int view, int floor,
                           int bars) noexcept
{
    const long long C = lcm(oldRes, view);
    const long long up = C / oldRes;
    long long g = C / view;
    for (std::size_t s = 0; s < grid.size(); ++s)
        if (!grid[s].empty())
            g = gcd(g, static_cast<long long>(s) * up);
    long long next = C / g;
    if (floor > next)
    {
        const long long base = next;
        for (const int r : kSeqResolutions)
        {
            if (r <= next || r > floor || r % base != 0)
                continue;
            if (bars * r > kSeqMaxSteps)
                continue;
            next = r;
        }
    }
    return static_cast<int>(next);
}

struct RefitResult
{
    int oldResolution = 16;
    int newResolution = 16;
    double ratio = 1.0; // new / old
    bool changed = false;
};

/// Re-store `st` at the coarsest resolution that fits `view` (+ the recording `floor`): notes keep their
/// musical time. Also keeps the step-input cursor in place (on a column) and clips rows past the caps.
inline RefitResult refitStorage(Storage& st, int view, int floor, int bars, int& recordStep) noexcept
{
    RefitResult res;
    const int old = st.resolution;
    res.oldResolution = old;
    const int next = refitResolution(st.grid, old, view, floor, bars);
    res.newResolution = next;
    res.ratio = static_cast<double>(next) / static_cast<double>(old);
    if (next != old)
    {
        // Lossless resolution first (C/g — every note lands on an integer step), then the recording floor may
        // have raised `next` to a multiple of it: scale by that factor too. (The Electron refit forgets this
        // second factor and leaves notes at their old indices when the floor kicks in — a latent bug, flagged.)
        const long long C = lcm(old, view);
        const long long up = C / old;
        long long g = C / view;
        for (std::size_t s = 0; s < st.grid.size(); ++s)
            if (!st.grid[s].empty())
                g = gcd(g, static_cast<long long>(s) * up);
        const long long lossless = C / g;
        const long long k = next / lossless;
        std::vector<std::vector<int>> grid;
        std::vector<std::vector<bool>> rev;
        std::vector<std::vector<float>> vel;
        for (std::size_t s = 0; s < st.grid.size(); ++s)
        {
            if (st.grid[s].empty())
                continue;
            const auto ns = static_cast<std::size_t>(((static_cast<long long>(s) * up) / g) * k);
            if (grid.size() <= ns)
            {
                grid.resize(ns + 1);
                rev.resize(ns + 1);
                vel.resize(ns + 1);
            }
            grid[ns] = st.grid[s];
            rev[ns] = s < st.rev.size() ? st.rev[s] : std::vector<bool>{};
            vel[ns] = s < st.vel.size() ? st.vel[s] : std::vector<float>{};
        }
        st.grid = std::move(grid);
        st.rev = std::move(rev);
        st.vel = std::move(vel);
        const int stride = columnStride(next, view);
        recordStep = static_cast<int>(js::roundToInt((recordStep * res.ratio) / stride)) * stride;
        st.resolution = next;
        res.changed = true;
    }
    const auto cap = static_cast<std::size_t>(stepCount(bars, st.resolution));
    if (st.grid.size() > cap)
        st.grid.resize(cap);
    if (st.rev.size() > cap)
        st.rev.resize(cap);
    if (st.vel.size() > cap)
        st.vel.resize(cap);
    const int vcap = viewStepCount(bars, view);
    if (recordStep >= vcap * columnStride(st.resolution, view))
        recordStep = 0;
    return res;
}
} // namespace terminator::seq
