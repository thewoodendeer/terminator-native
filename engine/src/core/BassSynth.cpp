#include "terminator/core/BassSynth.h"

#include <algorithm>
#include <cmath>

namespace terminator
{

namespace
{
constexpr double kTwoPi = 6.283185307179586476925286766559;
constexpr double kVT = 0.312;
constexpr BassWave kMorphOrder[7] = {BassWave::tri,   BassWave::shark,  BassWave::saw, BassWave::square,
                                     BassWave::pulse, BassWave::narrow, BassWave::sine};

// t = phase in [0,1), dt = phase increment. Returns the residual to ADD at a discontinuity of height 1.
inline double polyBlep(double t, double dt) noexcept TERMINATOR_NONBLOCKING
{
    if (t < dt)
    {
        t /= dt;
        return t + t - t * t - 1.0;
    }
    if (t > 1.0 - dt)
    {
        t = (t - 1.0) / dt;
        return t * t + t + t + 1.0;
    }
    return 0.0;
}

// Fast tanh (Padé 7/6) — the worklet's ftanh, clamped at ±4.97.
inline double ftanh(double x) noexcept TERMINATOR_NONBLOCKING
{
    if (x > 4.97)
        return 1.0;
    if (x < -4.97)
        return -1.0;
    const double x2 = x * x;
    return x * (135135.0 + x2 * (17325.0 + x2 * (378.0 + x2))) /
           (135135.0 + x2 * (62370.0 + x2 * (3150.0 + x2 * 28.0)));
}

inline double jsMod1(double x) noexcept TERMINATOR_NONBLOCKING
{
    // JS `(x) % 1` for x ≥ 0
    return x - std::floor(x);
}
} // namespace

// ───────────────────────────────── patch leaves / ranges ─────────────────────────────────
double* BassPatch::leaf(BassModTarget t) noexcept
{
    switch (t)
    {
    case BassModTarget::osc1Level:
        return &osc[0].level;
    case BassModTarget::osc1Semi:
        return &osc[0].semi;
    case BassModTarget::osc1Fine:
        return &osc[0].fine;
    case BassModTarget::osc1Pw:
        return &osc[0].pw;
    case BassModTarget::osc1Morph:
        return &osc[0].morph;
    case BassModTarget::osc2Level:
        return &osc[1].level;
    case BassModTarget::osc2Semi:
        return &osc[1].semi;
    case BassModTarget::osc2Fine:
        return &osc[1].fine;
    case BassModTarget::osc2Pw:
        return &osc[1].pw;
    case BassModTarget::osc2Morph:
        return &osc[1].morph;
    case BassModTarget::osc3Level:
        return &osc[2].level;
    case BassModTarget::osc3Semi:
        return &osc[2].semi;
    case BassModTarget::osc3Fine:
        return &osc[2].fine;
    case BassModTarget::osc3Pw:
        return &osc[2].pw;
    case BassModTarget::osc3Morph:
        return &osc[2].morph;
    case BassModTarget::subLevel:
        return &subLevel;
    case BassModTarget::noiseLevel:
        return &noiseLevel;
    case BassModTarget::mixerDrive:
        return &mixerDrive;
    case BassModTarget::filterCutoff:
        return &cutoff;
    case BassModTarget::filterReso:
        return &reso;
    case BassModTarget::filterEnvAmt:
        return &envAmt;
    case BassModTarget::filterKbd:
        return &kbd;
    case BassModTarget::filterDrive:
        return &filterDrive;
    case BassModTarget::filtEnvA:
        return &filtEnv.a;
    case BassModTarget::filtEnvD:
        return &filtEnv.d;
    case BassModTarget::filtEnvS:
        return &filtEnv.s;
    case BassModTarget::filtEnvR:
        return &filtEnv.r;
    case BassModTarget::ampEnvA:
        return &ampEnv.a;
    case BassModTarget::ampEnvD:
        return &ampEnv.d;
    case BassModTarget::ampEnvS:
        return &ampEnv.s;
    case BassModTarget::ampEnvR:
        return &ampEnv.r;
    case BassModTarget::glide:
        return &glide;
    case BassModTarget::drift:
        return &drift;
    case BassModTarget::velAmp:
        return &velAmp;
    case BassModTarget::velFilt:
        return &velFilt;
    case BassModTarget::postDrive:
        return &postDrive;
    case BassModTarget::postTone:
        return &postTone;
    case BassModTarget::postGlue:
        return &postGlue;
    case BassModTarget::postGain:
        return &postGain;
    case BassModTarget::lfo1Rate:
        return &modLfo[0].rate;
    case BassModTarget::lfo2Rate:
        return &modLfo[1].rate;
    case BassModTarget::lfo3Rate:
        return &modLfo[2].rate;
    case BassModTarget::trigARamp:
        return &modTrig[0].ramp;
    case BassModTarget::trigAFall:
        return &modTrig[0].fall;
    case BassModTarget::trigBRamp:
        return &modTrig[1].ramp;
    case BassModTarget::trigBFall:
        return &modTrig[1].fall;
    case BassModTarget::none:
    case BassModTarget::count:
    default:
        return nullptr;
    }
}

BassPatch::Range BassPatch::rangeOf(BassModTarget t) noexcept
{
    // the worklet's modRange(path) — by the path's shape
    switch (t)
    {
    case BassModTarget::filterCutoff:
        return {20.0, 16000.0, true, 5.0};
    case BassModTarget::postTone:
        return {400.0, 20000.0, true, 4.0};
    case BassModTarget::filtEnvA:
    case BassModTarget::filtEnvD:
    case BassModTarget::filtEnvR:
    case BassModTarget::ampEnvA:
    case BassModTarget::ampEnvD:
    case BassModTarget::ampEnvR:
        return {0.001, 4.0, true, 3.0}; // /\.(a|d|r)$/
    case BassModTarget::lfo1Rate:
    case BassModTarget::lfo2Rate:
    case BassModTarget::lfo3Rate:
        return {0.05, 30.0, true, 3.0};
    case BassModTarget::osc1Fine:
    case BassModTarget::osc2Fine:
    case BassModTarget::osc3Fine:
        return {-50.0, 50.0, false, 0.0};
    case BassModTarget::osc1Semi:
    case BassModTarget::osc2Semi:
    case BassModTarget::osc3Semi:
        return {-12.0, 12.0, false, 0.0};
    case BassModTarget::filterEnvAmt:
        return {-1.0, 1.0, false, 0.0};
    case BassModTarget::postGain:
        return {0.0, 1.5, false, 0.0};
    case BassModTarget::osc1Pw:
    case BassModTarget::osc2Pw:
    case BassModTarget::osc3Pw:
        return {0.05, 0.5, false, 0.0};
    case BassModTarget::osc1Morph:
    case BassModTarget::osc2Morph:
    case BassModTarget::osc3Morph:
        return {0.0, 1.0, false, 0.0};
    case BassModTarget::glide:
        return {0.0, 1.0, false, 0.0};
    default:
        return {0.0, 1.0, false, 0.0}; // anything unlisted = 0..1 linear
    }
}

// ───────────────────────────────── PRNG ─────────────────────────────────
double BassSynth::rnd() noexcept TERMINATOR_NONBLOCKING
{
    // xorshift64*: 2^64−1 period, the top 53 bits → [0,1)
    std::uint64_t x = rng_;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    rng_ = x;
    const std::uint64_t r = x * 0x2545F4914F6CDD1Dull;
    return static_cast<double>(r >> 11) * (1.0 / 9007199254740992.0);
}

// ───────────────────────────────── Osc ─────────────────────────────────
double BassSynth::Osc::shapeAt(BassWave w, double t, double dt, double pw) const noexcept TERMINATOR_NONBLOCKING
{
    switch (w)
    {
    case BassWave::sine:
        return std::sin(kTwoPi * t);
    case BassWave::saw:
        return 2.0 * t - 1.0 - polyBlep(t, dt);
    case BassWave::square:
    case BassWave::pulse:
    case BassWave::narrow:
    {
        const double wd = w == BassWave::square ? 0.5 : (w == BassWave::pulse ? 0.25 : pw);
        double v = t < wd ? 1.0 : -1.0;
        v += polyBlep(t, dt);
        v -= polyBlep(jsMod1(t + 1.0 - wd), dt);
        return v - (2.0 * wd - 1.0); // remove the DC an asymmetric pulse carries
    }
    case BassWave::tri:
        return tri;
    case BassWave::shark:
        return 0.62 * triS + 0.5 * (2.0 * t - 1.0 - polyBlep(t, dt));
    case BassWave::morph:
    default:
        return 2.0 * t - 1.0 - polyBlep(t, dt);
    }
}

double BassSynth::Osc::next(double freq, double sr, BassWave w, double pw, double morph) noexcept TERMINATOR_NONBLOCKING
{
    const double dt = freq / sr;
    if (dt >= 0.5)
        return 0.0; // above Nyquist: silence, don't alias
    double t = phase;
    // band-limited triangle = leaky-integrated BLEP square; both integrators run every sample
    double sq = t < 0.5 ? 1.0 : -1.0;
    sq += polyBlep(t, dt);
    sq -= polyBlep(jsMod1(t + 0.5), dt);
    tri = tri * (1.0 - 4.0 * dt) + sq * 4.0 * dt;
    triS = triS * (1.0 - 4.0 * dt) + sq * 4.0 * dt;
    double out;
    if (w == BassWave::morph)
    {
        const double m = std::isfinite(morph) ? std::clamp(morph, 0.0, 1.0) : 0.0;
        const double pos = m * 6.0;
        const int i = std::min(5, static_cast<int>(std::floor(pos)));
        const double f = pos - static_cast<double>(i);
        const double a = shapeAt(kMorphOrder[i], t, dt, pw);
        out = f > 0.0005 ? a * (1.0 - f) + shapeAt(kMorphOrder[i + 1], t, dt, pw) * f : a;
    }
    else
        out = shapeAt(w, t, dt, pw);
    t += dt;
    if (t >= 1.0)
        t -= 1.0;
    phase = t;
    return out;
}

// ───────────────────────────────── ADSR ─────────────────────────────────
void BassSynth::ADSR::set(double aa, double dd, double ss, double rr, double sr) noexcept TERMINATOR_NONBLOCKING
{
    const double na = std::max(0.0005, aa), nd = std::max(0.001, dd), nr = std::max(0.002, rr);
    s = std::min(1.0, std::max(0.0, ss));
    if (na != a || nd != d || nr != r || sr != cachedSr)
    {
        a = na;
        d = nd;
        r = nr;
        cachedSr = sr;
        ka = 1.0 - std::exp(-1.0 / (a * sr));
        kd = 1.0 - std::exp(-1.0 / (d * sr * 0.6));
        kr = 1.0 - std::exp(-1.0 / (r * sr * 0.6));
    }
}
void BassSynth::ADSR::gate(bool on) noexcept TERMINATOR_NONBLOCKING
{
    if (on)
        stage = 1;
    else if (stage != 0)
        stage = 4;
}
double BassSynth::ADSR::next() noexcept TERMINATOR_NONBLOCKING
{
    switch (stage)
    {
    case 1: // attack: RC toward 1.25 so it hits 1 with a convex knee
        v += (1.25 - v) * ka;
        if (v >= 1.0)
        {
            v = 1.0;
            stage = 2;
        }
        break;
    case 2: // decay: exponential toward sustain
        v += (s - v) * kd;
        if (v - s < 0.0005)
        {
            v = s;
            stage = 3;
        }
        break;
    case 3:
        v = s;
        break;
    case 4: // release
        v += (0.0 - v) * kr;
        if (v < 0.0004)
        {
            v = 0.0;
            stage = 0;
        }
        break;
    default:
        v = 0.0;
    }
    return v;
}

// ───────────────────────────────── Filters ─────────────────────────────────
void BassSynth::Ladder::reset() noexcept
{
    for (int i = 0; i < 4; ++i)
        V[i] = dV[i] = tV[i] = 0.0;
}
void BassSynth::Ladder::setCutoff(double hz, double sr2) noexcept TERMINATOR_NONBLOCKING
{
    const double x = 3.141592653589793 * hz / sr2;
    g = 4.0 * 3.141592653589793 * kVT * hz * (1.0 - x) / (1.0 + x);
}
double BassSynth::Ladder::process(double inp, double res, double drive, int poles,
                                  double sr2) noexcept TERMINATOR_NONBLOCKING
{
    const double inv2VT = 1.0 / (2.0 * kVT), h = 1.0 / (2.0 * sr2);
    double out = 0.0;
    for (int k = 0; k < 2; ++k) // 2× oversample (ZOH input)
    {
        const double dV0 = -g * (ftanh((drive * inp + res * V[3]) * inv2VT) + tV[0]);
        V[0] += (dV0 + dV[0]) * h;
        dV[0] = dV0;
        tV[0] = ftanh(V[0] * inv2VT);
        const double dV1 = g * (tV[0] - tV[1]);
        V[1] += (dV1 + dV[1]) * h;
        dV[1] = dV1;
        tV[1] = ftanh(V[1] * inv2VT);
        const double dV2 = g * (tV[1] - tV[2]);
        V[2] += (dV2 + dV[2]) * h;
        dV[2] = dV2;
        tV[2] = ftanh(V[2] * inv2VT);
        const double dV3 = g * (tV[2] - tV[3]);
        V[3] += (dV3 + dV[3]) * h;
        dV[3] = dV3;
        tV[3] = ftanh(V[3] * inv2VT);
        out = V[poles - 1];
    }
    return -out;
}

void BassSynth::Svf::reset() noexcept
{
    ic1 = ic2 = 0.0;
}
void BassSynth::Svf::set(double hz, double res, double sr) noexcept TERMINATOR_NONBLOCKING
{
    g = std::tan(3.141592653589793 * std::min(0.49 * sr, hz) / sr);
    k = 2.0 - 1.98 * std::min(1.0, std::max(0.0, res));
    a1 = 1.0 / (1.0 + g * (g + k));
    a2 = g * a1;
    a3 = g * a2;
}
double BassSynth::Svf::process(double v0, BassFilterMode mode) noexcept TERMINATOR_NONBLOCKING
{
    const double v3 = v0 - ic2;
    const double v1 = a1 * ic1 + a2 * v3;
    const double v2 = ic2 + a2 * ic1 + a3 * v3;
    // gentle OTA saturation of the state — keeps self-oscillation bounded
    ic1 = ftanh(2.0 * v1 - ic1);
    ic2 = ftanh(2.0 * v2 - ic2);
    if (mode == BassFilterMode::bp)
        return v1;
    if (mode == BassFilterMode::hp)
        return v0 - k * v1 - v2;
    return v2;
}

void BassSynth::Diode::reset() noexcept
{
    for (int i = 0; i < 4; ++i)
        z[i] = fb[i] = 0.0;
}
void BassSynth::Diode::set(double hz, double sr) noexcept TERMINATOR_NONBLOCKING
{
    const double g = std::tan(3.141592653589793 * std::min(0.45 * sr, hz) / sr);
    const double G4 = 0.5 * g / (1.0 + g);
    const double G3 = 0.5 * g / (1.0 + g - 0.5 * g * G4);
    const double G2 = 0.5 * g / (1.0 + g - 0.5 * g * G3);
    const double G1 = g / (1.0 + g - g * G2);
    gamma = G4 * G3 * G2 * G1;
    SG[0] = G4 * G3 * G2;
    SG[1] = G4 * G3;
    SG[2] = G4;
    SG[3] = 1.0;
    alpha = g / (1.0 + g);
    beta[0] = 1.0 / (1.0 + g - g * G2);
    gam[0] = 1.0 + G1 * G2;
    delta[0] = g;
    eps[0] = G2;
    beta[1] = 1.0 / (1.0 + g - 0.5 * g * G3);
    gam[1] = 1.0 + G2 * G3;
    delta[1] = 0.5 * g;
    eps[1] = G3;
    beta[2] = 1.0 / (1.0 + g - 0.5 * g * G4);
    gam[2] = 1.0 + G3 * G4;
    delta[2] = 0.5 * g;
    eps[2] = G4;
    beta[3] = 1.0 / (1.0 + g);
    gam[3] = 1.0;
    delta[3] = 0.0;
    eps[3] = 0.0;
}
double BassSynth::Diode::fbOut(int i) const noexcept TERMINATOR_NONBLOCKING
{
    return beta[i] * (z[i] + fb[i] * delta[i]);
}
double BassSynth::Diode::stage(int i, double xn) noexcept TERMINATOR_NONBLOCKING
{
    const double xin = xn * gam[i] + fb[i] + eps[i] * fbOut(i);
    const double vn = (a0[i] * xin - z[i]) * alpha;
    const double out = vn + z[i];
    z[i] = vn + out;
    return out;
}
double BassSynth::Diode::process(double xn, double K) noexcept TERMINATOR_NONBLOCKING
{
    fb[2] = fbOut(3);
    fb[1] = fbOut(2);
    fb[0] = fbOut(1);
    const double sigma = SG[0] * fbOut(0) + SG[1] * fbOut(1) + SG[2] * fbOut(2) + SG[3] * fbOut(3);
    xn *= 1.0 + 0.3 * K; // Zavalishin: input compensation so the level holds up as K rises
    const double un = ftanh((xn - K * sigma) / (1.0 + K * gamma));
    return stage(3, stage(2, stage(1, stage(0, un))));
}

// ───────────────────────────────── Voice ─────────────────────────────────
void BassSynth::Voice::start(int n, double v, bool legato, double glideSec, double when) noexcept TERMINATOR_NONBLOCKING
{
    const bool wasActive = active && ampEnv.active();
    note = n;
    vel = v;
    targetPitch = static_cast<double>(n);
    slideDur = 0.0; // a fresh note-on ends any slide in progress
    if (!wasActive)
        pitch = static_cast<double>(n);
    else if (glideSec <= 0.001)
        pitch = static_cast<double>(n);
    active = true;
    startedAt = when;
    if (!(legato && wasActive))
    {
        ampEnv.gate(true);
        filtEnv.gate(true);
        if (!wasActive)
        {
            ladder.reset();
            svfA.reset();
            svfB.reset();
            diode.reset();
        }
    }
}
void BassSynth::Voice::release() noexcept TERMINATOR_NONBLOCKING
{
    ampEnv.gate(false);
    filtEnv.gate(false);
}
void BassSynth::Voice::slide(int n, double sec) noexcept TERMINATOR_NONBLOCKING
{
    slideFrom = pitch;
    targetPitch = static_cast<double>(n);
    slideT = 0.0;
    slideDur = std::max(0.002, sec);
}
void BassSynth::Voice::kill() noexcept TERMINATOR_NONBLOCKING
{
    active = false;
    ampEnv.stage = 0;
    ampEnv.v = 0.0;
    filtEnv.stage = 0;
    filtEnv.v = 0.0;
    note = -1;
}

// ───────────────────────────────── lifecycle ─────────────────────────────────
void BassSynth::prepare(double sampleRate, std::uint64_t seed, bool keepClock, bool keepData) noexcept
{
    sr_ = sampleRate > 0.0 ? sampleRate : 48000.0;
    if (keepClock) // same rate, new block size: every coefficient below is rate-derived and still valid
        return;
    const auto* keptPatch = keepData ? patch_ : nullptr;
    rng_ = seed != 0 ? seed : 0x9e3779b97f4a7c15ull;
    reset();
    // the worklet constructs 8 voices: each Osc draws its start phase, each Voice its three offsets
    for (auto& v : voices_)
    {
        v = Voice{};
        for (auto& o : v.osc)
            o.phase = rnd();
        v.sub.phase = rnd();
        for (auto& o : v.offs)
            o = (rnd() - 0.5) * 3.0;
        // the worklet's ADSR constructor values (a voice that starts mid-block runs on the envelope's LAST set values
        // until the next block start sets the patch's — for the very first note those are these defaults)
        v.ampEnv.set(0.005, 0.2, 0.7, 0.2, sr_);
        v.filtEnv.set(0.005, 0.2, 0.7, 0.2, sr_);
    }
    patch_ = keptPatch;
}

void BassSynth::reset(bool keepData) noexcept
{
    const auto* keptPatch = keepData ? patch_ : nullptr;
    pos_ = 0;
    nextOrder_ = 0;
    patch_ = nullptr;
    defaults_ = BassPatch::defaults();
    eff_ = defaults_;
    modsOnCutoff_ = false;
    for (auto& v : voices_)
        v.kill();
    for (auto& e : events_)
        e.used = false;
    earliest_ = ~0ull;
    heldCount_ = 0;
    smCutoff_ = defaults_.cutoff;
    smRes_ = defaults_.reso;
    smDrive_ = defaults_.postDrive;
    smGain_ = defaults_.postGain;
    smMixDrive_ = defaults_.mixerDrive;
    lfoPhase_ = lastLfo_ = 0.0;
    for (int i = 0; i < 3; ++i)
        modLfoPhase_[i] = modLfoSH_[i] = 0.0;
    trigT_[0] = trigT_[1] = -1.0;
    for (auto& m : modOut_)
        m = 0.0;
    compEnv_ = toneZ_ = dcX_ = dcY_ = 0.0;
    pitchBend_ = modWheel_ = 0.0;
    meterAcc_ = 0.0;
    meterCount_ = 0;
    meterLevel_ = 0.0f;
    meterVoices_ = 0;
    notesFired_ = 0;
    eventsDropped_ = 0;
    patch_ = keptPatch;
}

void BassSynth::setPatch(const BassPatch* p) noexcept TERMINATOR_NONBLOCKING
{
    patch_ = p;
}

bool BassSynth::pushEvent(EventKind kind, std::uint64_t atSample, std::uint8_t note, float velocity, double value,
                          BassTag tag) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& e : events_)
        if (!e.used)
        {
            e.used = true;
            e.kind = kind;
            e.sample = atSample;
            e.order = nextOrder_++;
            e.note = note;
            e.velocity = velocity;
            e.value = value;
            e.tag = tag;
            if (atSample < earliest_)
                earliest_ = atSample;
            return true;
        }
    ++eventsDropped_;
    return false;
}

void BassSynth::recomputeEarliest() noexcept TERMINATOR_NONBLOCKING
{
    earliest_ = ~0ull;
    for (const auto& e : events_)
        if (e.used && e.sample < earliest_)
            earliest_ = e.sample;
}

void BassSynth::clear(BassTag tag, bool release) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& e : events_)
        if (e.used && (tag == BassTag::any || e.tag == tag))
            e.used = false;
    recomputeEarliest();
    if (release)
    {
        heldCount_ = 0;
        for (auto& v : voices_)
            if (v.active)
                v.release();
    }
}

void BassSynth::panic() noexcept TERMINATOR_NONBLOCKING
{
    for (auto& e : events_)
        e.used = false;
    earliest_ = ~0ull;
    heldCount_ = 0;
    for (auto& v : voices_)
        v.kill();
}

std::uint32_t BassSynth::activeVoices() const noexcept TERMINATOR_NONBLOCKING
{
    std::uint32_t n = 0;
    for (const auto& v : voices_)
        if (v.active)
            ++n;
    return n;
}
void BassSynth::activeNoteMask(std::uint64_t out[2]) const noexcept TERMINATOR_NONBLOCKING
{
    out[0] = out[1] = 0;
    for (const auto& v : voices_)
        if (v.active && v.note >= 0 && v.note < 128)
            out[v.note >> 6] |= (1ull << (v.note & 63));
}
int BassSynth::pendingEvents() const noexcept TERMINATOR_NONBLOCKING
{
    int n = 0;
    for (const auto& e : events_)
        if (e.used)
            ++n;
    return n;
}

// ───────────────────────────────── voice allocation ─────────────────────────────────
void BassSynth::heldRemove(int note) noexcept TERMINATOR_NONBLOCKING
{
    for (int i = 0; i < heldCount_; ++i)
        if (held_[i] == note)
        {
            for (int j = i; j + 1 < heldCount_; ++j)
                held_[j] = held_[j + 1];
            --heldCount_;
            return;
        }
}
void BassSynth::heldPush(int note) noexcept TERMINATOR_NONBLOCKING
{
    if (heldCount_ >= kBassMaxHeld)
    {
        for (int j = 0; j + 1 < heldCount_; ++j) // drop the oldest
            held_[j] = held_[j + 1];
        --heldCount_;
    }
    held_[heldCount_++] = note;
}

void BassSynth::noteOn(int note, double vel, double whenSec) noexcept TERMINATOR_NONBLOCKING
{
    const BassPatch& p = eff_;
    // MOD: trigger envelopes restart, key-synced LFOs restart their cycle
    trigT_[0] = 0.0;
    trigT_[1] = 0.0;
    for (int i = 0; i < 3; ++i)
        if (p.modLfo[i].key)
            modLfoPhase_[i] = 0.0;
    if (p.voices <= 1)
    {
        // MONO: last-note priority, legato when a note is already held
        heldRemove(note);
        heldPush(note);
        const bool legato = p.legato && heldCount_ > 1;
        voices_[0].start(note, vel, legato, p.glide, whenSec);
        return;
    }
    // POLY: reuse a voice already on this note, else a free one, else steal the oldest
    const int nv = std::clamp(p.voices, 1, kBassMaxVoices);
    Voice* v = nullptr;
    for (auto& x : voices_)
        if (x.active && x.note == note)
        {
            v = &x;
            break;
        }
    if (v == nullptr)
        for (int i = 0; i < nv; ++i)
            if (!voices_[i].active || !voices_[i].ampEnv.active())
            {
                v = &voices_[i];
                break;
            }
    if (v == nullptr)
    {
        Voice* oldest = &voices_[0];
        for (int i = 0; i < nv; ++i)
            if (voices_[i].startedAt < oldest->startedAt)
                oldest = &voices_[i];
        v = oldest;
    }
    v->start(note, vel, false, p.glide, whenSec);
}

void BassSynth::noteOff(int note) noexcept TERMINATOR_NONBLOCKING
{
    const BassPatch& p = eff_;
    if (p.voices <= 1)
    {
        heldRemove(note);
        Voice& v = voices_[0];
        if (v.note == note)
        {
            if (heldCount_ > 0)
            {
                // fall back to the most recent still-held note (Model D style)
                const int back = held_[heldCount_ - 1];
                v.start(back, v.vel, p.legato, p.glide, static_cast<double>(pos_) / sr_);
            }
            else
                v.release();
        }
        return;
    }
    for (auto& v : voices_)
        if (v.active && v.note == note && v.ampEnv.stage != 4 && v.ampEnv.stage != 0)
            v.release();
}

void BassSynth::slideTo(int note, double sec) noexcept TERMINATOR_NONBLOCKING
{
    for (auto& v : voices_)
        if (v.active && v.ampEnv.active())
            v.slide(note, sec);
}

// ───────────────────────────────── MOD matrix ─────────────────────────────────
void BassSynth::applyMods(double blockSec) noexcept TERMINATOR_NONBLOCKING
{
    const BassPatch& base = patch_ != nullptr ? *patch_ : defaults_;
    eff_ = base; // the per-block copy (trivially copyable, no allocation)
    modsOnCutoff_ = false;
    if (base.numMods <= 0)
        return;
    for (int i = 0; i < 3; ++i)
    {
        const auto& l = base.modLfo[i];
        double ph = modLfoPhase_[i] + std::max(0.01, l.rate) * blockSec;
        if (ph >= 1.0)
        {
            ph -= std::floor(ph);
            modLfoSH_[i] = rnd() * 2.0 - 1.0;
        }
        modLfoPhase_[i] = ph;
        double v;
        switch (l.wave)
        {
        case BassLfoWave::square:
            v = ph < 0.5 ? 1.0 : -1.0;
            break;
        case BassLfoWave::saw:
            v = 1.0 - 2.0 * ph;
            break;
        case BassLfoWave::ramp:
            v = 2.0 * ph - 1.0;
            break;
        case BassLfoWave::sine:
            v = std::sin(kTwoPi * ph);
            break;
        case BassLfoWave::sh:
            v = modLfoSH_[i];
            break;
        case BassLfoWave::tri:
        default:
            v = ph < 0.5 ? 4.0 * ph - 1.0 : 3.0 - 4.0 * ph;
            break;
        }
        modOut_[i] = v;
    }
    for (int i = 0; i < 2; ++i)
    {
        const auto& tg = base.modTrig[i];
        if (trigT_[i] < 0.0)
        {
            modOut_[3 + i] = 0.0;
            continue;
        }
        const double t = trigT_[i];
        const double ramp = std::max(0.001, tg.ramp), fall = std::max(0.005, tg.fall);
        double v;
        if (t < ramp)
            v = t / ramp;
        else if (t < ramp + fall)
        {
            const double u = (t - ramp) / fall;
            v = tg.shape == BassTrigShape::lin ? 1.0 - u : std::exp(-4.5 * u) * (1.0 - u * 0.011);
        }
        else
        {
            v = 0.0;
            trigT_[i] = -1.0;
        }
        modOut_[3 + i] = v;
        if (trigT_[i] >= 0.0)
            trigT_[i] = t + blockSec;
    }
    // apply, chained onto the copy (a second mod on the same target reads the first's result — the TS `cur[last]`)
    const int nm = std::min(base.numMods, kBassMaxMods);
    for (int m = 0; m < nm; ++m)
    {
        const auto& mod = base.mods[m];
        const double src = modOut_[static_cast<int>(mod.src)];
        if (mod.target == BassModTarget::none || src == 0.0 || mod.depth == 0.0)
            continue;
        double* cur = eff_.leaf(mod.target);
        if (cur == nullptr || !std::isfinite(*cur))
            continue;
        const auto r = BassPatch::rangeOf(mod.target);
        const double v = *cur;
        const double nv = r.log ? v * std::pow(2.0, mod.depth * src * r.oct) : v + mod.depth * src * (r.max - r.min);
        *cur = std::max(r.min, std::min(r.max, nv));
        if (mod.target == BassModTarget::filterCutoff)
            modsOnCutoff_ = true;
    }
}

// ───────────────────────────────── events ─────────────────────────────────
void BassSynth::fireDue(std::uint64_t atSample) noexcept TERMINATOR_NONBLOCKING
{
    // every event with sample ≤ atSample, in (sample, insertion) order — the worklet's sorted list
    if (atSample < earliest_)
        return;
    for (;;)
    {
        Event* best = nullptr;
        for (auto& e : events_)
            if (e.used && e.sample <= atSample &&
                (best == nullptr || e.sample < best->sample || (e.sample == best->sample && e.order < best->order)))
                best = &e;
        if (best == nullptr)
        {
            recomputeEarliest();
            return;
        }
        best->used = false;
        const double tNow = static_cast<double>(atSample) / sr_;
        switch (best->kind)
        {
        case EventKind::bend:
            pitchBend_ = best->value;
            break;
        case EventKind::slide:
            slideTo(best->note, best->value);
            break;
        case EventKind::on:
            noteOn(best->note, static_cast<double>(best->velocity), tNow);
            ++notesFired_;
            break;
        case EventKind::off:
        default:
            noteOff(best->note);
            break;
        }
    }
}

// ───────────────────────────────── render ─────────────────────────────────
void BassSynth::render(float* left, float* right, int numSamples,
                       std::uint64_t blockStart) noexcept TERMINATOR_NONBLOCKING
{
    if (left == nullptr || numSamples <= 0)
        return;
    pos_ = blockStart;
    int done = 0;
    while (done < numSamples)
    {
        const int toBoundary = kBassQuantum - static_cast<int>(pos_ % static_cast<std::uint64_t>(kBassQuantum));
        const int n = std::min(numSamples - done, toBoundary);
        renderQuantum(left + done, right != nullptr ? right + done : nullptr, n);
        done += n;
    }
}

void BassSynth::renderQuantum(float* L, float* R, int n) noexcept TERMINATOR_NONBLOCKING
{
    const double sr = sr_;
    // the worklet's per-block work runs once per QUANTUM: at a quantum START (pos_ on the 128 grid), for the
    // quantum's full length — a host block that ends mid-quantum defers that work to the next call. Doing it for
    // `n` would make smoothing/LFO rate depend on the host block size.
    const bool quantumStart = (pos_ % static_cast<std::uint64_t>(kBassQuantum)) == 0;
    if (quantumStart)
    {
        const double blockSec = static_cast<double>(kBassQuantum) / sr;
        applyMods(blockSec);
        const BassPatch& p = eff_;
        auto smooth = [&](double cur, double target, double tau) noexcept TERMINATOR_NONBLOCKING
        { return cur + (target - cur) * std::min(1.0, blockSec / tau); };
        smCutoff_ = smooth(smCutoff_, p.cutoff, modsOnCutoff_ ? 0.004 : 0.02);
        smRes_ = smooth(smRes_, p.reso, 0.02);
        smDrive_ = smooth(smDrive_, p.postDrive, 0.03);
        smGain_ = smooth(smGain_, p.postGain, 0.03);
        smMixDrive_ = smooth(smMixDrive_, p.mixerDrive, 0.03);
        const double driftMax = p.drift * 6.0; // cents at drift = 1
        for (auto& v : voices_)
        {
            if (!v.active)
                continue;
            v.ampEnv.set(p.ampEnv.a, p.ampEnv.d, p.ampEnv.s, p.ampEnv.r, sr);
            v.filtEnv.set(p.filtEnv.a, p.filtEnv.d, p.filtEnv.s, p.filtEnv.r, sr);
            for (int i = 0; i < 3; ++i)
            {
                if (driftMax > 0.0)
                {
                    Osc& o = v.osc[i];
                    if (o.driftCount <= 0.0)
                    {
                        o.driftTarget = (rnd() * 2.0 - 1.0) * driftMax;
                        o.driftCount = 0.15 + rnd() * 0.6; // seconds until the next target
                    }
                    o.driftCount -= blockSec;
                    o.drift += (o.driftTarget - o.drift) * std::min(1.0, blockSec * 3.0);
                    v.driftCents[i] = o.drift;
                }
                else
                    v.driftCents[i] = 0.0;
            }
        }
    }
    const BassPatch& p = eff_;
    // LFO (block-rate advance, sample-rate read via phase)
    const double lfoInc = p.lfoRate / sr;
    const double lfoDepthCut = p.lfoToCutoff + modWheel_ * 0.5;
    const double lfoDepthPitch = p.lfoToPitch + modWheel_ * 0.3;
    // oscillator settings resolved once per block
    bool oscOn[3];
    double oscSemis[3];
    for (int i = 0; i < 3; ++i)
    {
        oscOn[i] = p.osc[i].on && p.osc[i].level > 0.0;
        oscSemis[i] = p.osc[i].octave * 12.0 + p.osc[i].semi + p.osc[i].fine / 100.0;
    }
    const bool subOn = p.subLevel > 0.0;
    const bool noiseOn = p.noiseLevel > 0.0;
    const bool anyMix = oscOn[0] || oscOn[1] || oscOn[2] || subOn || noiseOn;
    const double mixPre = 1.0 + smMixDrive_ * 5.0;
    const double mixNorm = 1.0 / ftanh(mixPre * 0.8); // keep loudness roughly level while driven
    const double glideK = p.glide > 0.001 ? 1.0 - std::exp(-1.0 / (p.glide * sr * 0.35)) : 1.0;
    const double sr2 = sr * 2.0;
    const BassFilterModel filtModel = p.filterModel;
    const int poles = std::min(4, std::max(1, p.poles));
    const double kbdTrack = p.kbd;
    const double envAmt = p.envAmt; // −1..1 → ±8 octaves
    const double velAmp = p.velAmp, velFilt = p.velFilt;
    const double postDrivePre = 1.0 + smDrive_ * 9.0;
    const double postNorm = smDrive_ > 0.0 ? 1.0 / ftanh(postDrivePre * 0.7) * (0.85 + 0.15 * (1.0 - smDrive_)) : 1.0;
    const double toneK = 1.0 - std::exp(-kTwoPi * p.postTone / sr); // one-pole LP; tone in Hz
    const double glue = p.postGlue;
    const double subSemis = oscSemis[0] - 12.0 * static_cast<double>(p.subOctave);

    double level = 0.0;
    for (int i = 0; i < n; ++i)
    {
        const std::uint64_t sampleNow = pos_ + static_cast<std::uint64_t>(i);
        fireDue(sampleNow); // due events (at ≤ now → immediately)

        // legacy LFO
        lfoPhase_ += lfoInc;
        if (lfoPhase_ >= 1.0)
            lfoPhase_ -= 1.0;
        double lfo;
        switch (p.lfoWave)
        {
        case BassLfoWave::square:
            lfo = lfoPhase_ < 0.5 ? 1.0 : -1.0;
            break;
        case BassLfoWave::saw:
            lfo = 1.0 - 2.0 * lfoPhase_;
            break;
        case BassLfoWave::sh:
            if (lfoPhase_ < lfoInc)
                lastLfo_ = rnd() * 2.0 - 1.0;
            lfo = lastLfo_;
            break;
        default:
            lfo = lfoPhase_ < 0.5 ? 4.0 * lfoPhase_ - 1.0 : 3.0 - 4.0 * lfoPhase_;
            break; // triangle
        }

        double mix = 0.0;
        for (auto& v : voices_)
        {
            if (!v.active)
                continue;
            const double amp = v.ampEnv.next();
            if (!v.ampEnv.active())
            {
                v.active = false;
                v.note = -1;
                continue;
            }
            const double fenv = v.filtEnv.next();
            // slide (linear ramp) beats glide (exp) while it runs
            if (v.slideDur > 0.0)
            {
                v.slideT += 1.0 / sr;
                const double k = v.slideT / v.slideDur;
                if (k >= 1.0)
                {
                    v.slideDur = 0.0;
                    v.pitch = v.targetPitch;
                }
                else
                    v.pitch = v.slideFrom + (v.targetPitch - v.slideFrom) * k;
            }
            else if (v.pitch != v.targetPitch)
            {
                v.pitch += (v.targetPitch - v.pitch) * glideK;
                if (std::abs(v.pitch - v.targetPitch) < 0.0005)
                    v.pitch = v.targetPitch;
            }
            const double basePitch = v.pitch + pitchBend_ + lfo * lfoDepthPitch;
            // oscillators
            double s = 0.0;
            if (anyMix)
            {
                for (int o = 0; o < 3; ++o)
                {
                    if (!oscOn[o])
                        continue;
                    const double cents = v.offs[o] * p.drift + v.driftCents[o];
                    const double f = 440.0 * std::pow(2.0, (basePitch + oscSemis[o] + cents / 100.0 - 69.0) / 12.0);
                    s += v.osc[o].next(f, sr, p.osc[o].wave, p.osc[o].pw, p.osc[o].morph) * p.osc[o].level;
                }
                if (subOn)
                {
                    const double f = 440.0 * std::pow(2.0, (basePitch + subSemis - 69.0) / 12.0);
                    s += v.sub.next(f, sr, p.subWave, 0.5, 0.0) * p.subLevel;
                }
                if (noiseOn)
                {
                    const double w = rnd() * 2.0 - 1.0;
                    double nz = w;
                    if (p.noisePink)
                    {
                        v.noiseB0 = 0.99765 * v.noiseB0 + w * 0.0990460;
                        v.noiseB1 = 0.96300 * v.noiseB1 + w * 0.2965164;
                        v.noiseB2 = 0.57000 * v.noiseB2 + w * 1.0526913;
                        nz = (v.noiseB0 + v.noiseB1 + v.noiseB2 + w * 0.1848) * 0.25;
                    }
                    s += nz * p.noiseLevel;
                }
            }
            // mixer overdrive (Model D: pushing the mixer into the filter clips warmly)
            s = ftanh(s * mixPre * 0.8) * mixNorm * 0.9;

            // filter cutoff: base × kbd tracking × envelope × LFO × velocity
            const double velF = 1.0 + (v.vel - 1.0) * velFilt;
            const double octs =
                kbdTrack * (v.pitch - 48.0) / 12.0 + envAmt * 8.0 * fenv * velF + lfo * lfoDepthCut * 3.0;
            double fc = smCutoff_ * std::pow(2.0, octs);
            if (fc < 15.0)
                fc = 15.0;
            else if (fc > 18000.0)
                fc = 18000.0;
            double y;
            if (filtModel == BassFilterModel::ota)
            {
                v.svfA.set(fc, smRes_, sr);
                y = v.svfA.process(s * (1.0 + p.filterDrive * 2.0), p.filterMode);
                if (poles > 2)
                {
                    v.svfB.set(fc, smRes_ * 0.6, sr);
                    y = v.svfB.process(y, p.filterMode);
                }
                y *= 1.0 / (1.0 + p.filterDrive);
            }
            else if (filtModel == BassFilterModel::diode)
            {
                v.diode.set(fc, sr);
                y = v.diode.process(s * (0.6 + p.filterDrive * 1.5), smRes_ * 24.0) * 1.4; // K≈22 = self-osc edge
            }
            else
            {
                v.ladder.setCutoff(fc, sr2);
                // resonance 0..1 → 0..4; small level compensation as res rises
                y = v.ladder.process(s, smRes_ * 4.0, 0.7 + p.filterDrive * 2.5, poles, sr2) * (1.0 + smRes_ * 0.6) *
                    1.15;
            }
            const double velA = 1.0 + (v.vel - 1.0) * velAmp;
            mix += y * amp * velA;
        }

        // post
        double x = mix;
        if (smDrive_ > 0.001) // DRIVE: tape-ish saturation
            x = ftanh(x * postDrivePre) * postNorm;
        toneZ_ += (x - toneZ_) * toneK; // TONE: one-pole low-pass (20 kHz = open)
        x = toneZ_;
        if (glue > 0.001) // GLUE: one-knob feed-forward comp
        {
            const double a = std::abs(x);
            const double thr = 0.5 - glue * 0.35;
            const double target = a > thr ? thr / a : 1.0;
            const double rate = target < compEnv_ ? 0.004 : 0.00025; // fast attack, slow release
            compEnv_ += (target - compEnv_) * rate;
            x *= compEnv_ * (1.0 + glue * 0.8);
        }
        x *= smGain_;
        // DC blocker (~5 Hz)
        const double dcy = x - dcX_ + 0.9993 * dcY_;
        dcX_ = x;
        dcY_ = dcy;
        x = dcy;
        // final safety clip
        if (x > 1.2)
            x = 1.2 + ftanh(x - 1.2) * 0.3;
        else if (x < -1.2)
            x = -1.2 + ftanh(x + 1.2) * 0.3;
        const float xf = static_cast<float>(x);
        L[i] += xf;
        if (R != nullptr)
            R[i] += xf;
        const double ax = x < 0.0 ? -x : x;
        if (ax > level)
            level = ax;
    }
    pos_ += static_cast<std::uint64_t>(n);

    // meter for the UI (~30 Hz windows)
    meterAcc_ = std::max(meterAcc_, level);
    meterCount_ += static_cast<std::uint64_t>(n);
    if (static_cast<double>(meterCount_) >= sr / 30.0)
    {
        meterLevel_ = static_cast<float>(meterAcc_);
        meterVoices_ = activeVoices();
        meterAcc_ = 0.0;
        meterCount_ = 0;
    }
}

} // namespace terminator
