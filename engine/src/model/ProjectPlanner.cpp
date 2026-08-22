#include "terminator/model/ProjectPlanner.h"

#include "terminator/core/planners/SeqRefit.h"
#include "terminator/core/planners/Swing.h"

namespace terminator::model
{
using namespace ids;

namespace
{
juce::ValueTree padNode(const juce::ValueTree& p, int index)
{
    return findChildWithProperty(p.getChildWithName(Pads), ids::index, index);
}
bool hasChop(const juce::ValueTree& padN)
{
    return padN.isValid() && padN.hasProperty(chopId);
}
} // namespace

juce::String ProjectPlanner::padSourceKey(int padIndex) const
{
    // padGroups override → the pad's own source
    const auto grp = mapGet(p_.getChildWithName(PadGroups), padIndex);
    if (!grp.isVoid())
        return grp.toString();
    const auto src = findChildWithProperty(p_.getChildWithName(PadSources), ids::pad, padIndex);
    if (src.isValid())
        return "src:" + src[videoId].toString();
    if (hasChop(padNode(p_, padIndex)))
        return "main";
    return {};
}

juce::String ProjectPlanner::chokeGroupOf(int padIndex) const
{
    const auto own = mapGet(p_.getChildWithName(PadChoke), padIndex);
    if (!own.isVoid())
        return own.toString();
    const auto srcKey = padSourceKey(padIndex);
    return srcKey.isNotEmpty() ? srcKey : juce::String("none");
}

juce::String ProjectPlanner::seqTailGroup(int padIndex) const
{
    const auto g = chokeGroupOf(padIndex);
    return g == "none" ? ("pad:" + juce::String(padIndex)) : g;
}

bool ProjectPlanner::reversedFor(int padIndex) const
{
    const auto padN = padNode(p_, padIndex);
    if (padN.isValid() && padN.hasProperty(reverse))
        return static_cast<bool>(padN[reverse]);
    // source REV: 'main' → reverseSample; a pad source/group → sourceFx[key].reverse
    const auto srcKey = padSourceKey(padIndex);
    if (srcKey == "main")
        return static_cast<bool>(p_.getProperty(reverseSample, false));
    const auto fx = findChildWithProperty(p_.getChildWithName(SourceFx), ids::key, srcKey);
    return fx.isValid() && fx.hasProperty(reverse) ? static_cast<bool>(fx[reverse]) : false;
}

double ProjectPlanner::tempoBpm() const
{
    const double metro = static_cast<double>(p_.getProperty(metronomeBpm, 0));
    if (metro > 0)
        return metro;
    const double b = static_cast<double>(p_.getProperty(bpm, 0));
    return b > 0 ? b : 120.0;
}

juce::ValueTree ProjectPlanner::currentSequence() const
{
    const auto seqs = p_.getChildWithName(Sequences);
    const int cur =
        juce::jlimit(0, std::max(0, seqs.getNumChildren() - 1), static_cast<int>(p_.getProperty(currentSeqIdx, 0)));
    return seqs.getChild(cur);
}

std::vector<SeqEvent> ProjectPlanner::patternToEvents(const juce::ValueTree& seq, double offsetSec) const
{
    std::vector<SeqEvent> out;
    if (!seq.isValid())
        return out;
    const int numBars = static_cast<int>(seq.getProperty(ids::bars, 1));
    const int res = static_cast<int>(seq.getProperty(ids::resolution, 16));
    const int steps = seq::stepCount(numBars, res);
    const double tempo = tempoBpm();
    const double stepDur = (60.0 / tempo) * (4.0 / res);
    const auto gridV = seq.getProperty(ids::grid);
    const auto velV = seq.getProperty(ids::velGrid);
    auto rowAt = [](const juce::var& g, int step) -> juce::var
    {
        const auto* a = g.getArray();
        return (a != nullptr && step < a->size()) ? (*a)[step] : juce::var();
    };
    // active steps (any pad) for the tail-length search
    std::vector<int> active;
    for (int s = 0; s < steps; ++s)
        if (const auto* r = rowAt(gridV, s).getArray(); r != nullptr && r->size() > 0)
            active.push_back(s);
    for (std::size_t i = 0; i < active.size(); ++i)
    {
        const int step = active[i];
        const auto* row = rowAt(gridV, step).getArray();
        const auto* vrow = rowAt(velV, step).getArray();
        const double startAt = offsetSec + step * stepDur + swing::seqSwingOffsetSec(step, res, tempo, swing_);
        for (int r = 0; r < row->size(); ++r)
        {
            const int firePad = static_cast<int>((*row)[r]);
            const auto group = seqTailGroup(firePad);
            int endStep = steps;
            for (std::size_t j = i + 1; j < active.size(); ++j)
            {
                const int s2 = active[j];
                const auto* r2 = rowAt(gridV, s2).getArray();
                bool fires = false;
                for (const auto& q : *r2)
                    if (seqTailGroup(static_cast<int>(q)) == group)
                    {
                        fires = true;
                        break;
                    }
                if (fires)
                {
                    endStep = s2;
                    break;
                }
            }
            const double maxDur = (endStep - step) * stepDur;
            const float vel =
                seq::clampVel(vrow != nullptr && r < vrow->size() ? static_cast<double>((*vrow)[r]) : 1.0);
            out.push_back({firePad, startAt, maxDur, reversedFor(firePad), vel});
        }
    }
    return out;
}
} // namespace terminator::model
