#include "terminator/model/ProjectModel.h"

#include <cmath>

#include "terminator/core/planners/SeqRefit.h"
#include "terminator/core/planners/StemMask.h"

namespace terminator::model
{
using namespace ids;

namespace
{
// ── var helpers ─────────────────────────────────────────────────────────────────────────────────
bool isNum(const juce::var& v) noexcept
{
    return v.isInt() || v.isInt64() || v.isDouble();
}
double num(const juce::var& v, double fallback = 0.0) noexcept
{
    return isNum(v) ? static_cast<double>(v) : fallback;
}
int inum(const juce::var& v, int fallback = 0) noexcept
{
    return isNum(v) ? static_cast<int>(static_cast<double>(v)) : fallback;
}
bool isObj(const juce::var& v) noexcept
{
    return v.getDynamicObject() != nullptr;
}
const juce::NamedValueSet* props(const juce::var& v) noexcept
{
    if (auto* o = v.getDynamicObject())
        return &o->getProperties();
    return nullptr;
}
juce::var newObj()
{
    return juce::var(new juce::DynamicObject());
}
void setP(juce::var& obj, const juce::Identifier& k, const juce::var& v)
{
    obj.getDynamicObject()->setProperty(k, v);
}
/// Store a JSON number as it came (int stays int, double stays double) — keeps the written file identical.
juce::var numVar(const juce::var& v) noexcept
{
    if (v.isInt() || v.isInt64())
        return juce::var(static_cast<juce::int64>(v));
    return juce::var(static_cast<double>(v));
}
juce::var arrVar(std::initializer_list<juce::var> xs)
{
    juce::Array<juce::var> a;
    for (const auto& x : xs)
        a.add(x);
    return juce::var(a);
}
/// Grid rows: `null` rows (JSON.stringify of a sparse array) become empty rows — what loadPreset does.
juce::var normaliseGrid(const juce::var& g)
{
    juce::Array<juce::var> out;
    if (const auto* rows = g.getArray())
        for (const auto& row : *rows)
        {
            juce::Array<juce::var> r;
            if (const auto* cells = row.getArray())
                for (const auto& c : *cells)
                    r.add(c);
            out.add(juce::var(r));
        }
    return juce::var(out);
}
juce::var copyVar(const juce::var& v)
{
    return v.clone();
}
juce::String nowIso()
{
    return juce::Time::getCurrentTime().toISO8601(true);
}

// ── readers ─────────────────────────────────────────────────────────────────────────────────────
void readChops(juce::ValueTree chops, const juce::var& arr)
{
    if (const auto* a = arr.getArray())
        for (const auto& c : *a)
        {
            if (!isObj(c))
                continue;
            juce::ValueTree n(Chop);
            n.setProperty(id, inum(c[id]), nullptr);
            n.setProperty(start, numVar(c[start]), nullptr);
            n.setProperty(end, numVar(c[end]), nullptr);
            if (c.hasProperty(free) && c[free].isBool())
                n.setProperty(free, static_cast<bool>(c[free]), nullptr);
            chops.appendChild(n, nullptr);
        }
}
void readPads(juce::ValueTree pads, const juce::var& arr)
{
    if (const auto* a = arr.getArray())
        for (const auto& p : *a)
        {
            if (!isObj(p))
                continue;
            juce::ValueTree n(Pad);
            n.setProperty(index, inum(p[index]), nullptr);
            if (isNum(p[chopId]))
                n.setProperty(chopId, inum(p[chopId]), nullptr); // absent = null (no chop)
            n.setProperty(mode, p[mode].toString() == "loop" ? "loop" : "oneshot", nullptr);
            n.setProperty(pitch, numVar(isNum(p[pitch]) ? p[pitch] : juce::var(0)), nullptr);
            if (static_cast<bool>(p.getProperty(gate, false)))
                n.setProperty(gate, true, nullptr);
            if (num(p[fadeIn]) != 0.0)
                n.setProperty(fadeIn, numVar(p[fadeIn]), nullptr);
            if (num(p[fadeOut]) != 0.0)
                n.setProperty(fadeOut, numVar(p[fadeOut]), nullptr);
            if (isNum(p[stems]))
            {
                const auto m = stems::normalizeMaskValue(num(p[stems]));
                if (m != stems::kMaskAll)
                    n.setProperty(stems, static_cast<int>(m), nullptr);
            }
            if (p[reverse].isBool())
                n.setProperty(reverse, static_cast<bool>(p[reverse]), nullptr);
            pads.appendChild(n, nullptr);
        }
}
void readPadSources(juce::ValueTree out, const juce::var& obj)
{
    if (const auto* ps = props(obj))
        for (int i = 0; i < ps->size(); ++i)
        {
            const auto& v = ps->getValueAt(i);
            if (!isObj(v))
                continue;
            juce::ValueTree n(PadSource);
            n.setProperty(pad, ps->getName(i).toString().getIntValue(), nullptr);
            n.setProperty(videoId, v[videoId].toString(), nullptr);
            n.setProperty(title, v[title].toString(), nullptr);
            n.setProperty(start, numVar(isNum(v[start]) ? v[start] : juce::var(0)), nullptr);
            n.setProperty(end, numVar(isNum(v[end]) ? v[end] : juce::var(0)), nullptr);
            out.appendChild(n, nullptr);
        }
}
/// Generic object → Entry{key,value}. `intKeys` parses the key as a pad index.
void readMap(juce::ValueTree out, const juce::var& obj, bool intKeys, bool numericValuesOnly = false)
{
    if (const auto* ps = props(obj))
        for (int i = 0; i < ps->size(); ++i)
        {
            const auto& v = ps->getValueAt(i);
            if (numericValuesOnly && !(isNum(v) && num(v) > 0.0 && std::isfinite(num(v))))
                continue;
            juce::ValueTree n(Entry);
            const auto k = ps->getName(i).toString();
            n.setProperty(key, intKeys ? juce::var(k.getIntValue()) : juce::var(k), nullptr);
            n.setProperty(value, numericValuesOnly ? numVar(v) : v, nullptr);
            out.appendChild(n, nullptr);
        }
}
void readSourceFx(juce::ValueTree out, const juce::var& obj)
{
    if (const auto* ps = props(obj))
        for (int i = 0; i < ps->size(); ++i)
        {
            const auto& v = ps->getValueAt(i);
            if (!isObj(v))
                continue;
            juce::ValueTree n(Fx);
            n.setProperty(key, ps->getName(i).toString(), nullptr);
            if (isNum(v[attack]))
                n.setProperty(attack, numVar(v[attack]), nullptr);
            if (isNum(v[pitch]))
                n.setProperty(pitch, numVar(v[pitch]), nullptr);
            if (isNum(v[fine]))
                n.setProperty(fine, numVar(v[fine]), nullptr);
            if (v[reverse].isBool())
                n.setProperty(reverse, static_cast<bool>(v[reverse]), nullptr);
            out.appendChild(n, nullptr);
        }
}
juce::ValueTree makeSequence(int numBars, int res, int view, bool loopOn, const juce::var& gridV, const juce::var& rev,
                             const juce::var& vel)
{
    juce::ValueTree n(Sequence);
    n.setProperty(ids::bars, numBars, nullptr);
    n.setProperty(ids::resolution, res, nullptr);
    n.setProperty(viewResolution, view, nullptr);
    n.setProperty(ids::loop, loopOn, nullptr);
    n.setProperty(ids::grid, normaliseGrid(gridV), nullptr);
    n.setProperty(revGrid, normaliseGrid(rev), nullptr);
    n.setProperty(velGrid, normaliseGrid(vel), nullptr);
    return n;
}
void readSequences(juce::ValueTree root, juce::ValueTree out, const juce::var& json)
{
    const auto* arr = json[juce::Identifier("sequences")].getArray(); // "sequences"
    if (arr != nullptr && arr->size() > 0)
    {
        for (const auto& p : *arr)
        {
            if (!isObj(p))
                continue;
            const int res = seq::acceptStoredResolution(num(p[resolution], 16));
            const int view = seq::acceptViewResolution(num(p[viewResolution], static_cast<double>(res)), res);
            out.appendChild(makeSequence(inum(p[bars], 1), res, view,
                                         p.hasProperty(loop) ? static_cast<bool>(p[loop]) : true, p[grid], p[revGrid],
                                         p[velGrid]),
                            nullptr);
        }
        const int n = out.getNumChildren();
        const int cur = std::max(0, std::min(n - 1, inum(json[currentSeqIdx], 0)));
        root.setProperty(currentSeqIdx, cur, nullptr);
        return;
    }
    // legacy single-pattern fields
    const int barsV = inum(json[seqBars], 1);
    const int resV = seq::isSeqResolution(inum(json[seqResolution], 16)) ? inum(json[seqResolution], 16) : 16;
    const bool loopV = json.hasProperty(seqLoop) ? static_cast<bool>(json[seqLoop]) : true;
    out.appendChild(makeSequence(barsV, resV, resV, loopV, json[seqGrid], juce::var(), juce::var()), nullptr);
    root.setProperty(currentSeqIdx, 0, nullptr);
}
/// Any JSON object → a node whose properties are the object's keys (lossless, order kept).
void readFlatObject(juce::ValueTree n, const juce::var& obj)
{
    if (const auto* ps = props(obj))
        for (int i = 0; i < ps->size(); ++i)
            n.setProperty(ps->getName(i),
                          isNum(ps->getValueAt(i)) ? numVar(ps->getValueAt(i)) : ps->getValueAt(i).clone(), nullptr);
}
void readTrims(juce::ValueTree out, const juce::var& arr)
{
    if (const auto* a = arr.getArray())
        for (const auto& t : *a)
        {
            if (!isObj(t))
                continue;
            juce::ValueTree n(Trim);
            n.setProperty(startSec, numVar(t[startSec]), nullptr);
            n.setProperty(endSec, numVar(t[endSec]), nullptr);
            if (const auto* cs = t[juce::Identifier("chops")].getArray())
                for (const auto& c : *cs)
                {
                    if (!isObj(c))
                        continue;
                    juce::ValueTree cn(TrimChop);
                    cn.setProperty(id, inum(c[id]), nullptr);
                    cn.setProperty(startSec, numVar(c[startSec]), nullptr);
                    cn.setProperty(endSec, numVar(c[endSec]), nullptr);
                    if (isNum(c[padIdx]))
                        cn.setProperty(padIdx, inum(c[padIdx]), nullptr);
                    if (isNum(c[stems]))
                        cn.setProperty(stems, inum(c[stems]), nullptr);
                    n.appendChild(cn, nullptr);
                }
            out.appendChild(n, nullptr);
        }
}
juce::var readRanges(const juce::var& arr)
{
    std::vector<stems::ReadyRange> in;
    if (const auto* a = arr.getArray())
        for (const auto& r : *a)
            if (const auto* pr = r.getArray())
                if (pr->size() >= 2 && isNum((*pr)[0]) && isNum((*pr)[1]))
                    in.push_back({num((*pr)[0]), num((*pr)[1])});
    juce::Array<juce::var> out;
    for (const auto& r : stems::normalizeRanges(in))
        out.add(arrVar({juce::var(r.start), juce::var(r.end)}));
    return juce::var(out);
}
void readStemSet(juce::ValueTree n, const juce::var& s)
{
    n.setProperty(quality, s[quality].toString() == "fine" ? "fine" : "fast", nullptr);
    n.setProperty(readyRanges, readRanges(s[readyRanges]), nullptr);
    juce::ValueTree a(StemAssets);
    readFlatObject(a, s[assets]);
    n.appendChild(a, nullptr);
}

// ── writers ─────────────────────────────────────────────────────────────────────────────────────
juce::var writeChops(const juce::ValueTree& chops)
{
    juce::Array<juce::var> a;
    for (const auto& c : chops)
    {
        auto o = newObj();
        setP(o, id, c[id]);
        setP(o, start, c[start]);
        setP(o, end, c[end]);
        if (c.hasProperty(free))
            setP(o, free, c[free]);
        a.add(o);
    }
    return juce::var(a);
}
juce::var writePads(const juce::ValueTree& pads)
{
    juce::Array<juce::var> a;
    for (const auto& p : pads)
    {
        auto o = newObj();
        setP(o, index, p[index]);
        setP(o, chopId, p.hasProperty(chopId) ? p[chopId] : juce::var());
        setP(o, mode, p.getProperty(mode, "oneshot"));
        setP(o, pitch, p.getProperty(pitch, 0));
        if (static_cast<bool>(p.getProperty(gate, false)))
            setP(o, gate, true);
        if (num(p[fadeIn]) != 0.0)
            setP(o, fadeIn, p[fadeIn]);
        if (num(p[fadeOut]) != 0.0)
            setP(o, fadeOut, p[fadeOut]);
        if (p.hasProperty(stems) && inum(p[stems]) != stems::kMaskAll)
            setP(o, stems, p[stems]);
        if (p.hasProperty(reverse))
            setP(o, reverse, p[reverse]);
        a.add(o);
    }
    return juce::var(a);
}
juce::var writePadSources(const juce::ValueTree& srcs)
{
    auto o = newObj();
    for (const auto& s : srcs)
    {
        auto e = newObj();
        setP(e, videoId, s[videoId]);
        setP(e, title, s[title]);
        setP(e, start, s[start]);
        setP(e, end, s[end]);
        o.getDynamicObject()->setProperty(juce::Identifier(juce::String(inum(s[pad]))), e);
    }
    return o;
}
juce::var writeMap(const juce::ValueTree& map)
{
    auto o = newObj();
    for (const auto& e : map)
        o.getDynamicObject()->setProperty(juce::Identifier(e[key].toString()), e[value]);
    return o;
}
juce::var writeSourceFx(const juce::ValueTree& fx)
{
    auto o = newObj();
    for (const auto& f : fx)
    {
        auto e = newObj();
        for (const auto& k : {attack, pitch, fine, reverse})
            if (f.hasProperty(k))
                setP(e, k, f[k]);
        o.getDynamicObject()->setProperty(juce::Identifier(f[key].toString()), e);
    }
    return o;
}
juce::var writeSequence(const juce::ValueTree& s)
{
    auto o = newObj();
    setP(o, bars, s[bars]);
    setP(o, resolution, s[resolution]);
    setP(o, viewResolution, s[viewResolution]);
    setP(o, grid, copyVar(s[grid]));
    setP(o, revGrid, copyVar(s[revGrid]));
    setP(o, velGrid, copyVar(s[velGrid]));
    setP(o, loop, s[loop]);
    return o;
}
juce::var writeFlat(const juce::ValueTree& n)
{
    auto o = newObj();
    for (int i = 0; i < n.getNumProperties(); ++i)
    {
        const auto pn = n.getPropertyName(i);
        setP(o, pn, copyVar(n[pn]));
    }
    return o;
}
juce::var writeMasterDefaults()
{
    auto o = newObj();
    setP(o, volume, defaults::masterVolume);
    setP(o, pitch, 0);
    setP(o, filterFreq, 20000);
    setP(o, filterEnabled, false);
    setP(o, eqLow, 0);
    setP(o, eqMid, 0);
    setP(o, eqHigh, 0);
    setP(o, compStyle, "off");
    setP(o, compMix, 0);
    setP(o, delayTime, 0.25);
    setP(o, delayFeedback, 0.3);
    setP(o, delayMix, 0);
    setP(o, reverbMix, 0);
    setP(o, reverbDecay, 2);
    setP(o, attack, defaults::masterAttack);
    setP(o, release, 0);
    return o;
}
juce::var writeTrims(const juce::ValueTree& trims)
{
    juce::Array<juce::var> a;
    for (const auto& t : trims)
    {
        auto o = newObj();
        setP(o, startSec, t[startSec]);
        setP(o, endSec, t[endSec]);
        juce::Array<juce::var> cs;
        for (const auto& c : t)
        {
            auto co = newObj();
            setP(co, id, c[id]);
            setP(co, startSec, c[startSec]);
            setP(co, endSec, c[endSec]);
            if (c.hasProperty(padIdx))
                setP(co, padIdx, c[padIdx]);
            if (c.hasProperty(stems))
                setP(co, stems, c[stems]);
            cs.add(co);
        }
        setP(o, juce::Identifier("chops"), juce::var(cs));
        a.add(o);
    }
    return juce::var(a);
}
juce::var writeStemSet(const juce::ValueTree& s)
{
    auto o = newObj();
    setP(o, quality, s.getProperty(quality, "fast"));
    setP(o, assets, writeFlat(s.getChildWithName(StemAssets)));
    setP(o, readyRanges, copyVar(s[readyRanges]));
    return o;
}
} // namespace

// ── public ──────────────────────────────────────────────────────────────────────────────────────
juce::ValueTree createEmptyProject()
{
    juce::ValueTree p(Project);
    p.setProperty(videoId, kNoSampleId, nullptr);
    p.setProperty(savedAt, nowIso(), nullptr);
    p.setProperty(trackTitle, "", nullptr);
    p.setProperty(bpm, 0, nullptr);
    p.setProperty(nextChopId, defaults::nextChopId, nullptr);
    for (const auto& t : {Chops, Pads, PadSources, SourceRoutes, PadRoutes, PadGroups, PadChoke, SourceFx, SourceNorm,
                          Sequences, Trims, SourceStems})
        p.appendChild(juce::ValueTree(t), nullptr);
    p.getChildWithName(Sequences).appendChild(makeSequence(2, 4, 4, true, juce::var(), juce::var(), juce::var()),
                                              nullptr); // the engine's working default
    p.setProperty(currentSeqIdx, 0, nullptr);
    return p;
}

juce::ValueTree projectFromJson(const juce::var& json, juce::String& error)
{
    if (!isObj(json))
    {
        error = "project must be a JSON object";
        return {};
    }
    juce::ValueTree p(Project);
    // scalars — stored only when present (absent = the engine default; see ProjectModel.h)
    for (const auto& k : {videoId, savedAt, name, trackTitle})
        if (json[k].isString())
            p.setProperty(k, json[k], nullptr);
    for (const auto& k : {bpm, nextChopId, timelineLength, normalizeGain, masterClip, targetBpm, chopOffsetMs,
                          chopVolume, metronomeBpm, inputQuantize, nextSampleTrack, nextChokeGroup})
        if (isNum(json[k]))
            p.setProperty(k, numVar(json[k]), nullptr);
    for (const auto& k : {normalize, stretchEnabled, reverseSample})
        if (json[k].isBool())
            p.setProperty(k, json[k], nullptr);
    // inputQuantize migrates from drums._inputQuantize (loadPreset)
    if (!p.hasProperty(inputQuantize) && isObj(json[drums]) && isNum(json[drums][juce::Identifier("_inputQuantize")]))
        p.setProperty(inputQuantize,
                      static_cast<int>(std::round(
                          std::max(0.0, std::min(100.0, num(json[drums][juce::Identifier("_inputQuantize")]))))),
                      nullptr);
    // opaque blobs (drums/bass/mixer own engines land in Phases 3/4; timeline is legacy; assets = manifest)
    for (const auto& k : {timeline, drums, bass, mixer, assets})
        if (json.hasProperty(k) && !json[k].isVoid())
            p.setProperty(k, json[k].clone(), nullptr);

    juce::ValueTree chops(Chops);
    readChops(chops, json[juce::Identifier("chops")]);
    p.appendChild(chops, nullptr);
    juce::ValueTree pads(Pads);
    readPads(pads, json[juce::Identifier("pads")]);
    p.appendChild(pads, nullptr);
    juce::ValueTree srcs(PadSources);
    readPadSources(srcs, json[juce::Identifier("padBufferMeta")]);
    p.appendChild(srcs, nullptr);
    juce::ValueTree sr(SourceRoutes), pr(PadRoutes), pg(PadGroups), pc(PadChoke), sn(SourceNorm), sfx(SourceFx);
    readMap(sr, json[juce::Identifier("sourceRoutes")], false);
    readMap(pr, json[juce::Identifier("padRoutes")], true);
    readMap(pg, json[juce::Identifier("padGroups")], true);
    readMap(pc, json[juce::Identifier("padChoke")], true);
    readMap(sn, json[juce::Identifier("sourceNorm")], false, true);
    readSourceFx(sfx, json[juce::Identifier("sourceFx")]);
    for (auto& t : {sr, pr, pg, pc, sfx, sn})
        p.appendChild(t, nullptr);
    juce::ValueTree seqs(Sequences);
    readSequences(p, seqs, json);
    p.appendChild(seqs, nullptr);
    if (isObj(json[juce::Identifier("master")]))
    {
        juce::ValueTree m(Master);
        readFlatObject(m, json[juce::Identifier("master")]);
        p.appendChild(m, nullptr);
    }
    if (const auto* fxs = props(json[juce::Identifier("extraFX")]))
    {
        juce::ValueTree x(ExtraFX);
        for (int i = 0; i < fxs->size(); ++i)
        {
            juce::ValueTree b(fxs->getName(i));
            readFlatObject(b, fxs->getValueAt(i));
            x.appendChild(b, nullptr);
        }
        p.appendChild(x, nullptr);
    }
    juce::ValueTree trims(Trims);
    readTrims(trims, json[juce::Identifier("trims")]);
    p.appendChild(trims, nullptr);
    if (isObj(json[stems]))
    {
        juce::ValueTree s(Stems);
        readStemSet(s, json[stems]);
        p.appendChild(s, nullptr);
    }
    juce::ValueTree ss(SourceStems);
    if (const auto* sps = props(json[juce::Identifier("sourceStems")]))
        for (int i = 0; i < sps->size(); ++i)
            if (isObj(sps->getValueAt(i)))
            {
                juce::ValueTree s(SourceStem);
                s.setProperty(videoId, sps->getName(i).toString(), nullptr);
                readStemSet(s, sps->getValueAt(i));
                ss.appendChild(s, nullptr);
            }
    p.appendChild(ss, nullptr);
    return p;
}

juce::ValueTree projectFromJsonText(const juce::String& text, juce::String& error)
{
    juce::var json;
    const auto r = juce::JSON::parse(text, json);
    if (r.failed())
    {
        error = "invalid JSON: " + r.getErrorMessage();
        return {};
    }
    return projectFromJson(json, error);
}

juce::ValueTree projectFromFile(const juce::File& file, juce::String& error)
{
    if (!file.existsAsFile())
    {
        error = "no such file: " + file.getFullPathName();
        return {};
    }
    return projectFromJsonText(file.loadFileAsString(), error);
}

juce::var projectToJson(const juce::ValueTree& p, bool stampNow)
{
    auto o = newObj();
    auto get = [&](const juce::Identifier& k, const juce::var& fallback) { return p.hasProperty(k) ? p[k] : fallback; };
    setP(o, videoId, get(videoId, kNoSampleId));
    setP(o, savedAt, stampNow ? juce::var(nowIso()) : get(savedAt, nowIso()));
    if (p.hasProperty(name))
        setP(o, name, p[name]);
    setP(o, trackTitle, get(trackTitle, ""));
    setP(o, juce::Identifier("chops"), writeChops(p.getChildWithName(Chops)));
    setP(o, juce::Identifier("pads"), writePads(p.getChildWithName(Pads)));
    setP(o, juce::Identifier("padBufferMeta"), writePadSources(p.getChildWithName(PadSources)));
    setP(o, juce::Identifier("sourceRoutes"), writeMap(p.getChildWithName(SourceRoutes)));
    setP(o, juce::Identifier("padGroups"), writeMap(p.getChildWithName(PadGroups)));
    setP(o, juce::Identifier("padRoutes"), writeMap(p.getChildWithName(PadRoutes)));
    setP(o, nextSampleTrack, get(nextSampleTrack, defaults::nextSampleTrack));
    setP(o, juce::Identifier("padChoke"), writeMap(p.getChildWithName(PadChoke)));
    setP(o, nextChokeGroup, get(nextChokeGroup, defaults::nextChokeGroup));
    setP(o, juce::Identifier("sourceFx"), writeSourceFx(p.getChildWithName(SourceFx)));
    setP(o, bpm, get(bpm, 0));
    setP(o, nextChopId, get(nextChopId, defaults::nextChopId));
    setP(o, timeline, p.hasProperty(timeline) ? copyVar(p[timeline]) : juce::var(juce::Array<juce::var>()));
    setP(o, timelineLength, get(timelineLength, 0));
    // legacy single-pattern fields mirror the CURRENT sequence (the engine's working state)
    const auto seqs = p.getChildWithName(Sequences);
    const int cur = std::max(0, std::min(seqs.getNumChildren() - 1, inum(p[currentSeqIdx], 0)));
    const auto curSeq = seqs.getChild(cur);
    setP(o, seqBars, curSeq.isValid() ? curSeq[bars] : juce::var(defaults::seqBars));
    setP(o, seqResolution, curSeq.isValid() ? curSeq[resolution] : juce::var(defaults::seqResolution));
    setP(o, seqGrid, curSeq.isValid() ? copyVar(curSeq[grid]) : juce::var(juce::Array<juce::var>()));
    setP(o, seqLoop, curSeq.isValid() ? curSeq[loop] : juce::var(true));
    juce::Array<juce::var> sa;
    for (const auto& s : seqs)
        sa.add(writeSequence(s));
    setP(o, juce::Identifier("sequences"), juce::var(sa));
    setP(o, currentSeqIdx, cur);
    setP(o, normalize, get(normalize, false));
    setP(o, juce::Identifier("sourceNorm"), writeMap(p.getChildWithName(SourceNorm)));
    setP(o, normalizeGain, get(normalizeGain, defaults::normalizeGain));
    const auto master = p.getChildWithName(Master);
    setP(o, juce::Identifier("master"), master.isValid() ? writeFlat(master) : writeMasterDefaults());
    if (const auto x = p.getChildWithName(ExtraFX); x.isValid())
    {
        auto xo = newObj();
        for (const auto& b : x)
            setP(xo, b.getType(), writeFlat(b));
        setP(o, juce::Identifier("extraFX"), xo);
    }
    setP(o, masterClip, get(masterClip, 0));
    setP(o, stretchEnabled, get(stretchEnabled, false));
    setP(o, targetBpm, get(targetBpm, 0));
    setP(o, chopOffsetMs, get(chopOffsetMs, 0));
    setP(o, reverseSample, get(reverseSample, false));
    setP(o, chopVolume, get(chopVolume, defaults::chopVolume));
    setP(o, metronomeBpm, get(metronomeBpm, defaults::metronomeBpm));
    setP(o, inputQuantize, get(inputQuantize, defaults::inputQuantize));
    if (const auto t = p.getChildWithName(Trims); t.isValid() && t.getNumChildren() > 0)
        setP(o, juce::Identifier("trims"), writeTrims(t));
    if (const auto s = p.getChildWithName(Stems); s.isValid())
        setP(o, stems, writeStemSet(s));
    if (const auto ss = p.getChildWithName(SourceStems); ss.isValid() && ss.getNumChildren() > 0)
    {
        auto so = newObj();
        for (const auto& s : ss)
            so.getDynamicObject()->setProperty(juce::Identifier(s[videoId].toString()), writeStemSet(s));
        setP(o, juce::Identifier("sourceStems"), so);
    }
    for (const auto& k : {drums, bass, mixer, assets})
        if (p.hasProperty(k))
            setP(o, k, copyVar(p[k]));
    setP(o, version, kProjectFormatVersion);
    return o;
}

juce::String projectToJsonText(const juce::ValueTree& project, bool stampNow)
{
    return juce::JSON::toString(projectToJson(project, stampNow), false);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
juce::ValueTree getOrCreateChild(juce::ValueTree parent, const juce::Identifier& type, juce::UndoManager* um)
{
    auto c = parent.getChildWithName(type);
    if (!c.isValid())
    {
        c = juce::ValueTree(type);
        parent.appendChild(c, um);
    }
    return c;
}
juce::ValueTree findChildWithProperty(const juce::ValueTree& parent, const juce::Identifier& prop, const juce::var& v)
{
    for (const auto& c : parent)
        if (c[prop] == v)
            return c;
    return {};
}
juce::var mapGet(const juce::ValueTree& map, const juce::var& k, const juce::var& fallback)
{
    const auto e = findChildWithProperty(map, key, k);
    return e.isValid() ? e[value] : fallback;
}
bool mapHas(const juce::ValueTree& map, const juce::var& k)
{
    return findChildWithProperty(map, key, k).isValid();
}
void mapSet(juce::ValueTree map, const juce::var& k, const juce::var& v, juce::UndoManager* um)
{
    auto e = findChildWithProperty(map, key, k);
    if (!e.isValid())
    {
        e = juce::ValueTree(Entry);
        e.setProperty(key, k, nullptr);
        e.setProperty(value, v, nullptr);
        map.appendChild(e, um);
    }
    else if (e[value] != v)
        e.setProperty(value, v, um);
}
void mapRemove(juce::ValueTree map, const juce::var& k, juce::UndoManager* um)
{
    auto e = findChildWithProperty(map, key, k);
    if (e.isValid())
        map.removeChild(e, um);
}

juce::String jsonDiff(const juce::var& a, const juce::var& b, double tol, bool allowExtraOnRight)
{
    std::function<juce::String(const juce::var&, const juce::var&, const juce::String&)> rec;
    rec = [&](const juce::var& x, const juce::var& y, const juce::String& path) -> juce::String
    {
        const bool xArr = x.isArray(), yArr = y.isArray();
        // null rows == empty rows (sparse JS arrays)
        if ((x.isVoid() && yArr && y.size() == 0) || (y.isVoid() && xArr && x.size() == 0))
            return {};
        if (xArr || yArr)
        {
            if (!(xArr && yArr))
                return path + ": array vs non-array";
            if (x.size() != y.size())
                return path + ": array length " + juce::String(x.size()) + " vs " + juce::String(y.size());
            for (int i = 0; i < x.size(); ++i)
                if (auto d = rec(x[i], y[i], path + "[" + juce::String(i) + "]"); d.isNotEmpty())
                    return d;
            return {};
        }
        if (isObj(x) || isObj(y))
        {
            if (!(isObj(x) && isObj(y)))
                return path + ": object vs non-object";
            const auto *px = props(x), *py = props(y);
            for (int i = 0; i < px->size(); ++i)
            {
                const auto k = px->getName(i);
                if (!py->contains(k))
                    return path + "." + k.toString() + ": missing on the right";
                if (auto d = rec(px->getValueAt(i), (*py)[k], path + "." + k.toString()); d.isNotEmpty())
                    return d;
            }
            if (!allowExtraOnRight)
                for (int i = 0; i < py->size(); ++i)
                    if (!px->contains(py->getName(i)))
                        return path + "." + py->getName(i).toString() + ": missing on the left";
            return {};
        }
        if (isNum(x) && isNum(y))
        {
            const double dx = num(x), dy = num(y);
            const double scale = std::max(1.0, std::max(std::abs(dx), std::abs(dy)));
            return std::abs(dx - dy) <= tol * scale ? juce::String()
                                                    : path + ": " + x.toString() + " vs " + y.toString();
        }
        if (x.isBool() || y.isBool())
            return (x.isBool() && y.isBool() && static_cast<bool>(x) == static_cast<bool>(y))
                       ? juce::String()
                       : path + ": " + x.toString() + " vs " + y.toString();
        if (x.isVoid() && y.isVoid())
            return {};
        if (x.isString() && y.isString())
            return x.toString() == y.toString() ? juce::String()
                                                : path + ": '" + x.toString() + "' vs '" + y.toString() + "'";
        return path + ": type mismatch (" + x.toString() + " vs " + y.toString() + ")";
    };
    return rec(a, b, "$");
}
} // namespace terminator::model
