/**
 * DRUM MUTE GROUPS — lanes that cut each other, MPC-style.
 *
 * A lane in mute group G silences every OTHER lane in G the moment it hits:
 * the classic closed-hat/open-hat/pedal-hat trio, an 808 that must not stack
 * with its own slide, a crash that kills a ride. Lanes with no group (the
 * default) ring on as they always have.
 *
 * ONE OWNER FOR THE MATH. The live engine (DrumEngine.emitVoice) and BOTH
 * offline renderers (renderArrangementDAW.renderDrumTrackSource and
 * ChopperEngine.renderArrangementMix) must cut identically or an export stops
 * matching what he heard — his standing rule. Live works from voices that
 * exist right now, so it applies the rule directly; the renderers get every
 * hit up front, so they take `groupCutAt` computed HERE and cut at
 * `min(own next hit, groupCutAt)`.
 *
 * Time order decides who cuts whom — the same rule the lane's own retrigger
 * chain uses: a voice that started AT OR BEFORE a hit is cut by it; a voice
 * booked LATER is left alone and will cut this one when it lands.
 */
import type { TrackKey } from './DrumEngine';

/** 0 / undefined = no group. Groups are small integers so presets stay tiny. */
export type MuteGroup = number | undefined;

/** One drum hit as the renderers see it — only the fields the cut needs. */
export interface GroupHit {
  time: number;
  /** Note-repeat sub-hits self-choke into their own chokeAt and never take
   *  part in a lane's retrigger chain — nor in a group cut. */
  chokeAt?: number;
  /** Filled in by annotateGroupCuts: the earliest time a lane in the SAME
   *  mute group hits after this one. The renderer cuts at min(next own, this). */
  groupCutAt?: number;
}

/** The cut time for `hit` from OTHER lanes' hits in its group, or undefined.
 *  Pure — exported for the gate. */
export function groupCutTime(hitTime: number, otherTimes: number[]): number | undefined {
  let best: number | undefined;
  for (const t of otherTimes) {
    // Strictly later: two lanes landing on the SAME instant are simultaneous,
    // not a cut — cutting there would silence one of a deliberate layer.
    if (t > hitTime && (best === undefined || t < best)) best = t;
  }
  return best;
}

/**
 * Annotate every hit with `groupCutAt` in place, given each lane's group.
 * Lanes with no group, and note-repeat sub-hits, are left untouched.
 */
export function annotateGroupCuts<T extends GroupHit>(
  hitsByTrack: Partial<Record<TrackKey, T[]>>,
  groupOf: (track: TrackKey) => MuteGroup,
): void {
  const tracks = Object.keys(hitsByTrack) as TrackKey[];
  // group → every hit time in it, per lane, so a lane never cuts itself here
  // (its own retrigger chain already does that, with its own 4 ms ramp).
  const byGroup = new Map<number, Array<{ track: TrackKey; times: number[] }>>();
  for (const track of tracks) {
    const g = groupOf(track);
    if (!g) continue;
    const times = (hitsByTrack[track] ?? []).filter(h => h.chokeAt === undefined).map(h => h.time);
    if (!times.length) continue;
    const list = byGroup.get(g) ?? [];
    list.push({ track, times });
    byGroup.set(g, list);
  }
  for (const [, lanes] of byGroup) {
    if (lanes.length < 2) continue;           // a group of one cuts nothing
    for (const lane of lanes) {
      const others = lanes.filter(l => l.track !== lane.track).flatMap(l => l.times).sort((a, b) => a - b);
      if (!others.length) continue;
      for (const h of hitsByTrack[lane.track] ?? []) {
        if (h.chokeAt !== undefined) continue;
        h.groupCutAt = groupCutTime(h.time, others);
      }
    }
  }
}
