// Unified DAW-style offline render of a Beat Finisher arrangement through the
// desktop mixer (MixerEngine) — the single render path behind Master Mixdown
// and Trackouts, from BOTH the main EXPORT section and the Beat Finisher modal.
//
// It decomposes the live desktop graph linearly (every strip is LTI around its
// sources, so rendering strip-by-strip is exact):
//
//   sample source  = chop events → chopGain(level×NORM) → padBus → internal
//                    master chain (filter/EQ/comp/delay/reverb/clip/limiter)
//                    — i.e. exactly what feeds the mixer's Sample strip live
//   drum sources   = per-track one-shot voices with the LIVE envelope model
//                    (applyDrumAttack + the 4 ms retrigger choke), at the
//                    track's per-hit volume — exactly what feeds each drum strip
//   channel post   = source → strip insert FX → fader → pan      (= the stem)
//   send return    = Σ(channel post × send level) → send strip   (= send stem)
//   master         = Σ(all posts) → master FX → fader → limiter  (= mixdown)
//
// Desktop-only by construction: callers gate on engine.mixerEngine, which is
// never set on mobile/HardwareView (those keep the legacy renderArrangementMix
// path, so mobile sound is unchanged).

import { ChopperEngine } from '../chopper/ChopperEngine';
import { applyDrumAttack, drumHeadLevel, DRUM_CHOKE_S, TrackKey } from '../drums/DrumEngine';
import { MixerEngine, ChannelName, SEND_CHANNELS } from '../../mixer/MixerEngine';
import { renderBassOffline, type BassPatch, type BassRenderNote, type BassRenderBend } from '../bass/BassEngine';

export type ChopEvent = { padIdx: number; time: number; maxDur: number; reverse?: boolean };
/** One drum hit as the live scheduler would fire it: time (swing + SHIFT
 *  baked), gain (track volume × step VELOCITY), pan (step PAN), and — for a
 *  note-repeat sub-hit — chokeAt (it self-chokes into the next repeat / the
 *  step boundary instead of joining the lane's retrigger chain). */
export type DrumTrackHit = { time: number; gain: number; pan?: number; chokeAt?: number;
  /** MUTE GROUPS: the earliest time a lane in the SAME group hits after this
   *  one (muteGroups.annotateGroupCuts). The voice is cut at whichever comes
   *  first — this or the lane's own next hit — mirroring live emitVoice. */
  groupCutAt?: number };

/** Drum sequencer track → mixer channel → trackout stem file name. Order is the
 *  canonical pad/stem order (kick, snare, hat, openhat, perc). */
export const DRUM_TRACK_CHANNELS: Array<{ track: TrackKey; channel: ChannelName; stem: string }> = [
  { track: 'kick', channel: 'kick', stem: 'kick' },
  { track: 'snare', channel: 'snare', stem: 'snare' },
  { track: 'hihat', channel: 'hat', stem: 'hihat' },
  { track: 'openhat', channel: 'openhat', stem: 'openhat' },
  { track: 'perc', channel: 'perc', stem: 'perc' },
];

/** Mixer channel for a drum lane. The five built-ins have fixed strips; a lane
 *  the user added gets a strip named by its own key (ChopperView addChannel),
 *  so the key IS the channel. (Used to `.find(...)!` → TypeError for any added
 *  lane with hits, killing the MPC and drum-rack exports.) */
export const channelForTrack = (track: TrackKey): ChannelName =>
  DRUM_TRACK_CHANNELS.find((d) => d.track === track)?.channel ?? track;

/** Every lane in the plan, canonical five first then user lanes in the order
 *  they appear — so added lanes get stems + a place in the master too. */
export function drumPlanFor(keys: TrackKey[]): Array<{ track: TrackKey; channel: ChannelName; stem: string }> {
  const out = DRUM_TRACK_CHANNELS.filter((d) => keys.includes(d.track));
  for (const k of keys) {
    if (out.some((d) => d.track === k)) continue;
    out.push({ track: k, channel: channelForTrack(k), stem: k });
  }
  return out;
}

export interface DAWStem { channel: ChannelName; stemName: string; buffer: AudioBuffer }

export interface DAWArrangementRender {
  sampleRate: number;
  lengthSec: number;
  /** Post-strip stems in canonical order: sample, kick, snare, hihat, openhat,
   *  perc, then active sends (send1..send4). */
  stems: DAWStem[];
  master: AudioBuffer | null;
}

/** One drum track's voices over the whole song, with the live envelope model:
 *  applyDrumAttack on the way in, and the retrigger CHOKE that cuts the
 *  previous voice in 4 ms (DRUM_CHOKE_S — mirrors DrumEngine.playHit). */
async function renderDrumTrackSource(
  buffer: AudioBuffer,
  hits: DrumTrackHit[],
  lengthSec: number,
  sampleRate: number,
): Promise<AudioBuffer> {
  const len = Math.max(1, Math.ceil(lengthSec * sampleRate));
  const off = new OfflineAudioContext(2, len, sampleRate);
  const headAbs = drumHeadLevel(buffer);
  const attackS = headAbs < 0.02 ? 0 : 0.003; // mirrors applyDrumAttack's branch (DRUM_HEAD_SILENCE / DRUM_ATTACK_S)
  // Full hits chain-choke each other in time order (the live lane's voice
  // list); note-repeat sub-hits are self-contained and self-choke into chokeAt,
  // exactly as live emitVoice keeps them out of the lane's retrigger chain.
  const full = hits.filter(h => h.chokeAt === undefined && h.gain > 0).sort((a, b) => a.time - b.time);
  const subs = hits.filter(h => h.chokeAt !== undefined && h.gain > 0);
  const voice = (h: DrumTrackHit): { src: AudioBufferSourceNode; g: GainNode } => {
    const src = off.createBufferSource();
    src.buffer = buffer;
    const g = off.createGain();
    applyDrumAttack(g.gain, h.time, h.gain, headAbs);
    src.connect(g);
    if (h.pan && typeof off.createStereoPanner === 'function') {
      const p = off.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, h.pan));
      g.connect(p); p.connect(off.destination);
    } else g.connect(off.destination);
    // start() MUST precede stop() — calling stop() on a source that hasn't been
    // started throws "cannot call stop without calling start first" (which fired
    // for every choked hit, e.g. a 16th-note hat run, killing Master Mixdown).
    src.start(h.time);
    return { src, g };
  };
  for (let i = 0; i < full.length; i++) {
    const h = full[i];
    const { src, g } = voice(h);
    const next = full[i + 1];
    // Whichever lands first cuts it: the lane's own retrigger, or a lane in the
    // same MUTE GROUP (closed hat over open hat). Live emitVoice picks the same
    // winner by time order.
    const cut = Math.min(next ? next.time : Infinity, h.groupCutAt ?? Infinity);
    if (cut < h.time + buffer.duration) {
      // Same choke as live: pinned until the cut, 4 ms linear to 0,
      // the source stops 2 ms after the ramp.
      g.gain.setValueAtTime(Math.max(0.0001, h.gain), cut);
      g.gain.linearRampToValueAtTime(0, cut + DRUM_CHOKE_S);
      src.stop(cut + DRUM_CHOKE_S + 0.002);
    }
  }
  for (const h of subs) {
    const { src, g } = voice(h);
    const ch = Math.max(h.time + attackS + DRUM_CHOKE_S, h.chokeAt!);
    g.gain.setValueAtTime(Math.max(0.0001, h.gain), Math.max(h.time + attackS, ch - DRUM_CHOKE_S));
    g.gain.linearRampToValueAtTime(0, ch);
    src.stop(ch + 0.01);
  }
  return off.startRendering();
}

export interface RenderArrangementDAWOpts {
  engine: ChopperEngine;
  mixer: MixerEngine;
  chopEvents: ChopEvent[];
  /** Per-track absolute-time hits (gain = the track's live per-hit volume). */
  drumHits: Partial<Record<TrackKey, DrumTrackHit[]>>;
  drumBuffers: Partial<Record<TrackKey, AudioBuffer | null>>;
  /** BASS: absolute-time notes + the patch to render them with. Optional —
   *  absent/empty = no bass strip in this render. */
  bass?: { patch: BassPatch; notes: BassRenderNote[]; bends?: BassRenderBend[] };
  /** Arrangement length + ring-out headroom, BEFORE mixer-FX tails. */
  baseSec: number;
  wantMaster: boolean;
  wantStems: boolean;
  onStep?: (label: string) => void;
}

export async function renderArrangementDAW(opts: RenderArrangementDAWOpts): Promise<DAWArrangementRender> {
  const { engine, mixer } = opts;
  const sampleRate = engine.buffer?.sampleRate ?? mixer.ctx.sampleRate;

  // Which strips carry signal this render?
  const drumPlan = drumPlanFor(Object.keys(opts.drumHits)).filter(({ track, channel }) => {
    const hits = opts.drumHits[track];
    return !!hits && hits.length > 0 && !!opts.drumBuffers[track] && mixer.channels.has(channel) && mixer.isChannelAudible(channel);
  });
  // Chop events split by mixer route: the main SAMPLE strip + one strip per
  // pad source ('sample2'…). Each renders its own dry + post + stem.
  const chopRoutes = engine.routesForEvents(opts.chopEvents).filter((r) => mixer.channels.has(r) && mixer.isChannelAudible(r));
  const wantBass = !!opts.bass && opts.bass.notes.length > 0 && mixer.channels.has('bass') && mixer.isChannelAudible('bass');

  // One shared render length so every stem + the master line up sample-for-
  // sample: arrangement + ring-out, extended by the longest FX tail in play.
  let tail = 0;
  for (const r of chopRoutes) tail = Math.max(tail, mixer.stripTailSec(r));
  for (const d of drumPlan) tail = Math.max(tail, mixer.stripTailSec(d.channel));
  if (wantBass) tail = Math.max(tail, mixer.stripTailSec('bass'));
  const activeSends = SEND_CHANNELS.filter((s) => mixer.isSendActive(s) && mixer.isChannelAudible(s));
  for (const s of activeSends) tail = Math.max(tail, mixer.stripTailSec(s));
  if (opts.wantMaster) tail = Math.max(tail, mixer.stripTailSec('master'));
  const lengthSec = opts.baseSec + tail;

  // 1. Dry strip sources (what each mixer channel hears live) — ALL of them
  //    first, because a sidechain compressor on one channel is keyed from
  //    another channel's dry signal.
  const dries: Array<{ channel: string; stem: string; buffer: AudioBuffer }> = [];
  for (const r of chopRoutes) {
    opts.onStep?.(r === 'sample' ? 'Rendering chops…' : `Rendering ${r}…`);
    const dry = await engine.renderArrangementChopSource({
      chopEvents: opts.chopEvents, totalSec: lengthSec, sampleRate, route: r,
    });
    dries.push({ channel: r, stem: r, buffer: dry });
  }
  for (const d of drumPlan) {
    opts.onStep?.(`Rendering ${d.stem}…`);
    dries.push({ channel: d.channel, stem: d.stem, buffer: await renderDrumTrackSource(opts.drumBuffers[d.track]!, opts.drumHits[d.track]!, lengthSec, sampleRate) });
  }
  if (wantBass) {
    opts.onStep?.('Rendering bass…');
    dries.push({ channel: 'bass', stem: 'bass', buffer: await renderBassOffline(opts.bass!.patch, opts.bass!.notes, lengthSec, sampleRate, opts.bass!.bends ?? []) });
  }
  const keySources: Record<string, AudioBuffer> = {};
  for (const d of dries) keySources[d.channel] = d.buffer;
  //    …then each channel's post (insert FX + PDC + fader + pan).
  const posts: DAWStem[] = [];
  for (const d of dries) {
    opts.onStep?.(d.channel === 'sample' ? 'Sample channel FX…' : `${d.stem} channel FX…`);
    posts.push({ channel: d.channel, stemName: d.stem, buffer: await mixer.renderChannelPostOffline(d.buffer, d.channel, lengthSec, keySources) });
  }

  // 2. Send returns — only the buses that actually receive signal.
  const sendStems: DAWStem[] = [];
  for (const send of activeSends) {
    const idx = SEND_CHANNELS.indexOf(send);
    const inputs = posts
      .map((p) => ({ buffer: p.buffer, gain: mixer.getSendLinear(p.channel, idx) }))
      .filter((i) => i.gain > 0);
    if (!inputs.length) continue;
    opts.onStep?.(`Rendering ${send}…`);
    sendStems.push({ channel: send, stemName: send, buffer: await mixer.renderSendReturnOffline(inputs, send, lengthSec, sampleRate) });
  }

  // 2b. PDC's dry-to-master leg: live, every channel reaches the master behind
  //     the longest SEND-bus chain so it lines up with its own bus return. The
  //     posts fed the sends un-shifted (as live), so shift the STEM / master
  //     copies now. A plain sample shift — no re-render. 0 unless a send bus
  //     carries a latency insert.
  const shiftFrames = Math.round(mixer.pdcMasterShiftSec() * sampleRate);
  if (shiftFrames > 0) {
    for (const p of posts) p.buffer = shiftBuffer(p.buffer, shiftFrames);
  }

  // 3. Master bus — channels + send returns summed through the master strip.
  let master: AudioBuffer | null = null;
  if (opts.wantMaster) {
    opts.onStep?.('Master bus…');
    master = await mixer.renderMasterBusOffline(
      [...posts, ...sendStems].map((p) => p.buffer), lengthSec, sampleRate,
    );
  }

  return {
    sampleRate,
    lengthSec,
    stems: opts.wantStems ? [...posts, ...sendStems] : [],
    master,
  };
}

/** Copy of `buf` delayed by `frames` samples (same length; the tail is dropped). */
function shiftBuffer(buf: AudioBuffer, frames: number): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: buf.length, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const n = Math.max(0, buf.length - frames);
    if (n > 0) out.copyToChannel(src.subarray(0, n), c, frames);
  }
  return out;
}
