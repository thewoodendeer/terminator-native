#pragma once
// The BASS from the page's JSON (Phase 3.4 shapes, lifted out of the shell in 4.5d so the LIVE bridge and the
// OFFLINE exporter share ONE parser — a second copy would drift, and a patch that reads differently in a bounce
// than it sounds is the exact bug "export == what you hear" exists to prevent).
#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

#include "terminator/core/BassSequencer.h"
#include "terminator/core/BassSynth.h"

namespace terminator::render
{
/// Deep-merge a (possibly partial) patch over the defaults — the worklet's mergePatch(defaultPatch(), patch).
BassPatch bassPatchFromVar(const juce::var& j);

/// One pattern: `{bars, notes[{id,note,start,dur,vel,slide}], bend}`. `bend` is accepted in BOTH shapes — the
/// bridge's per-tick array (what nativeBassShadow sends) and the PRESET's breakpoint list
/// `[{beat,semis}]` (what a project file stores), sampled per tick with the page's linear `bendAt`.
void bassPatternFromVar(const juce::var& j, BassPattern& out);
} // namespace terminator::render
