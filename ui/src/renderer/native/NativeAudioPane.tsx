/**
 * NativeAudioPane — Preferences → AUDIO for the native app (Terminator 3.0), Ableton's layout (plan B7/B9,
 * Victor's call): Driver Type · Input Device · Output Device · Sample Rate · Buffer Size · Apply / Default ·
 * Input Config / Output Config (every channel, Enable all) · Latencies (reported + MEASURED round trip with
 * the driver-error compensation) · Measure · Test Tone · CPU / xruns. Everything talks to the C++ AudioIO
 * through the bridge (`terminatorAudio`, docs/native/BRIDGE-PROTOCOL.md); the Phase-1 static page did the
 * same in plain JS — this is that page as a React pane.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { native, onNativeEvent } from './juceBridge';

type Device = {
  type: string; inputDevice: string; outputDevice: string; sampleRate: number; bufferSize: number; inputs: number; outputs: number;
  inputLatencySamples: number; outputLatencySamples: number; inputLatencyMs: number; outputLatencyMs: number; open: boolean; error: string;
  inputChannelNames: string[]; outputChannelNames: string[]; activeInputChannels: number[]; activeOutputChannels: number[];
  availableSampleRates: number[]; availableBufferSizes: number[]; xruns: number; cpuLoad: number;
  calibrationSamples: number; calibrationMs: number; calibrationReportedSamples: number;
};
type AudioReply = { ok: boolean; error?: string; deviceTypes: string[]; currentType: string; listType: string; inputDevices: string[]; outputDevices: string[]; device: Device };

const card: CSSProperties = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '12px 14px', marginBottom: 12 };
const label: CSSProperties = { display: 'block', color: 'var(--text-dim)', fontSize: 11, letterSpacing: 1, marginBottom: 5, textTransform: 'uppercase' };
const row: CSSProperties = { marginBottom: 12 };
const selectStyle: CSSProperties = { width: '100%', background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 13 };
const hint: CSSProperties = { color: 'var(--text-dim)', fontSize: 11, marginTop: 5, lineHeight: 1.4 };
const btn: CSSProperties = { background: 'var(--bg3)', color: 'var(--neon)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 };
const chip = (on: boolean): CSSProperties => ({ display: 'inline-block', margin: '2px 4px 2px 0', padding: '3px 7px', borderRadius: 3, cursor: 'pointer', fontSize: 11, border: `1px solid ${on ? 'var(--neon)' : 'var(--border)'}`, color: on ? 'var(--neon)' : 'var(--text-dim)', background: on ? 'rgba(0,255,150,0.08)' : 'transparent', userSelect: 'none' });

export default function NativeAudioPane() {
  const [reply, setReply] = useState<AudioReply | null>(null);
  const [type, setType] = useState('');
  const [inDev, setInDev] = useState('');
  const [outDev, setOutDev] = useState('');
  const [rate, setRate] = useState(0);
  const [buf, setBuf] = useState(0);
  const [inOn, setInOn] = useState<number[]>([]);
  const [outOn, setOutOn] = useState<number[]>([]);
  const [calOut, setCalOut] = useState(0);
  const [calIn, setCalIn] = useState(0);
  const [calMsg, setCalMsg] = useState('cable an output to an input, then Measure');
  const [toneOn, setToneOn] = useState(false);
  const [tonePair, setTonePair] = useState(0);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState<{ cpuLoad: number; xruns: number; calibrationState: number; calibrationSamples: number; calibrationMs: number } | null>(null);

  const adopt = useCallback((r: AudioReply) => {
    setReply(r);
    const d = r.device;
    setType(r.listType || r.currentType || d.type);
    setInDev(d.inputDevice ?? '');
    setOutDev(d.outputDevice ?? '');
    setRate(d.sampleRate || 0);
    setBuf(d.bufferSize || 0);
    setInOn(d.activeInputChannels ?? []);
    setOutOn(d.activeOutputChannels ?? []);
  }, []);

  const refresh = useCallback(async (req: Record<string, unknown> = { verb: 'list' }) => {
    setBusy(true);
    try { const r = (await native.audio(req)) as AudioReply; adopt(r); return r; }
    catch (e) { console.warn('[prefs] audio', e); return null; }
    finally { setBusy(false); }
  }, [adopt]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => onNativeEvent('terminator.devicesChanged', () => { void refresh(); }), [refresh]);
  useEffect(() => onNativeEvent('terminator.snapshot', (s: any) => {
    setSnap({ cpuLoad: s.cpuLoad ?? 0, xruns: s.xruns ?? 0, calibrationState: s.calibrationState ?? 0, calibrationSamples: s.calibrationSamples ?? -1, calibrationMs: s.calibrationMs ?? -1 });
    if (s.calibrationState === 2 && s.calibrationSamples >= 0) setCalMsg(`✓ round trip ${s.calibrationSamples} samples = ${Number(s.calibrationMs).toFixed(2)} ms`);
    else if (s.calibrationSamples === -3) setCalMsg('✗ nothing heard on that input (check the cable / input channel)');
    else if (s.calibrationSamples === -2) setCalMsg('✗ channel out of range');
  }), []);

  const d = reply?.device;
  const toggle = (list: number[], set: (v: number[]) => void, i: number) => set(list.includes(i) ? list.filter(x => x !== i) : [...list, i].sort((a, b) => a - b));
  const apply = () => void refresh({ verb: 'apply', deviceType: type, inputDevice: inDev, outputDevice: outDev, sampleRate: rate || 0, bufferSize: buf || 0, inputChannels: inOn, outputChannels: outOn });
  const measure = async () => {
    setCalMsg('measuring… (1 s)');
    const r = await native.audio({ verb: 'calibrate', outputChannel: calOut, inputChannel: calIn });
    if (!r?.ok) setCalMsg('✗ ' + (r?.error ?? 'failed'));
  };
  const tone = (on: boolean, pair = tonePair) => { setToneOn(on); void native.command({ type: 'setTestTone', enabled: on, frequencyHz: 440, amplitude: 0.25, outputPair: pair }); };
  const pairs = Array.from({ length: Math.max(1, Math.ceil((d?.outputChannelNames.length ?? 2) / 2)) }, (_, i) => i);

  return (
    <>
      <div style={card}>
        <div style={row}>
          <label style={label}>Driver Type</label>
          <select style={selectStyle} value={type} onChange={e => { setType(e.target.value); void refresh({ verb: 'list', forType: e.target.value }); }}>
            {(reply?.deviceTypes ?? []).map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={row}>
          <label style={label}>Audio Input Device</label>
          <select style={selectStyle} value={inDev} onChange={e => setInDev(e.target.value)}>
            <option value="">No Device</option>
            {(reply?.inputDevices ?? []).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div style={row}>
          <label style={label}>Audio Output Device</label>
          <select style={selectStyle} value={outDev} onChange={e => setOutDev(e.target.value)}>
            <option value="">No Device</option>
            {(reply?.outputDevices ?? []).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ ...row, flex: 1 }}>
            <label style={label}>Sample Rate</label>
            <select style={selectStyle} value={rate} onChange={e => setRate(Number(e.target.value))}>
              {(d?.availableSampleRates ?? [rate]).map(r => <option key={r} value={r}>{r} Hz</option>)}
            </select>
          </div>
          <div style={{ ...row, flex: 1 }}>
            <label style={label}>Buffer Size</label>
            <select style={selectStyle} value={buf} onChange={e => setBuf(Number(e.target.value))}>
              {(d?.availableBufferSizes ?? [buf]).map(b => <option key={b} value={b}>{b} samples{rate ? ` (${(b * 1000 / rate).toFixed(2)} ms)` : ''}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btn} disabled={busy} onClick={apply} title="Open the chosen devices at this sample rate and buffer size with the channels enabled below (saved for the next launch)">Apply</button>
          <button style={btn} disabled={busy} onClick={() => void refresh({ verb: 'default' })} title="Back to the system's default output, no inputs">Default output</button>
          <button style={btn} disabled={busy} onClick={() => void refresh()} title="Re-read the device list">Refresh</button>
        </div>
        <div style={hint}>{d ? (d.open ? `${d.type} · in ${d.inputDevice || '—'} · out ${d.outputDevice || '—'} · ${d.sampleRate} Hz · ${d.bufferSize} samples · active in ${d.inputs} / out ${d.outputs}` : `NO DEVICE${d.error ? ' — ' + d.error : ''}`) : 'reading devices…'}</div>
      </div>

      <div style={card}>
        <label style={label}>Input Config <span style={{ textTransform: 'none', letterSpacing: 0 }}>— click a channel to enable it for recording / sampling</span></label>
        <div>{(d?.inputChannelNames ?? []).length === 0 && <span style={hint}>no input channels on this device</span>}
          {(d?.inputChannelNames ?? []).map((nm, i) => <span key={i} style={chip(inOn.includes(i))} onClick={() => toggle(inOn, setInOn, i)} title={`input ${i + 1}`}>{i + 1} {nm}</span>)}</div>
        <label style={{ ...label, marginTop: 10 }}>Output Config <span style={{ textTransform: 'none', letterSpacing: 0 }}>— outs 3/4… become pad / strip output pairs</span></label>
        <div>{(d?.outputChannelNames ?? []).map((nm, i) => <span key={i} style={chip(outOn.includes(i))} onClick={() => toggle(outOn, setOutOn, i)} title={`output ${i + 1}`}>{i + 1} {nm}</span>)}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button style={btn} disabled={busy} onClick={() => void refresh({ verb: 'enableAll' })} title="Enable every input and output channel of the current devices (Ableton leaves the rest off by default — each enabled channel costs CPU and bandwidth)">Enable all</button>
          <button style={btn} disabled={busy} onClick={apply}>Apply channels</button>
        </div>
        <div style={hint}>Inputs 1/2 + outputs 1/2 are on by default; Apply writes the selection. The channel lists reflect what the interface reports.</div>
      </div>

      <div style={card}>
        <label style={label}>Latency</label>
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          {d?.open ? <>
            reported in {d.inputLatencySamples} smp ({d.inputLatencyMs.toFixed(2)} ms) · out {d.outputLatencySamples} smp ({d.outputLatencyMs.toFixed(2)} ms) · buffer {(d.bufferSize * 1000 / d.sampleRate).toFixed(2)} ms
            {d.calibrationSamples >= 0 && <><br />MEASURED round trip <b style={{ color: 'var(--neon)' }}>{d.calibrationSamples} smp = {d.calibrationMs.toFixed(2)} ms</b> · driver error compensation {d.calibrationSamples - d.calibrationReportedSamples} smp</>}
          </> : '—'}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12 }}>Measure round trip: out</span>
          <input type="number" min={0} value={calOut} onChange={e => setCalOut(Number(e.target.value))} style={{ ...selectStyle, width: 64 }} />
          <span style={{ fontSize: 12 }}>→ in</span>
          <input type="number" min={0} value={calIn} onChange={e => setCalIn(Number(e.target.value))} style={{ ...selectStyle, width: 64 }} />
          <button style={btn} onClick={() => void measure()} title="Emits a 64-sample click on that output and listens on that input for 1 s — cable the two together. The measured round trip minus the reported latency is the driver error compensation, stored with the device setup">Measure</button>
        </div>
        <div style={hint}>{calMsg}</div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={{ ...btn, color: toneOn ? '#ff6' : 'var(--neon)' }} onClick={() => tone(!toneOn)} title="A 440 Hz sine at −12 dB on the chosen output pair — check every output of the interface">{toneOn ? 'Test tone OFF' : 'Test tone ON'}</button>
          <span style={{ fontSize: 12 }}>out pair</span>
          <select style={{ ...selectStyle, width: 90 }} value={tonePair} onChange={e => { const p = Number(e.target.value); setTonePair(p); if (toneOn) tone(true, p); }}>
            {pairs.map(p => <option key={p} value={p}>{2 * p + 1}/{2 * p + 2}</option>)}
          </select>
          <span style={{ ...hint, marginTop: 0, marginLeft: 'auto' }}>CPU {snap ? (snap.cpuLoad * 100).toFixed(1) : '—'}% · xruns {d?.xruns ?? snap?.xruns ?? 0}</span>
        </div>
      </div>
    </>
  );
}
