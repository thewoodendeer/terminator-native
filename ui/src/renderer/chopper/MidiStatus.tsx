// MIDI status pill — always visible, so a controller that isn't arriving is
// never a silent mystery: BLOCKED (permission) · NO DEVICE · <name> with an
// activity LED that blinks on every message, and a monitor line of the last
// message ("CC 74 = 100 · MPK mini") in the tooltip. RESCAN re-asks the
// browser / re-opens the ports. Polls the hub at 10 Hz for the LED (the hub
// deliberately doesn't notify per message).
import { useEffect, useState } from 'react';
import { midiHub, type MidiHubState } from './midiHub';

export function MidiStatusPill({ compact }: { compact?: boolean }) {
  const [st, setSt] = useState<MidiHubState>(midiHub.getState());
  const [lit, setLit] = useState(false);
  const [showMon, setShowMon] = useState(false);
  useEffect(() => midiHub.subscribe(setSt), []);
  useEffect(() => {
    const iv = setInterval(() => {
      const s = midiHub.getState();
      const on = performance.now() - s.activityAt < 140;
      setLit((v) => (v === on ? v : on));
      if (s.last !== st.last) setSt(s);
    }, 100);
    return () => clearInterval(iv);
  }, [st.last]);

  const label = st.status === 'unsupported' ? 'MIDI: N/A'
    : st.status === 'requesting' ? 'MIDI…'
    : st.status === 'denied' ? 'MIDI: BLOCKED'
    : st.status === 'nodevice' ? 'MIDI: NO DEVICE'
    : st.inputs.length > 1 ? `MIDI: ${st.inputs.length} DEVICES` : `MIDI: ${st.inputs[0]}`;
  const tip = [
    st.error ?? (st.status === 'ready' ? `Connected: ${st.inputs.join(', ')}` : st.status === 'nodevice' ? 'No MIDI input connected — plug one in (or RESCAN if it is)' : ''),
    st.last ? `Last: ${st.last.text}${st.last.port ? ` · ${st.last.port}` : ''}` : 'No MIDI received yet — move a knob or hit a pad on your controller',
    'Click for the monitor · RESCAN re-asks the browser',
  ].filter(Boolean).join('\n');
  const bad = st.status === 'denied' || st.status === 'unsupported';
  return (
    <span className={`midi-pill${bad ? ' bad' : st.status === 'ready' ? ' ok' : ''}${compact ? ' compact' : ''}`} title={tip}>
      <span className={`midi-pill-led${lit ? ' lit' : ''}`} />
      <button className="midi-pill-lbl" onClick={() => setShowMon((v) => !v)}>{label}</button>
      {(st.status !== 'ready' || showMon) && (
        <button className="midi-pill-btn" onClick={() => { void midiHub.rescan(); }} title="Re-ask the browser for MIDI and re-open every port">RESCAN</button>
      )}
      {showMon && <span className="midi-pill-mon">{st.last ? st.last.text : '— waiting —'}</span>}
    </span>
  );
}
