#include "terminator/model/EditHistory.h"

namespace terminator::model
{
EditHistory::EditHistory(int maxUnits, int minTransactions)
    : nowMs([] { return juce::Time::getMillisecondCounterHiRes(); }), undoManager_(maxUnits, minTransactions)
{
}

void EditHistory::begin(const juce::String& group, const juce::String& name)
{
    if (batchDepth_ > 0)
        return;
    const double now = nowMs();
    if (group.isNotEmpty() && group == lastGroup_ && now - lastGroupMs_ < kCoalesceMs &&
        undoManager_.getNumActionsInCurrentTransaction() > 0)
    {
        lastGroupMs_ = now; // keep riding the same step while the gesture continues
        return;
    }
    lastGroup_ = group;
    lastGroupMs_ = group.isNotEmpty() ? now : -1.0e12;
    undoManager_.beginNewTransaction(name.isNotEmpty() ? name : group);
}

void EditHistory::beginBatch()
{
    if (batchDepth_ == 0)
    {
        lastGroup_.clear();
        undoManager_.beginNewTransaction("batch");
    }
    ++batchDepth_;
}

void EditHistory::endBatch()
{
    batchDepth_ = batchDepth_ > 0 ? batchDepth_ - 1 : 0;
}

bool EditHistory::undo()
{
    lastGroup_.clear();
    undoManager_.beginNewTransaction(); // close whatever gesture was open so it is undone as a unit
    return undoManager_.undo();
}

bool EditHistory::redo()
{
    lastGroup_.clear();
    return undoManager_.redo();
}

void EditHistory::clear()
{
    undoManager_.clearUndoHistory();
    lastGroup_.clear();
    batchDepth_ = 0;
}
} // namespace terminator::model
