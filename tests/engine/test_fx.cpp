// The insert chain + the zero-latency devices (Phase 4.2a): UTILITY / EQ / FILTER / WIDE / M/S EQ / PAN ported from
// the page's FX (same param ids / ranges / defaults; the Web Audio BiquadFilterNode maths). Every assertion is a
// number the Web Audio spec fixes: a 0 dB EQ is a bit-exact pass-through, the RBJ shelf sits at its gain at DC, the
// peaking band at its gain on its centre, the Web Audio lowpass with Q 1 dB peaks +1 dB at the cutoff and falls
// 40 dB a decade up, the notch kills its centre; the chain: bypass = dry bit-exact, add / remove / reorder / clear,
// the 8-slot cap, the pool cap, WET-less devices are fully wet.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

#include "TestSamples.h"
#include "terminator/core/Engine.h"
#include "terminator/core/Mixer.h"
#include "terminator/core/fx/BasicFx.h"
#include "terminator/core/fx/FxPool.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double kSr = 48000.0;
constexpr int kBlock = 256;

/// Steady-state level (dB) of a sine at `hz` through `e` after `settleSec` (the last 0.25 s RMS vs the input RMS).
double responseDb(Effect& e, double hz, double settleSec = 0.5, bool antiphase = false)
{
    const int total = static_cast<int>(kSr * (settleSec + 0.25));
    const int tail = static_cast<int>(kSr * 0.25);
    std::vector<double> l(kBlock), r(kBlock);
    double sumIn = 0.0, sumOut = 0.0;
    int done = 0;
    while (done < total)
    {
        const int n = std::min(kBlock, total - done);
        for (int i = 0; i < n; ++i)
        {
            const double x = 0.5 * std::sin(6.283185307179586 * hz * static_cast<double>(done + i) / kSr);
            l[static_cast<std::size_t>(i)] = x;
            r[static_cast<std::size_t>(i)] = antiphase ? -x : x;
            if (done + i >= total - tail)
                sumIn += x * x;
        }
        e.process(l.data(), r.data(), n);
        for (int i = 0; i < n; ++i)
            if (done + i >= total - tail)
                sumOut += l[static_cast<std::size_t>(i)] * l[static_cast<std::size_t>(i)];
        done += n;
    }
    return 10.0 * std::log10(sumOut / sumIn);
}

struct Rig
{
    Engine engine;
    std::vector<std::vector<float>> data;
    std::vector<float*> ptrs;
    int block;
    std::vector<std::shared_ptr<SampleBuffer>> keep;
    explicit Rig(int blockSize = 64)
        : data(2, std::vector<float>(static_cast<std::size_t>(blockSize), 0.0f)), block(blockSize)
    {
        for (auto& c : data)
            ptrs.push_back(c.data());
        engine.prepare({kSr, blockSize, 2, 0});
        engine.commands().push(Command::mixerSetStrip(1, static_cast<std::uint8_t>(StripKind::channel)));
    }
    void push(const Command& c) { REQUIRE(engine.commands().push(c)); }
    void run(int blocks = 1)
    {
        for (int i = 0; i < blocks; ++i)
            engine.process(ptrs.data(), 2, block);
    }
    void settle() { run(static_cast<int>(0.4 * kSr / block) + 1); }
    void dcPad(float l, float r)
    {
        auto s = std::make_shared<SampleBuffer>();
        s->allocate(2, static_cast<std::int64_t>(kSr * 10.0), kSr);
        for (std::int64_t i = 0; i < s->numFrames; ++i)
        {
            s->channel(0)[i] = l;
            s->channel(1)[i] = r;
        }
        keep.push_back(s);
        PadParams p;
        p.pad = 0;
        p.attackSec = 0.0f;
        p.interpolation = Interpolation::linear;
        p.chokeGroup = -2;
        p.strip = 1;
        push(Command::setPadParams(p));
        push(Command::setPadSample(0, s.get()));
        run();
        push(Command::triggerPad(0, 1.0f));
        run(2);
    }
    float out(int ch, int i = 5) const { return data[static_cast<std::size_t>(ch)][static_cast<std::size_t>(i)]; }
    static std::uint8_t id(FxType t) { return static_cast<std::uint8_t>(t); }
};
} // namespace

TEST_CASE("fx: the type table — the page's ids, keys, ranges, defaults, enum options", "[fx]")
{
    REQUIRE(fxTypeFromId("utility") == FxType::utility);
    REQUIRE(fxTypeFromId("eq") == FxType::eq);
    REQUIRE(fxTypeFromId("filter") == FxType::filter);
    REQUIRE(fxTypeFromId("wide") == FxType::wide);
    REQUIRE(fxTypeFromId("mseq") == FxType::mseq);
    REQUIRE(fxTypeFromId("pan") == FxType::pan);
    REQUIRE(fxTypeFromId("nope") == FxType::none);
    REQUIRE(fxParamIndex(FxType::utility, "GAIN") == 0);
    REQUIRE(fxParamIndex(FxType::utility, "MODE") == 1);
    REQUIRE(fxParamIndex(FxType::utility, "PHASE") == 2);
    REQUIRE(fxParamIndex(FxType::utility, "WET") == -1);
    REQUIRE(fxOptionIndex(FxType::utility, 1, "MONO-R") == 3);
    REQUIRE(fxOptionIndex(FxType::utility, 2, "inverted") == 1);
    REQUIRE(fxOptionIndex(FxType::utility, 0, "x") == -1);
    REQUIRE(fxOptionIndex(FxType::filter, 0, "notch") == 3);
    const auto& f = fxTypeInfo(FxType::filter);
    REQUIRE(f.numParams == 3);
    REQUIRE(f.params[1].def == 20000.0f);
    REQUIRE(f.params[2].def == 1.0f);
    REQUIRE(fxTypeInfo(FxType::mseq).params[2].def == 4000.0f);
    REQUIRE(fxTypeInfo(FxType::pan).params[1].def == 50.0f);
    REQUIRE(fxTypeInfo(FxType::eq).wetParam == -1);
    // unported types have no params yet (the pool refuses them)
    REQUIRE(fxTypeInfo(FxType::reverb).numParams == 0);
}

TEST_CASE("fx: UTILITY — gain, mono folds, phase", "[fx]")
{
    UtilityFx u;
    u.prepare(kSr, kBlock);
    std::vector<double> l(kBlock, 0.5), r(kBlock, 0.25);
    u.process(l.data(), r.data(), kBlock);
    REQUIRE(l[10] == 0.5); // defaults = identity, bit-exact
    REQUIRE(r[10] == 0.25);
    u.setParam(0, -6.0206f, true);
    std::fill(l.begin(), l.end(), 0.5);
    std::fill(r.begin(), r.end(), 0.25);
    u.process(l.data(), r.data(), kBlock);
    REQUIRE(l[10] == Approx(0.25).margin(1e-6));
    REQUIRE(r[10] == Approx(0.125).margin(1e-6));
    u.setParam(0, 0.0f, true);
    u.setParam(1, 1.0f, true); // MONO
    std::fill(l.begin(), l.end(), 0.5);
    std::fill(r.begin(), r.end(), 0.25);
    u.process(l.data(), r.data(), kBlock);
    REQUIRE(l[10] == Approx(0.375).margin(1e-12));
    REQUIRE(r[10] == Approx(0.375).margin(1e-12));
    u.setParam(1, 2.0f, true); // MONO-L
    std::fill(l.begin(), l.end(), 0.5);
    std::fill(r.begin(), r.end(), 0.25);
    u.process(l.data(), r.data(), kBlock);
    REQUIRE(r[10] == 0.5);
    u.setParam(1, 3.0f, true); // MONO-R
    std::fill(l.begin(), l.end(), 0.5);
    std::fill(r.begin(), r.end(), 0.25);
    u.process(l.data(), r.data(), kBlock);
    REQUIRE(l[10] == 0.25);
    u.setParam(1, 0.0f, true);
    u.setParam(2, 1.0f, true); // inverted
    std::fill(l.begin(), l.end(), 0.5);
    std::fill(r.begin(), r.end(), 0.25);
    u.process(l.data(), r.data(), kBlock);
    REQUIRE(l[10] == -0.5);
    REQUIRE(r[10] == -0.25);
    // the glide: a gain step takes 10 ms tau — after 1 block (256 = 5.3 ms) it is part way
    u.setParam(2, 0.0f, true);
    u.setParam(0, -20.0f, false);
    std::fill(l.begin(), l.end(), 0.5);
    std::fill(r.begin(), r.end(), 0.25);
    u.process(l.data(), r.data(), kBlock);
    REQUIRE(l[255] < 0.5);
    REQUIRE(l[255] > 0.05);
    REQUIRE(u.param(0) == Approx(-20.0f).margin(1e-4f));
}

TEST_CASE("fx: EQ — 0 dB is a bit-exact pass-through; the shelves sit at their gain at the band edges, the bell on "
          "its centre",
          "[fx]")
{
    EqFx e;
    e.prepare(kSr, kBlock);
    std::vector<double> l(kBlock), r(kBlock);
    for (int i = 0; i < kBlock; ++i)
        l[static_cast<std::size_t>(i)] = r[static_cast<std::size_t>(i)] = std::sin(0.01 * i) * 0.7;
    std::vector<double> ref = l;
    e.process(l.data(), r.data(), kBlock);
    for (int i = 0; i < kBlock; ++i)
        REQUIRE(l[static_cast<std::size_t>(i)] == ref[static_cast<std::size_t>(i)]);
    e.setParam(0, 12.0f, true); // LOW +12 at 80 Hz shelf: +12 well below, ~0 well above
    REQUIRE(responseDb(e, 10.0) == Approx(12.0).margin(0.2));
    REQUIRE(responseDb(e, 8000.0) == Approx(0.0).margin(0.1));
    e.setParam(0, 0.0f, true);
    e.setParam(1, 6.0f, true); // MID +6 bell at 1 kHz Q 0.8
    REQUIRE(responseDb(e, 1000.0) == Approx(6.0).margin(0.1));
    REQUIRE(responseDb(e, 50.0) == Approx(0.0).margin(0.2));
    e.setParam(1, 0.0f, true);
    e.setParam(2, -12.0f, true); // HIGH −12 shelf at 12 kHz
    REQUIRE(responseDb(e, 22000.0) == Approx(-12.0).margin(0.4));
    REQUIRE(responseDb(e, 200.0) == Approx(0.0).margin(0.1));
    // the biquad maths, analytically: lowshelf +12 dB at DC = exactly +12; peaking +6 at f0 = exactly +6
    Biquad b;
    b.set(Biquad::Type::lowshelf, 80.0, 1.0, 12.0, kSr);
    REQUIRE(20.0 * std::log10(b.magnitudeAt(0.01, kSr)) == Approx(12.0).margin(1e-3));
    b.set(Biquad::Type::peaking, 1000.0, 0.8, 6.0, kSr);
    REQUIRE(20.0 * std::log10(b.magnitudeAt(1000.0, kSr)) == Approx(6.0).margin(1e-6));
    b.set(Biquad::Type::highshelf, 12000.0, 1.0, -12.0, kSr);
    REQUIRE(20.0 * std::log10(b.magnitudeAt(23999.0, kSr)) == Approx(-12.0).margin(1e-2));
}

TEST_CASE("fx: FILTER — the Web Audio lowpass/highpass (Q in dB) / bandpass / notch", "[fx]")
{
    FilterFx f;
    f.prepare(kSr, kBlock);
    // defaults: lowpass 20 kHz, RESO 1 (= Q 1 dB): flat in the band
    REQUIRE(responseDb(f, 1000.0) == Approx(0.0).margin(0.05));
    f.setParam(1, 1000.0f, true);                              // cutoff 1 kHz
    REQUIRE(responseDb(f, 1000.0) == Approx(1.0).margin(0.1)); // |H(fc)| = Q_lin = 10^(1/20) = +1 dB
    REQUIRE(responseDb(f, 10000.0) < -38.0);                   // 2nd order: ~−40 dB a decade up
    REQUIRE(responseDb(f, 100.0) == Approx(0.0).margin(0.1));
    f.setParam(2, 0.0f, true); // RESO 0 = Q 0.0001 dB (the TS floor): 0 dB at the cutoff (Butterworth −3 dB is
                               // below the page's RESO range — RESO is in dB for LP/HP)
    REQUIRE(responseDb(f, 1000.0) == Approx(0.0).margin(0.1));
    f.setParam(2, 1.0f, true);
    f.setParam(0, 1.0f, true); // highpass
    REQUIRE(responseDb(f, 1000.0) == Approx(1.0).margin(0.1));
    REQUIRE(responseDb(f, 100.0) < -38.0);
    REQUIRE(responseDb(f, 10000.0) == Approx(0.0).margin(0.1));
    f.setParam(0, 2.0f, true); // bandpass: 0 dB at fc (the constant-0-dB-peak RBJ form), off-centre attenuated
    REQUIRE(responseDb(f, 1000.0) == Approx(0.0).margin(0.1));
    REQUIRE(responseDb(f, 100.0) < -15.0);
    f.setParam(0, 3.0f, true); // notch: the centre gone
    REQUIRE(responseDb(f, 1000.0) < -40.0);
    REQUIRE(responseDb(f, 100.0) == Approx(0.0).margin(0.2));
    // the analytic numbers
    Biquad b;
    b.set(Biquad::Type::lowpass, 1000.0, 1.0, 0.0, kSr);
    REQUIRE(20.0 * std::log10(b.magnitudeAt(1000.0, kSr)) == Approx(1.0).margin(1e-3));
    b.set(Biquad::Type::lowpass, 1000.0, -3.0103, 0.0, kSr);
    REQUIRE(20.0 * std::log10(b.magnitudeAt(1000.0, kSr)) == Approx(-3.0103).margin(1e-3));
    b.set(Biquad::Type::bandpass, 1000.0, 1.0, 0.0, kSr);
    REQUIRE(b.magnitudeAt(1000.0, kSr) == Approx(1.0).margin(1e-9));
    b.set(Biquad::Type::notch, 1000.0, 1.0, 0.0, kSr);
    REQUIRE(b.magnitudeAt(1000.0, kSr) < 1e-9);
}

TEST_CASE("fx: WIDE and M/S EQ — the mid/side matrix", "[fx]")
{
    WideFx w;
    w.prepare(kSr, kBlock);
    std::vector<double> l(kBlock, 0.5), r(kBlock, 0.25);
    w.process(l.data(), r.data(), kBlock);
    REQUIRE(l[3] == Approx(0.5).margin(1e-12)); // 100 = identity (M + S)
    REQUIRE(r[3] == Approx(0.25).margin(1e-12));
    w.setParam(0, 0.0f, true);
    std::fill(l.begin(), l.end(), 0.5);
    std::fill(r.begin(), r.end(), 0.25);
    w.process(l.data(), r.data(), kBlock);
    REQUIRE(l[3] == Approx(0.375).margin(1e-12));
    REQUIRE(r[3] == Approx(0.375).margin(1e-12));
    w.setParam(0, 200.0f, true);
    std::fill(l.begin(), l.end(), 0.5);
    std::fill(r.begin(), r.end(), 0.25);
    w.process(l.data(), r.data(), kBlock);
    REQUIRE(l[3] == Approx(0.625).margin(1e-12));
    REQUIRE(r[3] == Approx(0.125).margin(1e-12));

    MseqFx m;
    m.prepare(kSr, kBlock);
    REQUIRE(responseDb(m, 1000.0) == Approx(0.0).margin(1e-6)); // defaults: 0 dB bands
    m.setParam(1, 6.0f, true);                                  // MID +6 at 1 kHz: a mono sine gets it …
    REQUIRE(responseDb(m, 1000.0) == Approx(6.0).margin(0.05));
    REQUIRE(responseDb(m, 1000.0, 0.5, true) == Approx(0.0).margin(0.05)); // … an anti-phase (side-only) one does not
    m.setParam(1, 0.0f, true);
    m.setParam(2, 1000.0f, true);
    m.setParam(3, -6.0f, true); // SIDE −6 at 1 kHz: side-only sine cut, mono untouched
    REQUIRE(responseDb(m, 1000.0, 0.5, true) == Approx(-6.0).margin(0.05));
    REQUIRE(responseDb(m, 1000.0) == Approx(0.0).margin(0.05));
}

TEST_CASE("fx: PAN — the sine LFO sweeps the StereoPanner law; DEPTH 0 is the identity", "[fx]")
{
    PanFx p;
    p.prepare(kSr, kBlock);
    p.setParam(0, 1.0f, true);   // 1 Hz
    p.setParam(1, 100.0f, true); // full depth
    // a mono DC 0.5: at t = 0.25 s pan = +1 → L 0, R 1.0; at t = 0.75 s pan = −1 → L 1.0, R 0
    std::vector<double> l(kBlock), r(kBlock);
    int done = 0;
    double l25 = -1.0, r25 = -1.0, l75 = -1.0, r75 = -1.0;
    const int s25 = static_cast<int>(kSr * 0.25), s75 = static_cast<int>(kSr * 0.75);
    while (done < static_cast<int>(kSr))
    {
        std::fill(l.begin(), l.end(), 0.5);
        std::fill(r.begin(), r.end(), 0.5);
        p.process(l.data(), r.data(), kBlock);
        if (s25 >= done && s25 < done + kBlock)
        {
            l25 = l[static_cast<std::size_t>(s25 - done)];
            r25 = r[static_cast<std::size_t>(s25 - done)];
        }
        if (s75 >= done && s75 < done + kBlock)
        {
            l75 = l[static_cast<std::size_t>(s75 - done)];
            r75 = r[static_cast<std::size_t>(s75 - done)];
        }
        done += kBlock;
    }
    REQUIRE(std::abs(l25) < 1e-3);
    REQUIRE(r25 == Approx(1.0).margin(1e-3));
    REQUIRE(l75 == Approx(1.0).margin(1e-3));
    REQUIRE(std::abs(r75) < 1e-3);
    p.setParam(1, 0.0f, true);
    std::fill(l.begin(), l.end(), 0.5);
    std::fill(r.begin(), r.end(), 0.25);
    p.process(l.data(), r.data(), kBlock);
    REQUIRE(l[7] == 0.5);
    REQUIRE(r[7] == 0.25);
}

TEST_CASE("fx: the insert chain — add / bypass / param / reorder / remove / clear, the caps, the pool", "[fx]")
{
    Rig r;
    r.dcPad(0.5f, 0.25f);
    r.settle();
    REQUIRE(r.out(0) == 0.5f);
    // utility −6 dB on strip 1
    r.push(Command::mixerAddFx(1, Rig::id(FxType::utility)));
    r.push(Command::mixerSetFxParam(1, 0, 0, -6.0206f, true));
    r.settle();
    REQUIRE(r.engine.snapshot().stripFxCount[1] == 1);
    REQUIRE(r.engine.mixer().fxType(1, 0) == FxType::utility);
    REQUIRE(r.out(0) == Approx(0.25f).margin(2e-5f));
    // bypass = dry, bit-exact
    r.push(Command::mixerSetFxBypass(1, 0, true));
    r.settle();
    REQUIRE(r.out(0) == 0.5f);
    REQUIRE(r.engine.mixer().fxBypassed(1, 0));
    r.push(Command::mixerSetFxBypass(1, 0, false));
    // a second device: WIDE 0 (mono) after the gain → both outs 0.1875
    r.push(Command::mixerAddFx(1, Rig::id(FxType::wide)));
    r.push(Command::mixerSetFxParam(1, 1, 0, 0.0f, true));
    r.settle();
    REQUIRE(r.out(0) == Approx(0.1875f).margin(2e-5f));
    REQUIRE(r.out(1) == Approx(0.1875f).margin(2e-5f));
    // reorder: wide first, then the gain — the same numbers (linear), the order read-back flips
    r.push(Command::mixerReorderFx(1, 1, 0));
    r.settle();
    REQUIRE(r.engine.mixer().fxType(1, 0) == FxType::wide);
    REQUIRE(r.engine.mixer().fxType(1, 1) == FxType::utility);
    REQUIRE(r.out(0) == Approx(0.1875f).margin(2e-5f));
    // the param read-back survives the reorder (the utility is now slot 1)
    REQUIRE(r.engine.mixer().fx(1, 1)->param(0) == Approx(-6.0206f).margin(1e-3f));
    // remove the utility → mono at 0.375
    r.push(Command::mixerRemoveFx(1, 1));
    r.settle();
    REQUIRE(r.engine.snapshot().stripFxCount[1] == 1);
    REQUIRE(r.out(0) == Approx(0.375f).margin(1e-6f));
    // the 8-slot cap: 7 more fit, the 9th is refused
    for (int k = 0; k < 7; ++k)
        r.push(Command::mixerAddFx(1, Rig::id(FxType::eq)));
    r.run();
    REQUIRE(r.engine.snapshot().stripFxCount[1] == 8);
    const auto rej0 = r.engine.snapshot().mixerFxRejected;
    r.push(Command::mixerAddFx(1, Rig::id(FxType::eq)));
    r.run();
    REQUIRE(r.engine.snapshot().mixerFxRejected == rej0 + 1);
    REQUIRE(r.engine.snapshot().stripFxCount[1] == 8);
    // a dead strip is refused
    r.push(Command::mixerAddFx(2, Rig::id(FxType::eq)));
    r.run();
    REQUIRE(r.engine.snapshot().mixerFxRejected == rej0 + 2);
    // clear → back to the plain strip
    r.push(Command::mixerClearFx(1));
    r.settle();
    REQUIRE(r.engine.snapshot().stripFxCount[1] == 0);
    REQUIRE(r.out(0) == 0.5f);
    // an UNPORTED type takes its slot as a pass-through placeholder (the page chain's indices stay aligned): it reports
    // the type, passes audio bit-exact, a later device behind it is still slot 1
    r.push(Command::mixerAddFx(1, Rig::id(FxType::reverb)));
    r.push(Command::mixerAddFx(1, Rig::id(FxType::utility)));
    r.push(Command::mixerSetFxParam(1, 1, 0, -6.0206f, true));
    r.settle();
    REQUIRE(r.engine.mixer().fxType(1, 0) == FxType::reverb);
    REQUIRE(r.engine.mixer().fxType(1, 1) == FxType::utility);
    REQUIRE(r.engine.snapshot().mixerFxRejected == rej0 + 2);
    REQUIRE(r.out(0) == Approx(0.25f).margin(2e-5f));
    REQUIRE_FALSE(FxPool::isPorted(FxType::reverb));
    REQUIRE(FxPool::isPorted(FxType::utility));
    r.push(Command::mixerClearFx(1));
    r.settle();
    REQUIRE(r.out(0) == 0.5f);
    // the pool cap: 32 WIDEs across strips, the 33rd refused; removing one frees a slot
    for (int s = 2; s <= 9; ++s)
        r.push(Command::mixerSetStrip(s, static_cast<std::uint8_t>(StripKind::channel)));
    for (int k = 0; k < 32; ++k)
        r.push(Command::mixerAddFx(2 + (k % 8), Rig::id(FxType::wide)));
    r.run();
    const auto rej1 = r.engine.snapshot().mixerFxRejected;
    r.push(Command::mixerAddFx(1, Rig::id(FxType::wide)));
    r.run();
    REQUIRE(r.engine.snapshot().mixerFxRejected == rej1 + 1);
    r.push(Command::mixerRemoveFx(2, 0));
    r.push(Command::mixerAddFx(1, Rig::id(FxType::wide)));
    r.run();
    REQUIRE(r.engine.snapshot().mixerFxRejected == rej1 + 1);
    REQUIRE(r.engine.snapshot().stripFxCount[1] == 1);
    // a strip turned off gives its devices back
    r.push(Command::mixerSetStrip(3, static_cast<std::uint8_t>(StripKind::off)));
    r.run();
    REQUIRE(r.engine.snapshot().stripFxCount[3] == 0);
    // the chain's latency: every 4.2a device is zero-latency
    REQUIRE(r.engine.mixer().chainLatencySamples(1) == 0);
}
