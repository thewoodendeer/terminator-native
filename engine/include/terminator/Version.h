#pragma once
// Version string comes from the root CMakeLists (TERMINATOR_VERSION_STRING). Single source of truth.
#ifndef TERMINATOR_VERSION_STRING
#define TERMINATOR_VERSION_STRING "0.0.0-dev"
#endif
namespace terminator
{
inline constexpr const char* versionString() noexcept
{
    return TERMINATOR_VERSION_STRING;
}
} // namespace terminator
