// The mixer (Phase 4.1): strips summed in 64-bit through a free routing graph. Every assertion is numeric against the
// documented laws: a strip at unity is BIT-IDENTICAL to the direct path; the sum of N strips equals one double
// accumulator (not N float adds); the fader taper (-60 = silence, -6.02 = 0.5, +6 = 1.995) after the 8 ms tau
// settles; the mute / solo law; the Web Audio StereoPanner stereo law; M/S width; post-fader sends into returns; a
// strip -> bus -> master chain; the cycle guard; hardware-pair outputs; the bass and the click through their strips;
// block-size invariance for a static mix; the per-strip meters.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "TestSamples.h"
#include "terminator/core/Engine.h"
#include "terminator/core/Mixer.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr std::uint8_t kChannel = static_cast<std::uint8_t>(StripKind::channel);
constexpr std::uint8_t kSend = static_cast<std::uint8_t>(StripKind::send);
constexpr std::uint8_t kBus = static_cast<std::uint8_t>(StripKind::bus);
constexpr std::uint8_t kOff = static_cast<std::uint8_t>(StripKind::off);
constexpr std::uint8_t kOutMaster = static_cast<std::uint8_t>(StripOutput::master);
constexpr std::uint8_t kOutStrip = static_cast<std::uint8_t>(StripOutput::strip);
constexpr std::uint8_t kOutHardware = static_cast<std::uint8_t>(StripOutput::hardware);
constexpr std::uint8_t kOutNone = static_cast<std::uint8_t>(StripOutput::none);

struct Rig
{
    Engine engine;
    std::vector<std::vector<float>> data;
    std::vector<float*> ptrs;
    int block;
    int outs;
    double sr;
    std::vector<std::shared_ptr<SampleBuffer>> keep;
    Rig(int blockSize, int numOuts = 4, double sampleRate = 48000.0)
        : data(static_cast<std::size_t>(numOuts), std::vector<float>(static_cast<std::size_t>(blockSize), 0.0f)),
          block(blockSize), outs(numOuts), sr(sampleRate)
    {
        for (auto& c : data)
            ptrs.push_back(c.data());
        engine.prepare({sampleRate, blockSize, numOuts, 0});
    }
    void push(const Command& c) { REQUIRE(engine.commands().push(c)); }
    void run(int blocks = 1)
    {
        for (int i = 0; i < blocks; ++i)
            engine.process(ptrs.data(), outs, block);
    }
    /// Enough blocks for the 8 ms one-poles to settle far below float resolution (≈ 0.4 s = 50 tau).
    void settle() { run(static_cast<int>(0.4 * sr / block) + 1); }
    /// A DC pad: mono `level` (or stereo l/r) playing a 10 s region; strip -1 = the direct path.
    void bindPad(int pad, float l, float r, int strip, std::uint8_t outputPair = 0)
    {
        std::shared_ptr<SampleBuffer> s;
        if (l == r)
            s = test::dc(static_cast<std::int64_t>(sr * 10.0), l, sr, 1);
        else
        {
            s = std::make_shared<SampleBuffer>();
            s->allocate(2, static_cast<std::int64_t>(sr * 10.0), sr);
            for (std::int64_t i = 0; i < s->numFrames; ++i)
            {
                s->channel(0)[i] = l;
                s->channel(1)[i] = r;
            }
        }
        keep.push_back(s);
        PadParams p;
        p.pad = static_cast<std::uint16_t>(pad);
        p.attackSec = 0.0f;
        p.interpolation = Interpolation::linear;
        p.chokeGroup = -2;
        p.strip = static_cast<std::int16_t>(strip);
        p.outputPair = outputPair;
        push(Command::setPadParams(p));
        push(Command::setPadSample(static_cast<std::uint16_t>(pad), s.get()));
    }
    void hit(int pad) { push(Command::triggerPad(static_cast<std::uint16_t>(pad), 1.0f)); }
    void strip(int idx, std::uint8_t kind = kChannel) { push(Command::mixerSetStrip(idx, kind)); }
    float out(int ch, int i = 0) const { return data[static_cast<std::size_t>(ch)][static_cast<std::size_t>(i)]; }
    bool silent(int ch) const
    {
        for (float v : data[static_cast<std::size_t>(ch)])
            if (v != 0.0f)
                return false;
        return true;
    }
    float peak(int ch) const
    {
        float pk = 0.0f;
        for (float v : data[static_cast<std::size_t>(ch)])
            pk = std::max(pk, std::abs(v));
        return pk;
    }
};
} // namespace

TEST_CASE("mixer: the default topology is the master alone, a strip at unity is bit-identical to the direct path",
          "[mixer]")
{
    // direct: pad -> outputs[0/1] (Phase 3). strip: pad -> strip 1 (0 dB, centre) -> master (0 dB) -> outs 1/2
    Rig direct(128), mixed(128);
    const auto& s0 = direct.engine.snapshot();
    REQUIRE(s0.mixerActiveMask == 1u); // strip 0 = the master
    REQUIRE(s0.mixerMainOut == 0);
    REQUIRE(s0.mixerOrderValid == 1u);
    direct.bindPad(0, 0.3f, 0.3f, -1);
    mixed.strip(1);
    mixed.bindPad(0, 0.3f, 0.3f, 1);
    direct.run();
    mixed.run();
    REQUIRE(mixed.engine.snapshot().mixerActiveMask == 3u);
    direct.hit(0);
    mixed.hit(0);
    for (int b = 0; b < 20; ++b)
    {
        direct.run();
        mixed.run();
        for (int ch = 0; ch < 2; ++ch)
            for (int i = 0; i < 128; ++i)
                REQUIRE(mixed.out(ch, i) == direct.out(ch, i)); // bit-identical, every sample
        REQUIRE(mixed.out(0, 0) == 0.3f);
    }
    // a DEAD strip drops what is routed to it (nothing leaks to the outs)
    mixed.strip(1, kOff);
    mixed.run(3);
    REQUIRE(mixed.silent(0));
    REQUIRE(mixed.silent(1));
    REQUIRE(mixed.engine.snapshot().mixerActiveMask == 1u);
}

TEST_CASE("mixer: 64-bit summing - N strips into the master equal ONE double accumulator cast once", "[mixer]")
{
    Rig r(64);
    // eight levels that do not sum exactly in float (0.1 + 0.2 + ... in binary)
    const float levels[8] = {0.1f, 0.2f, 0.3f, 0.7f, 0.11f, 0.013f, 0.29f, 0.001f};
    double ref = 0.0;
    for (int i = 0; i < 8; ++i)
    {
        r.strip(i + 1);
        r.bindPad(i, levels[i], levels[i], i + 1);
        ref += static_cast<double>(levels[i]);
    }
    r.run();
    for (int i = 0; i < 8; ++i)
        r.hit(i);
    r.run(3);
    REQUIRE(r.out(0, 10) == static_cast<float>(ref));
    REQUIRE(r.out(1, 10) == static_cast<float>(ref));
    // the same eight on the DIRECT path accumulate in float — the reference tells them apart (documents the gain)
    float f = 0.0f;
    for (float v : levels)
        f += v;
    INFO("float accumulate " << f << " vs double " << static_cast<float>(ref));
    REQUIRE(std::abs(f - static_cast<float>(ref)) < 1e-6f); // they are CLOSE — the point is which one we chose
}

TEST_CASE("mixer: fader taper after the 8 ms tau settles (-60 = silence, -6.02 = 0.5, +6 = 1.995, 0 = 1 exactly)",
          "[mixer]")
{
    Rig r(64);
    r.strip(1);
    r.bindPad(0, 0.5f, 0.5f, 1);
    r.run();
    r.hit(0);
    r.run(2);
    REQUIRE(r.out(0, 5) == 0.5f);
    r.push(Command::mixerSetFader(1, -6.0206f));
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.25f).margin(2e-5f));
    REQUIRE(r.engine.snapshot().stripGain[1] == Approx(0.5f).margin(2e-5f));
    r.push(Command::mixerSetFader(1, 6.0f));
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.5f * 1.99526f).margin(2e-5f));
    r.push(Command::mixerSetFader(1, -60.0f));
    r.settle();
    REQUIRE(r.silent(0));
    REQUIRE(r.engine.snapshot().stripGain[1] == 0.0f);
    r.push(Command::mixerSetFader(1, -59.0f)); // just above the floor: audible (-59 dB)
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.5f * 0.0011220f).margin(1e-6f));
    // the MASTER fader scales the whole mix the same way
    r.push(Command::mixerSetFader(1, 0.0f));
    r.push(Command::mixerSetFader(0, -6.0206f));
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.25f).margin(2e-5f));
    // the ramp is a one-pole: 8 ms after a step it is 1/e of the way — check at tau (blocks of 64 at 48k: 6 blocks
    // = 384 samples = 8 ms)
    r.push(Command::mixerSetFader(0, 0.0f));
    r.settle();
    r.push(Command::mixerSetFader(1, -60.0f));
    r.run(6);
    const float g = r.engine.snapshot().stripGain[1];
    REQUIRE(g == Approx(std::exp(-1.0f)).margin(0.01f));
}

TEST_CASE("mixer: the mute / solo law - silent = muted || (anySolo && !soloed), over every non-master strip", "[mixer]")
{
    Rig r(64);
    r.strip(1);
    r.strip(2);
    r.strip(3, kSend);
    r.bindPad(0, 0.25f, 0.25f, 1);
    r.bindPad(1, 0.125f, 0.125f, 2);
    r.run();
    r.hit(0);
    r.hit(1);
    r.settle();
    REQUIRE(r.out(0, 5) == 0.375f);
    r.push(Command::mixerSetMute(1, true));
    r.settle();
    REQUIRE(r.out(0, 5) == 0.125f);
    REQUIRE(r.engine.snapshot().mixerSilentMask == (1ull << 1));
    r.push(Command::mixerSetMute(1, false));
    r.push(Command::mixerSetSolo(2, true)); // solo 2: 1 AND the return 3 go quiet
    r.settle();
    REQUIRE(r.out(0, 5) == 0.125f);
    REQUIRE(r.engine.snapshot().mixerSilentMask == ((1ull << 1) | (1ull << 3)));
    r.push(Command::mixerSetSolo(1, true)); // both soloed: both heard
    r.settle();
    REQUIRE(r.out(0, 5) == 0.375f);
    r.push(Command::mixerSetSolo(1, false));
    r.push(Command::mixerSetSolo(2, false));
    r.settle();
    REQUIRE(r.out(0, 5) == 0.375f);
    REQUIRE(r.engine.snapshot().mixerSilentMask == 0u);
    // the master mutes everything; the master has no solo
    r.push(Command::mixerSetMute(0, true));
    r.push(Command::mixerSetSolo(0, true));
    r.settle();
    REQUIRE(r.silent(0));
    REQUIRE(r.engine.mixer().settings(0).solo == 0);
    // the mute is a ramp, not a step: one block after the toggle the level is between the two
    r.push(Command::mixerSetMute(0, false));
    r.run(1);
    const float mid = r.out(0, 63);
    REQUIRE(mid > 0.0f);
    REQUIRE(mid < 0.375f);
}

TEST_CASE("mixer: pan = the Web Audio StereoPanner stereo law; pan 0 is the identity", "[mixer]")
{
    Rig r(64);
    r.strip(1);
    r.bindPad(0, 0.5f, 0.25f, 1); // a STEREO source: L 0.5, R 0.25
    r.run();
    r.hit(0);
    r.settle();
    REQUIRE(r.out(0, 5) == 0.5f);
    REQUIRE(r.out(1, 5) == 0.25f);
    r.push(Command::mixerSetPan(1, -1.0f)); // hard left: L' = L + R, R' = 0
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.75f).margin(1e-6f));
    REQUIRE(std::abs(r.out(1, 5)) < 1e-6f);
    r.push(Command::mixerSetPan(1, 1.0f)); // hard right: L' = 0, R' = R + L
    r.settle();
    REQUIRE(std::abs(r.out(0, 5)) < 1e-6f);
    REQUIRE(r.out(1, 5) == Approx(0.75f).margin(1e-6f));
    r.push(Command::mixerSetPan(1, 0.5f)); // x = 0.5: L' = L cos(pi/4), R' = R + L sin(pi/4)
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.5f * 0.70710678f).margin(1e-6f));
    REQUIRE(r.out(1, 5) == Approx(0.25f + 0.5f * 0.70710678f).margin(1e-6f));
    r.push(Command::mixerSetPan(1, -0.5f)); // x = 0.5: L' = L + R cos(pi/4), R' = R sin(pi/4)
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.5f + 0.25f * 0.70710678f).margin(1e-6f));
    REQUIRE(r.out(1, 5) == Approx(0.25f * 0.70710678f).margin(1e-6f));
    r.push(Command::mixerSetPan(1, 0.0f));
    r.settle();
    REQUIRE(r.out(0, 5) == 0.5f); // back to the identity, bit-exact
    REQUIRE(r.out(1, 5) == 0.25f);
    // the master has no pan
    r.push(Command::mixerSetPan(0, 1.0f));
    r.settle();
    REQUIRE(r.out(0, 5) == 0.5f);
}

TEST_CASE("mixer: M/S width - 0 folds to mono, 1 is the identity, 2 doubles the side", "[mixer]")
{
    Rig r(64);
    r.strip(1);
    r.bindPad(0, 0.5f, 0.25f, 1);
    r.run();
    r.hit(0);
    r.settle();
    r.push(Command::mixerSetWidth(1, 0.0f));
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.375f).margin(1e-6f));
    REQUIRE(r.out(1, 5) == Approx(0.375f).margin(1e-6f));
    r.push(Command::mixerSetWidth(1, 2.0f)); // M 0.375, S 0.125*2: L' 0.625, R' 0.125
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.625f).margin(1e-6f));
    REQUIRE(r.out(1, 5) == Approx(0.125f).margin(1e-6f));
    r.push(Command::mixerSetWidth(1, 1.0f));
    r.settle();
    REQUIRE(r.out(0, 5) == 0.5f);
    REQUIRE(r.out(1, 5) == 0.25f);
}

TEST_CASE("mixer: sends are post-fader/mute/pan taps into a return; a return's own fader scales them; the guard "
          "refuses a send to itself / the master / a loop",
          "[mixer]")
{
    Rig r(64);
    r.strip(1);
    r.strip(8, kSend);
    r.bindPad(0, 0.5f, 0.5f, 1);
    r.run();
    r.hit(0);
    r.push(Command::mixerSetOutput(1, kOutNone, 0)); // only through the send
    r.settle();
    REQUIRE(r.silent(0));
    r.push(Command::mixerSetSend(1, 0, 0.0f, 8));
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.5f).margin(1e-6f));
    r.push(Command::mixerSetSend(1, 0, -6.0206f, 8));
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.25f).margin(2e-5f));
    r.push(Command::mixerSetFader(8, -6.0206f)); // the return's fader
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.125f).margin(2e-5f));
    r.push(Command::mixerSetFader(8, 0.0f));
    r.push(Command::mixerSetFader(1, -6.0206f)); // post-fader: the source fader scales the send too
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.125f).margin(2e-5f));
    r.push(Command::mixerSetFader(1, 0.0f));
    r.push(Command::mixerSetMute(1, true)); // post-mute
    r.settle();
    REQUIRE(r.silent(0));
    r.push(Command::mixerSetMute(1, false));
    r.push(Command::mixerSetSend(1, 0, -60.0f, 8)); // off
    r.settle();
    REQUIRE(r.silent(0));
    // the guard
    const auto before = r.engine.snapshot().mixerRoutesRejected;
    r.push(Command::mixerSetSend(1, 1, 0.0f, 1)); // itself
    r.push(Command::mixerSetSend(1, 2, 0.0f, 0)); // the master through a send
    r.push(Command::mixerSetSend(8, 0, 0.0f, 1)); // the return back into its source: a loop
    r.run();
    REQUIRE(r.engine.snapshot().mixerRoutesRejected == before + 3);
    REQUIRE(r.engine.mixer().settings(1).sendTarget[1] == -1);
    REQUIRE(r.engine.mixer().settings(1).sendTarget[2] == -1);
    REQUIRE(r.engine.mixer().settings(8).sendTarget[0] == -1);
    REQUIRE(r.engine.snapshot().mixerOrderValid == 1u);
}

TEST_CASE("mixer: the free routing graph - strip -> bus -> master, the cycle guard, hardware pairs, none", "[mixer]")
{
    Rig r(64, 4);
    r.strip(1);
    r.strip(2, kBus);
    r.bindPad(0, 0.5f, 0.5f, 1);
    r.run();
    r.hit(0);
    r.push(Command::mixerSetOutput(1, kOutStrip, 2));
    r.push(Command::mixerSetFader(2, -6.0206f));
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.25f).margin(2e-5f)); // through the bus fader
    REQUIRE(r.engine.mixer().settings(1).outKind == StripOutput::strip);
    REQUIRE(r.engine.mixer().settings(1).outIndex == 2);
    // a loop: bus 2 -> strip 1 is refused, the bus still goes to the master
    const auto before = r.engine.snapshot().mixerRoutesRejected;
    r.push(Command::mixerSetOutput(2, kOutStrip, 1));
    r.push(Command::mixerSetOutput(2, kOutStrip, 2)); // itself
    r.push(Command::mixerSetOutput(0, kOutStrip, 1)); // the master to a strip
    r.run();
    REQUIRE(r.engine.snapshot().mixerRoutesRejected == before + 3);
    REQUIRE(r.engine.mixer().settings(2).outKind == StripOutput::master);
    REQUIRE(r.engine.snapshot().mixerOrderValid == 1u);
    REQUIRE(r.engine.mixer().reaches(1, 0));
    REQUIRE(r.engine.mixer().reaches(1, 2));
    REQUIRE_FALSE(r.engine.mixer().reaches(2, 1));
    // a chain of buses: 1 -> 2 -> 3 -> master, every bus at -6 dB
    r.strip(3, kBus);
    r.push(Command::mixerSetFader(3, -6.0206f));
    r.push(Command::mixerSetOutput(2, kOutStrip, 3));
    r.settle();
    REQUIRE(r.out(0, 5) == Approx(0.125f).margin(2e-5f));
    REQUIRE(r.engine.mixer().reaches(1, 3));
    // the strip to a hardware pair: outs 3/4 carry it post-fader, the master does not
    r.push(Command::mixerSetOutput(1, kOutHardware, 1));
    r.settle();
    REQUIRE(r.silent(0));
    REQUIRE(r.silent(1));
    REQUIRE(r.out(2, 5) == 0.5f);
    REQUIRE(r.out(3, 5) == 0.5f);
    // the master's own pair moves (mainOut 1): the mix lands on outs 3/4
    r.push(Command::mixerSetOutput(1, kOutMaster, 0));
    r.push(Command::mixerSetMainOut(1));
    r.settle();
    REQUIRE(r.silent(0));
    REQUIRE(r.out(2, 5) == 0.5f);
    REQUIRE(r.engine.snapshot().mixerMainOut == 1);
    r.push(Command::mixerSetMainOut(0));
    r.push(Command::mixerSetOutput(1, kOutNone, 0));
    r.settle();
    REQUIRE(r.silent(0));
    REQUIRE(r.silent(2));
    // the direct path is untouched by all of it: a pad with strip -1 on pair 1 still lands on outs 3/4
    r.bindPad(1, 0.125f, 0.125f, -1, 1);
    r.run();
    r.hit(1);
    r.run(2);
    REQUIRE(r.out(2, 5) == 0.125f);
}

TEST_CASE("mixer: the bass synth and the click ride their strips (setSourceStrip), the direct paths otherwise",
          "[mixer]")
{
    Rig r(64);
    r.strip(5);
    r.strip(6);
    // the click first (the bass synth's tail would otherwise sit under the exact-silence assertions): a count-in books
    // 4 clicks; through strip 6 at -60 dB nothing reaches the outs, at 0 dB it does
    r.push(Command::setSourceStrip(1, 6));
    r.push(Command::mixerSetFader(6, -60.0f));
    r.settle();
    r.push(Command::seqSetBpm(240.0));
    r.push(Command::countIn(4));
    const auto clicks0 = r.engine.snapshot().metronomeClicks;
    float pk = 0.0f;
    for (int b = 0; b < 64; ++b) // 4 beats at 240 = 1 s; 64 blocks of 64 cover the first click
    {
        r.run();
        pk = std::max(pk, r.peak(0));
    }
    REQUIRE(r.engine.snapshot().metronomeClicks > clicks0);
    REQUIRE(pk == 0.0f);
    REQUIRE(r.engine.snapshot().clickStrip == 6);
    REQUIRE(r.engine.snapshot().stripPeakPre[6][0] > 0.01f); // the click IS in the strip
    r.push(Command::cancelCountIn());
    r.push(Command::mixerSetFader(6, 0.0f));
    r.settle();
    r.push(Command::countIn(4));
    pk = 0.0f;
    for (int b = 0; b < 64; ++b)
    {
        r.run();
        pk = std::max(pk, r.peak(0));
    }
    REQUIRE(pk > 0.01f);
    r.push(Command::cancelCountIn());
    r.push(Command::setSourceStrip(1, -1));
    r.settle();
    REQUIRE(r.engine.snapshot().clickStrip == -1);
    // the bass: a held note, routed to strip 5 muted -> the outs are silent while strip 5 meters show it
    r.push(Command::setSourceStrip(0, 5));
    r.push(Command::mixerSetMute(5, true));
    r.push(Command::bassNote(true, 40, 1.0f));
    r.settle();
    REQUIRE(r.engine.snapshot().bassVoices > 0u);
    REQUIRE(r.engine.snapshot().bassStrip == 5);
    REQUIRE(r.engine.snapshot().stripPeakPre[5][0] > 0.01f);
    REQUIRE(r.silent(0));
    r.push(Command::mixerSetMute(5, false));
    r.settle();
    REQUIRE(r.peak(0) > 0.01f);
    r.push(Command::setSourceStrip(0, -1)); // back to the direct path: still heard, strip 5 goes quiet
    r.settle();
    REQUIRE(r.peak(0) > 0.01f);
    REQUIRE(r.engine.snapshot().stripPeakPre[5][0] == 0.0f);
    r.push(Command::bassNote(false, 40, 0.0f));
    r.push(Command::bassPanic());
}

TEST_CASE("mixer: a static mix is block-size invariant (64 vs 512) and the meters read the window", "[mixer]")
{
    auto build = [](Rig& r)
    {
        r.push(Command::mixerSetFader(1, -3.0f));
        r.push(Command::mixerSetPan(1, 0.3f));
        r.push(Command::mixerSetWidth(1, 1.5f));
        r.strip(1); // activated AFTER its settings: it starts AT the targets (no ramp) — the master stays at 0 dB
                    // (it is live from prepare, so a move there would ramp, and a ramp's intra-block shape is
                    // block-size dependent by design)
        r.bindPad(0, 0.5f, 0.25f, 1);
        r.run();
        r.hit(0);
    };
    Rig a(64), b(512);
    build(a);
    build(b);
    std::vector<float> ca, cb;
    for (int k = 0; k < 16; ++k)
    {
        a.run();
        ca.insert(ca.end(), a.data[0].begin(), a.data[0].end());
        ca.insert(ca.end(), a.data[1].begin(), a.data[1].end());
    }
    for (int k = 0; k < 2; ++k)
    {
        b.run();
        cb.insert(cb.end(), b.data[0].begin(), b.data[0].end());
        cb.insert(cb.end(), b.data[1].begin(), b.data[1].end());
    }
    // compare sample by sample (the captures interleave per block: rebuild per-channel streams)
    std::vector<float> aL, aR, bL, bR;
    for (int k = 0; k < 16; ++k)
        for (int i = 0; i < 64; ++i)
        {
            aL.push_back(ca[static_cast<std::size_t>(k * 128 + i)]);
            aR.push_back(ca[static_cast<std::size_t>(k * 128 + 64 + i)]);
        }
    for (int k = 0; k < 2; ++k)
        for (int i = 0; i < 512; ++i)
        {
            bL.push_back(cb[static_cast<std::size_t>(k * 1024 + i)]);
            bR.push_back(cb[static_cast<std::size_t>(k * 1024 + 512 + i)]);
        }
    for (std::size_t i = 0; i < 1024; ++i)
    {
        REQUIRE(aL[i] == bL[i]);
        REQUIRE(aR[i] == bR[i]);
    }
    REQUIRE(aL[100] != 0.0f);
    // meters: after a full 4096-sample window the strip reads the DC levels; the master reads the panned/faded mix
    a.run(80);
    const auto& s = a.engine.snapshot();
    REQUIRE(s.stripPeakPre[1][0] == Approx(0.5f).margin(1e-6f));
    REQUIRE(s.stripPeakPre[1][1] == Approx(0.25f).margin(1e-6f));
    REQUIRE(s.stripRmsPre[1] == Approx(std::sqrt((0.25f + 0.0625f) / 2.0f)).margin(1e-5f));
    REQUIRE(s.stripPeakPost[1][0] == Approx(a.out(0, 5)).margin(1e-6f)); // the master at unity: the same level
    REQUIRE(s.stripPeakPost[0][0] == Approx(a.out(0, 5)).margin(1e-6f));
    REQUIRE(s.stripGain[1] == Approx(0.7079458f).margin(1e-6f));
    // a dead strip reads zero
    REQUIRE(s.stripPeakPre[9][0] == 0.0f);
}
