// The RT gate. Under the mac-rtsan preset Engine::process is [[clang::nonblocking]] and any malloc/lock/
// syscall inside it aborts the process (RTSan) — so these tests "pass" by not dying. On every compiler the
// allocation counter additionally proves zero heap allocations on the callback path.
#include <catch2/catch_test_macros.hpp>

#include <memory>
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

TEST_CASE(
    "RT: the bass synth + sequencer on the callback allocate nothing (patch, pattern, play, live notes, timeline)",
    "[rt]")
{
    Engine e;
    e.prepare({48000.0, 512, 2});
    std::vector<float> l(512), r(512);
    float* outs[2] = {l.data(), r.data()};
    auto patch = std::make_shared<BassPatch>(BassPatch::defaults());
    patch->voices = 6;
    patch->noiseLevel = 0.05;
    patch->mods[0] = {BassModSource::lfo1, BassModTarget::filterCutoff, 0.5};
    patch->mods[1] = {BassModSource::trigB, BassModTarget::postTone, 0.5};
    patch->numMods = 2;
    auto pat = std::make_shared<BassPattern>();
    pat->clear();
    pat->bars = 1;
    pat->loopTicks = 384;
    for (int b = 0; b < 16; ++b)
        pat->addNote(b + 1, 36 + (b % 7), b * 0.25, 0.2, 0.9, (b % 5) == 4);
    pat->hasBend = true;
    auto tl = std::make_shared<BassTimeline>();
    for (int i = 0; i < 64; ++i)
    {
        tl->add(BassSynth::EventKind::on, static_cast<std::uint64_t>(1000 + i * 700), 40 + (i % 12), 0.8f, 0.0);
        tl->add(BassSynth::EventKind::off, static_cast<std::uint64_t>(1400 + i * 700), 40 + (i % 12), 0.0f, 0.0);
    }
    e.commands().push(Command::bassSetPatch(patch.get()));
    e.commands().push(Command::bassSetPattern(pat.get()));
    e.commands().push(Command::bassSetTimeline(tl.get()));
    e.commands().push(Command::bassPlay());
    for (int i = 0; i < 8; ++i)
        e.commands().push(Command::bassNote(true, static_cast<std::uint8_t>(36 + i), 0.9f, 0, 2));
    REQUIRE(test::allocationsDuring(
                [&]
                {
                    for (int i = 0; i < 200; ++i)
                        e.process(outs, 2, 512);
                }) == 0);
    REQUIRE(e.snapshot().bassNotesFired > 8);
    e.commands().push(Command::bassSetPattern(pat.get())); // a live replace with sounding notes
    e.commands().push(Command::bassBend(2.0));
    e.commands().push(Command::bassClearTimeline());
    e.commands().push(Command::bassStop());
    e.commands().push(Command::bassPanic());
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
