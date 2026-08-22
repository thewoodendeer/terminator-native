// BASS — Terminator's bass synth voice engine, one AudioWorkletProcessor.
//
// A Minimoog Model D–shaped subtractive synth aimed squarely at bass:
//   3 oscillators (TRI · SHARK · SAW · SQUARE · PULSE · NARROW · SINE, each with
//   a 32'…2' range switch, semitone + fine detune, level) + SUB + NOISE
//   → mixer with the Model D's warm overdrive when you push the levels
//   → analog-modelled filter: LADDER (Moog transistor ladder, 4-pole with the
//     tanh stage nonlinearities, 2× oversampled), OTA (Oberheim SEM–style
//     state-variable, TPT/zero-delay) or DIODE (303/EMS-style diode ladder)
//   → contour (filter) + loudness (amp) envelopes with analog RC curves
//   → post: DRIVE (tape-ish saturation), TONE, GLUE (one-knob comp), OUTPUT.
// Mono (last-note priority + legato + glide) or up to 8-voice poly. Oscillator
// drift + tiny per-voice offsets keep it from sounding like a spreadsheet.
//
// Everything arrives over the port as messages (no AudioParams): a `patch`
// object (continuous fields are smoothed inside), and NOTE events stamped with
// an absolute context time so both the live sequencer and the offline export
// schedule sample-accurately. Oscillators are PolyBLEP anti-aliased.
//
// Loaded by src/renderer/bass/BassEngine.ts in the live context AND in every
// OfflineAudioContext an export spins up (same file, same sound).

const TWO_PI = Math.PI * 2;
const MAX_VOICES = 8;

// ─── PolyBLEP helpers ─────────────────────────────────────────────────────────
// t = phase in [0,1), dt = phase increment. Returns the residual to ADD at a
// discontinuity of height 1 (saw drop / pulse edge).
function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// Fast tanh (Padé) — close enough for saturation, ~4× cheaper than Math.tanh.
function ftanh(x) {
  if (x > 4.97) return 1;
  if (x < -4.97) return -1;
  const x2 = x * x;
  return x * (135135 + x2 * (17325 + x2 * (378 + x2))) / (135135 + x2 * (62370 + x2 * (3150 + x2 * 28)));
}

// ─── Oscillator ──────────────────────────────────────────────────────────────
// SHAPE morph order (his design, 2026-08-19): a knob from full-left TRIANGLE
// through the shapes to full-right SINE, crossfading neighbours so the timbre
// evolves continuously — an in-between you can dial.
const MORPH_ORDER = ['tri', 'shark', 'saw', 'square', 'pulse', 'narrow', 'sine'];
class Osc {
  constructor() {
    this.phase = Math.random();
    this.tri = 0;          // leaky integrator state for triangle
    this.triS = 0;         // …and a second one for the shark tooth (morph runs both)
    this.wave = 'saw';
    // per-osc analog drift: slow random walk in cents
    this.drift = 0;
    this.driftTarget = 0;
    this.driftCount = 0;
  }
  // One band-limited sample of `wave` at phase t (0..1), step dt. The tri /
  // shark integrators are advanced by the caller once per sample (see next).
  shapeAt(wave, t, dt, pw) {
    switch (wave) {
      case 'sine': return Math.sin(TWO_PI * t);
      case 'saw': return 2 * t - 1 - polyBlep(t, dt);
      case 'square':
      case 'pulse':
      case 'narrow': {
        const w = wave === 'square' ? 0.5 : wave === 'pulse' ? 0.25 : pw;
        let v = t < w ? 1 : -1;
        v += polyBlep(t, dt);
        v -= polyBlep((t + 1 - w) % 1, dt);
        // remove the DC that an asymmetric pulse carries
        return v - (2 * w - 1);
      }
      case 'tri': return this.tri;
      case 'shark': return 0.62 * this.triS + 0.5 * (2 * t - 1 - polyBlep(t, dt));
      default: return 2 * t - 1 - polyBlep(t, dt);
    }
  }
  // Returns one sample at frequency `freq` (Hz), pulse width pw (0.05..0.95).
  // wave 'morph' crossfades neighbours in MORPH_ORDER at position morph (0..1).
  next(freq, sr, wave, pw, morph) {
    const dt = freq / sr;
    if (dt >= 0.5) return 0;                // above Nyquist: silence, don't alias
    let t = this.phase;
    // Band-limited triangle = leaky-integrated BLEP square. Both integrators
    // run every sample so a morph crossing into tri/shark finds them settled.
    let sq = t < 0.5 ? 1 : -1;
    sq += polyBlep(t, dt);
    sq -= polyBlep((t + 0.5) % 1, dt);
    this.tri = this.tri * (1 - 4 * dt) + sq * 4 * dt;   // gain-normalised integrator
    this.triS = this.triS * (1 - 4 * dt) + sq * 4 * dt;
    let out;
    if (wave === 'morph') {
      const pos = Math.max(0, Math.min(1, +morph || 0)) * (MORPH_ORDER.length - 1);
      const i = Math.min(MORPH_ORDER.length - 2, Math.floor(pos));
      const f = pos - i;
      const a = this.shapeAt(MORPH_ORDER[i], t, dt, pw);
      out = f > 0.0005 ? a * (1 - f) + this.shapeAt(MORPH_ORDER[i + 1], t, dt, pw) * f : a;
    } else {
      out = this.shapeAt(wave, t, dt, pw);
    }
    t += dt;
    if (t >= 1) t -= 1;
    this.phase = t;
    return out;
  }
  // Slow random walk, ±maxCents. Called once per block.
  stepDrift(maxCents, blockSec) {
    if (this.driftCount <= 0) {
      this.driftTarget = (Math.random() * 2 - 1) * maxCents;
      this.driftCount = 0.15 + Math.random() * 0.6;   // seconds until the next target
    }
    this.driftCount -= blockSec;
    this.drift += (this.driftTarget - this.drift) * Math.min(1, blockSec * 3);
    return this.drift;
  }
}

// ─── Envelopes (analog RC-shaped ADSR) ───────────────────────────────────────
class ADSR {
  constructor() { this.stage = 0; this.v = 0; this.a = 0.005; this.d = 0.2; this.s = 0.7; this.r = 0.2; }
  set(a, d, s, r) { this.a = Math.max(0.0005, a); this.d = Math.max(0.001, d); this.s = Math.min(1, Math.max(0, s)); this.r = Math.max(0.002, r); }
  gate(on) {
    if (on) { this.stage = 1; }
    else if (this.stage !== 0) this.stage = 4;
  }
  retrigger() { this.stage = 1; }
  get active() { return this.stage !== 0; }
  next(sr) {
    switch (this.stage) {
      case 1: { // attack: RC toward 1.25 so it hits 1 with a convex knee
        const k = 1 - Math.exp(-1 / (this.a * sr));
        this.v += (1.25 - this.v) * k;
        if (this.v >= 1) { this.v = 1; this.stage = 2; }
        break;
      }
      case 2: { // decay: exponential toward sustain
        const k = 1 - Math.exp(-1 / (this.d * sr * 0.6));
        this.v += (this.s - this.v) * k;
        if (this.v - this.s < 0.0005) { this.v = this.s; this.stage = 3; }
        break;
      }
      case 3: this.v = this.s; break;
      case 4: { // release
        const k = 1 - Math.exp(-1 / (this.r * sr * 0.6));
        this.v += (0 - this.v) * k;
        if (this.v < 0.0004) { this.v = 0; this.stage = 0; }
        break;
      }
      default: this.v = 0;
    }
    return this.v;
  }
}

// ─── Filters ─────────────────────────────────────────────────────────────────
// Moog transistor ladder — the D'Angelo & Välimäki "improved" model: four
// tanh-coupled one-pole stages, trapezoidal integration, run 2× oversampled.
class Ladder {
  constructor() { this.V = [0, 0, 0, 0]; this.dV = [0, 0, 0, 0]; this.tV = [0, 0, 0, 0]; this.g = 0; }
  reset() { this.V.fill(0); this.dV.fill(0); this.tV.fill(0); }
  setCutoff(hz, sr2) {
    const x = Math.PI * hz / sr2;
    this.g = 4 * Math.PI * VT * hz * (1 - x) / (1 + x);
  }
  // in: input sample; res: 0..4 (4 ≈ self-osc); drive: input gain; poles 1..4
  process(inp, res, drive, poles, sr2) {
    const V = this.V, dV = this.dV, tV = this.tV, g = this.g;
    const inv2VT = 1 / (2 * VT), h = 1 / (2 * sr2);
    let out = 0;
    for (let k = 0; k < 2; k++) {                     // 2× oversample (ZOH input)
      const dV0 = -g * (ftanh((drive * inp + res * V[3]) * inv2VT) + tV[0]);
      V[0] += (dV0 + dV[0]) * h; dV[0] = dV0; tV[0] = ftanh(V[0] * inv2VT);
      const dV1 = g * (tV[0] - tV[1]);
      V[1] += (dV1 + dV[1]) * h; dV[1] = dV1; tV[1] = ftanh(V[1] * inv2VT);
      const dV2 = g * (tV[1] - tV[2]);
      V[2] += (dV2 + dV[2]) * h; dV[2] = dV2; tV[2] = ftanh(V[2] * inv2VT);
      const dV3 = g * (tV[2] - tV[3]);
      V[3] += (dV3 + dV[3]) * h; dV[3] = dV3; tV[3] = ftanh(V[3] * inv2VT);
      out = V[poles - 1];
    }
    return -out;
  }
}
const VT = 0.312;

// SEM/OTA-style state-variable filter — Cytomic/Zavalishin TPT form with soft
// saturation on the integrator states. 12 dB/oct; a second instance cascades
// for 24. Modes: lp / bp / hp.
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.g = 0; this.k = 1; this.a1 = 0; this.a2 = 0; this.a3 = 0; }
  reset() { this.ic1 = 0; this.ic2 = 0; }
  set(hz, res, sr) {
    this.g = Math.tan(Math.PI * Math.min(0.49 * sr, hz) / sr);
    this.k = 2 - 1.98 * Math.min(1, Math.max(0, res));
    this.a1 = 1 / (1 + this.g * (this.g + this.k));
    this.a2 = this.g * this.a1;
    this.a3 = this.g * this.a2;
  }
  process(v0, mode) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    // gentle OTA saturation of the state — keeps self-oscillation bounded
    this.ic1 = ftanh(2 * v1 - this.ic1);
    this.ic2 = ftanh(2 * v2 - this.ic2);
    if (mode === 'bp') return v1;
    if (mode === 'hp') return v0 - this.k * v1 - v2;
    return v2;
  }
}

// Diode ladder (TB-303 / EMS lineage) — Zavalishin/Pirkle zero-delay-feedback
// topology: four one-pole stages, each cross-coupled to the next, one global
// feedback K (0 → ~17 self-osc), tanh in the loop.
class Diode {
  constructor() {
    this.z = [0, 0, 0, 0];      // per-stage z^-1
    this.alpha = 0; this.gamma = 0;
    this.beta = [0, 0, 0, 0]; this.gam = [0, 0, 0, 0]; this.delta = [0, 0, 0, 0]; this.eps = [0, 0, 0, 0]; this.a0 = [1, 0.5, 0.5, 0.5];
    this.SG = [0, 0, 0, 1];
    this.fb = [0, 0, 0, 0];
  }
  reset() { this.z.fill(0); this.fb.fill(0); }
  set(hz, sr) {
    const g = Math.tan(Math.PI * Math.min(0.45 * sr, hz) / sr);
    const G4 = 0.5 * g / (1 + g);
    const G3 = 0.5 * g / (1 + g - 0.5 * g * G4);
    const G2 = 0.5 * g / (1 + g - 0.5 * g * G3);
    const G1 = g / (1 + g - g * G2);
    this.gamma = G4 * G3 * G2 * G1;
    this.SG[0] = G4 * G3 * G2; this.SG[1] = G4 * G3; this.SG[2] = G4; this.SG[3] = 1;
    this.alpha = g / (1 + g);
    this.beta[0] = 1 / (1 + g - g * G2); this.gam[0] = 1 + G1 * G2; this.delta[0] = g; this.eps[0] = G2;
    this.beta[1] = 1 / (1 + g - 0.5 * g * G3); this.gam[1] = 1 + G2 * G3; this.delta[1] = 0.5 * g; this.eps[1] = G3;
    this.beta[2] = 1 / (1 + g - 0.5 * g * G4); this.gam[2] = 1 + G3 * G4; this.delta[2] = 0.5 * g; this.eps[2] = G4;
    this.beta[3] = 1 / (1 + g); this.gam[3] = 1; this.delta[3] = 0; this.eps[3] = 0;
  }
  fbOut(i) { return this.beta[i] * (this.z[i] + this.fb[i] * this.delta[i]); }
  stage(i, xn) {
    const xin = xn * this.gam[i] + this.fb[i] + this.eps[i] * this.fbOut(i);
    const vn = (this.a0[i] * xin - this.z[i]) * this.alpha;
    const out = vn + this.z[i];
    this.z[i] = vn + out;
    return out;
  }
  process(xn, K) {
    this.fb[2] = this.fbOut(3);
    this.fb[1] = this.fbOut(2);
    this.fb[0] = this.fbOut(1);
    const sigma = this.SG[0] * this.fbOut(0) + this.SG[1] * this.fbOut(1) + this.SG[2] * this.fbOut(2) + this.SG[3] * this.fbOut(3);
    // Zavalishin: input compensation so the level holds up as K rises
    xn *= 1 + 0.3 * K;
    const un = ftanh((xn - K * sigma) / (1 + K * this.gamma));
    return this.stage(3, this.stage(2, this.stage(1, this.stage(0, un))));
  }
}

// ─── Voice ───────────────────────────────────────────────────────────────────
class Voice {
  constructor(idx) {
    this.idx = idx;
    this.osc = [new Osc(), new Osc(), new Osc()];
    this.sub = new Osc();
    this.noiseB0 = 0; this.noiseB1 = 0; this.noiseB2 = 0;   // pink filter
    this.ampEnv = new ADSR();
    this.filtEnv = new ADSR();
    this.ladder = new Ladder();
    this.svfA = new SVF(); this.svfB = new SVF();
    this.diode = new Diode();
    this.note = -1;
    this.vel = 1;
    this.pitch = 48;         // current (gliding) MIDI pitch, float
    this.targetPitch = 48;
    // SLIDE (FL-style slide note): a linear pitch ramp from slideFrom to
    // targetPitch over slideDur seconds, overriding the exp glide while it runs.
    this.slideDur = 0; this.slideT = 0; this.slideFrom = 48;
    this.active = false;
    this.startedAt = 0;
    // fixed per-voice analog offsets (cents)
    this.offs = [(Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3];
    this.driftCents = [0, 0, 0];
  }
  start(note, vel, legato, glideSec, sr, when) {
    const wasActive = this.active && this.ampEnv.active;
    this.note = note;
    this.vel = vel;
    this.targetPitch = note;
    this.slideDur = 0;   // a fresh note-on ends any slide in progress
    if (!wasActive) { this.pitch = note; }
    else if (glideSec <= 0.001) this.pitch = note;
    this.active = true;
    this.startedAt = when;
    if (!(legato && wasActive)) {
      this.ampEnv.gate(true);
      this.filtEnv.gate(true);
      if (!wasActive) { this.ladder.reset(); this.svfA.reset(); this.svfB.reset(); this.diode.reset(); }
    }
  }
  release() { this.ampEnv.gate(false); this.filtEnv.gate(false); }
  /** Bend this voice's pitch to `note` over `sec` seconds, linearly in
   *  semitones (the FL slide). The voice keeps its identity (`this.note`), so
   *  the original note-off still finds and releases it. */
  slide(note, sec) {
    this.slideFrom = this.pitch;
    this.targetPitch = note;
    this.slideT = 0;
    this.slideDur = Math.max(0.002, sec);
  }
  kill() { this.active = false; this.ampEnv.stage = 0; this.ampEnv.v = 0; this.filtEnv.stage = 0; this.filtEnv.v = 0; this.note = -1; }
}

// ─── Processor ───────────────────────────────────────────────────────────────
class BassSynthProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = [];
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new Voice(i));
    this.events = [];           // sorted by .at (ctx seconds)
    this.held = [];             // mono note stack (last-note priority)
    this.patch = defaultPatch();
    // smoothed continuous params
    this.sm = { cutoff: this.patch.filter.cutoff, res: this.patch.filter.reso, drive: this.patch.post.drive, gain: this.patch.post.gain, mixDrive: this.patch.mixerDrive };
    this.lfoPhase = 0;
    this.lastLfo = 0;
    // MOD sources: 3 free LFOs + 2 trigger envelopes (fire on every note-on)
    this.modLfoPhase = [0, 0, 0];
    this.modLfoSH = [0, 0, 0];
    this.trigT = [-1, -1];      // seconds since trigger, -1 = idle
    this.modOut = { lfo1: 0, lfo2: 0, lfo3: 0, trigA: 0, trigB: 0 };
    this.compEnv = 0;
    this.toneZ = 0;
    this.dcX = 0; this.dcY = 0;
    this.meterAcc = 0; this.meterCount = 0;
    this.pitchBend = 0;   // semitones
    this.modWheel = 0;    // 0..1 → extra LFO depth
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'patch': this.patch = mergePatch(defaultPatch(), m.patch || {}); break;
      case 'note': {
        // {on, note, vel, at, id}
        const ev = { on: !!m.on, note: m.note | 0, vel: typeof m.vel === 'number' ? m.vel : 1, at: typeof m.at === 'number' ? m.at : 0, tag: m.tag || 0, slide: !!m.slide, dur: typeof m.dur === 'number' ? m.dur : 0 };
        if (ev.at <= currentTime) ev.at = 0;   // fire now
        this.insertEvent(ev);
        break;
      }
      case 'notes': {
        // bulk: [{on, note, vel, at, tag}]
        for (const n of m.list || []) {
          const ev = { on: !!n.on, note: n.note | 0, vel: typeof n.vel === 'number' ? n.vel : 1, at: typeof n.at === 'number' ? n.at : 0, tag: n.tag || 0, slide: !!n.slide, dur: typeof n.dur === 'number' ? n.dur : 0 };
          if (ev.at <= currentTime) ev.at = 0;
          this.insertEvent(ev);
        }
        break;
      }
      case 'clear': {
        // drop pending events (optionally only a tag), release what's playing
        const tag = m.tag;
        this.events = tag ? this.events.filter((e) => e.tag !== tag) : [];
        if (m.release !== false) { this.held = []; for (const v of this.voices) if (v.active) v.release(); }
        break;
      }
      case 'panic': this.events = []; this.held = []; for (const v of this.voices) v.kill(); break;
      // bend: immediate (the wheel) or timed (`at` in the future → queued with
      // the note events, so a recorded/drawn BEND lane plays sample-aligned).
      case 'bend': {
        const at = typeof m.at === 'number' ? m.at : 0;
        if (at > currentTime) this.insertEvent({ bend: true, semis: +m.semis || 0, at, tag: m.tag || 0, on: false, note: 0, vel: 0 });
        else this.pitchBend = +m.semis || 0;
        break;
      }
      case 'bends': {
        // bulk timed bends: [{semis, at, tag}]
        for (const b of m.list || []) {
          const at = typeof b.at === 'number' ? b.at : 0;
          if (at > currentTime) this.insertEvent({ bend: true, semis: +b.semis || 0, at, tag: b.tag || 0, on: false, note: 0, vel: 0 });
          else this.pitchBend = +b.semis || 0;
        }
        break;
      }
      case 'mod': this.modWheel = Math.min(1, Math.max(0, +m.value || 0)); break;
      default: break;
    }
  }

  insertEvent(ev) {
    const arr = this.events;
    let i = arr.length;
    while (i > 0 && arr[i - 1].at > ev.at) i--;
    arr.splice(i, 0, ev);
  }

  // ── voice allocation ──
  noteOn(note, vel, when) {
    const p = this.patch;
    const sr = sampleRate;
    // MOD: trigger envelopes restart, key-synced LFOs restart their cycle
    this.trigT[0] = 0; this.trigT[1] = 0;
    if (p.modSrc) for (let i = 0; i < 3; i++) if (p.modSrc.lfo[i] && p.modSrc.lfo[i].key) this.modLfoPhase[i] = 0;
    if (p.voices <= 1) {
      // MONO: last-note priority, legato when a note is already held
      const idx = this.held.indexOf(note);
      if (idx >= 0) this.held.splice(idx, 1);
      this.held.push(note);
      const legato = p.legato && this.held.length > 1;
      this.voices[0].start(note, vel, legato, p.glide, sr, when);
      return;
    }
    // POLY: reuse a voice already on this note, else a free one, else steal the oldest
    let v = this.voices.find((x) => x.active && x.note === note);
    if (!v) v = this.voices.slice(0, p.voices).find((x) => !x.active || !x.ampEnv.active);
    if (!v) {
      let oldest = this.voices[0];
      for (const x of this.voices.slice(0, p.voices)) if (x.startedAt < oldest.startedAt) oldest = x;
      v = oldest;
    }
    v.start(note, vel, false, p.glide, sr, when);
  }
  noteOff(note) {
    const p = this.patch;
    if (p.voices <= 1) {
      const idx = this.held.indexOf(note);
      if (idx >= 0) this.held.splice(idx, 1);
      const v = this.voices[0];
      if (v.note === note) {
        if (this.held.length) {
          // fall back to the most recent still-held note (Model D style)
          const back = this.held[this.held.length - 1];
          v.start(back, v.vel, p.legato, p.glide, sampleRate, currentTime);
          if (!p.legato) { /* re-triggers */ }
        } else v.release();
      }
      return;
    }
    for (const v of this.voices) if (v.active && v.note === note && v.ampEnv.stage !== 4 && v.ampEnv.stage !== 0) v.release();
  }

  /** SLIDE NOTE (FL-style): every voice sounding right now bends to `note`
   *  over `sec` seconds and stays there. Nothing is triggered — with nothing
   *  playing a slide note is silent, exactly like FL. */
  slideTo(note, sec) {
    for (const v of this.voices) if (v.active && v.ampEnv.active) v.slide(note, sec);
  }

  // Advance LFO/trigger sources one block and return the patch with every
  // modulated target replaced by its modulated value (containers on the path
  // are cloned; everything else is shared). Log-taper targets (cutoff, tone,
  // env times, LFO rates) modulate in octaves; linear ones by a fraction of
  // their range.
  applyMods(base, blockSec) {
    const ms = base.modSrc, mods = base.mods;
    this.modsOnCutoff = false;
    if (!ms || !mods || !mods.length) return base;
    const out = this.modOut;
    for (let i = 0; i < 3; i++) {
      const l = ms.lfo[i]; if (!l) { out['lfo' + (i + 1)] = 0; continue; }
      let ph = this.modLfoPhase[i] + Math.max(0.01, l.rate) * blockSec;
      if (ph >= 1) { ph -= Math.floor(ph); this.modLfoSH[i] = Math.random() * 2 - 1; }
      this.modLfoPhase[i] = ph;
      let v;
      switch (l.wave) {
        case 'square': v = ph < 0.5 ? 1 : -1; break;
        case 'saw': v = 1 - 2 * ph; break;
        case 'ramp': v = 2 * ph - 1; break;
        case 'sine': v = Math.sin(TWO_PI * ph); break;
        case 'sh': v = this.modLfoSH[i]; break;
        default: v = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;   // tri
      }
      out['lfo' + (i + 1)] = v;
    }
    for (let i = 0; i < 2; i++) {
      const tg = ms.trig[i]; const key = i === 0 ? 'trigA' : 'trigB';
      if (!tg || this.trigT[i] < 0) { out[key] = 0; continue; }
      const t = this.trigT[i];
      const ramp = Math.max(0.001, tg.ramp), fall = Math.max(0.005, tg.fall);
      let v;
      if (t < ramp) v = t / ramp;
      else if (t < ramp + fall) { const u = (t - ramp) / fall; v = tg.shape === 'lin' ? 1 - u : Math.exp(-4.5 * u) * (1 - u * 0.011); }
      else { v = 0; this.trigT[i] = -1; }
      out[key] = v;
      if (this.trigT[i] >= 0) this.trigT[i] = t + blockSec;
    }
    // apply
    let eff = null;
    for (const m of mods) {
      const src = out[m.src]; if (!m.target || !src || !m.depth) continue;
      const parts = m.target.split('.');
      if (!eff) eff = { ...base };
      let cur = eff, curBase = base;
      for (let k = 0; k < parts.length - 1; k++) {
        const key = parts[k];
        const nextBase = curBase[key];
        if (nextBase === undefined) { cur = null; break; }
        if (cur[key] === nextBase) cur[key] = Array.isArray(nextBase) ? [...nextBase] : { ...nextBase };
        cur = cur[key]; curBase = nextBase;
      }
      if (!cur) continue;
      const last = parts[parts.length - 1];
      const v = +cur[last];
      if (!Number.isFinite(v)) continue;
      const r = modRange(m.target);
      let nv;
      if (r.log) nv = v * Math.pow(2, m.depth * src * r.oct);
      else nv = v + m.depth * src * (r.max - r.min);
      cur[last] = Math.max(r.min, Math.min(r.max, nv));
      if (m.target === 'filter.cutoff') this.modsOnCutoff = true;
    }
    return eff || base;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const L = out[0], R = out[1] || null;
    const n = L.length;
    const sr = sampleRate;
    const t0 = currentTime;
    // ── MOD matrix: advance the sources, then read the patch THROUGH them ──
    const p = this.applyMods(this.patch, n / sr);

    // ── per-block: smooth params, drift, envelope times ──
    const sm = this.sm;
    const smooth = (cur, target, tau) => cur + (target - cur) * Math.min(1, (n / sr) / tau);
    sm.cutoff = smooth(sm.cutoff, p.filter.cutoff, this.modsOnCutoff ? 0.004 : 0.02);
    sm.res = smooth(sm.res, p.filter.reso, 0.02);
    sm.drive = smooth(sm.drive, p.post.drive, 0.03);
    sm.gain = smooth(sm.gain, p.post.gain, 0.03);
    sm.mixDrive = smooth(sm.mixDrive, p.mixerDrive, 0.03);
    const blockSec = n / sr;
    const driftMax = p.drift * 6;   // cents at drift=1
    for (const v of this.voices) {
      if (!v.active) continue;
      v.ampEnv.set(p.ampEnv.a, p.ampEnv.d, p.ampEnv.s, p.ampEnv.r);
      v.filtEnv.set(p.filtEnv.a, p.filtEnv.d, p.filtEnv.s, p.filtEnv.r);
      for (let i = 0; i < 3; i++) v.driftCents[i] = driftMax > 0 ? v.osc[i].stepDrift(driftMax, blockSec) : 0;
    }
    // LFO (block-rate advance, sample-rate read via phase)
    const lfoInc = p.lfo.rate / sr;
    const lfoDepthCut = p.lfo.toCutoff + this.modWheel * 0.5;
    const lfoDepthPitch = p.lfo.toPitch + this.modWheel * 0.3;

    // ── oscillator settings resolved once per block ──
    const oscOn = [p.osc[0].on && p.osc[0].level > 0, p.osc[1].on && p.osc[1].level > 0, p.osc[2].on && p.osc[2].level > 0];
    const oscSemis = [0, 0, 0];
    for (let i = 0; i < 3; i++) oscSemis[i] = p.osc[i].octave * 12 + p.osc[i].semi + p.osc[i].fine / 100;
    const subOn = p.sub.level > 0;
    const noiseOn = p.noise.level > 0;
    const anyMix = oscOn[0] || oscOn[1] || oscOn[2] || subOn || noiseOn;
    const mixPre = 1 + sm.mixDrive * 5;
    const mixNorm = 1 / ftanh(mixPre * 0.8);   // keep loudness roughly level while driven
    const glideK = p.glide > 0.001 ? 1 - Math.exp(-1 / (p.glide * sr * 0.35)) : 1;
    const sr2 = sr * 2;
    const filtModel = p.filter.model;
    const poles = Math.min(4, Math.max(1, p.filter.poles | 0));
    const kbdTrack = p.filter.kbd;
    const envAmt = p.filter.envAmt;      // -1..1 → ± 8 octaves
    const velAmp = p.velAmp, velFilt = p.velFilt;
    const postDrivePre = 1 + sm.drive * 9;
    const postNorm = sm.drive > 0 ? 1 / ftanh(postDrivePre * 0.7) * (0.85 + 0.15 * (1 - sm.drive)) : 1;
    const toneK = 1 - Math.exp(-TWO_PI * p.post.tone / sr);   // one-pole LP; tone in Hz
    const glue = p.post.glue;

    let evIdx = 0;
    const events = this.events;
    let level = 0;

    for (let i = 0; i < n; i++) {
      const tNow = t0 + i / sr;
      // fire due events (at=0 → immediately)
      while (evIdx < events.length && events[evIdx].at <= tNow) {
        const ev = events[evIdx++];
        if (ev.bend) this.pitchBend = ev.semis;
        else if (ev.slide) this.slideTo(ev.note, ev.dur);
        else if (ev.on) this.noteOn(ev.note, ev.vel, tNow); else this.noteOff(ev.note);
      }

      // LFO
      this.lfoPhase += lfoInc; if (this.lfoPhase >= 1) this.lfoPhase -= 1;
      let lfo;
      switch (p.lfo.wave) {
        case 'square': lfo = this.lfoPhase < 0.5 ? 1 : -1; break;
        case 'saw': lfo = 1 - 2 * this.lfoPhase; break;
        case 'sh': if (this.lfoPhase < lfoInc) this.lastLfo = Math.random() * 2 - 1; lfo = this.lastLfo; break;
        default: lfo = this.lfoPhase < 0.5 ? 4 * this.lfoPhase - 1 : 3 - 4 * this.lfoPhase; // triangle
      }

      let mix = 0;
      for (let vi = 0; vi < MAX_VOICES; vi++) {
        const v = this.voices[vi];
        if (!v.active) continue;
        const amp = v.ampEnv.next(sr);
        if (!v.ampEnv.active) { v.active = false; v.note = -1; continue; }
        const fenv = v.filtEnv.next(sr);
        // slide (linear ramp) beats glide (exp) while it runs
        if (v.slideDur > 0) {
          v.slideT += 1 / sr;
          const k = v.slideT / v.slideDur;
          if (k >= 1) { v.slideDur = 0; v.pitch = v.targetPitch; }
          else v.pitch = v.slideFrom + (v.targetPitch - v.slideFrom) * k;
        } else if (v.pitch !== v.targetPitch) {
          v.pitch += (v.targetPitch - v.pitch) * glideK;
          if (Math.abs(v.pitch - v.targetPitch) < 0.0005) v.pitch = v.targetPitch;
        }
        const basePitch = v.pitch + this.pitchBend + lfo * lfoDepthPitch;
        // oscillators
        let s = 0;
        if (anyMix) {
          for (let o = 0; o < 3; o++) {
            if (!oscOn[o]) continue;
            const cents = v.offs[o] * p.drift + v.driftCents[o];
            const f = 440 * Math.pow(2, (basePitch + oscSemis[o] + cents / 100 - 69) / 12);
            s += v.osc[o].next(f, sr, p.osc[o].wave, p.osc[o].pw, p.osc[o].morph) * p.osc[o].level;
          }
          if (subOn) {
            const f = 440 * Math.pow(2, (basePitch + oscSemis[0] - 12 * p.sub.octave - 69) / 12);
            s += v.sub.next(f, sr, p.sub.wave, 0.5) * p.sub.level;
          }
          if (noiseOn) {
            const w = Math.random() * 2 - 1;
            let nz = w;
            if (p.noise.color === 'pink') {
              v.noiseB0 = 0.99765 * v.noiseB0 + w * 0.0990460;
              v.noiseB1 = 0.96300 * v.noiseB1 + w * 0.2965164;
              v.noiseB2 = 0.57000 * v.noiseB2 + w * 1.0526913;
              nz = (v.noiseB0 + v.noiseB1 + v.noiseB2 + w * 0.1848) * 0.25;
            }
            s += nz * p.noise.level;
          }
        }
        // mixer overdrive (Model D: pushing the mixer into the filter clips warmly)
        s = ftanh(s * mixPre * 0.8) * mixNorm * 0.9;

        // filter cutoff: base × kbd tracking × envelope × LFO × velocity
        const velF = 1 + (v.vel - 1) * velFilt;               // 0..1 scaling
        let octs = kbdTrack * (v.pitch - 48) / 12
          + envAmt * 8 * fenv * velF
          + lfo * lfoDepthCut * 3;
        let fc = sm.cutoff * Math.pow(2, octs);
        if (fc < 15) fc = 15; else if (fc > 18000) fc = 18000;
        let y;
        if (filtModel === 'ota') {
          v.svfA.set(fc, sm.res, sr);
          y = v.svfA.process(s * (1 + p.filter.drive * 2), p.filter.mode);
          if (poles > 2) { v.svfB.set(fc, sm.res * 0.6, sr); y = v.svfB.process(y, p.filter.mode); }
          y *= 1 / (1 + p.filter.drive);
        } else if (filtModel === 'diode') {
          v.diode.set(fc, sr);
          y = v.diode.process(s * (0.6 + p.filter.drive * 1.5), sm.res * 24) * 1.4;   // K≈22 = self-osc edge in this model
        } else {
          v.ladder.setCutoff(fc, sr2);
          // resonance 0..1 → 0..4; small level compensation as res rises
          y = v.ladder.process(s, sm.res * 4, 0.7 + p.filter.drive * 2.5, poles, sr2) * (1 + sm.res * 0.6) * 1.15;
        }
        const velA = 1 + (v.vel - 1) * velAmp;
        mix += y * amp * velA;
      }

      // ── post ──
      // DRIVE: tape-ish saturation
      let x = mix;
      if (sm.drive > 0.001) x = ftanh(x * postDrivePre) * postNorm;
      // TONE: one-pole low-pass (20 kHz = open)
      this.toneZ += (x - this.toneZ) * toneK;
      x = this.toneZ;
      // GLUE: one-knob feed-forward comp
      if (glue > 0.001) {
        const a = Math.abs(x);
        const thr = 0.5 - glue * 0.35;
        const target = a > thr ? thr / a : 1;      // gain to bring peaks to thr
        const rate = target < this.compEnv ? 0.004 : 0.00025;   // fast attack, slow release
        this.compEnv += (target - this.compEnv) * rate;
        x *= this.compEnv * (1 + glue * 0.8);
      }
      x *= sm.gain;
      // DC blocker (~5 Hz) — asymmetric pulses + saturation leave an offset that
      // would otherwise lean on the mixer's compressors
      const dcy = x - this.dcX + 0.9993 * this.dcY;
      this.dcX = x; this.dcY = dcy; x = dcy;
      // final safety clip
      if (x > 1.2) x = 1.2 + ftanh(x - 1.2) * 0.3; else if (x < -1.2) x = -1.2 + ftanh(x + 1.2) * 0.3;
      L[i] = x;
      if (R) R[i] = x;
      const ax = x < 0 ? -x : x;
      if (ax > level) level = ax;
    }
    if (evIdx > 0) events.splice(0, evIdx);

    // meter for the UI (~30 Hz)
    this.meterAcc = Math.max(this.meterAcc, level);
    this.meterCount += n;
    if (this.meterCount >= sr / 30) {
      let playing = 0;
      for (const v of this.voices) if (v.active) playing++;
      this.port.postMessage({ type: 'meter', level: this.meterAcc, voices: playing });
      this.meterAcc = 0; this.meterCount = 0;
    }
    return true;
  }
}

// Range/taper of every modulatable knob (path → limits). Anything unlisted is
// treated as 0..1 linear.
function modRange(path) {
  if (path === 'filter.cutoff') return { min: 20, max: 16000, log: true, oct: 5 };
  if (path === 'post.tone') return { min: 400, max: 20000, log: true, oct: 4 };
  if (/\.(a|d|r)$/.test(path)) return { min: 0.001, max: 4, log: true, oct: 3 };
  if (/^modSrc\.lfo\.\d\.rate$/.test(path)) return { min: 0.05, max: 30, log: true, oct: 3 };
  if (/\.fine$/.test(path)) return { min: -50, max: 50 };
  if (/\.semi$/.test(path)) return { min: -12, max: 12 };
  if (path === 'filter.envAmt') return { min: -1, max: 1 };
  if (path === 'post.gain') return { min: 0, max: 1.5 };
  if (/\.pw$/.test(path)) return { min: 0.05, max: 0.5 };
  if (/\.morph$/.test(path)) return { min: 0, max: 1 };
  if (path === 'glide') return { min: 0, max: 1 };
  return { min: 0, max: 1 };
}

function defaultPatch() {
  return {
    osc: [
      { on: true, wave: 'saw', octave: 0, semi: 0, fine: 0, level: 0.8, pw: 0.5, morph: 0.33 },
      { on: true, wave: 'square', octave: 0, semi: 0, fine: 7, level: 0.55, pw: 0.5, morph: 0.5 },
      { on: false, wave: 'saw', octave: -1, semi: 0, fine: -5, level: 0.4, pw: 0.5, morph: 0.33 },
    ],
    sub: { level: 0.5, wave: 'sine', octave: 1 },
    noise: { level: 0, color: 'white' },
    mixerDrive: 0.15,
    filter: { model: 'ladder', mode: 'lp', cutoff: 420, reso: 0.25, envAmt: 0.45, kbd: 0.3, poles: 4, drive: 0.2 },
    filtEnv: { a: 0.003, d: 0.28, s: 0.15, r: 0.2 },
    ampEnv: { a: 0.004, d: 0.3, s: 0.85, r: 0.12 },
    lfo: { rate: 4.5, wave: 'tri', toCutoff: 0, toPitch: 0 },
    modSrc: {
      lfo: [
        { rate: 4.5, wave: 'tri', key: false },
        { rate: 0.5, wave: 'sine', key: false },
        { rate: 8, wave: 'sh', key: true },
      ],
      trig: [
        { ramp: 0.005, fall: 0.35, shape: 'exp' },
        { ramp: 0.12, fall: 0.6, shape: 'exp' },
      ],
    },
    mods: [],
    glide: 0.04,
    legato: true,
    voices: 1,
    drift: 0.35,
    velAmp: 0.5,
    velFilt: 0.4,
    post: { drive: 0.15, tone: 20000, glue: 0.2, gain: 0.8 },
  };
}

function mergePatch(base, over) {
  if (!over || typeof over !== 'object') return base;
  for (const k of Object.keys(over)) {
    const v = over[k];
    if (Array.isArray(v)) {
      const arr = Array.isArray(base[k]) ? base[k] : [];
      base[k] = v.map((item, i) => (item && typeof item === 'object' && !Array.isArray(item)) ? mergePatch(arr[i] ? { ...arr[i] } : {}, item) : item);
    } else if (v && typeof v === 'object') base[k] = mergePatch(base[k] && typeof base[k] === 'object' ? { ...base[k] } : {}, v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}

registerProcessor('bass-synth', BassSynthProcessor);
