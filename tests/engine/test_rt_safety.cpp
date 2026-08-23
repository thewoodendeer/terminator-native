// The RT gate. Under the mac-rtsan preset Engine::process is [[clang::nonblocking]] and any malloc/lock/
// syscall inside it aborts the process (RTSan) — so these tests "pass" by not dying. On every compiler the
// allocation counter additionally proves zero heap allocations on the callback path.
#include <catch2/catch_test_macros.hpp>

#include <memory>
#include <vector>

#include "AllocationCounter.h"
#include "TestSamples.h"
#include "terminator/core/Engine.h"
#include "terminator/core/Mixer.h"

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

TEST_CASE("RT: the MIDI clock OUT on the callback allocates nothing (enable, play, tempo change, pause/resume, stop)",
          "[rt]")
{
    Engine e;
    e.prepare({48000.0, 64, 2});
    std::vector<float> l(64), r(64);
    float* outs[2] = {l.data(), r.data()};
    e.commands().push(Command::midiClockEnable(true));
    e.commands().push(Command::seqSetBpm(240.0));
    e.commands().push(Command::seqPlay(0));
    REQUIRE(test::allocationsDuring(
                [&]
                {
                    for (int i = 0; i < 400; ++i)
                    {
                        if (i == 100)
                            e.commands().push(Command::seqSetBpm(90.0));
                        if (i == 200)
                            e.commands().push(Command::seqPause());
                        if (i == 250)
                            e.commands().push(Command::seqResume());
                        if (i == 350)
                            e.commands().push(Command::seqStop());
                        e.process(nullptr, 0, outs, 2, 64,
                                  1'000'000'000ull + static_cast<std::uint64_t>(i) * 1'333'333ull);
                    }
                }) == 0);
    REQUIRE(e.snapshot().midiClockTicks > 0);
    REQUIRE(e.snapshot().midiClockRunning == 0);
    MidiOutEvent oe;
    int n = 0;
    while (e.midiOut().pop(oe))
        ++n;
    REQUIRE(n > 0);
}

TEST_CASE("RT: the metronome + count-in + arp on the callback allocate nothing (enable, play, count-in, hold, tempo "
          "change, release, stop)",
          "[rt]")
{
    Engine e;
    e.prepare({48000.0, 64, 2});
    std::vector<float> l(64), r(64);
    float* outs[2] = {l.data(), r.data()};
    auto pat = std::make_shared<SeqPattern>();
    pat->clear();
    pat->bars = 1;
    pat->resolution = 16;
    pat->stepCount = 16;
    for (int s = 0; s < 16; ++s)
        pat->grid[s] |= 1ull << (s % 4);
    e.commands().push(Command::seqSetBpm(240.0));
    e.commands().push(Command::seqSetPattern(pat.get()));
    e.commands().push(Command::setMetronome(true, 4)); // the clap (3 elements per click)
    e.commands().push(Command::countIn(4, 0));
    e.commands().push(Command::setArp(true, 8, false, true, 16));
    e.commands().push(Command::arpHold(2, 0.9f, 0));
    REQUIRE(test::allocationsDuring(
                [&]
                {
                    for (int i = 0; i < 1200; ++i)
                    {
                        if (i == 100)
                            e.commands().push(Command::seqPlay(0));
                        if (i == 300)
                            e.commands().push(Command::seqSetBpm(90.0));
                        if (i == 400)
                            e.commands().push(Command::setMetronome(true, 3));
                        if (i == 500)
                            e.commands().push(Command::arpRelease(2));
                        if (i == 600)
                            e.commands().push(Command::drumPlay(0, 0));
                        if (i == 700)
                            e.commands().push(Command::seqPause());
                        if (i == 800)
                            e.commands().push(Command::seqResume());
                        if (i == 900)
                            e.commands().push(Command::countIn(2, 0));
                        if (i == 950)
                            e.commands().push(Command::cancelCountIn());
                        if (i == 1000)
                            e.commands().push(Command::seqStop());
                        if (i == 1100)
                            e.commands().push(Command::panic());
                        e.process(outs, 2, 64);
                    }
                }) == 0);
    REQUIRE(e.snapshot().metronomeClicks > 4);
    REQUIRE(e.snapshot().arpHits > 4);
}

TEST_CASE("RT: the mixer on the callback allocates nothing (strips, routing, sends, pads + the bass + the click "
          "through strips, meters)",
          "[rt]")
{
    Engine e;
    e.prepare({48000.0, 512, 4});
    std::vector<float> o0(512), o1(512), o2(512), o3(512);
    float* outs[4] = {o0.data(), o1.data(), o2.data(), o3.data()};
    auto s = test::dc(48000, 0.5f);
    PadParams p;
    p.pad = 0;
    p.attackSec = 0.0f;
    p.strip = 1;
    e.commands().push(Command::setPadParams(p));
    e.commands().push(Command::setPadSample(0, s.get()));
    for (int i = 1; i <= 8; ++i)
        e.commands().push(Command::mixerSetStrip(i, static_cast<std::uint8_t>(i <= 4   ? StripKind::channel
                                                                              : i <= 6 ? StripKind::send
                                                                                       : StripKind::bus)));
    e.commands().push(Command::mixerSetOutput(1, static_cast<std::uint8_t>(StripOutput::strip), 7));
    e.commands().push(Command::mixerSetOutput(7, static_cast<std::uint8_t>(StripOutput::strip), 8));
    e.commands().push(Command::mixerSetSend(1, 0, -6.0f, 5));
    e.commands().push(Command::mixerSetSend(2, 1, 0.0f, 6));
    e.commands().push(Command::mixerSetOutput(3, static_cast<std::uint8_t>(StripOutput::hardware), 1));
    e.commands().push(Command::mixerSetOutput(8, static_cast<std::uint8_t>(StripOutput::strip), 1)); // a loop (refused)
    e.commands().push(Command::mixerSetMainOut(0));
    e.commands().push(Command::setSourceStrip(0, 2));
    e.commands().push(Command::setSourceStrip(1, 3));
    e.commands().push(Command::bassNote(true, 40, 1.0f));
    e.commands().push(Command::seqSetBpm(240.0));
    e.commands().push(Command::countIn(4));
    e.commands().push(Command::triggerPad(0, 1.0f));
    // the insert chain (4.2): devices come from the pre-built pool — add / param / bypass / reorder / remove on the
    // callback allocate nothing
    e.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::eq)));
    e.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::filter)));
    e.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::utility)));
    e.commands().push(Command::mixerAddFx(2, static_cast<std::uint8_t>(FxType::pan)));
    e.commands().push(Command::mixerAddFx(3, static_cast<std::uint8_t>(FxType::mseq)));
    e.commands().push(Command::mixerAddFx(7, static_cast<std::uint8_t>(FxType::wide)));
    REQUIRE(test::allocationsDuring(
                [&]
                {
                    for (int i = 0; i < 50; ++i)
                    {
                        if (i == 10)
                        {
                            e.commands().push(Command::mixerSetFxParam(1, 0, 0, 6.0f));
                            e.commands().push(Command::mixerSetFxParam(1, 1, 1, 800.0f));
                            e.commands().push(Command::mixerSetFxParam(1, 2, 1, 1.0f, true));
                            e.commands().push(Command::mixerSetFxBypass(1, 1, true));
                            e.commands().push(Command::mixerReorderFx(1, 2, 0));
                            e.commands().push(Command::mixerRemoveFx(1, 1));
                            e.commands().push(Command::mixerAddFx(1, static_cast<std::uint8_t>(FxType::wide)));
                            e.commands().push(Command::mixerClearFx(3));
                            e.commands().push(Command::mixerSetFader(1, -12.0f));
                            e.commands().push(Command::mixerSetPan(1, 0.5f));
                            e.commands().push(Command::mixerSetWidth(7, 0.5f));
                            e.commands().push(Command::mixerSetMute(2, true));
                            e.commands().push(Command::mixerSetSolo(3, true));
                            e.commands().push(Command::mixerSetStrip(4, static_cast<std::uint8_t>(StripKind::off)));
                        }
                        e.process(outs, 4, 512);
                    }
                }) == 0);
    REQUIRE(e.snapshot().mixerRoutesRejected == 1u);
    REQUIRE(e.snapshot().mixerOrderValid == 1u);
    REQUIRE(e.snapshot().stripFxCount[1] == 3);
    REQUIRE(e.snapshot().mixerFxRejected == 0u);
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
