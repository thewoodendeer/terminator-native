// LOUDNESS & SPECTRUM — the popup behind the master strip's M / S / I / TP
// readout (desktop DAW mixer) and the phone MIXER screen's LUFS readout.
// Everything here is READ from a LoudnessSource: loudness from the BS.1770-4
// worklet, spectrum from its 8192-bin AnalyserNode. Painted per animation
// frame while open, nothing re-renders React except the header state.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LoudnessSource } from './MixerEngine';
import './MixerSection.css';

interface Props { source: LoudnessSource; onClose: () => void }

const dB = (lin: number) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);
const fmtLufs = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '−∞');
const fmtDb = (v: number, d = 1) => (Number.isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(d) : '−∞');

// Streaming delivery targets — the common denominators (Spotify/Apple/YouTube
// normalise around −14 LUFS integrated; −1 dBTP keeps codec overshoot clean).
const TARGET_I = -14;
const TARGET_TP = -1;

// Bands for the balance readout (Hz). Wide, musical splits — not a spec, a
// mix-check: sub/low, low-mid (mud), mid (body), hi-mid (presence), air.
const BANDS: Array<[string, number, number]> = [
  ['SUB', 20, 60], ['LOW', 60, 150], ['LO-MID', 150, 500], ['MID', 500, 2000], ['HI-MID', 2000, 6000], ['AIR', 6000, 20000],
];

export function LoudnessPopup({ source, onClose }: Props) {
  const specRef = useRef<HTMLCanvasElement | null>(null);
  const numRefs = useRef<Record<string, HTMLElement | null>>({});
  const [tilt, setTilt] = useState(true);   // pink-tilt: a balanced mix reads FLAT
  const [hold, setHold] = useState(true);   // peak-hold trace on the spectrum
  const tiltRef = useRef(tilt); tiltRef.current = tilt;
  const holdRef = useRef(hold); holdRef.current = hold;
  const [exact, setExact] = useState(() => source.updateLoudness().worklet);

  useEffect(() => {
    const an = source.spectrum;
    const bins = an.frequencyBinCount;
    const data = new Float32Array(bins);
    const peakTrace = new Float32Array(bins).fill(-200);
    const sr = an.context.sampleRate;
    const fMin = 20, fMax = Math.min(20000, sr / 2);
    let raf = 0;
    const set = (k: string, v: string) => { const el = numRefs.current[k]; if (el && el.textContent !== v) el.textContent = v; };

    const paint = () => {
      const lu = source.updateLoudness();
      setExact(prev => (prev === lu.worklet ? prev : lu.worklet));
      set('m', fmtLufs(lu.m)); set('s', fmtLufs(lu.s)); set('i', fmtLufs(lu.i));
      set('lra', lu.lra.toFixed(1));
      set('tpl', fmtDb(dB(lu.tpL))); set('tpr', fmtDb(dB(lu.tpR)));
      set('tpmax', fmtDb(dB(lu.holdTp))); set('pkmax', fmtDb(dB(lu.holdPeak)));
      set('maxm', fmtLufs(lu.maxM)); set('maxs', fmtLufs(lu.maxS));
      const plr = Number.isFinite(lu.i) && lu.holdTp > 0 ? dB(lu.holdTp) - lu.i : NaN;
      set('plr', Number.isFinite(plr) ? plr.toFixed(1) : '—');
      set('corr', (lu.corr >= 0 ? '+' : '') + lu.corr.toFixed(2));
      const dI = Number.isFinite(lu.i) ? lu.i - TARGET_I : NaN;
      set('di', Number.isFinite(dI) ? `${dI > 0 ? '+' : ''}${dI.toFixed(1)} LU ${dI > 0 ? 'over' : 'under'} −14` : 'play to measure');
      const tpDb = dB(lu.holdTp);
      set('dtp', Number.isFinite(tpDb) ? (tpDb > TARGET_TP ? `${(tpDb - TARGET_TP).toFixed(1)} dB over −1 dBTP` : 'under −1 dBTP ✓') : '—');
      // correlation bar
      const cb = numRefs.current['corrbar'];
      if (cb) cb.style.left = `${((lu.corr + 1) / 2) * 100}%`;
      // headline colour classes
      const iEl = numRefs.current['i']; if (iEl) iEl.className = 'lp-big ' + (Number.isFinite(dI) ? (Math.abs(dI) <= 1 ? 'ok' : dI > 0 ? 'hot' : 'low') : '');
      const tEl = numRefs.current['tpmax']; if (tEl) tEl.className = 'lp-big ' + (Number.isFinite(tpDb) ? (tpDb > TARGET_TP ? 'hot' : 'ok') : '');

      // spectrum
      const cv = specRef.current;
      if (cv) {
        const W = cv.clientWidth, H = cv.clientHeight;
        if (cv.width !== W * devicePixelRatio || cv.height !== H * devicePixelRatio) { cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio; }
        const ctx = cv.getContext('2d')!;
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        an.getFloatFrequencyData(data);
        const cs = getComputedStyle(cv);
        const accent = cs.getPropertyValue('--hw-accent').trim() || '#35ff69';
        const muted = cs.getPropertyValue('--hw-muted').trim() || '#6c7a8c';
        ctx.clearRect(0, 0, W, H);
        const top = -0, bot = -90; // dB axis
        const xOf = (f: number) => (Math.log(f / fMin) / Math.log(fMax / fMin)) * W;
        const yOf = (d: number) => H - ((d - bot) / (top - bot)) * H;
        // grid
        ctx.strokeStyle = 'rgba(128,140,160,0.18)'; ctx.fillStyle = muted; ctx.font = '9px ui-monospace, monospace'; ctx.lineWidth = 1;
        for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
          if (f < fMin || f > fMax) continue;
          const x = xOf(f); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
          ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, H - 3);
        }
        for (let d = -80; d < 0; d += 20) { const y = yOf(d); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(`${d}`, 2, y - 2); }
        // curve — per pixel column, max of the bins in it (log axis packs many
        // bins per column up top and <1 per column at the bottom: interpolate)
        const useTilt = tiltRef.current;
        const tiltDb = (f: number) => (useTilt ? 10 * Math.log10(f / 1000) : 0); // +3 dB/oct → pink reads flat
        const col = new Float32Array(W).fill(-200);
        for (let b = 1; b < bins; b++) {
          const f = (b * sr) / (2 * bins); if (f < fMin || f > fMax) continue;
          const v = data[b] + tiltDb(f);
          const x = Math.min(W - 1, Math.max(0, Math.floor(xOf(f))));
          if (v > col[x]) col[x] = v;
          if (holdRef.current) { if (v > peakTrace[b]) peakTrace[b] = v; else peakTrace[b] -= 0.15; }
        }
        // fill gaps (low end) by linear interpolation
        let last = -1;
        for (let x = 0; x < W; x++) {
          if (col[x] > -199) { if (last >= 0 && x - last > 1) { for (let k = last + 1; k < x; k++) col[k] = col[last] + ((col[x] - col[last]) * (k - last)) / (x - last); } last = x; }
        }
        // hold trace
        if (holdRef.current) {
          ctx.strokeStyle = 'rgba(231,169,119,0.55)'; ctx.beginPath(); let started = false;
          for (let b = 1; b < bins; b++) { const f = (b * sr) / (2 * bins); if (f < fMin || f > fMax) continue; const x = xOf(f), y = yOf(Math.max(bot, peakTrace[b])); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
          ctx.stroke();
        }
        // main curve + fill
        ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x < W; x++) ctx.lineTo(x, yOf(Math.max(bot, col[x])));
        ctx.lineTo(W, H); ctx.closePath();
        const hex6 = /^#[0-9a-f]{6}$/i.test(accent);
        const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, hex6 ? accent + 'cc' : accent); g.addColorStop(1, hex6 ? accent + '11' : accent);
        ctx.globalAlpha = hex6 ? 1 : 0.35; ctx.fillStyle = g; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = accent; ctx.lineWidth = 1.2; ctx.beginPath();
        for (let x = 0; x < W; x++) { const y = yOf(Math.max(bot, col[x])); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        ctx.stroke();
        // reference line for a balanced mix (flat when tilted)
        if (useTilt) { ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(231,169,119,0.35)'; const y = yOf(-30); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]); }
        // band balance: mean (tilted) energy per band, shown relative to the
        // loudest band → 0 dB is the loudest, the rest read how far under
        const bandVals = BANDS.map(([, lo, hi]) => {
          let sum = 0, n = 0;
          for (let b = 1; b < bins; b++) { const f = (b * sr) / (2 * bins); if (f < lo || f >= hi) continue; sum += Math.pow(10, (data[b] + tiltDb(f)) / 10); n++; }
          return n ? 10 * Math.log10(sum / n) : -Infinity;
        });
        const bmax = Math.max(...bandVals);
        BANDS.forEach(([name], k) => {
          const v = bandVals[k] - bmax;
          set(`band-${name}`, Number.isFinite(v) ? (v > -0.05 ? '0.0' : v.toFixed(1)) : '—');
          const bar = numRefs.current[`bandbar-${name}`];
          if (bar) bar.style.height = `${Number.isFinite(v) ? Math.max(4, 100 + Math.max(-40, v) * 2.4) : 4}%`;
        });
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [source]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const R = (k: string) => (el: HTMLElement | null) => { numRefs.current[k] = el; };

  return createPortal(
    <div className="lp-backdrop" onPointerDown={onClose}>
      <div className="lp-panel" role="dialog" aria-label="Loudness and spectrum" onPointerDown={e => e.stopPropagation()}>
        <div className="lp-head">
          <span className="lp-title">MASTER · LOUDNESS &amp; SPECTRUM</span>
          <span className={`lp-tag ${exact ? 'ok' : 'warn'}`} title={exact ? 'ITU-R BS.1770-4 / EBU R128 meter running on the audio thread' : 'AudioWorklet unavailable — approximate meter'}>{exact ? 'BS.1770-4' : 'APPROX'}</span>
          <button className="lp-btn" onClick={() => source.resetIntegrated()} title="Reset integrated loudness, LRA and the peak holds — do it at the top of the track">⟳ RESET</button>
          <button className="lp-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="lp-grid">
          <div className="lp-cell">
            <div className="lp-k" title="MOMENTARY — the last 400 ms. What it feels like right now">MOMENTARY</div>
            <div className="lp-big" ref={R('m')}>−∞</div><div className="lp-u">LUFS · max <span ref={R('maxm')}>−∞</span></div>
          </div>
          <div className="lp-cell">
            <div className="lp-k" title="SHORT-TERM — the last 3 seconds. Section-level loudness">SHORT-TERM</div>
            <div className="lp-big" ref={R('s')}>−∞</div><div className="lp-u">LUFS · max <span ref={R('maxs')}>−∞</span></div>
          </div>
          <div className="lp-cell lp-cell-i">
            <div className="lp-k" title="INTEGRATED — the whole take since RESET, gated per BS.1770 (silence and quiet passages don't drag it down). This is the number streaming services normalise to.">INTEGRATED</div>
            <div className="lp-big" ref={R('i')}>−∞</div><div className="lp-u">LUFS · <span ref={R('di')}>play to measure</span></div>
          </div>
          <div className="lp-cell">
            <div className="lp-k" title="TRUE PEAK — the highest inter-sample peak since RESET (4× oversampled). Streaming wants ≤ −1 dBTP so the codec doesn't clip">TRUE PEAK</div>
            <div className="lp-big" ref={R('tpmax')}>−∞</div><div className="lp-u">dBTP · L <span ref={R('tpl')}>−∞</span> R <span ref={R('tpr')}>−∞</span> · <span ref={R('dtp')}>—</span></div>
          </div>
          <div className="lp-cell">
            <div className="lp-k" title="LOUDNESS RANGE — how much the loudness moves across the take (EBU R128). Trap/hip-hop masters sit around 3–7 LU; a big range reads as dynamic, a tiny one as flat">LRA</div>
            <div className="lp-big" ref={R('lra')}>0.0</div><div className="lp-u">LU · sample peak <span ref={R('pkmax')}>−∞</span> dBFS</div>
          </div>
          <div className="lp-cell">
            <div className="lp-k" title="PEAK-TO-LOUDNESS RATIO — true peak minus integrated. Under ~8 dB the master is dense/limited; over ~14 dB it has room. Neither is wrong, it says what you have">PLR</div>
            <div className="lp-big" ref={R('plr')}>—</div><div className="lp-u">dB · dynamics</div>
          </div>
        </div>

        <div className="lp-corr" title="STEREO CORRELATION — +1 = mono-compatible, 0 = wide/uncorrelated, negative = out of phase (bass will vanish on a mono system)">
          <span className="lp-k">PHASE / CORRELATION</span>
          <div className="lp-corr-track"><span className="lp-corr-neg">−1</span><span className="lp-corr-zero">0</span><span className="lp-corr-pos">+1</span><div className="lp-corr-dot" ref={R('corrbar')} /></div>
          <span className="lp-corr-val" ref={R('corr')}>+1.00</span>
        </div>

        <div className="lp-spec-head">
          <span className="lp-k">SPECTRUM · master out · 8192-pt</span>
          <button className={`lp-btn ${tilt ? 'on' : ''}`} onClick={() => setTilt(t => !t)} title="PINK TILT: +3 dB/octave, so a balanced full-range mix reads FLAT and pink noise is a straight line. Off = raw FFT (falls to the right by nature)">TILT {tilt ? 'ON' : 'OFF'}</button>
          <button className={`lp-btn ${hold ? 'on' : ''}`} onClick={() => setHold(h => !h)} title="Peak-hold trace (slow decay) — shows where the loudest moments sat">HOLD {hold ? 'ON' : 'OFF'}</button>
        </div>
        <canvas ref={specRef} className="lp-spec" />
        <div className="lp-bands" title="BAND BALANCE — average energy per band with the tilt applied, relative to the loudest band. Balanced mixes land within a few dB of each other; a −12 LOW next to a 0 MID is a thin mix, a 0 SUB with everything else at −10 is a boomy one">
          {BANDS.map(([name]) => (
            <div className="lp-band" key={name}>
              <div className="lp-band-bar"><div className="lp-band-fill" ref={R(`bandbar-${name}`)} /></div>
              <div className="lp-band-v" ref={R(`band-${name}`)}>—</div>
              <div className="lp-band-n">{name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
