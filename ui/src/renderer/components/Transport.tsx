import { useState, useEffect } from 'react';
import { GridDiv } from '../audio/Quantizer';
import { useDraggableNumber } from '../hooks/useDraggableNumber';

const GRIDS: GridDiv[] = ['1/4','1/8','1/16','1/32','1/64','1/128','1/4t','1/8t','1/16t','1/32t'];
const BARS  = [1, 2, 4, 8, 16, 32];

interface Props {
  isPlaying:    boolean;
  isRecording:  boolean;
  isCountingIn: boolean;
  bpm:          number;
  bars:         number;
  swing:        number;
  quantizeGrid: GridDiv;
  loopProgress: number;
  currentBeat:  number;
  metronomeOn:  boolean;
  canUndo:      boolean;
  canRedo:      boolean;
  onPlay:       () => void;
  onStop:       () => void;
  onRecord:     () => void;
  onMetronome:  () => void;
  onBPM:        (v: number) => void;
  onBars:       (v: number) => void;
  onSwing:      (v: number) => void;
  onGrid:       (v: GridDiv) => void;
  onUndo:       () => void;
  onRedo:       () => void;
}

export function Transport({
  isPlaying, isRecording, isCountingIn, bpm, bars, swing, quantizeGrid, loopProgress, currentBeat,
  metronomeOn, canUndo, canRedo,
  onPlay, onStop, onRecord, onMetronome, onBPM, onBars, onSwing, onGrid, onUndo, onRedo,
}: Props) {
  const beat = Math.floor(currentBeat % 4) + 1;
  const [bpmLocal, setBpmLocal] = useState(String(bpm));
  const [bpmEditing, setBpmEditing] = useState(false);
  useEffect(() => { if (!bpmEditing) setBpmLocal(String(bpm)); }, [bpm, bpmEditing]);
  const bpmDrag = useDraggableNumber(bpm, v => onBPM(Math.round(v)), { min: 40, max: 300, step: 1 });

  return (
    <div className="transport">
      <div className="transport-left">
        <div className="transport-logo">
          <span className="logo-t">T</span>-800
          <span className="logo-sub">AUDIO SYSTEM</span>
        </div>

        <div className="transport-btns">
          <button className={`btn btn-play ${isPlaying && !isRecording ? 'active' : ''}`} onClick={onPlay} title="Play [Space]">▶ PLAY</button>
          <button className={`btn btn-stop ${!isPlaying ? 'active' : ''}`} onClick={onStop} title="Stop">■ STOP</button>
          <button className={`btn btn-rec ${isCountingIn ? 'active blink' : isRecording ? 'active blink' : ''}`} onClick={onRecord} title="Record new track" disabled={isCountingIn}>
            {isCountingIn ? '◎ COUNT' : '● REC'}
          </button>
          <button className={`btn btn-metro ${metronomeOn ? 'active' : ''}`} onClick={onMetronome} title="Metronome">♩ CLICK</button>
        </div>

        <div className="beat-display">
          <span className="beat-label">BEAT</span>
          <span className="beat-value">{isPlaying ? beat : '–'}</span>
          <div className="beat-dots">
            {[1,2,3,4].map(b => (
              <div key={b} className={`beat-dot ${isPlaying && beat === b ? 'beat-dot--on' : ''}`} />
            ))}
          </div>
        </div>
      </div>

      <div className="transport-center">
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${loopProgress * 100}%` }} />
        </div>
      </div>

      <div className="transport-right">
        <label className="ctrl-group">
          <span className="ctrl-label">BPM</span>
          <input
            type="number"
            className={`ctrl-input bpm-input${bpmEditing ? ' bpm-input--editing' : ''}`}
            value={bpmLocal}
            readOnly={!bpmEditing}
            min={40} max={300} step={1}
            onChange={e => {
              setBpmLocal(e.target.value);
              const n = parseInt(e.target.value, 10);
              if (n >= 40 && n <= 300) onBPM(n);
            }}
            onDoubleClick={e => {
              setBpmEditing(true);
              e.currentTarget.select();
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                if (e.key === 'Escape') setBpmLocal(String(bpm));
                setBpmEditing(false);
                e.currentTarget.blur();
              }
            }}
            onBlur={() => {
              setBpmEditing(false);
              const n = parseInt(bpmLocal, 10);
              if (isNaN(n) || n < 40 || n > 300) setBpmLocal(String(bpm));
            }}
            {...(bpmEditing ? {} : bpmDrag)}
          />
        </label>

        <label className="ctrl-group">
          <span className="ctrl-label">BARS</span>
          <select className="ctrl-select" value={bars} onChange={e => onBars(Number(e.target.value))}>
            {BARS.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>

        <label className="ctrl-group">
          <span className="ctrl-label">GRID</span>
          <select className="ctrl-select" value={quantizeGrid} onChange={e => onGrid(e.target.value as GridDiv)}>
            {GRIDS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>

        <label className="ctrl-group">
          <span className="ctrl-label">SWING {swing}%</span>
          <input type="range" className="ctrl-slider" min={50} max={75} step={1}
            value={swing} onChange={e => onSwing(Number(e.target.value))} />
        </label>

        <div className="undo-redo">
          <button className="btn btn-sm" disabled={!canUndo} onClick={onUndo} title="Undo">↩</button>
          <button className="btn btn-sm" disabled={!canRedo} onClick={onRedo} title="Redo">↪</button>
        </div>
      </div>
    </div>
  );
}
