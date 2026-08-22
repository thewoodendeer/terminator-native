#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <thread>
#include <vector>

#include "AllocationCounter.h"
#include "terminator/core/Command.h"
#include "terminator/core/CommandQueue.h"

using namespace terminator;

TEST_CASE("SpscQueue: FIFO order, empty/full, wrap-around", "[queue]")
{
    SpscQueue<Command, 8> q; // holds 7
    REQUIRE(q.capacity() == 7);
    REQUIRE(q.emptyApprox());
    Command out;
    REQUIRE_FALSE(q.pop(out));

    for (std::uint32_t i = 0; i < 7; ++i)
    {
        auto c = Command::setMasterGain(static_cast<float>(i));
        c.sequence = i;
        REQUIRE(q.push(c));
    }
    REQUIRE(q.sizeApprox() == 7);
    REQUIRE_FALSE(q.push(Command::panic())); // full
    REQUIRE(q.droppedCount() == 1);

    for (std::uint32_t i = 0; i < 7; ++i)
    {
        REQUIRE(q.pop(out));
        REQUIRE(out.type == CommandType::setMasterGain);
        REQUIRE(out.sequence == i);
        REQUIRE(out.payload.gain.linear == static_cast<float>(i));
    }
    REQUIRE_FALSE(q.pop(out));

    // wrap around many times
    for (std::uint32_t i = 0; i < 1000; ++i)
    {
        auto c = Command::transportPlay();
        c.sequence = i;
        REQUIRE(q.push(c));
        REQUIRE(q.pop(out));
        REQUIRE(out.sequence == i);
    }
    REQUIRE(q.emptyApprox());
}

TEST_CASE("SpscQueue: pop never allocates", "[queue][rt]")
{
    SpscQueue<Command, 64> q;
    for (int i = 0; i < 10; ++i)
        q.push(Command::transportStop());
    Command out;
    const auto allocs = test::allocationsDuring(
        [&]
        {
            while (q.pop(out))
            {
            }
        });
    REQUIRE(allocs == 0);
}

TEST_CASE("SpscQueue: producer/consumer threads preserve order and lose nothing", "[queue][threads]")
{
    constexpr std::uint32_t kItems = 200000;
    SpscQueue<Command, 256> q;
    std::atomic<bool> done{false};
    std::vector<std::uint32_t> seen;
    seen.reserve(kItems);

    std::thread consumer(
        [&]
        {
            Command c;
            while (seen.size() < kItems)
            {
                if (q.pop(c))
                    seen.push_back(c.sequence);
                else if (done.load(std::memory_order_acquire) && !q.pop(c))
                    std::this_thread::yield();
            }
        });
    for (std::uint32_t i = 0; i < kItems;)
    {
        auto c = Command::setMasterGain(1.0f);
        c.sequence = i;
        if (q.push(c))
            ++i;
        else
            std::this_thread::yield();
    }
    done.store(true, std::memory_order_release);
    consumer.join();

    REQUIRE(seen.size() == kItems);
    for (std::uint32_t i = 0; i < kItems; ++i)
        REQUIRE(seen[i] == i);
    REQUIRE(q.droppedCount() >= 0); // full-queue refusals are fine (producer retried); nothing lost
}
