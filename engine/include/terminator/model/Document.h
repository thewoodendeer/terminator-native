#pragma once
// Document = the project ValueTree + its EditHistory. Every mutation routes through the UndoManager with the
// Electron group/batch semantics, so undo/redo is structural (not whole-state snapshots) and effectively
// unbounded at a fraction of the memory. This is the message-thread owner of the project; the RT engine is
// fed from it by translating changes into Commands (Phase 2.3 EngineClient). The mutations here are the ones
// the parity gates exercise; the full ChopperEngine surface is ported feature-by-feature through Phases 2–4.
#include <functional>
#include <map>
#include <optional>
#include <vector>

#include <juce_data_structures/juce_data_structures.h>

#include "terminator/core/planners/Blocks.h"
#include "terminator/core/planners/PadClipboard.h"
#include "terminator/core/planners/Trims.h"
#include "terminator/model/EditHistory.h"
#include "terminator/model/Ids.h"
#include "terminator/model/ProjectModel.h"

namespace terminator::model
{
/// The project's Trims node ⇄ the pure trim list (Trims{Trim{startSec endSec TrimChop{…}}} shape, FILE time).
trims::TrimList readTrimList(const juce::ValueTree& project);
void writeTrimList(juce::ValueTree project, const trims::TrimList& list, juce::UndoManager* um);

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
    juce::ValueTree padSources() { return project_.getChildWithName(ids::PadSources); }
    juce::ValueTree padOf(int index); // Pad node for index, or invalid
    juce::ValueTree chopById(int id);
    juce::ValueTree padSourceOf(int index); // PadSource node for a pad, or invalid
    /// Does the pad hold anything (a chop or its own sample)?
    bool hasPadContent(int pad) const;

    // ── pad params (each with the Electron coalescing group) ──
    void setPadPitch(int pad, double semitones);              // group pad-pitch-<pad>
    void setPadFades(int pad, double fadeIn, double fadeOut); // group pad-fade-<pad>
    void setPadMode(int pad, const juce::String& mode);       // oneshot|loop
    void setPadGate(int pad, bool on);
    void setPadStems(int pad, int mask); // 15/absent = ALL
    void setPadReverse(int pad, bool present, bool reverse);
    /// setPadsReverse: nullopt (or the direction the pad's SOURCE already plays) clears the override.
    void setPadsReverse(const std::vector<int>& pads, std::optional<bool> rev);

    // ── analysis state (set by the caller after decoding the main buffer; not persisted, not undone) ──
    struct Analysis
    {
        double bpm = 0.0;
        double bufferDurationSec = 0.0; // the EFFECTIVE (trimmed) duration
        std::vector<float> transients;  // the ACTIVE set (broadband or drum-only)
        std::vector<float> transientStrengths;
        std::vector<float> drumTransients; // for the grid anchor
        std::vector<float> drumStrengths;
        std::vector<float> broadbandTransients;
        std::vector<float> broadbandStrengths;
    };
    void setAnalysis(Analysis a) { analysis_ = std::move(a); }
    const Analysis& analysis() const noexcept { return analysis_; }
    double snap(double posSec, int snapMode) const; // 0 off,1 transient,2 1/4,3 1/8,4 1/16
    double transientSensitivity() const noexcept { return transientSensitivity_; }

    // ── chops ──
    void setChopBoundary(int chopId, bool isStart, double value); // group chop-boundary-<id>-<start|end>
    int addChop(double start, double end, bool free = false);     // returns the new chop id (nextChopId)
    /// Equal-division auto-chop: replace the main chops with `n` chops over [startOffset, duration), placed on
    /// pads 0..n-1 (a fresh grid; block push-aside is a later increment). One undo step. bpm/duration from
    /// analysis(). Returns the number of chops made.
    int autoChop(int n, double startOffset = 0.0);
    /// Slice the main chop containing `timeSec` (snapped) onto `targetPad`; returns the new chop id or -1.
    int sliceAtTime(double timeSec, int targetPad, int snapMode = 0);
    /// Auto-slice at the strongest transients by the sensitivity knob (0..1; nullopt = keep the stored one):
    /// wantCount = round(N * sens^0.7) of the N detected onsets, re-sorted by time, slivers < 20 ms skipped,
    /// chops onto pads 0..n-1 (pads truncated to n like the TS), stems carried over from the old chop each new
    /// one starts in. Coalescing group "auto-slice". N == 0 → autoChop(1).
    void autoSliceTransients(std::optional<double> sensitivity = std::nullopt);
    /// Composable chop primitives (no step of their own inside a batch): a `free` copy with a fresh id (or the
    /// id unchanged when it does not exist); the chop if it still exists else a fresh free one from the region.
    int cloneChop(int sourceChopId);
    int reviveChop(int chopId, double start, double end);

    // ── scalars ──
    void setScalar(const juce::Identifier& key, const juce::var& value, const juce::String& group = {});

    // ── pads: content ──
    /// Point a pad at a chop (creates the pad node lazily). No check that the chop exists (TS parity).
    void assignChopToPad(int pad, int chopId);
    /// Empty a pad's slot (drop its own sample, null its chop, forget its route/choke) WITHOUT touching the
    /// chop layout — the clipboard's non-destructive empty.
    void unassignPad(int pad);
    /// The pad's OWN sample (loadPadBuffer's tree half): a different source landing drops the per-pad route
    /// override; the source gets its mixer strip ('sampleN') if new. chopId is kept.
    void setPadSource(int pad, const juce::String& videoId, const juce::String& title, double start, double end);
    /// CLEAR: a pad-source pad drops its PadSource + stems (+ SourceStems no pad uses any more); a chop pad
    /// empties ONLY this slot and splices the chop out of the waveform if no other pad references it — a
    /// `free` chop goes without merging, otherwise the previous chop absorbs its end (or, for the first chop,
    /// its successor extends back). One undo step.
    void clearPad(int pad);
    /// clearPad over the pad's whole block, hi → lo, one batch.
    void clearBlock(int pad);
    /// Move — or swap — a pad's full content (play props incl. pitch/mode/gate/fades/stems/reverse, its
    /// PadSource, index-keyed route + choke overrides; PadGroups stay put like the TS) and remap every
    /// sequence's steps src→dest (and dest→src on a swap). One undo step. false on a no-op.
    bool movePad(int src, int dest);

    // ── blocks (source-key runs) ──
    /// The source key of a pad slot ('main'/'src:<id>'/group), or empty — for building the blocks array.
    juce::String padSourceKey(int pad) const;
    /// The source-key slot array over every pad index the tree knows (pads + pad sources).
    blocks::Slots slots() const;
    /// Move pad `from`'s whole block onto `to`, pushing others aside; singles swap (movePad). Remaps sequencer
    /// steps. One undo step. Returns false on a no-op.
    bool moveBlock(int from, int to);
    /// How many empty pads sit right after the pad's block (the room it can chop into; scan <= 64).
    blocks::Room roomAfterBlock(int pad) const;

    // ── pad sources: chop a pad's own sample into the room after its block ──
    /// Cut at `times` (inside (start+10ms, end-10ms), deduped, sorted): the pad keeps the first piece, the rest
    /// land in the empty pads right after the block — never pushing a neighbour. New pieces share the source's
    /// videoId/title and inherit the pad's group override + stems. Returns the number of new pieces, 0 when
    /// nothing to cut, -1 when there is no room. One undo step.
    int chopPadSource(int pad, std::vector<double> times);
    /// Cut at `time` and put the tail on `targetPad` (pushed free if something sits there). One undo step.
    bool chopPadSourceTo(int pad, double time, int targetPad);
    /// `n` equal pieces of the pad's current trim (→ chopPadSource).
    int autoChopPadSource(int pad, int n);
    /// At the given onset times (the caller detects them on the pad's sample); takes as many as there is room
    /// for, from the start. -1 when none fit.
    int autoChopPadSourceAtTransients(int pad, const std::vector<double>& times);
    struct SourceChop
    {
        int pad = 0;
        double start = 0.0;
        double end = 0.0;
    };
    /// Every pad that plays from the same source as `pad` (its own sample), each with its trim, by start.
    std::vector<SourceChop> padSourceChops(int pad) const;

    // ── trims (non-destructive section deletion; tree + analysis side — the audio rebuild is the caller's) ──
    trims::TrimList trimList() const { return readTrimList(project_); }
    double effToFile(double effSec, bool end = false) const { return trims::effToFile(trimList(), effSec, end); }
    double fileToEff(double fileSec) const { return trims::fileToEff(trimList(), fileSec); }
    /// Cut [t0, t1) (EFFECTIVE seconds) out of the sample: 20 ms minimum, never the whole sample; chops after
    /// slide, chops across are clipped (the inside part rides the trim under the same id), chops inside are
    /// SWALLOWED into the trim with their pad + stems and their pads emptied; transients cut on every detector
    /// array; Analysis.bufferDurationSec shrinks. One undo step. The caller rebuilds the effective buffer from
    /// trimList() (trims::buildEffectiveChannels).
    bool addTrim(double t0, double t1);
    /// RESTORE TRIM: every cut comes back with the chops it swallowed — on their old pads when still empty,
    /// else on the next free 'main' slot; clipped survivors grow back; chops re-sorted by start. One undo step.
    bool restoreTrims();

    // ── pad clipboard (padClipboard.ts over the Document; every multi-pad op = one batch) ──
    std::optional<padclip::PadContent> getPadContent(int pad) const;
    /// Drop content onto a pad, replacing whatever is there (non-destructive: unassignPad, then the content's
    /// play settings are always written). nullopt = just empty it.
    void setPadSlot(int pad, const std::optional<padclip::PadContent>& content);
    std::vector<padclip::PadContent> copyPads(const std::vector<int>& pads) const;
    /// Returns how many landed (items past `limit`/64 are dropped).
    int pastePads(int at, const std::vector<padclip::PadContent>& items, int limit = padclip::kPadGridMax);
    /// clearPad back-to-front; returns how many pads had content.
    int clearPads(const std::vector<int>& pads);
    /// Copy, then EMPTY (unassign) the pads; returns the copied items.
    std::vector<padclip::PadContent> cutPads(const std::vector<int>& pads);
    /// Duplicate onto the free slots after them (a chop pad's copy gets its OWN free chop). Returns how many.
    int duplicatePads(const std::vector<int>& pads, int limit = padclip::kPadGridMax);

    // ── batches (paste/dup/move/clearBlock collapse to one step) ──
    void beginBatch() { history_.beginBatch(); }
    void endBatch() { history_.endBatch(); }

    bool undo() { return history_.undo(); }
    bool redo() { return history_.redo(); }
    bool canUndo() const { return history_.canUndo(); }
    bool canRedo() const { return history_.canRedo(); }

  private:
    /// A snapshot of one pad slot's content (the TS PadSlot): the Pad node's props, its PadSource, and the
    /// index-keyed overrides. `pad` invalid = a NEW item (a chop-into-room piece) that carries no play props.
    struct SlotContent
    {
        juce::ValueTree pad;    // detached copy of the Pad node (props), or invalid
        juce::ValueTree source; // detached copy of the PadSource node, or invalid
        juce::var route, choke, group;
    };
    int maxPadIndex() const;             // highest index any Pad / PadSource node names, -1 when none
    juce::ValueTree ensurePad(int upTo); // every Pad node up to `upTo` exists; returns Pad `upTo`
    std::optional<SlotContent> snapSlot(int i);
    /// Empty slot i (chopId/stems/reverse/source/route/choke[/group]) then place `s` if given.
    void placeSlot(int i, const SlotContent* s, bool touchGroups);
    /// Rewrite every sequence grid by old→new pad index (-1 = vanished: spliced when < n, kept otherwise
    /// when `spliceVanished`, else left as is).
    void remapSteps(const std::vector<int>& oldToNew, int n, bool spliceVanished);
    /// ChopperEngine.rearrange: snapshot every slot, run `plan` over the key array + origin map, re-place
    /// everything from origin (routes/chokes/groups follow their pads), put `newAt` items where origin is -1,
    /// remap the sequencer steps. Caller opens the undo step.
    void rearrange(const std::function<void(blocks::Slots&, std::vector<int>&)>& plan,
                   const std::map<int, SlotContent>& newAt = {});
    void forgetPadRoute(int pad);
    void ensureSourceRoute(const juce::String& key);
    void pruneSourceStems();
    int padIdxForChop(int chopId) const;
    bool sourceReverseOf(int pad) const; // the pad's SOURCE REV (not the per-pad override)

    juce::ValueTree project_;
    EditHistory history_;
    Analysis analysis_;
    double transientSensitivity_ = 0.3; // desktop default (the web build starts at 0)
};
} // namespace terminator::model
