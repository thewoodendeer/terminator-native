#pragma once
// Small helpers that reproduce JavaScript number semantics where the ported planners depend on them.
// The Electron engine is the reference for every planner in this directory; where JS and C++ disagree
// (Math.round of negative halves, float32 storage of times) we follow JS so the ported tests hold bit-for-bit.
#include <cmath>
#include <cstdint>

namespace terminator::js
{
/// JavaScript Math.round: halves round toward +infinity (std::round rounds away from zero).
inline double round(double x) noexcept
{
    return std::floor(x + 0.5);
}
inline std::int64_t roundToInt(double x) noexcept
{
    return static_cast<std::int64_t>(std::floor(x + 0.5));
}
/// JavaScript `x | 0` on a non-negative finite double.
inline std::int64_t truncToInt(double x) noexcept
{
    return static_cast<std::int64_t>(x);
}
inline double clamp(double v, double lo, double hi) noexcept
{
    return v < lo ? lo : (v > hi ? hi : v);
}
} // namespace terminator::js
