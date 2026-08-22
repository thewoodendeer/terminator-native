#pragma once
// The project model — a juce::ValueTree whose shape mirrors the Electron ChopPreset JSON (field names
// unchanged, B10) so the tree IS the undo model (juce::UndoManager records every property/child change) AND
// serialises straight to .tproj / .tprojz / the cloud row. Reader accepts every legacy shape loadPreset
// accepts (no version field, single-pattern seq fields, drums._inputQuantize); writer emits the current
// getPresetData() shape + `version: 2` (additive; the Electron loader ignores unknown fields).
//
// Tree shape (node types capitalised, properties = JSON keys):
//   Project{videoId savedAt name? trackTitle bpm nextChopId timelineLength seqBars seqResolution seqLoop
//           currentSeqIdx normalize normalizeGain masterClip stretchEnabled targetBpm chopOffsetMs reverseSample
//           chopVolume metronomeBpm inputQuantize nextSampleTrack nextChokeGroup | opaque vars: timeline seqGrid
//           drums bass mixer assets}
//     Chops{Chop{id start end free?}*}  Pads{Pad{index chopId? mode pitch gate? fadeIn? fadeOut? stems? reverse?}*}
//     PadSources{PadSource{pad videoId title start end}*}            (JSON padBufferMeta)
//     SourceRoutes/PadRoutes/PadGroups/PadChoke/SourceNorm{Entry{key value}*}
//     SourceFx{Fx{key attack? pitch? fine? reverse?}*}
//     Sequences{Sequence{bars resolution viewResolution loop grid revGrid velGrid}*}  (grids = var arrays)
//     Master{volume pitch fine? filterFreq … release}  ExtraFX{clipper{…} waveshaper{…} … chorus{…}}
//     Trims{Trim{startSec endSec TrimChop{id startSec endSec padIdx? stems?}*}*}
//     Stems{quality readyRanges StemAssets{drums? bass? other? vocals?}}
//     SourceStems{SourceStem{videoId quality readyRanges StemAssets{…}}*}
// drums / bass / mixer are opaque `var` blobs until their engines land (Phases 3/4): they round-trip
// losslessly and undo replaces them whole (what the Electron history does too).
#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

#include "terminator/model/Ids.h"

namespace terminator::model
{
inline constexpr int kProjectFormatVersion = 2;
inline constexpr const char* kNoSampleId = "none"; // videoId of a project saved with no main track

/// Defaults the Electron engine applies when a field is absent (dossier-chopper-core §1.2/§1.3).
namespace defaults
{
inline constexpr double chopVolume = 1.0;
inline constexpr double normalizeGain = 1.0;
inline constexpr int metronomeBpm = 120;
inline constexpr int inputQuantize = 100;
inline constexpr int nextSampleTrack = 2;
inline constexpr int nextChokeGroup = 1;
inline constexpr int nextChopId = 1;
inline constexpr int seqBars = 1;
inline constexpr int seqResolution = 16;
inline constexpr double masterVolume = 0.85;
inline constexpr double masterAttack = 0.003;
} // namespace defaults

/// A fresh, empty project tree (every container child present, no pads/chops).
juce::ValueTree createEmptyProject();

/// ChopPreset JSON → tree. Tolerant like loadPreset: missing fields stay absent (accessors apply defaults),
/// legacy single-pattern fields build Sequences[0], `drums._inputQuantize` migrates to inputQuantize,
/// sequences' resolutions are validated, stem masks normalised. Returns an invalid tree + error for non-objects.
juce::ValueTree projectFromJson(const juce::var& json, juce::String& error);
juce::ValueTree projectFromJsonText(const juce::String& text, juce::String& error);
juce::ValueTree projectFromFile(const juce::File& file, juce::String& error); // .tproj (JSON); .tprojz = Phase 8

/// Tree → ChopPreset JSON (getPresetData() shape + view-attached sections + version). `savedAt` is written
/// as stored; pass `stampNow` to refresh it.
juce::var projectToJson(const juce::ValueTree& project, bool stampNow = false);
juce::String projectToJsonText(const juce::ValueTree& project, bool stampNow = false); // pretty, like .tproj

// ── typed helpers over the tree (no UndoManager: pass one to the setters you call yourself) ──────
juce::ValueTree getOrCreateChild(juce::ValueTree parent, const juce::Identifier& type, juce::UndoManager* um);
juce::ValueTree findChildWithProperty(const juce::ValueTree& parent, const juce::Identifier& prop,
                                      const juce::var& value);
/// Map nodes (SourceRoutes, PadRoutes, …): Entry{key,value}.
juce::var mapGet(const juce::ValueTree& map, const juce::var& key, const juce::var& fallback = {});
void mapSet(juce::ValueTree map, const juce::var& key, const juce::var& value, juce::UndoManager* um);
void mapRemove(juce::ValueTree map, const juce::var& key, juce::UndoManager* um);
bool mapHas(const juce::ValueTree& map, const juce::var& key);

/// Debug/diagnostic: a normalised deep comparison of two JSON values (numbers within tolerance, key order
/// ignored, null rows == empty rows in grids). Returns the first difference path or an empty string.
/// `allowExtraOnRight`: objects in `b` may carry keys `a` lacks (writer-added fields).
juce::String jsonDiff(const juce::var& a, const juce::var& b, double tolerance = 1e-9, bool allowExtraOnRight = false);
} // namespace terminator::model
