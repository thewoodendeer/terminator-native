// CONSOLE — the analog-desk "separation" stage (see public/worklets/
// console-worklet.js for the DSP and the why). One ConsoleStage sits between a
// strip's input and its insert chain (role 'channel', seeded by the strip's
// NAME) and one on the master (role 'bus'). Built for ANY BaseAudioContext,
// so the live graph and every export's OfflineAudioContext run the same code:
// what you heard is what prints. Until the worklet module lands (or if it
// can't) the stage is a clean passthrough — never silence.

export type ConsoleFlavour = 'SSL' | 'NEVE' | 'API';
export const CONSOLE_FLAVOURS: ConsoleFlavour[] = ['SSL', 'NEVE', 'API'];

export interface ConsoleSettings {
  on: boolean;
  flavour: ConsoleFlavour;
  /** 0–100: scales the drive and the per-strip EQ deviations. 50 = the
   *  default "a real desk" amount; 100 = pushed. */
  amount: number;
}
export const DEFAULT_CONSOLE: ConsoleSettings = { on: false, flavour: 'SSL', amount: 50 };

export function normalizeConsole(p: Partial<ConsoleSettings> | null | undefined): ConsoleSettings {
  const flavour = CONSOLE_FLAVOURS.includes(p?.flavour as ConsoleFlavour) ? (p!.flavour as ConsoleFlavour) : DEFAULT_CONSOLE.flavour;
  const amtRaw = Number(p?.amount);
  const amount = Number.isFinite(amtRaw) ? Math.max(0, Math.min(100, amtRaw)) : DEFAULT_CONSOLE.amount;
  return { on: !!p?.on, flavour, amount };
}

// One addModule per context — every stage in the same AudioContext (or the
// same OfflineAudioContext of an export) shares the load.
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();
function loadConsoleModule(ctx: BaseAudioContext): Promise<void> {
  let p = moduleLoads.get(ctx);
  if (!p) {
    p = ctx.audioWorklet
      ? ctx.audioWorklet.addModule('./worklets/console-worklet.js')
      : Promise.reject(new Error('AudioWorklet unavailable'));
    moduleLoads.set(ctx, p);
  }
  return p;
}

export class ConsoleStage {
  readonly input: GainNode;
  readonly output: GainNode;
  /** Resolves once the processor is in the graph (or has given up). Offline
   *  renders await this before startRendering. */
  readonly ready: Promise<void>;
  private node: AudioWorkletNode | null = null;
  private disposed = false;
  private flavour: ConsoleFlavour;
  private amount: number;

  constructor(ctx: BaseAudioContext, readonly role: 'channel' | 'bus', readonly seed: string, settings: ConsoleSettings) {
    this.flavour = settings.flavour;
    this.amount = settings.amount;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    // Clean passthrough until the processor is up.
    this.input.connect(this.output);
    this.ready = loadConsoleModule(ctx).then(() => {
      if (this.disposed) return;
      const node = new AudioWorkletNode(ctx, 'console-stage', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: { role, seed, flavour: this.flavour, amount: Math.max(0, Math.min(1, this.amount / 100)) },
      });
      this.node = node;
      this.push();
      try { this.input.disconnect(this.output); } catch { /* */ }
      this.input.connect(node);
      node.connect(this.output);
    }).catch((err) => {
      console.warn('[mixer] CONSOLE worklet unavailable, passing through:', err);
    });
  }

  set(flavour: ConsoleFlavour, amount: number): void {
    this.flavour = flavour; this.amount = amount;
    this.push();
  }
  private push(): void {
    if (!this.node) return;
    try { this.node.port.postMessage({ flavour: this.flavour, amount: Math.max(0, Math.min(1, this.amount / 100)) }); } catch { /* */ }
  }

  dispose(): void {
    this.disposed = true;
    for (const n of [this.input, this.node, this.output]) { if (!n) continue; try { n.disconnect(); } catch { /* */ } }
    this.node = null;
  }
}
