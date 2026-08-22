#pragma once
// Single-producer / single-consumer lock-free ring buffer for trivially-copyable items.
// Producer = the message (UI) thread. Consumer = the audio thread (pop() is RT-safe: no allocation,
// no locks, no syscalls). Capacity is a power of two; the queue holds Capacity-1 items.
//
// Multi-producer is NOT supported — if more than one non-RT thread needs to talk to the engine, funnel
// through the message thread (or add an MPSC variant; do not "just add a mutex").
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <type_traits>

#include "terminator/core/Platform.h"
#include "terminator/core/RtAssert.h"

namespace terminator
{

template <typename T, std::size_t Capacity> class SpscQueue
{
    static_assert(std::is_trivially_copyable_v<T>, "SpscQueue items must be trivially copyable");
    static_assert(Capacity >= 2 && (Capacity & (Capacity - 1)) == 0, "Capacity must be a power of two");

  public:
    SpscQueue() = default;
    SpscQueue(const SpscQueue&) = delete;
    SpscQueue& operator=(const SpscQueue&) = delete;

    /// Producer thread only. Returns false (and drops nothing else) when the queue is full.
    bool push(const T& item) noexcept
    {
        const auto head = head_.load(std::memory_order_relaxed);
        const auto next = (head + 1) & kMask;
        if (next == tail_.load(std::memory_order_acquire))
        {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        slots_[head] = item;
        head_.store(next, std::memory_order_release);
        return true;
    }

    /// Consumer (audio) thread only. RT-safe.
    bool pop(T& out) noexcept TERMINATOR_NONBLOCKING
    {
        const auto tail = tail_.load(std::memory_order_relaxed);
        if (tail == head_.load(std::memory_order_acquire))
            return false;
        out = slots_[tail];
        tail_.store((tail + 1) & kMask, std::memory_order_release);
        return true;
    }

    /// Approximate — safe to call from any thread for diagnostics.
    std::size_t sizeApprox() const noexcept
    {
        const auto head = head_.load(std::memory_order_acquire);
        const auto tail = tail_.load(std::memory_order_acquire);
        return (head - tail) & kMask;
    }
    bool emptyApprox() const noexcept { return sizeApprox() == 0; }
    static constexpr std::size_t capacity() noexcept { return Capacity - 1; }
    /// Number of pushes refused because the queue was full (diagnostic; a non-zero value is a bug upstream).
    std::uint64_t droppedCount() const noexcept { return dropped_.load(std::memory_order_relaxed); }

  private:
    static constexpr std::size_t kMask = Capacity - 1;

    alignas(kCacheLine) std::atomic<std::size_t> head_{0}; // written by producer
    alignas(kCacheLine) std::atomic<std::size_t> tail_{0}; // written by consumer
    alignas(kCacheLine) std::atomic<std::uint64_t> dropped_{0};
    alignas(kCacheLine) std::array<T, Capacity> slots_{};
};

} // namespace terminator
