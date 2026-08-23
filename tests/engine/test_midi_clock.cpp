// MIDI clock (Phase 3.5) — the Electron gates `midi-clock.test.mts` (OUT) and `midi-clock-in.test.mts` (IN)
// ported to the sample clock, plus what only the native design can assert: events at exact samples, block-size
// invariance, ten minutes without drift, pause → STOP / resume → Song Position + CONTINUE, the Engine wiring
// (seqPlay / drumPlay anchor the clock, seqStop / panic / a self-stopping sequencer send STOP, host-time stamps at
// the ear) and the loopback gate from the plan (OUT → IN follower reads the same BPM).
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include "terminator/core/ChopSequencer.h"
#include "terminator/core/Engine.h"
#include "terminator/core/MidiClock.h"

using namespace terminator;
using Catch::Approx;

namespace
{
struct Ev
{
    std::uint64_t sample;
    std::uint8_t b0, b1, b2, size;
};

/// Run the generator over `blocks` blocks of `blockSize` from `from`, collecting every event.
std::vector<Ev> run(MidiClockOut& c, std::uint64_t& pos, int blocks, int blockSize,
                    const std::function<void(std::uint64_t blockStart)>& before = {})
{
    std::vector<Ev> out;
    MidiClockOut::Event buf[MidiClockOut::kMaxEventsPerBlock];
    for (int b = 0; b < blocks; ++b)
    {
        if (before)
            before(pos);
        const int n = c.process(pos, blockSize, buf, MidiClockOut::kMaxEventsPerBlock);
        for (int i = 0; i < n; ++i)
            out.push_back({buf[i].sample, buf[i].data[0], buf[i].data[1], buf[i].data[2], buf[i].size});
        pos += static_cast<std::uint64_t>(blockSize);
    }
    return out;
}
std::vector<Ev> ticks(const std::vector<Ev>& evs)
{
    std::vector<Ev> t;
    for (const auto& e : evs)
        if (e.b0 == kMidiClockByte)
            t.push_back(e);
    return t;
}
double sptSamples(double bpm, double sr = 48000.0)
{
    return midiClockSecondsPerTick(bpm) * sr;
}
} // namespace

TEST_CASE("midi clock: seconds per tick (TS secondsPerTick)", "[midiclock]")
{
    REQUIRE(midiClockSecondsPerTick(120.0) == Approx(60.0 / 120.0 / 24.0));
    REQUIRE(midiClockSecondsPerTick(10.0) == Approx(60.0 / 20.0 / 24.0));   // clamped to 20
    REQUIRE(midiClockSecondsPerTick(900.0) == Approx(60.0 / 400.0 / 24.0)); // clamped to 400
    REQUIRE(midiClockSecondsPerTick(0.0) == Approx(60.0 / 120.0 / 24.0));   // 0 → 120
}

TEST_CASE("midi clock out: PLAY = SPP 0 + START + the first tick AT the anchor, then 24 evenly spaced ticks per beat",
          "[midiclock]")
{
    MidiClockOut c;
    c.prepare(48000.0);
    c.setBpm(120.0);
    std::uint64_t pos = 0;

    // disabled: PLAY sends nothing
    c.start(1000, 0);
    REQUIRE(run(c, pos, 40, 64).empty());
    REQUIRE_FALSE(c.running());

    c.setEnabled(true, pos);
    pos = 0;
    c.start(1000, 0);
    const auto evs = run(c, pos, 48000 / 64, 64); // one second
    REQUIRE(evs.size() >= 3);
    CHECK(evs[0].b0 == kMidiSppByte);
    CHECK(evs[0].b1 == 0);
    CHECK(evs[0].b2 == 0);
    CHECK(evs[0].size == 3);
    CHECK(evs[1].b0 == kMidiStartByte);
    CHECK(evs[1].size == 1);
    CHECK(evs[2].b0 == kMidiClockByte);
    CHECK(evs[0].sample == 1000);
    CHECK(evs[1].sample == 1000);
    CHECK(evs[2].sample == 1000);
    const auto tk = ticks(evs);
    // one second at 120 = 2 beats: ticks at 1000, 2000, … 47000 fit before 48000 (the 48th is AT 48000 = the next
    // block)
    CHECK(tk.size() == 47);
    for (std::size_t i = 0; i < tk.size(); ++i)
    {
        CHECK(tk[i].sample == 1000 + i * 1000);
        CHECK(tk[i].size == 1);
    }
    for (const auto& e : evs)
        CHECK(e.sample >= 1000); // nothing before the anchor
    CHECK(c.running());
    CHECK(c.tickCount() == 47);
}

TEST_CASE("midi clock out: a tempo change lands at the next tick - continuous, monotonic, no double/missing tick",
          "[midiclock]")
{
    MidiClockOut c;
    c.prepare(48000.0);
    c.setEnabled(true, 0);
    c.setBpm(120.0);
    std::uint64_t pos = 0;
    c.start(0, 0);
    auto evs = run(c, pos, 100, 64); // 6400 samples: ticks at 0,1000,…,6000
    c.setBpm(90.0);                  // lands at the NEXT tick (7000), then 1333.33 apart
    const auto more = run(c, pos, 400, 64);
    evs.insert(evs.end(), more.begin(), more.end());
    const auto tk = ticks(evs);
    REQUIRE(tk.size() > 12);
    std::vector<double> gaps;
    for (std::size_t i = 1; i < tk.size(); ++i)
        gaps.push_back(static_cast<double>(tk[i].sample) - static_cast<double>(tk[i - 1].sample));
    CHECK(gaps[0] == Approx(1000.0));
    CHECK(gaps[5] == Approx(1000.0));
    CHECK(tk[7].sample == 7000);                            // the last 120-spaced tick
    CHECK(gaps[7] == Approx(sptSamples(90.0)).margin(1.0)); // 7000 → 8333
    CHECK(gaps.back() == Approx(sptSamples(90.0)).margin(1.0));
    bool widensOnce = false, monotonic = true;
    for (std::size_t i = 1; i < gaps.size(); ++i)
    {
        if (gaps[i] > gaps[i - 1] + 1.0)
            widensOnce = true;
        if (gaps[i] + 1.0 < gaps[i - 1])
            monotonic = false;
    }
    CHECK(widensOnce);
    CHECK(monotonic);
    // ten minutes at 90 from a known tick: tick n == floor(t0 + n × 1333.33…) within a sample (no accumulated drift)
    const auto t0 = static_cast<double>(tk[7].sample);
    std::uint64_t pos2 = pos;
    const auto ten = ticks(run(c, pos2, 600 * 48000 / 64, 64));
    REQUIRE(ten.size() >= 21590); // 600 s x 36 ticks/s
    // pick the first tick in `ten` and derive its index from tk's tail
    const std::size_t base = tk.size() - 7; // ticks after tk[7] already seen in `tk`
    for (std::size_t i = 0; i < ten.size(); i += 997)
    {
        const double expect = t0 + static_cast<double>(base + i) * sptSamples(90.0);
        CHECK(std::fabs(static_cast<double>(ten[i].sample) - expect) <= 1.0);
    }
}

TEST_CASE("midi clock out: block-size invariant (37/64/128/480/512 give the same events at the same samples)",
          "[midiclock]")
{
    auto render = [](int block, bool change)
    {
        MidiClockOut c;
        c.prepare(48000.0);
        c.setEnabled(true, 0);
        c.setBpm(120.0);
        std::uint64_t pos = 0;
        c.start(2000, 0);
        const int seconds = 8;
        const int blocks = seconds * 48000 / block + 1;
        std::vector<Ev> evs;
        MidiClockOut::Event buf[MidiClockOut::kMaxEventsPerBlock];
        bool changed = false;
        for (int b = 0; b < blocks; ++b)
        {
            if (change && !changed && pos >= 147456) // 288 × 512 = a boundary of every power-of-two block here
            {
                c.setBpm(77.0);
                changed = true;
            }
            const int n = c.process(pos, block, buf, MidiClockOut::kMaxEventsPerBlock);
            for (int i = 0; i < n; ++i)
                if (buf[i].sample < 8 * 48000)
                    evs.push_back({buf[i].sample, buf[i].data[0], buf[i].data[1], buf[i].data[2], buf[i].size});
            pos += static_cast<std::uint64_t>(block);
        }
        return evs;
    };
    const auto ref = render(64, false);
    for (int block : {37, 128, 480, 512})
    {
        const auto other = render(block, false);
        REQUIRE(other.size() == ref.size());
        for (std::size_t i = 0; i < ref.size(); ++i)
        {
            CHECK(other[i].sample == ref[i].sample);
            CHECK(other[i].b0 == ref[i].b0);
        }
    }
    const auto refC = render(64, true);
    for (int block : {32, 128, 512})
    {
        const auto other = render(block, true);
        REQUIRE(other.size() == refC.size());
        for (std::size_t i = 0; i < refC.size(); ++i)
            CHECK(other[i].sample == refC[i].sample);
    }
    CHECK(refC.size() != ref.size()); // the tempo change really changed the stream
}

TEST_CASE("midi clock out: STOP at its sample, nothing after; restart = STOP then SPP 0 + START; disable mid-run",
          "[midiclock]")
{
    MidiClockOut c;
    c.prepare(48000.0);
    c.setEnabled(true, 0);
    c.setBpm(120.0);
    std::uint64_t pos = 0;
    c.start(0, 0);
    auto evs = run(c, pos, 50, 64); // to 3200
    c.stop(pos);                    // STOP at 3200
    auto evs2 = run(c, pos, 100, 64);
    REQUIRE(evs2.size() == 1);
    CHECK(evs2[0].b0 == kMidiStopByte);
    CHECK(evs2[0].sample == 3200);
    CHECK_FALSE(c.running());
    // restart at a future anchor: SPP 0 + START there, the tick count starts over
    const std::uint64_t anchor = pos + 5000;
    c.start(anchor, pos);
    auto evs3 = run(c, pos, 200, 64);
    REQUIRE(evs3.size() >= 3);
    CHECK(evs3[0].b0 == kMidiSppByte);
    CHECK(evs3[0].b1 == 0);
    CHECK(evs3[0].sample == anchor);
    CHECK(evs3[1].b0 == kMidiStartByte);
    CHECK(evs3[2].b0 == kMidiClockByte);
    CHECK(evs3[2].sample == anchor);
    for (const auto& e : evs3)
        CHECK(e.sample >= anchor);
    // a restart WHILE running: STOP at the block start first (TS stop() → start())
    const std::uint64_t anchor2 = pos + 640;
    c.start(anchor2, pos);
    auto evs4 = run(c, pos, 20, 64);
    REQUIRE(evs4.size() >= 4);
    CHECK(evs4[0].b0 == kMidiStopByte);
    CHECK(evs4[0].sample == anchor2 - 640);
    CHECK(evs4[1].b0 == kMidiSppByte);
    CHECK(evs4[2].b0 == kMidiStartByte);
    CHECK(evs4[3].b0 == kMidiClockByte);
    CHECK(evs4[3].sample == anchor2);
    // the preference goes off mid-run → STOP now, quiet; back on → still quiet until the next PLAY
    c.setEnabled(false, pos);
    auto evs5 = run(c, pos, 50, 64);
    REQUIRE(evs5.size() == 1);
    CHECK(evs5[0].b0 == kMidiStopByte);
    CHECK_FALSE(c.running());
    c.setEnabled(true, pos);
    CHECK(run(c, pos, 50, 64).empty());
    CHECK(c.controlDropped() == 0);
}

TEST_CASE("midi clock out: pause -> STOP keeps the count + phase; resume -> Song Position + CONTINUE, ticks go on",
          "[midiclock]")
{
    MidiClockOut c;
    c.prepare(48000.0);
    c.setEnabled(true, 0);
    c.setBpm(120.0);
    std::uint64_t pos = 0;
    c.start(0, 0);
    auto evs = run(c, pos, 36500 / 64, 64); // pos = 36480: ticks 0..36 fired (the 37th at 36000 too) — 37 ticks
    c.pause(pos);                           // STOP at 36480; the next tick was due at 37000 → phase 520
    REQUIRE(ticks(evs).size() == 37);
    auto evs2 = run(c, pos, 100, 64);
    REQUIRE(evs2.size() == 1);
    CHECK(evs2[0].b0 == kMidiStopByte);
    CHECK(evs2[0].sample == 36480);
    CHECK(c.running());
    CHECK(c.paused());
    const std::uint64_t at = pos; // 42880
    c.resume(at);
    auto evs3 = run(c, pos, 200, 64);
    REQUIRE(evs3.size() >= 3);
    CHECK(evs3[0].b0 == kMidiSppByte);
    CHECK(evs3[0].b1 == 37 / 6); // 6 MIDI beats (16ths) in
    CHECK(evs3[0].b2 == 0);
    CHECK(evs3[0].sample == at);
    CHECK(evs3[1].b0 == kMidiContinueByte);
    CHECK(evs3[1].sample == at);
    CHECK(evs3[2].b0 == kMidiClockByte);
    CHECK(evs3[2].sample == at + 520);
    CHECK(evs3[3].sample == at + 1520);
    CHECK_FALSE(c.paused());
}

TEST_CASE("midi clock out: the Engine anchors it with seqPlay / drumPlay, stops it with seqStop / panic / a "
          "self-stopping sequencer, stamps host time at the ear",
          "[midiclock][engine]")
{
    Engine e;
    Engine::Config cfg{48000.0, 64, 2, 0};
    cfg.outputLatencySamples = 96;
    e.prepare(cfg);
    std::vector<float> l(64), r(64);
    float* outs[2] = {l.data(), r.data()};
    auto step = [&](int blocks, std::uint64_t host0 = 0)
    {
        for (int b = 0; b < blocks; ++b)
        {
            const std::uint64_t host =
                host0 != 0 ? host0 + static_cast<std::uint64_t>(b) * (64ull * 1000000000ull / 48000ull) : 0;
            e.process(nullptr, 0, outs, 2, 64, host);
        }
    };
    auto drain = [&]
    {
        std::vector<MidiOutEvent> v;
        MidiOutEvent oe;
        while (e.midiOut().pop(oe))
            v.push_back(oe);
        return v;
    };
    // disabled by default: PLAY sends nothing
    e.commands().push(Command::seqSetBpm(120.0));
    e.commands().push(Command::seqPlay(0));
    step(20);
    CHECK(drain().empty());
    CHECK(e.snapshot().midiClockEnabled == 0);
    e.commands().push(Command::seqStop());
    step(1);
    drain();
    // enabled: seqPlay at 4800 → SPP/START/tick at 4800 with host stamps = block entry + (offset + latency)/sr
    e.commands().push(Command::midiClockEnable(true));
    e.commands().push(Command::seqPlay(4800));
    const std::uint64_t host0 = 5'000'000'000ull;
    step(100, host0); // samples 1344 .. 7744 (the engine is at 21×64 = 1344 after the first two steps)
    auto v = drain();
    REQUIRE(v.size() >= 3);
    CHECK(v[0].data[0] == kMidiSppByte);
    CHECK(v[0].sample == 4800);
    CHECK(v[1].data[0] == kMidiStartByte);
    CHECK(v[2].data[0] == kMidiClockByte);
    CHECK(v[2].sample == 4800);
    const std::uint64_t startSample = e.snapshot().samplesProcessed - 100 * 64; // where this run began
    const std::uint64_t blockOfAnchor = (4800 - startSample) / 64;
    const std::uint64_t blockEntry = host0 + blockOfAnchor * (64ull * 1000000000ull / 48000ull);
    const auto offSamples = static_cast<double>((4800 - startSample) % 64) + 96.0;
    const auto expectNs = blockEntry + static_cast<std::uint64_t>(offSamples / 48000.0 * 1e9);
    CHECK(v[0].hostTimeNs == expectNs);
    CHECK(v[2].hostTimeNs == expectNs);
    CHECK(e.snapshot().midiClockRunning == 1);
    CHECK(e.snapshot().midiClockEnabled == 1);
    {
        std::uint64_t n = 0;
        for (const auto& x : v)
            if (x.data[0] == kMidiClockByte)
                ++n;
        CHECK(e.snapshot().midiClockTicks == n);
    }
    // seqStop → STOP at that block start
    e.commands().push(Command::seqStop());
    step(1);
    v = drain();
    REQUIRE(v.size() == 1);
    CHECK(v[0].data[0] == kMidiStopByte);
    CHECK(e.snapshot().midiClockRunning == 0);
    // drums alone anchor the clock too; seqStop with the drums still playing does NOT stop it; drumStop does
    e.commands().push(Command::drumPlay(0, 0));
    step(5);
    v = drain();
    REQUIRE(v.size() >= 2);
    CHECK(v[0].data[0] == kMidiSppByte);
    CHECK(v[1].data[0] == kMidiStartByte);
    e.commands().push(Command::seqPlay(0)); // the chops join: a restart (STOP, SPP, START) — one clock, the seq anchor
    step(2);
    v = drain();
    REQUIRE(v.size() >= 3);
    CHECK(v[0].data[0] == kMidiStopByte);
    CHECK(v[1].data[0] == kMidiSppByte);
    CHECK(v[2].data[0] == kMidiStartByte);
    e.commands().push(Command::seqStop());
    step(2);
    v = drain();
    REQUIRE(v.size() == 1);
    CHECK(v[0].data[0] == kMidiStopByte); // seqStop always sends STOP (the TS stop hook) …
    e.commands().push(Command::drumPlay(0, 0));
    step(2);
    drain();
    e.commands().push(Command::drumStop());
    step(2);
    v = drain();
    REQUIRE(v.size() == 1);
    CHECK(v[0].data[0] == kMidiStopByte);
    // panic → STOP
    e.commands().push(Command::seqPlay(0));
    step(3);
    drain();
    e.commands().push(Command::panic());
    step(2);
    v = drain();
    REQUIRE(v.size() == 1);
    CHECK(v[0].data[0] == kMidiStopByte);
    // a non-looping chop pattern ends → the transport stops itself → STOP goes out
    auto pat = std::make_shared<SeqPattern>();
    pat->clear();
    pat->bars = 1;
    pat->resolution = 4;
    pat->stepCount = 4;
    pat->loop = false;
    e.commands().push(Command::seqSetBpm(240.0)); // a bar = 1 s
    e.commands().push(Command::seqSetPattern(pat.get()));
    e.commands().push(Command::seqPlay(0));
    step(2);
    v = drain();
    REQUIRE(v.size() >= 2);
    step(48000 / 64 + 20); // past the bar
    v = drain();
    REQUIRE_FALSE(v.empty());
    CHECK(v.back().data[0] == kMidiStopByte);
    CHECK(e.snapshot().midiClockRunning == 0);
    CHECK(e.snapshot().seqPlaying == 0);
    CHECK(e.snapshot().midiOutDropped == 0);
}

// ───────────────────────────── IN (the Electron midi-clock-in gate, 1:1) ─────────────────────────────
namespace
{
struct Lcg
{
    std::uint32_t seed = 99;
    double operator()()
    {
        seed = (seed * 1103515245u + 12345u) & 0x7fffffffu;
        return static_cast<double>(seed) / 2147483647.0 * 2.0 - 1.0;
    }
};
double perTickMs(double bpm)
{
    return 60000.0 / bpm / 24.0;
}
} // namespace

TEST_CASE("midi clock in: 120 BPM with +/-1 ms jitter reads 120 within 0.2 after a full beat, without wobble",
          "[midiclock]")
{
    MidiClockFollower f;
    Lcg rnd;
    double t = 1000.0;
    std::vector<std::pair<int, double>> reports;
    for (int i = 0; i < 24 * 8; ++i)
    {
        const double b = f.onTick(t + rnd());
        if (b != 0.0)
            reports.emplace_back(i, b);
        t += perTickMs(120.0);
    }
    REQUIRE_FALSE(reports.empty());
    CHECK(reports[0].first >= 24);
    CHECK(std::fabs(reports[0].second - 120.0) <= 0.2 + 1e-9);
    CHECK(reports.size() <= 2);
}

TEST_CASE("midi clock in: 120 -> 90 is followed within ~2 beats; reports at most once per beat", "[midiclock]")
{
    {
        MidiClockFollower f;
        double t = 0.0;
        int lastAt = -1;
        double lastBpm = 0.0;
        for (int i = 0; i < 24 * 4; ++i)
        {
            const double b = f.onTick(t);
            if (b != 0.0)
            {
                lastAt = i;
                lastBpm = b;
            }
            t += perTickMs(120.0);
        }
        const int changeAt = 24 * 4;
        for (int i = changeAt; i < changeAt + 24 * 4; ++i)
        {
            const double b = f.onTick(t);
            if (b != 0.0)
            {
                lastAt = i;
                lastBpm = b;
            }
            t += perTickMs(90.0);
        }
        CHECK(std::fabs(lastBpm - 90.0) <= 0.2 + 1e-9);
        CHECK(lastAt - changeAt <= 24 * 2 + 2);
    }
    {
        MidiClockFollower f;
        double t = 0.0;
        std::vector<int> at;
        double bpm = 100.0;
        for (int i = 0; i < 24 * 12; ++i)
        {
            if (i % 12 == 0)
                bpm += 1.0;
            if (f.onTick(t) != 0.0)
                at.push_back(i);
            t += perTickMs(bpm);
        }
        for (std::size_t k = 1; k < at.size(); ++k)
            CHECK(at[k] - at[k - 1] >= 24);
    }
}

TEST_CASE("midi clock in: a drop-out resets the window (a new tempo reads clean; the same tempo says nothing new)",
          "[midiclock]")
{
    MidiClockFollower f;
    double t = 0.0;
    for (int i = 0; i < 48; ++i)
    {
        f.onTick(t);
        t += perTickMs(120.0);
    }
    t += 3000.0; // 3 s pause, then 100 BPM
    double first = 0.0;
    int n = -1;
    for (int i = 0; i < 48; ++i)
    {
        const double b = f.onTick(t);
        if (b != 0.0 && first == 0.0)
        {
            first = b;
            n = i;
        }
        t += perTickMs(100.0);
    }
    CHECK(first != 0.0);
    CHECK(std::fabs(first - 100.0) <= 0.2 + 1e-9);
    CHECK(n >= 24);
    CHECK(n <= 30);
    MidiClockFollower g;
    t = 0.0;
    int reports = 0;
    for (int i = 0; i < 48; ++i)
    {
        if (g.onTick(t) != 0.0)
            ++reports;
        t += perTickMs(120.0);
    }
    t += 3000.0;
    for (int i = 0; i < 48; ++i)
    {
        if (g.onTick(t) != 0.0)
            ++reports;
        t += perTickMs(120.0);
    }
    CHECK(reports == 1);
    CHECK(g.current() == 120.0);
}

TEST_CASE("midi clock in: ONE PORT OWNS THE CLOCK (the MPC-on-two-ports 89 -> 177 bug)", "[midiclock]")
{
    MidiClockSourceLock lock;
    CHECK(lock.onStart(0, 1000.0));
    CHECK_FALSE(lock.onStart(1, 1003.0)); // the same press seen on port B 3 ms later
    CHECK(lock.onTick(0));
    CHECK_FALSE(lock.onTick(1));
    CHECK(lock.ownerPort() == 0);
    CHECK(lock.onStop(1)); // STOP from any port stops
    CHECK(lock.ownerPort() == -1);
    CHECK(lock.onStart(1, 5000.0)); // the next START can come from the other port
    MidiClockSourceLock l2;
    l2.onStart(0, 0.0);
    CHECK(l2.onStart(1, 2000.0)); // a real second press 2 s later takes over
    CHECK(l2.ownerPort() == 1);
    // the follower behind the lock: two ports' ticks interleaved at 89 must read 89, not 178
    {
        MidiClockSourceLock lk;
        MidiClockFollower f;
        double t = 0.0, last = 0.0;
        lk.onStart(0, t);
        lk.onStart(1, t + 1.0);
        for (int i = 0; i < 24 * 8; ++i)
        {
            if (lk.onTick(0))
            {
                const double b = f.onTick(t);
                if (b != 0.0)
                    last = b;
            }
            if (lk.onTick(1))
            {
                const double b = f.onTick(t + 0.4);
                if (b != 0.0)
                    last = b;
            }
            t += perTickMs(89.0);
        }
        CHECK(std::fabs(last - 89.0) <= 0.2 + 1e-9);
        // (control) without the lock the same stream reads double
        MidiClockFollower g;
        t = 0.0;
        double bad = 0.0;
        for (int i = 0; i < 24 * 8; ++i)
        {
            const double b1 = g.onTick(t);
            if (b1 != 0.0)
                bad = b1;
            const double b2 = g.onTick(t + 0.4);
            if (b2 != 0.0)
                bad = b2;
            t += perTickMs(89.0);
        }
        CHECK(bad > 150.0);
    }
}

TEST_CASE("midi clock loopback: the native clock OUT fed to the IN follower reads the same BPM (120, then 90)",
          "[midiclock]")
{
    MidiClockOut c;
    c.prepare(48000.0);
    c.setEnabled(true, 0);
    c.setBpm(120.0);
    std::uint64_t pos = 0;
    c.start(0, 0);
    MidiClockFollower f;
    MidiClockSourceLock lock;
    double read = 0.0;
    int readAtTick = -1, tickIdx = 0, changeTick = -1;
    auto feed = [&](const std::vector<Ev>& evs)
    {
        for (const auto& e : evs)
        {
            if (e.b0 == kMidiStartByte)
                lock.onStart(0, static_cast<double>(e.sample) / 48.0);
            if (e.b0 != kMidiClockByte || !lock.onTick(0))
                continue;
            const double b = f.onTick(static_cast<double>(e.sample) / 48.0); // samples → ms at 48 kHz
            if (b != 0.0)
            {
                read = b;
                readAtTick = tickIdx;
            }
            ++tickIdx;
        }
    };
    feed(run(c, pos, 4 * 48000 / 64, 64)); // 4 s at 120
    CHECK(std::fabs(read - 120.0) <= 0.1);
    c.setBpm(90.0);
    changeTick = tickIdx;
    feed(run(c, pos, 4 * 48000 / 64, 64));
    CHECK(std::fabs(read - 90.0) <= 0.1);
    CHECK(readAtTick - changeTick <= 24 * 2 + 2);
}
