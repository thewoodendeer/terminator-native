// The RT gate. Under the mac-rtsan preset Engine::process is [[clang::nonblocking]] and any malloc/lock/
// syscall inside it aborts the process (RTSan) — so these tests "pass" by not dying. On every compiler the
// allocation counter additionally proves zero heap allocations on the callback path.
#include <catch2/catch_test_macros.hpp>

#include <vector>

#include "AllocationCounter.h"
#include "terminator/core/Engine.h"

using namespace terminator;

TEST_CASE("RT: Engine::process allocates nothing (empty callback, tone, commands, transport)", "[rt]")
{
    Engine e;
    e.prepare({48000.0, 512, 2});
    std::vector<float> l(512), r(512);
    float* outs[2] = {l.data(), r.data()};

    // empty callback
    REQUIRE(test::allocationsDuring([&] { e.process(outs, 2, 512); }) == 0);

    // with queued commands to drain and the tone running
    for (int i = 0; i < 100; ++i)
    {
        e.commands().push(Command::setMasterGain(0.5f));
        e.commands().push(Command::setTestTone(true, 440.0f + static_cast<float>(i), 0.5f));
        e.commands().push(Command::transportPlay());
    }
    REQUIRE(test::allocationsDuring(
                [&]
                {
                    for (int i = 0; i < 50; ++i)
                        e.process(outs, 2, 512);
                }) == 0);

    // full queue flood + panic
    while (e.commands().push(Command::transportStop()))
    {
    }
    e.commands().push(Command::panic());
    REQUIRE(test::allocationsDuring(
                [&]
                {
                    for (int i = 0; i < 4; ++i)
                        e.process(outs, 2, 512);
                }) == 0);
}

TEST_CASE("RT: process before prepare and after release allocates nothing", "[rt]")
{
    Engine e;
    std::vector<float> l(256), r(256);
    float* outs[2] = {l.data(), r.data()};
    REQUIRE(test::allocationsDuring([&] { e.process(outs, 2, 256); }) == 0);
    e.prepare({44100.0, 256, 2});
    e.release();
    REQUIRE(test::allocationsDuring([&] { e.process(outs, 2, 256); }) == 0);
}

#if defined(TERMINATOR_RTSAN)
TEST_CASE("RT: built with RealtimeSanitizer (informational)", "[rt][rtsan]")
{
    // If this test runs at all, the binary was built with -fsanitize=realtime and the tests above executed
    // Engine::process under RTSan's watch. A violation would have aborted before reaching here.
    SUCCEED("RTSan active");
}
#endif
