import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TrackState, EffectKey } from '../audio/Track';
import type { FilterType } from '../audio/effects/Filter';
import { EffectsPanel } from './EffectsPanel';
import { useDraggableNumber } from '../hooks/useDraggableNumber';
import { midiNoteToName } from '../audio/MidiInput';

interface Props {
  state: TrackState;
  isRecordingThis: boolean;
  onVolume:       (v: number) => void;
  onPan:          (v: number) => void;
  onMute:         () => void;
  onSolo:         () => void;
  onArm:          () => void;
  onRecord:       () => void;
  onOverdub:      () => void;
  onDuplicate:    () => void;
  onRemove:       () => void;
  onRename:       (name: string) => void;
  onStretch:      (v: number) => void;
  onPitch:        (v: number) => void;
  onLoopStart:    (v: number) => void;
  onEQ:           (key: 'lowGain' | 'midGain' | 'highGain', v: number) => void;
  onClipper:      (key: 'amount' | 'drive' | 'mix', v: number) => void;
  onWaveshaper:   (key: 'drive' | 'mix', v: number) => void;
  onSaturator:    (key: 'drive' | 'mix' | 'lowFreq' | 'highFreq', v: number) => void;
  onCompressor:   (key: 'drive' | 'ratio' | 'attack' | 'release' | 'makeup', v: number) => void;
  onWidener:      (key: 'width' | 'mix', v: number) => void;
  onReverse:      () => void;
  onMidiArm:      () => void;
  onRootNote:     (n: number) => void;
  onMSEQ:         (key: 'midFreq' | 'midGain' | 'sideFreq' | 'sideGain' | 'mix', v: number) => void;
  onChorus:       (key: 'rate' | 'depth' | 'mix', v: number) => void;
  onDelay:        (key: 'timeL' | 'timeR' | 'feedback' | 'mix' | 'pingPong', v: number | boolean) => void;
  onReverb:       (key: 'mix' | 'decay' | 'preHPF', v: number) => void;
  onBitCrusher:   (key: 'bits' | 'rate' | 'mix', v: number) => void;
  onAutoPan:      (key: 'rate' | 'depth' | 'mix', v: number) => void;
  onFilter:       (key: 'type' | 'freq' | 'q' | 'mix', v: FilterType | number) => void;
  onTranceGate:   (key: 'rate' | 'depth' | 'attack' | 'release' | 'mix' | 'synced' | 'syncDiv', v: number | boolean | string) => void;
  onBypassFX:     (fx: EffectKey) => void;
  onMasterBypass: () => void;
  onReorderFX:    (order: EffectKey[]) => void;
}

export function TrackStrip({
  state, isRecordingThis,
  onVolume, onPan, onMute, onSolo, onArm, onRecord, onOverdub,
  onDuplicate, onRemove, onRename, onStretch, onPitch, onLoopStart, onReverse,
  onMidiArm, onRootNote,
  onFilter,
  onEQ, onClipper, onWaveshaper, onSaturator, onCompressor, onWidener, onMSEQ,
  onChorus, onDelay, onReverb, onBitCrusher, onAutoPan, onTranceGate,
  onBypassFX, onMasterBypass, onReorderFX,
}: Props) {
  const [showFX, setShowFX] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameVal, setNameVal] = useState(state.name);
  const [waveExpanded, setWaveExpanded] = useState(false);
  const [waveZoom, setWaveZoom] = useState(4);
  const [waveViewStart, setWaveViewStart] = useState(0);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const expandWaveRef = useRef<HTMLCanvasElement>(null);

  const stretchDrag  = useDraggableNumber(state.timeStretch, onStretch, { min: 0.25, max: 4, step: 0.01 });
  const pitchDrag    = useDraggableNumber(state.pitch, onPitch, { min: -24, max: 24, step: 1 });
  const rootNoteDrag = useDraggableNumber(state.rootNote, onRootNote, { min: 0, max: 127, step: 1 });

  // Mini waveform
  useEffect(() => {
    const c = waveRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const W = c.width, H = c.height;
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, W, H);

    if (state.hasAudio && state.waveformPeaks.length > 0) {
      const peaks = state.waveformPeaks;
      const totalCols = peaks.length / 2;
      const mid = H / 2;

      if (state.bufferDuration > 0 && state.loopStartOffset > 0) {
        const dimX = (state.loopStartOffset / state.bufferDuration) * W;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, dimX, H);
      }

      for (let i = 0; i < W; i++) {
        const srcIdx = Math.floor((i / W) * totalCols);
        const mn = peaks[srcIdx * 2];
        const mx = peaks[srcIdx * 2 + 1];
        const y1 = mid - mx * mid * 0.92;
        const y2 = mid - mn * mid * 0.92;
        const heightPx = Math.max(1, y2 - y1);
        const grad = ctx.createLinearGradient(0, y1, 0, y2);
        grad.addColorStop(0,   state.color + '66');
        grad.addColorStop(0.5, state.color);
        grad.addColorStop(1,   state.color + '66');
        ctx.fillStyle = grad;
        ctx.fillRect(i, y1, 1, heightPx);
      }

      if (state.bufferDuration > 0) {
        const markerX = (state.loopStartOffset / state.bufferDuration) * W;
        ctx.strokeStyle = '#ff6600';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#ff6600';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.moveTo(markerX, 0);
        ctx.lineTo(markerX, H);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    } else if (!state.hasAudio) {
      ctx.fillStyle = '#ffffff11';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('NO AUDIO', W / 2, H / 2 + 3);
    }
  }, [state.waveformPeaks, state.color, state.loopStartOffset, state.bufferDuration, state.hasAudio]);

  // Expanded waveform
  useEffect(() => {
    if (!waveExpanded) return;
    const c = expandWaveRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const W = c.width, H = c.height;

    ctx.fillStyle = '#06060d';
    ctx.fillRect(0, 0, W, H);

    if (!state.hasAudio || state.waveformPeaks.length === 0 || state.bufferDuration === 0) {
      ctx.fillStyle = '#ffffff22';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('NO AUDIO', W / 2, H / 2);
      return;
    }

    const peaks = state.waveformPeaks;
    const totalCols = peaks.length / 2;
    const viewFraction = 1 / waveZoom;
    const mid = H / 2;
    const rulerH = 18;

    for (let i = 0; i < W; i++) {
      const frac = waveViewStart + (i / W) * viewFraction;
      const srcIdx = Math.min(totalCols - 1, Math.floor(frac * totalCols));
      const mn = peaks[srcIdx * 2];
      const mx = peaks[srcIdx * 2 + 1];
      const usable = mid - rulerH / 2;
      const y1 = mid - mx * usable * 0.92;
      const y2 = mid - mn * usable * 0.92;
      const heightPx = Math.max(1, y2 - y1);
      const grad = ctx.createLinearGradient(0, y1, 0, y2);
      grad.addColorStop(0,   state.color + '66');
      grad.addColorStop(0.5, state.color);
      grad.addColorStop(1,   state.color + '66');
      ctx.fillStyle = grad;
      ctx.fillRect(i, y1, 1, heightPx);
    }

    // Time ruler
    const rulerY = H - rulerH;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, rulerY, W, rulerH);

    const visibleSec = state.bufferDuration * viewFraction;
    const rawInterval = visibleSec / 8;
    const mag = Math.pow(10, Math.floor(Math.log10(rawInterval)));
    const niceSteps = [1, 2, 5, 10];
    const tickSec = (niceSteps.find(n => n * mag >= rawInterval) ?? 10) * mag;
    const startSec = waveViewStart * state.bufferDuration;
    const endSec   = (waveViewStart + viewFraction) * state.bufferDuration;
    const firstTick = Math.ceil(startSec / tickSec) * tickSec;

    ctx.strokeStyle = '#ffffff33';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#999';
    ctx.font = '9px monospace';
    for (let t = firstTick; t <= endSec + tickSec * 0.01; t += tickSec) {
      const x = ((t / state.bufferDuration - waveViewStart) / viewFraction) * W;
      ctx.beginPath(); ctx.moveTo(x, rulerY); ctx.lineTo(x, H); ctx.stroke();
      const label = visibleSec < 0.5 ? t.toFixed(3) : visibleSec < 5 ? t.toFixed(2) : t.toFixed(1);
      ctx.textAlign = x < 24 ? 'left' : x > W - 24 ? 'right' : 'center';
      ctx.fillText(label + 's', x, H - 4);
    }

    // Loop start marker
    const loopFrac = state.loopStartOffset / state.bufferDuration;
    const markerX = ((loopFrac - waveViewStart) / viewFraction) * W;
    if (markerX >= -2 && markerX <= W + 2) {
      ctx.strokeStyle = '#ff6600';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ff6600';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(markerX, 0);
      ctx.lineTo(markerX, rulerY);
      ctx.stroke();
      ctx.shadowBlur = 0;

      const lx = Math.max(4, Math.min(W - 4, markerX));
      ctx.fillStyle = '#ff6600';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = markerX > W * 0.72 ? 'right' : 'left';
      ctx.fillText(state.loopStartOffset.toFixed(4) + 's', lx + (markerX > W * 0.72 ? -4 : 4), 12);
    }
  }, [waveExpanded, state.waveformPeaks, state.color, state.loopStartOffset,
      state.bufferDuration, state.hasAudio, waveZoom, waveViewStart]);

  const recenterView = useCallback((zoom: number) => {
    const viewFraction = 1 / zoom;
    const loopFrac = state.bufferDuration > 0 ? state.loopStartOffset / state.bufferDuration : 0;
    setWaveViewStart(Math.max(0, Math.min(1 - viewFraction, loopFrac - viewFraction / 2)));
  }, [state.loopStartOffset, state.bufferDuration]);

  const handleWaveDblClick = () => {
    if (!waveExpanded) recenterView(4);
    setWaveZoom(4);
    setWaveExpanded(v => !v);
  };

  const handleExpandedZoom = (newZoom: number) => {
    setWaveZoom(newZoom);
    recenterView(newZoom);
  };

  const handleWavePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!state.hasAudio || state.bufferDuration === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const updateStart = (clientX: number) => {
      const rect = waveRef.current!.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(0.95, (clientX - rect.left) / rect.width));
      onLoopStart(ratio * state.bufferDuration);
    };
    updateStart(e.clientX);
  };

  const handleWavePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!(e.buttons & 1) || !state.hasAudio || state.bufferDuration === 0) return;
    const rect = waveRef.current!.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.95, (e.clientX - rect.left) / rect.width));
    onLoopStart(ratio * state.bufferDuration);
  };

  const handleExpandedPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!state.hasAudio || state.bufferDuration === 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = expandWaveRef.current!.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onLoopStart(Math.min(state.bufferDuration * 0.95,
      (waveViewStart + ratio * (1 / waveZoom)) * state.bufferDuration));
  };

  const handleExpandedPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!(e.buttons & 1) || !state.hasAudio || state.bufferDuration === 0) return;
    const rect = expandWaveRef.current!.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onLoopStart(Math.min(state.bufferDuration * 0.95,
      (waveViewStart + ratio * (1 / waveZoom)) * state.bufferDuration));
  };

  const handleExpandedWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const newZoom = Math.max(1, Math.min(64, waveZoom * (e.deltaY < 0 ? 1.5 : 1 / 1.5)));
    handleExpandedZoom(newZoom);
  };

  const handleRename = () => {
    setEditing(false);
    onRename(nameVal || state.name);
  };

  return (
    <div
      className={`track-strip ${state.muted ? 'track-muted' : ''} ${isRecordingThis ? 'track-recording' : ''} ${state.armed ? 'track-armed' : ''}`}
      style={{ '--track-color': state.color } as React.CSSProperties}
    >
      <div className="track-color-bar" style={{ background: state.color }} />

      <div className="track-main">
        {/* Name */}
        <div className="track-name">
          {editing ? (
            <input
              className="track-name-input"
              value={nameVal}
              onChange={e => setNameVal(e.target.value)}
              onBlur={handleRename}
              onKeyDown={e => e.key === 'Enter' && handleRename()}
              autoFocus
            />
          ) : (
            <span className="track-name-text" onDoubleClick={() => setEditing(true)}>{state.name}</span>
          )}
        </div>

        {/* Mini waveform */}
        <canvas
          ref={waveRef}
          width={220} height={52}
          className="track-wave"
          style={{ cursor: state.hasAudio ? 'crosshair' : 'default' }}
          title={state.hasAudio ? 'Drag to set loop start · Double-tap to expand' : ''}
          onPointerDown={handleWavePointerDown}
          onPointerMove={handleWavePointerMove}
          onDoubleClick={handleWaveDblClick}
        />

        {/* Expanded waveform editor */}
        {waveExpanded && (
          <div className="wave-expanded">
            <div className="wave-expand-toolbar">
              <span className="wave-expand-pos">{state.loopStartOffset.toFixed(4)}s</span>
              <div className="wave-expand-zoom-group">
                <button className="btn-wave-zoom" onClick={() => handleExpandedZoom(Math.max(1, waveZoom / 2))} title="Zoom out">−</button>
                <span className="wave-zoom-label">{waveZoom >= 10 ? Math.round(waveZoom) : waveZoom.toFixed(1)}×</span>
                <button className="btn-wave-zoom" onClick={() => handleExpandedZoom(Math.min(64, waveZoom * 2))} title="Zoom in">+</button>
              </div>
              <button className="btn-wave-close" onClick={() => setWaveExpanded(false)} title="Close (double-tap waveform)">✕</button>
            </div>
            <canvas
              ref={expandWaveRef}
              width={500} height={120}
              className="wave-expand-canvas"
              style={{ cursor: state.hasAudio ? 'crosshair' : 'default' }}
              title="Drag to set loop start · Scroll to zoom"
              onPointerDown={handleExpandedPointerDown}
              onPointerMove={handleExpandedPointerMove}
              onWheel={handleExpandedWheel}
            />
          </div>
        )}

        {/* Controls row */}
        <div className="track-controls">
          <button className={`btn-track btn-midi-arm ${state.midiArmed ? 'active' : ''}`} onClick={onMidiArm} title="MIDI arm — play sample chromatically from keyboard">
            MIDI
          </button>
          {state.midiArmed && (
            <input
              type="text"
              className="ctrl-input midi-root-input"
              readOnly
              value={midiNoteToName(state.rootNote)}
              title="Root note — drag up/down to change"
              {...rootNoteDrag}
              onDoubleClick={() => onRootNote(60)}
            />
          )}
          <button className={`btn-track ${state.armed ? 'armed' : ''}`} onClick={onArm} title="Arm for monitoring/record">ARM</button>
          <button className={`btn-track btn-rec ${isRecordingThis ? 'active blink' : ''}`} onClick={isRecordingThis ? undefined : onRecord} title="Record">●</button>
          <button className="btn-track" onClick={onOverdub} title="Overdub" disabled={!state.hasAudio}>+●</button>
          <button className={`btn-track btn-rev ${state.reversed ? 'active' : ''}`} onClick={onReverse} title="Reverse playback" disabled={!state.hasAudio}>REV</button>
          <button className={`btn-track ${state.muted ? 'active' : ''}`} onClick={onMute} title="Mute">M</button>
          <button className={`btn-track ${state.soloed ? 'active' : ''}`} onClick={onSolo} title="Solo">S</button>
          <button className="btn-track" onClick={onDuplicate} title="Duplicate">⧉</button>
          <button className="btn-track btn-danger" onClick={onRemove} title="Remove">✕</button>
        </div>

        {/* Volume + Pan */}
        <div className="track-mix">
          <label className="mix-label">VOL</label>
          <input type="range" className="fader" min={0} max={1} step={0.01}
            value={state.volume}
            onChange={e => onVolume(Number(e.target.value))}
            onDoubleClick={() => onVolume(0.8)}
            title="Double-click to reset" />
          <span className="mix-val">{Math.round(state.volume * 100)}</span>

          <label className="mix-label">PAN</label>
          <input type="range" className="fader pan-fader" min={-1} max={1} step={0.01}
            value={state.pan}
            onChange={e => onPan(Number(e.target.value))}
            onDoubleClick={() => onPan(0)}
            title="Double-click to reset" />
          <span className="mix-val">{state.pan >= 0 ? `+${(state.pan * 100).toFixed(0)}` : (state.pan * 100).toFixed(0)}</span>
        </div>

        {/* Stretch + Pitch */}
        <div className="track-tune">
          <div className="tune-field">
            <span className="mix-label">STRETCH ×</span>
            <input
              type="number"
              className="ctrl-input tune-input"
              min={0.25} max={4} step={0.01}
              value={state.timeStretch.toFixed(2)}
              onChange={e => onStretch(Number(e.target.value))}
              onDoubleClick={() => onStretch(1.0)}
              title="Double-click to reset"
              {...stretchDrag}
            />
          </div>
          <div className="tune-field">
            <span className="mix-label">PITCH st</span>
            <input
              type="number"
              className="ctrl-input tune-input"
              min={-24} max={24} step={1}
              value={state.pitch}
              onChange={e => onPitch(Number(e.target.value))}
              onDoubleClick={() => onPitch(0)}
              title="Double-click to reset"
              {...pitchDrag}
            />
          </div>
        </div>

        {/* FX toggle */}
        <button className={`btn-fx-toggle ${showFX ? 'active' : ''}`} onClick={() => setShowFX(v => !v)}>
          FX {showFX ? '▲' : '▼'}
        </button>
      </div>

      {showFX && (
        <EffectsPanel
          effects={state.effects}
          onMasterBypass={onMasterBypass}
          onCollapse={() => setShowFX(false)}
          onBypass={onBypassFX}
          onReorder={onReorderFX}
          onFilter={onFilter}
          onEQ={onEQ}
          onClipper={onClipper}
          onWaveshaper={onWaveshaper}
          onSaturator={onSaturator}
          onCompressor={onCompressor}
          onWidener={onWidener}
          onMSEQ={onMSEQ}
          onChorus={onChorus}
          onDelay={onDelay}
          onReverb={onReverb}
          onBitCrusher={onBitCrusher}
          onAutoPan={onAutoPan}
          onTranceGate={onTranceGate}
        />
      )}
    </div>
  );
}
