#pragma once
// Real-time annotations and assertions. See docs/native/RT-RULES.md.
//
// TERMINATOR_NONBLOCKING   — marks a function as running on the audio thread. With an LLVM 20+ clang this is
//                            [[clang::nonblocking]]: -Wfunction-effects flags blocking/allocating calls at
//                            compile time and -fsanitize=realtime (RTSan) aborts on them at run time.
// TERMINATOR_RT_ASSERT(x)  — debug-only assertion usable on the audio thread (no allocation, no I/O; it
//                            traps instead of printing). Compiled out in Release.
#include <cstdlib>

#if defined(__clang__) && defined(__has_cpp_attribute)
#if __has_cpp_attribute(clang::nonblocking)
#define TERMINATOR_NONBLOCKING [[clang::nonblocking]]
#define TERMINATOR_HAS_NONBLOCKING 1
#endif
#endif
#ifndef TERMINATOR_NONBLOCKING
#define TERMINATOR_NONBLOCKING
#define TERMINATOR_HAS_NONBLOCKING 0
#endif

#if defined(_MSC_VER)
#define TERMINATOR_TRAP() __debugbreak()
#else
#define TERMINATOR_TRAP() __builtin_trap()
#endif

#if defined(NDEBUG)
#define TERMINATOR_RT_ASSERT(x) ((void)0)
#else
#define TERMINATOR_RT_ASSERT(x)                                                                                        \
    do                                                                                                                 \
    {                                                                                                                  \
        if (!(x))                                                                                                      \
            TERMINATOR_TRAP();                                                                                         \
    } while (false)
#endif
