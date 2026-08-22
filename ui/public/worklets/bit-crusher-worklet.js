class BitCrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8,  minValue: 1,  maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 1,  minValue: 1,  maxValue: 32, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._held      = [0, 0];
    this._holdCount = [0, 0];
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const bits = parameters.bits[0];
    const rate = Math.round(parameters.rate[0]);
    const step = Math.pow(2, bits - 1);

    for (let ch = 0; ch < 2; ch++) {
      const inCh  = input[ch] || input[0];
      const outCh = output[ch] || output[0];
      if (!outCh) continue;

      for (let i = 0; i < inCh.length; i++) {
        if (this._holdCount[ch] <= 0) {
          this._held[ch]      = Math.round(inCh[i] * step) / step;
          this._holdCount[ch] = rate;
        }
        this._holdCount[ch]--;
        outCh[i] = this._held[ch];
      }
    }
    return true;
  }
}

registerProcessor('bit-crusher', BitCrusherProcessor);
