#pragma once
// Read-only queries over the project ValueTree that the transport/exporter/EngineClient need — ported from the
// pure parts of ChopperEngine: pad source identity, choke/tail groups, and patternToEvents (a stored sequence →
// sample-accurate events with swing, per-cell velocity, per-pad reverse, and a note length that ends at the
// next step where its tail group fires). No audio here; the caller resolves each pad's region + buffer.
#include <cstdint>
#include <vector>

#include <juce_data_structures/juce_data_structures.h>

#include "terminator/model/Ids.h"
#include "terminator/model/ProjectModel.h"

namespace terminator::model
{
/// One scheduled note from a sequence (offline render / live scheduler feed).
struct SeqEvent
{
    int pad = 0;
    double time = 0.0;    // seconds from the pattern start
    double maxDur = 0.0;  // seconds until the next same-tail-group hit (or the pattern end)
    bool reverse = false; // the pad's effective reverse at playback time
    float velocity = 1.0f;
};

class ProjectPlanner
{
  public:
    explicit ProjectPlanner(const juce::ValueTree& project) : p_(project) {}

    // ── source identity / groups (parity with padSourceKey / chokeGroupOf) ──
    /// 'main' (a main-track chop), 'src:<videoId>' (the pad's own sample), a group override, or empty (empty pad).
    juce::String padSourceKey(int pad) const;
    /// The mute/tail group: the padChoke override, else the source key, else 'none'.
    juce::String chokeGroupOf(int pad) const;
    /// The sequencer's tail group: chokeGroupOf, or 'pad:<i>' when 'none' (a polyphonic pad still ends at its
    /// own next hit — dossier §2.4).
    juce::String seqTailGroup(int pad) const;
    /// Effective reverse: the pad's own override, else its source's REV (sourceFx / reverseSample for 'main').
    bool reversedFor(int pad) const;

    // ── transport ──
    double tempoBpm() const; // metronomeBpm > 0 ? : bpm > 0 ? : 120
    double seqSwing() const { return swing_; }
    void setSeqSwing(double s) { swing_ = s; }

    /// A stored sequence node → events. `offsetSec` shifts the whole pattern (arranger). Mirrors
    /// ChopperEngine.patternToEvents exactly (swing on the STORED step, velocity floor 0.05, tail-group length).
    std::vector<SeqEvent> patternToEvents(const juce::ValueTree& sequence, double offsetSec = 0.0) const;
    /// The current working sequence (sequences[currentSeqIdx]).
    juce::ValueTree currentSequence() const;

  private:
    juce::ValueTree p_;
    double swing_ = 0.0;
};
} // namespace terminator::model
