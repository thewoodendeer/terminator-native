class StereoWidenerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'width', defaultValue: 2, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'mix',   defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input[0]) return true;

    const width = parameters.width[0];
    const mix   = parameters.mix[0];

    for (let i = 0; i < input[0].length; i++) {
      const L = input[0][i];
      const R = input[1]?.[i] ?? input[0][i];

      const M = (L + R) * 0.5;
      const S = (L - R) * 0.5;

      const Lw = M + S * width;
      const Rw = M - S * width;

      output[0][i] = L * (1 - mix) + Lw * mix;
      output[1][i] = R * (1 - mix) + Rw * mix;
    }
    return true;
  }
}

registerProcessor('stereo-widener', StereoWidenerProcessor);
