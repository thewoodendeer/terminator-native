/**
 * Mid-Side parametric EQ — always outputs the processed signal.
 * Bypass / wet-dry mix are handled externally by MSEQ.ts.
 */

function calcPeakingCoeffs(freq, dBgain, sr) {
  const A     = Math.pow(10, dBgain / 40);
  const w0    = 2 * Math.PI * freq / sr;
  const sinW0 = Math.sin(w0);
  const cosW0 = Math.cos(w0);
  const alpha = sinW0 / (2 * 0.707);

  const b0 =  1 + alpha * A;
  const b1 = -2 * cosW0;
  const b2 =  1 - alpha * A;
  const a0 =  1 + alpha / A;
  const a1 = -2 * cosW0;
  const a2 =  1 - alpha / A;

  return { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 };
}

function biquad(x, s, c) {
  const y = c.b0 * x + s.z1;
  s.z1 = c.b1 * x - c.a1 * y + s.z2;
  s.z2 = c.b2 * x - c.a2 * y;
  return y;
}

class MSEQProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'midFreq',  defaultValue: 1000, minValue: 20,  maxValue: 20000, automationRate: 'k-rate' },
      { name: 'midGain',  defaultValue: 0,    minValue: -24, maxValue: 24,    automationRate: 'k-rate' },
      { name: 'sideFreq', defaultValue: 3000, minValue: 20,  maxValue: 20000, automationRate: 'k-rate' },
      { name: 'sideGain', defaultValue: 0,    minValue: -24, maxValue: 24,    automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._midState  = { z1: 0, z2: 0 };
    this._sideState = { z1: 0, z2: 0 };
    this._midCoeffs  = calcPeakingCoeffs(1000, 0, sampleRate);
    this._sideCoeffs = calcPeakingCoeffs(3000, 0, sampleRate);
    this._lastMidFreq  = 1000;
    this._lastMidGain  = 0;
    this._lastSideFreq = 3000;
    this._lastSideGain = 0;
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const midFreq  = parameters.midFreq[0];
    const midGain  = parameters.midGain[0];
    const sideFreq = parameters.sideFreq[0];
    const sideGain = parameters.sideGain[0];

    if (midFreq !== this._lastMidFreq || midGain !== this._lastMidGain) {
      this._midCoeffs    = calcPeakingCoeffs(midFreq, midGain, sampleRate);
      this._lastMidFreq  = midFreq;
      this._lastMidGain  = midGain;
    }
    if (sideFreq !== this._lastSideFreq || sideGain !== this._lastSideGain) {
      this._sideCoeffs    = calcPeakingCoeffs(sideFreq, sideGain, sampleRate);
      this._lastSideFreq  = sideFreq;
      this._lastSideGain  = sideGain;
    }

    const outR = output[1] || output[0];

    for (let i = 0; i < input[0].length; i++) {
      const L = input[0][i];
      const R = input[1] ? input[1][i] : L;

      const M = (L + R) * 0.5;
      const S = (L - R) * 0.5;

      const Meq = biquad(M, this._midState,  this._midCoeffs);
      const Seq = biquad(S, this._sideState, this._sideCoeffs);

      output[0][i] = Meq + Seq;
      outR[i]      = Meq - Seq;
    }
    return true;
  }
}

registerProcessor('ms-eq', MSEQProcessor);
