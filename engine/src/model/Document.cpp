#include "terminator/model/Document.h"

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
} // namespace terminator::model
