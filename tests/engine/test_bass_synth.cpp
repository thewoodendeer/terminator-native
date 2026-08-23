// BassSynth — the Model D–shaped bass synth (Phase 3.4), the Electron gate `scripts/bass-synth.test.mts` ported:
// the things a human checks by ear, numerically — pitch lands on the note, the envelope opens and releases, every
// filter model stays bounded at full resonance, cutoff changes brightness, poly plays two notes, slides / timed bends
// land where they are told, the MOD matrix moves what it should, and no NaN ever escapes. SR 44100, block 128 (the
// worklet's render quantum) — plus the native-only gates: block-size invariance and zero allocations while rendering.
#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cmath>
#include <cstdint>
#include <vector>

#include "AllocationCounter.h"
#include "terminator/core/BassSynth.h"

using namespace terminator;
using Catch::Approx;

namespace
{
constexpr double SR = 44100.0;
constexpr int BLOCK = 128;

struct Ev
{
    BassSynth::EventKind kind;
    int note;
    float vel;
    double at;    // seconds
    double value; // slide dur / bend semis
    BassTag tag;
};
Ev on(int note, double at, float vel = 1.0f, BassTag tag = BassTag::x)
{
    return {BassSynth::EventKind::on, note, vel, at, 0.0, tag};
}
Ev off(int note, double at, BassTag tag = BassTag::x)
{
    return {BassSynth::EventKind::off, note, 0.0f, at, 0.0, tag};
}
Ev slide(int note, double at, double dur)
{
    return {BassSynth::EventKind::slide, note, 0.0f, at, dur, BassTag::x};
}
Ev bend(double semis, double at)
{
    return {BassSynth::EventKind::bend, 0, 0.0f, at, semis, BassTag::x};
}

std::uint64_t samp(double sec)
{
    return static_cast<std::uint64_t>(std::llround(sec * SR));
}

/// Render `seconds` of the synth with `patch` and the events, returning the left channel.
std::vector<float> render(double seconds, const BassPatch& patch, const std::vector<Ev>& events, int block = BLOCK,
                          std::uint64_t seed = 0x9e3779b97f4a7c15ull)
{
    BassSynth s;
    s.prepare(SR, seed);
    s.setPatch(&patch);
    for (const auto& e : events)
        REQUIRE(s.pushEvent(e.kind, samp(e.at), static_cast<std::uint8_t>(e.note), e.vel, e.value, e.tag));
    const int total = static_cast<int>(std::ceil(seconds * SR / BLOCK)) * BLOCK;
    std::vector<float> out(static_cast<std::size_t>(total), 0.0f), r(static_cast<std::size_t>(total), 0.0f);
    for (int pos = 0; pos < total; pos += block)
    {
        const int n = std::min(block, total - pos);
        s.render(out.data() + pos, r.data() + pos, n, static_cast<std::uint64_t>(pos));
    }
    return out;
}

double rms(const std::vector<float>& a, double fromSec, double toSec)
{
    const auto from = static_cast<std::size_t>(fromSec * SR),
               to = std::min(a.size(), static_cast<std::size_t>(toSec * SR));
    double s = 0.0;
    for (std::size_t i = from; i < to; ++i)
        s += static_cast<double>(a[i]) * static_cast<double>(a[i]);
    return std::sqrt(s / static_cast<double>(std::max<std::size_t>(1, to - from)));
}
double rmsAll(const std::vector<float>& a)
{
    return rms(a, 0.0, static_cast<double>(a.size()) / SR);
}
double peak(const std::vector<float>& a)
{
    double p = 0.0;
    for (float v : a)
        p = std::max(p, std::abs(static_cast<double>(v)));
    return p;
}
bool finite(const std::vector<float>& a)
{
    for (float v : a)
        if (!std::isfinite(v))
            return false;
    return true;
}
/// Fundamental estimate: autocorrelation peak over a plausible bass range (the TS helper).
double fundamentalHz(const std::vector<float>& a, double fromSec, int len)
{
    const auto from = static_cast<std::size_t>(fromSec * SR);
    const int minLag = static_cast<int>(std::floor(SR / 400.0)), maxLag = static_cast<int>(std::floor(SR / 25.0));
    std::vector<double> ac(static_cast<std::size_t>(maxLag) + 1, 0.0);
    double best = 0.0;
    for (int lag = minLag; lag <= maxLag; ++lag)
    {
        double s = 0.0;
        for (int i = 0; i < len; ++i)
        {
            const std::size_t k = from + static_cast<std::size_t>(i);
            if (k + static_cast<std::size_t>(lag) >= a.size())
                break;
            s += static_cast<double>(a[k]) * static_cast<double>(a[k + static_cast<std::size_t>(lag)]);
        }
        ac[static_cast<std::size_t>(lag)] = s;
        best = std::max(best, s);
    }
    for (int lag = minLag + 1; lag < maxLag; ++lag)
    {
        const auto l = static_cast<std::size_t>(lag);
        if (ac[l] >= best * 0.92 && ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1])
            return SR / lag;
    }
    return 0.0;
}
/// Pitch inside a SWEEP (glide / slide / bend): the global autocorrelation maximum, octave-corrected downward. The
/// TS estimator's "first local max within 8 % of the best" is a fine steady-tone reader but trips on a fast sweep
/// (it picked a spurious 361 Hz peak 50 ms into a 65→131 Hz glide); the global maximum sits on the window's period.
double sweepHz(const std::vector<float>& a, double fromSec, int len)
{
    const auto from = static_cast<std::size_t>(fromSec * SR);
    const int minLag = static_cast<int>(std::floor(SR / 400.0)), maxLag = static_cast<int>(std::floor(SR / 25.0));
    std::vector<double> ac(static_cast<std::size_t>(maxLag) + 1, 0.0);
    int bestLag = minLag;
    for (int lag = minLag; lag <= maxLag; ++lag)
    {
        double s = 0.0;
        for (int i = 0; i < len; ++i)
        {
            const std::size_t k = from + static_cast<std::size_t>(i);
            if (k + static_cast<std::size_t>(lag) >= a.size())
                break;
            s += static_cast<double>(a[k]) * static_cast<double>(a[k + static_cast<std::size_t>(lag)]);
        }
        ac[static_cast<std::size_t>(lag)] = s;
        if (s > ac[static_cast<std::size_t>(bestLag)])
            bestLag = lag;
    }
    while (bestLag / 2 >= minLag &&
           ac[static_cast<std::size_t>(bestLag / 2)] >= 0.9 * ac[static_cast<std::size_t>(bestLag)])
        bestLag /= 2;
    return SR / bestLag;
}
/// "brightness": RMS of the first difference over RMS.
double brightness(const std::vector<float>& a, double fromSec, double toSec)
{
    const auto from = static_cast<std::size_t>(fromSec * SR),
               to = std::min(a.size(), static_cast<std::size_t>(toSec * SR));
    double s = 0.0;
    for (std::size_t i = from + 1; i < to; ++i)
    {
        const double d = static_cast<double>(a[i]) - static_cast<double>(a[i - 1]);
        s += d * d;
    }
    return std::sqrt(s / static_cast<double>(to - from)) / (rms(a, fromSec, toSec) + 1e-9);
}
double midiHz(int n)
{
    return 440.0 * std::pow(2.0, (n - 69) / 12.0);
}
bool near(double f, double want, double tol = 0.03)
{
    return std::abs(f - want) / want < tol;
}
constexpr int NOTE = 36; // C1 = 65.41 Hz

BassPatch plain() // the TS tests' usual base: open-ish filter, no drift, no sub, no post drive
{
    BassPatch p = BassPatch::defaults();
    p.cutoff = 4000.0;
    p.envAmt = 0.0;
    p.drift = 0.0;
    p.subLevel = 0.0;
    p.postDrive = 0.0;
    return p;
}
} // namespace

TEST_CASE("BassSynth: default patch - pitch on the note, the envelope opens and releases, sane level, no NaN", "[bass]")
{
    BassPatch p = BassPatch::defaults();
    p.cutoff = 2000.0;
    p.reso = 0.1;
    p.envAmt = 0.0;
    p.drift = 0.0;
    p.subLevel = 0.0;
    p.postDrive = 0.0;
    p.postGlue = 0.0;
    auto y = render(1.5, p, {on(NOTE, 0.0), off(NOTE, 0.8)});
    REQUIRE(finite(y));
    const double pk = peak(y);
    REQUIRE(pk > 0.1);
    REQUIRE(pk < 1.3);
    REQUIRE(rms(y, 0.4, 0.7) > 0.05);  // sustain
    REQUIRE(rms(y, 1.3, 1.5) < 0.002); // released
    REQUIRE(near(fundamentalHz(y, 0.3, 8192), midiHz(NOTE)));
    REQUIRE(rms(y, 0.0, 0.001) < rms(y, 0.05, 0.1)); // attack rising (no click)
}

TEST_CASE("BassSynth: every filter model is bounded at full resonance, opens with cutoff, ladder/diode self-oscillate",
          "[bass]")
{
    for (BassFilterModel model : {BassFilterModel::ladder, BassFilterModel::ota, BassFilterModel::diode})
    {
        for (double reso : {0.0, 1.0})
        {
            BassPatch p = BassPatch::defaults();
            p.filterModel = model;
            p.cutoff = 300.0;
            p.reso = reso;
            p.envAmt = 0.0;
            p.filterDrive = 0.5;
            p.drift = 0.0;
            p.postDrive = 0.3;
            p.postGlue = 0.3;
            auto y = render(1.0, p, {on(NOTE, 0.0), off(NOTE, 0.6)});
            INFO("model " << static_cast<int>(model) << " reso " << reso);
            REQUIRE(finite(y));
            REQUIRE(peak(y) < 1.6);
            REQUIRE(peak(y) > 0.05);
        }
        BassPatch lo = BassPatch::defaults(), hi = BassPatch::defaults();
        lo.filterModel = hi.filterModel = model;
        lo.reso = hi.reso = 0.2;
        lo.envAmt = hi.envAmt = 0.0;
        lo.drift = hi.drift = 0.0;
        lo.postDrive = hi.postDrive = 0.0;
        lo.cutoff = 120.0;
        hi.cutoff = 6000.0;
        const auto yl = render(0.6, lo, {on(NOTE, 0.0)});
        const auto yh = render(0.6, hi, {on(NOTE, 0.0)});
        const double bLo = brightness(yl, 0.2, 0.5), bHi = brightness(yh, 0.2, 0.5);
        INFO("model " << static_cast<int>(model) << " lo " << bLo << " hi " << bHi);
        REQUIRE(bHi > bLo * 1.5);
        if (model != BassFilterModel::ota)
        {
            // self-oscillation: full reso, no oscillators, a whisper of noise → it sings
            BassPatch p = BassPatch::defaults();
            for (auto& o : p.osc)
                o.level = 0.0;
            p.subLevel = 0.0;
            p.noiseLevel = 0.02;
            p.filterModel = model;
            p.cutoff = 200.0;
            p.reso = 1.0;
            p.envAmt = 0.0;
            p.kbd = 0.0;
            p.drift = 0.0;
            p.postDrive = 0.0;
            p.postGlue = 0.0;
            auto y = render(1.5, p, {on(NOTE, 0.0)});
            REQUIRE(finite(y));
            REQUIRE(rms(y, 1.0, 1.4) > 0.01);
        }
    }
}

TEST_CASE("BassSynth: every oscillator wave hits the note, no DC", "[bass]")
{
    for (BassWave w : {BassWave::tri, BassWave::shark, BassWave::saw, BassWave::square, BassWave::pulse,
                       BassWave::narrow, BassWave::sine})
    {
        BassPatch p = BassPatch::defaults();
        p.osc[0].wave = w;
        p.osc[0].level = 0.8;
        p.osc[0].on = true;
        p.osc[1].on = false;
        p.osc[2].on = false;
        p.subLevel = 0.0;
        p.cutoff = 8000.0;
        p.reso = 0.0;
        p.envAmt = 0.0;
        p.drift = 0.0;
        p.postDrive = 0.0;
        p.postGlue = 0.0;
        auto y = render(0.7, p, {on(40, 0.0)});
        INFO("wave " << static_cast<int>(w));
        REQUIRE(finite(y));
        REQUIRE(near(fundamentalHz(y, 0.3, 8192), midiHz(40)));
        REQUIRE(peak(y) > 0.1);
        REQUIRE(peak(y) < 1.3);
        double mean = 0.0;
        const auto a = static_cast<std::size_t>(0.3 * SR), b = static_cast<std::size_t>(0.6 * SR);
        for (std::size_t i = a; i < b; ++i)
            mean += static_cast<double>(y[i]);
        mean /= static_cast<double>(b - a);
        REQUIRE(std::abs(mean) < 0.05);
    }
}

TEST_CASE("BassSynth: the sub an octave down moves the fundamental", "[bass]")
{
    BassPatch p = BassPatch::defaults();
    p.osc[0].level = 0.0;
    p.osc[1].on = false;
    p.osc[2].on = false;
    p.subLevel = 0.8;
    p.subOctave = 1;
    p.subWave = BassWave::sine;
    p.cutoff = 8000.0;
    p.envAmt = 0.0;
    p.drift = 0.0;
    p.postDrive = 0.0;
    auto y = render(0.7, p, {on(48, 0.0)});
    REQUIRE(near(fundamentalHz(y, 0.3, 8192), midiHz(36)));
}

TEST_CASE("BassSynth: mono legato + glide - the second note glides, the note-off falls back to the held note", "[bass]")
{
    BassPatch p = plain();
    p.voices = 1;
    p.legato = true;
    p.glide = 0.15;
    auto y = render(1.6, p, {on(36, 0.0), on(48, 0.5), off(48, 1.0)});
    const double fMid = sweepHz(y, 0.55, 4096), fEnd = fundamentalHz(y, 0.85, 8192),
                 fBack = fundamentalHz(y, 1.4, 8192);
    INFO("mid " << fMid << " end " << fEnd << " back " << fBack);
    REQUIRE(fMid > midiHz(36) * 1.05);
    REQUIRE(fMid < midiHz(48) * 0.98);
    REQUIRE(near(fEnd, midiHz(48)));
    REQUIRE(near(fBack, midiHz(36)));
    REQUIRE(rms(y, 0.5, 0.52) > rms(y, 0.45, 0.5) * 0.5); // legato: no retrigger dip
}

TEST_CASE("BassSynth: poly - two notes louder than one, both release", "[bass]")
{
    BassPatch p = plain();
    p.voices = 4;
    p.postGlue = 0.0;
    auto one = render(1.0, p, {on(36, 0.0), off(36, 0.5)});
    auto two = render(1.0, p, {on(36, 0.0), on(43, 0.0), off(36, 0.5), off(43, 0.5)});
    REQUIRE(rms(two, 0.2, 0.4) > rms(one, 0.2, 0.4) * 1.15);
    REQUIRE(rms(two, 0.9, 1.0) < 0.003);
}

TEST_CASE("BassSynth: a scheduled note is silent before its sample and sounds after it", "[bass]")
{
    BassPatch p = plain();
    auto y = render(0.6, p, {on(40, 0.25)});
    REQUIRE(rms(y, 0.0, 0.24) < 1e-6);
    REQUIRE(rms(y, 0.3, 0.5) > 0.05);
    // sample-exact: the very first non-zero sample is the note's sample (the attack RC opens on the first sample)
    const auto at = static_cast<std::size_t>(samp(0.25));
    std::size_t first = y.size();
    for (std::size_t i = 0; i < y.size(); ++i)
        if (y[i] != 0.0f)
        {
            first = i;
            break;
        }
    REQUIRE(first == at);
}

TEST_CASE("BassSynth: clear(tag) drops only that tag's pending events", "[bass]")
{
    BassSynth s;
    s.prepare(SR);
    BassPatch p = plain();
    s.setPatch(&p);
    REQUIRE(s.pushEvent(BassSynth::EventKind::on, samp(0.3), 40, 1.0f, 0.0, BassTag::seq));
    REQUIRE(s.pushEvent(BassSynth::EventKind::on, samp(0.3), 52, 1.0f, 0.0, BassTag::live));
    s.clear(BassTag::seq, false);
    REQUIRE(s.pendingEvents() == 1);
    const int total = static_cast<int>(std::ceil(0.6 * SR / BLOCK)) * BLOCK;
    std::vector<float> out(static_cast<std::size_t>(total), 0.0f);
    for (int pos = 0; pos < total; pos += BLOCK)
        s.render(out.data() + pos, nullptr, BLOCK, static_cast<std::uint64_t>(pos));
    REQUIRE(near(fundamentalHz(out, 0.4, 8192), midiHz(52)));
}

TEST_CASE("BassSynth: MOD matrix - a slow LFO on the cutoff moves brightness; a trigger env opens then returns",
          "[bass]")
{
    BassPatch base = BassPatch::defaults();
    base.drift = 0.0;
    base.subLevel = 0.0;
    base.cutoff = 150.0;
    base.reso = 0.1;
    base.envAmt = 0.0;
    base.postDrive = 0.0;
    base.postGlue = 0.0;
    auto still = render(2.0, base, {on(NOTE, 0.0)});
    BassPatch wobP = base;
    wobP.modLfo[0] = {1.0, BassLfoWave::sine, false};
    wobP.mods[0] = {BassModSource::lfo1, BassModTarget::filterCutoff, 0.8};
    wobP.numMods = 1;
    auto wob = render(2.0, wobP, {on(NOTE, 0.0)});
    auto win = [&](const std::vector<float>& a, int i) { return brightness(a, 0.5 + i * 0.25, 0.7 + i * 0.25); };
    double sMin = 1e9, sMax = -1e9, wMin = 1e9, wMax = -1e9;
    for (int i = 0; i < 4; ++i)
    {
        sMin = std::min(sMin, win(still, i));
        sMax = std::max(sMax, win(still, i));
        wMin = std::min(wMin, win(wob, i));
        wMax = std::max(wMax, win(wob, i));
    }
    REQUIRE(finite(wob));
    REQUIRE(wMax - wMin > (sMax - sMin) * 4.0 + 0.002);
    BassPatch trigP = base;
    trigP.modTrig[0] = {0.005, 0.25, BassTrigShape::exp};
    trigP.mods[0] = {BassModSource::trigA, BassModTarget::filterCutoff, 1.0};
    trigP.numMods = 1;
    auto trig = render(1.5, trigP, {on(NOTE, 0.0)});
    const double early = brightness(trig, 0.02, 0.08), late = brightness(trig, 1.0, 1.3),
                 ref = brightness(still, 1.0, 1.3);
    REQUIRE(finite(trig));
    REQUIRE(early > late * 1.5);
    REQUIRE(std::abs(late - ref) < ref * 0.35 + 0.002);
}

TEST_CASE("BassSynth: SHAPE morph - finite everywhere, lands on tri/saw/sine at its points, climbs tri->saw", "[bass]")
{
    BassPatch base = BassPatch::defaults();
    base.cutoff = 8000.0;
    base.reso = 0.0;
    base.envAmt = 0.0;
    base.drift = 0.0;
    base.subLevel = 0.0;
    base.postDrive = 0.0;
    base.postGlue = 0.0;
    base.ampEnv = {0.001, 0.1, 1.0, 0.05};
    auto one = [&](BassWave w, double morph)
    {
        BassPatch p = base;
        p.osc[0] = {true, w, 0.0, 0.0, 0.0, 0.8, 0.15, morph};
        p.osc[1].on = false;
        p.osc[2].on = false;
        return render(0.5, p, {on(NOTE, 0.0), off(NOTE, 0.45)});
    };
    auto seg = [&](const std::vector<float>& y) { return brightness(y, 0.2, 0.4); };
    const double positions[] = {0.0, 0.1, 0.2, 0.33, 0.5, 0.66, 0.8, 0.9, 1.0};
    std::vector<double> br;
    for (double m : positions)
    {
        auto y = one(BassWave::morph, m);
        INFO("morph " << m);
        REQUIRE(finite(y));
        REQUIRE(rms(y, 0.2, 0.4) > 0.03);
        br.push_back(seg(y));
    }
    const double tri = seg(one(BassWave::tri, 0.0)), sine = seg(one(BassWave::sine, 0.0)),
                 saw = seg(one(BassWave::saw, 0.0));
    REQUIRE(std::abs(br[0] - tri) < 0.02);
    REQUIRE(std::abs(br.back() - sine) < 0.02);
    REQUIRE(std::abs(br[3] - saw) < 0.03);
    REQUIRE(br[0] < br[1]);
    REQUIRE(br[1] < br[2]);
    REQUIRE(br[2] <= br[3] + 1e-6);
}

TEST_CASE("BassSynth: SLIDE notes bend what sounds over their length; the original note-off releases; alone = silent",
          "[bass]")
{
    BassPatch p = plain();
    p.voices = 1;
    p.legato = true;
    p.glide = 0.0;
    p.ampEnv = {0.002, 0.1, 1.0, 0.03};
    auto y = render(1.6, p, {on(36, 0.0), slide(43, 0.5, 0.3), off(36, 1.2)});
    const double fBefore = fundamentalHz(y, 0.3, 8192), fMid = sweepHz(y, 0.62, 2048),
                 fAfter = fundamentalHz(y, 0.95, 8192);
    INFO("before " << fBefore << " mid " << fMid << " after " << fAfter);
    REQUIRE(near(fBefore, midiHz(36)));
    REQUIRE(fMid > midiHz(36) * 1.05);
    REQUIRE(fMid < midiHz(43) * 0.97);
    REQUIRE(near(fAfter, midiHz(43)));
    REQUIRE(rms(y, 1.4, 1.55) < 0.01);
    auto silent = render(0.6, p, {slide(43, 0.1, 0.2)});
    REQUIRE(rmsAll(silent) < 1e-4);
    REQUIRE(finite(y));
    REQUIRE(finite(silent));
}

TEST_CASE("BassSynth: timed BEND events land at their sample - a stepwise ramp 0->+7 st glides through", "[bass]")
{
    BassPatch p = plain();
    p.voices = 1;
    p.legato = true;
    p.glide = 0.0;
    p.ampEnv = {0.002, 0.1, 1.0, 0.03};
    std::vector<Ev> evs = {on(36, 0.001), off(36, 1.4)};
    for (int i = 0; i <= 30; ++i)
        evs.push_back(bend(7.0 * i / 30.0, 0.6 + 0.3 * i / 30.0));
    auto y = render(1.5, p, evs);
    const double fBefore = fundamentalHz(y, 0.3, 8192), fMid = sweepHz(y, 0.74, 2048),
                 fAfter = fundamentalHz(y, 1.05, 8192);
    INFO("before " << fBefore << " mid " << fMid << " after " << fAfter);
    REQUIRE(near(fBefore, midiHz(36)));
    REQUIRE(fMid > midiHz(36) * 1.05);
    REQUIRE(fMid < midiHz(43) * 0.97);
    REQUIRE(near(fAfter, midiHz(43)));
    REQUIRE(finite(y));
}

TEST_CASE("BassSynth: the output is block-size invariant - 128 vs 64 vs 512 vs 37 render bit-identically", "[bass]")
{
    // drift + pink noise + an S&H LFO + a key-synced LFO + the mixer drive → every per-quantum branch runs
    BassPatch p = BassPatch::defaults();
    p.drift = 0.5;
    p.noiseLevel = 0.05;
    p.noisePink = true;
    p.modLfo[2] = {8.0, BassLfoWave::sh, true};
    p.mods[0] = {BassModSource::lfo3, BassModTarget::filterCutoff, 0.5};
    p.mods[1] = {BassModSource::trigA, BassModTarget::postTone, 0.3};
    p.numMods = 2;
    p.voices = 3;
    const std::vector<Ev> evs = {on(36, 0.0), on(43, 0.1), off(36, 0.5), on(40, 0.52), off(43, 0.9), off(40, 1.0)};
    const auto a = render(1.2, p, evs, 128);
    const auto b = render(1.2, p, evs, 64);
    const auto c = render(1.2, p, evs, 512);
    const auto d = render(1.2, p, evs, 37);
    REQUIRE(a.size() == b.size());
    REQUIRE(rms(a, 0.2, 0.4) > 0.01);
    for (std::size_t i = 0; i < a.size(); ++i)
    {
        REQUIRE(a[i] == b[i]);
        REQUIRE(a[i] == c[i]);
        REQUIRE(a[i] == d[i]);
    }
}

TEST_CASE("BassSynth: render allocates nothing (RT), the meter reports, panic silences at once", "[bass][rt]")
{
    BassSynth s;
    s.prepare(48000.0);
    BassPatch p = BassPatch::defaults();
    p.voices = 8;
    p.mods[0] = {BassModSource::lfo1, BassModTarget::filterCutoff, 0.5};
    p.numMods = 1;
    s.setPatch(&p);
    for (int i = 0; i < 8; ++i)
        REQUIRE(s.pushEvent(BassSynth::EventKind::on, 0, static_cast<std::uint8_t>(36 + i), 0.9f, 0.0, BassTag::live));
    std::vector<float> l(512), r(512);
    REQUIRE(test::allocationsDuring(
                [&]
                {
                    for (int b = 0; b < 200; ++b)
                        s.render(l.data(), r.data(), 512, static_cast<std::uint64_t>(b) * 512);
                }) == 0);
    REQUIRE(s.activeVoices() == 8);
    REQUIRE(s.meterLevel() > 0.01f);
    REQUIRE(s.meterVoices() == 8);
    std::uint64_t mask[2];
    s.activeNoteMask(mask);
    REQUIRE(mask[0] == (0xFFull << 36));
    s.panic();
    REQUIRE(s.activeVoices() == 0);
    for (int b = 200; b < 260; ++b) // the TONE / DC-blocker states ring down; no voice is rendering
    {
        std::fill(l.begin(), l.end(), 0.0f);
        s.render(l.data(), r.data(), 512, static_cast<std::uint64_t>(b) * 512);
    }
    REQUIRE(peak(l) < 1e-4);
}
