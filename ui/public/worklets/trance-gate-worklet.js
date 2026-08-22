class TranceGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate',    defaultValue: 4,     minValue: 0.1,   maxValue: 40,  automationRate: 'k-rate' },
      { name: 'depth',   defaultValue: 1,     minValue: 0,     maxValue: 1,   automationRate: 'k-rate' },
      { name: 'attack',  defaultValue: 0.005, minValue: 0.001, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.08,  minValue: 0.001, maxValue: 0.5, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._phase    = 0;
    this._envelope = 0;
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const rate    = parameters.rate[0];
    const depth   = parameters.depth[0];
    const attack  = parameters.attack[0];
    const release = parameters.release[0];

    const phaseInc     = rate / sampleRate;
    const attackCoeff  = 1 / (attack  * sampleRate);
    const releaseCoeff = 1 / (release * sampleRate);

    const frameSize = input[0].length;

    for (let i = 0; i < frameSize; i++) {
      const gateOpen = this._phase < 0.5 ? 1 : 0;

      if (gateOpen) {
        this._envelope += attackCoeff  * (1 - this._envelope);
      } else {
        this._envelope += releaseCoeff * (0 - this._envelope);
      }

      const gateGain = (1 - depth) + this._envelope * depth;

      for (let ch = 0; ch < 2; ch++) {
        const inCh  = input[ch]  || input[0];
        const outCh = output[ch] || output[0];
        if (!outCh) continue;
        outCh[i] = inCh[i] * gateGain;
      }

      this._phase += phaseInc;
      if (this._phase >= 1) this._phase -= 1;
    }

    return true;
  }
}

registerProcessor('trance-gate', TranceGateProcessor);
