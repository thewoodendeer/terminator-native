#pragma once
// Undo = juce::UndoManager over the project ValueTree, with the Electron history semantics on top
// (dossier-chopper-core §1.5): 500 ms coalescing by group key (`pad-pitch-N`, `pad-fade-N`,
// `chop-boundary-<id>-<side>`, `auto-slice`), begin/end batch so composite edits (paste / dup / move /
// clearBlock) collapse to ONE step, and sample audio referenced — never copied — by the tree (source ids).
// Every Document mutation calls begin(group) first, exactly where ChopperEngine called pushHistory(group).
#include <functional>

#include <juce_data_structures/juce_data_structures.h>

namespace terminator::model
{
class EditHistory
{
  public:
    static constexpr double kCoalesceMs = 500.0;
    /// Default limits: ≥ 500 transactions kept (the Phase 2 gate), bounded by units (≈ bytes of actions).
    explicit EditHistory(int maxUnits = 64 * 1024 * 1024, int minTransactions = 500);

    /// Start an undoable edit. Inside a batch: no-op (the batch's single transaction continues). With a
    /// `group`: a second call for the same group within kCoalesceMs joins the same transaction (drag gestures).
    void begin(const juce::String& group = {}, const juce::String& name = {});
    void beginBatch();
    void endBatch();
    int batchDepth() const noexcept { return batchDepth_; }

    bool undo();
    bool redo();
    bool canUndo() const { return undoManager_.canUndo(); }
    bool canRedo() const { return undoManager_.canRedo(); }
    int numUndoSteps() const { return static_cast<int>(undoManager_.getUndoDescriptions().size()); }
    void clear(); // drop everything (fresh session)

    juce::UndoManager& undoManager() noexcept { return undoManager_; }
    const juce::UndoManager& undoManager() const noexcept { return undoManager_; }
    /// The clock the coalescing reads (ms; injectable for tests — default = juce::Time::getMillisecondCounterHiRes).
    std::function<double()> nowMs;

  private:
    juce::UndoManager undoManager_;
    int batchDepth_ = 0;
    juce::String lastGroup_;
    double lastGroupMs_ = -1.0e12;
};
} // namespace terminator::model
