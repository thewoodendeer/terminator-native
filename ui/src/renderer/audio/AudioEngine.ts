import { Track, TrackState, EffectKey } from './Track';
import { LoopRecorder } from './LoopRecorder';
import { Quantizer, GridDiv } from './Quantizer';
import { exportStem, exportMaster, ExportOptions } from './StemExporter';
import { Metronome } from './Metronome';
import { MidiInput } from './MidiInput';

export interface EngineState {
  isPlaying: boolean;
  isRecording: boolean;
  isCountingIn: boolean;
  recordingTrackId: string | null;
  bpm: number;
  bars: number;
  swing: number;
  quantizeGrid: GridDiv;
  loopProgress: number;
  currentBeat: number;
  masterVolume: number;
  tracks: TrackState[];
  metronomeOn: boolean;
  limiterEnabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  midiConnected: boolean;
  midiInputCount: number;
}

type HistoryEntry = { tracks: TrackState[]; buffers: Map<string, AudioBuffer | null> };

export class AudioEngine {
  readonly context: AudioContext;
  readonly masterGain: GainNode;
  readonly masterLimiter: DynamicsCompressorNode;
  readonly analyser: AnalyserNode;

  private tracks: Map<string, Track> = new Map();
  private recorder: LoopRecorder;
  private quantizer: Quantizer;

  private isPlaying = false;
  private isRecording = false;
  private recordingTrackId: string | null = null;
  private loopStartTime = 0;
  private bpm = 140;
  private bars = 4;
  private swing = 50;
  private quantizeGrid: GridDiv = '1/16';
  private masterVolume = 0.85;
  private rafId = 0;

  private metronome: Metronome;
  private metronomeEnabled = false;
  private limiterEnabled = true;
  private nextBarTime = 0;
  private isCountingIn = false;
  private countInAborted = false;
  private micStream: MediaStream | null = null;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private midi: MidiInput;

  private onUpdate: ((s: EngineState) => void) | null = null;

  constructor() {
    this.context = new AudioContext({ latencyHint: 'interactive' });

    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = this.masterVolume;

    this.masterLimiter = this.context.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -1;
    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.attack.value = 0.001;
    this.masterLimiter.release.value = 0.05;

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    this.masterGain.connect(this.masterLimiter);
    this.masterLimiter.connect(this.analyser);
    this.analyser.connect(this.context.destination);

    this.recorder = new LoopRecorder(this.context);
    this.quantizer = new Quantizer(this.bpm, this.swing);
    this.metronome = new Metronome(this.context, this.context.destination);

    this.midi = new MidiInput();
    this.midi.init().then(() => this.emit());
    this.midi.onNoteOn((note, vel) => {
      for (const t of this.tracks.values()) {
        if (t.midiArmed) t.playNote(note, vel);
      }
    });
    this.midi.onNoteOff(note => {
      for (const t of this.tracks.values()) {
        if (t.midiArmed) t.stopNote(note);
      }
    });
  }

  subscribe(cb: (s: EngineState) => void): () => void {
    this.onUpdate = cb;
    return () => { this.onUpdate = null; };
  }

  // ─── Tracks ──────────────────────────────────────────────────────────────

  async addTrack(): Promise<Track> {
    const track = new Track(this.context, this.masterGain);
    await track.initWorklets();
    this.tracks.set(track.id, track);
    this.emit();
    return track;
  }

  removeTrack(id: string): void {
    this.pushHistory();
    const t = this.tracks.get(id);
    if (t) { t.dispose(); this.tracks.delete(id); }
    this.emit();
  }

  async duplicateTrack(id: string): Promise<void> {
    const src = this.tracks.get(id);
    if (!src) return;
    this.pushHistory();
    const copy = src.clone(this.masterGain);
    await copy.initWorklets();
    this.tracks.set(copy.id, copy);
    if (this.isPlaying && copy.buffer) {
      const offset = (this.context.currentTime - this.loopStartTime) % this.loopDuration;
      copy.play(this.context.currentTime, this.loopDuration, offset);
    }
    this.emit();
  }

  // ─── Transport ───────────────────────────────────────────────────────────

  async play(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume();
    if (this.isPlaying) return;

    this.isPlaying = true;
    this.loopStartTime = this.context.currentTime;
    this.nextBarTime   = this.loopStartTime + this.loopDuration;

    for (const t of this.tracks.values()) {
      if (t.buffer) t.play(this.loopStartTime, this.loopDuration);
    }
    if (this.metronomeEnabled) this.metronome.start(this.bpm);
    this.startClock();
    this.emit();
  }

  stop(): void {
    this.countInAborted = true;   // cancel any in-progress count-in
    this.isCountingIn = false;
    this.isPlaying = false;
    this.isRecording = false;
    this.recordingTrackId = null;
    cancelAnimationFrame(this.rafId);

    for (const t of this.tracks.values()) t.stop();
    if (this.recorder.isRecording) this.recorder.cancel();
    this.metronome.stop();
    this.emit();
  }

  async startRecording(trackId?: string): Promise<string> {
    if (this.context.state === 'suspended') await this.context.resume();
    this.pushHistory();

    let target: Track;
    if (trackId) {
      target = this.tracks.get(trackId)!;
      if (!target) throw new Error('Track not found');
    } else {
      target = await this.addTrack();
    }

    if (!this.isPlaying) {
      // 4-click pre-count before recording starts
      const beatDuration = 60 / this.bpm;
      this.isCountingIn  = true;
      this.countInAborted = false;
      this.emit();

      this.metronome.countIn(this.bpm, 4);
      await new Promise<void>(resolve =>
        setTimeout(resolve, 4 * beatDuration * 1000 + 50)
      );

      if (this.countInAborted) return target.id; // stop() was pressed during count-in
      this.isCountingIn = false;

      this.isPlaying = true;
      this.loopStartTime = this.context.currentTime;
      this.nextBarTime   = this.loopStartTime + this.loopDuration;
      for (const t of this.tracks.values()) {
        if (t.id !== target.id && t.buffer) t.play(this.loopStartTime, this.loopDuration);
      }
      this.startClock();
    }

    this.isRecording = true;
    this.recordingTrackId = target.id;
    this.emit();

    await this.recorder.start();

    // Auto-stop after one loop
    setTimeout(async () => {
      if (!this.isRecording || this.recordingTrackId !== target.id) return;
      try {
        const buf = await this.recorder.stop();
        const processed = target.quantizeEnabled
          ? this.quantizer.quantizeBuffer(this.context, buf, this.quantizeGrid)
          : buf;
        target.setBuffer(processed);
        if (this.isPlaying) {
          const offset = (this.context.currentTime - this.loopStartTime) % this.loopDuration;
          target.play(this.context.currentTime, this.loopDuration, offset);
        }
      } catch (e) {
        console.error('Recording error:', e);
      }
      this.isRecording = false;
      this.recordingTrackId = null;
      this.emit();
    }, this.loopDuration * 1000);

    return target.id;
  }

  async overdub(trackId: string): Promise<void> {
    const track = this.tracks.get(trackId);
    if (!track) return;
    this.pushHistory();

    this.isRecording = true;
    this.recordingTrackId = trackId;
    this.emit();

    await this.recorder.start();

    setTimeout(async () => {
      if (!this.isRecording) return;
      try {
        const newBuf = await this.recorder.stop();
        const existing = track.buffer;
        const mixed = this.mixBuffers(existing, newBuf);
        track.setBuffer(mixed);
        if (this.isPlaying) {
          const offset = (this.context.currentTime - this.loopStartTime) % this.loopDuration;
          track.play(this.context.currentTime, this.loopDuration, offset);
        }
      } catch (e) {
        console.error('Overdub error:', e);
      }
      this.isRecording = false;
      this.recordingTrackId = null;
      this.emit();
    }, this.loopDuration * 1000);
  }

  // ─── Track mutations ─────────────────────────────────────────────────────

  setTrackVolume(id: string, v: number)   { this.tracks.get(id)?.setVolume(v);      this.emit(); }
  setTrackPan(id: string, p: number)      { this.tracks.get(id)?.setPan(p);         this.emit(); }
  setTrackMute(id: string, m: boolean)    { this.tracks.get(id)?.setMuted(m);       this.emit(); }
  setTrackSolo(id: string, s: boolean)    {
    const t = this.tracks.get(id);
    if (!t) return;
    t.soloed = s;
    const anySolo = [...this.tracks.values()].some(x => x.soloed);
    for (const tr of this.tracks.values()) {
      tr.gainNode.gain.setTargetAtTime(
        anySolo && !tr.soloed ? 0 : tr.volume, this.context.currentTime, 0.01
      );
    }
    this.emit();
  }
  setTrackArmed(id: string, a: boolean): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.armed = a;
    if (a) {
      this.getMicStream().then((stream: MediaStream) => {
        if (t.armed) t.startMonitoring(stream);
      }).catch(console.warn);
    } else {
      t.stopMonitoring();
    }
    this.emit();
  }
  setTrackStretch(id: string, r: number)  { this.tracks.get(id)?.setTimeStretch(r); this.emit(); }
  setTrackPitch(id: string, v: number)    { this.tracks.get(id)?.setPitch(v);        this.emit(); }
  setTrackLoopStart(id: string, v: number){ this.tracks.get(id)?.setLoopStartOffset(v); this.emit(); }
  setTrackName(id: string, n: string)     { const t = this.tracks.get(id); if (t) { t.name = n; this.emit(); } }
  reorderTrackEffects(id: string, order: EffectKey[]): void {
    this.tracks.get(id)?.reorderEffects(order);
    this.emit();
  }

  setTrackMidiArmed(id: string, armed: boolean): void {
    const t = this.tracks.get(id);
    if (!t) return;
    if (!armed) t.stopAllNotes();
    t.midiArmed = armed;
    this.emit();
  }

  setTrackRootNote(id: string, note: number): void {
    this.tracks.get(id)?.setRootNote(note);
    this.emit();
  }

  setTrackEffect(id: string, fn: (t: Track) => void): void {
    const t = this.tracks.get(id);
    if (t) { fn(t); this.emit(); }
  }

  stretchAllToFirstTrack(): void {
    const first = [...this.tracks.values()].find(t => t.buffer);
    if (!first) return;
    for (const t of this.tracks.values()) {
      if (t.id !== first.id) t.stretchToFit(this.loopDuration);
    }
    this.emit();
  }

  // ─── Global settings ─────────────────────────────────────────────────────

  toggleMetronome(): void {
    this.metronomeEnabled = !this.metronomeEnabled;
    if (this.metronomeEnabled && this.isPlaying) {
      this.metronome.start(this.bpm);
    } else {
      this.metronome.stop();
    }
    this.emit();
  }

  setBPM(bpm: number): void {
    this.bpm = Math.max(40, Math.min(300, bpm));
    this.quantizer.bpm = this.bpm;
    this.metronome.updateBPM(this.bpm);
    for (const t of this.tracks.values()) t.setBPM(this.bpm);
    this.emit();
  }

  setTrackReversed(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.setReversed(!t.reversed);
    if (this.isPlaying && t.buffer) {
      const offset = (this.context.currentTime - this.loopStartTime) % this.loopDuration;
      t.play(this.context.currentTime, this.loopDuration, offset);
    }
    this.emit();
  }

  setBars(bars: number): void {
    this.bars = Math.max(1, Math.min(64, bars));
    this.emit();
  }

  setSwing(swing: number): void {
    this.swing = Math.max(50, Math.min(75, swing));
    this.quantizer.swing = this.swing;
    this.emit();
  }

  setQuantizeGrid(grid: GridDiv): void {
    this.quantizeGrid = grid;
    this.emit();
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    this.masterGain.gain.setTargetAtTime(this.masterVolume, this.context.currentTime, 0.01);
    this.emit();
  }

  setLimiterEnabled(enabled: boolean): void {
    this.limiterEnabled = enabled;
    this.masterLimiter.ratio.value = enabled ? 20 : 1;
    this.masterLimiter.threshold.value = enabled ? -1 : 0;
    this.emit();
  }

  private async getMicStream(): Promise<MediaStream> {
    if (this.micStream) return this.micStream;
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    return this.micStream;
  }

  get loopDuration(): number {
    return this.quantizer.loopDuration(this.bars);
  }

  // ─── Analyser ────────────────────────────────────────────────────────────

  getWaveform(): Uint8Array {
    const d = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(d);
    return d;
  }

  getSpectrum(): Uint8Array {
    const d = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(d);
    return d;
  }

  // ─── Export ──────────────────────────────────────────────────────────────

  async exportTrack(id: string, opts: ExportOptions): Promise<{ name: string; data: ArrayBuffer }> {
    const t = this.tracks.get(id);
    if (!t) throw new Error('Track not found');
    return exportStem(t, this.loopDuration, this.bpm, opts);
  }

  async exportAllStems(opts: ExportOptions): Promise<Array<{ name: string; data: ArrayBuffer }>> {
    const results = [];
    for (const t of this.tracks.values()) {
      if (t.buffer) results.push(await exportStem(t, this.loopDuration, this.bpm, opts));
    }
    return results;
  }

  async exportMaster(opts: ExportOptions): Promise<{ name: string; data: ArrayBuffer }> {
    return exportMaster([...this.tracks.values()], this.loopDuration, this.bpm, opts);
  }

  // ─── Undo / Redo ─────────────────────────────────────────────────────────

  undo(): void {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.captureHistory());
    this.applyHistory(this.undoStack.pop()!);
  }

  redo(): void {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.captureHistory());
    this.applyHistory(this.redoStack.pop()!);
  }

  private pushHistory(): void {
    this.undoStack.push(this.captureHistory());
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  private captureHistory(): HistoryEntry {
    const buffers = new Map<string, AudioBuffer | null>();
    for (const [id, t] of this.tracks) buffers.set(id, t.buffer);
    return { tracks: [...this.tracks.values()].map(t => t.getState()), buffers };
  }

  private applyHistory(entry: HistoryEntry): void {
    // Restore buffers only (state is in React; full structural undo would need more)
    for (const [id, buf] of entry.buffers) {
      const t = this.tracks.get(id);
      if (t) t.buffer = buf;
    }
    this.emit();
  }

  // ─── Presets ─────────────────────────────────────────────────────────────

  exportPreset(trackId: string): string {
    const t = this.tracks.get(trackId);
    if (!t) throw new Error('Track not found');
    return JSON.stringify({ version: 1, effects: t.getState().effects }, null, 2);
  }

  importPreset(trackId: string, json: string): void {
    const t = this.tracks.get(trackId);
    if (!t) return;
    const preset = JSON.parse(json);
    const e = preset.effects;
    t.waveshaper.setDrive(e.waveshaper.drive);
    t.waveshaper.setMix(e.waveshaper.mix);
    t.saturator.setDrive(e.saturator.drive);
    t.saturator.setMix(e.saturator.mix);
    if (e.compressor) {
      t.compressor.setDrive(e.compressor.drive);
      t.compressor.setRatio(e.compressor.ratio);
      t.compressor.setAttack(e.compressor.attack);
      t.compressor.setRelease(e.compressor.release);
      t.compressor.setMakeup(e.compressor.makeup);
    }
    t.widener.setWidth(e.widener.width);
    t.widener.setMix(e.widener.mix);
    t.mseq.setMidGain(e.mseq.midGain);
    t.mseq.setSideGain(e.mseq.sideGain);
    t.mseq.setMix(e.mseq.mix);
    this.emit();
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private startClock(): void {
    const LOOKAHEAD = 0.1; // seconds — schedule retriggering this far ahead of bar boundary
    const tick = () => {
      if (!this.isPlaying) return;
      // Lookahead: when we're within LOOKAHEAD seconds of the next bar boundary,
      // schedule all tracks to retrigger at that exact time, then advance nextBarTime.
      while (this.context.currentTime + LOOKAHEAD >= this.nextBarTime) {
        for (const t of this.tracks.values()) {
          if (t.buffer) t.scheduleRetrigger(this.nextBarTime);
        }
        this.nextBarTime += this.loopDuration;
      }
      this.emit();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private mixBuffers(existing: AudioBuffer | null, incoming: AudioBuffer): AudioBuffer {
    const ch = Math.max(existing?.numberOfChannels ?? 1, incoming.numberOfChannels);
    const len = Math.max(existing?.length ?? 0, incoming.length);
    const out = this.context.createBuffer(ch, len, this.context.sampleRate);
    for (let c = 0; c < ch; c++) {
      const dst = out.getChannelData(c);
      if (existing && c < existing.numberOfChannels) {
        dst.set(existing.getChannelData(c).subarray(0, len));
      }
      const src = incoming.getChannelData(Math.min(c, incoming.numberOfChannels - 1));
      for (let i = 0; i < src.length; i++) dst[i] = (dst[i] ?? 0) + src[i] * 0.75;
    }
    return out;
  }

  private emit(): void {
    if (!this.onUpdate) return;
    const elapsed = this.isPlaying
      ? (this.context.currentTime - this.loopStartTime) % this.loopDuration
      : 0;
    this.onUpdate({
      isPlaying: this.isPlaying,
      isRecording: this.isRecording,
      isCountingIn: this.isCountingIn,
      recordingTrackId: this.recordingTrackId,
      bpm: this.bpm,
      bars: this.bars,
      swing: this.swing,
      quantizeGrid: this.quantizeGrid,
      loopProgress: this.loopDuration > 0 ? elapsed / this.loopDuration : 0,
      currentBeat: elapsed / (60 / this.bpm),
      masterVolume: this.masterVolume,
      tracks: [...this.tracks.values()].map(t => t.getState()),
      metronomeOn: this.metronomeEnabled,
      limiterEnabled: this.limiterEnabled,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      midiConnected: this.midi.connected,
      midiInputCount: this.midi.inputCount,
    });
  }

  dispose(): void {
    this.stop();
    for (const t of this.tracks.values()) t.dispose();
    this.context.close();
  }
}
