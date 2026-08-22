import { useState } from 'react';
import { ChopperEngine, ChopperState } from './ChopperEngine';
import { useFaderTooltip } from './useFaderTooltip';

interface Props {
  state: ChopperState;
  engine: ChopperEngine;
}

const isWeb = (import.meta as any).env?.MODE === 'web';

// Two render paths kept inside one component so ChopperView doesn't have to
// fork. Web: collapsible header + no mix knobs (toggle is the on/off,
// engine forces 100% wet). Desktop: original layout — always expanded,
// mix knobs visible.
export function ExtraFXPanel({ state, engine }: Props) {
  return isWeb
    ? <ExtraFXPanelWeb state={state} engine={engine} />
    : <ExtraFXPanelDesktop state={state} engine={engine} />;
}

function ExtraFXPanelWeb({ state, engine }: Props) {
  const [expanded, setExpanded] = useState(false);
  const fx = state.extraFX;
  const activeCount = [
    !fx.clipper.bypassed, !fx.waveshaper.bypassed, !fx.saturator.bypassed,
    !fx.widener.bypassed, !fx.mseq.bypassed, !fx.bitcrusher.bypassed,
    !fx.autopan.bypassed, !fx.trancegate.bypassed, !fx.chorus.bypassed,
  ].filter(Boolean).length;

  return (
    <div className={`master-fx extra-fx${expanded ? '' : ' collapsed'}`}>
      <button
        type="button"
        className="master-fx-title fx-panel-header"
        onClick={() => setExpanded(e => !e)}
        title={expanded ? 'Collapse' : 'Expand'}
      >
        <span>{expanded ? '▾' : '▸'} EXTRA FX</span>
        {activeCount > 0 && <span className="fx-panel-active">{activeCount} on</span>}
      </button>

      {expanded && (<>
        <FxRow label="CLIP" on={!fx.clipper.bypassed} onToggle={() => engine.toggleClipper()}>
          <FXKnob label="AMT" value={Math.round(fx.clipper.amount * 100)} unit="%" min={0} max={100} step={1}
            onChange={v => engine.setClipperAmount(v / 100)} onReset={() => engine.setClipperAmount(0.5)} />
          <FXKnob label="DRIVE" value={Math.round(fx.clipper.drive * 100)} unit="%" min={0} max={100} step={1}
            onChange={v => engine.setClipperDrive(v / 100)} onReset={() => engine.setClipperDrive(0.5)} />
        </FxRow>

        <FxRow label="WAVE" on={!fx.waveshaper.bypassed} onToggle={() => engine.toggleWaveshaper()}>
          <FXKnob label="DRIVE" value={Math.round(fx.waveshaper.drive * 100)} unit="%" min={0} max={100} step={1}
            onChange={v => engine.setWaveshaperDrive(v / 100)} onReset={() => engine.setWaveshaperDrive(0.5)} />
        </FxRow>

        <FxRow label="SAT" on={!fx.saturator.bypassed} onToggle={() => engine.toggleSaturator()}>
          <FXKnob label="DRIVE" value={Math.round(fx.saturator.drive * 100)} unit="%" min={0} max={100} step={1}
            onChange={v => engine.setSaturatorDrive(v / 100)} onReset={() => engine.setSaturatorDrive(0.5)} />
          <FXKnob label="LOW" value={Math.round(fx.saturator.lowFreq)} unit="Hz" min={20} max={500} step={1}
            onChange={v => engine.setSaturatorLowFreq(v)} onReset={() => engine.setSaturatorLowFreq(120)} />
          <FXKnob label="HIGH" value={Math.round(fx.saturator.highFreq)} unit="Hz" min={500} max={20000} step={50}
            onChange={v => engine.setSaturatorHighFreq(v)} onReset={() => engine.setSaturatorHighFreq(4000)} />
        </FxRow>

        <FxRow label="WIDE" on={!fx.widener.bypassed} onToggle={() => engine.toggleWidener()}>
          <FXKnob label="WIDTH" value={Math.round(fx.widener.width * 100)} unit="%" min={0} max={200} step={1}
            onChange={v => engine.setWidenerWidth(v / 100)} onReset={() => engine.setWidenerWidth(1)} />
        </FxRow>

        <FxRow label="M/S EQ" on={!fx.mseq.bypassed} onToggle={() => engine.toggleMSEQ()}>
          <FXKnob label="MID Hz" value={Math.round(fx.mseq.midFreq)} unit="" min={50} max={5000} step={10}
            onChange={v => engine.setMSEQMidFreq(v)} onReset={() => engine.setMSEQMidFreq(800)} />
          <FXKnob label="MID dB" value={fx.mseq.midGain} unit="dB" min={-18} max={18} step={0.5}
            onChange={v => engine.setMSEQMidGain(v)} onReset={() => engine.setMSEQMidGain(0)} />
          <FXKnob label="SIDE Hz" value={Math.round(fx.mseq.sideFreq)} unit="" min={50} max={5000} step={10}
            onChange={v => engine.setMSEQSideFreq(v)} onReset={() => engine.setMSEQSideFreq(2000)} />
          <FXKnob label="SIDE dB" value={fx.mseq.sideGain} unit="dB" min={-18} max={18} step={0.5}
            onChange={v => engine.setMSEQSideGain(v)} onReset={() => engine.setMSEQSideGain(0)} />
        </FxRow>

        <FxRow label="BIT" on={!fx.bitcrusher.bypassed} onToggle={() => engine.toggleBitCrusher()}>
          <FXKnob label="BITS" value={Math.round(fx.bitcrusher.bits)} unit="" min={1} max={16} step={1}
            onChange={v => engine.setBitCrusherBits(v)} onReset={() => engine.setBitCrusherBits(16)} />
          {/* RATE is a 1..32 sample-and-hold divisor in the engine; mapping
              the slider directly avoids the 0..1 round-to-0 bug that made
              it stuck at full rate. 1 = no downsampling, 32 = heavy crush. */}
          <FXKnob label="RATE" value={Math.round(fx.bitcrusher.rate)} unit="x" min={1} max={32} step={1}
            onChange={v => engine.setBitCrusherRate(v)} onReset={() => engine.setBitCrusherRate(1)} />
        </FxRow>

        <FxRow label="PAN" on={!fx.autopan.bypassed} onToggle={() => engine.toggleAutoPan()}>
          <FXKnob label="RATE" value={Number(fx.autopan.rate.toFixed(2))} unit="Hz" min={0.05} max={10} step={0.05}
            onChange={v => engine.setAutoPanRate(v)} onReset={() => engine.setAutoPanRate(1)} />
          <FXKnob label="DEPTH" value={Math.round(fx.autopan.depth * 100)} unit="%" min={0} max={100} step={1}
            onChange={v => engine.setAutoPanDepth(v / 100)} onReset={() => engine.setAutoPanDepth(0.5)} />
        </FxRow>

        <FxRow label="GATE" on={!fx.trancegate.bypassed} onToggle={() => engine.toggleTranceGate()}>
          <FXKnob label="RATE" value={Number(fx.trancegate.rate.toFixed(2))} unit="Hz" min={0.5} max={20} step={0.1}
            onChange={v => engine.setTranceGateRate(v)} onReset={() => engine.setTranceGateRate(4)} />
          <FXKnob label="DEPTH" value={Math.round(fx.trancegate.depth * 100)} unit="%" min={0} max={100} step={1}
            onChange={v => engine.setTranceGateDepth(v / 100)} onReset={() => engine.setTranceGateDepth(1)} />
          <FXKnob label="ATK" value={Math.round(fx.trancegate.attack * 1000)} unit="ms" min={1} max={100} step={1}
            onChange={v => engine.setTranceGateAttack(v / 1000)} onReset={() => engine.setTranceGateAttack(0.005)} />
          <FXKnob label="REL" value={Math.round(fx.trancegate.release * 1000)} unit="ms" min={1} max={500} step={1}
            onChange={v => engine.setTranceGateRelease(v / 1000)} onReset={() => engine.setTranceGateRelease(0.05)} />
        </FxRow>

        <FxRow label="TAPE" on={!fx.chorus.bypassed} onToggle={() => engine.toggleChorus()}>
          <FXKnob label="RATE" value={Number(fx.chorus.rate.toFixed(2))} unit="Hz" min={0.05} max={5} step={0.05}
            onChange={v => engine.setChorusRate(v)} onReset={() => engine.setChorusRate(0.8)} />
          <FXKnob label="DEPTH" value={Math.round(fx.chorus.depth * 100)} unit="%" min={0} max={100} step={1}
            onChange={v => engine.setChorusDepth(v / 100)} onReset={() => engine.setChorusDepth(0.5)} />
        </FxRow>
      </>)}
    </div>
  );
}

// Original desktop layout — always expanded, mix knobs visible alongside
// each FX's tone controls.
function ExtraFXPanelDesktop({ state, engine }: Props) {
  const fx = state.extraFX;
  return (
    <div className="master-fx extra-fx">
      <div className="master-fx-title">EXTRA FX</div>

      <FxRow label="CLIP" on={!fx.clipper.bypassed} onToggle={() => engine.toggleClipper()}>
        <FXKnob label="AMT" value={Math.round(fx.clipper.amount * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setClipperAmount(v / 100)} onReset={() => engine.setClipperAmount(0.5)} />
        <FXKnob label="DRIVE" value={Math.round(fx.clipper.drive * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setClipperDrive(v / 100)} onReset={() => engine.setClipperDrive(0.5)} />
        <FXKnob label="MIX" value={Math.round(fx.clipper.mix * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setClipperMix(v / 100)} onReset={() => engine.setClipperMix(0.7)} />
      </FxRow>

      <FxRow label="WAVE" on={!fx.waveshaper.bypassed} onToggle={() => engine.toggleWaveshaper()}>
        <FXKnob label="DRIVE" value={Math.round(fx.waveshaper.drive * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setWaveshaperDrive(v / 100)} onReset={() => engine.setWaveshaperDrive(0.5)} />
        <FXKnob label="MIX" value={Math.round(fx.waveshaper.mix * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setWaveshaperMix(v / 100)} onReset={() => engine.setWaveshaperMix(0.5)} />
      </FxRow>

      <FxRow label="SAT" on={!fx.saturator.bypassed} onToggle={() => engine.toggleSaturator()}>
        <FXKnob label="DRIVE" value={Math.round(fx.saturator.drive * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setSaturatorDrive(v / 100)} onReset={() => engine.setSaturatorDrive(0.5)} />
        <FXKnob label="LOW" value={Math.round(fx.saturator.lowFreq)} unit="Hz" min={20} max={500} step={1}
          onChange={v => engine.setSaturatorLowFreq(v)} onReset={() => engine.setSaturatorLowFreq(120)} />
        <FXKnob label="HIGH" value={Math.round(fx.saturator.highFreq)} unit="Hz" min={500} max={20000} step={50}
          onChange={v => engine.setSaturatorHighFreq(v)} onReset={() => engine.setSaturatorHighFreq(4000)} />
        <FXKnob label="MIX" value={Math.round(fx.saturator.mix * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setSaturatorMix(v / 100)} onReset={() => engine.setSaturatorMix(0.5)} />
      </FxRow>

      <FxRow label="WIDE" on={!fx.widener.bypassed} onToggle={() => engine.toggleWidener()}>
        <FXKnob label="WIDTH" value={Math.round(fx.widener.width * 100)} unit="%" min={0} max={200} step={1}
          onChange={v => engine.setWidenerWidth(v / 100)} onReset={() => engine.setWidenerWidth(1)} />
        <FXKnob label="MIX" value={Math.round(fx.widener.mix * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setWidenerMix(v / 100)} onReset={() => engine.setWidenerMix(1)} />
      </FxRow>

      <FxRow label="M/S EQ" on={!fx.mseq.bypassed} onToggle={() => engine.toggleMSEQ()}>
        <FXKnob label="MID Hz" value={Math.round(fx.mseq.midFreq)} unit="" min={50} max={5000} step={10}
          onChange={v => engine.setMSEQMidFreq(v)} onReset={() => engine.setMSEQMidFreq(800)} />
        <FXKnob label="MID dB" value={fx.mseq.midGain} unit="dB" min={-18} max={18} step={0.5}
          onChange={v => engine.setMSEQMidGain(v)} onReset={() => engine.setMSEQMidGain(0)} />
        <FXKnob label="SIDE Hz" value={Math.round(fx.mseq.sideFreq)} unit="" min={50} max={5000} step={10}
          onChange={v => engine.setMSEQSideFreq(v)} onReset={() => engine.setMSEQSideFreq(2000)} />
        <FXKnob label="SIDE dB" value={fx.mseq.sideGain} unit="dB" min={-18} max={18} step={0.5}
          onChange={v => engine.setMSEQSideGain(v)} onReset={() => engine.setMSEQSideGain(0)} />
        <FXKnob label="MIX" value={Math.round(fx.mseq.mix * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setMSEQMix(v / 100)} onReset={() => engine.setMSEQMix(1)} />
      </FxRow>

      <FxRow label="BIT" on={!fx.bitcrusher.bypassed} onToggle={() => engine.toggleBitCrusher()}>
        <FXKnob label="BITS" value={Math.round(fx.bitcrusher.bits)} unit="" min={1} max={16} step={1}
          onChange={v => engine.setBitCrusherBits(v)} onReset={() => engine.setBitCrusherBits(16)} />
        <FXKnob label="RATE" value={Math.round(fx.bitcrusher.rate * 100)} unit="%" min={1} max={100} step={1}
          onChange={v => engine.setBitCrusherRate(v / 100)} onReset={() => engine.setBitCrusherRate(1)} />
        <FXKnob label="MIX" value={Math.round(fx.bitcrusher.mix * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setBitCrusherMix(v / 100)} onReset={() => engine.setBitCrusherMix(1)} />
      </FxRow>

      <FxRow label="PAN" on={!fx.autopan.bypassed} onToggle={() => engine.toggleAutoPan()}>
        <FXKnob label="RATE" value={Number(fx.autopan.rate.toFixed(2))} unit="Hz" min={0.05} max={10} step={0.05}
          onChange={v => engine.setAutoPanRate(v)} onReset={() => engine.setAutoPanRate(1)} />
        <FXKnob label="DEPTH" value={Math.round(fx.autopan.depth * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setAutoPanDepth(v / 100)} onReset={() => engine.setAutoPanDepth(0.5)} />
        <FXKnob label="MIX" value={Math.round(fx.autopan.mix * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setAutoPanMix(v / 100)} onReset={() => engine.setAutoPanMix(1)} />
      </FxRow>

      <FxRow label="GATE" on={!fx.trancegate.bypassed} onToggle={() => engine.toggleTranceGate()}>
        <FXKnob label="RATE" value={Number(fx.trancegate.rate.toFixed(2))} unit="Hz" min={0.5} max={20} step={0.1}
          onChange={v => engine.setTranceGateRate(v)} onReset={() => engine.setTranceGateRate(4)} />
        <FXKnob label="DEPTH" value={Math.round(fx.trancegate.depth * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setTranceGateDepth(v / 100)} onReset={() => engine.setTranceGateDepth(1)} />
        <FXKnob label="ATK" value={Math.round(fx.trancegate.attack * 1000)} unit="ms" min={1} max={100} step={1}
          onChange={v => engine.setTranceGateAttack(v / 1000)} onReset={() => engine.setTranceGateAttack(0.005)} />
        <FXKnob label="REL" value={Math.round(fx.trancegate.release * 1000)} unit="ms" min={1} max={500} step={1}
          onChange={v => engine.setTranceGateRelease(v / 1000)} onReset={() => engine.setTranceGateRelease(0.05)} />
        <FXKnob label="MIX" value={Math.round(fx.trancegate.mix * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setTranceGateMix(v / 100)} onReset={() => engine.setTranceGateMix(1)} />
      </FxRow>

      <FxRow label="CHORUS" on={!fx.chorus.bypassed} onToggle={() => engine.toggleChorus()}>
        <FXKnob label="RATE" value={Number(fx.chorus.rate.toFixed(2))} unit="Hz" min={0.05} max={5} step={0.05}
          onChange={v => engine.setChorusRate(v)} onReset={() => engine.setChorusRate(0.8)} />
        <FXKnob label="DEPTH" value={Math.round(fx.chorus.depth * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setChorusDepth(v / 100)} onReset={() => engine.setChorusDepth(0.5)} />
        <FXKnob label="MIX" value={Math.round(fx.chorus.mix * 100)} unit="%" min={0} max={100} step={1}
          onChange={v => engine.setChorusMix(v / 100)} onReset={() => engine.setChorusMix(0.5)} />
      </FxRow>
    </div>
  );
}

function FxRow({ label, on, onToggle, children }: {
  label: string; on: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="extra-fx-row">
      <button
        type="button"
        className={`extra-fx-toggle${on ? ' on' : ''}`}
        onClick={onToggle}
        title={`Toggle ${label}`}
      >
        {label}
      </button>
      <div className="fx-row extra-fx-knobs">
        {children}
      </div>
    </div>
  );
}

function FXKnob({ label, value, unit = '', min, max, step, onChange, onReset }: {
  label: string; value: number; unit?: string; min: number; max: number; step: number;
  onChange: (v: number) => void; onReset: () => void;
}) {
  const tip = useFaderTooltip(value, min, max);
  const display = `${Number.isInteger(value) ? value : value.toFixed(2)}${unit}`;
  return (
    <label className="fx-knob" onDoubleClick={onReset} title="Double-click to reset">
      <span className="fx-label">{label}</span>
      <span className="fx-slider-wrap">
        <input type="range" className="fx-slider" min={min} max={max} step={step}
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          onPointerDown={tip.onPointerDown} />
        {tip.active && (
          <span className="fx-fader-tooltip" style={{ left: `${tip.pct}%` }}>
            {display}
          </span>
        )}
      </span>
      <span className="fx-value">{display}</span>
    </label>
  );
}
