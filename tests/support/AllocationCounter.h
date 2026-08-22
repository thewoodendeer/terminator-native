#pragma once
// Global operator new/delete replacement that counts allocations on the CURRENT thread. Works on every
// compiler (MSVC included), so the "no allocation on the audio path" gate runs on Windows CI too, not
// only under RTSan. Usage: auto n = terminator::test::allocationsDuring([&]{ engine.process(...); });
#include <cstddef>
#include <cstdint>

namespace terminator::test
{
std::uint64_t allocationCountThisThread() noexcept;
void resetAllocationCountThisThread() noexcept;

template <typename Fn> std::uint64_t allocationsDuring(Fn&& fn)
{
    const auto before = allocationCountThisThread();
    fn();
    return allocationCountThisThread() - before;
}
} // namespace terminator::test
