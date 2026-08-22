#pragma once
// 16T SWING — port of src/renderer/lib/swing.ts: ONE formula for both sequencers. Odd 16ths are pushed late by
// `swing × half a 16th`, snapped toward the 96-PPQ pulse grid as the amount rises (MPC-style). Downbeats never
// move. Plus ChopperEngine.seqSwingOffsetSec: steps inside an odd 16th all shift with that 16th.
#include <cmath>

#include "terminator/core/planners/JsMath.h"

namespace terminator::swing
{
inline double swingOffsetSec(int step16, double bpm, double swing) noexcept
{
    const double s = swing;
    if (s <= 0.0 || step16 % 2 == 0)
        return 0.0;
    if (bpm <= 0.0)
        return 0.0;
    const double stepDurMs = (60000.0 / bpm) / 4.0;
    const double pulseDurMs = 60000.0 / bpm / 96.0;
    const double swung = s * (stepDurMs / 2.0);
    const double quantized = js::round(swung / pulseDurMs) * pulseDurMs;
    const double finalMs = swung + s * (quantized - swung);
    return finalMs / 1000.0;
}
/// The swing offset (seconds) for a STORED step of a pattern at `resolution` steps per bar.
inline double seqSwingOffsetSec(int step, int resolution, double tempoBpm, double swing) noexcept
{
    if (swing <= 0.0)
        return 0.0;
    const int res = resolution < 1 ? 1 : resolution;
    const int idx16 = static_cast<int>(std::floor(static_cast<double>(step * 16) / static_cast<double>(res)));
    return swingOffsetSec(idx16, tempoBpm, swing);
}
} // namespace terminator::swing
