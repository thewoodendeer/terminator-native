// BASS section — the Model-D-shaped synth panel on top, the piano roll under
// it. Desktop ChopperView mounts it as a DraggableSection like DRUMS. All
// audio/state lives in BassEngine; this file is controls + layout only.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { BassEngine, BassState, BASS_FACTORY, BASS_MAX_PATTERNS, MOD_SOURCES, MORPH_ORDER, defaultBassPatch, type OscWave, type FilterModel, type LfoWave, type ModSource } from './BassEngine';
import { BassKnob, KnobEnv, type KnobMenuInfo } from './BassKnob';
import { KnobMenu } from './KnobMenu';
import { SeqPager } from '../chopper/SeqPager';
import * as patchStore from './bassPatchStore';
import { PianoRoll, type RollTool } from './PianoRoll';
import { NOTE_NAMES, SCALES, type ScaleId } from './theory.mts';
import './BassSection.css';

interface Props {
  engine: BassEngine;
  onTransportPlay?: () => void;
  onTransportStop?: () => void;
  transportPlaying?: boolean;
  /** Called with the toggle so the host can route MIDI notes to the bass. */
  onMidiInChange?: (on: boolean) => void;
  /** Phone / iPad: bigger targets, taller roll rows, no hint text. */
  compact?: boolean;
  /** ChopperEngine — REC with the transport stopped runs the SAME count-in the
   *  chop sequencer and drums use (runCountIn: identical clicks, bar count and
   *  countInBeat visual), then starts the transport + records on the downbeat.
   *  Optional: without it REC just starts the transport straight away. */
  chopperEngine?: import('../chopper/ChopperEngine').ChopperEngine;
  /** DEMO: asked before REC arms; false = refused (host opens the popup). */
  recGate?: () => boolean;
}

// The three pulse widths are drawn (a combining glyph for the wide pulse used
// to spill outside its button); the rest are plain glyphs.
const pulseGlyph = (w: number): ReactElement => (
  <svg className="bb-wave-svg" viewBox="0 0 16 10" aria-hidden="true">
    <path d={`M0 8 H2 V2 H${2 + 12 * w} V8 H16`} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
);
const WAVES: Array<{ id: OscWave; g: string | ReactElement; t: string }> = [
  { id: 'tri', g: '△', t: 'Triangle' }, { id: 'shark', g: '◺', t: 'Shark tooth (saw-tri)' }, { id: 'saw', g: '◿', t: 'Sawtooth' },
  { id: 'square', g: pulseGlyph(0.5), t: 'Square' }, { id: 'pulse', g: pulseGlyph(0.25), t: 'Wide pulse' }, { id: 'narrow', g: pulseGlyph(0.12), t: 'Narrow pulse (PW knob)' }, { id: 'sine', g: '∿', t: 'Sine' },
];
const WAVE_SHORT: Record<string, string> = { tri: 'TRI', shark: 'SHK', saw: 'SAW', square: 'SQR', pulse: 'PLS', narrow: 'NRW', sine: 'SIN' };
/** One cycle of a shape at phase t (0..1) — display only (not band-limited). */
function shapeSample(w: OscWave, t: number, pw: number): number {
  switch (w) {
    case 'sine': return Math.sin(2 * Math.PI * t);
    case 'saw': return 2 * t - 1;
    case 'tri': return t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
    case 'shark': return 0.62 * (t < 0.5 ? 4 * t - 1 : 3 - 4 * t) + 0.5 * (2 * t - 1);
    case 'square': case 'pulse': case 'narrow': { const wd = w === 'square' ? 0.5 : w === 'pulse' ? 0.25 : pw; return (t < wd ? 1 : -1) - (2 * wd - 1); }
    default: return 0;
  }
}
/** The morphed cycle at knob position m (0..1): a crossfade of the two
 *  neighbouring shapes in MORPH_ORDER — same rule as the worklet. */
function morphSample(m: number, t: number, pw: number): number {
  const pos = Math.max(0, Math.min(1, m)) * (MORPH_ORDER.length - 1);
  const i = Math.min(MORPH_ORDER.length - 2, Math.floor(pos));
  const f = pos - i;
  return shapeSample(MORPH_ORDER[i], t, pw) * (1 - f) + shapeSample(MORPH_ORDER[i + 1], t, pw) * f;
}
function morphLabel(m: number): string {
  const pos = Math.max(0, Math.min(1, m)) * (MORPH_ORDER.length - 1);
  const i = Math.min(MORPH_ORDER.length - 2, Math.floor(pos));
  const f = pos - i;
  if (f < 0.03) return WAVE_SHORT[MORPH_ORDER[i]];
  if (f > 0.97) return WAVE_SHORT[MORPH_ORDER[i + 1]];
  return `${WAVE_SHORT[MORPH_ORDER[i]]}›${WAVE_SHORT[MORPH_ORDER[i + 1]]} ${Math.round(f * 100)}`;
}
/** Live picture of the morphed waveform — redrawn whenever the knob moves,
 *  so you SEE the shape evolve while you turn it. */
function MorphScope({ morph, pw }: { morph: number; pw: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 72, H = cv.clientHeight || 28;
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext('2d'); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const cs = getComputedStyle(cv);
    const accent = cs.getPropertyValue('--bass-accent').trim() || cs.getPropertyValue('--neon').trim() || '#f2c94c';
    g.strokeStyle = 'rgba(128,140,160,0.25)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    g.strokeStyle = accent; g.lineWidth = 1.5; g.beginPath();
    for (let x = 0; x <= W; x++) {
      const y = H / 2 - morphSample(morph, x / W, pw) * (H / 2 - 2);
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }, [morph, pw]);
  return <canvas ref={ref} className="bm-scope" title="The oscillator's shape right now — turn SHAPE and watch it morph" />;
}
const RANGES = [{ v: -2, l: "32'" }, { v: -1, l: "16'" }, { v: 0, l: "8'" }, { v: 1, l: "4'" }, { v: 2, l: "2'" }];
const GRIDS = [{ v: 1, l: '1/4' }, { v: 2, l: '1/8' }, { v: 4, l: '1/16' }, { v: 8, l: '1/32' }, { v: 3, l: '1/8T' }, { v: 6, l: '1/16T' }, { v: 0, l: 'OFF' }];

const fHz = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${v.toFixed(0)}`;
const fMs = (v: number) => v >= 1 ? `${v.toFixed(2)}s` : `${(v * 1000).toFixed(0)}ms`;
const fPct = (v: number) => `${Math.round(v * 100)}`;
const fSigned = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`;
const fBip = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;

export function BassSection({ engine, onTransportPlay, onTransportStop, transportPlaying, onMidiInChange, compact, chopperEngine, recGate }: Props) {
  const [state, setState] = useState<BassState>(() => engine.getState());
  useEffect(() => engine.subscribe(setState), [engine]);
  // Count-in state off the ChopperEngine (the REC button's beat countdown).
  const [countInBeat, setCountInBeat] = useState<number>(() => chopperEngine?.getState().countInBeat ?? -1);
  // True from our runCountIn() until its downbeat fires. If the count ends
  // while this is still set, it was cancelled from outside (■ STOP, another
  // section's stop) → drop the arm, otherwise the next PLAY would silently
  // record. (Not keyed off seqPlaying: with no sample loaded playSeq() is a
  // no-op and only drums + bass roll.)
  const countPendingRef = useRef(false);
  useEffect(() => {
    if (!chopperEngine) return;
    setCountInBeat(chopperEngine.getState().countInBeat);
    return chopperEngine.subscribe((st) => {
      if (st.countInBeat < 0 && countPendingRef.current) { countPendingRef.current = false; engine.setRecording(false); }
      setCountInBeat(st.countInBeat);
    });
  }, [chopperEngine, engine]);
  const [fold, setFold] = useState(false);
  const [showSynth, setShowSynth] = useState(!compact);
  const [tool, setTool] = useState<RollTool>('draw');
  // PITCH BEND automation lane under the roll (toolbar BEND toggle).
  const [bendLane, setBendLane] = useState(false);
  // LEARN mode (every knob flashes; tap one to arm it) + the right-click menu.
  const [learnMode, setLearnMode] = useState(false);
  // User patches (saved by name; localStorage + bass-patches.json on Electron).
  const [userPatches, setUserPatches] = useState(patchStore.list());
  useEffect(() => { void patchStore.loadFromDisk(); return patchStore.subscribe(setUserPatches); }, []);
  // SAVE never touches a FACTORY patch. First save of a factory / custom patch
  // asks for a name → a USER patch. Saving a USER patch you have edited asks
  // Overwrite / New / Cancel; NEW proposes the next free name — the same name
  // with a letter on the end (1 → 1a → 1b …) — or type any new name.
  const [saveAsk, setSaveAsk] = useState<string | null>(null);
  const isFactoryName = (n: string) => BASS_FACTORY.some((f) => f.name.toLowerCase() === n.trim().toLowerCase());
  const takenName = (n: string) => isFactoryName(n) || userPatches.some((u) => u.name.toLowerCase() === n.trim().toLowerCase());
  const nextFreeName = (base: string) => {
    const b = base.replace(/\*$/, '').trim();
    for (let i = 0; i < 26 * 27; i++) {
      const suffix = i < 26 ? String.fromCharCode(97 + i) : String.fromCharCode(97 + Math.floor(i / 26) - 1) + String.fromCharCode(97 + (i % 26));
      const cand = `${b}${suffix}`;
      if (!takenName(cand)) return cand;
    }
    return `${b}${Date.now() % 1000}`;
  };
  const saveAs = (proposed: string) => {
    const typed = window.prompt('Save bass patch as:', proposed);
    if (!typed) return;
    let name = typed.trim().slice(0, 40);
    if (!name) return;
    if (isFactoryName(name)) { window.alert('That name is a factory patch — pick another.'); return; }
    // NEW with the name left as-is (or any taken name) → the next free lettered name
    if (userPatches.some((u) => u.name === name)) name = nextFreeName(name);
    patchStore.save(name, state.patch);
    engine.setPatch({}, { name });
  };
  const savePatch = () => {
    const cur = state.presetName?.replace(/\*$/, '') ?? '';
    const isUser = userPatches.some((u) => u.name === cur);
    if (isUser) { setSaveAsk(cur); return; }           // Overwrite / New / Cancel (inline)
    saveAs(cur && !isFactoryName(cur) ? cur : '');      // factory or custom → name it → USER
  };
  const deletePatch = () => {
    const cur = state.presetName?.replace(/\*$/, '') ?? '';
    if (!userPatches.some((u) => u.name === cur)) return;
    if (!window.confirm(`Delete bass patch "${cur}"?`)) return;
    patchStore.remove(cur);
    engine.setPatch({}, { name: `${cur}*` });
  };
  const [menu, setMenu] = useState<KnobMenuInfo | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  useEffect(() => engine.onMeter((lvl, voices) => {
    const el = meterRef.current; if (!el) return;
    el.style.setProperty('--lvl', `${Math.min(1, lvl) * 100}%`);
    el.dataset.voices = String(voices);
    el.classList.toggle('hot', lvl > 1.05);
  }), [engine]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [accent, setAccent] = useState('#00ff88');
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const read = () => setAccent(getComputedStyle(el).getPropertyValue('--bass-accent').trim() || '#00ff88');
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'data-finish', 'style'] });
    const host = el.closest('.chopper-root, .app-root, [data-palette]');
    if (host) mo.observe(host, { attributes: true });
    return () => mo.disconnect();
  }, []);

  const p = state.patch;
  const set = (path: string, v: any) => engine.setParam(path, v);
  // Every knob in this panel: learn-mode aware, shows its MOD count, opens the
  // menu — via KnobEnv (see BassKnob.tsx for why not a wrapper component).
  const modCountFor = (id: string) => state.patch.mods.filter((m) => m.target === id.replace(/^bass\./, '')).length;
  const knobEnv = { learnMode, modCountFor, onMenu: setMenu };
  const pat = state.patterns[state.currentIdx] ?? state.patterns[0];
  const playing = !!transportPlaying || state.playing;

  // REC behaves like the sequencer's: transport stopped → count in a bar (the
  // chopper's shared click + countdown), then start the transport and record
  // from the downbeat; transport already rolling → just punch in. Clicking
  // during the count cancels it (nothing is playing yet); clicking while
  // recording punches out and leaves the transport running.
  const toggleRec = () => {
    if (countInBeat >= 0) {
      countPendingRef.current = false;
      chopperEngine?.stopLiveRecord();       // aborts the pending count-in + clicks
      engine.setRecording(false);
      return;
    }
    if (state.recording) { engine.setRecording(false); return; }
    if (recGate && !recGate()) return;
    engine.setRecording(true);
    if (!state.midiIn) { engine.setMidiIn(true); onMidiInChange?.(true); }
    if (playing) return;                      // rolling → notes record from here on
    const onDownbeat = () => { countPendingRef.current = false; onTransportPlay?.(); };
    if (chopperEngine && chopperEngine.getState().countInEnabled) { countPendingRef.current = true; chopperEngine.runCountIn(onDownbeat); }
    else onDownbeat();
  };

  const module = (title: string, body: ReactElement, extra?: ReactElement) => (
    <div className="bm">
      <div className="bm-title">{title}{extra}</div>
      <div className="bm-body">{body}</div>
    </div>
  );
  const osc = (i: 0 | 1 | 2) => {
    const o = p.osc[i];
    return module(`OSC ${i + 1}`, (
      <>
        <div className="bm-col">
          <button className={`bb bb-sq${o.on ? ' on' : ''}`} onClick={() => set(`osc.${i}.on`, !o.on)} title={`Oscillator ${i + 1} on/off`}>{o.on ? 'ON' : 'OFF'}</button>
          <div className="bm-waves" title="Waveform">
            {WAVES.map((w) => <button key={w.id} className={`bb bb-wave${o.wave === w.id ? ' on' : ''}`} title={w.t} onClick={() => set(`osc.${i}.wave`, w.id)}>{w.g}</button>)}
            <button className={`bb bb-wave bb-morph${o.wave === 'morph' ? ' on' : ''}`} title="SHAPE — a knob that morphs the waveform continuously: full left = triangle, through shark, saw, square, the pulses, full right = sine. Dial the in-between"
              onClick={() => set(`osc.${i}.wave`, o.wave === 'morph' ? 'saw' : 'morph')}>⌇</button>
          </div>
          <div className="bm-range" title="Range (octave): 32' is two octaves down">
            {RANGES.map((r) => <button key={r.v} className={`bb bb-range${o.octave === r.v ? ' on' : ''}`} onClick={() => set(`osc.${i}.octave`, r.v)}>{r.l}</button>)}
          </div>
        </div>
        {i > 0 && <BassKnob id={`bass.osc.${i}.semi`} label="SEMI" value={o.semi} min={-12} max={12} def={0} bipolar fmt={fSigned} onChange={(v) => set(`osc.${i}.semi`, Math.round(v))} title="Semitone offset from OSC 1" />}
        <BassKnob id={`bass.osc.${i}.fine`} label="FINE" value={o.fine} min={-50} max={50} def={0} bipolar fmt={(v) => `${fSigned(v)}¢`} onChange={(v) => set(`osc.${i}.fine`, v)} title="Fine tune (cents) — detune OSC 2/3 a few cents for width" />
        {o.wave === 'narrow' && <BassKnob id={`bass.osc.${i}.pw`} label="PW" value={o.pw} min={0.05} max={0.5} def={0.15} fmt={fPct} onChange={(v) => set(`osc.${i}.pw`, v)} title="Pulse width of the NARROW wave" />}
        {o.wave === 'morph' && (
          <div className="bm-morph">
            <BassKnob id={`bass.osc.${i}.morph`} label="SHAPE" value={o.morph ?? 0.33} min={0} max={1} def={0.33} fmt={morphLabel} onChange={(v) => set(`osc.${i}.morph`, v)} title="SHAPE — morph the waveform: TRI → SHARK → SAW → SQUARE → PULSE → NARROW → SINE. Modulate it from the MOD matrix for a moving timbre" />
            <MorphScope morph={o.morph ?? 0.33} pw={o.pw} />
          </div>
        )}
        <BassKnob id={`bass.osc.${i}.level`} label="LEVEL" value={o.level} min={0} max={1} def={0.8} fmt={fPct} onChange={(v) => set(`osc.${i}.level`, v)} size={42} title="Oscillator level into the mixer — push it to overdrive the mixer" />
      </>
    ));
  };

  const scaleId = state.key.scale;
  const lockOn = state.lock && scaleId !== 'chromatic';

  // The targets a MOD source drives, each with its own depth knob and ✕ —
  // this IS the matrix: one knob can take several sources (TRIG A on the
  // cutoff, TRIG B on the drive), each source several knobs.
  const modTargets = (src: ModSource) => {
    const list = p.mods.filter((m) => m.src === src);
    if (!list.length) return <div className="bm-modtargets bm-modtargets-empty">no targets — right-click a knob → ASSIGN TO MOD</div>;
    return (
      <div className="bm-modtargets">
        {list.map((m) => (
          <div key={m.target} className="bm-modtarget" title={`${m.target} ← ${src}`}>
            <BassKnob noMenu id={`bass.mod.${src}.${m.target}`} label={m.target.replace(/^(osc\.)(\d)\./, (_a, _b, n) => `O${+n + 1} `).replace(/^filter\./, '').replace(/^post\./, '').replace(/^filtEnv\./, 'CONT ').replace(/^ampEnv\./, 'LOUD ').replace(/^modSrc\.lfo\.(\d)\./, (_a, n) => `LFO${+n + 1} `).replace(/^modSrc\.trig\.(\d)\./, (_a, n) => `TRIG${n === '0' ? 'A' : 'B'} `).toUpperCase()}
              value={m.depth} min={-1} max={1} def={0.5} bipolar fmt={fBip} size={26}
              onChange={(v) => engine.setModDepth(src, m.target, v)} title={`Depth of ${src} on ${m.target} — negative inverts`} />
            <button className="bb bb-sq bm-modx" onClick={() => engine.removeMod(src, m.target)} title="Remove this assignment">✕</button>
          </div>
        ))}
      </div>
    );
  };
  const header = (
      <div className="bass-head">
        <button className={`bb bb-toggle${showSynth ? ' on' : ''}`} onClick={() => setShowSynth((v) => !v)} title="Show / hide the synth panel">SYNTH</button>
        <label className="bass-field" title="Patches — FACTORY ones ship with Terminator, USER ones are yours (SAVE). The name gets a * when you've turned a knob since.">
          <span>PATCH</span>
          {(() => {
            const cur = state.presetName ?? '';
            const known = BASS_FACTORY.some((f) => f.name === cur) || userPatches.some((u) => u.name === cur);
            return (
              <select value={known ? cur : '__custom'} onChange={(e) => {
                const v = e.target.value; if (v === '__custom') return;
                const u = userPatches.find((x) => x.name === v);
                if (u) engine.setPatch(u.patch, { name: u.name, replace: true }); else engine.loadFactory(v);
              }}>
                {!known && <option value="__custom">{cur || 'CUSTOM'}</option>}
                <optgroup label="FACTORY">
                  {BASS_FACTORY.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </optgroup>
                {userPatches.length > 0 && (
                  <optgroup label="USER">
                    {userPatches.map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}
                  </optgroup>
                )}
              </select>
            );
          })()}
        </label>
        <button className="bb" onClick={savePatch} title="Save the synth as a USER patch. Factory patches are never overwritten — you name a new one. Saving an edited USER patch asks Overwrite / New / Cancel; NEW proposes the same name with a letter on the end (1 → 1a → 1b…), or type any new name.">SAVE</button>
        {saveAsk !== null && (
          <span className="bass-save-ask" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
            <span style={{ fontSize: 10, opacity: 0.85 }}>"{saveAsk}":</span>
            <button className="bb" onClick={() => { patchStore.save(saveAsk, state.patch); engine.setPatch({}, { name: saveAsk }); setSaveAsk(null); }} title="Overwrite this USER patch with the current settings">OVERWRITE</button>
            <button className="bb" onClick={() => { const ask = saveAsk; setSaveAsk(null); saveAs(nextFreeName(ask)); }} title="Save as a NEW user patch — the proposed name adds a letter (1 → 1a); change it to anything you like">NEW</button>
            <button className="bb" onClick={() => setSaveAsk(null)} title="Keep editing, save nothing">CANCEL</button>
          </span>
        )}
        <button className="bb" onClick={deletePatch} disabled={!userPatches.some((u) => u.name === (state.presetName ?? '').replace(/\*$/, ''))} title="Delete the selected USER patch">DEL</button>
        <button className="bb" onClick={() => engine.setPatch(defaultBassPatch(), { name: 'MODEL D', replace: true })} title="Reset the synth to the MODEL D patch">INIT</button>
        <button className={`bb bb-learn${learnMode ? ' on' : ''}`} onClick={() => setLearnMode((v) => !v)}
          title="MIDI LEARN: every knob flashes — green = already mapped to a CC, white = free. Tap a knob, move a control on your hardware, done. Tap LEARN again to leave.">{learnMode ? '◉ LEARN' : '○ LEARN'}</button>
        <span className="bass-sep" />
        <label className="bass-field" title="Key root — with LOCK on, the roll and MIDI input only land on notes in this key">
          <span>KEY</span>
          <select value={state.key.root} onChange={(e) => engine.setKey(Number(e.target.value), scaleId)}>
            {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
          <select value={scaleId} onChange={(e) => engine.setKey(state.key.root, e.target.value as ScaleId)} title="Scale — CHROMATIC = every note">
            {SCALES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button className={`bb${lockOn ? ' on' : ''}`} disabled={scaleId === 'chromatic'} onClick={() => engine.setLock(!state.lock)}
          title="LOCK: notes you draw, drag, or play in over MIDI snap to the key — you can't record a wrong note. Off = chromatic.">🔒 LOCK</button>
        <button className="bb" onClick={() => engine.conformToKey()} disabled={!lockOn} title="Snap every note in this pattern to the key">CONFORM</button>
        <button className={`bb${fold ? ' on' : ''}`} onClick={() => setFold((v) => !v)} disabled={scaleId === 'chromatic'} title="FOLD: hide out-of-key rows in the roll">FOLD</button>
        <span className="bass-sep" />
        <button className={`bb bb-midi${state.midiIn ? ' on' : ''}`} onClick={() => { const on = !state.midiIn; engine.setMidiIn(on); onMidiInChange?.(on); }}
          title="MIDI IN: your controller (and the pad keys) play the bass instead of the pads. With REC + transport running, notes record into the pattern (scale-locked when LOCK is on).">MIDI IN</button>
        <div ref={meterRef} className="bass-meter" title="Output level · voices playing"><i /></div>
      </div>
  );
  const synthPanel = (
    <>
      {/* ── synth panel ── */}
      {showSynth && (
        <div className="bass-panel">
          {osc(0)}{osc(1)}{osc(2)}
          {module('MIXER', (
            <>
              <BassKnob id="bass.sub.level" label="SUB" value={p.sub.level} min={0} max={1} def={0.5} fmt={fPct} onChange={(v) => set('sub.level', v)} title="Sub oscillator (locked under OSC 1)" />
              <div className="bm-col">
                <button className={`bb bb-sq${p.sub.octave === 1 ? ' on' : ''}`} onClick={() => set('sub.octave', p.sub.octave === 1 ? 2 : 1)} title="Sub one or two octaves down">-{p.sub.octave}oct</button>
                <button className={`bb bb-sq${p.sub.wave === 'square' ? ' on' : ''}`} onClick={() => set('sub.wave', p.sub.wave === 'sine' ? 'square' : 'sine')} title="Sub waveform">{p.sub.wave === 'sine' ? '∿' : '⊓'}</button>
              </div>
              <BassKnob id="bass.noise.level" label="NOISE" value={p.noise.level} min={0} max={1} def={0} fmt={fPct} onChange={(v) => set('noise.level', v)} title="Noise into the filter — a touch adds breath and grit" />
              <div className="bm-col">
                <button className={`bb bb-sq${p.noise.color === 'pink' ? ' on' : ''}`} onClick={() => set('noise.color', p.noise.color === 'pink' ? 'white' : 'pink')} title="White or pink noise">{p.noise.color === 'pink' ? 'PINK' : 'WHITE'}</button>
              </div>
              <BassKnob id="bass.mixerDrive" label="DRIVE" value={p.mixerDrive} min={0} max={1} def={0.15} fmt={fPct} onChange={(v) => set('mixerDrive', v)} title="Mixer overdrive — the Model D trick: hit the filter hard for warmth" />
            </>
          ))}
          {module('FILTER', (
            <>
              <div className="bm-col">
                {(['ladder', 'ota', 'diode'] as FilterModel[]).map((m) => (
                  <button key={m} className={`bb bb-sq${p.filter.model === m ? ' on' : ''}`} onClick={() => set('filter.model', m)}
                    title={m === 'ladder' ? 'LADDER — Moog transistor ladder, 24 dB, saturating' : m === 'ota' ? 'OTA — SEM/Oberheim state-variable, smoother' : 'DIODE — 303/EMS diode ladder, squelchy'}>{m.toUpperCase()}</button>
                ))}
              </div>
              <div className="bm-col">
                {p.filter.model === 'ota'
                  ? (['lp', 'bp', 'hp'] as const).map((m) => <button key={m} className={`bb bb-sq${p.filter.mode === m ? ' on' : ''}`} onClick={() => set('filter.mode', m)} title="Filter mode">{m.toUpperCase()}</button>)
                  : p.filter.model === 'ladder'
                    ? [1, 2, 3, 4].map((n) => <button key={n} className={`bb bb-sq${p.filter.poles === n ? ' on' : ''}`} onClick={() => set('filter.poles', n)} title="Poles: 6 / 12 / 18 / 24 dB per octave">{n * 6}</button>)
                    : null}
                {p.filter.model === 'ota' && <button className={`bb bb-sq${p.filter.poles > 2 ? ' on' : ''}`} onClick={() => set('filter.poles', p.filter.poles > 2 ? 2 : 4)} title="12 or 24 dB/oct (two SVFs in series)">{p.filter.poles > 2 ? '24dB' : '12dB'}</button>}
              </div>
              <BassKnob id="bass.filter.cutoff" label="CUTOFF" value={p.filter.cutoff} min={20} max={16000} def={420} log fmt={fHz} onChange={(v) => set('filter.cutoff', v)} size={54} title="Cutoff frequency (Hz)" />
              <BassKnob id="bass.filter.reso" label="EMPHASIS" value={p.filter.reso} min={0} max={1} def={0.25} fmt={fPct} onChange={(v) => set('filter.reso', v)} size={44} title="Resonance — all the way up self-oscillates on LADDER / DIODE" />
              <BassKnob id="bass.filter.envAmt" label="CONTOUR" value={p.filter.envAmt} min={-1} max={1} def={0.45} bipolar fmt={fBip} onChange={(v) => set('filter.envAmt', v)} title="How much the CONTOUR envelope opens the filter (negative = closes)" />
              <BassKnob id="bass.filter.kbd" label="KBD" value={p.filter.kbd} min={0} max={1} def={0.3} fmt={fPct} onChange={(v) => set('filter.kbd', v)} title="Keyboard tracking — higher notes open the filter" />
              <BassKnob id="bass.filter.drive" label="DRIVE" value={p.filter.drive} min={0} max={1} def={0.2} fmt={fPct} onChange={(v) => set('filter.drive', v)} title="Filter input drive — saturates the ladder stages" />
            </>
          ))}
          {module('CONTOUR', (
            <>
              <BassKnob id="bass.filtEnv.a" label="ATT" value={p.filtEnv.a} min={0.001} max={2} def={0.003} log fmt={fMs} onChange={(v) => set('filtEnv.a', v)} title="Filter envelope attack" />
              <BassKnob id="bass.filtEnv.d" label="DEC" value={p.filtEnv.d} min={0.005} max={4} def={0.28} log fmt={fMs} onChange={(v) => set('filtEnv.d', v)} title="Filter envelope decay" />
              <BassKnob id="bass.filtEnv.s" label="SUS" value={p.filtEnv.s} min={0} max={1} def={0.15} fmt={fPct} onChange={(v) => set('filtEnv.s', v)} title="Filter envelope sustain" />
              <BassKnob id="bass.filtEnv.r" label="REL" value={p.filtEnv.r} min={0.005} max={4} def={0.2} log fmt={fMs} onChange={(v) => set('filtEnv.r', v)} title="Filter envelope release" />
            </>
          ), <span className="bm-sub">filter env</span>)}
          {module('LOUDNESS', (
            <>
              <BassKnob id="bass.ampEnv.a" label="ATT" value={p.ampEnv.a} min={0.001} max={2} def={0.004} log fmt={fMs} onChange={(v) => set('ampEnv.a', v)} title="Amp attack" />
              <BassKnob id="bass.ampEnv.d" label="DEC" value={p.ampEnv.d} min={0.005} max={4} def={0.3} log fmt={fMs} onChange={(v) => set('ampEnv.d', v)} title="Amp decay" />
              <BassKnob id="bass.ampEnv.s" label="SUS" value={p.ampEnv.s} min={0} max={1} def={0.85} fmt={fPct} onChange={(v) => set('ampEnv.s', v)} title="Amp sustain" />
              <BassKnob id="bass.ampEnv.r" label="REL" value={p.ampEnv.r} min={0.005} max={4} def={0.12} log fmt={fMs} onChange={(v) => set('ampEnv.r', v)} title="Amp release" />
            </>
          ), <span className="bm-sub">amp env</span>)}
          {module('PLAY', (
            <>
              <BassKnob id="bass.glide" label="GLIDE" value={p.glide} min={0} max={1} def={0.04} fmt={fMs} onChange={(v) => set('glide', v)} title="Portamento time between notes (mono)" />
              <BassKnob id="bass.drift" label="DRIFT" value={p.drift} min={0} max={1} def={0.35} fmt={fPct} onChange={(v) => set('drift', v)} title="Analog oscillator drift + per-voice offsets" />
              <div className="bm-col">
                <button className={`bb bb-sq${p.legato ? ' on' : ''}`} onClick={() => set('legato', !p.legato)} title="LEGATO: overlapping notes don't retrigger the envelopes (mono)">LEGATO</button>
                <button className={`bb bb-sq${p.voices > 1 ? ' on' : ''}`} onClick={() => set('voices', p.voices > 1 ? 1 : 6)} title="MONO (last-note priority, glide) or POLY (6 voices)">{p.voices > 1 ? 'POLY' : 'MONO'}</button>
              </div>
            </>
          ))}
          {module('OUT', (
            <>
              <BassKnob id="bass.velAmp" label="VEL→AMP" value={p.velAmp} min={0} max={1} def={0.5} fmt={fPct} onChange={(v) => set('velAmp', v)} title="Velocity to loudness" />
              <BassKnob id="bass.velFilt" label="VEL→FLT" value={p.velFilt} min={0} max={1} def={0.4} fmt={fPct} onChange={(v) => set('velFilt', v)} title="Velocity to filter contour" />
              <BassKnob id="bass.post.drive" label="DRIVE" value={p.post.drive} min={0} max={1} def={0.15} fmt={fPct} onChange={(v) => set('post.drive', v)} title="Output saturation (tape-ish)" />
              <BassKnob id="bass.post.tone" label="TONE" value={p.post.tone} min={400} max={20000} def={20000} log fmt={fHz} onChange={(v) => set('post.tone', v)} title="Tone: darkens the top after the drive" />
              <BassKnob id="bass.post.glue" label="GLUE" value={p.post.glue} min={0} max={1} def={0.2} fmt={fPct} onChange={(v) => set('post.glue', v)} title="One-knob compressor — evens the notes out" />
              <BassKnob id="bass.post.gain" label="VOL" value={p.post.gain} min={0} max={1.5} def={0.8} fmt={fPct} onChange={(v) => set('post.gain', v)} size={44} title="Bass output level (before its mixer strip)" />
            </>
          ))}
        </div>
      )}

          {module('MOD', (
            <div className="bm-mod">
              {([0, 1, 2] as const).map((i) => {
                const l = p.modSrc.lfo[i];
                const src = (`lfo${i + 1}`) as ModSource;
                return (
                  <div key={src} className="bm-modsrc">
                    <div className="bm-modsrc-head">LFO {i + 1}</div>
                    <div className="bm-modsrc-body">
                      <BassKnob id={`bass.modSrc.lfo.${i}.rate`} label="RATE" value={l.rate} min={0.05} max={30} def={[4.5, 0.5, 8][i]} log fmt={(v) => `${v.toFixed(v < 1 ? 2 : 1)}Hz`} onChange={(v) => set(`modSrc.lfo.${i}.rate`, v)} size={32} title={`LFO ${i + 1} rate`} />
                      <div className="bm-col">
                        <div className="bm-waves">
                          {(['tri', 'sine', 'square', 'saw', 'ramp', 'sh'] as LfoWave[]).map((w) => <button key={w} className={`bb bb-wave${l.wave === w ? ' on' : ''}`} onClick={() => set(`modSrc.lfo.${i}.wave`, w)} title={`LFO ${i + 1} shape`}>{w === 'tri' ? '△' : w === 'sine' ? '∿' : w === 'square' ? '⊓' : w === 'saw' ? '◿' : w === 'ramp' ? '◺' : 'S&H'}</button>)}
                        </div>
                        <button className={`bb bb-sq${l.key ? ' on' : ''}`} onClick={() => set(`modSrc.lfo.${i}.key`, !l.key)} title="KEY: restart the LFO on every note">KEY</button>
                      </div>
                      {modTargets(src)}
                    </div>
                  </div>
                );
              })}
              {([0, 1] as const).map((i) => {
                const tg = p.modSrc.trig[i];
                const src = (i === 0 ? 'trigA' : 'trigB') as ModSource;
                return (
                  <div key={src} className="bm-modsrc">
                    <div className="bm-modsrc-head">TRIG {i === 0 ? 'A' : 'B'} <span className="bm-sub">fires on every note</span></div>
                    <div className="bm-modsrc-body">
                      <BassKnob id={`bass.modSrc.trig.${i}.ramp`} label="RAMP" value={tg.ramp} min={0.001} max={2} def={i === 0 ? 0.005 : 0.12} log fmt={fMs} onChange={(v) => set(`modSrc.trig.${i}.ramp`, v)} size={32} title="Time to rise to full after the note hits" />
                      <BassKnob id={`bass.modSrc.trig.${i}.fall`} label="FALL" value={tg.fall} min={0.005} max={4} def={i === 0 ? 0.35 : 0.6} log fmt={fMs} onChange={(v) => set(`modSrc.trig.${i}.fall`, v)} size={32} title="Time to fall back to where the knob was" />
                      <button className={`bb bb-sq${tg.shape === 'lin' ? ' on' : ''}`} onClick={() => set(`modSrc.trig.${i}.shape`, tg.shape === 'lin' ? 'exp' : 'lin')} title="Fall curve: EXP (analog, fast at first) or LIN">{tg.shape === 'lin' ? 'LIN' : 'EXP'}</button>
                      {modTargets(src)}
                    </div>
                  </div>
                );
              })}
            </div>
          ), <span className="bm-sub">right-click a knob → ASSIGN TO MOD</span>)}
    </>
  );
  return (
    <KnobEnv.Provider value={knobEnv}>
    <div ref={wrapRef} className={`bass-section${compact ? ' compact' : ''}`} data-lock={lockOn ? '1' : '0'}>
      {/* ── header: preset · key · lock · midi in · meter ── (compact: below the roll) */}
      {!compact && header}
      {!compact && synthPanel}
      {/* ── roll toolbar ── */}
      <div className="bass-roll-bar">
        <button className={`bb bb-play${playing ? ' on' : ''}`} onClick={() => (playing ? onTransportStop?.() : onTransportPlay?.())} title="Play / stop the whole transport (chops + drums + bass)">{playing ? '■' : '▶'}</button>
        <button className={`bb bb-rec${state.recording || countInBeat >= 0 ? ' on' : ''}`} onClick={toggleRec}
          title={countInBeat >= 0
            ? 'Counting in… click to cancel'
            : state.recording
              ? 'Recording — click to stop recording; the transport keeps playing'
              : 'REC: like the sequencer — stopped, it counts in a bar then rolls and records; already playing, it records from here. Notes you play (MIDI or the pad keys) land in the pattern, quantised to the grid — and locked to the key if LOCK is on'}>● {countInBeat >= 0 ? countInBeat : 'REC'}</button>
        <span className="bass-sep" />
        <SeqPager index={state.currentIdx} count={state.patterns.length} max={BASS_MAX_PATTERNS}
          onSelect={(i) => engine.setCurrent(i)}
          onAdd={() => engine.addPattern(false)}
          onDuplicate={() => engine.addPattern(true)}
          onDelete={() => { if (state.patterns.length > 1) engine.deletePattern(state.currentIdx); else engine.clearPattern(); }}
          lastDeleteHint="Clear this pattern (the last one can’t be deleted)"
          compact={compact} />
        <span className="bass-sep" />
        <label className="bass-field" title="Pattern length in bars">
          <span>BARS</span>
          <select value={pat.bars} onChange={(e) => engine.setBars(Number(e.target.value))}>{[1, 2, 4, 8].map((b) => <option key={b} value={b}>{b}</option>)}</select>
        </label>
        <div className="bass-grids" title="Grid — where notes snap (also the live-record quantise). OFF = no snap at all: notes land exactly where you click, drag or play them">
          {GRIDS.map((g) => <button key={g.v} className={`bb bb-sq${state.grid === g.v ? ' on' : ''}`} onClick={() => engine.setGrid(g.v)} title={g.v === 0 ? 'Grid OFF — nothing snaps: draw, move and record free of the grid' : undefined}>{g.l}</button>)}
        </div>
        <span className="bass-sep" />
        <div className="bass-tools" title="Tool: DRAW places/moves notes · SLIDE draws slide notes (◢ — they bend whatever is playing to their pitch over their length, like FL Studio) · ERASE removes what you tap or drag over · VEL drags a note's velocity up/down">
          {(['draw', 'slide', 'erase', 'vel'] as RollTool[]).map((t) => <button key={t} className={`bb bb-sq${tool === t ? ' on' : ''}`} onClick={() => setTool(t)}
            title={t === 'slide' ? 'SLIDE — draw slide notes: nothing triggers, what is sounding bends to the slide note\'s pitch over its length and stays there (FL-style). S toggles slide on selected notes.' : undefined}>{t === 'draw' ? '✎ DRAW' : t === 'slide' ? '◢ SLIDE' : t === 'erase' ? '⌫ ERASE' : '↕ VEL'}</button>)}
        </div>
        <span className="bass-sep" />
        <button className={`bb bb-sq${bendLane ? ' on' : ''}`} onClick={() => setBendLane((v) => !v)}
          title="BEND — show the PITCH BEND automation lane under the roll. Draw a bend curve (semitones), or record your keyboard's pitch wheel into it with ● REC. Plays live and prints into exports.">∿ BEND</button>
        {bendLane && (
          <>
            {[2, 12].map((r) => <button key={r} className={`bb bb-sq${(state.bendRange ?? 2) === r ? ' on' : ''}`} onClick={() => engine.setBendRange(r)} title={`Bend lane range ±${r} semitones (the wheel and the lane share it)`}>±{r}</button>)}
            <button className="bb bb-sq" onClick={() => engine.clearBend()} title="Clear the bend lane of this pattern">✕ BEND</button>
          </>
        )}
        <button className="bb bb-sq" onClick={() => engine.transpose(12)} title="Whole pattern up an octave">+8va</button>
        <button className="bb bb-sq" onClick={() => engine.transpose(-12)} title="Whole pattern down an octave">-8va</button>
        <button className="bb bb-sq" onClick={() => engine.clearPattern()} title="Clear every note in this pattern">CLEAR</button>
        <span className="bass-hint">click · drag = draw · edge = length · right-click = erase · ⌘-drag empty = select · ⌥-drag selected = duplicate · double-click = delete · ⌘-drag note = velocity · ↑↓ = transpose in key</span>
      </div>
      <PianoRoll engine={engine} state={state} fold={fold && lockOn} accent={accent} tool={tool} compact={compact} height={compact ? 270 : 234} bendLane={bendLane} />
      {compact && header}
      {compact && synthPanel}
      {menu && (
        <KnobMenu info={menu} mods={engine.modsFor(menu.path)}
          onAssign={(src) => engine.addMod(src, menu.path, menu.path === 'filter.cutoff' ? 0.4 : 0.5)}
          onUnassign={(src) => engine.removeMod(src, menu.path)}
          onClose={() => setMenu(null)} />
      )}
    </div>
    </KnobEnv.Provider>
  );
}
