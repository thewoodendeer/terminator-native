#pragma once
#include <cstddef>
#include <new>

namespace terminator
{
#if defined(__cpp_lib_hardware_interference_size)
inline constexpr std::size_t kCacheLine = std::hardware_destructive_interference_size;
#else
inline constexpr std::size_t kCacheLine = 64;
#endif
} // namespace terminator
