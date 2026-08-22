// Live preview player for an arrangement. Additive — it does not touch the
// chopper's tuned sequencer. Drums and chops are anchored to ONE start time so
// they line up exactly: the drum transport starts at the anchor and runs
// continuously in phase for the whole preview (sections only swap which tracks
// are audible); chop step-events fire off a 25 ms interval against the same
// anchor. Progress getters drive a ref-based playhead in the UI.

import { ChopperEngine } from '../chopper/ChopperEngine';
import { DrumEngine, TrackKey } from '../drums/DrumEngine';
import { Arrangement, ArrangementSection } from './types';
import type { BassEngine, BassRenderNote, BassRenderBend } from '../bass/BassEngine';

type DrumPattern = Record<TrackKey, boolean[]>;

export class ArrangerPreview {
  private engine: ChopperEngine;
  private drums: DrumEngine;
  // BASS (desktop): while a preview runs the bass engine's own pattern loop is
  // parked and every section's bassNotes are posted to the synth as an
  // absolute-time timeline (sample-accurate, same anchor as the drums).
  private bass: BassEngine | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private bpm = 90;
  private totalBeats = 0;
  // Phase 3A.5: enough state to re-schedule drum patterns live (mute a block /
  // switch a sequence) without restarting the transport. Captured in play().
  private baseBars = 1;
  private basePattern: DrumPattern | null = null;
  // Phase 3A.6: the last play() args, so a seek can re-anchor the transport at a
  // new offset without the caller re-supplying everything.
  private lastPlay: {
    arr: Arrangement; chopToPad: number[]; basePattern: DrumPattern;
    baseBars: number; onDone?: () => void;
  } | null = null;

  constructor(engine: ChopperEngine, drums: DrumEngine, bass?: BassEngine) {
    this.engine = engine;
    this.drums = drums;
    this.bass = bass ?? null;
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  getTotalBeats(): number {
    return this.totalBeats;
  }

  /** Elapsed beats since the anchor (clamped to the arrangement length). Read by
   *  the UI's rAF for a ref-based playhead. 0 when stopped. */
  getElapsedBeats(): number {
    if (this.timer === null) return 0;
    const e = (this.engine.ctx.currentTime - this.startTime) * (this.bpm / 60);
    return Math.max(0, Math.min(this.totalBeats, e));
  }

  async play(
    arr: Arrangement,
    chopToPad: number[],
    basePattern: DrumPattern,
    baseBars: number,
    onDone?: () => void,
    startBeats = 0,
  ): Promise<void> {
    this.stop();
    const ctx = this.engine.ctx;
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch { /* gesture already happened */ }
    }

    // Phase 3A.4: pre-warm the drum sample buffers BEFORE we anchor the
    // transport. The first drums-on section follows a drum-less intro, so its
    // hits would otherwise wait on a cold fetch+decode and fade in late. The
    // actual anchoring happens in schedule(), called only after this resolves.
    try { await this.drums.preload?.(); } catch { /* play anyway if a load fails */ }

    this.lastPlay = { arr, chopToPad, basePattern, baseBars, onDone };
    this.schedule(startBeats);
  }

  /** Re-anchor the transport so playback represents position `beats` and
   *  continues from there (Phase 3A.6). No-op when not playing — a stopped seek
   *  is just a UI playhead move; the next play() starts from the saved offset. */
  seek(beats: number): void {
    if (this.timer === null || !this.lastPlay) return;
    this.schedule(Math.max(0, beats));
  }

  /** Build the whole transport (drum timeline + chop event queue) anchored so the
   *  playhead reads `startBeats` right now and grows. Shared by play() + seek().
   *  Synchronous (resume/preload already done) so seeks are snappy. */
  private schedule(startBeats: number): void {
    if (!this.lastPlay) return;
    const { arr, chopToPad, basePattern, baseBars, onDone } = this.lastPlay;
    // Tear down any running transport but keep the context warm. stopAllPads
    // also kills chop voices already SCHEDULED into the lookahead window —
    // without it a seek replays up to 200 ms of the old position on top of
    // the new one.
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.drums.stop();
    this.engine.stopAllPads();
    if (this.bass) { this.bass.stop(); this.bass.clearTimeline(); this.bass.setArrangerDriven(true); }

    const ctx = this.engine.ctx;
    const bpm = this.engine.getMasterBpm() || 90;
    this.bpm = bpm;
    this.baseBars = baseBars;
    this.basePattern = basePattern;
    const beatDur = 60 / bpm;
    const barDur = beatDur * 4;
    // One ENGINE step — start()'s stepOffset counts in the engine's storage
    // resolution (1/32 now, was 1/16). Hardcoding /4 here made every seek land
    // the drums half as far into the loop as the chops.
    const stepDur = barDur / this.drums.stepsPerBar;

    // Audio begins ~80 ms from now; startTime is back-dated by the seek offset so
    // getElapsedBeats() (and every event time, measured from startTime) reads
    // `startBeats` at the anchor and counts up from there.
    const anchor = ctx.currentTime + 0.08;
    const offsetSec = Math.max(0, startBeats) * beatDur;
    this.startTime = anchor - offsetSec;

    // Drums: lay every section's pattern onto the engine timeline at its absolute
    // start time (Phase 3A.5). The scheduler resolves the active pattern per step
    // so each boundary's first hit lands on the beat. Start the loop phase at the
    // seek offset so the groove is musically aligned at the seek point (3A.6).
    this.scheduleDrumTimeline(arr, this.startTime, barDur);
    void this.drums.start(anchor, Math.round(offsetSec / stepDur));
    this.scheduleBassTimeline(arr, this.startTime, beatDur);

    // Chop events are SCHEDULED AHEAD on the audio clock (triggerPadAt), the
    // same way the drum + bass timelines are — never fired live off the
    // interval tick. Fired-live they landed 0–25 ms late (interval
    // quantization) plus whatever the main thread was doing, while the drums
    // kept sample-accurate time: the chops audibly fell out of sync under any
    // UI jank and "picked back up" after (his report). The interval below
    // only tops up the schedule and watches for the end.
    type Ev = { at: number; fn: (when: number) => void };
    const events: Ev[] = [];
    let cursor = 0;
    arr.sections.forEach((sec) => {
      const sectionStart = cursor;
      const bars = Math.max(1, Math.floor(sec.bars) || 1);

      if (sec.chopEvents && sec.chopEvents.length) {
        // Full chop-sequence playback: fire each resolved step at its beat offset.
        for (const ev of sec.chopEvents) {
          const at = sectionStart + ev.beat * beatDur;
          ev.pads.forEach((pad, i) => {
            const reverse = ev.rev?.[i];
            events.push({ at, fn: (when) => this.engine.triggerPadAt(pad, when, 1, reverse ? { reverse } : undefined) });
          });
        }
      } else if (sec.chops.length) {
        // Fallback: one chop per bar, cycling through the section's chops.
        for (let b = 0; b < bars; b++) {
          const chopIdx = sec.chops[b % sec.chops.length];
          const pad = chopToPad[chopIdx];
          if (typeof pad === 'number') events.push({ at: sectionStart + b * barDur, fn: (when) => this.engine.triggerPadAt(pad, when) });
        }
      }
      cursor += bars * barDur;
    });
    events.sort((a, b) => a.at - b.at);
    const total = cursor;
    this.totalBeats = total / beatDur;

    // Skip chop events that sit before the seek point so they don't all fire at once.
    let idx = 0;
    while (idx < events.length && events[idx].at < offsetSec) idx++;
    const LOOKAHEAD = 0.2;   // seconds of audio scheduled ahead of the clock
    const pump = () => {
      const t = ctx.currentTime - this.startTime;
      const horizon = t + LOOKAHEAD;
      while (idx < events.length && events[idx].at <= horizon) {
        const ev = events[idx];
        try { ev.fn(this.startTime + ev.at); } catch { /* keep the transport alive */ }
        idx++;
      }
      if (t >= total + 0.25) {
        this.stop();
        onDone?.();
      }
    };
    this.timer = setInterval(pump, 25);
    pump();   // fill the first window NOW — the anchor is only 80 ms out
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.drums.stop();
    if (this.bass) { this.bass.clearTimeline(); this.bass.setArrangerDriven(false); }
  }

  /** Post every section's bassNotes as absolute-time events. Notes already in
   *  the past (a seek / live edit mid-preview) are skipped rather than fired
   *  all at once. */
  private scheduleBassTimeline(arr: Arrangement, anchor: number, beatDur: number): void {
    if (!this.bass) return;
    const barDur = beatDur * 4;
    const now = this.engine.ctx.currentTime + 0.01;
    const notes: BassRenderNote[] = [];
    const bends: BassRenderBend[] = [];
    let cursor = 0;
    for (const sec of arr.sections) {
      const bars = Math.max(1, Math.floor(sec.bars) || 1);
      for (const b of sec.bassBends ?? []) {
        const at = anchor + cursor + b.beat * beatDur;
        if (at >= now) bends.push({ time: at, semis: b.semis });
      }
      for (const n of sec.bassNotes ?? []) {
        const at = anchor + cursor + n.beat * beatDur;
        if (at < now) continue;
        notes.push({ time: at, note: n.note, dur: Math.max(0.02, n.dur * beatDur), vel: n.vel, ...(n.slide ? { slide: true } : {}) });
      }
      cursor += bars * barDur;
    }
    if (notes.length || bends.length) this.bass.playTimeline(notes, bends);
  }

  /** Lay each section's drum pattern onto the engine timeline at its absolute
   *  start time (anchor + accumulated bars). Clears any prior timeline first. */
  private scheduleDrumTimeline(arr: Arrangement, anchor: number, barDur: number): void {
    const base = this.basePattern ?? ({} as DrumPattern);
    this.drums.clearScheduledPatterns?.();
    let cursor = 0;
    for (const sec of arr.sections) {
      const bars = Math.max(1, Math.floor(sec.bars) || 1);
      this.drums.schedulePattern?.(this.patternForSection(sec, base), anchor + cursor);
      cursor += bars * barDur;
    }
  }

  /** Re-schedule the drum timeline mid-preview so a live edit (mute a block,
   *  switch a section's sequence) takes effect on the NEXT scheduled hit without
   *  restarting the transport (Phase 3A.5). No-op when not previewing. The new
   *  arrangement must keep the same section bar lengths (mute/seq edits do) so
   *  the section start times — and the chop-event timeline — stay aligned. */
  updateDrums(arr: Arrangement): void {
    if (this.timer === null) return;
    const barDur = (60 / this.bpm) * 4;
    this.scheduleDrumTimeline(arr, this.startTime, barDur);
    if (this.bass) { this.bass.clearTimeline(); this.scheduleBassTimeline(arr, this.startTime, barDur / 4); }
  }

  // Which drum rows this section plays, as one explicit pattern. Empty -> a
  // silent pattern so the transport keeps running through drum-less sections.
  private patternForSection(sec: ArrangementSection, base: DrumPattern): Partial<Record<TrackKey, boolean[]>> {
    // Phase 1B: an explicit per-track pattern (each row drawn from the sequence
    // chosen for that track) wins outright — play exactly those rows.
    if (sec.drumPattern) return sec.drumPattern as Partial<Record<TrackKey, boolean[]>>;
    let keys: TrackKey[];
    if (sec.enabledDrumTracks) keys = sec.enabledDrumTracks as TrackKey[];
    else if (sec.drums === 'none') keys = [];
    else if (sec.drums === 'breakdown') keys = ['kick', 'snare'];
    else if (sec.drums === 'hi_hats_only') keys = ['hihat', 'openhat'];
    else keys = Object.keys(base) as TrackKey[];
    const pat: Partial<Record<TrackKey, boolean[]>> = {};
    for (const k of keys) if (base[k]) pat[k] = base[k];
    return pat;
  }
}
