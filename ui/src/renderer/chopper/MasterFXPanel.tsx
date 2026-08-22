import { useRef, useState } from 'react';
import { ChopperState, CompressorStyle } from './ChopperEngine';
import { useFaderTooltip } from './useFaderTooltip';
import { useMidiLearn } from './midiLearn';

interface Props {
  state: ChopperState;
  onMasterVolume: (v: number) => void;
  onMasterPitch: (semitones: number) => void;
  onFilterFreq: (hz: number) => void;
  onFilterEnabled: (b: boolean) => void;
  onEQ: (band: 'low' | 'mid' | 'high', gainDB: number) => void;
  onCompStyle: (style: CompressorStyle) => void;
  onCompMix: (mix: number) => void;
  onDelayMix: (v: number) => void;
  onDelayTime: (s: number) => void;
  onDelayFeedback: (v: number) => void;
  onReverbMix: (v: number) => void;
  onReverbDecay: (s: number) => void;
  onAttack: (s: number) => void;
  onRelease: (s: number) => void;
}

const isWeb = (import.meta as any).env?.MODE === 'web';
const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const FREQ_STEPS = 1000;
const freqToFader = (hz: number) => Math.round(Math.log(Math.max(FREQ_MIN, hz) / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN) * FREQ_STEPS);
const faderToFreq = (t: number) => FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t / FREQ_STEPS);

export function MasterFXPanel(props: Props) {
  return isWeb ? <MasterFXPanelWeb {...props} /> : <MasterFXPanelDesktop {...props} />;
}

// Web build: collapsible header, no mix knobs, delay/reverb get a toggle
// dot that flips mix between 0 and 1. Comp style change sets compMix too.
function MasterFXPanelWeb(props: Props) {
  const m = props.state.master;
  const [expanded, setExpanded] = useState(true);
  const delayOn = m.delayMix > 0.01;
  const reverbOn = m.reverbMix > 0.01;
  const compOn = m.compStyle !== 'off';
  const activeCount = [m.filterEnabled, compOn, delayOn, reverbOn].filter(Boolean).length;

  return (
    <div className={`master-fx${expanded ? '' : ' collapsed'}`}>
      <button
        type="button"
        className="master-fx-title fx-panel-header"
        onClick={() => setExpanded(e => !e)}
        title={expanded ? 'Collapse' : 'Expand'}
      >
        <span>{expanded ? '▾' : '▸'} MASTER FX</span>
        {activeCount > 0 && <span className="fx-panel-active">{activeCount} on</span>}
      </button>

      {expanded && (<>
        <div className="fx-row">
          <FXKnob label="VOLUME" value={Math.round(m.volume * 100)} unit="%"
            min={0} max={100} step={1} ccId="master.volume"
            onChange={v => props.onMasterVolume(v / 100)}
            onReset={() => props.onMasterVolume(0.85)} />
          <FXKnob label="PITCH/TEMPO" value={m.pitch} unit=" st"
            min={-24} max={24} step={0.5} ccId="master.pitch"
            onChange={v => props.onMasterPitch(v)}
            onReset={() => props.onMasterPitch(0)} />
          <FXKnob label="ATTACK" value={Math.round(m.attack * 1000)} unit=" ms"
            min={0} max={50} step={1} ccId="master.attack"
            onChange={v => props.onAttack(v / 1000)}
            onReset={() => props.onAttack(0)} />
          <FXKnob label="RELEASE" value={Math.round(m.release * 1000)} unit=" ms"
            min={0} max={500} step={5} ccId="master.release"
            onChange={v => props.onRelease(v / 1000)}
            onReset={() => props.onRelease(0)} />
        </div>

        <div className="fx-section">
          <div className="fx-section-title">
            <button
              className={`fx-toggle ${m.filterEnabled ? 'on' : ''}`}
              onClick={() => props.onFilterEnabled(!m.filterEnabled)}
            >●</button>
            FILTER
          </div>
          <FXSlider label="CUTOFF" value={freqToFader(m.filterFreq)}
            display={m.filterFreq >= 1000 ? `${(m.filterFreq / 1000).toFixed(1)}k Hz` : `${Math.round(m.filterFreq)} Hz`}
            min={0} max={FREQ_STEPS} step={1} ccId="master.cutoff"
            onChange={v => props.onFilterFreq(Math.round(faderToFreq(v)))}
            onReset={() => props.onFilterFreq(20000)}
            wide />
        </div>

        <div className="fx-section">
          <div className="fx-section-title">EQ</div>
          <div className="fx-row">
            <FXKnob label="LOW"  value={m.eqLow}  unit=" dB" min={-24} max={24} step={0.5} ccId="master.eqLow"
              onChange={v => props.onEQ('low', v)} onReset={() => props.onEQ('low', 0)} />
            <FXKnob label="MID"  value={m.eqMid}  unit=" dB" min={-24} max={24} step={0.5} ccId="master.eqMid"
              onChange={v => props.onEQ('mid', v)} onReset={() => props.onEQ('mid', 0)} />
            <FXKnob label="HIGH" value={m.eqHigh} unit=" dB" min={-24} max={24} step={0.5} ccId="master.eqHigh"
              onChange={v => props.onEQ('high', v)} onReset={() => props.onEQ('high', 0)} />
          </div>
        </div>

        <div className="fx-section">
          <div className="fx-section-title">COMPRESSOR</div>
          <div className="fx-row">
            <label className="fx-select-group">
              <span className="fx-label">STYLE</span>
              <select
                className="fx-select"
                value={m.compStyle}
                onChange={e => {
                  const s = e.target.value as CompressorStyle;
                  props.onCompStyle(s);
                  // 'off' mutes mix; any real style implies 100% wet.
                  props.onCompMix(s === 'off' ? 0 : 1);
                }}
              >
                <option value="off">OFF</option>
                <option value="light">LIGHT</option>
                <option value="punchy">PUNCHY</option>
                <option value="ny">NY (PARALLEL)</option>
                <option value="aggressive">AGGRESSIVE</option>
              </select>
            </label>
          </div>
        </div>

        <div className="fx-section">
          <div className="fx-section-title">
            <button
              className={`fx-toggle ${delayOn ? 'on' : ''}`}
              onClick={() => props.onDelayMix(delayOn ? 0 : 1)}
            >●</button>
            DELAY
          </div>
          <div className="fx-row">
            <FXKnob label="TIME" value={Number(m.delayTime.toFixed(3))} unit="s" min={0.01} max={2} step={0.01} ccId="master.delayTime"
              onChange={v => props.onDelayTime(v)} onReset={() => props.onDelayTime(0.25)} />
            <FXKnob label="FBK" value={Math.round(m.delayFeedback * 100)} unit="%"
              min={0} max={95} step={1} ccId="master.delayFeedback"
              onChange={v => props.onDelayFeedback(v / 100)}
              onReset={() => props.onDelayFeedback(0.3)} />
          </div>
        </div>

        <div className="fx-section">
          <div className="fx-section-title">
            <button
              className={`fx-toggle ${reverbOn ? 'on' : ''}`}
              onClick={() => props.onReverbMix(reverbOn ? 0 : 1)}
            >●</button>
            REVERB
          </div>
          <div className="fx-row">
            <FXKnob label="DECAY" value={Number(m.reverbDecay.toFixed(2))} unit="s" min={0.1} max={6} step={0.1} ccId="master.reverbDecay"
              onChange={v => props.onReverbDecay(v)} onReset={() => props.onReverbDecay(2)} />
          </div>
        </div>
      </>)}
    </div>
  );
}

// Original desktop layout — always expanded, mix knobs visible. Unchanged
// from the version before the web-targeted UI changes.
function MasterFXPanelDesktop(props: Props) {
  const m = props.state.master;

  return (
    <div className="master-fx">
      <div className="master-fx-title">MASTER FX</div>

      <div className="fx-row">
        <FXKnob label="VOLUME" value={Math.round(m.volume * 100)} unit="%"
          min={0} max={100} step={1}
          onChange={v => props.onMasterVolume(v / 100)}
          onReset={() => props.onMasterVolume(0.85)} />
        <FXKnob label="PITCH/TEMPO" value={m.pitch} unit=" st"
          min={-24} max={24} step={0.5}
          onChange={v => props.onMasterPitch(v)}
          onReset={() => props.onMasterPitch(0)} />
        <FXKnob label="ATTACK" value={Math.round(m.attack * 1000)} unit=" ms"
          min={0} max={50} step={1}
          onChange={v => props.onAttack(v / 1000)}
          onReset={() => props.onAttack(0)} />
        <FXKnob label="RELEASE" value={Math.round(m.release * 1000)} unit=" ms"
          min={0} max={500} step={5}
          onChange={v => props.onRelease(v / 1000)}
          onReset={() => props.onRelease(0)} />
      </div>

      <div className="fx-section">
        <div className="fx-section-title">
          <button
            className={`fx-toggle ${m.filterEnabled ? 'on' : ''}`}
            onClick={() => props.onFilterEnabled(!m.filterEnabled)}
          >●</button>
          FILTER
        </div>
        <FXSlider label="CUTOFF" value={freqToFader(m.filterFreq)}
          display={m.filterFreq >= 1000 ? `${(m.filterFreq / 1000).toFixed(1)}k Hz` : `${Math.round(m.filterFreq)} Hz`}
          min={0} max={FREQ_STEPS} step={1}
          onChange={v => props.onFilterFreq(Math.round(faderToFreq(v)))}
          onReset={() => props.onFilterFreq(20000)}
          wide />
      </div>

      <div className="fx-section">
        <div className="fx-section-title">EQ</div>
        <div className="fx-row">
          <FXKnob label="LOW"  value={m.eqLow}  unit=" dB" min={-24} max={24} step={0.5}
            onChange={v => props.onEQ('low', v)} onReset={() => props.onEQ('low', 0)} />
          <FXKnob label="MID"  value={m.eqMid}  unit=" dB" min={-24} max={24} step={0.5}
            onChange={v => props.onEQ('mid', v)} onReset={() => props.onEQ('mid', 0)} />
          <FXKnob label="HIGH" value={m.eqHigh} unit=" dB" min={-24} max={24} step={0.5}
            onChange={v => props.onEQ('high', v)} onReset={() => props.onEQ('high', 0)} />
        </div>
      </div>

      <div className="fx-section">
        <div className="fx-section-title">COMPRESSOR</div>
        <div className="fx-row">
          <label className="fx-select-group">
            <span className="fx-label">STYLE</span>
            <select className="fx-select" value={m.compStyle} onChange={e => props.onCompStyle(e.target.value as CompressorStyle)}>
              <option value="off">OFF</option>
              <option value="light">LIGHT</option>
              <option value="punchy">PUNCHY</option>
              <option value="ny">NY (PARALLEL)</option>
              <option value="aggressive">AGGRESSIVE</option>
            </select>
          </label>
          <FXKnob label="MIX" value={Math.round(m.compMix * 100)} unit="%" ccId="master.compMix"
            min={0} max={100} step={1}
            onChange={v => props.onCompMix(v / 100)}
            onReset={() => props.onCompMix(m.compStyle === 'ny' ? 0.5 : 1)} />
        </div>
      </div>

      <div className="fx-section">
        <div className="fx-section-title">DELAY</div>
        <div className="fx-row">
          <FXKnob label="TIME" value={Number(m.delayTime.toFixed(3))} unit="s" min={0.01} max={2} step={0.01}
            onChange={v => props.onDelayTime(v)} onReset={() => props.onDelayTime(0.25)} />
          <FXKnob label="FBK" value={Math.round(m.delayFeedback * 100)} unit="%"
            min={0} max={95} step={1}
            onChange={v => props.onDelayFeedback(v / 100)}
            onReset={() => props.onDelayFeedback(0.3)} />
          <FXKnob label="MIX" value={Math.round(m.delayMix * 100)} unit="%" ccId="master.delayMix"
            min={0} max={100} step={1}
            onChange={v => props.onDelayMix(v / 100)}
            onReset={() => props.onDelayMix(0)} />
        </div>
      </div>

      <div className="fx-section">
        <div className="fx-section-title">REVERB</div>
        <div className="fx-row">
          <FXKnob label="DECAY" value={Number(m.reverbDecay.toFixed(2))} unit="s" min={0.1} max={6} step={0.1}
            onChange={v => props.onReverbDecay(v)} onReset={() => props.onReverbDecay(2)} />
          <FXKnob label="MIX" value={Math.round(m.reverbMix * 100)} unit="%" ccId="master.reverbMix"
            min={0} max={100} step={1}
            onChange={v => props.onReverbMix(v / 100)}
            onReset={() => props.onReverbMix(0)} />
        </div>
      </div>
    </div>
  );
}

// Pixels of horizontal drag needed to sweep a knob's full range. Higher =
// less sensitive / finer control. The native <input> would map the slider's
// own width (~60px) to the full range, which felt twitchy — a relative drag
// over a fixed sweep gives consistent, calmer control on every knob.
const KNOB_SWEEP_PX = 260;

export function FXKnob({ label, value, unit = '', min, max, step, onChange, onReset, ccId, title }: {
  label: string; value: number; unit?: string; min: number; max: number; step: number;
  onChange: (v: number) => void; onReset: () => void; ccId?: string;
  /** What the knob DOES — prepended to the generic drag/reset/learn hint. */
  title?: string;
}) {
  const tip = useFaderTooltip(value, min, max);
  const display = `${Number.isInteger(value) ? value : value.toFixed(2)}${unit}`;
  // MIDI learn: map normalized 0..1 from a CC into this param's range.
  const learn = useMidiLearn(ccId ?? `__noid_${label}`, (t) => {
    const v = min + t * (max - min);
    onChange(step >= 1 ? Math.round(v) : v);
  });
  // Relative-drag: record start x + value on pointerdown, then move the value
  // by (Δpx / sweep) * range. Quantize to step. Pointer-capture keeps the drag
  // alive even when the finger/cursor leaves the small slider footprint.
  const drag = useRef<{ x: number; v: number } | null>(null);
  const onDragDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, v: value };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* */ }
    tip.onPointerDown();
    e.preventDefault();
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const range = max - min;
    let v = d.v + ((e.clientX - d.x) / KNOB_SWEEP_PX) * range;
    v = Math.min(max, Math.max(min, v));
    const snapped = Math.round(v / step) * step;
    onChange(Number(snapped.toFixed(6)));
  };
  const onDragEnd = () => { drag.current = null; };
  return (
    <label
      className={`fx-knob ${learn.learning ? 'fx-knob-learning' : ''} ${learn.cc !== null ? 'fx-knob-mapped' : ''}`}
      onDoubleClick={onReset}
      onContextMenu={ccId ? (e) => { e.preventDefault(); learn.learning ? learn.clear() : learn.startLearn(); } : undefined}
      title={`${title ? title + '\n' : ''}${ccId ? `Drag to adjust • Double-click to reset • Right-click to MIDI-learn${learn.cc !== null ? ` (CC ${learn.cc})` : ''}` : 'Drag to adjust • Double-click to reset'}`}
    >
      <span className="fx-label">{label}{learn.cc !== null && <span className="fx-cc-badge">CC{learn.cc}</span>}{learn.learning && <span className="fx-cc-learning">…</span>}</span>
      <span className="fx-slider-wrap">
        <input type="range" className="fx-slider" min={min} max={max} step={step}
          value={value} readOnly tabIndex={-1} />
        <span
          className="fx-fader-capture"
          onPointerDown={onDragDown}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        />
        {tip.active && (
          <span className="fx-fader-tooltip" style={{ left: `${tip.pct}%` }}>
            {display}
          </span>
        )}
      </span>
      <span className="fx-value">{display}</span>
    </label>
  );
}

function FXSlider({ label, value, display, min, max, step, onChange, onReset, wide, ccId }: {
  label: string; value: number; display: string; min: number; max: number; step: number;
  onChange: (v: number) => void; onReset: () => void; wide?: boolean; ccId?: string;
}) {
  const tip = useFaderTooltip(value, min, max);
  const learn = useMidiLearn(ccId ?? `__noid_${label}`, (t) => {
    const v = min + t * (max - min);
    onChange(step >= 1 ? Math.round(v) : v);
  });
  return (
    <label
      className={`fx-knob ${wide ? 'fx-knob-wide' : ''} ${learn.learning ? 'fx-knob-learning' : ''} ${learn.cc !== null ? 'fx-knob-mapped' : ''}`}
      onDoubleClick={onReset}
      onContextMenu={ccId ? (e) => { e.preventDefault(); learn.learning ? learn.clear() : learn.startLearn(); } : undefined}
      title={ccId ? `Double-click to reset • Right-click to MIDI-learn${learn.cc !== null ? ` (CC ${learn.cc})` : ''}` : 'Double-click to reset'}
    >
      <span className="fx-label">{label}{learn.cc !== null && <span className="fx-cc-badge">CC{learn.cc}</span>}{learn.learning && <span className="fx-cc-learning">…</span>}</span>
      <span className={`fx-slider-wrap ${wide ? 'fx-slider-wrap-wide' : ''}`}>
        <input type="range" className={`fx-slider ${wide ? 'fx-slider-wide' : ''}`}
          min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          onPointerDown={tip.onPointerDown} />
        {tip.active && (
          <span className="fx-fader-tooltip" style={{ left: `${tip.pct}%` }}>
            {display}
          </span>
        )}
      </span>
      <span className="fx-value">{display}</span>
    </label>
  );
}
