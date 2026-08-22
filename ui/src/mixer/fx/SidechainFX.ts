import { MixerFX, FxParamValue, clamp, WetDry, setParam } from './base';

// One addModule per context — every SC COMP in the same AudioContext (or the
// same OfflineAudioContext of an export) shares the load.
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();
function loadScCompModule(ctx: BaseAudioContext): Promise<void> {
  let p = moduleLoads.get(ctx);
  if (!p) {
    p = ctx.audioWorklet
      ? ctx.audioWorklet.addModule('./worklets/sc-comp-worklet.js')
      : Promise.reject(new Error('AudioWorklet unavailable'));
    moduleLoads.set(ctx, p);
  }
  return p;
}

/** SC COMP — a compressor keyed from ANOTHER channel (sidechain ducking):
 *  the kick on the SOURCE menu makes the bass, pad or sample duck under every
 *  hit. Web Audio's DynamicsCompressor has no key input, so the detector +
 *  gain computer live in `public/worklets/sc-comp-worklet.js` (input 0 = this
 *  strip, input 1 = the key). The MixerEngine connects the SOURCE strip's
 *  input (pre-fader, pre-insert — so the source's own fader / FX don't change
 *  the ducking) to `sidechainInput`, live and in exports alike. KEY HP filters
 *  the key only (let the kick's thump trigger, not its click). No look-ahead →
 *  zero latency. Until the worklet module has loaded the signal passes clean. */
export class SidechainFX implements MixerFX {
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  readonly sidechainInput: GainNode;
  readonly ready: Promise<void>;
  params: Record<string, FxParamValue> = {
    SOURCE: 'NONE', THRESH: -24, RATIO: 4, ATTACK: 5, RELEASE: 120, HOLD: 0, MAKEUP: 0, KEYHP: 20,
  };
  /** Latest gain reduction reported by the worklet, dB (≤ 0). For the panel meter. */
  gainReductionDb = 0;
  private wd: WetDry;
  private keyHp: BiquadFilterNode;
  private node: AudioWorkletNode | null = null;
  private primed = false;
  private disposed = false;

  constructor(private ctx: BaseAudioContext) {
    this.wd = new WetDry(ctx);
    this.sidechainInput = ctx.createGain();
    this.keyHp = ctx.createBiquadFilter();
    this.keyHp.type = 'highpass';
    this.keyHp.Q.value = -3.0103; // Butterworth (lowpass/highpass Q is in dB)
    this.sidechainInput.connect(this.keyHp);
    // Clean passthrough until the processor is up.
    this.wd.wetIn.connect(this.wd.wetOut);
    this.inputNode = this.wd.input;
    this.outputNode = this.wd.output;
    this.update();
    this.primed = true;
    this.ready = loadScCompModule(ctx).then(() => {
      if (this.disposed) return;
      this.node = new AudioWorkletNode(ctx, 'sc-comp', {
        numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      this.node.port.onmessage = (e: MessageEvent) => { this.gainReductionDb = Number(e.data) || 0; };
      try { this.wd.wetIn.disconnect(this.wd.wetOut); } catch { /* */ }
      this.wd.wetIn.connect(this.node, 0, 0);
      this.keyHp.connect(this.node, 0, 1);
      this.node.connect(this.wd.wetOut);
      this.update(true);
    }).catch(err => {
      // No worklet → stays a clean passthrough (never silence).
      console.warn('SC COMP worklet unavailable, passing through:', err);
    });
  }

  setParam(key: string, value: FxParamValue): void {
    this.params[key] = key === 'SOURCE' ? String(value) : Number(value);
    this.update();
  }
  bypass(on: boolean): void { this.wd.setBypassed(on); }
  latencySec(): number { return 0; }
  dispose(): void {
    this.disposed = true;
    for (const n of [this.sidechainInput, this.keyHp, this.node]) { if (n) { try { n.disconnect(); } catch { /* */ } } }
    if (this.node) { try { this.node.port.onmessage = null; } catch { /* */ } }
    this.wd.disconnect();
  }

  private update(instantOverride = false): void {
    const instant = instantOverride || !this.primed;
    const set = (p: AudioParam | undefined, v: number) => { if (p) setParam(this.ctx, p, v, 0.01, instant); };
    set(this.keyHp.frequency, clamp(Number(this.params.KEYHP), 20, 500));
    const P = this.node?.parameters;
    if (!P) return;
    set(P.get('threshold'), clamp(Number(this.params.THRESH), -60, 0));
    set(P.get('ratio'), clamp(Number(this.params.RATIO), 1, 20));
    set(P.get('attack'), clamp(Number(this.params.ATTACK), 0.1, 500) / 1000);
    set(P.get('release'), clamp(Number(this.params.RELEASE), 5, 2000) / 1000);
    set(P.get('hold'), clamp(Number(this.params.HOLD), 0, 1000) / 1000);
    set(P.get('makeup'), clamp(Number(this.params.MAKEUP), 0, 24));
  }
}
