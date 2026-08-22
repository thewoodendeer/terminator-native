#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <thread>

#include "AllocationCounter.h"
#include "terminator/core/StateSnapshot.h"

using namespace terminator;

TEST_CASE("SnapshotPublisher: read returns the latest publish; stable when nothing new", "[snapshot]")
{
    SnapshotPublisher<StateSnapshot> pub;
    REQUIRE(pub.read().blocksProcessed == 0); // default-constructed slot

    StateSnapshot s{};
    s.blocksProcessed = 1;
    pub.publish(s);
    REQUIRE(pub.read().blocksProcessed == 1);
    REQUIRE(pub.read().blocksProcessed == 1); // re-read without publish stays

    s.blocksProcessed = 2;
    pub.publish(s);
    s.blocksProcessed = 3;
    pub.publish(s); // two publishes, one read → sees the newest
    REQUIRE(pub.read().blocksProcessed == 3);
}

TEST_CASE("SnapshotPublisher: publish never allocates", "[snapshot][rt]")
{
    SnapshotPublisher<StateSnapshot> pub;
    StateSnapshot s{};
    const auto allocs = test::allocationsDuring(
        [&]
        {
            for (int i = 0; i < 1000; ++i)
            {
                s.blocksProcessed = static_cast<std::uint64_t>(i);
                pub.publish(s);
            }
        });
    REQUIRE(allocs == 0);
}

TEST_CASE("SnapshotPublisher: writer and reader threads - reader sees monotonic, consistent snapshots",
          "[snapshot][threads]")
{
    SnapshotPublisher<StateSnapshot> pub;
    constexpr std::uint64_t kN = 300000;
    std::atomic<bool> done{false};

    std::thread writer(
        [&]
        {
            StateSnapshot s{};
            for (std::uint64_t i = 1; i <= kN; ++i)
            {
                s.blocksProcessed = i;
                s.samplesProcessed = i * 512; // consistency check: must always match blocksProcessed
                s.playheadSamples = i * 512;
                pub.publish(s);
            }
            done.store(true, std::memory_order_release);
        });

    std::uint64_t last = 0;
    std::uint64_t reads = 0;
    bool consistent = true, monotonic = true;
    do // at least one read even if the writer already finished (fast CI machines)
    {
        const auto& s = pub.read();
        if (s.samplesProcessed != s.blocksProcessed * 512)
            consistent = false;
        if (s.blocksProcessed < last)
            monotonic = false;
        last = s.blocksProcessed;
        ++reads;
    } while (!done.load(std::memory_order_acquire) || pub.read().blocksProcessed < kN);
    writer.join();
    REQUIRE(consistent);
    REQUIRE(monotonic);
    REQUIRE(pub.read().blocksProcessed == kN);
    REQUIRE(reads > 0);
}
