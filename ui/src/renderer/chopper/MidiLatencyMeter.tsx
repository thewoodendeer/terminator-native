// ─────────────────────────────────────────────────────────────────────────────
// MIDI LATENCY METER — turns "there's slight latency" into a number.
//
// Two things add up between hitting a pad on a controller and hearing it, and
// they are NOT equally fixable, so the meter reports them separately:
//
//   OUT — the graph→speaker delay (`AudioContext.outputLatency`). Set by the
//         browser, the OS and the audio device. Nothing in this app moves it;
//         a smaller buffer or the desktop build is what moves it. Typically
//         ~10ms on macOS Chrome, often 20-40ms on Windows shared-mode audio.
//
//   IN  — how long a MIDI message sat waiting before our handler ran, measured
//         from the event's own timestamp. This one IS ours: it is main-thread
//         contention — waveform repaints, React renders, the sequencer tick —
//         and it drops when there is less on screen to draw.
//
// The IN figure is a MEDIAN of recent hits. One 80ms stall while a big sample
// decoded should not brand the whole rig laggy — but it should still be
// visible, so the worst recent hit is reported next to it in the tooltip.
//
// Nothing here is on the audio path. It polls twice a second and renders a
// short string; a meter that cost latency to display would be a bad joke.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import type { ChopperEngine } from './ChopperEngine';

type Report = ReturnType<ChopperEngine['getLatencyReport']>;

const ms = (v: number) => `${Math.round(v)}ms`;

export function MidiLatencyMeter({ engine, active }: {
  engine: ChopperEngine;
  active: boolean;
}) {
  const [rep, setRep] = useState<Report | null>(null);

  useEffect(() => {
    if (!active) { setRep(null); return; }
    const read = () => setRep(engine.getLatencyReport());
    read();
    const id = window.setInterval(read, 500);
    return () => window.clearInterval(id);
  }, [engine, active]);

  if (!rep) return null;

  const measured = rep.samples > 0;
  // Until a pad has actually been hit there is no input figure, so show the
  // output number alone rather than a total that is quietly missing half of
  // itself.
  const shown = measured ? rep.totalMs : rep.outputMs;
  const approx = rep.outputMeasured ? '' : '~';

  const tip = [
    measured
      ? `Round trip ≈ ${ms(rep.totalMs)} from controller to speaker.`
      : `Output ${approx}${ms(rep.outputMs)}. Hit a pad on your controller to measure the input side.`,
    '',
    `OUT ${approx}${ms(rep.outputMs)} — graph to speaker.${rep.outputMeasured ? '' : ' Estimated: this browser does not report outputLatency.'} Set by the browser, OS and audio device — the desktop app or a smaller device buffer is what moves this, not a setting in here.`,
    measured
      ? `IN ${ms(rep.inputMs)} — how long a MIDI message waited on the main thread (median of ${rep.samples}, worst ${ms(rep.worstMs)}). This is the half that responds to load: collapse WAVEFORM and MIXER while you play and watch it drop.`
      : '',
  ].filter(Boolean).join('\n');

  return (
    <div
      className={`midi-latency${measured ? '' : ' midi-latency-partial'}`}
      title={tip}
      onDoubleClick={() => { engine.resetInputLag(); setRep(engine.getLatencyReport()); }}
    >
      ⏱ {approx}{ms(shown)}
    </div>
  );
}
