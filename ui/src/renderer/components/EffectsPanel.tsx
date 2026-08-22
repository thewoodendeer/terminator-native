import React, { useState, useRef } from 'react';
import { TrackEffectsState, EffectKey } from '../audio/Track';
import type { FilterType } from '../audio/effects/Filter';

// ─── Knob ─────────────────────────────────────────────────────────────────────

interface KnobProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  defaultValue?: number;
  onChange: (v: number) => void;
}

function Knob({ label, value, min = 0, max = 1, step = 0.01, unit = '%', defaultValue, onChange }: KnobProps) {
  const pct = ((value - min) / (max - min)) * 100;
  const display = unit === '%' ? `${pct.toFixed(0)}%` : `${value % 1 === 0 ? value : value.toFixed(2)}${unit}`;
  return (
    <label className="knob-group" onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)} title="Double-click to reset">
      <span className="knob-label">{label}</span>
      <input
        type="range"
        className="knob-slider"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
      <span className="knob-value">{display}</span>
    </label>
  );
}

function DBKnob({ label, value, defaultValue = 0, onChange }: { label: string; value: number; defaultValue?: number; onChange: (v: number) => void }) {
  return (
    <label className="knob-group" onDoubleClick={() => onChange(defaultValue)} title="Double-click to reset">
      <span className="knob-label">{label}</span>
      <input type="range" className="knob-slider" min={-24} max={24} step={0.5} value={value}
        onChange={e => onChange(Number(e.target.value))} />
      <span className="knob-value">{value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1)}dB</span>
    </label>
  );
}

// Log-mapped frequency slider: equal visual travel per octave so lows get
// as much space as highs. Backed by a 0..STEPS linear range under the hood.
const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const FREQ_STEPS = 1000;
const freqToFader = (hz: number) =>
  Math.round(Math.log(Math.max(FREQ_MIN, hz) / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN) * FREQ_STEPS);
const faderToFreq = (t: number) =>
  FREQ_MIN * Math.pow(FREQ_MAX / FREQ_MIN, t / FREQ_STEPS);

function FreqKnob({ label, value, defaultValue, onChange }: { label: string; value: number; defaultValue: number; onChange: (v: number) => void }) {
  const display = value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`;
  return (
    <label className="knob-group knob-group-wide" onDoubleClick={() => onChange(defaultValue)} title="Double-click to reset">
      <span className="knob-label">{label}</span>
      <input type="range" className="knob-slider knob-slider-wide" min={0} max={FREQ_STEPS} step={1} value={freqToFader(value)}
        onChange={e => onChange(Math.round(faderToFreq(Number(e.target.value))))} />
      <span className="knob-value">{display}Hz</span>
    </label>
  );
}

// ─── EffectRow ────────────────────────────────────────────────────────────────

interface EffectRowProps {
  effectKey: EffectKey;
  label: string;
  bypassed: boolean;
  isDragOver: boolean;
  onToggle: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  children: React.ReactNode;
}

function EffectRow({ effectKey: _key, label, bypassed, isDragOver, onToggle, onDragStart, onDragOver, onDrop, onDragEnd, children }: EffectRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`effect-row ${bypassed ? 'effect-bypassed' : ''} ${isDragOver ? 'effect-drag-over' : ''}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className="effect-header">
        <span className="effect-drag-handle" draggable onDragStart={onDragStart} title="Drag to reorder">⠿</span>
        <button
          className={`btn-power ${bypassed ? '' : 'on'}`}
          onClick={onToggle}
          title={bypassed ? 'Enable effect' : 'Disable effect'}
        >●</button>
        <span className="effect-name" onClick={() => setOpen(o => !o)}>{label}</span>
        <button className="btn-expand" onClick={() => setOpen(o => !o)}>{open ? '▲' : '▼'}</button>
      </div>
      {open && <div className="effect-controls">{children}</div>}
    </div>
  );
}

// ─── EffectsPanel ─────────────────────────────────────────────────────────────

const SYNC_DIVS = ['1/2', '1/4', '1/8', '1/16', '1/32', '1/64', '1/128'] as const;

interface Props {
  effects: TrackEffectsState;
  onMasterBypass: () => void;
  onCollapse:     () => void;
  onBypass: (fx: EffectKey) => void;
  onReorder: (order: EffectKey[]) => void;
  onFilter:      (key: 'type' | 'freq' | 'q' | 'mix', v: FilterType | number) => void;
  onEQ:          (key: 'lowGain' | 'midGain' | 'highGain', v: number) => void;
  onClipper:     (key: 'amount' | 'drive' | 'mix', v: number) => void;
  onWaveshaper:  (key: 'drive' | 'mix', v: number) => void;
  onSaturator:   (key: 'drive' | 'mix' | 'lowFreq' | 'highFreq', v: number) => void;
  onCompressor:  (key: 'drive' | 'ratio' | 'attack' | 'release' | 'makeup', v: number) => void;
  onWidener:     (key: 'width' | 'mix', v: number) => void;
  onMSEQ:        (key: 'midFreq' | 'midGain' | 'sideFreq' | 'sideGain' | 'mix', v: number) => void;
  onChorus:      (key: 'rate' | 'depth' | 'mix', v: number) => void;
  onDelay:       (key: 'timeL' | 'timeR' | 'feedback' | 'mix' | 'pingPong', v: number | boolean) => void;
  onReverb:      (key: 'mix' | 'decay' | 'preHPF', v: number) => void;
  onBitCrusher:  (key: 'bits' | 'rate' | 'mix', v: number) => void;
  onAutoPan:     (key: 'rate' | 'depth' | 'mix', v: number) => void;
  onTranceGate:  (key: 'rate' | 'depth' | 'attack' | 'release' | 'mix' | 'synced' | 'syncDiv', v: number | boolean | string) => void;
}

const EFFECT_LABELS: Record<EffectKey, string> = {
  filter: 'FILTER',
  eq: 'EQ3', clipper: 'CLIPPER', waveshaper: 'WAVESHAPER',
  saturator: 'MB SATURATOR', compressor: 'COMPRESSOR', widener: 'STEREO WIDTH',
  mseq: 'M/S EQ', chorus: 'CHORUS', delay: 'DELAY', reverb: 'REVERB',
  bitcrusher: 'BIT CRUSHER', autopan: 'AUTO PAN', trancegate: 'TRANCE GATE',
};

export function EffectsPanel({
  effects, onMasterBypass, onCollapse, onBypass, onReorder,
  onFilter, onEQ, onClipper, onWaveshaper, onSaturator, onCompressor, onWidener, onMSEQ, onChorus, onDelay, onReverb,
  onBitCrusher, onAutoPan, onTranceGate,
}: Props) {
  const dragIdxRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const order = effects.effectsOrder;

  const handleDrop = (toIdx: number) => {
    const from = dragIdxRef.current;
    if (from === null || from === toIdx) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(toIdx, 0, item);
    onReorder(next);
    dragIdxRef.current = null;
    setDragOverIdx(null);
  };

  const FILTER_TYPES: { label: string; value: FilterType }[] = [
    { label: 'LP', value: 'lowpass' },
    { label: 'HP', value: 'highpass' },
    { label: 'BP', value: 'bandpass' },
  ];
  const FILTER_QS = [6, 12, 18];

  const effectControls = (key: EffectKey): React.ReactNode => {
    const e = effects;
    switch (key) {
      case 'filter':
        return <>
          <div className="filter-type-row">
            {FILTER_TYPES.map(({ label, value }) => (
              <button
                key={value}
                className={`btn-filter-type ${e.filter.type === value ? 'active' : ''}`}
                onClick={() => onFilter('type', value)}
              >{label}</button>
            ))}
          </div>
          <FreqKnob label="FREQ" value={e.filter.freq} defaultValue={1000} onChange={v => onFilter('freq', v)} />
          <div className="filter-q-row">
            <span className="knob-label">Q</span>
            {FILTER_QS.map(q => (
              <button
                key={q}
                className={`btn-filter-q ${e.filter.q === q ? 'active' : ''}`}
                onClick={() => onFilter('q', q)}
              >{q}</button>
            ))}
          </div>
          <Knob label="MIX" value={e.filter.mix} defaultValue={1} onChange={v => onFilter('mix', v)} />
        </>;
      case 'eq':
        return <>
          <DBKnob label="LOW 60Hz"  value={e.eq.lowGain}  onChange={v => onEQ('lowGain', v)} />
          <DBKnob label="MID 2kHz"  value={e.eq.midGain}  onChange={v => onEQ('midGain', v)} />
          <DBKnob label="HIGH 12k"  value={e.eq.highGain} onChange={v => onEQ('highGain', v)} />
        </>;
      case 'clipper':
        return <>
          <Knob label="DRIVE"     value={e.clipper.drive}  defaultValue={0.5} onChange={v => onClipper('drive', v)} />
          <Knob label="SOFT↔HARD" value={e.clipper.amount} defaultValue={0.5} onChange={v => onClipper('amount', v)} />
          <Knob label="MIX"       value={e.clipper.mix}    defaultValue={0.7} onChange={v => onClipper('mix', v)} />
        </>;
      case 'waveshaper':
        return <>
          <Knob label="DRIVE" value={e.waveshaper.drive} defaultValue={0.5} onChange={v => onWaveshaper('drive', v)} />
          <Knob label="MIX"   value={e.waveshaper.mix}   defaultValue={0.5} onChange={v => onWaveshaper('mix', v)} />
        </>;
      case 'saturator':
        return <>
          <Knob label="DRIVE"    value={e.saturator.drive}    defaultValue={0.4}  onChange={v => onSaturator('drive', v)} />
          <Knob label="MIX"      value={e.saturator.mix}      defaultValue={0.5}  onChange={v => onSaturator('mix', v)} />
          <Knob label="LOW CUT"  value={e.saturator.lowFreq}  defaultValue={300}  min={60}  max={2000}  step={10} unit="Hz" onChange={v => onSaturator('lowFreq', v)} />
          <Knob label="HIGH CUT" value={e.saturator.highFreq} defaultValue={3000} min={500} max={16000} step={50} unit="Hz" onChange={v => onSaturator('highFreq', v)} />
        </>;
      case 'compressor':
        return <>
          <Knob label="DRIVE"   value={e.compressor.drive}   defaultValue={0}    min={0}     max={24}  step={0.1}  unit=" dB" onChange={v => onCompressor('drive', v)} />
          <Knob label="RATIO"   value={e.compressor.ratio}   defaultValue={4}    min={1}     max={20}  step={0.1}  unit=":1"  onChange={v => onCompressor('ratio', v)} />
          <Knob label="ATTACK"  value={e.compressor.attack}  defaultValue={0.01} min={0.001} max={0.3} step={0.001} unit=" s" onChange={v => onCompressor('attack', v)} />
          <Knob label="RELEASE" value={e.compressor.release} defaultValue={0.15} min={0.01}  max={1.0} step={0.01} unit=" s"  onChange={v => onCompressor('release', v)} />
          <Knob label="MAKEUP"  value={e.compressor.makeup}  defaultValue={0}    min={-24}   max={24}  step={0.1}  unit=" dB" onChange={v => onCompressor('makeup', v)} />
        </>;
      case 'widener':
        return <>
          <Knob label="WIDTH" value={e.widener.width} defaultValue={2}   min={0} max={3} onChange={v => onWidener('width', v)} />
          <Knob label="MIX"   value={e.widener.mix}   defaultValue={0.5}          onChange={v => onWidener('mix', v)} />
        </>;
      case 'mseq':
        return <>
          <div className="effect-controls-row">
            <FreqKnob label="MID FREQ"  value={e.mseq.midFreq}  defaultValue={1000} onChange={v => onMSEQ('midFreq', v)} />
            <DBKnob   label="MID GAIN"  value={e.mseq.midGain}  defaultValue={0}    onChange={v => onMSEQ('midGain', v)} />
          </div>
          <div className="effect-controls-row">
            <FreqKnob label="SIDE FREQ" value={e.mseq.sideFreq} defaultValue={3000} onChange={v => onMSEQ('sideFreq', v)} />
            <DBKnob   label="SIDE GAIN" value={e.mseq.sideGain} defaultValue={0}    onChange={v => onMSEQ('sideGain', v)} />
          </div>
          <Knob label="MIX" value={e.mseq.mix} defaultValue={0.5} onChange={v => onMSEQ('mix', v)} />
        </>;
      case 'chorus':
        return <>
          <Knob label="RATE"  value={e.chorus.rate}  defaultValue={2}     min={0.1} max={10}   step={0.1}   unit="Hz" onChange={v => onChorus('rate', v)} />
          <Knob label="DEPTH" value={e.chorus.depth} defaultValue={0.004} min={0}   max={0.02} step={0.001} unit=""   onChange={v => onChorus('depth', v)} />
          <Knob label="MIX"   value={e.chorus.mix}   defaultValue={0.35}                                              onChange={v => onChorus('mix', v)} />
        </>;
      case 'delay':
        return <>
          <Knob label="TIME L" value={e.delay.timeL}     defaultValue={0.375} min={0.01} max={2}    step={0.01} unit="s" onChange={v => onDelay('timeL', v)} />
          <Knob label="TIME R" value={e.delay.timeR}     defaultValue={0.5}   min={0.01} max={2}    step={0.01} unit="s" onChange={v => onDelay('timeR', v)} />
          <Knob label="FDBK"   value={e.delay.feedback}  defaultValue={0.35}  min={0}    max={0.95} step={0.01}          onChange={v => onDelay('feedback', v)} />
          <Knob label="MIX"    value={e.delay.mix}       defaultValue={0.3}                                              onChange={v => onDelay('mix', v)} />
          <label className="knob-group knob-toggle">
            <span className="knob-label">PING PONG</span>
            <button
              className={`btn-ping-pong ${e.delay.pingPong ? 'active' : ''}`}
              onClick={() => onDelay('pingPong', !e.delay.pingPong)}
            >{e.delay.pingPong ? 'ON' : 'OFF'}</button>
          </label>
        </>;
      case 'reverb':
        return <>
          <Knob label="DECAY"  value={e.reverb.decay}  defaultValue={2.0} min={0.1} max={10}   step={0.1} unit="s"  onChange={v => onReverb('decay', v)} />
          <Knob label="PRE-HP" value={e.reverb.preHPF} defaultValue={200} min={20}  max={2000} step={10}  unit="Hz" onChange={v => onReverb('preHPF', v)} />
          <Knob label="MIX"    value={e.reverb.mix}    defaultValue={0.3}                                            onChange={v => onReverb('mix', v)} />
        </>;
      case 'bitcrusher':
        return <>
          <Knob label="BITS" value={e.bitcrusher.bits} defaultValue={8} min={1} max={16} step={1} unit=" bit" onChange={v => onBitCrusher('bits', v)} />
          <Knob label="RATE" value={e.bitcrusher.rate} defaultValue={1} min={1} max={32} step={1} unit="×"    onChange={v => onBitCrusher('rate', v)} />
          <Knob label="MIX"  value={e.bitcrusher.mix}  defaultValue={1}                                       onChange={v => onBitCrusher('mix', v)} />
        </>;
      case 'autopan':
        return <>
          <Knob label="RATE"  value={e.autopan.rate}  defaultValue={1}   min={0.1} max={20} step={0.1} unit="Hz" onChange={v => onAutoPan('rate', v)} />
          <Knob label="DEPTH" value={e.autopan.depth} defaultValue={0.7} min={0}   max={1}  step={0.01}           onChange={v => onAutoPan('depth', v)} />
          <Knob label="MIX"   value={e.autopan.mix}   defaultValue={1}                                             onChange={v => onAutoPan('mix', v)} />
        </>;
      case 'trancegate':
        return <>
          <div className="effect-controls-row trance-gate-top">
            <label className="knob-group knob-toggle">
              <span className="knob-label">SYNC</span>
              <button
                className={`btn-trance-sync ${e.trancegate.synced ? 'active' : ''}`}
                onClick={() => onTranceGate('synced', !e.trancegate.synced)}
              >{e.trancegate.synced ? 'BPM' : 'FREE'}</button>
            </label>
            {e.trancegate.synced ? (
              <label className="knob-group">
                <span className="knob-label">DIVISION</span>
                <select
                  className="trance-div-select"
                  value={e.trancegate.syncDiv}
                  onChange={ev => onTranceGate('syncDiv', ev.target.value)}
                >
                  {SYNC_DIVS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            ) : (
              <Knob label="RATE" value={e.trancegate.rate} defaultValue={4} min={0.1} max={40} step={0.1} unit="Hz" onChange={v => onTranceGate('rate', v)} />
            )}
          </div>
          <Knob label="DEPTH"   value={e.trancegate.depth}   defaultValue={1}      min={0}     max={1}   step={0.01}  onChange={v => onTranceGate('depth', v)} />
          <Knob label="ATTACK"  value={e.trancegate.attack}  defaultValue={0.005}  min={0.001} max={0.2} step={0.001} unit="s" onChange={v => onTranceGate('attack', v)} />
          <Knob label="RELEASE" value={e.trancegate.release} defaultValue={0.08}   min={0.001} max={0.2} step={0.001} unit="s" onChange={v => onTranceGate('release', v)} />
          <Knob label="MIX"     value={e.trancegate.mix}     defaultValue={1}                                          onChange={v => onTranceGate('mix', v)} />
        </>;
    }
  };

  return (
    <div className="effects-panel">
      <div className="effects-header">
        <span className="effects-title" onClick={onCollapse} title="Click to collapse" style={{ cursor: 'pointer' }}>FX CHAIN ▲</span>
        <button
          className={`btn-master-bypass ${effects.masterBypass ? 'active' : ''}`}
          onClick={onMasterBypass}
        >BYPASS ALL</button>
      </div>

      {order.map((key, idx) => (
        <EffectRow
          key={key}
          effectKey={key}
          label={EFFECT_LABELS[key]}
          bypassed={effects[key].bypassed}
          isDragOver={dragOverIdx === idx}
          onToggle={() => onBypass(key)}
          onDragStart={() => { dragIdxRef.current = idx; }}
          onDragOver={e => { e.preventDefault(); setDragOverIdx(idx); }}
          onDrop={() => handleDrop(idx)}
          onDragEnd={() => { dragIdxRef.current = null; setDragOverIdx(null); }}
        >
          {effectControls(key)}
        </EffectRow>
      ))}
    </div>
  );
}
