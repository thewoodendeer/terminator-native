/**
 * NativeMidiPane — Preferences → MIDI, the native inputs: every MIDI port the C++ MidiHub sees (CoreMIDI /
 * WinMM), per-port enable persisted by the shell, hot-plug, and the driver→handler lag meter. Clock / channel /
 * outputs stay the React page's own settings until Phase 3 wires them (the pane below it).
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { native, onNativeEvent } from './juceBridge';

type MidiReply = { ok: boolean; error?: string; inputs: Array<{ id: string; name: string; enabled: boolean; open: boolean }>; messages: number; lastLagMs: number; medianLagMs: number; last: string };

const card: CSSProperties = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '12px 14px', marginBottom: 12 };
const label: CSSProperties = { display: 'block', color: 'var(--text-dim)', fontSize: 11, letterSpacing: 1, marginBottom: 5, textTransform: 'uppercase' };
const hint: CSSProperties = { color: 'var(--text-dim)', fontSize: 11, marginTop: 5, lineHeight: 1.4 };
const btn: CSSProperties = { background: 'var(--bg3)', color: 'var(--neon)', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 };
const toggleRow: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', borderBottom: '1px solid var(--border)', gap: 10 };

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} style={{ width: 40, height: 22, borderRadius: 11, border: '1px solid var(--border)', background: on ? 'var(--neon)' : 'var(--bg3)', position: 'relative', cursor: 'pointer', padding: 0 }} aria-pressed={on}>
      <span style={{ position: 'absolute', top: 2, left: on ? 20 : 2, width: 16, height: 16, borderRadius: 8, background: on ? '#000' : 'var(--text-dim)', transition: 'left .12s' }} />
    </button>
  );
}

export default function NativeMidiPane() {
  const [r, setR] = useState<MidiReply | null>(null);
  const [live, setLive] = useState<{ messages: number; lagMs: number; last: string } | null>(null);
  const refresh = useCallback(async (req: Record<string, unknown> = { verb: 'list' }) => {
    try { setR((await native.midi(req)) as MidiReply); } catch (e) { console.warn('[prefs] midi', e); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => onNativeEvent('terminator.midiChanged', (m: MidiReply) => setR(m)), []);
  useEffect(() => onNativeEvent('terminator.snapshot', (s: any) => { if (s.midiMessages) setLive({ messages: s.midiMessages, lagMs: s.midiLagMs ?? 0, last: s.midiLast ?? '' }); }), []);
  return (
    <div style={card}>
      <label style={label}>MIDI Inputs (native)</label>
      {(r?.inputs ?? []).length === 0 && <div style={{ color: 'var(--text-dim)', padding: '6px 0' }}>No MIDI inputs connected</div>}
      {(r?.inputs ?? []).map(p => (
        <div key={p.id} style={toggleRow} title={p.id}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.enabled ? '●' : '○'} {p.name}{p.open ? '' : ' (closed)'}</span>
          <Toggle on={p.enabled} onChange={v => void refresh({ verb: 'enable', id: p.id, enabled: v })} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button style={btn} onClick={() => void refresh({ verb: 'enableAll' })}>Enable all</button>
        <button style={btn} onClick={() => void refresh({ verb: 'refresh' })}>Rescan</button>
      </div>
      <div style={hint}>
        {r ? `${r.messages} messages · lag median ${Number(r.medianLagMs).toFixed(2)} ms${r.last ? ' · last ' + r.last : ''}` : '…'}
        {live ? ` · live: ${live.messages} msgs, ${live.lagMs.toFixed(2)} ms, ${live.last}` : ''}
      </div>
      <div style={hint}>Note 36 = pad 1 (1:1 upward). Play your controller: the last message shows here with the driver→engine lag.</div>
    </div>
  );
}
