// Registry for the DAW Mixer insert effects: the factory that builds each
// one, plus the parameter metadata the device-panel UI renders from. Keep the
// param `key`s in sync with each effect class's `params`.

import { MixerFX, FxParamValue } from './base';
import { ClipFX } from './ClipFX';
import { WaveFX } from './WaveFX';
import { SatFX } from './SatFX';
import { WideFX } from './WideFX';
import { MseqFX } from './MseqFX';
import { PanFX } from './PanFX';
import { VinylFX } from './VinylFX';
import { FilterFX } from './FilterFX';
import { EqFX } from './EqFX';
import { CompFX } from './CompFX';
import { DelayFX } from './DelayFX';
import { ReverbFX } from './ReverbFX';
import { UtilityFX } from './UtilityFX';
import { PhaserFX } from './PhaserFX';
import { FlangerFX } from './FlangerFX';
import { MbSatFX } from './MbSatFX';
import { SidechainFX } from './SidechainFX';
import { LadderFX } from './LadderFX';
import { FetCompFX } from './FetCompFX';
import { TapeEchoFX } from './TapeEchoFX';
import { PlateVerbFX } from './PlateVerbFX';
import { SaturatorFX } from './SaturatorFX';

export type { MixerFX, FxParamValue } from './base';

export type FxId =
  | 'clip' | 'wave' | 'sat' | 'mbsat' | 'wide' | 'mseq' | 'pan' | 'phaser' | 'flanger'
  | 'vinyl' | 'filter' | 'eq' | 'comp' | 'sccomp' | 'delay' | 'reverb' | 'utility'
  /** Terminator 3.0 PREMIUM devices — the real thing lives in the C++ engine (see LadderFX's header). */
  | 'ladder' | 'fetcomp' | 'tapeecho' | 'plateverb' | 'saturator';

export type ParamSpec =
  | { key: string; label: string; kind: 'slider' | 'knob'; min: number; max: number; step?: number; unit?: string; log?: boolean; center?: number }
  | { key: string; label: string; kind: 'select'; options: Array<{ label: string; value: FxParamValue }>;
      /** 'channels' = the panel replaces `options` with the live mixer strips
       *  (every channel but the one this effect sits on) — the sidechain SOURCE. */
      dynamic?: 'channels' }
  | { key: string; label: string; kind: 'toggle'; onValue: FxParamValue; offValue: FxParamValue };

export interface FxDef {
  name: string;
  /** One-line tooltip: what it does and what to reach for it for. */
  desc: string;
  params: ParamSpec[];
  create(ctx: BaseAudioContext): MixerFX;
}

const sel = (key: string, label: string, values: Array<string | number>, labels?: string[]): ParamSpec => ({
  key, label, kind: 'select',
  options: values.map((v, i) => ({ label: labels?.[i] ?? String(v), value: v })),
});

export const FX_REGISTRY: Record<FxId, FxDef> = {
  clip: {
    name: 'CLIP',
    desc: 'Soft clipper — rounds off peaks so the strip can run hotter without a limiter. AMT = how much of the wave gets rounded',
    params: [{ key: 'AMT', label: 'AMT', kind: 'slider', min: 0, max: 100, unit: '%' }],
    create: (c) => new ClipFX(c),
  },
  wave: {
    name: 'WAVE',
    desc: 'Warm overdrive — tanh drive for thicker harmonics than the clipper. Chops and 808s that need edge',
    params: [{ key: 'DRIVE', label: 'DRIVE', kind: 'slider', min: 0, max: 100, unit: '%' }],
    create: (c) => new WaveFX(c),
  },
  sat: {
    name: 'SAT',
    desc: 'Tape saturation — even-harmonic warmth, low end preserved. Gentle glue on anything',
    params: [{ key: 'DRIVE', label: 'DRIVE', kind: 'slider', min: 0, max: 100, unit: '%' }],
    create: (c) => new SatFX(c),
  },
  mbsat: {
    name: 'MB SAT',
    desc: 'Multiband saturation — drive LOWS, MIDS and HIGHS separately (LO X / HI X set the splits). Fatten a kick without fizzing the hats, or add air up top with the low end untouched',
    params: [
      { key: 'LOW', label: 'LOW', kind: 'knob', min: 0, max: 100, unit: '%' },
      { key: 'MID', label: 'MID', kind: 'knob', min: 0, max: 100, unit: '%' },
      { key: 'HIGH', label: 'HIGH', kind: 'knob', min: 0, max: 100, unit: '%' },
      { key: 'LO_X', label: 'LO X', kind: 'knob', min: 40, max: 2000, log: true, unit: 'Hz' },
      { key: 'HI_X', label: 'HI X', kind: 'knob', min: 500, max: 16000, log: true, unit: 'Hz' },
      { key: 'WET', label: 'DRY/WET', kind: 'knob', min: 0, max: 100, unit: '%' },
    ],
    create: (c) => new MbSatFX(c),
  },
  wide: {
    name: 'WIDE',
    desc: 'Stereo width — 100 = as recorded, 0 = mono, 200 = extra wide. Keep drums narrow, spread pads',
    params: [{ key: 'WIDTH', label: 'WIDTH', kind: 'slider', min: 0, max: 200, center: 100, unit: '%' }],
    create: (c) => new WideFX(c),
  },
  mseq: {
    name: 'M/S EQ',
    desc: 'Mid/Side EQ — a peaking band on the centre and another on the sides. Brighten the width without touching the vocal or kick in the middle',
    params: [
      { key: 'MID_HZ', label: 'MID HZ', kind: 'knob', min: 20, max: 20000, log: true, unit: 'Hz' },
      { key: 'MID_DB', label: 'MID dB', kind: 'knob', min: -18, max: 18, center: 0, unit: 'dB' },
      { key: 'SIDE_HZ', label: 'SIDE HZ', kind: 'knob', min: 20, max: 20000, log: true, unit: 'Hz' },
      { key: 'SIDE_DB', label: 'SIDE dB', kind: 'knob', min: -18, max: 18, center: 0, unit: 'dB' },
    ],
    create: (c) => new MseqFX(c),
  },
  pan: {
    name: 'PAN',
    desc: 'Auto-pan — a sine LFO sweeps the signal left/right at RATE, DEPTH is how far',
    params: [
      { key: 'RATE', label: 'RATE', kind: 'knob', min: 0.1, max: 10, step: 0.1, unit: 'Hz' },
      { key: 'DEPTH', label: 'DEPTH', kind: 'knob', min: 0, max: 100, unit: '%' },
    ],
    create: (c) => new PanFX(c),
  },
  phaser: {
    name: 'PHASER',
    desc: 'Phaser — allpass stages swept by an LFO, mixed with the dry for the classic moving notches. STAGES = how many notches; FBK makes them resonate',
    params: [
      { key: 'RATE', label: 'RATE', kind: 'knob', min: 0.02, max: 10, step: 0.01, log: true, unit: 'Hz' },
      { key: 'DEPTH', label: 'DEPTH', kind: 'knob', min: 0, max: 100, unit: '%' },
      { key: 'CENTER', label: 'CENTER', kind: 'knob', min: 100, max: 8000, log: true, unit: 'Hz' },
      { key: 'FEEDBACK', label: 'FBK', kind: 'knob', min: 0, max: 90, unit: '%' },
      sel('STAGES', 'STAGES', [4, 6, 8, 12]),
      { key: 'WET', label: 'DRY/WET', kind: 'knob', min: 0, max: 100, unit: '%' },
    ],
    create: (c) => new PhaserFX(c),
  },
  flanger: {
    name: 'FLANGER',
    desc: 'Flanger — a very short swept delay fed back on itself: the jet-plane comb sweep. Negative FBK for the hollow, through-zero flavour',
    params: [
      { key: 'RATE', label: 'RATE', kind: 'knob', min: 0.02, max: 8, step: 0.01, log: true, unit: 'Hz' },
      { key: 'DEPTH', label: 'DEPTH', kind: 'knob', min: 0, max: 100, unit: '%' },
      { key: 'DELAY', label: 'DELAY', kind: 'knob', min: 0.3, max: 12, step: 0.1, log: true, unit: 'ms' },
      { key: 'FEEDBACK', label: 'FBK', kind: 'knob', min: -95, max: 95, center: 0, unit: '%' },
      { key: 'WET', label: 'DRY/WET', kind: 'knob', min: 0, max: 100, unit: '%' },
    ],
    create: (c) => new FlangerFX(c),
  },
  vinyl: {
    name: 'VINYL/TAPE',
    desc: 'Vinyl / tape — saturation, high-end age, wow and flutter pitch drift, and a warmth bell in one box. The lo-fi finish',
    params: [
      { key: 'WARMTH', label: 'WARMTH', kind: 'knob', min: 0, max: 10, step: 0.1 },
      { key: 'DRIVE', label: 'DRIVE', kind: 'knob', min: 0, max: 10, step: 0.1 },
      { key: 'WOW', label: 'WOW', kind: 'knob', min: 0, max: 10, step: 0.1 },
      { key: 'FLUTTER', label: 'FLUTTER', kind: 'knob', min: 0, max: 10, step: 0.1 },
      { key: 'AGE', label: 'AGE', kind: 'knob', min: 0, max: 10, step: 0.1 },
    ],
    create: (c) => new VinylFX(c),
  },
  ladder: {
    name: 'ANALOG FILTER',
    desc: 'Moog transistor ladder — the real thing, 4× oversampled: 24/18/12/6 dB lowpass plus highpass and bandpass, DRIVE that saturates the input stage, and RESO that self-oscillates at 100. Rendered by the app\'s engine, so it is in your Master Mixdown and Trackouts (not in the MPC / Drum Rack export, which bakes one-shots)',
    params: [
      sel('MODE', 'MODE', ['LP24', 'LP18', 'LP12', 'LP6', 'HP24', 'HP12', 'BP24', 'BP12'],
          ['LP 24', 'LP 18', 'LP 12', 'LP 6', 'HP 24', 'HP 12', 'BP 24', 'BP 12']),
      { key: 'CUTOFF', label: 'CUTOFF', kind: 'slider', min: 20, max: 20000, log: true, unit: 'Hz' },
      { key: 'RESO', label: 'RESO', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'DRIVE', label: 'DRIVE', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'WET', label: 'WET', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
    ],
    create: (c) => new LadderFX(c),
  },
  saturator: {
    name: 'SATURATOR',
    desc: 'Five analogue flavours on one stage: A is a tube (asymmetric, thickens), E germanium (harder edge), N a British console (the one you leave on everything), T a transformer (the bottom saturates first), P punish (fold-back fuzz). LOWCUT, HIGHCUT and TONE sit BEFORE the curve, so they choose WHAT gets distorted rather than tidying up afterwards. DRIVE 0 is bit-clean and DRIVE is colour, not level — the auto-gain asks the curve what it did. Rendered by the app\'s engine',
    params: [
      sel('STYLE', 'STYLE', ['A TUBE', 'E GERM', 'N BRIT', 'T XFMR', 'P PUNISH']),
      { key: 'DRIVE', label: 'DRIVE', kind: 'slider', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'TONE', label: 'TONE', kind: 'knob', min: -100, max: 100, step: 1, center: 0 },
      { key: 'LOWCUT', label: 'LO CUT', kind: 'knob', min: 20, max: 1000, step: 1, log: true, unit: 'Hz' },
      { key: 'HIGHCUT', label: 'HI CUT', kind: 'knob', min: 1000, max: 20000, step: 10, log: true, unit: 'Hz' },
      { key: 'PUNISH', label: 'PUNISH', kind: 'toggle', onValue: 'ON', offValue: 'OFF' },
      { key: 'OUTPUT', label: 'OUT', kind: 'knob', min: -24, max: 24, step: 0.5, center: 0, unit: 'dB' },
      { key: 'WET', label: 'WET', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
    ],
    create: (c) => new SaturatorFX(c),
  },
  plateverb: {
    name: 'HALL 224',
    desc: 'A real algorithmic reverb — the Lexicon 224 programs on a Dattorro tank. DECAY is in SECONDS (the loop is solved for the RT60 you ask for, so 3 s measures 3 s), BASS is the 224\'s bass decay MULTIPLIER rather than an EQ (2 = the bottom rings twice as long), DAMP is the treble decay, and MOD keeps the tail moving so a long decay never turns into a ringing buzz. A mono source comes back as a stereo room. Rendered by the app\'s engine',
    params: [
      sel('PROGRAM', 'PROGRAM', ['HALL', 'CHAMBER', 'PLATE', 'ROOM', 'AMBIENCE']),
      { key: 'PREDELAY', label: 'PRE', kind: 'knob', min: 0, max: 250, step: 1, unit: 'ms' },
      { key: 'DECAY', label: 'DECAY', kind: 'slider', min: 0.2, max: 20, step: 0.1, log: true, unit: 's' },
      { key: 'SIZE', label: 'SIZE', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'DIFFUSION', label: 'DIFF', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'BASS', label: 'BASS x', kind: 'knob', min: 0.2, max: 4, step: 0.05 },
      { key: 'DAMP', label: 'DAMP', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'MOD', label: 'MOD', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'WET', label: 'WET', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
    ],
    create: (c) => new PlateVerbFX(c),
  },
  tapeecho: {
    name: 'TAPE ECHO',
    desc: 'The RE-201 Space Echo — one tape loop read by three heads at fixed spacings, which is why the multi-head MODES roll the way a single delay cannot. TIME is the MOTOR: moving it bends the pitch of what is already on the tape. The losses live inside the loop, so every repeat is darker and thicker than the last; INTENSITY past ~90 runs away into self-oscillation and the tape saturation is what keeps that musical. WOW is the worn transport, SPRING is the tank. Rendered by the app\'s engine',
    params: [
      sel('MODE', 'HEADS', ['H1', 'H2', 'H3', 'H1+2', 'H2+3', 'H1+3', 'H1+2+3']),
      { key: 'TIME', label: 'TIME', kind: 'slider', min: 20, max: 1500, log: true, unit: 'ms' },
      { key: 'INTENSITY', label: 'INTENS', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'WOW', label: 'WOW', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'SAT', label: 'SAT', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'BASS', label: 'BASS', kind: 'knob', min: -12, max: 12, step: 0.5, center: 0, unit: 'dB' },
      { key: 'TREBLE', label: 'TREBLE', kind: 'knob', min: -12, max: 12, step: 0.5, center: 0, unit: 'dB' },
      { key: 'SPRING', label: 'SPRING', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'WET', label: 'WET', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
    ],
    create: (c) => new TapeEchoFX(c),
  },
  fetcomp: {
    name: 'FET COMP',
    desc: 'The aggressive FET compressor. There is no THRESHOLD on purpose — you drive INTO it with INPUT and bring the level back with OUTPUT, exactly like the hardware. RATIO is the character (NUKE pins it), DETECT decides what the side chain hears so a kick stops ducking everything, and MODE adds the colour: DIST 2 even harmonics, DIST 3 odd, BRITISH faster and dirtier. Rendered by the app\'s engine',
    params: [
      sel('RATIO', 'RATIO', ['1:1', '2:1', '3:1', '4:1', '6:1', '10:1', '20:1', 'NUKE']),
      { key: 'INPUT', label: 'INPUT', kind: 'knob', min: -12, max: 24, step: 0.5, unit: 'dB' },
      { key: 'ATTACK', label: 'ATK', kind: 'knob', min: 0.05, max: 50, step: 0.05, unit: 'ms' },
      { key: 'RELEASE', label: 'REL', kind: 'knob', min: 20, max: 2000, step: 5, unit: 'ms' },
      sel('DETECT', 'DETECT', ['FLAT', 'HP1', 'HP2', 'BAND']),
      sel('MODE', 'MODE', ['CLEAN', 'DIST 2', 'DIST 3', 'BRITISH']),
      { key: 'OUTPUT', label: 'OUT', kind: 'knob', min: -24, max: 24, step: 0.5, unit: 'dB' },
      { key: 'WET', label: 'WET', kind: 'knob', min: 0, max: 100, step: 1, unit: '%' },
    ],
    create: (c) => new FetCompFX(c),
  },
  filter: {
    name: 'FILTER',
    desc: 'Filter — one resonant lowpass / highpass / bandpass / notch. RESO is how much it rings at the cutoff',
    params: [
      sel('TYPE', 'TYPE', ['lowpass', 'highpass', 'bandpass', 'notch'], ['LP', 'HP', 'BP', 'NOTCH']),
      { key: 'CUTOFF', label: 'CUTOFF', kind: 'slider', min: 20, max: 20000, log: true, unit: 'Hz' },
      { key: 'RESO', label: 'RESO', kind: 'knob', min: 0, max: 30, step: 0.1 },
    ],
    create: (c) => new FilterFX(c),
  },
  eq: {
    name: 'EQ',
    desc: '3-band EQ — low shelf at 80 Hz, mid bell at 1 kHz, high shelf at 12 kHz, ±12 dB each',
    params: [
      { key: 'LOW', label: 'LOW', kind: 'slider', min: -12, max: 12, center: 0, unit: 'dB' },
      { key: 'MID', label: 'MID', kind: 'slider', min: -12, max: 12, center: 0, unit: 'dB' },
      { key: 'HIGH', label: 'HIGH', kind: 'slider', min: -12, max: 12, center: 0, unit: 'dB' },
    ],
    create: (c) => new EqFX(c),
  },
  comp: {
    name: 'COMP',
    desc: 'Compressor — pick a STYLE as a starting point, then trim threshold, ratio, attack, release and makeup. NY-PARALLEL blends half dry',
    params: [
      sel('STYLE', 'STYLE', ['OFF', 'LIGHT', 'PUNCHY', 'NY-PARALLEL', 'AGGRESSIVE']),
      { key: 'THRESHOLD', label: 'THRESH', kind: 'knob', min: -60, max: 0, unit: 'dB' },
      { key: 'RATIO', label: 'RATIO', kind: 'knob', min: 1, max: 20, step: 0.1 },
      { key: 'ATTACK', label: 'ATK', kind: 'knob', min: 0.1, max: 100, step: 0.1, unit: 'ms' },
      { key: 'RELEASE', label: 'REL', kind: 'knob', min: 10, max: 1000, unit: 'ms' },
      { key: 'MAKEUP', label: 'MAKEUP', kind: 'knob', min: 0, max: 24, unit: 'dB' },
    ],
    create: (c) => new CompFX(c),
  },
  sccomp: {
    name: 'SC COMP',
    desc: 'Sidechain compressor — ducks THIS channel from another one. SOURCE = the key (put the kick here to make an 808 or pad duck under every hit). THRESH/RATIO how hard, ATK/REL/HOLD the shape, KEY HP keeps the key\'s lows-only from triggering',
    params: [
      { key: 'SOURCE', label: 'SOURCE', kind: 'select', options: [{ label: 'NONE', value: 'NONE' }], dynamic: 'channels' },
      { key: 'THRESH', label: 'THRESH', kind: 'knob', min: -60, max: 0, unit: 'dB' },
      { key: 'RATIO', label: 'RATIO', kind: 'knob', min: 1, max: 20, step: 0.1 },
      { key: 'ATTACK', label: 'ATK', kind: 'knob', min: 0.1, max: 100, step: 0.1, unit: 'ms' },
      { key: 'RELEASE', label: 'REL', kind: 'knob', min: 5, max: 1000, unit: 'ms' },
      { key: 'HOLD', label: 'HOLD', kind: 'knob', min: 0, max: 500, unit: 'ms' },
      { key: 'MAKEUP', label: 'MAKEUP', kind: 'knob', min: 0, max: 24, unit: 'dB' },
      { key: 'KEYHP', label: 'KEY HP', kind: 'knob', min: 20, max: 500, unit: 'Hz', log: true },
    ],
    create: (c) => new SidechainFX(c),
  },
  delay: {
    name: 'DELAY',
    desc: 'Stereo delay — TIME in ms, FEEDBACK for repeats (they darken like tape), PING-PONG bounces them across the field',
    params: [
      { key: 'TIME', label: 'TIME', kind: 'knob', min: 1, max: 2000, unit: 'ms' },
      { key: 'FEEDBACK', label: 'FBK', kind: 'knob', min: 0, max: 95, unit: '%' },
      { key: 'WET', label: 'DRY/WET', kind: 'knob', min: 0, max: 100, unit: '%' },
      { key: 'PINGPONG', label: 'PING-PONG', kind: 'toggle', onValue: 1, offValue: 0 },
    ],
    create: (c) => new DelayFX(c),
  },
  reverb: {
    name: 'REVERB',
    desc: 'Reverb — ROOM sets the size and onset, DECAY the tail length, PRE-DLY holds the room back from the dry hit',
    params: [
      { key: 'ROOM', label: 'ROOM', kind: 'knob', min: 0, max: 100, unit: '%' },
      { key: 'PREDELAY', label: 'PRE-DLY', kind: 'knob', min: 0, max: 100, unit: 'ms' },
      { key: 'DECAY', label: 'DECAY', kind: 'knob', min: 0.1, max: 10, step: 0.1, unit: 's' },
      { key: 'WET', label: 'DRY/WET', kind: 'knob', min: 0, max: 100, unit: '%' },
    ],
    create: (c) => new ReverbFX(c),
  },
  utility: {
    name: 'UTILITY',
    desc: 'Utility — clean gain trim, mono / mono-L / mono-R fold-down, and a phase flip',
    params: [
      { key: 'GAIN', label: 'GAIN', kind: 'knob', min: -20, max: 20, center: 0, unit: 'dB' },
      sel('MODE', 'MODE', ['STEREO', 'MONO', 'MONO-L', 'MONO-R']),
      { key: 'PHASE', label: 'PHASE', kind: 'toggle', onValue: 'inverted', offValue: 'normal' },
    ],
    create: (c) => new UtilityFX(c),
  },
};

/** Ordered list for the “＋ INSERT FX” dropdown. */
export const FX_ORDER: FxId[] = [
  'clip', 'wave', 'sat', 'saturator', 'mbsat', 'wide', 'mseq', 'pan', 'phaser', 'flanger',
  'vinyl', 'filter', 'ladder', 'eq', 'comp', 'fetcomp', 'sccomp', 'delay', 'tapeecho', 'reverb', 'plateverb', 'utility',
];

/** Param keys that are a DRY/WET blend — locked to 100% on send (aux) channels. */
export const WET_PARAM_KEYS = new Set(['WET']);

export function createFx(id: FxId, ctx: BaseAudioContext): MixerFX {
  return FX_REGISTRY[id].create(ctx);
}
