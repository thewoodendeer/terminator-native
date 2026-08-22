#pragma once
// Snap — pure port of ChopperEngine.applySnap/snapToTransient/snapToBeat/gridAnchor. A boundary/position is
// snapped to the nearest transient, or to a beat grid spaced (60/bpm)*(4/div) and anchored at the first drum
// hit (folded into [0,beat)). Beat modes fall back to transient when bpm is unknown. `transients` are the
// ACTIVE set (broadband or drum-only per the acDrumsOnly toggle); `drumTransients`/`broadbandTransients` seed
// the grid anchor. All times in seconds.
#include <algorithm>
#include <cmath>
#include <vector>

namespace terminator::snap
{
enum class Mode
{
    off,
    transient,
    beat4,
    beat8,
    beat16
};

/// Nearest active transient within `windowSec`; the input unchanged if none is closer. Binary-searchy scan
/// over the 3 candidates around the insertion point (matches the Electron code).
inline double snapToTransient(double posSec, const std::vector<float>& transients, double windowSec = 0.25)
{
    if (transients.empty())
        return posSec;
    // lower_bound
    std::size_t lo = 0, hi = transients.size() - 1;
    while (lo < hi)
    {
        const std::size_t mid = (lo + hi) / 2;
        if (static_cast<double>(transients[mid]) < posSec)
            lo = mid + 1;
        else
            hi = mid;
    }
    double best = posSec, bestDist = windowSec;
    for (long long idx = static_cast<long long>(lo) - 1; idx <= static_cast<long long>(lo) + 1; ++idx)
    {
        if (idx < 0 || idx >= static_cast<long long>(transients.size()))
            continue;
        const double d = std::abs(static_cast<double>(transients[static_cast<std::size_t>(idx)]) - posSec);
        if (d < bestDist)
        {
            bestDist = d;
            best = static_cast<double>(transients[static_cast<std::size_t>(idx)]);
        }
    }
    return best;
}

/// Beat-1 position: first drum hit, else first broadband, else 0 — folded into [0, beat).
inline double gridAnchor(double bpm, const std::vector<float>& drumTransients,
                         const std::vector<float>& broadbandTransients)
{
    const double candidate = !drumTransients.empty()        ? static_cast<double>(drumTransients[0])
                             : !broadbandTransients.empty() ? static_cast<double>(broadbandTransients[0])
                                                            : 0.0;
    if (bpm <= 0.0)
        return candidate;
    const double beat = 60.0 / bpm;
    return std::fmod(std::fmod(candidate, beat) + beat, beat);
}

inline double snapToBeat(double posSec, int div, double bpm, const std::vector<float>& drumTransients,
                         const std::vector<float>& broadbandTransients)
{
    if (bpm <= 0.0)
        return posSec;
    const double step = (60.0 / bpm) * (4.0 / div);
    if (step <= 0.0)
        return posSec;
    const double anchor = gridAnchor(bpm, drumTransients, broadbandTransients);
    const double idx = std::floor((posSec - anchor) / step + 0.5); // Math.round
    return anchor + idx * step;
}

inline double applySnap(double posSec, Mode mode, double bpm, const std::vector<float>& active,
                        const std::vector<float>& drumTransients, const std::vector<float>& broadbandTransients)
{
    switch (mode)
    {
    case Mode::off:
        return posSec;
    case Mode::transient:
        return snapToTransient(posSec, active);
    case Mode::beat4:
        return bpm > 0 ? snapToBeat(posSec, 4, bpm, drumTransients, broadbandTransients)
                       : snapToTransient(posSec, active);
    case Mode::beat8:
        return bpm > 0 ? snapToBeat(posSec, 8, bpm, drumTransients, broadbandTransients)
                       : snapToTransient(posSec, active);
    case Mode::beat16:
        return bpm > 0 ? snapToBeat(posSec, 16, bpm, drumTransients, broadbandTransients)
                       : snapToTransient(posSec, active);
    }
    return posSec;
}
} // namespace terminator::snap
