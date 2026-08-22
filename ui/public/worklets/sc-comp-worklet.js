// SC COMP — a compressor with an EXTERNAL key (sidechain). Web Audio's
// DynamicsCompressorNode has no key input, so this is the real thing:
//   input 0 = the signal being ducked (stereo)
//   input 1 = the key — whatever the MixerEngine feeds in (a kick channel, say)
// Detector = rectified key peak → gain computer (soft knee, dB) → attack /
// hold / release smoothing on the gain-reduction (dB) → applied to input 0.
// Zero latency (no look-ahead), so PDC has nothing to compensate for.
// If no key is connected the gain reduction is 0 and the signal passes clean.
class ScCompProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -24,   minValue: -60,   maxValue: 0,   automationRate: 'k-rate' }, // dB
      { name: 'ratio',     defaultValue: 4,     minValue: 1,     maxValue: 20,  automationRate: 'k-rate' },
      { name: 'attack',    defaultValue: 0.005, minValue: 0.0001, maxValue: 0.5, automationRate: 'k-rate' }, // s
      { name: 'release',   defaultValue: 0.12,  minValue: 0.005, maxValue: 2,   automationRate: 'k-rate' }, // s
      { name: 'hold',      defaultValue: 0,     minValue: 0,     maxValue: 1,   automationRate: 'k-rate' }, // s
      { name: 'makeup',    defaultValue: 0,     minValue: 0,     maxValue: 24,  automationRate: 'k-rate' }, // dB
      { name: 'knee',      defaultValue: 6,     minValue: 0,     maxValue: 24,  automationRate: 'k-rate' }, // dB
    ];
  }

  constructor() {
    super();
    this._gr = 0;          // current gain reduction, dB (≤ 0)
    this._holdLeft = 0;    // samples of hold remaining before release may run
    this._meterCount = 0;
    this._meterMin = 0;
  }

  process(inputs, outputs, parameters) {
    const main = inputs[0];
    const key = inputs[1];
    const out = outputs[0];
    if (!main || !main[0] || !out || !out[0]) return true;

    const thr = parameters.threshold[0];
    const ratio = parameters.ratio[0];
    const knee = parameters.knee[0];
    const makeupLin = Math.pow(10, parameters.makeup[0] / 20);
    const aCoef = 1 - Math.exp(-1 / (Math.max(0.0001, parameters.attack[0]) * sampleRate));
    const rCoef = 1 - Math.exp(-1 / (Math.max(0.001, parameters.release[0]) * sampleRate));
    const holdSamples = Math.round(parameters.hold[0] * sampleRate);
    const slope = 1 / ratio - 1;   // dB of GR per dB over threshold (negative)
    const halfKnee = knee / 2;

    const n = main[0].length;
    const keyL = key && key[0] ? key[0] : null;
    const keyR = key && key[1] ? key[1] : keyL;
    const chans = Math.min(out.length, 2);
    let gr = this._gr;
    let holdLeft = this._holdLeft;
    let minGr = 0;

    for (let i = 0; i < n; i++) {
      // Static gain computer on the instantaneous key level.
      let target = 0;
      if (keyL) {
        const a = Math.abs(keyL[i]);
        const b = keyR ? Math.abs(keyR[i]) : a;
        const lvl = a > b ? a : b;
        const db = 20 * Math.log10(lvl + 1e-9);
        const over = db - thr;
        if (over > -halfKnee) {
          target = (knee > 0 && over < halfKnee)
            ? slope * ((over + halfKnee) * (over + halfKnee)) / (2 * knee)
            : slope * over;
        }
      }
      // Attack pulls GR down (more reduction) fast; release lets it recover
      // after the hold has run out.
      if (target < gr) {
        gr += aCoef * (target - gr);
        holdLeft = holdSamples;
      } else if (holdLeft > 0) {
        holdLeft--;
      } else {
        gr += rCoef * (target - gr);
      }
      if (gr < minGr) minGr = gr;
      const g = Math.pow(10, gr / 20) * makeupLin;
      for (let c = 0; c < chans; c++) {
        const inCh = main[c] || main[0];
        out[c][i] = inCh[i] * g;
      }
    }
    this._gr = gr;
    this._holdLeft = holdLeft;

    // Gain-reduction meter for the panel — the deepest GR seen, ~every 40 ms.
    if (minGr < this._meterMin) this._meterMin = minGr;
    this._meterCount += n;
    if (this._meterCount >= sampleRate * 0.04) {
      this.port.postMessage(this._meterMin);
      this._meterCount = 0;
      this._meterMin = 0;
    }
    return true;
  }
}

registerProcessor('sc-comp', ScCompProcessor);
