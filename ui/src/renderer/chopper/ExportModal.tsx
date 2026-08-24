/**
 * THE EXPORT DIALOG (Phase 4.5i) — one popup with every option, the way Ableton's Export Audio box works: you say
 * WHAT to render, then HOW to write it, then Export. Trackouts are one of the things you can render, not a separate
 * button somewhere else — that was Victor's whole point.
 *
 * What renders the audio is unchanged: the page's arrangement exporter, which is the only thing that knows the Beat
 * Finisher arrangement. The dialog adds three things on top:
 *   • MP3, by handing the rendered file to the shell to re-encode (`terminatorExport {verb:'transcode'}`) — same
 *     audio, same app-parity dither, no second render path;
 *   • a real CANCEL: `shouldCancel` is polled at every progress point and aborts BEFORE anything is written, so a
 *     cancelled export never leaves a partial file behind;
 *   • progress with the stage label the renderer reports.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EXPORT_FORMATS, ExportFormat } from './exporters/formats';
import { isNative, native } from '../native/juceBridge';

/** The targets whose bytes the user opens, so they may be FLAC or MP3. An MPC project or a Drum Rack is read by a
 *  sampler that parses WAV headers — those stay WAV whatever is asked for. */
const AUDIO_CHOICE_TARGETS = new Set<ExportFormat>(['master-wav', 'wav-stems']);

export type ExportAudioFormat = 'wav' | 'flac' | 'mp3';

export interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  /** Runs the export. `shouldCancel` is polled by the renderer; throwing ExportCancelled is treated as "cancelled". */
  onRun: (
    format: ExportFormat,
    audioFormat: 'wav' | 'flac',
    onProgress: (pct: number) => void,
    shouldCancel: () => boolean,
    bitDepth: 16 | 24,
  ) => Promise<string>;
  /** False while no audio is loaded — Export stays disabled and says why. */
  canExport: boolean;
  /** The project's own rate, shown for information. There is no rate CONTROL: the arrangement renders at the
   *  loaded track's rate, and offering a menu that silently resampled (or did nothing) would be worse than saying so. */
  sampleRate?: number;
}

export default function ExportModal({ open, onClose, onRun, canExport, sampleRate }: ExportModalProps): React.ReactElement | null {
  const [target, setTarget] = useState<ExportFormat>('master-wav');
  const [audio, setAudio] = useState<ExportAudioFormat>('wav');
  const [depth, setDepth] = useState<16 | 24>(16);
  const [kbps, setKbps] = useState(320);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const meta = EXPORT_FORMATS.find(f => f.value === target);
  const canChooseAudio = AUDIO_CHOICE_TARGETS.has(target);
  const mp3Available = isNative(); // the encoder lives in the shell
  const effectiveAudio: ExportAudioFormat = canChooseAudio ? audio : 'wav';
  // MP3 is always 16-bit source material; the page's FLAC encoder is 16-bit only, so a 24-bit FLAC has to be written
  // by the shell (render 24-bit WAV, then transcode) — which means it needs the desktop app.
  const canChoose24 = canChooseAudio && effectiveAudio !== 'mp3' && (effectiveAudio === 'wav' || isNative());
  const effectiveDepth: 16 | 24 = canChoose24 ? depth : 16;
  // WAV 24 is written by the page; FLAC 24 goes through the shell's writer; MP3 always does
  const needsTranscode = effectiveAudio === 'mp3' || (effectiveAudio === 'flac' && effectiveDepth === 24);

  // Escape closes when nothing is running; while a render is going it cancels instead of leaving it orphaned.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (busy) cancelRef.current = true;
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  useEffect(() => { if (open) { setMsg(null); setPct(null); } }, [open]);

  const run = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    setPct(0);
    cancelRef.current = false;
    // let React paint the disabled/progress state before the render blocks the main thread
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    try {
      // MP3 renders as WAV first and is re-encoded by the shell — one render path, and the MP3 carries the same
      // samples the WAV would have.
      const rendered = needsTranscode ? 'wav' : effectiveAudio;
      const status = await onRun(target, rendered, p => setPct(p), () => cancelRef.current, effectiveDepth);
      if (needsTranscode) {
        setPct(97);
        // the REAL path the shell just wrote — never scraped out of the status text, which is prose
        const { lastNativeSavePaths } = await import('../lib/download');
        const from = lastNativeSavePaths()[0] ?? null;
        if (!from) {
          setMsg(`Exported as WAV — could not find the file to convert to ${effectiveAudio.toUpperCase()}.`);
        } else {
          const r = await native.exportProject({
            verb: 'transcode', from, to: from, format: effectiveAudio, bitDepth: effectiveDepth, mp3Kbps: kbps,
          });
          setMsg(r?.ok
            ? `Exported ${String(r.path ?? '').split(/[\\/]/).pop()}`
            : `${effectiveAudio.toUpperCase()} failed: ${r?.error ?? 'unknown'}`);
          if (r?.ok) await native.fs({ verb: 'trash', path: from }); // the intermediate WAV is not a deliverable
        }
      } else {
        setMsg(status);
      }
      setPct(100);
    } catch (e: unknown) {
      const err = e as Error;
      if (err?.name === 'ExportCancelled') setMsg('Cancelled — nothing was written.');
      else setMsg(`Export failed: ${err?.message ?? String(e)}`);
    } finally {
      setBusy(false);
      cancelRef.current = false;
    }
  }, [target, effectiveAudio, effectiveDepth, needsTranscode, kbps, onRun]);

  if (!open) return null;

  return (
    <div className="export-modal-backdrop" role="dialog" aria-modal="true" aria-label="Export"
         onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="export-modal">
        <div className="export-modal-head">
          <h2>EXPORT</h2>
          <button className="export-modal-x" onClick={onClose} disabled={busy} title="Close (Esc)">×</button>
        </div>

        <div className="export-modal-body">
          <section className="export-group">
            <h3>Rendered Track</h3>
            <div className="export-targets">
              {EXPORT_FORMATS.map(f => (
                <button key={f.value} type="button" disabled={busy || !f.available}
                        className={`export-target${target === f.value ? ' on' : ''}`}
                        onClick={() => { setTarget(f.value); setMsg(null); }}>
                  <span className="export-target-label">{f.label}</span>
                  <span className="export-target-desc">{f.description}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="export-group">
            <h3>File</h3>
            <div className="export-row">
              <span className="export-row-label">Format</span>
              <span className="export-seg" title={canChooseAudio
                ? 'WAV and FLAC hold identical samples — FLAC is lossless and about half the size. MP3 is lossy, for sharing.'
                : 'This export writes audio for a sampler that reads WAV headers (MPC project, Drum Rack), so it is always WAV.'}>
                {(['wav', 'flac', 'mp3'] as const).map(f => (
                  <button key={f} type="button"
                          className={`export-seg-btn${effectiveAudio === f ? ' on' : ''}`}
                          disabled={busy || !canChooseAudio || (f === 'mp3' && !mp3Available)}
                          onClick={() => { setAudio(f); setMsg(null); }}>
                    {f.toUpperCase()}
                  </button>
                ))}
              </span>
            </div>
            {effectiveAudio !== 'mp3' && (
              <div className="export-row">
                <span className="export-row-label">Bit depth</span>
                <span className="export-seg" title={canChoose24
                  ? '24-bit keeps more headroom for further mixing or mastering. 16-bit is the deliverable — dithered, and what a CD or a streaming upload wants.'
                  : '24-bit FLAC is written by the desktop app; in the browser FLAC is 16-bit.'}>
                  {([16, 24] as const).map(d => (
                    <button key={d} type="button"
                            className={`export-seg-btn${effectiveDepth === d ? ' on' : ''}`}
                            disabled={busy || !canChooseAudio || (d === 24 && !canChoose24)}
                            onClick={() => { setDepth(d); setMsg(null); }}>
                      {d}-BIT
                    </button>
                  ))}
                </span>
              </div>
            )}
            {effectiveAudio === 'mp3' && (
              <div className="export-row">
                <span className="export-row-label">Bitrate</span>
                <select className="ctrl-select" value={kbps} disabled={busy}
                        onChange={e => setKbps(Number(e.target.value))}>
                  {[128, 192, 256, 320].map(b => <option key={b} value={b}>{b} kbps</option>)}
                </select>
              </div>
            )}
            <p className="export-note">
              {effectiveAudio === 'flac' && 'Lossless — the same samples as the WAV, about half the size.'}
              {effectiveAudio === 'mp3' && !mp3Available && 'MP3 needs the desktop app.'}
              {effectiveAudio === 'mp3' && mp3Available && 'Rendered as WAV, then encoded — same audio, smaller file.'}
              {effectiveAudio === 'wav' && effectiveDepth === 16 && 'Dithered on the way down to 16-bit.'}
              {effectiveAudio === 'wav' && effectiveDepth === 24 && 'No dither needed at 24-bit.'}
            </p>
            {sampleRate ? (
              <p className="export-note">
                Sample rate {(sampleRate / 1000).toFixed(1)} kHz — the project's own rate. Exports never resample.
              </p>
            ) : null}
          </section>
        </div>

        <div className="export-modal-foot">
          {pct !== null && (
            <div className="export-progress-wrap">
              <div className="export-progress-track"><div className="export-progress-fill" style={{ width: `${pct}%` }} /></div>
              <div className="export-progress-label">{busy ? `Rendering… ${pct}%` : `${pct}%`}</div>
            </div>
          )}
          {msg && <span className="export-status">{msg}</span>}
          <div className="export-modal-actions">
            {busy
              ? <button className="btn" onClick={() => { cancelRef.current = true; }}>CANCEL</button>
              : <button className="btn" onClick={onClose}>CLOSE</button>}
            <button className="btn btn-export-run" disabled={busy || !canExport || !meta?.available} onClick={run}>
              {busy ? 'EXPORTING…' : '⬇ EXPORT'}
            </button>
          </div>
          {!canExport && <span className="export-hint">Load a track first.</span>}
        </div>
      </div>
    </div>
  );
}

