#pragma once
// Document = the project ValueTree + its EditHistory. Every mutation routes through the UndoManager with the
// Electron group/batch semantics, so undo/redo is structural (not whole-state snapshots) and effectively
// unbounded at a fraction of the memory. This is the message-thread owner of the project; the RT engine is
// fed from it by translating changes into Commands (Phase 2.3 EngineClient). The mutations here are the ones
// the parity gates exercise; the full ChopperEngine surface is ported feature-by-feature through Phases 2–4.
#include <juce_data_structures/juce_data_structures.h>

#include "terminator/model/EditHistory.h"
#include "terminator/model/Ids.h"
#include "terminator/model/ProjectModel.h"

namespace terminator::model
{
class Document
{
  public:
    Document();
    explicit Document(juce::ValueTree project); // takes an already-built tree (e.g. from projectFromFile)

    juce::ValueTree& tree() noexcept { return project_; }
    const juce::ValueTree& tree() const noexcept { return project_; }
    EditHistory& history() noexcept { return history_; }
    juce::UndoManager* um() noexcept { return &history_.undoManager(); }

    /// Replace the whole document (open a project). Not undoable — clears history.
    void load(juce::ValueTree project);
    void loadFromJson(const juce::var& json, juce::String& error);
    juce::var toJson(bool stampNow = false) const { return projectToJson(project_, stampNow); }

    // ── containers ──
    juce::ValueTree chops() { return project_.getChildWithName(ids::Chops); }
    juce::ValueTree pads() { return project_.getChildWithName(ids::Pads); }
    juce::ValueTree padOf(int index); // Pad node for index, or invalid
    juce::ValueTree chopById(int id);

    // ── pad params (each with the Electron coalescing group) ──
    void setPadPitch(int pad, double semitones);              // group pad-pitch-<pad>
    void setPadFades(int pad, double fadeIn, double fadeOut); // group pad-fade-<pad>
    void setPadMode(int pad, const juce::String& mode);       // oneshot|loop
    void setPadGate(int pad, bool on);
    void setPadStems(int pad, int mask); // 15/absent = ALL
    void setPadReverse(int pad, bool present, bool reverse);

    // ── chops ──
    void setChopBoundary(int chopId, bool isStart, double value); // group chop-boundary-<id>-<start|end>
    int addChop(double start, double end, bool free = false);     // returns the new chop id (nextChopId)

    // ── scalars ──
    void setScalar(const juce::Identifier& key, const juce::var& value, const juce::String& group = {});

    // ── batches (paste/dup/move/clearBlock collapse to one step) ──
    void beginBatch() { history_.beginBatch(); }
    void endBatch() { history_.endBatch(); }

    bool undo() { return history_.undo(); }
    bool redo() { return history_.redo(); }
    bool canUndo() const { return history_.canUndo(); }
    bool canRedo() const { return history_.canRedo(); }

  private:
    juce::ValueTree project_;
    EditHistory history_;
};
} // namespace terminator::model
