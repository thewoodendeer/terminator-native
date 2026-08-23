/**
 * NativeMidiPane — Preferences → MIDI, the native ports: every MIDI input and output the C++ MidiHub sees (CoreMIDI /
 * WinMM), per-port enable persisted by the shell (inputs in `midi.inputs`, outputs in the page's own `app.midi.outputs`
 * map — the same toggles the clock sender filters by), hot-plug, the driver→handler lag meter, and the MIDI clock
 * status (3.5): OUT = the engine's clock (running / ticks / how late the pump's last send was against its stamp),
 * IN = the follower's last settled BPM + the port that owns the clock. The clock send / follow toggles + the channel
 * stay in the React card below (they live in `app.midi`, which the shell applies to the engine + hub).
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { native, onNativeEvent } from './juceBridge';

type Port = { id: string; name: string; enabled: boolean; open: boolean };
type MidiReply = {
  ok: boolean; error?: string; inputs: Port[]; outputs?: Port[]; messages: number; lastLagMs: number; medianLagMs: number; last: string;
  clock?: { enabled: boolean; running: boolean; ticks: number; sent: number; lateMs: number; maxLateMs: number; inBpm: number; inPort: number; inStarted: boolean };
};

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
  const [live, setLive] = useState<{ messages: number; lagMs: number; last: string; clockRunning: boolean; clockTicks: number; clockPos: number; lateMs: number; inBpm: number; inPort: number; inStarted: boolean } | null>(null);
  const refresh = useCallback(async (req: Record<string, unknown> = { verb: 'list' }) => {
    try { setR((await native.midi(req)) as MidiReply); } catch (e) { console.warn('[prefs] midi', e); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => onNativeEvent('terminator.midiChanged', (m: MidiReply) => setR(m)), []);
  useEffect(() => onNativeEvent('terminator.snapshot', (s: any) => {
    setLive({
      messages: Number(s.midiMessages ?? 0), lagMs: Number(s.midiLagMs ?? 0), last: String(s.midiLast ?? ''),
      clockRunning: !!s.midiClockRunning, clockTicks: Number(s.midiClockTicks ?? 0), clockPos: Number(s.midiClockPosition ?? 0), lateMs: Number(s.midiSendLateMs ?? 0),
      inBpm: Number(s.midiClockInBpm ?? 0), inPort: Number(s.midiClockInPort ?? -1), inStarted: !!s.midiClockInStarted,
    });
  }), []);
  const outputs = r?.outputs ?? [];
  const clockOn = !!r?.clock?.enabled;
  return (
    <>
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
        <div style={hint}>Note 36 = pad 1 (1:1 upward, remappable with pad LEARN). Play your controller: the last message shows here with the driver→engine lag. START / STOP from the controller drive the transport; its clock ticks set the tempo when "follow tempo" is on below.</div>
      </div>

      <div style={card}>
        <label style={label}>MIDI Outputs (native)</label>
        {outputs.length === 0 && <div style={{ color: 'var(--text-dim)', padding: '6px 0' }}>No MIDI outputs connected</div>}
        {outputs.map(p => (
          <div key={p.id} style={toggleRow} title={p.id}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.enabled ? '●' : '○'} {p.name}{p.enabled && !p.open ? ' (could not open)' : ''}</span>
            <Toggle on={p.enabled} onChange={v => void refresh({ verb: 'enableOutput', id: p.id, enabled: v })} />
          </div>
        ))}
        <div style={hint}>
          MIDI Clock (send) {clockOn ? 'is ON' : 'is off'} — the engine generates Song Position + START, 24 ticks per quarter note and STOP from the transport itself, sample-exact, and sends them to every output left on here.
          {live ? ` · ${live.clockRunning ? `RUNNING · tick ${live.clockPos} (${Math.floor(live.clockPos / 6)} beats in)` : 'stopped'} · ${live.clockTicks} ticks total · last send ${live.lateMs.toFixed(2)} ms late` : ''}
        </div>
        <div style={hint}>
          Clock IN: {live?.inStarted ? `hardware driving (port ${live.inPort})` : 'idle'}{live && live.inBpm > 0 ? ` · reads ${live.inBpm.toFixed(1)} BPM` : ''} — the port that sent START owns the clock until its STOP (a controller on two ports cannot double the tempo).
        </div>
      </div>
    </>
  );
}
