import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { SeqPager } from './SeqPager';
import { ChopperState, ChopperEngine, SEQ_MAX_VIEW_STEPS } from './ChopperEngine';
import { flashCells, onCellsInColumn } from '../luxe/hitFlash';

interface Props {
  state: ChopperState;
  engine: ChopperEngine;
  onClear: () => void;
  onStartRecord: () => void;
  onStopRecord: () => void;
  onStartLiveRecord: () => void;
  onStopLiveRecord: () => void;
  onToggleCountIn: () => void;
  onPlay: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onToggleLoop: () => void;
  onToggleStep: (step: number, padIdx: number) => void;
  onClearStep: (step: number) => void;
  /** ALT-click a lit cell cycles its velocity 100 → 75 → 50 → 25 → 100 %. */
  onSetStepVelocity?: (step: number, padIdx: number, v: number) => void;
  onMoveNote: (fromStep: number, padIdx: number, toStep: number) => void;
  onSetBars: (bars: number) => void;
  onSetResolution: (res: number) => void;
  onSelectSequence: (idx: number) => void;
  onAddSequence: () => void;
  onDuplicateSequence: () => void;
  onDeleteSequence: (idx: number) => void;
}

const BAR_OPTIONS = [1, 2, 3, 4];
const RES_OPTIONS = [
  { label: '1/2',   value: 2 },
  { label: '1/4',   value: 4 },
  { label: '1/8',   value: 8 },
  { label: '1/16',  value: 16 },
  { label: '1/32',  value: 32 },
  { label: '1/64',  value: 64 },
  { label: '1/128', value: 128 },
];
// Triplet resolutions = a straight value × 1.5 (3 in the space of 2).
const TRIPLET_RES = new Set([3, 6, 12, 24, 48, 96, 192]);
const isTriplet = (r: number) => TRIPLET_RES.has(r);
// The straight base note behind a resolution (so 24 → 16, i.e. "1/16" + triplet).
const baseResolution = (r: number) => (isTriplet(r) ? Math.round((r * 2) / 3) : r);

export function Timeline({
  state, engine, onClear, onStartRecord, onStopRecord, onStartLiveRecord, onStopLiveRecord,
  onToggleCountIn,
  onPlay, onStop, onPause, onResume, onToggleLoop, onToggleStep, onClearStep, onSetStepVelocity, onMoveNote,
  onSetBars, onSetResolution,
  onSelectSequence, onAddSequence, onDuplicateSequence, onDeleteSequence,
}: Props) {
  // Columns are the VIEW (seqViewResolution); the notes are STORED at
  // seqResolution, an integer multiple of it. `stride` stored steps sit behind
  // each column — the first is the column's own step, the rest are off-grid
  // at this view and drawn as ghosts (still audible; pick a finer grid to edit).
  const viewRes = state.seqViewResolution ?? state.seqResolution;
  const stride = Math.max(1, Math.round(state.seqResolution / viewRes));
  const stepCount = Math.min(SEQ_MAX_VIEW_STEPS, state.seqBars * viewRes);
  const stepsPerBar = viewRes;
  const stepsPerBeat = stepsPerBar / 4;

  // Rows = pads that have at least one hit in the grid. When the grid is
  // empty, fall back to a single placeholder row (first pad with a chop)
  // so the user has somewhere to click.
  const activePadIndices = new Set<number>();
  for (const row of state.seqGrid) if (row) for (const i of row) activePadIndices.add(i);
  const visiblePads = activePadIndices.size > 0
    ? state.pads.filter(p => activePadIndices.has(p.index))
    : state.pads.filter(p => p.chopId !== null).slice(0, 1);

  // Animate playhead column via RAF — direct DOM manipulation to avoid re-renders.
  // We measure the cells area each frame so the cursor lines up with the actual
  // cells column (which sits to the right of the pad-label gutter).
  const cursorRef = useRef<HTMLDivElement>(null);
  const cellsAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state.seqPlaying) {
      if (cursorRef.current) cursorRef.current.style.display = 'none';
      return;
    }
    let raf: number;
    const tick = () => {
      // Fractional phase (continuous) instead of the integer step, so the
      // playhead interpolates smoothly between cells. left = offset + phase*cellW
      // already supports a fractional phase; width stays one cell wide.
      // getSeqCursorPhase counts STORED steps; the cells are columns.
      const phase = engine.getSeqCursorPhase() / stride;
      const el = cursorRef.current;
      const cells = cellsAreaRef.current;
      if (el && cells && phase >= 0 && stepCount > 0) {
        const cellW = cells.clientWidth / stepCount;
        // The cursor's LEADING edge tracks the audio clock's real position
        // (phase * cellW), so it sweeps all the way THROUGH the last step before
        // wrapping to 0 — it no longer freezes at the start of the final cell.
        // To avoid the cursor BODY poking past the grid (which would grow a
        // transient horizontal scrollbar on the overflow-x:auto body right before
        // each loop), clamp its WIDTH to the space remaining, not its position.
        const gridRight = cells.offsetLeft + cells.clientWidth;
        const left = Math.min(cells.offsetLeft + phase * cellW, gridRight - 2);
        el.style.display = 'block';
        el.style.left = `${left}px`;
        el.style.width = `${Math.min(cellW, gridRight - left)}px`;
        // 4K finish: the notes in the column the playhead just entered FIRE —
        // each lit cell flares and decays (luxe/hitFlash.ts). Once per column,
        // no React, inert on the classic finish.
        const col = Math.floor(phase) % stepCount;
        if (col !== lastCol) {
          lastCol = col;
          const body = el.parentElement;
          if (body) flashCells(onCellsInColumn(body, '.seq-cells', '.seq-cell', col));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    let lastCol = -1;
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.seqPlaying, stepCount, stride, engine]);

  // Static record cursor — just CSS-positioned, no animation needed.
  const recCursorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = recCursorRef.current;
    const cells = cellsAreaRef.current;
    if (!el) return;
    if (!state.recording || !cells || stepCount === 0) {
      el.style.display = 'none';
      return;
    }
    const cellW = cells.clientWidth / stepCount;
    el.style.display = 'block';
    el.style.left = `${cells.offsetLeft + (state.recordStep / stride) * cellW}px`;
    el.style.width = `${cellW}px`;
  }, [state.recording, state.recordStep, stepCount, stride]);

  const totalActiveHits = state.seqGrid.reduce((s, row) => s + (row?.length ?? 0), 0);

  const seqLetter = (i: number) => {
    // 0 = A, 25 = Z, then AA, AB, ...
    let s = '';
    let n = i;
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };

  return (
    <div className="seq">
      <div className="seq-tabs">
        {state.sequences.map((_p, i) => {
          const isCurrent = i === state.currentSeqIdx;
          const isPlaying = state.seqPlaying && i === state.playingSeqIdx;
          const isQueued = state.queuedSeqIdx === i;
          const cls = ['seq-tab',
            isCurrent ? 'on' : '',
            isPlaying ? 'playing' : '',
            isQueued ? 'queued' : '',
          ].filter(Boolean).join(' ');
          return (
            <button
              key={i}
              className={cls}
              onClick={() => onSelectSequence(i)}
              onContextMenu={e => { e.preventDefault(); if (state.sequences.length > 1) onDeleteSequence(i); }}
              title={
                isQueued ? `Sequence ${seqLetter(i)} — queued, plays at next loop boundary`
                : isPlaying ? `Sequence ${seqLetter(i)} — playing`
                : `Sequence ${seqLetter(i)} — click to switch · right-click to delete`
              }
            >
              {seqLetter(i)}
            </button>
          );
        })}
        {/* The shared SeqPager — same ◀ ▶ + ⧉ ✕ as the drum sequencer + bass roll. */}
        <span className="seq-tabs-gap" />
        <SeqPager index={state.currentSeqIdx} count={state.sequences.length}
          onSelect={onSelectSequence}
          onAdd={onAddSequence}
          onDuplicate={onDuplicateSequence}
          onDelete={() => { if (state.sequences.length > 1) onDeleteSequence(state.currentSeqIdx); }}
          lastDeleteHint="The last sequence can’t be deleted" />
      </div>
      <div className="seq-header">
        <div className="seq-titlewrap">
          <span className="seq-title">SEQUENCER</span>
          <span className="seq-count">
            {totalActiveHits} hits · {state.seqBars} bar{state.seqBars > 1 ? 's' : ''} · {stepCount} steps
          </span>
        </div>
        <div className="seq-actions">
          {state.seqPlaying
            ? <button className="btn-rec on" onClick={onStop} title="Stop the sequencer (SPACE)">■ STOP</button>
            : <button className="btn-rec" onClick={onPlay} title="Play the sequence — chops and drums start together (SPACE)">▶ PLAY</button>
          }
          <button
            className={`btn-rec seq-mode${state.seqLoop ? ' on' : ''}`}
            onClick={onToggleLoop}
            title="Loop the pattern when it reaches the end"
          >
            <span className="rec-dot">{state.seqLoop ? '●' : '○'}</span> LOOP
          </button>
          {state.recording
            ? <button className="btn-rec on" onClick={onStopRecord} title="Step record on — each pad hit fills the next step"><span className="rec-dot">●</span> STEP</button>
            : <button className="btn-rec" onClick={onStartRecord} title="Step record — each pad hit drops onto the next step (1/4, 1/8, … per the resolution)"><span className="rec-dot">○</span> STEP</button>
          }
          {(state.liveRecording || state.countInBeat >= 0)
            ? <button className="btn-rec on" onClick={onStopLiveRecord} title={state.countInBeat >= 0 ? 'Counting in… click to cancel' : 'Recording — click to stop recording; the loop keeps playing'}><span className="rec-dot">●</span> {state.countInBeat >= 0 ? state.countInBeat : 'REC'}</button>
            : <button className="btn-rec" onClick={onStartLiveRecord} title="Record — loop plays; play pads in time and they snap to the nearest line (set quantize with the resolution / TRIPS)"><span className="rec-dot">○</span> REC</button>
          }
          <button
            className={`btn-rec seq-mode${state.countInEnabled ? ' on' : ''}`}
            onClick={onToggleCountIn}
            title="Count-in — play a 1-bar metronome lead-in before LIVE recording arms"
          >
            <span className="rec-dot">{state.countInEnabled ? '●' : '○'}</span> CUE
          </button>
          <select
            className="ctrl-select seq-select"
            value={state.seqBars}
            onChange={e => onSetBars(Number(e.target.value))}
            title="Bars in the loop"
          >
            {BAR_OPTIONS.map(b => (
              <option key={b} value={b}>{b} BAR{b > 1 ? 'S' : ''}</option>
            ))}
          </select>
          <select
            className="ctrl-select seq-select"
            value={baseResolution(viewRes)}
            onChange={e => {
              const base = Number(e.target.value);
              // Keep triplet mode on if it's currently on (1/8 + TRIPS → pick
              // 1/16 → becomes 1/16T).
              onSetResolution(isTriplet(viewRes) ? Math.round(base * 1.5) : base);
            }}
            title="Grid / live-record quantize (where notes snap). Changing it never moves a note — notes between the lines show as ghosts"
          >
            {RES_OPTIONS.map(r => (
              <option key={r.value} value={r.value}>
                {r.label}{isTriplet(viewRes) ? 'T' : ''}
              </option>
            ))}
          </select>
          <button
            className={`btn-rec seq-mode${isTriplet(viewRes) ? ' on' : ''}`}
            // Disabled when the triplet grid wouldn't fit the column cap.
            disabled={!isTriplet(viewRes) && Math.round(baseResolution(viewRes) * 1.5) * state.seqBars > SEQ_MAX_VIEW_STEPS}
            onClick={() => {
              const base = baseResolution(viewRes);
              onSetResolution(isTriplet(viewRes) ? base : Math.round(base * 1.5));
            }}
            title="TRIPS — turn the current grid into its triplet (e.g. 1/16 → 1/16T) and back"
          >
            T
          </button>
          <button className="btn-clear tl-clear-btn" onClick={onClear} disabled={totalActiveHits === 0}
            title="Clear every step in this sequence — the pads and chops stay as they are">CLEAR</button>
        </div>
      </div>

      {visiblePads.length === 0 ? (
        <div className="seq-empty">Load a sample and create some chops to see step rows.</div>
      ) : (
        <div className="seq-body" style={{ '--step-count': stepCount } as React.CSSProperties}>
          {/* Step number ruler */}
          <div className="seq-ruler-row">
            <div className="seq-row-label" />
            <div ref={cellsAreaRef} className="seq-ruler" style={{ gridTemplateColumns: `repeat(${stepCount}, 1fr)` }}>
              {Array.from({ length: stepCount }, (_, s) => {
                const isBar = s % stepsPerBar === 0;
                const isBeat = s % stepsPerBeat === 0;
                return (
                  <div
                    key={s}
                    className={`seq-ruler-cell${isBar ? ' is-bar' : isBeat ? ' is-beat' : ''}`}
                  >
                    {isBar ? Math.floor(s / stepsPerBar) + 1 : ''}
                  </div>
                );
              })}
            </div>
          </div>

          {visiblePads.map(p => (
            <SeqRow
              key={p.index}
              pad={p}
              stepCount={stepCount}
              stride={stride}
              stepsPerBar={stepsPerBar}
              stepsPerBeat={stepsPerBeat}
              seqGrid={state.seqGrid}
              seqRevGrid={state.seqRevGrid}
              seqVelGrid={state.seqVelGrid}
              onSetStepVelocity={onSetStepVelocity}
              onToggleStep={onToggleStep}
              onClearStep={onClearStep}
              onMoveNote={onMoveNote}
            />
          ))}

          <div ref={cursorRef} className="seq-cursor" style={{ display: 'none' }} />
          <div ref={recCursorRef} className="seq-rec-cursor" style={{ display: 'none' }} />
          {state.countInBeat >= 0 && (
            <div key={state.countInBeat} className="seq-countin" aria-hidden>{state.countInBeat}</div>
          )}
        </div>
      )}
    </div>
  );
}

function SeqRow({
  pad, stepCount, stride, stepsPerBar, stepsPerBeat, seqGrid, seqRevGrid, seqVelGrid, onToggleStep, onClearStep, onSetStepVelocity, onMoveNote,
}: {
  pad: { index: number; color: string };
  /** Visible columns. */
  stepCount: number;
  /** Stored steps per column; the callbacks below take STORED steps. */
  stride: number;
  stepsPerBar: number;
  stepsPerBeat: number;
  seqGrid: number[][];
  seqRevGrid: boolean[][];
  /** Per-cell velocity (aligned with seqGrid; absent = 1). */
  seqVelGrid?: number[][];
  onToggleStep: (step: number, padIdx: number) => void;
  onClearStep: (step: number) => void;
  /** ALT-click a lit cell cycles its velocity 100 → 75 → 50 → 25 → 100 %. */
  onSetStepVelocity?: (step: number, padIdx: number, v: number) => void;
  onMoveNote: (fromStep: number, padIdx: number, toStep: number) => void;
}) {
  // Drag-to-move state. Only set while a mouse-button is down on a filled cell;
  // crossing DRAG_THRESHOLD pixels promotes the gesture from "maybe click" into
  // an actual drag, at which point the live preview kicks in.
  const cellsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ srcStep: number; previewStep: number; active: boolean } | null>(null);
  const DRAG_THRESHOLD = 4;

  const stepFromClientX = (clientX: number): number => {
    const el = cellsRef.current;
    if (!el || stepCount === 0) return -1;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left;
    const cellW = r.width / stepCount;
    return Math.max(0, Math.min(stepCount - 1, Math.floor(x / cellW)));
  };

  const handleCellMouseDown = (e: React.MouseEvent, s: number) => {
    if (e.button !== 0) return;
    const row = seqGrid[s * stride];
    const isFilled = !!row && row.includes(pad.index);
    e.preventDefault();
    // ALT-click on a lit cell = cycle its VELOCITY (100 → 75 → 50 → 25 → 100 %).
    if (isFilled && e.altKey && onSetStepVelocity) {
      const i = row!.indexOf(pad.index);
      const cur = seqVelGrid?.[s * stride]?.[i] ?? 1;
      const next = cur > 0.9 ? 0.75 : cur > 0.6 ? 0.5 : cur > 0.35 ? 0.25 : 1;
      onSetStepVelocity(s * stride, pad.index, next);
      return;
    }
    if (!isFilled) {
      // Empty cell — straight toggle (add).
      onToggleStep(s * stride, pad.index);
      return;
    }
    // Filled cell — could be a click (toggle off) or a drag (move). Defer
    // the decision until the user either moves past the threshold or
    // releases the button.
    const startX = e.clientX;
    let moved = false;
    setDrag({ srcStep: s, previewStep: s, active: false });
    const onMove = (mv: MouseEvent) => {
      if (!moved && Math.abs(mv.clientX - startX) < DRAG_THRESHOLD) return;
      moved = true;
      const tgt = stepFromClientX(mv.clientX);
      if (tgt < 0) return;
      setDrag(d => d && (d.previewStep === tgt && d.active) ? d : { srcStep: s, previewStep: tgt, active: true });
    };
    const onUp = (mv: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (moved) {
        const tgt = stepFromClientX(mv.clientX);
        if (tgt >= 0 && tgt !== s) onMoveNote(s * stride, pad.index, tgt * stride);
      } else {
        // No drag — treat as click → toggle the cell off.
        onToggleStep(s * stride, pad.index);
      }
      setDrag(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="seq-row">
      <div
        className="seq-row-label"
        style={{ borderLeftColor: pad.color, color: pad.color }}
        title={`Pad ${pad.index + 1}`}
      >
        {String(pad.index + 1).padStart(2, '0')}
      </div>
      <div
        ref={cellsRef}
        className="seq-cells"
        style={{ gridTemplateColumns: `repeat(${stepCount}, 1fr)` }}
      >
        {Array.from({ length: stepCount }, (_, s) => {
          const base = s * stride;
          const row = seqGrid[base];
          // While dragging, hide the source cell and show the preview at the
          // target step so the user sees the note "follow" their cursor.
          const dragOnAndActive = drag?.active === true;
          const isSourceHidden = dragOnAndActive && drag?.srcStep === s;
          const isPreview = dragOnAndActive && drag?.previewStep === s && drag?.srcStep !== s;
          const onStored = !!row && row.includes(pad.index);
          const on = (onStored || isPreview) && !isSourceHidden;
          const isBar = s % stepsPerBar === 0;
          const isBeat = s % stepsPerBeat === 0;
          // Notes for this pad living BETWEEN this column and the next — real,
          // audible, off-grid at this view. Drawn as a ghost mark instead of
          // vanishing when you zoom the grid out.
          let ghosts = 0;
          for (let k = 1; k < stride; k++) if (seqGrid[base + k]?.includes(pad.index)) ghosts++;
          // Per-cell reverse flag: lookup aligned position in seqRevGrid.
          let isReversed = false;
          let vel = 1;
          if (onStored && row) {
            const idx = row.indexOf(pad.index);
            isReversed = idx >= 0 && !!seqRevGrid?.[base]?.[idx];
            vel = idx >= 0 ? (seqVelGrid?.[base]?.[idx] ?? 1) : 1;
          }
          const soft = on && vel < 0.999;
          const cls = [
            'seq-cell',
            on ? 'on' : '',
            ghosts ? 'has-ghost' : '',
            isBar ? 'is-bar' : isBeat ? 'is-beat' : '',
            isPreview ? 'preview' : '',
            isSourceHidden ? 'src-hidden' : '',
            on && isReversed ? 'reversed' : '',
            soft ? 'soft' : '',
          ].filter(Boolean).join(' ');
          return (
            <div
              key={s}
              className={cls}
              style={on ? { background: pad.color, boxShadow: `0 0 6px ${pad.color}`, '--cell-led': pad.color, '--vel': vel } as CSSProperties : undefined}
              onMouseDown={e => handleCellMouseDown(e, s)}
              onContextMenu={e => {
                e.preventDefault();
                onClearStep(base);
              }}
              title={
                ghosts ? `${ghosts} off-grid note${ghosts > 1 ? 's' : ''} here — switch to a finer grid to edit`
                : on ? `${isReversed ? '◁ reversed · ' : ''}velocity ${Math.round(vel * 100)}% — ALT-click cycles 100 / 75 / 50 / 25, right-click clears the step` : undefined
              }
            >
              {on && isReversed ? <span className="seq-cell-rev">◁</span> : null}
              {soft ? <span className="seq-cell-vel">{Math.round(vel * 100)}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
