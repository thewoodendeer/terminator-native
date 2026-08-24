// CONSOLE — the analog-desk "separation" stage (see public/worklets/
// console-worklet.js for the DSP and the why). One ConsoleStage sits between a
// strip's input and its insert chain (role 'channel', seeded by the strip's
// NAME) and one on the master (role 'bus'). Built for ANY BaseAudioContext,
// so the live graph and every export's OfflineAudioContext run the same code:
// what you heard is what prints. Until the worklet module lands (or if it
// can't) the stage is a clean passthrough — never silence.

export type ConsoleFlavour = 'SSL' | 'NEVE' | 'API' | 'SSL+' | 'NEVE+' | 'API+';
/** The three desks, then their PREMIUM re-models (Terminator 3.0, phase 4.6i — engine/core/fx/ConsoleStage.h).
 *  The plain three are FROZEN: a project saved with SSL has to sound like it did. The '+' three are the same desks
 *  modelled properly (4x-oversampled saturation, a transformer stage on NEVE+, an op-amp edge on SSL+, discrete
 *  class-AB on API+) and are only heard in the native app, where the engine is what makes the sound. */
export const CONSOLE_FLAVOURS: ConsoleFlavour[] = ['SSL', 'NEVE', 'API', 'SSL+', 'NEVE+', 'API+'];

/** One line per desk, for the button tooltips. The '+' entries say plainly what they are, because the difference
 *  between "SSL" and "SSL+" is not guessable from the label. */
export const CONSOLE_FLAVOUR_HELP: Record<ConsoleFlavour, string> = {
  SSL: 'SSL — clean and forward: odd harmonics, tight sub filter, a hair of air on top. The default.',
  NEVE: 'NEVE — transformer warmth: even harmonics, a little weight down low, softened top end.',
  API: 'API — punch: 2nd and 3rd harmonics with a presence lift around 3 kHz.',
  'SSL+': 'SSL+ — the same desk modelled properly: the saturation runs oversampled (so you can push it without fizz) with an op-amp edge that keeps the odd harmonics tight. Pick the plain SSL if you want a project to sound exactly as it did before.',
  'NEVE+': 'NEVE+ — the re-model, with the actual TRANSFORMER: its core saturates on low frequencies first, so the bottom compresses and thickens while the top stays clean. That is the "Neve weight" no static curve gives you.',
  'API+': 'API+ — the re-model: discrete class-AB push, 2nd and 3rd together, oversampled. More punch than the original, and it holds together when driven.',
};

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
