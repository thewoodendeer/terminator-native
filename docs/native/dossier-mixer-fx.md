# TERMINATOR MIXER / FX / CONSOLE / METERING — NATIVE-PORT DOSSIER

Branch `mpc-stem-extractor`, read-only survey 2026-08-22. All paths under `~/terminator/`. "SR" = context sample rate (not fixed — see §4).

---

## 1. SIGNAL FLOW

### 1.1 Sources → mixer (ChopperView.tsx:691-701, ChopperEngine.ts:966-1093)

```
CHOP BUS (ChopperEngine):
  pad voice: BufferSource(detune = (pad.pitch + source pitch + fine/100)·100 cents)
    → voice GainNode (attack ramp, velocity × per-source NORM)         [4425-4452]
    → chopGain (chopVolume × normalizeGain)  [or routeBus for 'sampleN' source strips]
    → padBus
    → [9 "extra FX" spliced lazily on first toggle, order clipper→waveshaper→saturator→widener→mseq→bitcrusher→autopan→trancegate→chorus]  [1100-1110]
    → Filter (LP, Q 6, 20 kHz, bypassed unless enabled) → EQ3 → compMixIn ─┬─ dry (DelayNode = measured comp latency, only when 0<mix<1)
                                                                             └─ Compressor → wet
    → compMixOut → Delay → Reverb → masterGain (0.85) → masterClip (WaveShaper, curve=null/'none' until CLIP>0)
    → masterLimiter (DynamicsCompressor −1 dBFS, knee 0, 20:1, atk 1 ms, rel 50 ms)  ← REMOVED from live path when the desktop mixer attaches (attachMixer 1088-1093): masterClip → outputNode directly
    → outputNode → mixer.getChannelInput('sample')     (+ meterAnalyser fftSize 1024 tap, getPeakLevel)
DRUMS (DrumEngine): hit voice → gain(applyDrumAttack) → [StereoPanner if pan≠0] → lane tap → route gain → mixer strip named by lane key (kick/snare/hat/openhat/perc/user lane)
BASS: bassEngine.outputNode → mixer 'bass' strip
```

### 1.2 ChannelStrip (MixerEngine.ts:155-271, 294-311)

```
input (GainNode, channelCountMode 'explicit', channelCount 2, 'speakers' → mono upmixed L=R BEFORE the strip)
 ├─ [ConsoleStage role 'channel', seed = strip NAME]  (only when CONSOLE on; off = node absent, bit-identical)
 └─ chainIn → FX[0] → … → FX[n-1] (≤8 inserts) → chainOut
      → pdcDelay (DelayNode max 0.25 s)  → matchGain (auto gain match trim) → faderGain → muteGain → StereoPannerNode → output
      output ─┬─ toMaster (DelayNode max 0.25 s) → master.input
              ├─ sendGains[0..3] (regular strips only) → send strip .input
              └─ meter taps: pre = input, post = output, RMS taps = chainIn/chainOut  (one peak-meter worklet, 4 inputs, 0 outputs; analyser fallback)
```
Send/aux strips = same class with `isSend=true`: no send taps, every `WET` param forced to 100 (index.ts:235, MixerEngine 342). Default strips: `sample,kick,snare,hat,openhat,perc` + `send1..4` + master; `addChannel()` creates `sampleN` / user-lane strips (978-1001).

### 1.3 Master (MixerEngine.ts:638-819)
`input(explicit 2ch) → [ConsoleStage role 'bus', seed 'master'] → chainIn → FX ≤8 → chainOut → faderGain → limiter (DynamicsCompressor threshold −1, knee 0, ratio 20, attack 0.001, release 0.05) → output → ctx.destination` ; `output → LoudnessTap.input` (BS.1770 worklet + 8192-bin spectrum analyser) ; pre/post analysers (fftSize 4096). No pan, no sends on master.

### 1.4 Sidechain tap (MixerEngine.ts:934-956)
Every `sccomp` FX listens to `channels.get(params.SOURCE).input` — **pre-console, pre-insert, pre-fader** of the source strip. Re-wired on every chain change (`onChainChanged`) and on `SOURCE` param change. Offline: `keySources` = the DRY source buffers (renderArrangementDAW.ts:198-204).

### 1.5 PDC (compressorLatency.ts; MixerEngine.ts:379-393, 906-965)
| Item | Value |
|---|---|
| `compressorLatencySec(sr)` | Impulse at frame 64 through a transparent DynamicsCompressor (ratio 1, knee 0, thr 0, atk 1 ms, rel 50 ms) in a 50 ms OfflineAudioContext; latency = (argmax‖y‖ − 64)/sr. Cached per SR. Code comment "≈6 ms, 256 frames @44.1k"; memory (audio_engine_pass) records **264 frames measured** @44.1k = 5.99 ms. Never hard-coded. |
| `oversampleLatencySec(sr, mode)` | Same impulse method through a WaveShaper with identity curve: **2x = 128 frames, 4x = 192 frames (4.35 ms @44.1k)**. Undocumented by the API. |
| Per-FX `latencySec()` | comp = measured compressor; clip/wave/sat/mbsat = 4x shaper; vinyl = 0.005 + 4x shaper; sccomp = 0; everything else 0 |
| `chainLatencySec()` | Σ latencySec of **non-bypassed** inserts |
| Plan | `maxChan` = longest regular-channel chain, `maxBus` = longest send-bus chain. Regular strip: `pdcDelay = maxChan − own`, `toMaster = maxBus`. Send strip: `pdcDelay = maxBus − own`, `toMaster = 0`. Clamped 0..0.25 s; set with `cancelScheduledValues`+`setValueAtTime` (instant; a glide would pitch-bend). |
| Default | ON; localStorage `terminator.mixer.pdc.v1`; costs ≤~10 ms monitoring latency only while latency inserts exist |
| Exports | `renderStripOffline` inserts the same `pdcChainDelaySec`; `renderArrangementDAW` shifts stems by `pdcMasterShiftSec()` frames AFTER they fed the sends (posts fed sends un-shifted, as live) (renderArrangementDAW.ts:219-227); master render drops `compressorLatency` frames from its head so master aligns sample-for-sample with stems (MixerEngine 1176-1212). |

Inside an FX, `WetDry.setDryLatency/setDryPath` (base.ts:103-131) aligns the dry leg: CompFX delays dry by the measured comp latency (DelayNode max 0.1 s); MbSat routes dry through AP(loX)·AP(hiX)·¼-gain·identity-4x-shaper so phase AND latency match.

### 1.6 CONSOLE stage (ConsoleStage.ts + public/worklets/console-worklet.js)
`ConsoleSettings {on:false, flavour:'SSL', amount:50}` default; persisted `terminator.mixer.console.v1` and in `MixerPreset.console`. Zero latency, no oversampling, unity small-signal gain. Processor per-channel chain, per sample: `HPF(RBJ biquad, Q=1/√2) → low shelf → high shelf → presence peak → 1-pole LPF → sat() → DC blocker (1-pole HPF @ 5 Hz, r = 1 − 2π·5/sr)`.

Seed: `toleranceFor(name)` = FNV-1a(name) → mulberry32 → six uniform draws t[0..5] ∈ [−1,1]; bus role → all zeros.

FLAVOURS table (values at AMOUNT 1.0; `amt` ∈ 0..1 scales drive and EQ deviations linearly; AMOUNT glides 1/1024 per frame ≈ 23 ms):

| | a2 (2nd) | a3 (3rd) | hp Hz | lowF | low dB | highF | high dB | peakF / dB | lp Hz | BUS a2/a3/low/lp |
|---|---|---|---|---|---|---|---|---|---|---|
| SSL | 0.012 | 0.144 | 24 | 100 | 0.0 | 8000 | +0.25 | — | 0 (none) | 0.008 / 0.25 / 0.0 / 21000 |
| NEVE | 0.048 | 0.072 | 20 | 100 | +0.4 | 6000 | −0.2 | — | 18000 | 0.03 / 0.18 / 0.3 / 17000 |
| API | 0.03 | 0.12 | 22 | 120 | +0.2 | 8000 | 0.0 | 3000 Hz / +0.25 (Q 0.7) | 0 | 0.02 / 0.2 / 0.15 / 20000 |

Derived (recompute, lines 125-160): `a2 = F.a2·amt·(1+0.15·t0)`, `a3 = F.a3·amt·(1+0.15·t1)`; `hpF = max(10, F.hp + 2·t2)` (channel only; bus has no HPF); `lowDb = F.low·amt + 0.3·t3·amt` (bus: `F.bus.low·amt`); `highDb = F.high·amt + 0.3·t4·amt` (bus: 0); `lowF = F.lowF·(1+0.1·t5)`; `highF = F.highF·(1+0.1·t2)` (capped 0.45·sr); shelves S=1; peak only on channel, gain `F.peak·amt`; 1-pole LPF coefficient `lpA = exp(−2π·fc/sr)` with `fc = lpF + (0.49·sr − lpF)·(1−amt)` (opens fully at amt 0). Saturator: `y = x − a3·x·|x|² + a2·x²` for |x| < x0, else `±oddHold + evenHold` where `x0 = 1/√(3·a3)`, `oddHold = x0 − a3·x0³`, `evenHold = a2·x0²`. Measured (gate): THD @ −6 dBFS, AMOUNT 100: SSL 0.97 % (h3>h2), NEVE 1.22 % (h2>h3), API 1.06 %; ~half at 50; level match ≤ 0.05 dB; per-strip tilt ≤ ±0.6 dB.

### 1.7 Auto gain match (MixerEngine.ts:180-191, 410-439) — live only, never exported
Per strip, driven from the meter rAF: `db = clamp(20·log10(inRms/outRms), −15, +15)`; ignore if either RMS < 1e-4; `matchGain.setTargetAtTime(10^(db/20), τ=0.25 s)`. RMS over the 4096-sample window (worklet ring of per-block mean-squares). Off → trim returns to 1 with τ 0.05 s. Master excluded.

### 1.8 Offline export decomposition (MixerEngine.ts:1136-1271, renderArrangementDAW.ts)
`channel post = dry source → [console ch] → inserts → pdcDelay → fader → pan`; `send return = Σ(post × sendLinear) → send strip (100 % wet)`; `master = Σ(posts+sends) → [console bus] → master inserts → fader → −1 dBFS/20:1 limiter` with `compressorLatency` frames trimmed from the head. Tail headroom `fxTailSec`: reverb DECAY+0.5 s, delay 8×TIME, vinyl 0.5 s, phaser/flanger 0.25 s. `renderWithMixerFX` (single chop bake) trims leading silence (threshold 1e-5 on ch0). Bypassed inserts are omitted entirely offline (buildFXChain.ts:27). Mobile/HardwareView keeps the legacy `renderArrangementMix` path (internal chain incl. limiter).

---

## 2. EVERY FX

All mixer FX wrap `WetDry` (base.ts:77-153): `dry.gain = 1−mix`, `wetOut.gain = mix`, bypass → dry 1 / wet 0 (true crossfade; behaviour change vs. old presets noted in memory). Param sets use `setParam()` (base.ts:58): **instant** (`cancelScheduledValues` + `setValueAtTime`) on the constructor's first set and inside ANY OfflineAudioContext, else `setTargetAtTime(τ)`. Stereo handling is native 2-ch unless noted.

### 2.1 Mixer inserts (src/mixer/fx, FX_REGISTRY index.ts:51-226)

| id / NAME | Algorithm (nodes) | Params: key [range] default (unit, mapping) | Latency | Notes |
|---|---|---|---|---|
| `clip` CLIP | WaveShaper 4x, 4096-pt curve: `t = 1 − 0.9·amt`; for ‖x‖>t: `y = t + o/(1+(o/d)²)`, o=‖x‖−t, d=1−t; `min(y, 0.9886)` (−0.1 dBFS ceiling) | AMT [0..100] 0 % | 4x (192 fr) | never reaches 0 dBFS |
| `wave` WAVE | WaveShaper 4x, 2048-pt `tanh(k·x)/tanh(k)`, `k = 1 + 24·drive` | DRIVE [0..100] 0 % | 4x | |
| `sat` SAT | WaveShaper 4x, 4096-pt Doidic `y=(3x/2)(1−x²/3)`, x pre-gained `g=1+2·drive`, clamped ±1 | DRIVE [0..100] 0 % | 4x | even-harmonic |
| `mbsat` MB SAT | LR4 crossovers (2× cascaded Butterworth biquads, **Q = −3.0103 dB**): low = LP²(loX)→AP(hiX, Q 0.707 linear); rest = HP²(loX); mid = rest→LP²(hiX); high = rest→HP²(hiX). Each band: ¼ pre-gain → 4x WaveShaper `tanh(a·X)/a`, X∈[−4,4], `a = 4·drive` (identity at 0) → makeup `√(1+4·drive)`. Dry leg = AP(loX)→AP(hiX)→¼→identity 4x shaper | LOW/MID/HIGH [0..100] 0 %; LO_X [40..2000 log] 200 Hz; HI_X [500..16000 log] 3000 Hz (forced ≥1.5·LO_X); WET [0..100] 100 | 4x | sum flat 0.00 dB at 0 drive (verified) |
| `wide` WIDE | splitter → M=(L+R)/2, S=(L−R)/2 gains; S×(WIDTH/100); L'=M+S, R'=M−S | WIDTH [0..200, center 100] 100 % | 0 | 0 = mono |
| `mseq` M/S EQ | same M/S matrix; peaking biquad on M and on S, Q 1 | MID_HZ [20..20k log] 1000; MID_DB [−18..18] 0; SIDE_HZ 4000; SIDE_DB 0 | 0 | |
| `pan` PAN | sine OscillatorNode → gain(depth) → StereoPanner.pan | RATE [0.1..10] 1 Hz; DEPTH [0..100] 50 % (→ 0..1 pan swing) | 0 | |
| `phaser` PHASER | N allpass biquads (Q 0.6) in series, centres spread ±½ oct: `f_i = center·2^((i/(n−1))−0.5)`; sine LFO adds linear Hz offset `min(depth·center·0.9, lowestCentre−40)`; feedback from last stage via 1-quantum DelayNode (128/sr) back to first | RATE [0.02..10 log] 0.4; DEPTH 70 %; CENTER [100..8000 log] 900 Hz; FEEDBACK [0..90] 30 %; STAGES {4,6,8,12} 6; WET 50 | 0 (+128-frame feedback delay inside loop) | 50 % = deepest notches |
| `flanger` FLANGER | DelayNode(≤50 ms) base `DELAY ms`, triangle LFO depth `depth·base·0.9`; feedback gain (±) → LP 9 kHz Q 0.5 → delay | RATE [0.02..8 log] 0.25; DEPTH 60 %; DELAY [0.3..12 log] 3 ms; FEEDBACK [−95..95] 40 %; WET 50 | 0 (wet path = DELAY ms) | negative FBK = through-zero flavour |
| `vinyl` VINYL/TAPE | series: WaveShaper 4x Doidic (g = 1+0.3·DRIVE) → LP (Q 0.3, f = 20000 − 1200·AGE) → HP 20 Hz → wow DelayNode base 4 ms (sine LFO 0.1+0.07·WOW Hz, depth 0.0003·WOW s) → flutter DelayNode base 1 ms (sine 3+0.5·FLUTTER Hz, depth 0.00005·FLUTTER s) → peaking 200 Hz Q 0.7 gain 2+0.4·WARMTH dB | WARMTH 4, DRIVE 2, WOW 3, FLUTTER 3, AGE 3 (all 0..10 step 0.1) | 5 ms + 4x | LFOs started in ctor |
| `filter` FILTER | one BiquadFilter | TYPE {lowpass,highpass,bandpass,notch} lowpass; CUTOFF [20..20k log] 20000; RESO → Q [0.0001..30] 1 | 0 | Q for LP/HP is in dB per Web Audio |
| `eq` EQ | lowshelf 80 Hz → peaking 1 kHz Q 0.8 → highshelf 12 kHz | LOW/MID/HIGH [−12..12] 0 dB | 0 | |
| `comp` COMP | DynamicsCompressor (knee 6) → makeup gain; NY mix via WetDry with dry delayed by measured comp latency | STYLE presets {OFF: −0/1/10 ms/150 ms/0 dB/mix 1; LIGHT: −18/2/30/200/+2/1; PUNCHY: −20/4/10/80/+4/1; NY-PARALLEL: −32/8/1/50/+6/**mix 0.5**; AGGRESSIVE: −28/12/1/30/+8/1}; THRESHOLD [−60..0]; RATIO [1..20]; ATTACK [0.1..100 ms]; RELEASE [10..1000 ms]; MAKEUP [0..24 dB]; default STYLE PUNCHY | measured comp lookahead (~6 ms) | |
| `sccomp` SC COMP | AudioWorklet `sc-comp` (below); key → HP biquad (Q −3.0103 dB) → input 1 | SOURCE (dynamic strip list) NONE; THRESH [−60..0] −24; RATIO 4; ATTACK [0.1..100] 5 ms; RELEASE [5..1000] 120 ms; HOLD [0..500] 0 ms; MAKEUP [0..24] 0; KEYHP [20..500 log] 20 Hz | 0 | passthrough until module loads; GR meter via port every 40 ms |
| `delay` DELAY | two DelayNodes (max 2 s), independent L/R feedback loops each damped LP 7.5 kHz Q 0.5 + HP 90 Hz Q 0.5; R time = min(2, TIME·1.02); PINGPONG = in→L→R→fb→L | TIME [1..2000] 300 ms; FEEDBACK [0..95] 35 %; WET 30; PINGPONG 0/1 | 0 | |
| `reverb` REVERB | pre-delay DelayNode(≤0.5 s) → 2 ConvolverNodes (normalize=true) A/B crossfade 60 ms; IR: length = DECAY·sr, onset ramp `2+30·room` ms, per-channel 1-pole LP of LCG noise with fc `fcStart=14000−6000·room → 1800` along `√frac`, envelope `exp(−6.9078·t/DECAY)`; seed 0x9e3779b9, LCG 1664525/1013904223 | ROOM [0..100] 50; PREDELAY [0..100] 10 ms; DECAY [0.1..10] 2 s; WET 30 | 0 (+PREDELAY) | live rebuild debounced 60 ms; offline immediate |
| `utility` UTILITY | gain → splitter/merger re-patch → ±1 phase gain | GAIN [−20..20] 0 dB; MODE {STEREO,MONO(0.5L+0.5R both),MONO-L,MONO-R}; PHASE normal/inverted | 0 | |

`fxTailSec` per type in §1.8. Max 8 inserts per strip; FX_ORDER = clip,wave,sat,mbsat,wide,mseq,pan,phaser,flanger,vinyl,filter,eq,comp,sccomp,delay,reverb,utility.

### 2.2 Chopper internal effects (src/renderer/audio/effects — the legacy master chain + looper Track.ts)

| Class | Algorithm | Defaults / ranges | Used by |
|---|---|---|---|
| `Filter` | one biquad, dry/wet gains | lowpass 1000 Hz Q 6 mix 1 (chopper master: LP, 20 kHz, Q 6, mix 1, bypass unless enabled) | master chain, Track |
| `EQ3` | lowshelf 60 Hz, peaking 2 kHz Q 1, highshelf 12 kHz, ±24 dB, no smoothing | 0/0/0 | master (UI ±24 step 0.5), Track |
| `Compressor` | gain(drive dB) → DynamicsCompressor **threshold −18, knee 6** → makeup; bypass = ratio→1, gains→1 (τ 5 ms) | ratio 4, atk 10 ms, rel 150 ms; drive 0..24 dB, makeup ±24 | master COMP_PRESETS (ChopperEngine.ts:364-370): off 0/1/10/150/0/mix0; light 3/2/30/200/+2; punchy 6/4/10/80/+4; ny 12/8/1/50/+6/mix 0.5; aggressive 18/12/1/30/+8 |
| `Delay` | 2 DelayNodes(≤4 s), fb gains, pingpong re-patch; no damping | timeL 0.375, timeR 0.5 (master: R = L·1.5), fb 0.35 (≤0.95), mix 0.3 | master (TIME 0.01–2 s def 0.25, FBK def 0.3) |
| `Reverb` | HP 200 Hz Q 0.5 → Convolver (normalize default true); IR len = 1.2·decay·sr, fc 12000→1600 along √, `exp(−6.9078 t/decay)·0.2`, seed 0x1234567 | mix 0.3, decay 2 (0.1–10; UI ≤6) | master |
| `Clipper` | preGain `1+1.5·drive` → 4x WaveShaper 4096: `soft=tanh(kS x)/tanh(kS)`, `hard=tanh(kH x)/tanh(kH)`, `kS=1.5+2.5·drive`, `kH=3+12·drive`, blend by amount → postGain 0.7 | amount 0.11, drive 0.05, mix 0.7 | extra FX |
| `Waveshaper` | 4x WaveShaper 4096: `((π+k)x)/(π+k‖x‖)`, `k=30·drive+1` | drive 0.03, mix 0.5 | extra FX |
| `MultibandSaturator` | 3 bands by single biquads (LP lowF; HP lowF→LP highF; HP highF — NOT phase-compensated), each 4x `tanh(kx)/tanh(k)`, `k=15·drive+1`, band drives ×1.0/1.1/1.2; wet ×0.33 | drive 0.14, mix 0.5, 60 Hz/16 kHz | extra FX |
| `StereoWidener` | worklet `stereo-widener`: M/S, `Lw=M+S·width`, mix blend inside worklet | width 1 (0..3), mix 0.5 | extra FX |
| `MSEQ` | worklet `ms-eq`: RBJ peaking on M and S, Q 0.707, ±24 dB | 1670 Hz +5.5 / 5000 Hz +10, mix 0.5 | extra FX |
| `BitCrusher` | worklet: `round(x·2^(bits−1))/2^(bits−1)`, sample-hold every `rate` samples | bits 4 (1..16), rate 8 (1..32), mix 1 | extra FX |
| `AutoPan` | sine LFO → StereoPanner.pan | rate 1, depth 0.7, mix 1 | extra FX |
| `TranceGate` | worklet: square LFO (phase<0.5 open), 1-pole env `atk/rel coeff = 1/(t·sr)`, `g=(1−depth)+env·depth`; sync: `rate = bpm/60·div/4` | rate 12.1 Hz, depth 1, atk 5 ms, rel 80 ms, div 1/8 | extra FX |
| `Chorus` | DelayNode base 25 ms, sine LFO, depth·0.02 s | rate 0.35, depth 0.02(!), mix 0.35 | extra FX ("TAPE" on web) |

Track.ts (looper, `audio/AudioEngine.ts`): per-track chain gain→fxIn→[14 effects, reorderable, DEFAULT_FX_ORDER]→fxOut→StereoPanner→master; master = gain 0.85 → limiter (−1/0/20/1 ms/50 ms) → analyser 2048 → destination; loop retrigger fades `FADE=0.004 s` linear; MIDI note = varispeed `(note−root)·100` cents.

### 2.3 Worklets (public/worklets)
| Worklet | Core math |
|---|---|
| `sc-comp` | per-sample: key level = max(‖kL‖,‖kR‖); `db=20log10(lvl+1e-9)`; `over=db−thr`; soft knee: `over>−knee/2 → target = slope·(over+knee/2)²/(2·knee)` if inside knee else `slope·over`, `slope=1/ratio−1`; `aCoef=1−exp(−1/(atk·sr))`, `rCoef` likewise; attack when target<gr (resets hold), hold counts down, then release; `g = 10^(gr/20)·makeup`; params k-rate: threshold −24, ratio 4, attack 0.005, release 0.12, hold 0, makeup 0, knee 6 |
| `peak-meter` | ring of 32 per-128-block partials = 4096-sample window; peak = max over ring, RMS = √(mean of block mean-squares); posts every 16 blocks (~46 ms); inputs 0 pre / 1 post / 2 chainIn / 3 chainOut |
| `loudness-meter` | K-weighting designed from BS.1770 analogue prototypes (shelf f0 1681.974 Hz Q 0.7071752 +3.99984 dB with `Vb = Vh^0.49967`; HP 38.13547 Hz Q 0.5003270), bilinear per SR; 100 ms hops; M = last 4 hops, S = last 30; I = 400 ms blocks gated −70 abs then −10 LU relative, recomputed each hop; LRA = short-term, −70/−20 gate, 10th→95th percentile; true peak = 4-phase 12-tap Kaiser(β 8) sinc, phases normalised to unity DC; correlation = Σlr/√(Σl²Σr²) |
| `console-stage` | §1.6 |
| `ms-eq`, `stereo-widener`, `bit-crusher`, `trance-gate` | §2.2 |

---

## 3. CHANNEL STRIP SEMANTICS

| Aspect | Spec |
|---|---|
| Fader | dB domain, `FADER_MIN_DB −60` (= −∞ → gain 0), `FADER_MAX_DB +6`; `gain = 10^(dB/20)`; `setTargetAtTime(τ=8 ms)`. UI taper (MixerSection.tsx:150-156): track pos 0..0.8 ↔ −60..0 dB linear-in-dB, 0.8..1 ↔ 0..+6 dB; ≤ −59.5 snaps to −∞. MIDI CC follows the same taper. Gang drags move in POSITION space by delta. Double-click = 0 dB. |
| Sends | 4 per regular strip, `SEND_MIN_DB −60 = off`, max +6, post-fader/mute/pan tap; τ 8 ms |
| Pan | Web Audio StereoPannerNode (equal-power per spec; −1..1), τ 8 ms; UI centre detent ±3 px; display L/R 0-100 |
| Mute/solo | `silent = muted ‖ (anySolo && !soloed)`; applied via `muteGain` setTargetAtTime 0/1 τ 8 ms (no click); Alt-click = exclusive solo; mutes ARE printed into exports (caller skips inaudible channels) |
| Strip pristine | ‖fader‖<0.01, ‖pan‖<0.01, no mute/solo/FX, sends ≤ −59.99 → auto-created source strips may be removed |
| Peak meters | pre (ghost 20 % alpha) and post (solid) per channel, linear peak over a 4096-sample (~93 ms) window, drawn 0..−60 dB linear-in-dB; colour zones: green to −18, amber to −6, red above; peak-hold line = post max, holds 3 s then decays 8 dB/s (time-based); numeric held peak; clip latch at post ≥ 0.999 lin: red 1.5 s hold, 1.2 s fade; pre-warn yellow→orange→red over the last 6 dB; STOP clears clips. Silence → strips skip redraw; loop drops from rAF to a 20 Hz timer after 60 silent polls. |
| Master TP | `truePeakOf` 4× linear interpolation between samples (analyser fallback); worklet hold TP when available |
| LUFS (approx fallback) | highshelf 1500 Hz +4 dB → HP 38 Hz Q 0.5 → analyser 4096; `LUFS = −0.691 + 10log10(ms)`; M = mean of last 24 frames, S = last 180, I = gated > −70 |
| Loudness popup targets | TARGET_I −14 LUFS (±1 LU = ok), TARGET_TP −1 dBTP; PLR = TP_hold − I; bands SUB 20-60 / LOW 60-150 / LO-MID 150-500 / MID 500-2k / HI-MID 2k-6k / AIR 6k-20k; pink tilt +3 dB/oct (`10log10(f/1000)`), −30 dB reference line; spectrum 8192-pt, smoothing 0.6, −100..0 dB, drawn −90..0 log-f |
| Mobile meter | `getPeakLevel()` post-limiter analyser (fftSize 1024) + LoudnessTap on `engine.outputNode` |

---

## 4. MASTER, EXPORT, FORMATS

| Item | Spec |
|---|---|
| Safety limiter | DynamicsCompressor −1 dBFS, knee 0, 20:1, attack 1 ms, release 50 ms — on the mixer master (live+offline), on the chopper internal chain (mobile only live; desktop bypassed via attachMixer), and `applySafetyLimiter` after single-chop bake (head trimmed by comp latency). `AudioEngine.setLimiterEnabled(false)` → ratio 1/thr 0. |
| Master CLIP (chopper) | WaveShaper 2048-pt hard clip `clamp(x·drive, ±C)`, `C = 10^(−0.1/20) = 0.9886`, `drive = 1 + 5·amount`; oversample '4x' only while on (`'none'` + null curve when off); exported only via `withMasterClip` (renderArrangementChopSource) |
| NORM | non-destructive: `gain = 0.891/peak` (−1 dBFS) of whole buffer, all channels; main track → multiplied into `chopGain`; pad-source NORM → per voice (`normGainFor`); preset carries `normalize`, `normalizeGain`, `sourceNorm` |
| Master volume | chopper masterGain 0.85 default (τ 10 ms); mixer master fader 0 dB |
| Pitch | master PITCH ±24 st (+ FINE/100) applied as detune per voice (varispeed); `resampleBuffer` linear-interp for Extractor PITCH warp; `stretchBuffer` = phase-locked vocoder (pitch 0, RMS-matched, gain clamp 0.25..4) or SoundTouch WSOLA |
| Voice envelopes | pad ATTACK default 3 ms (0..0.5 s, per source), RELEASE 0..0.5 s (linear to 1e-4 at real end); one-shot fadeIn/fadeOut inside chop (loop = rendered crossfade `sin×cos` equal-power, `LOOP_MIN_PERIOD`); sequencer/export cut = `FADE 0.005 s` linear to 1e-4 at real end, attack clamped [0.5 ms, realDur−FADE]; varispeed-corrected (real = buffer/rate) |
| Drum voice model | `applyDrumAttack`: head (first 1 ms, all ch) < 0.02 → instant; else 3 ms linear ramp; `declickHead` at decode (≤3 ms, stops at first ≥ −6 dBFS sample, skipped if head < 0.002); choke = hold level (interpolated if inside attack) then linear to 0 over `DRUM_CHOKE_S 0.004`; mute-group cut = min(next lane hit, group cut); note-repeat sub-hits self-choke; per-hit pan via StereoPanner |
| Sample rate | Live ctx: `new AudioContext({latencyHint:'interactive'})` at hardware rate unless desktop prefs set 44100/48000 (+ bufferFrames → latencyHint seconds). Exports: `buffer.sampleRate ?? 44100` (chopper) / `engine.buffer?.sampleRate ?? mixer.ctx.sampleRate` (DAW). Nothing assumes 44.1k except comments; worklets read `sampleRate`. |
| WAV (StemExporter.ts:12-92) | 8-bit unsigned (`round((x+1)·127.5)`), 16-bit **TPDF dither** (two xorshift32 streams seeds 0x2545f491/0x9e3779b9, triangular (−1,1) LSB, `round(x·32767+d)`), 24-bit round-to-nearest (`round(x·8388607)`), 32-bit IEEE float; all hard-clamped ±1. Default chop export 24-bit, arrangement 16-bit. |
| FLAC | `quantizeTPDF16` = same PRNG/draw order as WAV16 (bit-identical PCM, gated); `encodeFLAC` 16/24; only Master Mixdown + Trackouts (never MPC/Drum Rack) |
| Mono-ness | no mono-cut/mono-maker on master; UTILITY FX provides mono fold; correlation readout only |

---

## 5. PERFORMANCE FINDINGS (memory project_electron_lag_2026_08_20 + code)
- Idle renderer was 44 % → ~20-24 % after: MIDI-learn box-shadow pulse → opacity keyframe; scanlines → transform; silent meter strips skip redraw + rAF→20 Hz timer; MixerSection memoized (`channelsRev`), per-pad stems chop-length slices.
- Audio render thread ≈13 % of which **52 pre/post AnalyserNodes (4×13 strips, fftSize 4096) ≈ 9 pts**; match analysers ≈0; LUFS/spectrum ≈0; loudness+bass worklets 1-2 pts.
- The planned fix is now BUILT: `peak-meter-worklet.js` (one node per strip, 4 inputs, 0 outputs, posts every 16 blocks), analysers disconnected on attach (MixerEngine.ts:498-522); gate `npm run test:peak-meter` (worklet vs reference max diff 0.0000 live). MasterStrip still uses analysers + `truePeakOf`.
- Reverb IR rebuild debounced 60 ms + A/B convolver swap (10 s IR ≈ 900k samples); old buffer nulled after fade so one convolution runs.
- Extra-FX rack is lazily spliced (five 4x shapers + 3 worklets were burning CPU on silence).
- Gotchas: HMR of ChopperView closes the AudioContext; CDP-debug Electron is the user's live window.

---

## 6. TESTS (numeric assertions)
| Gate | Asserts |
|---|---|
| `scripts/console.test.mts` (`npm run test:console`) | level match ≤ 0.1 dB @ −18 dBFS/1 kHz every strip+bus, every flavour; THD @ −6 dBFS AMOUNT 100 within 0.3–2 %; AMOUNT 50 < 0.7× AMOUNT 100; quieter input cleaner; SSL h3>h2, NEVE h2>h3; per-strip curves within ±0.6 dB (60 Hz–12 kHz), every pair differs ≥ 0.03 dB, same name → identical (<1e-6); 10 Hz < −12 dB, 40 Hz > −2.5 dB; NEVE bus 16 kHz between −0.5 and −4 dB; AMOUNT 0 THD < 0.05 % and < 0.05 dB; +12 dBFS in bounded (peak < 4.5), no NaN; DC after even stage < 1e-3 |
| `scripts/peak-meter.test.mts` | pre/post peaks per channel exact; transient visible ~46 ms later, gone after 2 windows; RMS of steady 0.4/0.2; sine RMS 0.707±2e-3, peak 1.0; random block peak/RMS match straight scan ≤1e-6; idle → 0, finite; process() returns true; reset clears |
| `input-q.test.mts` | `liveLanding` q=1 lands on line, q=0 within ½ stored step, q=0.5 halfway, monotonic, sound time == written step; per-sequencer grid; DrumEngine SHIFT residual (±1.5 ms) |
| `norm-per-source.test.mts` | source NORM = 0.891/peak on that buffer per voice; main NORM = 0.891/main peak on bus; preset round-trip |
| `export-flac.test.mts` | FLAC PCM bit-identical to WAV16 (TPDF); capability set (no FLAC for MPC/Drum Rack) |
| Electron `scripts/test-exports-main.js` | 7 export tests incl. "CONSOLE bake" (per memory) |
| Verified-in-browser (memory) | NY comp dry/wet flat 60 Hz–8 kHz; MB SAT flat at 0 drive, +2.3 dB @100 Hz LOW=100; master impulse lands on the same sample as stems; SAT-on-kick both channels aligned; COMP-on-send single aligned impulse |

---

## 7. WEB-AUDIO LIMITATIONS VISIBLE IN CODE
- **DynamicsCompressor has undocumented ~6 ms look-ahead** and no key input → measured at runtime (`compressorLatency.ts`), SC COMP re-implemented as a worklet.
- **WaveShaper 2x/4x oversampling adds 128/192 frames of unreported latency** → measured, PDC'd, dry legs matched. 4x left at `'none'` until needed (CPU + latency even with null curve).
- **Biquad `Q` is in dB for lowpass/highpass, linear for allpass/peaking** → Butterworth = −3.0103 (MbSatFX.ts:13-16, SidechainFX.ts:47); 0.707 "dB" peaks +7 dB.
- **Feedback cycles need a DelayNode** (phaser uses a 128-frame delay, flanger/delay contain one) else Web Audio mutes the loop.
- **`setTargetAtTime` from node defaults inside an OfflineAudioContext prints a 50–250 ms sweep at the stem head** ("tape start" whoosh) → `setParam()` instant-on-first-set / instant-offline (base.ts:49-66, param.ts).
- `AudioBufferSourceNode.buffer` may be set once; `start()` must precede `stop()`; `start()` throws on bad offsets (guarded).
- Worklet modules must be `addModule`'d per context (one-per-ctx WeakMap caches); offline renders must `await chain.ready`/`desk.ready`; everything degrades to clean passthrough if a worklet can't load (never silence). `readonly ready` field initializer gotcha (memory).
- Meter/worklet message-port latency: peak meter pushes every ~46 ms over a 93 ms window; loudness every 100 ms; SC GR every 40 ms — UI reads cached scalars.
- Analysers run on the audio thread ("automatic pull") and cost CPU; `getFloatTimeDomainData` on the main thread per frame.
- `setSinkId` abort-on-same-id → detach to `{type:'none'}` first; context pinned to endpoint (devicechange re-open, debounced 250 ms).
- iOS/WebKit: 'interrupted' state, resume on visibility; no multichannel (everything explicit 2-ch); ScriptProcessor deliberately avoided ("fair game" comment but unused); OfflineAudioContext `close()` optional; iOS AudioContext count cap (scratch contexts closed).
- No TODO/FIXME markers found in src/mixer, src/renderer/audio, public/worklets.
- Design-call non-parity (memory): gain-match trim not exported; drum export ignores per-step graphs; pads with own buffers differ between manual hit vs seq/export; extra-FX 9 are dead UI on desktop.

---

## 8. SUBTLE "TERMINATOR SOUND" BEHAVIOURS TO PRESERVE
1. **Mono→stereo upmix before the strip** (explicit 2-ch input) so centre pan is transparent and PRE==POST at unity.
2. **Exact limiter**: DynamicsCompressor −1/0/20/1 ms/50 ms semantics (WebKit/Blink algorithm incl. its pre-delay) — the master brickwall, the chop-export safety limiter and the looper master all use it; head-trim by its latency in exports.
3. **Console per-strip determinism**: FNV-1a+mulberry32 seeded by strip NAME; bus has zero tolerance; AMOUNT scaling, hold-flat polynomial past x0 (no foldback), always-on 5 Hz DC blocker, no oversampling.
4. **WetDry true crossfade** (dry 1−mix, wet mix), WET locked 100 on sends, bypass = full dry; bypassed FX skipped entirely in offline chains.
5. **PDC topology**: channel-vs-bus two-tier alignment, dry-to-master leg delayed by longest bus chain, stems shifted post-send, master head-trimmed.
6. **Measured latencies, never constants**: comp lookahead and 4x shaper latency are probed per SR at runtime; a native port must reproduce the same group delays (~264 frames comp, 192 frames 4x shaper @44.1k) or re-measure its own and keep all dry legs matched.
7. **Param-smoothing constants**: fader/pan/send/mute τ 8 ms; FX params τ 10 ms (LFOs 20–50 ms); gain-match τ 250 ms, ±15 dB; AMOUNT glide 1024 frames.
8. **Envelope constants**: ATTACK 3 ms default, seq/export cut FADE 5 ms to 1e-4, RELEASE linear, DRUM_ATTACK 3 ms / silence threshold 0.02 / choke 4 ms / declick ≤3 ms ending at −6 dBFS, looper FADE 4 ms; all in REAL seconds under varispeed.
9. **NORM = 0.891/peak (−1 dBFS)** non-destructive; per-source NORM rides the voice.
10. **Deterministic IRs** (seeded LCG, onset ramp, √-frac air absorption, −60 dB at DECAY) so export == audition; Convolver `normalize=true`.
11. **Delay damping** LP 7.5 kHz Q 0.5 + HP 90 Hz Q 0.5 in the loop, R = 1.02·TIME; master chopper delay R = 1.5·L.
12. **MB SAT phase-flat split**: LR4 with Q=−3.01 dB, AP(hiX) on the low band, identity-shaper dry leg.
13. **Meter window 4096 samples, hold 3 s then 8 dB/s, clip ≥0.999, −60 dB floor**, BS.1770-4 exact (designed filters, 12-tap Kaiser TP) with −14 LUFS / −1 dBTP targets.
14. **16-bit TPDF dither with the fixed xorshift seeds** — WAV and FLAC must stay bit-identical; 24-bit round-to-nearest.
15. Mobile path keeps the internal chain WITH the limiter and no mixer; desktop removes the internal limiter when the mixer attaches (one brickwall only).