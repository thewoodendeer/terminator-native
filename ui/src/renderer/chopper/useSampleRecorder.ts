// RECORD SAMPLE — the phone/web recorder as a hook. The default microphone /
// plugged-in input (getUserMedia) → MediaRecorder (PCM webm where it exists,
// audio/mp4 on Safari) → decode → 16-bit WAV → `onTake(file)`. The caller
// loads the File the way it loads any dropped file (the asset store keeps it
// with the project). The desktop ChopperView has its own richer panel (input
// picker + System Audio); this hook is the HardwareView's — and it carries the
// phone-sized version of the input picker: `inputs` / `inputId` / `setInput`.
//
// iOS/iPadOS device rules the picker is built around: device ids and labels
// are HIDDEN until mic permission is granted once, so the list is enumerated
// blind on mount (usually empty of usable entries), and re-enumerated after
// every successful getUserMedia — the first take records the system default
// (a plugged-in class-compliant interface IS the default on iPadOS), and from
// then on the real names are known and selectable. `devicechange` keeps the
// list live while an interface is plugged in/out.
import { useEffect, useRef, useState } from 'react';
import { encodeWAV } from '../audio/StemExporter';
import { recordAudioConstraints } from './recordConstraints';

export type RecorderState = 'idle' | 'recording' | 'saving';

export type RecorderInput = { id: string; name: string };

export function useSampleRecorder(opts: { onTake: (file: File) => Promise<void> | void; onError: (msg: string) => void }) {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0); // 0..1 input RMS, ~10 Hz for the button's meter
  // Input picker: the named audioinput devices (empty until permission has
  // been granted once — iOS hides them), and the chosen one (null = default).
  const [inputs, setInputs] = useState<RecorderInput[]>([]);
  const [inputId, setInputId] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const startMsRef = useRef(0);
  const optsRef = useRef(opts); optsRef.current = opts;

  // List the real inputs (mic / interface channels). Same filter as the
  // desktop panel: named audioinput devices, minus the 'default' alias.
  const refreshInputs = async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setInputs(all
        .filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.label)
        .map(d => ({ id: d.deviceId, name: d.label })));
    } catch { /* not supported / blocked — the default input still records */ }
  };
  // Blind first pass (fills in only if permission was granted in a past
  // session) + follow plug-in/out while mounted.
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    void refreshInputs();
    const on = () => { void refreshInputs(); };
    md.addEventListener?.('devicechange', on);
    return () => md.removeEventListener?.('devicechange', on);
  }, []);

  const stopMeter = () => {
    cancelAnimationFrame(rafRef.current);
    try { void meterCtxRef.current?.close(); } catch { /* */ }
    meterCtxRef.current = null;
  };
  const releaseStream = () => {
    try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* */ }
    streamRef.current = null;
  };

  const finalize = async () => {
    stopMeter();
    const chunks = chunksRef.current; chunksRef.current = []; recRef.current = null;
    releaseStream();
    if (chunks.length === 0) { setState('idle'); return; }
    setState('saving');
    let tmp: AudioContext | null = null;
    try {
      const raw = await new Blob(chunks).arrayBuffer();
      tmp = new AudioContext();
      const decoded = await tmp.decodeAudioData(raw);
      const wav = encodeWAV(decoded, 24);
      const d = new Date(); const p = (n: number) => n.toString().padStart(2, '0');
      const name = `recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.wav`;
      await optsRef.current.onTake(new File([wav], name, { type: 'audio/wav' }));
    } catch (e: any) {
      optsRef.current.onError(`Recording failed: ${e?.message ?? String(e)}`);
    } finally {
      try { void tmp?.close(); } catch { /* */ }
      setState('idle');
    }
  };

  const start = async () => {
    if (state !== 'idle') return;
    try {
      const md = navigator.mediaDevices;
      if (!md?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Recording is not supported in this browser');
      // The picked input, else the system default — both asked for RAW (no echo
      // cancel / noise gate / auto gain, stereo if offered; recordConstraints.ts —
      // unsupported keys are ignored by a UA, so iOS Safari still opens its mic).
      // `exact` + fallback: an unplugged interface must fall back to the default
      // mic, not fail the take (the list is refreshed below, so the stale pick
      // clears itself).
      let stream: MediaStream;
      try {
        stream = await md.getUserMedia({ audio: recordAudioConstraints(inputId || null, null) });
      } catch (err) {
        if (!inputId) throw err;
        setInputId(null);
        stream = await md.getUserMedia({ audio: recordAudioConstraints(null, null) });
      }
      streamRef.current = stream;
      // Permission is granted now → the real device names are visible.
      void refreshInputs();
      const mimeType = ['audio/webm;codecs=pcm', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']
        .find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } });
      const mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recRef.current = mr; chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => { void finalize(); };
      mr.start();
      startMsRef.current = performance.now();
      setElapsed(0); setState('recording');
      // Input level + elapsed — listen-only analyser, never routed to the speakers.
      try {
        const ctx = new AudioContext();
        meterCtxRef.current = ctx;
        const an = ctx.createAnalyser(); an.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(an);
        const data = new Uint8Array(an.frequencyBinCount);
        let lastSec = -1, lastLv = 0;
        const tick = () => {
          an.getByteFrequencyData(data);
          let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
          const rms = Math.min(1, (Math.sqrt(sum / data.length) / 255) * 1.6);
          const t = performance.now();
          const sec = Math.floor((t - startMsRef.current) / 1000);
          if (sec !== lastSec) { lastSec = sec; setElapsed(sec); }
          if (t - lastLv > 100) { lastLv = t; setLevel(rms); }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch { /* meter is cosmetic */ }
    } catch (e: any) {
      releaseStream(); recRef.current = null; stopMeter();
      setState('idle');
      const msg = e?.name === 'NotAllowedError' ? 'Microphone access was denied — allow it in the browser/site settings and try again' : `Recording failed: ${e?.message ?? String(e)}`;
      optsRef.current.onError(msg);
    }
  };

  const stop = () => {
    const mr = recRef.current;
    if (mr && mr.state !== 'inactive') mr.stop(); // onstop → finalize
    else { releaseStream(); stopMeter(); setState('idle'); }
  };

  // Unmount mid-take: drop everything, keep the mic from staying hot.
  useEffect(() => () => {
    try { const mr = recRef.current; if (mr && mr.state !== 'inactive') { mr.onstop = null; mr.stop(); } } catch { /* */ }
    releaseStream(); stopMeter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  return { state, elapsed, level, start, stop, supported, inputs, inputId, setInput: setInputId };
}
