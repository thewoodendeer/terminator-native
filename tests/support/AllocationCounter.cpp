#include "AllocationCounter.h"

#include <cstdlib>
#include <new>

namespace
{
thread_local std::uint64_t gAllocs = 0;

void* countedAlloc(std::size_t size)
{
    ++gAllocs;
    if (size == 0)
        size = 1;
    if (void* p = std::malloc(size))
        return p;
    throw std::bad_alloc{};
}
} // namespace

namespace terminator::test
{
std::uint64_t allocationCountThisThread() noexcept
{
    return gAllocs;
}
void resetAllocationCountThisThread() noexcept
{
    gAllocs = 0;
}
} // namespace terminator::test

void* operator new(std::size_t size)
{
    return countedAlloc(size);
}
void* operator new[](std::size_t size)
{
    return countedAlloc(size);
}
void* operator new(std::size_t size, const std::nothrow_t&) noexcept
{
    ++gAllocs;
    return std::malloc(size == 0 ? 1 : size);
}
void* operator new[](std::size_t size, const std::nothrow_t&) noexcept
{
    ++gAllocs;
    return std::malloc(size == 0 ? 1 : size);
}
void operator delete(void* p) noexcept
{
    std::free(p);
}
void operator delete[](void* p) noexcept
{
    std::free(p);
}
void operator delete(void* p, std::size_t) noexcept
{
    std::free(p);
}
void operator delete[](void* p, std::size_t) noexcept
{
    std::free(p);
}
void operator delete(void* p, const std::nothrow_t&) noexcept
{
    std::free(p);
}
void operator delete[](void* p, const std::nothrow_t&) noexcept
{
    std::free(p);
}
