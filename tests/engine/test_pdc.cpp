// PDC (Phase 4.4) - plugin-delay compensation: the page's two-tier plan (MixerEngine.pdcPlan / pdcChainDelaySec /
// pdcMasterShiftSec) in whole samples on the chain latencies the engine already reports. Tier 1 lines every CHANNEL
// up on the longest channel chain; tier 2 lines every SEND / BUS up on the longest bus chain and delays the
// channels' direct-to-master leg by the same amount, so a bus return sums with the dry channel beside it instead of
// comb-filtering against it. Gated on TIMING, not on a description: a transparent COMP (RATIO 1, MAKEUP 0) is an
// exact 288-sample look-ahead delay at 48 kHz, so two strips that should be aligned must put their impulses on ONE
// sample, and with PDC off they must land 288 apart. Plus the plan read-back through the snapshot and the IntDelay
// line itself.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "TestSamples.h"
#include "terminator/core/Engine.h"
#include "terminator/core/Mixer.h"
#include "terminator/core/fx/FxDsp.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr std::uint8_t kChannel = static_cast<std::uint8_t>(StripKind::channel);
constexpr std::uint8_t kSend = static_cast<std::uint8_t>(StripKind::send);
constexpr std::uint8_t kBus = static_cast<std::uint8_t>(StripKind::bus);
constexpr std::uint8_t kOutStrip = static_cast<std::uint8_t>(StripOutput::strip);
constexpr int kCompLatency = 288; // the 6 ms look-ahead at 48 kHz (DynamicsFx, gated in test_fx_devices)
constexpr int kSatLatency = 55;   // the 4x oversampler's two halfbands (ShaperFx)

/// An Engine at 48 k / block 64 with 2 outs, a tape of everything the master put out, and impulse pads.
struct Rig
{
    Engine engine;
    std::vector<float> a, b;
    std::vector<float*> ptrs;
    std::vector<float> tapeL, tapeR;
    std::vector<std::shared_ptr<SampleBuffer>> keep;
    static constexpr int kBlock = 64;
    Rig() : a(kBlock, 0.0f), b(kBlock, 0.0f)
    {
        ptrs = {a.data(), b.data()};
        engine.prepare({48000.0, kBlock, 2, 0});
    }
    void push(const Command& c) { REQUIRE(engine.commands().push(c)); }
    void strip(int idx, std::uint8_t kind = kChannel) { push(Command::mixerSetStrip(idx, kind)); }
    void routeTo(int idx, int target) { push(Command::mixerSetOutput(idx, kOutStrip, target)); }
    /// A transparent COMP on `idx`: RATIO 1 and MAKEUP 0 make it a pure 288-sample look-ahead delay.
    void transparentComp(int idx)
    {
        push(Command::mixerAddFx(idx, static_cast<std::uint8_t>(FxType::comp)));
        push(Command::mixerSetFxParam(idx, 0, 1, 0.0f, true)); // THRESHOLD 0 dBFS
        push(Command::mixerSetFxParam(idx, 0, 2, 1.0f, true)); // RATIO 1:1
        push(Command::mixerSetFxParam(idx, 0, 5, 0.0f, true)); // MAKEUP 0 dB
    }
    /// A one-sample impulse pad on `pad`, routed to `strip`.
    void impulsePad(int pad, int strip, float amp)
    {
        auto s = std::make_shared<SampleBuffer>();
        s->allocate(1, 4096, 48000.0);
        for (std::int64_t i = 0; i < s->numFrames; ++i)
            s->channel(0)[i] = 0.0f;
        s->channel(0)[0] = amp;
        keep.push_back(s);
        PadParams p;
        p.pad = static_cast<std::uint16_t>(pad);
        p.attackSec = 0.0f;
        p.interpolation = Interpolation::linear;
        p.chokeGroup = -2;
        p.strip = static_cast<std::int16_t>(strip);
        push(Command::setPadParams(p));
        push(Command::setPadSample(static_cast<std::uint16_t>(pad), s.get()));
    }
    void run(int blocks = 1)
    {
        for (int i = 0; i < blocks; ++i)
        {
            engine.process(ptrs.data(), 2, kBlock);
            for (int k = 0; k < kBlock; ++k)
            {
                tapeL.push_back(a[static_cast<std::size_t>(k)]);
                tapeR.push_back(b[static_cast<std::size_t>(k)]);
            }
        }
    }
    void clearTape()
    {
        tapeL.clear();
        tapeR.clear();
    }
    /// Every sample of the tape above `floorAmp`, as (index, value) - the impulses that came out.
    std::vector<std::pair<int, float>> hits(float floorAmp = 1.0e-4f) const
    {
        std::vector<std::pair<int, float>> h;
        for (std::size_t i = 0; i < tapeL.size(); ++i)
            if (std::abs(tapeL[i]) > floorAmp)
                h.emplace_back(static_cast<int>(i), tapeL[i]);
        return h;
    }
};
} // namespace

TEST_CASE("pdc: an empty mix has no plan and every strip is untouched", "[pdc]")
{
    Rig r;
    r.strip(1);
    r.strip(2);
    r.strip(8, kSend);
    r.run(2);
    const auto& s = r.engine.snapshot();
    REQUIRE(s.mixerPdcOn == 1); // the page's default
    REQUIRE(s.mixerPdcMaxChan == 0);
    REQUIRE(s.mixerPdcToMaster == 0);
    for (int i = 0; i < kMaxStrips; ++i)
        REQUIRE(s.stripPdc[i] == 0);
}

TEST_CASE("pdc: the two-tier plan follows the chain latencies, the bypass and the switch", "[pdc]")
{
    Rig r;
    r.strip(1);
    r.strip(2);
    r.strip(8, kSend);
    r.run(2);

    // tier 1: a COMP on channel 1 makes 288 the channel target - channel 2 catches up, channel 1 does not move
    r.transparentComp(1);
    r.run(2);
    {
        const auto& s = r.engine.snapshot();
        REQUIRE(s.mixerPdcMaxChan == kCompLatency);
        REQUIRE(s.mixerPdcToMaster == 0);
        REQUIRE(s.stripPdc[1] == 0);
        REQUIRE(s.stripPdc[2] == kCompLatency);
        REQUIRE(s.stripPdc[8] == 0);
    }

    // tier 2: a SAT on the send makes 55 the bus target - the channels' direct leg to the master carries it
    r.push(Command::mixerAddFx(8, static_cast<std::uint8_t>(FxType::sat)));
    r.run(2);
    {
        const auto& s = r.engine.snapshot();
        REQUIRE(s.mixerPdcMaxChan == kCompLatency);
        REQUIRE(s.mixerPdcToMaster == kSatLatency);
        REQUIRE(s.stripPdc[8] == 0); // it IS the longest bus
    }

    // a second send with no latency catches up to the longest bus
    r.strip(9, kSend);
    r.run(2);
    REQUIRE(r.engine.snapshot().stripPdc[9] == kSatLatency);

    // bypassing the COMP takes its latency out of the plan
    r.push(Command::mixerSetFxBypass(1, 0, true));
    r.run(2);
    {
        const auto& s = r.engine.snapshot();
        REQUIRE(s.mixerPdcMaxChan == 0);
        REQUIRE(s.stripPdc[2] == 0);
    }
    r.push(Command::mixerSetFxBypass(1, 0, false));
    r.run(2);
    REQUIRE(r.engine.snapshot().stripPdc[2] == kCompLatency);

    // the switch: OFF reports the plan as flat (nothing is delayed), ON brings it back
    r.push(Command::mixerSetPdc(false));
    r.run(2);
    {
        const auto& s = r.engine.snapshot();
        REQUIRE(s.mixerPdcOn == 0);
        REQUIRE(s.mixerPdcMaxChan == 0);
        REQUIRE(s.mixerPdcToMaster == 0);
        REQUIRE(s.stripPdc[2] == 0);
    }
    r.push(Command::mixerSetPdc(true));
    r.run(2);
    {
        const auto& s = r.engine.snapshot();
        REQUIRE(s.mixerPdcOn == 1);
        REQUIRE(s.stripPdc[2] == kCompLatency);
    }

    // clearing the chain empties the plan
    r.push(Command::mixerClearFx(1));
    r.push(Command::mixerClearFx(8));
    r.run(2);
    {
        const auto& s = r.engine.snapshot();
        REQUIRE(s.mixerPdcMaxChan == 0);
        REQUIRE(s.mixerPdcToMaster == 0);
    }
}

TEST_CASE("pdc: tier 1 - a COMP on one channel no longer plays the others early", "[pdc]")
{
    // Two identical mixes, one with PDC on and one with it off, driven with the SAME commands block for block - so
    // the COMP sees the same history in both and its own level is out of the question. Channel 1 carries a COMP
    // (288 samples of look-ahead), channel 2 is clean; both hit the master.
    Rig on, off;
    for (Rig* r : {&on, &off})
    {
        r->strip(1);
        r->strip(2);
        r->transparentComp(1);
        r->impulsePad(0, 1, 0.5f);
        r->impulsePad(1, 2, 0.25f);
    }
    off.push(Command::mixerSetPdc(false));
    for (Rig* r : {&on, &off})
    {
        r->run(20); // let the chain settle before the tape starts
        r->clearTape();
        r->push(Command::triggerPad(0, 1.0f));
        r->push(Command::triggerPad(1, 1.0f));
        r->run(16); // 1024 samples
    }

    const auto h = on.hits();
    INFO("aligned hits: " << h.size() << (h.empty() ? "" : " first at ") << (h.empty() ? 0 : h[0].first));
    REQUIRE(h.size() == 1);              // ONE impulse: the two channels land on the same sample
    REQUIRE(h[0].first == kCompLatency); // …the longest channel chain

    // with PDC off the same two impulses come back 288 apart - and they sum to exactly what the aligned one carried,
    // so the alignment moved signal in time and nowhere else
    const auto apart = off.hits();
    REQUIRE(apart.size() == 2);
    REQUIRE(apart[0].first == 0);            // the clean channel, early
    REQUIRE(apart[0].second == 0.25f);       // …and untouched: no chain, no delay, bit-exact
    REQUIRE(apart[1].first == kCompLatency); // the COMP channel
    REQUIRE(apart[0].second + apart[1].second == Approx(h[0].second).margin(1.0e-6));
}

TEST_CASE("pdc off: the clean channel plays 288 samples early", "[pdc]")
{
    Rig r;
    r.strip(1);
    r.strip(2);
    r.transparentComp(1);
    r.impulsePad(0, 1, 0.5f);
    r.impulsePad(1, 2, 0.25f);
    r.push(Command::mixerSetPdc(false));
    r.run(20);
    r.clearTape();
    r.push(Command::triggerPad(0, 1.0f));
    r.push(Command::triggerPad(1, 1.0f));
    r.run(16);

    const auto h = r.hits();
    REQUIRE(h.size() == 2);              // two impulses, 288 apart
    REQUIRE(h[0].first == 0);            // the clean channel, early
    REQUIRE(h[0].second == 0.25f);       // …and bit-exact: PDC off leaves a chainless strip untouched
    REQUIRE(h[1].first == kCompLatency); // the COMP channel
    REQUIRE(h[1].second > 0.1f);
}

TEST_CASE("pdc: tier 2 - a bus return sums with the dry channel beside it", "[pdc]")
{
    // channel 1 -> master, dry. channel 2 -> bus 9 (a COMP) -> master. Both channels are clean, so the only latency
    // in the mix is the BUS's: PDC must delay channel 1's direct leg by it instead of letting the return come back
    // 288 samples late against it (the comb filter PDC exists to stop). Same two-rig method as tier 1.
    Rig on, off;
    for (Rig* r : {&on, &off})
    {
        r->strip(1);
        r->strip(2);
        r->strip(9, kBus);
        r->routeTo(2, 9);
        r->transparentComp(9);
        r->impulsePad(0, 1, 0.5f);
        r->impulsePad(1, 2, 0.25f);
    }
    off.push(Command::mixerSetPdc(false));
    for (Rig* r : {&on, &off})
    {
        r->run(20);
        r->clearTape();
        r->push(Command::triggerPad(0, 1.0f));
        r->push(Command::triggerPad(1, 1.0f));
        r->run(16);
    }
    {
        const auto& s = on.engine.snapshot();
        REQUIRE(s.mixerPdcMaxChan == 0);             // no channel carries latency…
        REQUIRE(s.mixerPdcToMaster == kCompLatency); // …the BUS does, and the direct leg carries it
        REQUIRE(s.stripPdc[9] == 0);                 // the bus IS the longest bus
        REQUIRE(off.engine.snapshot().mixerPdcToMaster == 0);
    }

    const auto h = on.hits();
    INFO("aligned hits: " << h.size());
    REQUIRE(h.size() == 1); // the dry channel and the bus return on ONE sample
    REQUIRE(h[0].first == kCompLatency);

    const auto apart = off.hits();
    REQUIRE(apart.size() == 2);
    REQUIRE(apart[0].first == 0);
    REQUIRE(apart[0].second == 0.5f); // the dry channel, untouched
    REQUIRE(apart[1].first == kCompLatency);
    REQUIRE(apart[0].second + apart[1].second == Approx(h[0].second).margin(1.0e-6));
}

TEST_CASE("pdc: a mix with no latency anywhere is bit-identical with PDC on and off", "[pdc]")
{
    Rig on, off;
    for (Rig* r : {&on, &off})
    {
        r->strip(1);
        r->strip(2);
        r->impulsePad(0, 1, 0.5f);
        r->impulsePad(1, 2, 0.25f);
    }
    off.push(Command::mixerSetPdc(false));
    on.run(4);
    off.run(4);
    on.push(Command::triggerPad(0, 1.0f));
    on.push(Command::triggerPad(1, 1.0f));
    off.push(Command::triggerPad(0, 1.0f));
    off.push(Command::triggerPad(1, 1.0f));
    on.run(8);
    off.run(8);
    REQUIRE(on.tapeL.size() == off.tapeL.size());
    for (std::size_t i = 0; i < on.tapeL.size(); ++i)
        REQUIRE(on.tapeL[i] == off.tapeL[i]);
}

TEST_CASE("pdc: IntDelay is an exact integer shift and a true pass-through at 0", "[pdc]")
{
    IntDelay d;
    d.prepare(512, 64);
    REQUIRE(d.maxDelay() == 512);

    // delay 0: the samples come back untouched, bit for bit
    {
        std::vector<double> x(64);
        for (int i = 0; i < 64; ++i)
            x[static_cast<std::size_t>(i)] = 0.001 * static_cast<double>(i) + 0.5;
        std::vector<double> want = x;
        d.process(x.data(), 64, 0);
        for (int i = 0; i < 64; ++i)
            REQUIRE(x[static_cast<std::size_t>(i)] == want[static_cast<std::size_t>(i)]);
    }

    // an impulse through a delay of 100 comes out exactly 100 samples later, across block boundaries
    d.reset();
    {
        std::vector<double> tape;
        for (int b = 0; b < 8; ++b)
        {
            std::vector<double> x(64, 0.0);
            if (b == 0)
                x[0] = 1.0;
            d.process(x.data(), 64, 100);
            tape.insert(tape.end(), x.begin(), x.end());
        }
        for (std::size_t i = 0; i < tape.size(); ++i)
            REQUIRE(tape[i] == (i == 100 ? 1.0 : 0.0));
    }

    // the delay is clamped to maxDelay, never read out of range
    d.reset();
    {
        std::vector<double> x(64, 1.0);
        d.process(x.data(), 64, 10000);
        for (double v : x)
            REQUIRE(v == 0.0); // 512 samples of silence still in the ring
    }
}
