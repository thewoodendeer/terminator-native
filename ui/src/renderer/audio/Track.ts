import { stretchBuffer } from './TimeStretcher';
import { Waveshaper } from './effects/Waveshaper';
import { MultibandSaturator } from './effects/MultibandSaturator';
import { Compressor } from './effects/Compressor';
import { StereoWidener } from './effects/StereoWidener';
import { MSEQ } from './effects/MSEQ';
import { Reverb } from './effects/Reverb';
import { Delay } from './effects/Delay';
import { EQ3 } from './effects/EQ3';
import { Clipper } from './effects/Clipper';
import { Chorus } from './effects/Chorus';
import { BitCrusher } from './effects/BitCrusher';
import { AutoPan } from './effects/AutoPan';
import { TranceGate } from './effects/TranceGate';
import { Filter, FilterType } from './effects/Filter';

let trackCounter = 0;

export type EffectKey =
  | 'filter' | 'eq' | 'clipper' | 'waveshaper' | 'saturator' | 'compressor'
  | 'widener' | 'mseq' | 'chorus' | 'delay' | 'reverb'
  | 'bitcrusher' | 'autopan' | 'trancegate';

export const DEFAULT_FX_ORDER: EffectKey[] = [
  'filter', 'eq', 'clipper', 'waveshaper', 'saturator', 'compressor',
  'widener', 'mseq', 'chorus', 'delay', 'reverb',
  'bitcrusher', 'autopan', 'trancegate',
];

export interface TrackEffectsState {
  filter:     { type: FilterType; freq: number; q: number; mix: number; bypassed: boolean };
  eq:         { lowGain: number; midGain: number; highGain: number; bypassed: boolean };
  clipper:    { amount: number; drive: number; mix: number; bypassed: boolean };
  waveshaper: { drive: number; mix: number; bypassed: boolean };
  saturator:  { drive: number; mix: number; lowFreq: number; highFreq: number; bypassed: boolean };
  compressor: { drive: number; ratio: number; attack: number; release: number; makeup: number; bypassed: boolean };
  widener:    { width: number; mix: number; bypassed: boolean };
  mseq:       { midFreq: number; midGain: number; sideFreq: number; sideGain: number; mix: number; bypassed: boolean };
  chorus:     { rate: number; depth: number; mix: number; bypassed: boolean };
  delay:      { timeL: number; timeR: number; feedback: number; mix: number; pingPong: boolean; bypassed: boolean };
  reverb:     { mix: number; decay: number; preHPF: number; bypassed: boolean };
  bitcrusher: { bits: number; rate: number; mix: number; bypassed: boolean };
  autopan:    { rate: number; depth: number; mix: number; bypassed: boolean };
  trancegate: { rate: number; depth: number; attack: number; release: number; mix: number; synced: boolean; syncDiv: string; bypassed: boolean };
  masterBypass: boolean;
  effectsOrder: EffectKey[];
}

export interface TrackState {
  id: string;
  name: string;
  volume: number;
  pan: number;
  muted: boolean;
  soloed: boolean;
  armed: boolean;
  midiArmed: boolean;
  rootNote: number;
  reversed: boolean;
  timeStretch: number;
  pitch: number;
  loopStartOffset: number;
  quantizeEnabled: boolean;
  quantizeGrid: string;
  swingAmount: number;
  effects: TrackEffectsState;
  hasAudio: boolean;
  bufferDuration: number;
  waveformPeaks: number[];
  color: string;
}

export class Track {
  readonly id: string;
  name: string;
  buffer: AudioBuffer | null = null;
  private reversedBuffer: AudioBuffer | null = null;

  readonly gainNode: GainNode;
  readonly panNode: StereoPannerNode;
  private loopGain: GainNode; // dedicated gain for loop sources — faded in/out at bar boundaries
  private fxInputGain: GainNode;
  private fxOutGain: GainNode;
  private dryBypassGain: GainNode;
  private sourceNode: AudioBufferSourceNode | null = null;
  private pendingStops = new Set<AudioBufferSourceNode>();
  private monitorSource: MediaStreamAudioSourceNode | null = null;

  // Pitch-preserved stretched versions of the raw buffers. Generated async; used
  // by playback paths at playbackRate=1 so stretch/pitch are baked in.
  private processedBuffer: AudioBuffer | null = null;
  private processedReversedBuffer: AudioBuffer | null = null;
  private processVersion = 0;
  private processDebounce: ReturnType<typeof setTimeout> | null = null;

  readonly filter:     Filter;
  readonly eq:         EQ3;
  readonly clipper:    Clipper;
  readonly waveshaper: Waveshaper;
  readonly saturator:  MultibandSaturator;
  readonly compressor: Compressor;
  readonly widener:    StereoWidener;
  readonly mseq:       MSEQ;
  readonly chorus:     Chorus;
  readonly delay:      Delay;
  readonly reverb:     Reverb;
  readonly bitcrusher: BitCrusher;
  readonly autopan:    AutoPan;
  readonly trancegate: TranceGate;

  volume  = 0.8;
  pan     = 0;
  muted   = false;
  soloed  = false;
  armed   = false;
  midiArmed = false;
  rootNote  = 60;
  reversed = false;
  private midiSources = new Map<number, { src: AudioBufferSourceNode; vel: GainNode }>();
  timeStretch     = 1.0;
  pitch           = 0;
  loopStartOffset = 0;
  quantizeEnabled = false;
  quantizeGrid    = '1/16';
  swingAmount     = 50;
  masterBypass    = false;
  color: string;
  effectsOrder: EffectKey[] = [...DEFAULT_FX_ORDER];
  waveformPeaks: number[]   = [];

  static readonly COLORS = ['#00ff88','#00ccff','#ff6600','#cc00ff','#ffcc00','#ff0066','#00ff00','#ff00cc'];

  constructor(private ctx: AudioContext, private destination: AudioNode) {
    trackCounter++;
    this.id    = `track-${Date.now()}-${trackCounter}`;
    this.name  = `TRACK ${trackCounter}`;
    this.color = Track.COLORS[(trackCounter - 1) % Track.COLORS.length];

    this.gainNode      = ctx.createGain();
    this.gainNode.gain.value = this.volume;
    this.loopGain      = ctx.createGain();
    this.loopGain.gain.value = 1;
    this.loopGain.connect(this.gainNode);
    this.panNode       = ctx.createStereoPanner();
    this.panNode.pan.value = this.pan;
    this.fxInputGain   = ctx.createGain();
    this.fxOutGain     = ctx.createGain();
    this.fxOutGain.gain.value = 1;
    this.dryBypassGain = ctx.createGain();
    this.dryBypassGain.gain.value = 0;

    this.filter     = new Filter(ctx);
    this.eq         = new EQ3(ctx);
    this.clipper    = new Clipper(ctx);
    this.waveshaper = new Waveshaper(ctx);
    this.saturator  = new MultibandSaturator(ctx);
    this.compressor = new Compressor(ctx);
    this.widener    = new StereoWidener(ctx);
    this.mseq       = new MSEQ(ctx);
    this.chorus     = new Chorus(ctx);
    this.delay      = new Delay(ctx);
    this.reverb     = new Reverb(ctx);
    this.bitcrusher = new BitCrusher(ctx);
    this.autopan    = new AutoPan(ctx);
    this.trancegate = new TranceGate(ctx);

    // All effects start bypassed
    this.filter.setBypassed(true);
    this.eq.setBypassed(true);
    this.clipper.setBypassed(true);
    this.waveshaper.setBypassed(true);
    this.saturator.setBypassed(true);
    this.compressor.setBypassed(true);
    this.chorus.setBypassed(true);
    this.delay.setBypassed(true);
    this.reverb.setBypassed(true);
    this.autopan.setBypassed(true);

    this.gainNode.connect(this.fxInputGain);
    this.gainNode.connect(this.dryBypassGain);
    this.rewireEffects();
    this.fxOutGain.connect(this.panNode);
    this.dryBypassGain.connect(this.panNode);
    this.panNode.connect(this.destination);
  }

  async initWorklets(): Promise<void> {
    await Promise.all([
      this.widener.init(),
      this.mseq.init(),
      this.bitcrusher.init(),
      this.trancegate.init(),
    ]);
    this.widener.setBypassed(true);
    this.mseq.setBypassed(true);
    this.bitcrusher.setBypassed(true);
    this.trancegate.setBypassed(true);
  }

  private effectIO(key: EffectKey): { input: AudioNode; output: AudioNode } {
    switch (key) {
      case 'filter':     return this.filter;
      case 'eq':         return this.eq;
      case 'clipper':    return this.clipper;
      case 'waveshaper': return this.waveshaper;
      case 'saturator':  return this.saturator;
      case 'compressor': return this.compressor;
      case 'widener':    return this.widener;
      case 'mseq':       return this.mseq;
      case 'chorus':     return this.chorus;
      case 'delay':      return this.delay;
      case 'reverb':     return this.reverb;
      case 'bitcrusher': return this.bitcrusher;
      case 'autopan':    return this.autopan;
      case 'trancegate': return this.trancegate;
    }
  }

  rewireEffects(): void {
    try { this.fxInputGain.disconnect(); } catch (_) {}
    for (const key of DEFAULT_FX_ORDER) {
      try { (this.effectIO(key).output as GainNode).disconnect(); } catch (_) {}
    }
    const order = this.effectsOrder;
    if (order.length === 0) { this.fxInputGain.connect(this.fxOutGain); return; }
    this.fxInputGain.connect(this.effectIO(order[0]).input);
    for (let i = 0; i < order.length - 1; i++) {
      this.effectIO(order[i]).output.connect(this.effectIO(order[i + 1]).input);
    }
    this.effectIO(order[order.length - 1]).output.connect(this.fxOutGain);
  }

  reorderEffects(order: EffectKey[]): void {
    this.effectsOrder = [...order];
    this.rewireEffects();
  }

  setEffectBypassed(fx: EffectKey, b: boolean): void {
    switch (fx) {
      case 'filter':     this.filter.setBypassed(b);     break;
      case 'eq':         this.eq.setBypassed(b);         break;
      case 'clipper':    this.clipper.setBypassed(b);    break;
      case 'waveshaper': this.waveshaper.setBypassed(b); break;
      case 'saturator':  this.saturator.setBypassed(b);  break;
      case 'compressor': this.compressor.setBypassed(b); break;
      case 'widener':    this.widener.setBypassed(b);    break;
      case 'mseq':       this.mseq.setBypassed(b);       break;
      case 'chorus':     this.chorus.setBypassed(b);     break;
      case 'delay':      this.delay.setBypassed(b);      break;
      case 'reverb':     this.reverb.setBypassed(b);     break;
      case 'bitcrusher': this.bitcrusher.setBypassed(b); break;
      case 'autopan':    this.autopan.setBypassed(b);    break;
      case 'trancegate': this.trancegate.setBypassed(b); break;
    }
  }

  setMasterBypass(b: boolean): void {
    this.masterBypass = b;
    this.fxOutGain.gain.setTargetAtTime(b ? 0 : 1, this.ctx.currentTime, 0.005);
    this.dryBypassGain.gain.setTargetAtTime(b ? 1 : 0, this.ctx.currentTime, 0.005);
  }

  setReversed(reversed: boolean): void {
    this.reversed = reversed;
    this.stop();
    this.regenerateProcessed();
  }

  setBPM(bpm: number): void {
    this.trancegate.setBPM(bpm);
  }

  setBuffer(buffer: AudioBuffer): void {
    this.buffer = buffer;
    this.reversedBuffer = Track.reverseBuffer(buffer, this.ctx);
    this.loopStartOffset = 0;
    this.waveformPeaks = Track.computePeaks(buffer, 2000);
    this.processedBuffer = null;
    this.processedReversedBuffer = null;
    this.regenerateProcessed();
  }

  // Rebuild the pitch/time-stretched buffers in the background. Debounced so
  // dragging a knob doesn't thrash. The next bar-boundary retrigger picks up
  // the new buffer automatically via effectiveBuffer().
  private regenerateProcessed(): void {
    if (this.processDebounce) clearTimeout(this.processDebounce);
    this.processDebounce = setTimeout(() => { void this._doRegenerate(); }, 150);
  }

  private async _doRegenerate(): Promise<void> {
    const raw = this.buffer;
    const rawRev = this.reversedBuffer;
    if (!raw) return;
    const version = ++this.processVersion;
    const tempo = this.timeStretch;
    const pitch = this.pitch;
    try {
      const forward = await stretchBuffer(this.ctx, raw, tempo, pitch);
      if (version !== this.processVersion) return; // superseded
      this.processedBuffer = forward;

      if (rawRev) {
        const reversed = await stretchBuffer(this.ctx, rawRev, tempo, pitch);
        if (version !== this.processVersion) return;
        this.processedReversedBuffer = reversed;
      }
    } catch (e) {
      console.warn('Time-stretch regeneration failed:', e);
    }
  }

  // Buffer chosen for playback: prefer processed (pitch-preserved), fall back
  // to raw if processing hasn't completed yet.
  private effectiveBuffer(): AudioBuffer | null {
    if (this.reversed) {
      return this.processedReversedBuffer ?? this.reversedBuffer ?? null;
    }
    return this.processedBuffer ?? this.buffer ?? null;
  }

  // True when the processed buffer (with baked-in stretch/pitch) is active.
  // Used to decide whether playback should apply varispeed or play at 1×.
  private usingProcessed(): boolean {
    return this.reversed
      ? this.processedReversedBuffer !== null
      : this.processedBuffer !== null;
  }

  private static reverseBuffer(buf: AudioBuffer, ctx: AudioContext): AudioBuffer {
    const rev = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c).slice().reverse();
      rev.copyToChannel(data, c);
    }
    return rev;
  }

  private static computePeaks(buffer: AudioBuffer, columns: number): number[] {
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / columns));
    const peaks: number[] = [];
    for (let i = 0; i < columns; i++) {
      let mn = 0, mx = 0;
      const base = i * step;
      for (let j = 0; j < step && base + j < data.length; j++) {
        const s = data[base + j];
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      peaks.push(mn, mx);
    }
    return peaks;
  }

  private static readonly FADE = 0.004; // 4 ms — enough to kill clicks, short enough to be inaudible

  play(startTime: number, loopDuration: number, offsetIntoLoop = 0): void {
    this.stop();
    if (this.muted) return;
    const buf = this.effectiveBuffer();
    if (!buf) return;
    const baked = this.usingProcessed();
    // With the processed buffer, stretch and pitch are already applied, so play
    // at 1× / 0 cents. Otherwise fall back to varispeed so audio keeps flowing
    // until the async stretch catches up.
    const rate   = baked ? 1        : this.timeStretch;
    const detune = baked ? 0        : this.pitch * 100;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = false;
    src.playbackRate.value = rate;
    src.detune.value       = detune;
    src.connect(this.loopGain);

    // Fade in from silence at sample start to eliminate transient click
    this.loopGain.gain.cancelScheduledValues(startTime);
    this.loopGain.gain.setValueAtTime(0, startTime);
    this.loopGain.gain.linearRampToValueAtTime(1, startTime + Track.FADE);

    if (this.reversed) {
      src.start(startTime, 0);
    } else {
      // loopStartOffset is in raw-buffer seconds; rescale when the baked buffer
      // is in use (it has length = raw / timeStretch).
      const startOffset = baked ? this.loopStartOffset / this.timeStretch : this.loopStartOffset;
      // With the baked buffer, buffer time = loop time. Otherwise, buffer time
      // advances at timeStretch× loop time.
      const bufPerLoop = baked ? 1 : this.timeStretch;
      const regionLen = Math.max(0.001,
        Math.min(buf.duration - startOffset, loopDuration * bufPerLoop));
      const safeOffset = (offsetIntoLoop * bufPerLoop) % regionLen;
      src.start(startTime, startOffset + safeOffset);
    }
    this.sourceNode = src;
  }

  // Called by the engine's bar-boundary lookahead scheduler
  scheduleRetrigger(atTime: number): void {
    if (!this.buffer || this.muted) return;
    const buf = this.effectiveBuffer();
    if (!buf) return;
    const baked = this.usingProcessed();
    const F   = Track.FADE;

    // Fade out the current source just before the bar boundary, then stop it
    const old = this.sourceNode;
    if (old) {
      this.loopGain.gain.cancelScheduledValues(atTime - F);
      this.loopGain.gain.setValueAtTime(1, atTime - F);
      this.loopGain.gain.linearRampToValueAtTime(0, atTime);
      try { old.stop(atTime); } catch (_) {}
      old.onended = () => { try { old.disconnect(); } catch (_) {} this.pendingStops.delete(old); };
      this.pendingStops.add(old);
      this.sourceNode = null;
    }

    // Schedule a new source starting at the bar boundary with a fade in
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = false;
    src.playbackRate.value = baked ? 1 : this.timeStretch;
    src.detune.value       = baked ? 0 : this.pitch * 100;
    src.connect(this.loopGain);
    this.loopGain.gain.setValueAtTime(0, atTime);
    this.loopGain.gain.linearRampToValueAtTime(1, atTime + F);
    const startOffset = baked ? this.loopStartOffset / this.timeStretch : this.loopStartOffset;
    src.start(atTime, this.reversed ? 0 : startOffset);
    this.sourceNode = src;
  }

  stop(): void {
    for (const src of this.pendingStops) {
      try { src.stop(); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
    }
    this.pendingStops.clear();
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch (_) {}
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
  }

  startMonitoring(stream: MediaStream): void {
    this.stopMonitoring();
    this.monitorSource = this.ctx.createMediaStreamSource(stream) as MediaStreamAudioSourceNode;
    this.monitorSource.connect(this.gainNode);
  }

  stopMonitoring(): void {
    if (this.monitorSource) {
      this.monitorSource.disconnect();
      this.monitorSource = null;
    }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.gainNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  setPan(p: number): void {
    this.pan = Math.max(-1, Math.min(1, p));
    this.panNode.pan.setTargetAtTime(this.pan, this.ctx.currentTime, 0.01);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (m && this.sourceNode) this.stop();
  }

  setTimeStretch(rate: number): void {
    const next = Math.max(0.25, Math.min(4, rate));
    if (next === this.timeStretch) return;
    this.timeStretch = next;
    // Invalidate processed buffers so playback falls back to varispeed until
    // the new stretched buffer is ready.
    this.processedBuffer = null;
    this.processedReversedBuffer = null;
    this.regenerateProcessed();
  }

  setPitch(semitones: number): void {
    const next = Math.max(-24, Math.min(24, semitones));
    if (next === this.pitch) return;
    this.pitch = next;
    this.processedBuffer = null;
    this.processedReversedBuffer = null;
    this.regenerateProcessed();
  }

  setLoopStartOffset(offset: number): void {
    this.loopStartOffset = Math.max(0, Math.min(this.buffer ? this.buffer.duration * 0.95 : 0, offset));
  }

  setRootNote(note: number): void {
    this.rootNote = Math.max(0, Math.min(127, note));
  }

  playNote(midiNote: number, velocity: number): void {
    if (!this.buffer || this.muted) return;
    this.stopNote(midiNote);
    const buf = this.effectiveBuffer();
    if (!buf) return;
    const baked = this.usingProcessed();

    const vel = this.ctx.createGain();
    vel.gain.value = velocity / 127;
    vel.connect(this.gainNode);

    const midiStartOffset = baked ? this.loopStartOffset / this.timeStretch : this.loopStartOffset;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = this.reversed ? 0 : midiStartOffset;
    src.loopEnd   = buf.duration;
    // MIDI notes are chromatic by design (varispeed per note). When the buffer
    // is baked, the pitch knob is already applied — just add the note offset.
    // When not baked, we still need to layer timeStretch + pitch + note offset.
    src.playbackRate.value = baked ? 1 : this.timeStretch;
    src.detune.value = baked
      ? (midiNote - this.rootNote) * 100
      : (midiNote - this.rootNote) * 100 + this.pitch * 100;
    src.connect(vel);
    src.start(0, this.reversed ? 0 : midiStartOffset);
    src.onended = () => { vel.disconnect(); this.midiSources.delete(midiNote); };
    this.midiSources.set(midiNote, { src, vel });
  }

  stopNote(midiNote: number): void {
    const entry = this.midiSources.get(midiNote);
    if (!entry) return;
    const { src, vel } = entry;
    // Short fade-out to avoid clicks
    vel.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
    try { src.stop(this.ctx.currentTime + 0.08); } catch (_) {}
    this.midiSources.delete(midiNote);
  }

  stopAllNotes(): void {
    for (const note of [...this.midiSources.keys()]) this.stopNote(note);
  }

  stretchToFit(loopDuration: number): void {
    if (!this.buffer || loopDuration <= 0) return;
    this.setTimeStretch(this.buffer.duration / loopDuration);
  }

  /** Render this track through its full effects chain into a new AudioBuffer.
   *  Bakes time-stretch and pitch via soundtouchjs, honors reversed state,
   *  effect order, bypass states, master bypass, loopStartOffset, volume, and
   *  pan. Used by the stem/master exporters for "wet" output. */
  async renderOffline(loopDuration: number, bpm: number): Promise<AudioBuffer> {
    const rawBuf = this.reversed && this.reversedBuffer ? this.reversedBuffer : this.buffer;
    if (!rawBuf) throw new Error(`Track ${this.name} has no audio to render`);

    const sr  = rawBuf.sampleRate;
    const len = Math.ceil(loopDuration * sr);
    const off = new OfflineAudioContext(2, len, sr);

    // Load worklets against the offline context (fresh context has no modules)
    await Promise.all([
      off.audioWorklet.addModule('./worklets/stereo-widener-worklet.js').catch(() => {}),
      off.audioWorklet.addModule('./worklets/ms-eq-worklet.js').catch(() => {}),
      off.audioWorklet.addModule('./worklets/bit-crusher-worklet.js').catch(() => {}),
      off.audioWorklet.addModule('./worklets/trance-gate-worklet.js').catch(() => {}),
    ]);

    // Bake stretch + pitch. Result plays at playbackRate=1.
    const stretched = await stretchBuffer(off, rawBuf, this.timeStretch, this.pitch);

    // Fresh effect instances, initialized and configured from live state
    const fx = {
      filter:     new Filter(off),
      eq:         new EQ3(off),
      clipper:    new Clipper(off),
      waveshaper: new Waveshaper(off),
      saturator:  new MultibandSaturator(off),
      compressor: new Compressor(off),
      widener:    new StereoWidener(off),
      mseq:       new MSEQ(off),
      chorus:     new Chorus(off),
      delay:      new Delay(off),
      reverb:     new Reverb(off),
      bitcrusher: new BitCrusher(off),
      autopan:    new AutoPan(off),
      trancegate: new TranceGate(off),
    };
    await Promise.all([fx.widener.init(), fx.mseq.init(), fx.bitcrusher.init(), fx.trancegate.init()]);

    // Mirror every knob from live → offline
    fx.filter.setType(this.filter.type);
    fx.filter.setFreq(this.filter.freq);
    fx.filter.setQ(this.filter.q);
    fx.filter.setMix(this.filter.mix);
    fx.filter.setBypassed(this.filter.bypassed);

    fx.eq.setLow(this.eq.lowGain);
    fx.eq.setMid(this.eq.midGain);
    fx.eq.setHigh(this.eq.highGain);
    fx.eq.setBypassed(this.eq.bypassed);

    fx.clipper.setAmount(this.clipper.amount);
    fx.clipper.setDrive(this.clipper.drive);
    fx.clipper.setMix(this.clipper.mix);
    fx.clipper.setBypassed(this.clipper.bypassed);

    fx.waveshaper.setDrive(this.waveshaper.drive);
    fx.waveshaper.setMix(this.waveshaper.mix);
    fx.waveshaper.setBypassed(this.waveshaper.bypassed);

    fx.saturator.setDrive(this.saturator.drive);
    fx.saturator.setMix(this.saturator.mix);
    fx.saturator.setLowFreq(this.saturator.lowFreq);
    fx.saturator.setHighFreq(this.saturator.highFreq);
    fx.saturator.setBypassed(this.saturator.bypassed);

    fx.compressor.setDrive(this.compressor.drive);
    fx.compressor.setRatio(this.compressor.ratio);
    fx.compressor.setAttack(this.compressor.attack);
    fx.compressor.setRelease(this.compressor.release);
    fx.compressor.setMakeup(this.compressor.makeup);
    fx.compressor.setBypassed(this.compressor.bypassed);

    fx.widener.setWidth(this.widener.width);
    fx.widener.setMix(this.widener.mix);
    fx.widener.setBypassed(this.widener.bypassed);

    fx.mseq.setMidFreq(this.mseq.midFreq);
    fx.mseq.setMidGain(this.mseq.midGain);
    fx.mseq.setSideFreq(this.mseq.sideFreq);
    fx.mseq.setSideGain(this.mseq.sideGain);
    fx.mseq.setMix(this.mseq.mix);
    fx.mseq.setBypassed(this.mseq.bypassed);

    fx.chorus.setRate(this.chorus.rate);
    fx.chorus.setDepth(this.chorus.depth);
    fx.chorus.setMix(this.chorus.mix);
    fx.chorus.setBypassed(this.chorus.bypassed);

    fx.delay.setTimeL(this.delay.timeL);
    fx.delay.setTimeR(this.delay.timeR);
    fx.delay.setFeedback(this.delay.feedback);
    fx.delay.setMix(this.delay.mix);
    fx.delay.setPingPong(this.delay.pingPong);
    fx.delay.setBypassed(this.delay.bypassed);

    fx.reverb.setMix(this.reverb.mix);
    fx.reverb.setDecay(this.reverb.decay);
    fx.reverb.setPreHPF(this.reverb.preHPFFreq);
    fx.reverb.setBypassed(this.reverb.bypassed);

    fx.bitcrusher.setBits(this.bitcrusher.bits);
    fx.bitcrusher.setRate(this.bitcrusher.rate);
    fx.bitcrusher.setMix(this.bitcrusher.mix);
    fx.bitcrusher.setBypassed(this.bitcrusher.bypassed);

    fx.autopan.setRate(this.autopan.rate);
    fx.autopan.setDepth(this.autopan.depth);
    fx.autopan.setMix(this.autopan.mix);
    fx.autopan.setBypassed(this.autopan.bypassed);

    fx.trancegate.setBPM(bpm);
    fx.trancegate.setRate(this.trancegate.rate);
    fx.trancegate.setDepth(this.trancegate.depth);
    fx.trancegate.setAttack(this.trancegate.attack);
    fx.trancegate.setRelease(this.trancegate.release);
    fx.trancegate.setMix(this.trancegate.mix);
    fx.trancegate.setSyncDiv(this.trancegate.syncDiv);
    fx.trancegate.setSynced(this.trancegate.synced);
    fx.trancegate.setBypassed(this.trancegate.bypassed);

    // Source node (plays the pre-stretched buffer at 1× / 0 cents)
    const src = off.createBufferSource();
    src.buffer = stretched;
    src.loop = true;
    src.loopEnd = stretched.duration;
    const startOffset = this.reversed
      ? 0
      : this.loopStartOffset / Math.max(0.001, this.timeStretch);

    // Volume + pan applied after the effects chain
    const gain = off.createGain();
    gain.gain.value = this.volume;
    const pan = off.createStereoPanner();
    pan.pan.value = this.pan;

    // Wire source → [effects in order, unless master-bypassed] → gain → pan → destination
    let tail: AudioNode = src;
    if (!this.masterBypass && this.effectsOrder.length > 0) {
      const order = this.effectsOrder;
      tail.connect((fx as any)[order[0]].input);
      for (let i = 0; i < order.length - 1; i++) {
        (fx as any)[order[i]].output.connect((fx as any)[order[i + 1]].input);
      }
      tail = (fx as any)[order[order.length - 1]].output;
    }
    tail.connect(gain);
    gain.connect(pan);
    pan.connect(off.destination);

    src.start(0, startOffset);
    const rendered = await off.startRendering();

    // Stop any running oscillators so they don't leak (technically fine since
    // the offline context is discarded, but keep it tidy).
    fx.chorus.dispose();
    fx.autopan.dispose();
    fx.trancegate.dispose();
    return rendered;
  }

  getState(): TrackState {
    return {
      id: this.id,
      name: this.name,
      volume: this.volume,
      pan: this.pan,
      muted: this.muted,
      soloed: this.soloed,
      armed: this.armed,
      midiArmed: this.midiArmed,
      rootNote:  this.rootNote,
      reversed: this.reversed,
      timeStretch: this.timeStretch,
      pitch: this.pitch,
      loopStartOffset: this.loopStartOffset,
      quantizeEnabled: this.quantizeEnabled,
      quantizeGrid: this.quantizeGrid,
      swingAmount: this.swingAmount,
      effects: {
        filter:     { type: this.filter.type, freq: this.filter.freq, q: this.filter.q, mix: this.filter.mix, bypassed: this.filter.bypassed },
        eq:         { lowGain: this.eq.lowGain, midGain: this.eq.midGain, highGain: this.eq.highGain, bypassed: this.eq.bypassed },
        clipper:    { amount: this.clipper.amount, drive: this.clipper.drive, mix: this.clipper.mix, bypassed: this.clipper.bypassed },
        waveshaper: { drive: this.waveshaper.drive, mix: this.waveshaper.mix, bypassed: this.waveshaper.bypassed },
        saturator:  { drive: this.saturator.drive, mix: this.saturator.mix, lowFreq: this.saturator.lowFreq, highFreq: this.saturator.highFreq, bypassed: this.saturator.bypassed },
        compressor: { drive: this.compressor.drive, ratio: this.compressor.ratio, attack: this.compressor.attack, release: this.compressor.release, makeup: this.compressor.makeup, bypassed: this.compressor.bypassed },
        widener:    { width: this.widener.width, mix: this.widener.mix, bypassed: this.widener.bypassed },
        mseq:       { midFreq: this.mseq.midFreq, midGain: this.mseq.midGain, sideFreq: this.mseq.sideFreq, sideGain: this.mseq.sideGain, mix: this.mseq.mix, bypassed: this.mseq.bypassed },
        chorus:     { rate: this.chorus.rate, depth: this.chorus.depth, mix: this.chorus.mix, bypassed: this.chorus.bypassed },
        delay:      { timeL: this.delay.timeL, timeR: this.delay.timeR, feedback: this.delay.feedback, mix: this.delay.mix, pingPong: this.delay.pingPong, bypassed: this.delay.bypassed },
        reverb:     { mix: this.reverb.mix, decay: this.reverb.decay, preHPF: this.reverb.preHPFFreq, bypassed: this.reverb.bypassed },
        bitcrusher: { bits: this.bitcrusher.bits, rate: this.bitcrusher.rate, mix: this.bitcrusher.mix, bypassed: this.bitcrusher.bypassed },
        autopan:    { rate: this.autopan.rate, depth: this.autopan.depth, mix: this.autopan.mix, bypassed: this.autopan.bypassed },
        trancegate: { rate: this.trancegate.rate, depth: this.trancegate.depth, attack: this.trancegate.attack, release: this.trancegate.release, mix: this.trancegate.mix, synced: this.trancegate.synced, syncDiv: this.trancegate.syncDiv, bypassed: this.trancegate.bypassed },
        masterBypass: this.masterBypass,
        effectsOrder: [...this.effectsOrder],
      },
      hasAudio: this.buffer !== null,
      bufferDuration: this.buffer?.duration ?? 0,
      waveformPeaks: this.waveformPeaks,
      color: this.color,
    };
  }

  clone(destination: AudioNode): Track {
    const t = new Track(this.ctx, destination);
    t.name = `${this.name} CPY`;
    if (this.buffer) {
      t.buffer = this.buffer;
      t.reversedBuffer = this.reversedBuffer;
      t.waveformPeaks = this.waveformPeaks;
    }
    t.setVolume(this.volume);
    t.setPan(this.pan);
    t.timeStretch   = this.timeStretch;
    t.pitch         = this.pitch;
    t.reversed      = this.reversed;
    t.effectsOrder  = [...this.effectsOrder];
    t.waveshaper.setDrive(this.waveshaper.drive);
    t.waveshaper.setMix(this.waveshaper.mix);
    t.saturator.setDrive(this.saturator.drive);
    t.saturator.setMix(this.saturator.mix);
    t.compressor.setDrive(this.compressor.drive);
    t.compressor.setRatio(this.compressor.ratio);
    t.compressor.setAttack(this.compressor.attack);
    t.compressor.setRelease(this.compressor.release);
    t.compressor.setMakeup(this.compressor.makeup);
    t.reverb.setMix(this.reverb.mix);
    t.reverb.setDecay(this.reverb.decay);
    t.delay.setTimeL(this.delay.timeL);
    t.delay.setTimeR(this.delay.timeR);
    t.delay.setFeedback(this.delay.feedback);
    t.delay.setMix(this.delay.mix);
    return t;
  }

  dispose(): void {
    this.stop();
    this.stopMonitoring();
    this.stopAllNotes();
    this.chorus.dispose();
    this.autopan.dispose();
    this.trancegate.dispose();
    this.gainNode.disconnect();
    this.panNode.disconnect();
  }
}
