#include "terminator/model/Document.h"

#include <algorithm>

#include "terminator/core/planners/Snap.h"

namespace terminator::model
{

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

juce::ValueTree Document::padOf(int index)
{
    return findChildWithProperty(pads(), ids::index, index);
}
juce::ValueTree Document::chopById(int id)
{
    return findChildWithProperty(chops(), ids::id, id);
}

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
            padN = juce::ValueTree(ids::Pad);
            padN.setProperty(ids::index, i, nullptr);
            padN.setProperty(ids::pitch, 0, nullptr);
            padN.setProperty(ids::mode, "oneshot", nullptr);
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
        padN = juce::ValueTree(ids::Pad);
        padN.setProperty(ids::index, targetPad, nullptr);
        padN.setProperty(ids::pitch, 0, nullptr);
        padN.setProperty(ids::mode, "oneshot", nullptr);
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

} // namespace terminator::model
