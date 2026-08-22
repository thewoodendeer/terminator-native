#pragma once
// Where a live-recorded hit LANDS, in STORED steps since the loop start — port of ChopperEngine.liveLanding.
// INPUT Q (`strength`, 0..1) pulls the hit toward the nearest line of THIS sequencer's grid by that fraction;
// the result is snapped to the nearest STORED step and THAT instant is what both the ear and the pattern get.
#include <cmath>

#include "terminator/core/planners/JsMath.h"

namespace terminator::seq
{
struct Landing
{
    int step = 0;
    double at = 0.0;
};
inline Landing liveLanding(double elapsed, double stepDur, double stride, double strength) noexcept
{
    if (!(stepDur > 0.0) || !(stride >= 1.0))
        return {0, 0.0};
    const double s = std::isfinite(strength) ? js::clamp(strength, 0.0, 1.0) : 1.0;
    const double gridDur = stepDur * stride;
    const double line = js::round(elapsed / gridDur) * gridDur;
    const double corrected = elapsed + s * (line - elapsed);
    const int step = static_cast<int>(js::roundToInt(corrected / stepDur));
    return {step, step * stepDur};
}
} // namespace terminator::seq
