#pragma once
// EFFECTIVE BUFFER — the message-thread (never RT) builder of the TRIMMED timeline: the kept ranges of a decoded
// file concatenated with 3 ms seam ramps (trims::buildEffectiveChannels), wrapped as a SampleBuffer the engine
// can be handed by setPadSample / setPadStems. Port of buildEffectiveBuffer (trimRegions.ts): the EFFECTIVE
// buffer is what every consumer treats as "the sample" (chops, pads, waveform, stems, sequencer, exports); the
// original stays on disk/in the store for undo and for re-cutting when the trim list changes. Stems are cut
// with the SAME list so every plane stays sample-aligned with its original (rederiveStems).
#include <array>
#include <memory>

#include "terminator/core/SampleBuffer.h"
#include "terminator/core/planners/Trims.h"

namespace terminator::analysis
{
/// Four stem planes (drums, bass, other, vocals — StemMask.h bit order); a missing stem stays null.
using StemPlanes = std::array<std::shared_ptr<SampleBuffer>, 4>;

/// The effective buffer of `file` under `trims`: length = file − trimmed frames (kept ranges concatenated,
/// 3 ms amplitude ramps on each side of every interior seam), same channels/rate, id 0 (the caller's store
/// assigns one). Empty trims → a plain copy; callers that want zero-copy keep the original (effectiveOrSame).
std::shared_ptr<SampleBuffer> buildEffectiveBuffer(const SampleBuffer& file, const trims::TrimList& trims);

/// The same, but the TS contract for zero trims: the SAME buffer object comes back (no copy).
std::shared_ptr<SampleBuffer> effectiveOrSame(const std::shared_ptr<SampleBuffer>& file, const trims::TrimList& trims);

/// Every plane cut with the same trim list (null planes stay null) — the effective stems of an effective
/// original; zero trims → the same planes.
StemPlanes buildEffectiveStems(const StemPlanes& filePlanes, const trims::TrimList& trims);
} // namespace terminator::analysis
