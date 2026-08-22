// Pure planner ports, part 1 — the TS gates re-asserted in C++:
//   stem-mask (scripts/stem-mask.test.mts), input-q's liveLanding half (scripts/input-q.test.mts),
//   chop-seq-standalone's swing assertions, trims (from trimRegions.ts semantics), the sequencer refit.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <vector>

#include "terminator/core/planners/LiveLanding.h"
#include "terminator/core/planners/SeqRefit.h"
#include "terminator/core/planners/StemMask.h"
#include "terminator/core/planners/Swing.h"
#include "terminator/core/planners/Trims.h"

using Catch::Approx;
using namespace terminator;

// ── stem masks ────────────────────────────────────────────────────────────────────────────────────
TEST_CASE("stem mask: model bit order, toggles, normalisation", "[planners][stems]")
{
    using namespace stems;
    CHECK(stemBit(Stem::drums) == 1);
    CHECK(stemBit(Stem::bass) == 2);
    CHECK(stemBit(Stem::other) == 4);
    CHECK(stemBit(Stem::vocals) == 8);
    for (int s = 0; s < kStemCount; ++s)
        CHECK(maskHas(kMaskAll, static_cast<Stem>(s)));
    CHECK(toggleStem(kMaskAll, Stem::vocals) == 0b0111);
    CHECK(!maskHas(0b0111, Stem::vocals));
    CHECK(toggleStem(0b0111, Stem::vocals) == kMaskAll);
    CHECK(toggleStem(stemBit(Stem::bass), Stem::bass) == stemBit(Stem::bass)); // last lit stem refuses
    for (const long long v : {0LL, 16LL, -3LL})
        CHECK(normalizeMask(v) == kMaskAll);
    CHECK(normalizeMaskValue(1.5) == kMaskAll);
    CHECK(normalizeMask(1) == 1);
    CHECK(normalizeMask(0b1010) == 0b1010);
    CHECK(normalizeMask(15) == 15);
}

TEST_CASE("stem mask: combo mixdown is the exact per-sample sum; mono stems fill both channels", "[planners][stems]")
{
    using namespace stems;
    const std::size_t N = 1000;
    auto mk = [&](int seed)
    {
        std::vector<float> a(N);
        for (std::size_t i = 0; i < N; ++i)
            a[i] = static_cast<float>(std::sin(static_cast<double>(i) * seed * 0.01) * 0.2);
        return a;
    };
    std::vector<std::vector<float>> d{mk(1), mk(2)}, b{mk(3), mk(4)}, o{mk(5), mk(6)}, v{mk(7), mk(8)};
    std::vector<std::vector<const float*>> stemsv{
        {d[0].data(), d[1].data()}, {b[0].data(), b[1].data()}, {o[0].data(), o[1].data()}, {v[0].data(), v[1].data()}};
    auto mix = mixMaskChannels(stemsv, static_cast<StemMask>(stemBit(Stem::drums) | stemBit(Stem::bass)), 2, N);
    for (std::size_t i = 0; i < N; ++i)
    {
        CHECK(mix[0][i] == Approx(d[0][i] + b[0][i]).margin(1e-7));
        CHECK(mix[1][i] == Approx(d[1][i] + b[1][i]).margin(1e-7));
    }
    auto all = mixMaskChannels(stemsv, kMaskAll, 2, N);
    for (std::size_t i = 0; i < N; i += 97)
        CHECK(all[0][i] == Approx(d[0][i] + b[0][i] + o[0][i] + v[0][i]).margin(1e-6));
    auto mono = mk(9);
    std::vector<std::vector<const float*>> stemsMono{
        {mono.data()}, {b[0].data(), b[1].data()}, {o[0].data(), o[1].data()}, {v[0].data(), v[1].data()}};
    auto mm = mixMaskChannels(stemsMono, stemBit(Stem::drums), 2, N);
    CHECK(mm[1][123] == Approx(mono[123]).margin(1e-7));
}

TEST_CASE("stem mask: ready ranges merge, contain, forgive float edges", "[planners][stems]")
{
    using namespace stems;
    std::vector<ReadyRange> r;
    r = addReadyRange(r, {10, 15});
    r = addReadyRange(r, {20, 25});
    REQUIRE(r.size() == 2);
    CHECK(r[0].start == 10);
    CHECK(r[1].start == 20);
    r = addReadyRange(r, {14, 21});
    REQUIRE(r.size() == 1);
    CHECK(r[0].start == 10);
    CHECK(r[0].end == 25);
    r = addReadyRange(r, {25, 30});
    REQUIRE(r.size() == 1);
    CHECK(r[0].end == 30);
    CHECK(spanReady(r, 12, 28));
    CHECK(!spanReady(r, 12, 30.5));
    CHECK(spanReady(r, 10.0, 30.0005));
    CHECK(!spanReady({}, 0, 1));
    CHECK(addReadyRange(r, {5, 5}).size() == 1);
    auto n = normalizeRanges({{20, 25}, {10, 15}, {14, 21}, {3, 1}, {-2, 0.5}});
    REQUIRE(n.size() == 2);
    CHECK(n[0].start == 0); // clamped start
    CHECK(n[0].end == 0.5);
    CHECK(n[1].start == 10);
    CHECK(n[1].end == 25);
    CHECK(normalizeRanges({{1, std::nan("")}}).empty());
}

// ── live landing (INPUT Q) ────────────────────────────────────────────────────────────────────────
TEST_CASE("liveLanding: INPUT Q 100 lands on the line, 0 keeps the played time, 50 halfway, monotonic",
          "[planners][seq]")
{
    using seq::liveLanding;
    const double BPM = 120, BAR = (60.0 / BPM) * 4;
    const double stepDur = BAR / 192;
    const double stride = 192.0 / 8;
    const double lineDur = stepDur * stride;
    const double line = 3 * lineDur;
    const double played = line - 0.04;
    const auto full = liveLanding(played, stepDur, stride, 1);
    CHECK(full.at == Approx(line).margin(1e-9));
    CHECK(full.step == static_cast<int>(3 * stride));
    const auto free = liveLanding(played, stepDur, stride, 0);
    CHECK(std::abs(free.at - played) <= stepDur / 2 + 1e-9);
    const auto half = liveLanding(played, stepDur, stride, 0.5);
    CHECK(std::abs(half.at - (played + (line - played) / 2)) <= stepDur / 2 + 1e-9);
    double prev = -1;
    for (const double s : {0.0, 0.25, 0.5, 0.75, 1.0})
    {
        const double at = liveLanding(played, stepDur, stride, s).at;
        CHECK(at >= prev - 1e-9);
        prev = at;
    }
    for (const double s : {0.0, 0.3, 0.7, 1.0})
    {
        const auto r = liveLanding(played, stepDur, stride, s);
        CHECK(r.at == Approx(r.step * stepDur).margin(1e-12));
    }
    CHECK(liveLanding(0.16, stepDur, 192.0 / 8, 1).at == Approx(0.25).margin(1e-9));
    CHECK(liveLanding(0.16, stepDur, 192.0 / 16, 1).at == Approx(0.125).margin(1e-9));
    const auto bad = liveLanding(0.1, 0, 4, 1);
    CHECK((bad.step == 0 && bad.at == 0));
    const auto late = liveLanding(-0.01, stepDur, stride, 1);
    CHECK(std::isfinite(late.at));
    CHECK(late.step == 0);
    CHECK(liveLanding(played, stepDur, stride, std::nan("")).at == Approx(line).margin(1e-9)); // NaN = full
}

// ── swing ──────────────────────────────────────────────────────────────────────────────────────────
TEST_CASE("swing: downbeats never move, odd 16ths go late, a 32nd inside an odd 16th shifts with it", "[planners][seq]")
{
    using namespace swing;
    CHECK(swingOffsetSec(0, 90, 0.6) == 0.0);
    CHECK(swingOffsetSec(2, 90, 0.6) == 0.0);
    CHECK(swingOffsetSec(1, 90, 0.6) > 0.005);
    CHECK(swingOffsetSec(1, 90, 0.0) == 0.0);
    CHECK(swingOffsetSec(1, 0, 0.6) == 0.0);
    // full swing = exactly half a 16th (the pulse snap lands on it: 12 pulses)
    CHECK(swingOffsetSec(1, 120, 1.0) == Approx((60000.0 / 120 / 4 / 2) / 1000).margin(1e-9));
    CHECK(seqSwingOffsetSec(3, 16, 100, 0.6) > 0);
    CHECK(seqSwingOffsetSec(3, 16, 100, 0.6) == Approx(seqSwingOffsetSec(7, 32, 100, 0.6)).margin(1e-9));
    CHECK(seqSwingOffsetSec(4, 32, 100, 0.6) == 0.0); // step 4 of 32 = the 3rd 16th (even)
    CHECK(seqSwingOffsetSec(6, 32, 100, 0.6) > 0.0);  // step 6 of 32 sits inside the 4th 16th (odd)
}

// ── trims ──────────────────────────────────────────────────────────────────────────────────────────
TEST_CASE("trims: file↔effective mapping, region merge, kept ranges", "[planners][trims]")
{
    using namespace trims;
    TrimList t;
    t = addTrimRegion(t, 2.0, 3.0, {{7, 2.1, 2.9, 4, -1}});
    t = addTrimRegion(t, 5.0, 6.0, {});
    REQUIRE(t.size() == 2);
    CHECK(fileToEff(t, 1.0) == 1.0);
    CHECK(fileToEff(t, 2.5) == 2.0); // inside a cut → its seam
    CHECK(fileToEff(t, 4.0) == 3.0);
    CHECK(fileToEff(t, 7.0) == 5.0);
    CHECK(effToFile(t, 3.0) == 4.0);
    CHECK(effToFile(t, 2.0) == 3.0);       // a START on the seam → after side
    CHECK(effToFile(t, 2.0, true) == 2.0); // an END on the seam → before side
    // merge: a span bridging both cuts swallows their chop lists (deduped by id)
    auto m = addTrimRegion(t, 2.8, 5.2, {{7, 2.1, 2.9, 4, -1}, {9, 4.0, 4.5, -1, 3}});
    REQUIRE(m.size() == 1);
    CHECK(m[0].startSec == 2.0);
    CHECK(m[0].endSec == 6.0);
    REQUIRE(m[0].chops.size() == 2);
    CHECK(m[0].chops[0].id == 7);
    CHECK(m[0].chops[1].id == 9);
    CHECK(totalTrimmedSec(t) == Approx(2.0));
    CHECK(sameTrims(t, t));
    CHECK(!sameTrims(t, m));
    auto k = keptRanges(100, 10.0, t);
    REQUIRE(k.size() == 3);
    CHECK(k[0] == std::make_pair<std::int64_t, std::int64_t>(0, 20));
    CHECK(k[1] == std::make_pair<std::int64_t, std::int64_t>(30, 50));
    CHECK(k[2] == std::make_pair<std::int64_t, std::int64_t>(60, 100));
    auto whole = keptRanges(100, 10.0, {{0.0, 10.0, {}}});
    REQUIRE(whole.size() == 1);
    CHECK(whole[0].second == 1); // one frame survives
}

TEST_CASE("trims: effective buffer = kept ranges concatenated with 3 ms seam ramps", "[planners][trims]")
{
    using namespace trims;
    const double rate = 1000.0; // 3 ms = 3 frames
    std::vector<float> src(100, 1.0f);
    TrimList t = {{0.02, 0.05, {}}}; // cut frames [20, 50)
    auto out = buildEffectiveChannels({src.data()}, 100, rate, t);
    REQUIRE(out.size() == 1);
    REQUIRE(out[0].size() == 70);
    // ramp OUT over the last 3 frames before the seam (frames 17,18,19): 2/3, 1/3, 0
    CHECK(out[0][16] == 1.0f);
    CHECK(out[0][17] == Approx(2.0 / 3).margin(1e-6));
    CHECK(out[0][18] == Approx(1.0 / 3).margin(1e-6));
    CHECK(out[0][19] == Approx(0.0).margin(1e-6));
    // ramp IN over the first 3 frames after the seam: 1/3, 2/3, 1
    CHECK(out[0][20] == Approx(1.0 / 3).margin(1e-6));
    CHECK(out[0][21] == Approx(2.0 / 3).margin(1e-6));
    CHECK(out[0][22] == Approx(1.0).margin(1e-6));
    CHECK(out[0][69] == 1.0f); // true file end: no ramp
    CHECK(out[0][0] == 1.0f);  // true file start: no ramp
}

TEST_CASE("trims: cutTimes / mapTimesFileToEff / mapFileRangesToEff", "[planners][trims]")
{
    using namespace trims;
    std::vector<float> times{0.5f, 1.5f, 2.5f, 3.5f}, str{1, 2, 3, 4};
    auto c = cutTimes(times, str, 1.0, 2.0);
    REQUIRE(c.times.size() == 3);
    CHECK(c.times[0] == 0.5f);
    CHECK(c.times[1] == 1.5f); // 2.5 − 1
    CHECK(c.strengths[1] == 3.0f);
    TrimList t = {{1.0, 2.0, {}}};
    auto m = mapTimesFileToEff(times, str, t);
    REQUIRE(m.times.size() == 3);
    CHECK(m.times[1] == 1.5f);
    auto r = mapFileRangesToEff({{0.0, 4.0}}, t);
    REQUIRE(r.size() == 1); // [0,1) and [2,4) map to [0,1) + [1,3) → merged [0,3)
    CHECK(r[0].first == 0.0);
    CHECK(r[0].second == 3.0);
    auto r2 = mapFileRangesToEff({{1.2, 1.8}}, t);
    CHECK(r2.empty()); // entirely inside the cut
    auto r3 = mapFileRangesToEff({{0.0, 4.0}}, {});
    CHECK(r3.size() == 1);
}

// ── sequencer refit ────────────────────────────────────────────────────────────────────────────────
TEST_CASE("seq refit: the grid is a lens — resolution changes never move notes", "[planners][seq]")
{
    using namespace seq;
    CHECK(acceptStoredResolution(16) == 16);
    CHECK(acceptStoredResolution(24) == 24);
    CHECK(acceptStoredResolution(384) == 384); // divides 384
    CHECK(acceptStoredResolution(7) == 16);
    CHECK(acceptStoredResolution(16.5) == 16);
    CHECK(acceptViewResolution(8, 16) == 8);
    CHECK(acceptViewResolution(12, 16) == 16); // 16 % 12 != 0
    CHECK(clampVel(0.0) == 0.05f);
    CHECK(clampVel(2.0) == 1.0f);
    CHECK(clampVel(std::nan("")) == 1.0f);
    CHECK(columnStride(32, 16) == 2);
    CHECK(columnStride(16, 16) == 1);

    Storage st;
    st.resolution = 16;
    st.grid = {{0}, {}, {}, {1}, {}, {}, {}, {}, {2}}; // notes on 16th steps 0, 3, 8
    st.rev = {{false}, {}, {}, {true}, {}, {}, {}, {}, {false}};
    st.vel = {{1.0f}, {}, {}, {0.5f}, {}, {}, {}, {}, {1.0f}};
    int rec = 4;
    // view 1/8: step 3 is an odd 16th → storage must STAY 16 (a ghost note keeps its time)
    auto r1 = refitStorage(st, 8, 0, 2, rec);
    CHECK(!r1.changed);
    CHECK(st.resolution == 16);
    // view 1/32: storage upsamples to 32, notes at 0, 6, 16
    auto r2 = refitStorage(st, 32, 0, 2, rec);
    CHECK(r2.changed);
    CHECK(st.resolution == 32);
    REQUIRE(st.grid.size() >= 17);
    CHECK(st.grid[0] == std::vector<int>{0});
    CHECK(st.grid[6] == std::vector<int>{1});
    CHECK(st.grid[16] == std::vector<int>{2});
    CHECK(st.vel[6] == std::vector<float>{0.5f});
    CHECK(st.rev[6] == std::vector<bool>{true});
    CHECK(rec == 8); // cursor keeps its place in time (4 × 2)
    // back to view 1/16: drops to 16 again (every note fits), notes back at 0, 3, 8
    auto r3 = refitStorage(st, 16, 0, 2, rec);
    CHECK(r3.changed);
    CHECK(st.resolution == 16);
    CHECK(st.grid[3] == std::vector<int>{1});
    CHECK(st.grid[8] == std::vector<int>{2});
    CHECK(rec == 4);
    // 1/16 → 1/16T (24): lcm 48 → notes at 0, 9, 24 on a 48 grid; coarsest multiple of 24 fitting them = 48
    refitStorage(st, 24, 0, 2, rec);
    CHECK(st.resolution == 48);
    CHECK(st.grid[9] == std::vector<int>{1});
    // a recording floor of 192 raises storage to the finest qualifying grid ≤ 192 that is a multiple of 48
    refitStorage(st, 24, 192, 2, rec);
    CHECK(st.resolution == 192);
    CHECK(st.grid[36] == std::vector<int>{1});
    // floor that would exceed the step cap is ignored: 4 bars × 192 = 768 fits; 4 × 384 wouldn't be offered
    CHECK(stepCount(4, 192) == 768);
    // a pattern with NO notes drops straight to the view
    Storage empty;
    empty.resolution = 192;
    int rs = 0;
    refitStorage(empty, 8, 0, 1, rs);
    CHECK(empty.resolution == 8);
}
