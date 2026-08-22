#include "terminator/model/Document.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <set>

#include "terminator/core/planners/JsMath.h"
#include "terminator/core/planners/Snap.h"
#include "terminator/core/planners/StemMask.h"
#include "terminator/model/ProjectPlanner.h"

namespace terminator::model
{
namespace
{
bool isNumVar(const juce::var& v) noexcept
{
    return v.isInt() || v.isInt64() || v.isDouble();
}
double dnum(const juce::var& v, double fallback = 0.0) noexcept
{
    return isNumVar(v) ? static_cast<double>(v) : fallback;
}
juce::ValueTree newPadNode(int index)
{
    juce::ValueTree p(ids::Pad);
    p.setProperty(ids::index, index, nullptr);
    p.setProperty(ids::pitch, 0, nullptr);
    p.setProperty(ids::mode, "oneshot", nullptr);
    return p;
}
} // namespace

// ── trims node ⇄ trim list ────────────────────────────────────────────────────────────────────────
trims::TrimList readTrimList(const juce::ValueTree& project)
{
    trims::TrimList out;
    for (const auto& t : project.getChildWithName(ids::Trims))
    {
        trims::TrimRegion r;
        r.startSec = dnum(t[ids::startSec]);
        r.endSec = dnum(t[ids::endSec]);
        for (const auto& c : t)
        {
            trims::TrimChop tc;
            tc.id = static_cast<int>(c[ids::id]);
            tc.startSec = dnum(c[ids::startSec]);
            tc.endSec = dnum(c[ids::endSec]);
            tc.padIdx = c.hasProperty(ids::padIdx) ? static_cast<int>(c[ids::padIdx]) : -1;
            tc.stems = c.hasProperty(ids::stems) ? static_cast<int>(c[ids::stems]) : -1;
            r.chops.push_back(tc);
        }
        out.push_back(std::move(r));
    }
    return out;
}

void writeTrimList(juce::ValueTree project, const trims::TrimList& list, juce::UndoManager* um)
{
    auto node = getOrCreateChild(project, ids::Trims, um);
    node.removeAllChildren(um);
    for (const auto& r : list)
    {
        juce::ValueTree t(ids::Trim);
        t.setProperty(ids::startSec, r.startSec, nullptr);
        t.setProperty(ids::endSec, r.endSec, nullptr);
        for (const auto& c : r.chops)
        {
            juce::ValueTree tc(ids::TrimChop);
            tc.setProperty(ids::id, c.id, nullptr);
            tc.setProperty(ids::startSec, c.startSec, nullptr);
            tc.setProperty(ids::endSec, c.endSec, nullptr);
            if (c.padIdx >= 0)
                tc.setProperty(ids::padIdx, c.padIdx, nullptr);
            if (c.stems >= 0)
                tc.setProperty(ids::stems, c.stems, nullptr);
            t.appendChild(tc, nullptr);
        }
        node.appendChild(t, um);
    }
}

// ── construction / load ──────────────────────────────────────────────────────────────────────────
Document::Document() : project_(createEmptyProject()) {}
Document::Document(juce::ValueTree project) : project_(std::move(project)) {}

void Document::load(juce::ValueTree project)
{
    project_ = std::move(project);
    history_.clear();
}
void Document::loadFromJson(const juce::var& json, juce::String& error)
{
    auto p = projectFromJson(json, error);
    if (p.isValid())
        load(p);
}

// ── lookups ──────────────────────────────────────────────────────────────────────────────────────
juce::ValueTree Document::padOf(int index)
{
    return findChildWithProperty(pads(), ids::index, index);
}
juce::ValueTree Document::chopById(int id)
{
    return findChildWithProperty(chops(), ids::id, id);
}
juce::ValueTree Document::padSourceOf(int index)
{
    return findChildWithProperty(padSources(), ids::pad, index);
}
bool Document::hasPadContent(int pad) const
{
    auto* self = const_cast<Document*>(this);
    const auto p = self->padOf(pad);
    return (p.isValid() && p.hasProperty(ids::chopId)) || self->padSourceOf(pad).isValid();
}
int Document::maxPadIndex() const
{
    int maxPad = -1;
    for (const auto& p : project_.getChildWithName(ids::Pads))
        maxPad = std::max(maxPad, static_cast<int>(p[ids::index]));
    for (const auto& s : project_.getChildWithName(ids::PadSources))
        maxPad = std::max(maxPad, static_cast<int>(s[ids::pad]));
    return maxPad;
}
juce::ValueTree Document::ensurePad(int upTo)
{
    // dense like the TS pads array: every index up to `upTo` gets a node
    auto padsN = pads();
    for (int i = 0; i <= upTo; ++i)
        if (!padOf(i).isValid())
            padsN.appendChild(newPadNode(i), um());
    return padOf(upTo);
}
int Document::padIdxForChop(int chopId) const
{
    auto* self = const_cast<Document*>(this);
    for (const auto& p : project_.getChildWithName(ids::Pads))
        if (p.hasProperty(ids::chopId) && static_cast<int>(p[ids::chopId]) == chopId &&
            !self->padSourceOf(static_cast<int>(p[ids::index])).isValid())
            return static_cast<int>(p[ids::index]);
    return -1;
}
bool Document::sourceReverseOf(int pad) const
{
    const auto key = padSourceKey(pad);
    if (key == "main")
        return static_cast<bool>(project_.getProperty(ids::reverseSample, false));
    const auto fx = findChildWithProperty(project_.getChildWithName(ids::SourceFx), ids::key, key);
    return fx.isValid() && fx.hasProperty(ids::reverse) ? static_cast<bool>(fx[ids::reverse]) : false;
}

// ── pad params ───────────────────────────────────────────────────────────────────────────────────
void Document::setPadPitch(int pad, double semitones)
{
    auto p = padOf(pad);
    if (!p.isValid())
        return;
    const double v = juce::jlimit(-24.0, 24.0, semitones);
    history_.begin("pad-pitch-" + juce::String(pad));
    p.setProperty(ids::pitch, v, um());
}
void Document::setPadFades(int pad, double fadeIn, double fadeOut)
{
    auto p = padOf(pad);
    if (!p.isValid())
        return;
    history_.begin("pad-fade-" + juce::String(pad));
    if (fadeIn > 0.0)
        p.setProperty(ids::fadeIn, fadeIn, um());
    else
        p.removeProperty(ids::fadeIn, um());
    if (fadeOut > 0.0)
        p.setProperty(ids::fadeOut, fadeOut, um());
    else
        p.removeProperty(ids::fadeOut, um());
}
void Document::setPadMode(int pad, const juce::String& mode)
{
    auto p = padOf(pad);
    if (!p.isValid())
        return;
    history_.begin();
    p.setProperty(ids::mode, mode == "loop" ? "loop" : "oneshot", um());
}
void Document::setPadGate(int pad, bool on)
{
    auto p = padOf(pad);
    if (!p.isValid())
        return;
    history_.begin();
    if (on)
        p.setProperty(ids::gate, true, um());
    else
        p.removeProperty(ids::gate, um());
}
void Document::setPadStems(int pad, int mask)
{
    auto p = padOf(pad);
    if (!p.isValid())
        return;
    history_.begin();
    if (mask >= 1 && mask <= 15 && mask != 15)
        p.setProperty(ids::stems, mask, um());
    else
        p.removeProperty(ids::stems, um());
}
void Document::setPadReverse(int pad, bool present, bool reverse)
{
    auto p = padOf(pad);
    if (!p.isValid())
        return;
    history_.begin();
    if (present)
        p.setProperty(ids::reverse, reverse, um());
    else
        p.removeProperty(ids::reverse, um());
}
void Document::setPadsReverse(const std::vector<int>& padIdxs, std::optional<bool> rev)
{
    // Asking for the direction the pad's SOURCE already plays clears the override instead of freezing a
    // duplicate of it — so flipping a pad back makes it follow the source again.
    auto want = [&](int i) -> std::optional<bool>
    {
        if (!rev.has_value() || *rev == sourceReverseOf(i))
            return std::nullopt;
        return rev;
    };
    std::vector<int> hit;
    for (int i : padIdxs)
    {
        auto p = padOf(i);
        if (!p.isValid())
            continue;
        const std::optional<bool> cur =
            p.hasProperty(ids::reverse) ? std::optional<bool>(static_cast<bool>(p[ids::reverse])) : std::nullopt;
        if (cur != want(i))
            hit.push_back(i);
    }
    if (hit.empty())
        return;
    history_.begin();
    for (int i : hit)
    {
        auto p = padOf(i);
        const auto w = want(i);
        if (w.has_value())
            p.setProperty(ids::reverse, *w, um());
        else
            p.removeProperty(ids::reverse, um());
    }
}

// ── chops ────────────────────────────────────────────────────────────────────────────────────────
void Document::setChopBoundary(int chopId, bool isStart, double value)
{
    auto c = chopById(chopId);
    if (!c.isValid())
        return;
    history_.begin("chop-boundary-" + juce::String(chopId) + (isStart ? "-start" : "-end"));
    c.setProperty(isStart ? ids::start : ids::end, value, um());
}
int Document::addChop(double start_, double end_, bool free_)
{
    const int nid = static_cast<int>(project_.getProperty(ids::nextChopId, defaults::nextChopId));
    history_.begin();
    juce::ValueTree c(ids::Chop);
    c.setProperty(ids::id, nid, nullptr);
    c.setProperty(ids::start, start_, nullptr);
    c.setProperty(ids::end, end_, nullptr);
    if (free_)
        c.setProperty(ids::free, true, nullptr);
    chops().appendChild(c, um());
    project_.setProperty(ids::nextChopId, nid + 1, um());
    return nid;
}
int Document::cloneChop(int sourceChopId)
{
    auto src = chopById(sourceChopId);
    if (!src.isValid())
        return sourceChopId;
    history_.begin();
    const int nid = static_cast<int>(project_.getProperty(ids::nextChopId, defaults::nextChopId));
    juce::ValueTree c(ids::Chop);
    c.setProperty(ids::id, nid, nullptr);
    c.setProperty(ids::start, src[ids::start], nullptr);
    c.setProperty(ids::end, src[ids::end], nullptr);
    c.setProperty(ids::free, true, nullptr);
    chops().appendChild(c, um());
    project_.setProperty(ids::nextChopId, nid + 1, um());
    return nid;
}
int Document::reviveChop(int chopId, double start_, double end_)
{
    if (chopById(chopId).isValid())
        return chopId;
    return addChop(start_, end_, true);
}

void Document::setScalar(const juce::Identifier& key, const juce::var& value, const juce::String& group)
{
    history_.begin(group);
    project_.setProperty(key, value, um());
}

double Document::snap(double posSec, int snapMode) const
{
    const auto mode = static_cast<snap::Mode>(juce::jlimit(0, 4, snapMode));
    return snap::applySnap(posSec, mode, analysis_.bpm, analysis_.transients, analysis_.drumTransients,
                           analysis_.broadbandTransients);
}

int Document::autoChop(int n, double startOffset)
{
    if (n < 1)
        return 0;
    const double dur = analysis_.bufferDurationSec;
    if (!(dur > startOffset))
        return 0;
    history_.begin({}, "auto-chop");
    // clear the main chops and any pad pointing at one; pad sources stay
    auto chopsN = chops();
    chopsN.removeAllChildren(um());
    auto padsN = pads();
    for (auto padN : padsN)
        if (padN.hasProperty(ids::chopId))
            padN.removeProperty(ids::chopId, um());
    int nid = static_cast<int>(project_.getProperty(ids::nextChopId, defaults::nextChopId));
    const double step = (dur - startOffset) / n;
    for (int i = 0; i < n; ++i)
    {
        juce::ValueTree c(ids::Chop);
        c.setProperty(ids::id, nid, nullptr);
        c.setProperty(ids::start, startOffset + i * step, nullptr);
        c.setProperty(ids::end, startOffset + (i + 1) * step, nullptr);
        chopsN.appendChild(c, um());
        // place on pad i (create the pad node if missing)
        auto padN = padOf(i);
        if (!padN.isValid())
        {
            padN = newPadNode(i);
            padsN.appendChild(padN, um());
        }
        padN.setProperty(ids::chopId, nid, um());
        ++nid;
    }
    project_.setProperty(ids::nextChopId, nid, um());
    return n;
}

int Document::sliceAtTime(double timeSec, int targetPad, int snapMode)
{
    const double pos = snap(timeSec, snapMode);
    // find the main chop containing pos
    juce::ValueTree src;
    for (auto c : chops())
        if (pos >= static_cast<double>(c[ids::start]) && pos < static_cast<double>(c[ids::end]))
        {
            src = c;
            break;
        }
    if (!src.isValid())
        return -1;
    if (pos - static_cast<double>(src[ids::start]) < 0.01 || static_cast<double>(src[ids::end]) - pos < 0.01)
        return -1; // 10 ms min each side
    history_.begin();
    const int nid = static_cast<int>(project_.getProperty(ids::nextChopId, defaults::nextChopId));
    juce::ValueTree c(ids::Chop);
    c.setProperty(ids::id, nid, nullptr);
    c.setProperty(ids::start, pos, nullptr);
    c.setProperty(ids::end, static_cast<double>(src[ids::end]), nullptr);
    // insert right after src
    const int srcIdx = chops().indexOf(src);
    chops().addChild(c, srcIdx + 1, um());
    src.setProperty(ids::end, pos, um());
    // assign to the target pad
    auto padN = padOf(targetPad);
    if (!padN.isValid())
    {
        padN = newPadNode(targetPad);
        pads().appendChild(padN, um());
    }
    padN.setProperty(ids::chopId, nid, um());
    // stems carry over from the source chop's pad (dossier inheritStems)
    if (auto fromPad = findChildWithProperty(pads(), ids::chopId, static_cast<int>(src[ids::id])); fromPad.isValid())
    {
        if (fromPad.hasProperty(ids::stems))
            padN.setProperty(ids::stems, fromPad[ids::stems], um());
        else
            padN.removeProperty(ids::stems, um());
    }
    project_.setProperty(ids::nextChopId, nid + 1, um());
    return nid;
}

void Document::autoSliceTransients(std::optional<double> sensitivity)
{
    if (!(analysis_.bufferDurationSec > 0.0))
        return;
    // Live drag of the sensitivity knob fires many calls — coalesce them.
    history_.begin("auto-slice", "auto-slice");
    if (sensitivity.has_value())
        transientSensitivity_ = std::max(0.0, std::min(1.0, *sensitivity));
    const int N = static_cast<int>(analysis_.transients.size());
    if (N == 0)
    {
        // Nothing detected yet (still analyzing or silent buffer) — fall back to 1 pad
        autoChop(1);
        return;
    }
    const double sens = transientSensitivity_;
    // Power curve so the lower half of the knob still produces useful counts. Desktop has no cap: the
    // effective max is the detected count.
    const int effMax = N;
    const int wantCount =
        std::max(0, std::min(effMax, static_cast<int>(js::round(static_cast<double>(effMax) * std::pow(sens, 0.7)))));
    // Pick the strongest `wantCount` transients (stable on ties, like Array.sort), then re-sort by time
    std::vector<int> order(static_cast<std::size_t>(N));
    std::iota(order.begin(), order.end(), 0);
    auto strengthAt = [&](int i)
    {
        return i < static_cast<int>(analysis_.transientStrengths.size())
                   ? analysis_.transientStrengths[static_cast<std::size_t>(i)]
                   : 0.0f;
    };
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return strengthAt(a) > strengthAt(b); });
    order.resize(static_cast<std::size_t>(wantCount));
    std::vector<double> cuts;
    for (int i : order)
        cuts.push_back(static_cast<double>(analysis_.transients[static_cast<std::size_t>(i)]));
    std::stable_sort(cuts.begin(), cuts.end());

    const double dur = analysis_.bufferDurationSec;
    std::vector<double> boundaries;
    boundaries.push_back(0.0);
    boundaries.insert(boundaries.end(), cuts.begin(), cuts.end());
    boundaries.push_back(dur);

    // the old layout: chop regions + the stems of the pad holding each chop (any pad with a chopId)
    struct OldChop
    {
        int id;
        double start, end;
    };
    std::vector<OldChop> oldChops;
    for (const auto& c : chops())
        oldChops.push_back({static_cast<int>(c[ids::id]), dnum(c[ids::start]), dnum(c[ids::end])});
    std::map<int, juce::var> oldMask; // chop id -> stems var (void = absent)
    for (const auto& p : pads())
        if (p.hasProperty(ids::chopId))
            oldMask[static_cast<int>(p[ids::chopId])] = p.hasProperty(ids::stems) ? p[ids::stems] : juce::var();

    int nid = static_cast<int>(project_.getProperty(ids::nextChopId, defaults::nextChopId));
    auto chopsN = chops();
    chopsN.removeAllChildren(um());
    std::vector<std::pair<int, double>> newChops; // id, start
    for (std::size_t i = 0; i + 1 < boundaries.size(); ++i)
    {
        const double s = boundaries[i], e = boundaries[i + 1];
        if (e - s < 0.02)
            continue; // skip slivers
        juce::ValueTree c(ids::Chop);
        c.setProperty(ids::id, nid, nullptr);
        c.setProperty(ids::start, s, nullptr);
        c.setProperty(ids::end, e, nullptr);
        chopsN.appendChild(c, um());
        newChops.emplace_back(nid, s);
        ++nid;
    }
    project_.setProperty(ids::nextChopId, nid, um());

    const int nChops = static_cast<int>(newChops.size());
    ensurePad(std::max(0, nChops - 1));
    // pads.length = nChops — the TS truncates the pads array (pad sources above keep their entries)
    auto padsN = pads();
    for (int k = padsN.getNumChildren(); --k >= 0;)
        if (static_cast<int>(padsN.getChild(k)[ids::index]) >= nChops)
            padsN.removeChild(k, um());
    for (int i = 0; i < nChops; ++i)
    {
        auto p = padOf(i);
        p.setProperty(ids::chopId, newChops[static_cast<std::size_t>(i)].first, um());
        // stems carry over from the old chop this one starts in
        const double st = newChops[static_cast<std::size_t>(i)].second;
        juce::var mask;
        for (const auto& oc : oldChops)
            if (st >= oc.start && st < oc.end)
            {
                if (auto it = oldMask.find(oc.id); it != oldMask.end())
                    mask = it->second;
                break;
            }
        if (mask.isVoid())
            p.removeProperty(ids::stems, um());
        else
            p.setProperty(ids::stems, mask, um());
    }
}

// ── pads: content ────────────────────────────────────────────────────────────────────────────────
void Document::forgetPadRoute(int pad)
{
    mapRemove(project_.getChildWithName(ids::PadRoutes), pad, um());
    mapRemove(project_.getChildWithName(ids::PadChoke), pad, um());
}
void Document::ensureSourceRoute(const juce::String& key)
{
    if (key == "main")
        return;
    auto routes = project_.getChildWithName(ids::SourceRoutes);
    if (mapHas(routes, key))
        return;
    const int n = static_cast<int>(project_.getProperty(ids::nextSampleTrack, defaults::nextSampleTrack));
    mapSet(routes, key, "sample" + juce::String(n), um());
    project_.setProperty(ids::nextSampleTrack, n + 1, um());
}
void Document::pruneSourceStems()
{
    auto ss = project_.getChildWithName(ids::SourceStems);
    if (!ss.isValid() || ss.getNumChildren() == 0)
        return;
    std::set<juce::String> live;
    for (const auto& s : padSources())
        live.insert(s[ids::videoId].toString());
    for (int k = ss.getNumChildren(); --k >= 0;)
        if (live.count(ss.getChild(k)[ids::videoId].toString()) == 0)
            ss.removeChild(k, um());
}

void Document::assignChopToPad(int pad, int chopId)
{
    if (pad < 0)
        return;
    history_.begin();
    auto p = ensurePad(pad); // allocate lazily-created pads (paste/dup/move into an untouched slot)
    p.setProperty(ids::chopId, chopId, um());
}

void Document::unassignPad(int pad)
{
    auto p = padOf(pad);
    if (!p.isValid())
        return;
    history_.begin();
    if (auto so = padSourceOf(pad); so.isValid())
        padSources().removeChild(so, um());
    p.removeProperty(ids::chopId, um());
    forgetPadRoute(pad);
}

void Document::setPadSource(int pad, const juce::String& videoId, const juce::String& title, double start_, double end_)
{
    if (pad < 0)
        return;
    history_.begin();
    ensurePad(pad);
    auto prev = padSourceOf(pad);
    // A different source landing on this pad takes the pad with it: drop any per-pad routing override; the
    // source gets its own strip if new.
    if (!prev.isValid() || prev[ids::videoId].toString() != videoId)
        forgetPadRoute(pad);
    ensureSourceRoute("src:" + videoId);
    if (prev.isValid())
        padSources().removeChild(prev, um());
    juce::ValueTree s(ids::PadSource);
    s.setProperty(ids::pad, pad, nullptr);
    s.setProperty(ids::videoId, videoId, nullptr);
    s.setProperty(ids::title, title, nullptr);
    s.setProperty(ids::start, start_, nullptr);
    s.setProperty(ids::end, end_, nullptr);
    padSources().appendChild(s, um());
}

void Document::clearPad(int pad)
{
    auto p = padOf(pad);
    if (!p.isValid())
        return;
    history_.begin();
    forgetPadRoute(pad);

    // Remove the per-pad sample if present
    if (auto so = padSourceOf(pad); so.isValid())
    {
        padSources().removeChild(so, um());
        p.removeProperty(ids::stems, um());
        pruneSourceStems();
        return;
    }
    if (!p.hasProperty(ids::chopId))
        return;
    const int chopId = static_cast<int>(p[ids::chopId]);
    // Always empty ONLY the targeted pad's slot.
    p.removeProperty(ids::chopId, um());

    // Duplicated pads share a chopId. Splice the underlying chop out of the waveform (merging its region into
    // a neighbour) ONLY when no OTHER pad still references it.
    bool sharedByOther = false;
    for (const auto& q : pads())
        if (static_cast<int>(q[ids::index]) != pad && q.hasProperty(ids::chopId) &&
            static_cast<int>(q[ids::chopId]) == chopId)
        {
            sharedByOther = true;
            break;
        }
    if (sharedByOther)
        return;
    auto chopsN = chops();
    auto removed = chopById(chopId);
    if (!removed.isValid())
        return;
    const int idx = chopsN.indexOf(removed);
    // A `free` chop (a duplicate clone) isn't part of the contiguous chain, so removing it leaves no gap —
    // splice it out without merging a neighbour.
    if (!static_cast<bool>(removed.getProperty(ids::free, false)))
    {
        if (idx > 0)
            chopsN.getChild(idx - 1).setProperty(ids::end, removed[ids::end], um()); // previous absorbs it
        else if (idx < chopsN.getNumChildren() - 1)
            chopsN.getChild(idx + 1).setProperty(ids::start, removed[ids::start], um()); // next extends back
    }
    chopsN.removeChild(removed, um());
}

void Document::clearBlock(int pad)
{
    const auto range = blocks::blockRange(slots(), pad);
    if (!range)
        return;
    beginBatch();
    for (int i = range->second; i >= range->first; --i)
        clearPad(i);
    endBatch();
}

// ── slots / rearrange ────────────────────────────────────────────────────────────────────────────
std::optional<Document::SlotContent> Document::snapSlot(int i)
{
    auto p = padOf(i);
    auto so = padSourceOf(i);
    if (!so.isValid() && !(p.isValid() && p.hasProperty(ids::chopId)))
        return std::nullopt;
    SlotContent c;
    if (p.isValid())
        c.pad = p.createCopy();
    if (so.isValid())
        c.source = so.createCopy();
    c.route = mapGet(project_.getChildWithName(ids::PadRoutes), i);
    c.choke = mapGet(project_.getChildWithName(ids::PadChoke), i);
    c.group = mapGet(project_.getChildWithName(ids::PadGroups), i);
    return c;
}

void Document::placeSlot(int i, const SlotContent* s, bool touchGroups)
{
    auto srcN = padSources();
    auto routesN = project_.getChildWithName(ids::PadRoutes);
    auto chokeN = project_.getChildWithName(ids::PadChoke);
    auto groupsN = project_.getChildWithName(ids::PadGroups);
    // empty the slot: its content leaves; the play settings (pitch/mode/gate/fades) stay behind like the TS
    if (auto so = padSourceOf(i); so.isValid())
        srcN.removeChild(so, um());
    if (auto p = padOf(i); p.isValid())
    {
        p.removeProperty(ids::chopId, um());
        p.removeProperty(ids::stems, um());
        p.removeProperty(ids::reverse, um());
    }
    mapRemove(routesN, i, um());
    mapRemove(chokeN, i, um());
    if (touchGroups)
        mapRemove(groupsN, i, um());
    if (s == nullptr)
        return;
    auto p = ensurePad(i);
    if (s->pad.isValid()) // existing content: its full pad props travel (keep the destination index)
        for (int k = 0; k < s->pad.getNumProperties(); ++k)
        {
            const auto pn = s->pad.getPropertyName(k);
            if (pn == ids::index)
                continue;
            p.setProperty(pn, s->pad[pn], um());
        }
    if (s->source.isValid())
    {
        auto so = s->source.createCopy();
        so.setProperty(ids::pad, i, nullptr);
        srcN.appendChild(so, um());
    }
    if (!s->route.isVoid())
        mapSet(routesN, i, s->route, um());
    if (!s->choke.isVoid())
        mapSet(chokeN, i, s->choke, um());
    if (touchGroups && !s->group.isVoid())
        mapSet(groupsN, i, s->group, um());
}

void Document::remapSteps(const std::vector<int>& oldToNew, int n, bool spliceVanished)
{
    for (auto seq : project_.getChildWithName(ids::Sequences))
    {
        auto grid = seq[ids::grid];
        auto* rows = grid.getArray();
        if (rows == nullptr)
            continue;
        juce::Array<juce::var> ng;
        for (auto& row : *rows)
        {
            juce::Array<juce::var> nr;
            if (auto* cells = row.getArray())
                for (auto& cell : *cells)
                {
                    const int old = static_cast<int>(cell);
                    const int nw = (old >= 0 && old < static_cast<int>(oldToNew.size()))
                                       ? oldToNew[static_cast<std::size_t>(old)]
                                       : -1;
                    if (nw >= 0)
                        nr.add(nw);
                    else if (!(spliceVanished && old < n))
                        nr.add(old);
                }
            ng.add(juce::var(nr));
        }
        seq.setProperty(ids::grid, juce::var(ng), um());
    }
}

blocks::Slots Document::slots() const
{
    const int maxPad = maxPadIndex();
    blocks::Slots s(static_cast<std::size_t>(std::max(0, maxPad + 1)));
    for (int i = 0; i <= maxPad; ++i)
    {
        const auto k = padSourceKey(i);
        if (k.isNotEmpty())
            s[static_cast<std::size_t>(i)] = k.toStdString();
    }
    return s;
}

void Document::rearrange(const std::function<void(blocks::Slots&, std::vector<int>&)>& plan,
                         const std::map<int, SlotContent>& newAt)
{
    const int n = maxPadIndex() + 1;
    std::vector<std::optional<SlotContent>> snaps(static_cast<std::size_t>(n));
    for (int i = 0; i < n; ++i)
        snaps[static_cast<std::size_t>(i)] = snapSlot(i);
    blocks::Slots keys = slots();
    std::vector<int> origin(static_cast<std::size_t>(n));
    std::iota(origin.begin(), origin.end(), 0);
    plan(keys, origin);
    // old index → new index (an old index that vanished maps to -1: its steps are dropped)
    const int total = std::max(n, static_cast<int>(origin.size()));
    std::vector<int> oldToNew(static_cast<std::size_t>(total), -1);
    for (int i = 0; i < static_cast<int>(origin.size()); ++i)
        if (const int o = origin[static_cast<std::size_t>(i)]; o >= 0 && o < total)
            oldToNew[static_cast<std::size_t>(o)] = i;
    // empty every slot, then re-place from the origin map (routes/chokes/groups follow their pads)
    for (int i = 0; i < total; ++i)
        placeSlot(i, nullptr, true);
    for (int i = 0; i < static_cast<int>(origin.size()); ++i)
    {
        const int o = origin[static_cast<std::size_t>(i)];
        if (o >= 0 && o < n && snaps[static_cast<std::size_t>(o)].has_value())
            placeSlot(i, &*snaps[static_cast<std::size_t>(o)], true);
        else if (auto it = newAt.find(i); it != newAt.end())
            placeSlot(i, &it->second, true);
    }
    remapSteps(oldToNew, n, true);
}

bool Document::movePad(int src, int dest)
{
    if (src == dest || src < 0 || dest < 0)
        return false;
    history_.begin({}, "move-pad");
    ensurePad(std::max(src, dest));
    auto a = snapSlot(src);
    auto b = snapSlot(dest);
    const bool swap = b.has_value();
    // groups stay pinned to their indices (the TS movePad never touches padGroups)
    placeSlot(dest, a ? &*a : nullptr, false);
    placeSlot(src, swap ? &*b : nullptr, false);
    // steps: src → dest, and dest → src on a swap; nothing else changes
    const int n = std::max(maxPadIndex() + 1, std::max(src, dest) + 1);
    std::vector<int> oldToNew(static_cast<std::size_t>(n));
    std::iota(oldToNew.begin(), oldToNew.end(), 0);
    oldToNew[static_cast<std::size_t>(src)] = dest;
    if (swap)
        oldToNew[static_cast<std::size_t>(dest)] = src;
    remapSteps(oldToNew, n, false);
    return a.has_value() || b.has_value();
}

// ── blocks ───────────────────────────────────────────────────────────────────────────────────────
juce::String Document::padSourceKey(int pad) const
{
    return ProjectPlanner(project_).padSourceKey(pad);
}

blocks::Room Document::roomAfterBlock(int pad) const
{
    return blocks::roomAfterBlock(slots(), pad);
}

bool Document::moveBlock(int from, int to)
{
    const auto s = slots();
    const auto range = blocks::blockRange(s, from);
    if (!range)
        return false;
    const int lo = range->first, hi = range->second;
    if (to >= lo && to <= hi)
        return false;
    const int len = hi - lo + 1;
    const auto destRange = blocks::blockRange(s, to);
    // singles swap (a one-wide block onto a one-wide block, or onto an empty pad)
    if (len == 1 && (!destRange || destRange->first == destRange->second))
        return movePad(from, to);
    history_.begin({}, "move-block");
    rearrange(
        [lo, hi, to](blocks::Slots& sl, std::vector<int>& origin)
        {
            blocks::Slots items(sl.begin() + lo, sl.begin() + hi + 1);
            std::vector<int> origins(origin.begin() + lo, origin.begin() + hi + 1);
            for (int i = lo; i <= hi; ++i)
            {
                sl[static_cast<std::size_t>(i)] = std::nullopt;
                origin[static_cast<std::size_t>(i)] = -1;
            }
            // insertPushing marks origin -1; restore the moved pads' origins so their steps follow them
            blocks::insertPushing(sl, origin, to, items);
            for (std::size_t k = 0; k < items.size(); ++k)
                origin[static_cast<std::size_t>(to) + k] = origins[k];
        });
    return true;
}

// ── pad sources: chop into the room ──────────────────────────────────────────────────────────────
int Document::chopPadSource(int pad, std::vector<double> times)
{
    auto pb = padSourceOf(pad);
    if (!pb.isValid())
        return 0;
    const double s0 = dnum(pb[ids::start]), e0 = dnum(pb[ids::end]);
    std::vector<double> cuts;
    for (double t : times)
        if (t > s0 + 0.01 && t < e0 - 0.01 && std::find(cuts.begin(), cuts.end(), t) == cuts.end())
            cuts.push_back(t);
    std::sort(cuts.begin(), cuts.end());
    if (cuts.empty())
        return 0;
    // Only into the empty pads right after the block — never push a neighbour.
    const auto room = roomAfterBlock(pad);
    if (room.free < static_cast<int>(cuts.size()))
        return -1;
    history_.begin({}, "chop-pad-source");
    std::vector<double> edges;
    edges.push_back(s0);
    edges.insert(edges.end(), cuts.begin(), cuts.end());
    edges.push_back(e0);
    pb.setProperty(ids::end, edges[1], um()); // the pad keeps the first piece
    const auto group = mapGet(project_.getChildWithName(ids::PadGroups), pad);
    const auto padN = padOf(pad);
    const juce::var stems = padN.isValid() && padN.hasProperty(ids::stems) ? padN[ids::stems] : juce::var();
    std::map<int, SlotContent> items;
    for (std::size_t k = 1; k + 1 < edges.size(); ++k)
    {
        SlotContent c;
        c.source = juce::ValueTree(ids::PadSource);
        c.source.setProperty(ids::videoId, pb[ids::videoId], nullptr);
        c.source.setProperty(ids::title, pb[ids::title], nullptr);
        c.source.setProperty(ids::start, edges[k], nullptr);
        c.source.setProperty(ids::end, edges[k + 1], nullptr);
        if (!stems.isVoid()) // a new piece starts with the SAME layers (as main-track chops do)
        {
            c.pad = juce::ValueTree(ids::Pad);
            c.pad.setProperty(ids::stems, stems, nullptr);
        }
        c.group = group;
        items[room.at + static_cast<int>(k) - 1] = std::move(c);
    }
    const int insertAt = room.at;
    const int count = static_cast<int>(items.size());
    rearrange(
        [insertAt, count](blocks::Slots& sl, std::vector<int>& origin)
        {
            blocks::Slots newKeys(static_cast<std::size_t>(count), blocks::Key{std::string("new")});
            blocks::insertPushing(sl, origin, insertAt, newKeys);
        },
        items);
    return count;
}

bool Document::chopPadSourceTo(int pad, double time, int targetPad)
{
    auto pb = padSourceOf(pad);
    if (!pb.isValid() || targetPad < 0)
        return false;
    const double s0 = dnum(pb[ids::start]), e0 = dnum(pb[ids::end]);
    if (time <= s0 + 0.01 || time >= e0 - 0.01)
        return false;
    history_.begin({}, "chop-pad-source");
    pb.setProperty(ids::end, time, um());
    SlotContent c;
    c.source = juce::ValueTree(ids::PadSource);
    c.source.setProperty(ids::videoId, pb[ids::videoId], nullptr);
    c.source.setProperty(ids::title, pb[ids::title], nullptr);
    c.source.setProperty(ids::start, time, nullptr);
    c.source.setProperty(ids::end, e0, nullptr);
    if (auto padN = padOf(pad); padN.isValid() && padN.hasProperty(ids::stems))
    {
        c.pad = juce::ValueTree(ids::Pad);
        c.pad.setProperty(ids::stems, padN[ids::stems], nullptr);
    }
    c.group = mapGet(project_.getChildWithName(ids::PadGroups), pad);
    std::map<int, SlotContent> items;
    items[targetPad] = std::move(c);
    rearrange([targetPad](blocks::Slots& sl, std::vector<int>& origin)
              { blocks::insertPushing(sl, origin, targetPad, blocks::Slots{blocks::Key{std::string("new")}}); }, items);
    return true;
}

int Document::autoChopPadSource(int pad, int n)
{
    auto pb = padSourceOf(pad);
    if (!pb.isValid())
        return 0;
    const double s0 = dnum(pb[ids::start]), e0 = dnum(pb[ids::end]);
    std::vector<double> times;
    if (n >= 2)
    {
        const double step = (e0 - s0) / n;
        for (int i = 0; i < n - 1; ++i)
            times.push_back(s0 + (i + 1) * step);
    }
    return chopPadSource(pad, std::move(times));
}

int Document::autoChopPadSourceAtTransients(int pad, const std::vector<double>& onsetTimes)
{
    auto pb = padSourceOf(pad);
    if (!pb.isValid())
        return 0;
    const double s0 = dnum(pb[ids::start]), e0 = dnum(pb[ids::end]);
    std::vector<double> times;
    for (double t : onsetTimes)
        if (t > s0 && t < e0)
            times.push_back(t);
    // take as many as there is room for (from the start)
    const auto room = roomAfterBlock(pad);
    times.resize(static_cast<std::size_t>(std::min<int>(static_cast<int>(times.size()), std::max(0, room.free))));
    if (times.empty())
        return -1;
    return chopPadSource(pad, std::move(times));
}

std::vector<Document::SourceChop> Document::padSourceChops(int pad) const
{
    std::vector<SourceChop> out;
    auto* self = const_cast<Document*>(this);
    const auto pb = self->padSourceOf(pad);
    if (!pb.isValid())
        return out;
    const auto vid = pb[ids::videoId].toString();
    for (const auto& s : project_.getChildWithName(ids::PadSources))
        if (s[ids::videoId].toString() == vid)
            out.push_back({static_cast<int>(s[ids::pad]), dnum(s[ids::start]), dnum(s[ids::end])});
    std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return a.start < b.start; });
    return out;
}

// ── trims ────────────────────────────────────────────────────────────────────────────────────────
bool Document::addTrim(double t0, double t1)
{
    const double dur = analysis_.bufferDurationSec;
    if (!(dur > 0.0))
        return false;
    const double a = std::max(0.0, std::min(dur, std::min(t0, t1)));
    const double b = std::max(0.0, std::min(dur, std::max(t0, t1)));
    if (b - a < 0.02)
        return false;
    if (b - a >= dur - 0.02)
        return false; // never trim the whole sample away
    const auto cur = trimList();
    history_.begin({}, "trim");
    const double removed = b - a;
    const double f0 = trims::effToFile(cur, a), f1 = trims::effToFile(cur, b, true);
    std::vector<trims::TrimChop> swallowed;
    auto padStems = [&](int pad) -> int
    {
        if (pad < 0)
            return -1;
        auto p = padOf(pad);
        return p.isValid() && p.hasProperty(ids::stems) ? static_cast<int>(p[ids::stems]) : -1;
    };
    auto swallow = [&](const juce::ValueTree& c)
    {
        const int id = static_cast<int>(c[ids::id]);
        const int pad = padIdxForChop(id);
        swallowed.push_back({id, trims::effToFile(cur, dnum(c[ids::start])),
                             trims::effToFile(cur, dnum(c[ids::end]), true), pad, padStems(pad)});
    };
    auto chopsN = chops();
    std::set<int> kept;
    for (int k = 0; k < chopsN.getNumChildren();)
    {
        auto c = chopsN.getChild(k);
        const int id = static_cast<int>(c[ids::id]);
        const double cs = dnum(c[ids::start]), ce = dnum(c[ids::end]);
        if (ce <= a)
        {
            kept.insert(id);
            ++k;
            continue;
        }
        if (cs >= b)
        {
            c.setProperty(ids::start, cs - removed, um());
            c.setProperty(ids::end, ce - removed, um());
            kept.insert(id);
            ++k;
            continue;
        }
        if (cs >= a && ce <= b)
        {
            swallow(c);
            chopsN.removeChild(c, um());
            continue;
        }
        // straddles an edge (or both): keep what sits outside the cut; the part inside rides the trim under
        // the SAME id so RESTORE extends it back.
        const double ns = cs < a ? cs : a;
        const double ne = ce > b ? ce - removed : a;
        if (ne - ns >= 0.01)
        {
            c.setProperty(ids::start, ns, um());
            c.setProperty(ids::end, ne, um());
            kept.insert(id);
            const int pad = padIdxForChop(id);
            swallowed.push_back({id, trims::effToFile(cur, std::max(cs, a)),
                                 trims::effToFile(cur, std::min(ce, b), true), pad, padStems(pad)});
            ++k;
        }
        else
        {
            swallow(c);
            chopsN.removeChild(c, um());
        }
    }
    for (auto p : pads())
        if (p.hasProperty(ids::chopId) && kept.count(static_cast<int>(p[ids::chopId])) == 0)
        {
            forgetPadRoute(static_cast<int>(p[ids::index]));
            p.removeProperty(ids::chopId, um());
            p.removeProperty(ids::stems, um());
        }
    writeTrimList(project_, trims::addTrimRegion(cur, f0, f1, std::move(swallowed)), um());
    // transients live in the trimmed timeline: drop the cut, slide the rest (every detector array)
    auto cut = [&](std::vector<float>& times, std::vector<float>& strengths)
    {
        auto r = trims::cutTimes(times, strengths, a, b);
        times = std::move(r.times);
        strengths = std::move(r.strengths);
    };
    cut(analysis_.broadbandTransients, analysis_.broadbandStrengths);
    cut(analysis_.drumTransients, analysis_.drumStrengths);
    cut(analysis_.transients, analysis_.transientStrengths);
    analysis_.bufferDurationSec = dur - removed;
    return true;
}

bool Document::restoreTrims()
{
    const auto prev = trimList();
    if (prev.empty())
        return false;
    history_.begin({}, "restore-trims");
    std::vector<trims::TrimChop> swallowed;
    for (const auto& t : prev)
        swallowed.insert(swallowed.end(), t.chops.begin(), t.chops.end());
    std::stable_sort(swallowed.begin(), swallowed.end(),
                     [](const auto& x, const auto& y) { return x.startSec < y.startSec; });
    // surviving chops + transients: trimmed timeline → the original's
    auto chopsN = chops();
    for (auto c : chopsN)
    {
        c.setProperty(ids::start, trims::effToFile(prev, dnum(c[ids::start])), um());
        c.setProperty(ids::end, trims::effToFile(prev, dnum(c[ids::end]), true), um());
    }
    auto back = [&](std::vector<float>& arr)
    {
        for (auto& t : arr)
            t = static_cast<float>(trims::effToFile(prev, static_cast<double>(t)));
    };
    back(analysis_.broadbandTransients);
    back(analysis_.drumTransients);
    back(analysis_.transients);
    writeTrimList(project_, {}, um());
    for (const auto& sc : swallowed)
    {
        // A clipped survivor (same id still on the grid) grows back to cover the part the cut took; a
        // swallowed chop comes back whole on a pad.
        if (auto alive = chopById(sc.id); alive.isValid())
        {
            alive.setProperty(ids::start, std::min(dnum(alive[ids::start]), sc.startSec), um());
            alive.setProperty(ids::end, std::max(dnum(alive[ids::end]), sc.endSec), um());
            continue;
        }
        const int id = sc.id;
        const int next = static_cast<int>(project_.getProperty(ids::nextChopId, defaults::nextChopId));
        if (id >= next)
            project_.setProperty(ids::nextChopId, id + 1, um());
        juce::ValueTree c(ids::Chop);
        c.setProperty(ids::id, id, nullptr);
        c.setProperty(ids::start, sc.startSec, nullptr);
        c.setProperty(ids::end, sc.endSec, nullptr);
        chopsN.appendChild(c, um());
        int home = -1;
        if (sc.padIdx >= 0)
        {
            auto p = padOf(sc.padIdx);
            if (p.isValid() && !p.hasProperty(ids::chopId) && !padSourceOf(sc.padIdx).isValid())
                home = sc.padIdx;
        }
        if (home < 0)
            home = blocks::nextSlotForSource(slots(), "main");
        auto p = ensurePad(home);
        p.setProperty(ids::chopId, id, um());
        if (sc.stems >= 0)
            p.setProperty(ids::stems, sc.stems, um());
        else
            p.removeProperty(ids::stems, um());
    }
    // chops sorted by start (stable)
    std::vector<juce::ValueTree> copies;
    for (const auto& c : chopsN)
        copies.push_back(c.createCopy());
    std::stable_sort(copies.begin(), copies.end(),
                     [](const auto& x, const auto& y) { return dnum(x[ids::start]) < dnum(y[ids::start]); });
    bool inOrder = true;
    for (int k = 0; k < chopsN.getNumChildren(); ++k)
        if (static_cast<int>(chopsN.getChild(k)[ids::id]) !=
            static_cast<int>(copies[static_cast<std::size_t>(k)][ids::id]))
            inOrder = false;
    if (!inOrder)
    {
        chopsN.removeAllChildren(um());
        for (auto& c : copies)
            chopsN.appendChild(c, um());
    }
    analysis_.bufferDurationSec += trims::totalTrimmedSec(prev);
    return true;
}

// ── pad clipboard ────────────────────────────────────────────────────────────────────────────────
std::optional<padclip::PadContent> Document::getPadContent(int pad) const
{
    auto* self = const_cast<Document*>(this);
    auto p = self->padOf(pad);
    if (!p.isValid())
        return std::nullopt;
    padclip::PadContent c;
    c.pitch = dnum(p[ids::pitch]);
    c.mode = p.getProperty(ids::mode, "oneshot").toString() == "loop" ? "loop" : "oneshot";
    c.gate = static_cast<bool>(p.getProperty(ids::gate, false));
    c.fadeIn = dnum(p[ids::fadeIn]);
    c.fadeOut = dnum(p[ids::fadeOut]);
    if (auto so = self->padSourceOf(pad); so.isValid())
    {
        c.type = padclip::PadContent::Type::buffer;
        c.videoId = so[ids::videoId].toString().toStdString();
        c.title = so[ids::title].toString().toStdString();
        c.start = dnum(so[ids::start]);
        c.end = dnum(so[ids::end]);
        return c;
    }
    if (!p.hasProperty(ids::chopId))
        return std::nullopt;
    const int chopId = static_cast<int>(p[ids::chopId]);
    auto chop = self->chopById(chopId);
    if (!chop.isValid())
        return std::nullopt;
    c.type = padclip::PadContent::Type::chop;
    c.chopId = chopId;
    c.start = dnum(chop[ids::start]);
    c.end = dnum(chop[ids::end]);
    // the STEM mask travels with the pad (15 = ALL); the per-pad REV override too (nullopt = follow source)
    c.stems = p.hasProperty(ids::stems) ? static_cast<int>(stems::normalizeMaskValue(dnum(p[ids::stems])))
                                        : static_cast<int>(stems::kMaskAll);
    if (p.hasProperty(ids::reverse))
        c.reverse = static_cast<bool>(p[ids::reverse]);
    return c;
}

void Document::setPadSlot(int pad, const std::optional<padclip::PadContent>& content)
{
    if (pad < 0)
        return;
    history_.begin();
    unassignPad(pad);
    if (!content.has_value())
        return;
    const auto& c = *content;
    if (c.type == padclip::PadContent::Type::buffer)
        setPadSource(pad, c.videoId, c.title, c.start, c.end);
    else
        assignChopToPad(pad, reviveChop(c.chopId, c.start, c.end));
    setPadPitch(pad, c.pitch);
    setPadMode(pad, c.mode);
    setPadGate(pad, c.gate);
    setPadFades(pad, c.fadeIn, c.fadeOut);
    setPadStems(pad, c.type == padclip::PadContent::Type::chop ? c.stems : static_cast<int>(stems::kMaskAll));
    setPadsReverse({pad}, c.type == padclip::PadContent::Type::chop ? c.reverse : std::nullopt);
}

std::vector<padclip::PadContent> Document::copyPads(const std::vector<int>& padIdxs) const
{
    std::vector<padclip::PadContent> out;
    for (int i : padclip::copyOrder(padIdxs))
        if (auto c = getPadContent(i))
            out.push_back(*c);
    return out;
}

int Document::pastePads(int at, const std::vector<padclip::PadContent>& items, int limit)
{
    const auto plan = padclip::pastePlan(at, static_cast<int>(items.size()), limit);
    if (plan.empty())
        return 0;
    beginBatch();
    for (const auto& [dest, k] : plan)
        setPadSlot(dest, items[static_cast<std::size_t>(k)]);
    endBatch();
    return static_cast<int>(plan.size());
}

int Document::clearPads(const std::vector<int>& padIdxs)
{
    const auto list = padclip::clearOrder(padIdxs, [&](int i) { return hasPadContent(i); });
    if (list.empty())
        return 0;
    beginBatch();
    for (int i : list)
        clearPad(i);
    endBatch();
    return static_cast<int>(list.size());
}

std::vector<padclip::PadContent> Document::cutPads(const std::vector<int>& padIdxs)
{
    auto items = copyPads(padIdxs);
    if (items.empty())
        return items;
    beginBatch();
    for (int i : padclip::cutOrder(padIdxs, [&](int k) { return hasPadContent(k); }))
        unassignPad(i);
    endBatch();
    return items;
}

int Document::duplicatePads(const std::vector<int>& padIdxs, int limit)
{
    const auto plan = padclip::duplicatePlan(
        padIdxs, [&](int i) { return getPadContent(i).has_value(); }, [&](int i) { return hasPadContent(i); }, limit);
    if (plan.empty())
        return 0;
    beginBatch();
    for (const auto& [src, dest] : plan)
    {
        auto c = getPadContent(src);
        if (!c)
            continue;
        if (c->type == padclip::PadContent::Type::chop)
            c->chopId = cloneChop(c->chopId); // the copy gets its OWN chop (fresh id, same region)
        setPadSlot(dest, c);
    }
    endBatch();
    return static_cast<int>(plan.size());
}

} // namespace terminator::model
