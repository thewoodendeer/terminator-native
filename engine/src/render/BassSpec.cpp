// One parser for the bass, shared by the live bridge (app/WebShell) and the offline exporter (render/ProjectRenderer).
#include "terminator/render/BassSpec.h"

#include <algorithm>
#include <cmath>

namespace terminator::render
{
namespace
{
double numOr(const juce::var& o, const char* key, double fallback)
{
    if (!o.isObject() || !o.hasProperty(key))
        return fallback;
    const auto& v = o[key];
    if (!v.isDouble() && !v.isInt() && !v.isInt64() && !v.isBool())
        return fallback;
    const double d = static_cast<double>(v);
    return std::isfinite(d) ? d : fallback;
}
bool boolOr(const juce::var& o, const char* key, bool fallback)
{
    if (!o.isObject() || !o.hasProperty(key))
        return fallback;
    return static_cast<bool>(o[key]);
}
juce::String strOr(const juce::var& o, const char* key, const juce::String& fallback)
{
    if (!o.isObject() || !o.hasProperty(key) || !o[key].isString())
        return fallback;
    return o[key].toString();
}
// ---- the bass patch / pattern / timeline from the page's JSON (Phase 3.4, BRIDGE-PROTOCOL.md) ----
BassWave bassWaveOf(const juce::String& w, BassWave fallback)
{
    if (w == "tri")
        return BassWave::tri;
    if (w == "shark")
        return BassWave::shark;
    if (w == "saw")
        return BassWave::saw;
    if (w == "square")
        return BassWave::square;
    if (w == "pulse")
        return BassWave::pulse;
    if (w == "narrow")
        return BassWave::narrow;
    if (w == "sine")
        return BassWave::sine;
    if (w == "morph")
        return BassWave::morph;
    return fallback;
}
BassLfoWave bassLfoWaveOf(const juce::String& w, BassLfoWave fallback)
{
    if (w == "tri")
        return BassLfoWave::tri;
    if (w == "square")
        return BassLfoWave::square;
    if (w == "saw")
        return BassLfoWave::saw;
    if (w == "ramp")
        return BassLfoWave::ramp;
    if (w == "sine")
        return BassLfoWave::sine;
    if (w == "sh")
        return BassLfoWave::sh;
    return fallback;
}
/// The dotted knob path the MOD matrix targets → the engine's enum (none = unknown path, ignored).
BassModTarget bassModTargetOf(const juce::String& path)
{
    static const std::pair<const char*, BassModTarget> table[] = {
        {"osc.0.level", BassModTarget::osc1Level},
        {"osc.0.semi", BassModTarget::osc1Semi},
        {"osc.0.fine", BassModTarget::osc1Fine},
        {"osc.0.pw", BassModTarget::osc1Pw},
        {"osc.0.morph", BassModTarget::osc1Morph},
        {"osc.1.level", BassModTarget::osc2Level},
        {"osc.1.semi", BassModTarget::osc2Semi},
        {"osc.1.fine", BassModTarget::osc2Fine},
        {"osc.1.pw", BassModTarget::osc2Pw},
        {"osc.1.morph", BassModTarget::osc2Morph},
        {"osc.2.level", BassModTarget::osc3Level},
        {"osc.2.semi", BassModTarget::osc3Semi},
        {"osc.2.fine", BassModTarget::osc3Fine},
        {"osc.2.pw", BassModTarget::osc3Pw},
        {"osc.2.morph", BassModTarget::osc3Morph},
        {"sub.level", BassModTarget::subLevel},
        {"noise.level", BassModTarget::noiseLevel},
        {"mixerDrive", BassModTarget::mixerDrive},
        {"filter.cutoff", BassModTarget::filterCutoff},
        {"filter.reso", BassModTarget::filterReso},
        {"filter.envAmt", BassModTarget::filterEnvAmt},
        {"filter.kbd", BassModTarget::filterKbd},
        {"filter.drive", BassModTarget::filterDrive},
        {"filtEnv.a", BassModTarget::filtEnvA},
        {"filtEnv.d", BassModTarget::filtEnvD},
        {"filtEnv.s", BassModTarget::filtEnvS},
        {"filtEnv.r", BassModTarget::filtEnvR},
        {"ampEnv.a", BassModTarget::ampEnvA},
        {"ampEnv.d", BassModTarget::ampEnvD},
        {"ampEnv.s", BassModTarget::ampEnvS},
        {"ampEnv.r", BassModTarget::ampEnvR},
        {"glide", BassModTarget::glide},
        {"drift", BassModTarget::drift},
        {"velAmp", BassModTarget::velAmp},
        {"velFilt", BassModTarget::velFilt},
        {"post.drive", BassModTarget::postDrive},
        {"post.tone", BassModTarget::postTone},
        {"post.glue", BassModTarget::postGlue},
        {"post.gain", BassModTarget::postGain},
        {"modSrc.lfo.0.rate", BassModTarget::lfo1Rate},
        {"modSrc.lfo.1.rate", BassModTarget::lfo2Rate},
        {"modSrc.lfo.2.rate", BassModTarget::lfo3Rate},
        {"modSrc.trig.0.ramp", BassModTarget::trigARamp},
        {"modSrc.trig.0.fall", BassModTarget::trigAFall},
        {"modSrc.trig.1.ramp", BassModTarget::trigBRamp},
        {"modSrc.trig.1.fall", BassModTarget::trigBFall},
    };
    for (const auto& [name, t] : table)
        if (path == name)
            return t;
    return BassModTarget::none;
}
} // namespace

/// deep-merge a (possibly partial) JSON patch over the defaults — the worklet's mergePatch(defaultPatch(), patch)
BassPatch bassPatchFromVar(const juce::var& j)
{
    BassPatch p = BassPatch::defaults();
    if (!j.isObject())
        return p;
    if (const auto* oscs = j.getProperty("osc", juce::var()).getArray())
        for (int i = 0; i < 3 && i < oscs->size(); ++i)
        {
            const auto& o = (*oscs)[i];
            auto& d = p.osc[i];
            d.on = boolOr(o, "on", d.on);
            d.wave = bassWaveOf(strOr(o, "wave", ""), d.wave);
            d.octave = numOr(o, "octave", d.octave);
            d.semi = numOr(o, "semi", d.semi);
            d.fine = numOr(o, "fine", d.fine);
            d.level = numOr(o, "level", d.level);
            d.pw = numOr(o, "pw", d.pw);
            d.morph = numOr(o, "morph", d.morph);
        }
    const auto sub = j.getProperty("sub", juce::var());
    p.subLevel = numOr(sub, "level", p.subLevel);
    {
        const auto w = strOr(sub, "wave", "");
        p.subWave = w == "square" ? BassWave::square : (w == "sine" ? BassWave::sine : p.subWave);
    }
    p.subOctave = static_cast<int>(numOr(sub, "octave", p.subOctave)) >= 2 ? 2 : 1;
    const auto noise = j.getProperty("noise", juce::var());
    p.noiseLevel = numOr(noise, "level", p.noiseLevel);
    p.noisePink = strOr(noise, "color", p.noisePink ? "pink" : "white") == "pink";
    p.mixerDrive = numOr(j, "mixerDrive", p.mixerDrive);
    const auto f = j.getProperty("filter", juce::var());
    {
        const auto m = strOr(f, "model", "");
        p.filterModel = m == "ota" ? BassFilterModel::ota
                                   : (m == "diode" ? BassFilterModel::diode
                                                   : (m == "ladder" ? BassFilterModel::ladder : p.filterModel));
        const auto mo = strOr(f, "mode", "");
        p.filterMode = mo == "bp"
                           ? BassFilterMode::bp
                           : (mo == "hp" ? BassFilterMode::hp : (mo == "lp" ? BassFilterMode::lp : p.filterMode));
        p.cutoff = numOr(f, "cutoff", p.cutoff);
        p.reso = numOr(f, "reso", p.reso);
        p.envAmt = numOr(f, "envAmt", p.envAmt);
        p.kbd = numOr(f, "kbd", p.kbd);
        p.poles = static_cast<int>(numOr(f, "poles", p.poles));
        p.filterDrive = numOr(f, "drive", p.filterDrive);
    }
    auto env = [&](const char* key, BassEnvPatch& e)
    {
        const auto o = j.getProperty(key, juce::var());
        e.a = numOr(o, "a", e.a);
        e.d = numOr(o, "d", e.d);
        e.s = numOr(o, "s", e.s);
        e.r = numOr(o, "r", e.r);
    };
    env("filtEnv", p.filtEnv);
    env("ampEnv", p.ampEnv);
    const auto lfo = j.getProperty("lfo", juce::var());
    p.lfoRate = numOr(lfo, "rate", p.lfoRate);
    p.lfoWave = bassLfoWaveOf(strOr(lfo, "wave", ""), p.lfoWave);
    p.lfoToCutoff = numOr(lfo, "toCutoff", p.lfoToCutoff);
    p.lfoToPitch = numOr(lfo, "toPitch", p.lfoToPitch);
    const auto ms = j.getProperty("modSrc", juce::var());
    if (const auto* lfos = ms.getProperty("lfo", juce::var()).getArray())
        for (int i = 0; i < 3 && i < lfos->size(); ++i)
        {
            const auto& o = (*lfos)[i];
            p.modLfo[i].rate = numOr(o, "rate", p.modLfo[i].rate);
            p.modLfo[i].wave = bassLfoWaveOf(strOr(o, "wave", ""), p.modLfo[i].wave);
            p.modLfo[i].key = boolOr(o, "key", p.modLfo[i].key);
        }
    if (const auto* trigs = ms.getProperty("trig", juce::var()).getArray())
        for (int i = 0; i < 2 && i < trigs->size(); ++i)
        {
            const auto& o = (*trigs)[i];
            p.modTrig[i].ramp = numOr(o, "ramp", p.modTrig[i].ramp);
            p.modTrig[i].fall = numOr(o, "fall", p.modTrig[i].fall);
            const auto sh = strOr(o, "shape", "");
            p.modTrig[i].shape =
                sh == "lin" ? BassTrigShape::lin : (sh == "exp" ? BassTrigShape::exp : p.modTrig[i].shape);
        }
    if (const auto* mods = j.getProperty("mods", juce::var()).getArray())
    {
        p.numMods = 0; // `mods` is replaced wholesale (the worklet's merge does the same)
        for (const auto& m : *mods)
        {
            if (p.numMods >= kBassMaxMods)
                break;
            const auto src = strOr(m, "src", "");
            const BassModSource sv = src == "lfo2"    ? BassModSource::lfo2
                                     : src == "lfo3"  ? BassModSource::lfo3
                                     : src == "trigA" ? BassModSource::trigA
                                     : src == "trigB" ? BassModSource::trigB
                                                      : BassModSource::lfo1;
            const BassModTarget t = bassModTargetOf(strOr(m, "target", ""));
            if (t == BassModTarget::none)
                continue;
            p.mods[p.numMods++] = {sv, t, std::clamp(numOr(m, "depth", 0.0), -1.0, 1.0)};
        }
    }
    p.glide = numOr(j, "glide", p.glide);
    p.legato = boolOr(j, "legato", p.legato);
    p.voices = std::clamp(static_cast<int>(numOr(j, "voices", p.voices)), 1, kBassMaxVoices);
    p.drift = numOr(j, "drift", p.drift);
    p.velAmp = numOr(j, "velAmp", p.velAmp);
    p.velFilt = numOr(j, "velFilt", p.velFilt);
    const auto post = j.getProperty("post", juce::var());
    p.postDrive = numOr(post, "drive", p.postDrive);
    p.postTone = numOr(post, "tone", p.postTone);
    p.postGlue = numOr(post, "glue", p.postGlue);
    p.postGain = numOr(post, "gain", p.postGain);
    return p;
}

void bassPatternFromVar(const juce::var& j, BassPattern& out)
{
    out.clear();
    out.bars = std::clamp(static_cast<int>(numOr(j, "bars", 2)), 1, kBassMaxBars);
    out.loopTicks = std::max(kBassPpq, out.bars * 4 * kBassPpq);
    if (const auto* notes = j.getProperty("notes", juce::var()).getArray())
        for (const auto& n : *notes)
            out.addNote(static_cast<std::int32_t>(numOr(n, "id", 0)), static_cast<int>(numOr(n, "note", 36)),
                        numOr(n, "start", 0.0), std::max(0.05, numOr(n, "dur", 0.25)),
                        std::clamp(numOr(n, "vel", 0.9), 0.05, 1.0), boolOr(n, "slide", false));
    const auto* bend = j.getProperty("bend", juce::var()).getArray();
    if (bend == nullptr || bend->isEmpty())
        return;
    // Two shapes reach us: the bridge sends the lane already sampled PER TICK (plain numbers), a project file stores
    // it as the page's BREAKPOINTS [{beat, semis}] — flat before the first and after the last, linear between.
    const bool breakpoints = (*bend)[0].isObject();
    out.hasBend = true;
    if (!breakpoints)
    {
        for (int t = 0; t < out.loopTicks && t < kBassMaxLoopTicks; ++t)
        {
            const double v = t < bend->size() ? static_cast<double>((*bend)[t]) : 0.0;
            out.bend[t] = static_cast<float>(std::isfinite(v) ? v : 0.0);
        }
        return;
    }
    const int n = bend->size();
    auto beatAt = [&](int i) { return numOr((*bend)[i], "beat", 0.0); };
    auto semisAt = [&](int i) { return numOr((*bend)[i], "semis", 0.0); };
    for (int t = 0; t < out.loopTicks && t < kBassMaxLoopTicks; ++t)
    {
        const double beat = static_cast<double>(t) / static_cast<double>(kBassPpq);
        double semis;
        if (beat <= beatAt(0))
            semis = semisAt(0);
        else if (beat >= beatAt(n - 1))
            semis = semisAt(n - 1);
        else
        {
            semis = semisAt(n - 1);
            for (int i = 1; i < n; ++i)
                if (beat <= beatAt(i))
                {
                    const double a = beatAt(i - 1), b = beatAt(i);
                    const double f = b > a ? (beat - a) / (b - a) : 1.0;
                    semis = semisAt(i - 1) + (semisAt(i) - semisAt(i - 1)) * f;
                    break;
                }
        }
        out.bend[t] = static_cast<float>(std::isfinite(semis) ? semis : 0.0);
    }
}
} // namespace terminator::render
