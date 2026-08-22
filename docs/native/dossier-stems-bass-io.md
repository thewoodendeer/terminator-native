# Terminator → native DAW dossier: STEMS · BASS · AUDIO I/O + RECORDING

Surveyed read-only on `mpc-stem-extractor` @ `0af0dbe` (2026-08-22). All paths under `~/terminator/`.

---

## 1. STEM SEPARATION

### 1.1 Models (`src/main/stemsModels.ts:32-48`)

| Quality | File (R2 `stems-models/onnx/`) | Bytes | Source |
|---|---|---|---|
| FAST | `htdemucs_fp16weights.onnx` | 165,612,636 | HF `StemSplitio/htdemucs-onnx` (MIT), htdemucs v4 fp16 weights |
| FINE | `htdemucs_ft_{drums,bass,other,vocals}.onnx` | 316,446,953 each (4 files) | HF `StemSplitio/htdemucs-ft-onnx` (MIT) — the ft "bag" |

- IO contract (`stemsWorkerChild.ts:7-8`, `STEMS-IN-ELECTRON.md §1`): input `mix` `(1,2,343980)` float32 = 7.8 s stereo @ **44.1 kHz** in [-1,1]; output `stems` `(1,4,2,343980)`, row order **drums, bass, other, vocals**. STFT/ISTFT are **inside the graph** — feed raw audio. fp32 file exists but is no faster on CPU (spike README).
- FINE is **one-hot**: each specialist session runs on every chunk but contributes **only its own row** (`inferRows`, child:216-231). No averaging.
- Manifest rule: sha256-pinned; never repoint a filename at new bytes; download to `.part` → verify size+sha → rename; typed errors `network|disk|corrupt`; re-entrant downloads with shared progress listeners (`ensureModels`, :151-179). Models live in `<userData>/terminator-stems/models/` (relocatable via `setModelsBaseDir`), downloaded on first use (~4 s for 166 MB measured), deletable from Preferences → FOLDERS.

### 1.2 Chunk grid + overlap-add (`stemsWorkerChild.ts:62-65, 103-104, 125-141, 270-289`)

```
SEG     = 343980            # model window
OVERLAP = SEG >> 2 = 85995  # segment/4 (reference infer.py::separate)
STRIDE  = SEG - OVERLAP = 257985
chunk i covers [i*STRIDE, i*STRIDE + SEG);  nChunks = ceil(frames/STRIDE); last chunk zero-padded
win[i]  = min(1, (i+1)/OVERLAP, (SEG-i)/OVERLAP)      # linear ramps both edges, flat 1 between
acc[p][s] += row[s]*win[i];  weight[s] += win[i];   out = acc / max(weight, 1e-8)
```
- A sample is covered by ≤2 chunks (overlap < stride). Stretch `[i*STRIDE,(i+1)*STRIDE)` is **ready** iff `done[i] && (i==0 || done[i-1])` (`readyRanges`). Only newly-ready spans are emitted (`subtractReported`), normalized, as 8 planes `[drumsL,drumsR,bassL,bassR,otherL,otherR,vocalsL,vocalsR]`.
- Grid is **global and fixed**, so chunks computed minutes apart compose exactly → partial/priority splitting. Verified by a stems-sum residual across a seam: **−33…−34 dB** below the mix on real material.
- Work queue: `windows` (chop spans, focused pad first) enqueued first, then (if `sweep`) every remaining chunk; `queueWindow` inserts at the front mid-run (child:117-122, 371-380). `sessions` live for the child's lifetime (create ≈2 s each).
- Memory: accumulators ≈32 B/frame; main caps input at `STEMS_MAX_SECONDS = 600` (`main.ts:1680-1693`).

### 1.3 Resampling (`src/main/stemsResample.ts`)
The renderer's PCM is at the AudioContext's **hardware rate (48 k on most Macs)**; the model is 44.1 k — un-resampled 48 k plays ~1.5 st flat to htdemucs and shifts every seconds→frames window. The child resamples **down at init and every emitted span back up**, emitting SOURCE frames so stems stay sample-aligned with the main buffer.
- Kernel: windowed sinc, Blackman, `LOBES_UP=16`, `LOBES_DOWN=32`, downsampling cutoff pulled to `0.97 × lower Nyquist` (`CUTOFF_TRIM`), per-phase tap tables when phases ≤ 8192 (48000/44100 = 160/147 → 147 exact phases), each phase normalized to unity DC. Positions from the **global output index** (`sampleRange(src, lo, hi, n0, count, offset)`), callers hand a `halfWidth` margin so piecemeal spans tile bit-identically.
- Measured: flat to 20 k ±0.1 dB, 23.5 k rejected 78 dB, round-trip −94.6 dB; cost ≈2.4 s per minute of audio (down), ≈0.3 s/min/plane (up). Choosing 44100 in Preferences skips it entirely.

### 1.4 ONNX Runtime builds per platform + every GPU path measured

| Target | Package | EP | Status |
|---|---|---|---|
| Apple Silicon | `onnxruntime-node ^1.27.0` (`package.json:90`) | CPU, or **WebGPU** after self-check | shipped |
| Intel Mac | npm alias `onnxruntime-node-darwin-x64 = npm:onnxruntime-node@1.23.2` (`package.json:98`; 1.24+ ships no darwin-x64 binary) | CPU only | shipped as `Resources/ort-darwin-x64` |
| Windows | `onnxruntime-node ^1.27.0` | CPU | DirectML/WebGPU **unmeasured** |

Child picks module by `process.platform/arch` (`stemsWorkerChild.ts:56-60`); packaged Mac passes `TERMINATOR_ORT_DARWIN_X64`.

Measured on M1 Max, one 7.8 s chunk (`STEMS-IN-ELECTRON.md §2/§2b/§8`, memory note):

| Engine | Per chunk | Correct? |
|---|---|---|
| CPU EP, ORT 1.27 | 1.8–2.0 s FAST; FINE 2.0–2.2 s/specialist ≈ 8.4 s | yes (reference) |
| WebGPU EP, ORT 1.27 arm64 | 1.31–1.45 s (1.3–1.4×) | yes, 72–101 dB SNR (his machine: verdict ok, 62.6 dB, 1856 vs 2248 ms); 30 s sweep 10.1–11.7 s vs 13.3–13.9 s CPU |
| WebGPU EP, ORT 1.23.2 (arm64 & x64) | 0.64 s | **WRONG** (other −5 dB, vocals −4.7 dB) |
| CoreML EP, MLProgram (`coreMlFlags 0x10`) | 0.95 s + **67 s** compile, no cache | **WRONG** (drums 13.7 / bass 28 / other −1 / vocals 0 dB SNR) |
| CoreML EP, NeuralNetwork | fails compile: Espresso `generic_general_slice: Invalid values 2048 in begin_ids` | — |
| ort-web WASM (node, 8 thr) / WebGPU in hidden BrowserWindow | `std::bad_alloc` creating session (wasm32 4 GB) | — |
| demucs.cpp native 8-thread | 33.6 s | rejected (17× slower) |

Other numbers: session create ~2 s; 30 s region FAST 7.5 s; full 3:25 track FAST ~50 s; Intel 1.23.2 under Rosetta correct at 118 dB SNR.

**GPU policy** (`stemsWorker.ts:58-99`, child:241-268): `gpuCapable() = darwin && arm64`. Modes `off|probe|on`. In `probe`, the first chunk does a warm-up GPU run, a timed GPU run, a fresh CPU session + timed run, min-SNR over the rows that quality uses; **ok iff SNR ≥ 40 dB AND gpuMs×1.1 ≤ cpuMs**, else sessions rebuilt on CPU. Verdict persisted at `<userData>/terminator-stems/gpu.json` keyed `ortVersion+arch+platform`. A GPU child that dies before its first chunk is re-forked once on CPU with the same job, verdict stored `bad` (worker:239-252). Rule recorded: **never ship a GPU EP without an SNR check against CPU** — two of three GPU paths returned garbage.

### 1.5 The V8-cage crash + fix
`session.run()` **SIGTRAPs inside any Electron process** (Electron ≥21 V8 memory cage forbids ort's external ArrayBuffers; session create survives, first run traps; `ELECTRON_RUN_AS_NODE` does not escape; preallocated fetches don't help). Fix (`scripts/download-stems-node.js`, `stemsWorker.ts:35-54, 264-281`): ship a **real pinned Node v24.15.0** per platform (`bin/stems-node/{darwin-arm64,darwin-x64,win-x64}`, sha256-pinned from nodejs.org `SHASUMS256.txt`, ~90 MB on disk / ~30 MB compressed), `child_process.fork(child, [], { execPath: thatNode, serialization: 'advanced', stdio: ['ignore','ignore','pipe','ipc'] })`, delete `ELECTRON_RUN_AS_NODE` from env. Dev falls back to PATH node; `TERMINATOR_STEMS_NODE` overrides (runs the Intel slice via Rosetta for tests).

### 1.6 Process architecture + IPC

```
Renderer StemsController ──invoke stems:split {pcmL,pcmR,srcRate,quality,windows,sweep}──► main stemsWorker
   ◄── ordered webContents.send events: stems:progress {phase models|load|split, pct, total?} · stems:engine · stems:chunk {startFrame,endFrame,stems[8]} · stems:done · stems:error
main: ensureModels → write planar f32le temp <userData>/terminator-stems/split-<pid>-<ts>.raw (L then R) → fork child → relay
child: {init rawPath,frames,srcRate,modelPaths,windows,sweep,gpu} · {queueWindow span} · {cancel}  →  {loading} {ready,total} {progress} {engine} {chunk} {done} {error}
```
- **IPC ordering race** (`STEMS-IN-ELECTRON.md §6`, controller:297-316): the `invoke` resolution's microtasks run before queued `send` macrotasks → finalizing on resolution lost the tail spans. Completion = the `done` **event** (ordered with chunks); invoke result = errors/busy only; unsubscribe before finalizing.
- Busy slot claimed **synchronously** at entry (`starting` flag, worker:126-131) — an async claim double-forked once.
- **Batch**: a finished child is **parked** 45 s (`PARK_MS`) with models loaded and reused when the next job wants the same model paths + engine (worker:101-125; child:347-352) — model load is the per-split overhead.
- Cancel / `app.will-quit` kill the child and delete the temp file.

### 1.7 Caching, storage, restore
- **Global cache** (`src/main/stemsCache.ts`): `<presets>/stems-cache.json` `{version:1, entries:{ key: { fast?: Entry, fine?: Entry } }}`, `Entry = {quality, assets{drums,bass,other,vocals: 'asset:<sha1>'}, readyRanges [[s,e] seconds], sampleRate, frames, title, savedAt}`; atomic tmp+rename; `MAX_KEYS=300` LRU eviction; a FINE entry serves a FAST request; entries advisory (renderer verifies assets, drops on miss; FOLDERS per-song delete drops by asset hash).
- **Key** (`src/renderer/chopper/stemsKey.ts`): SHA-1 over `[PIPELINE=1, sampleRate, length, channels] + 65,536 strided probe samples` → `s1.<40hex>`; ~10 ms on a full song; bump `PIPELINE` when output changes. (Note: "stemsKey" is the **content key** for the cache, not musical key detection — there is no key detection in the stems pipeline.)
- **Assets**: after `done`, the 4 full-length buffers are encoded **FLAC 16-bit** (`encodeFlac16`, 4 parallel workers, ~3 s for a 3-min song) into the content-addressed asset store as `<title> — DRUMS.stems.flac` etc. (controller:583-603); stems are **derived** → excluded from `.tprojz` bundles/transfers; project JSON carries `stems{quality,assets,readyRanges}` + per-pad masks.
- **Restore**: main track → **lazy** (`setStemsPending`, engine:1700-1730): chips light instantly, the 4 FLACs decode on the first masked demand (saves ~1 s + ~140 MB). Pad-source stems eager.
- Preferences → FOLDERS (`PreferencesWindow.tsx:341-424`): engine sizes/download/delete, per-song stem audio delete, clear all, reveal.

### 1.8 Progress reporting (`stemsProgress.ts`)
Real ticks arrive once per chunk (FINE also per specialist = quarter ticks). `DEFAULT_MS_PER_CHUNK = {fast:2000, fine:8500}`, seeded from last run's measured rate (localStorage `terminator-stems-ms-per-chunk`, blended 50/50); shown % creeps toward the next expected tick (capped `step−0.5`), monotonic, 400 ms UI timer; `ready{total}` seeds the denominator.

### 1.9 Stem mask — what it means to the user (`stemMask.ts`, `ChopperEngine.ts:1593-1990`)
- A pad carries a **4-bit mask** = which stems of its source it *plays*: bit0 drums, bit1 bass, bit2 other, bit3 vocals (== model row order). `MASK_ALL=0b1111` = the original buffer object, bit-exact. `toggleStem` refuses mask 0 (last lit chip can't turn off). Not per-stem gain — on/off.
- Resolution at trigger time: `bufferForPadChop(pad, start, end)` → if ALL / no stems / span not ready → original; else a **chop-length** summed slice (`maskSlice`, LRU 96, ~1 ms/bar) positioned so playback is sample-exact. `resolvePadSource` routes the sequencer/exports/RESAMPLE through the same path; own-sample pads have a per-source twin (`bufferForPadSource`, `sourceStems` map). `spanReady` EPS 1e-3 s; `addReadyRange` merges with EPS 1e-4.
- Live: `restemVoice` hot-swaps a ringing voice's buffer at the current playhead (~12 ms crossfade) when a mask changes or a span turns ready. Waveform draws a per-chop composite (each chop painted in its pad's mix). UI: STEMS button (click = split whole song, right-click FAST/FINE/REMOVE), chips DR BS OT VX on the focused pad, pad menu Stems ▸, Group ▸ "duplicate as DRUMS/BASS/OTHER/VOCALS". Same chops, different groups hear different mixes.
- Outside ready ranges the pad plays the ORIGINAL — never silence.

### 1.10 Packaging traps (`electron-builder.json`, `scripts/electron-afterpack.js`)
`asarUnpack`: `onnxruntime-node/**`, `onnxruntime-common/**`, `dist/main/stemsWorkerChild.js`, `stemsResample.js` (a real node cannot read asar; **every new child import needs its own unpack line** — dev never catches it). `extraResources`: `bin/stems-node/<arch>` per platform; Mac universal carries both darwin arches + `Resources/ort-darwin-x64` (filtered to the darwin-x64 slice + its own `onnxruntime-common`, since electron-builder 26 drops the alias as a "duplicate" and `files` negations never reach node_modules); `x64ArchFiles` lists them. `afterPack` prunes other platforms' ORT slices (~180 MB) from the **merged** universal app only (pruning per-arch temps breaks `@electron/universal`) and asserts the Intel binding + matching `onnxruntime-common` version. Always `npx asar list … | grep -E 'stems|onnx'` + launch the packaged app.

### 1.11 Web/mobile status
Desktop-only (`stemsAvailable()` = bridge has `stemsSplit`). Measured 2026-08-22: the model **does not load in onnxruntime-web** (both EPs fail at `ConstantOfShape` inside `/real_istft/` — needs a re-export with STFT/ISTFT outside the graph), no WASM threads on the site (`crossOriginIsolated === false`; COOP/COEP would break the YouTube iframe), 158 MB per phone. Proposed instead: pre-split the R2 catalog (3,065 tracks / 208 h ≈ 76 h compute; SOUL SAMPLES alone 445 tracks ≈ 11 h FAST, ~6 GB m4a) or on-demand + keep.

### 1.12 What a native build can improve
- **CoreML/ANE**: re-export with STFT/ISTFT outside the graph (the slice op is what Espresso rejects), run the transformer core on ANE/GPU via native `MLProgram` with compiled-model caching (the 67 s compile was the *node binding's* lack of cache) — keep the SNR-vs-CPU self-check as a release gate.
- **Windows DirectML / CUDA** via native ORT providers (unmeasured today; the probe already makes enabling safe for correctness).
- No V8 cage, no child-process fork, no temp raw file, no IPC serialization of 8 Float32Arrays per chunk — in-process session on a background thread, stems written straight into the engine's buffers; zero-copy resampling with `vDSP`/`SIMD`.
- Streaming: overlap-add accumulators are already span-local; native can stream chunk rows into a ring and free them (today 8 full-length planes + weight ≈ 32 B/frame live in the child).
- Background queue across sources with one warm session per model (the parked-child trick becomes trivial), cancellation per chunk, priority preemption mid-batch.
- Int8/quantized or distilled export; 6-stem models; per-stem gain instead of on/off masks; per-stem time-stretch cache keys (already buffer-token keyed).

---

## 2. BASS SYNTH MODULE

### 2.1 Architecture (`public/worklets/bass-synth-worklet.js`, `src/renderer/bass/BassEngine.ts`)
One `AudioWorkletProcessor` (`bass-synth`), mono-summed to stereo out, no AudioParams — **everything by port messages**: `{type:'patch'}`, `{type:'note', on, note, vel, at, tag, slide?, dur?}`, `{type:'notes', list}`, `{type:'bend'|'bends', semis, at}`, `{type:'mod', value}`, `{type:'clear', tag, release}`, `{type:'panic'}`. Events carry an **absolute ctx time** (`at ≤ currentTime` = fire now), inserted into a sorted event list and fired sample-accurately inside `process()` (:572-580). Meter posted ~30 Hz.

Signal chain per voice: 3 PolyBLEP oscillators + SUB + NOISE → mixer tanh overdrive → filter (LADDER | OTA | DIODE) → amp env × velocity → summed → post DRIVE → TONE → GLUE → VOL → DC blocker → safety clip.

**Oscillators** (`Osc`, :48-118): waves `tri | shark | saw | square | pulse | narrow | sine | morph`. `saw = 2t−1−polyBlep`; pulses `w = 0.5 (square) | 0.25 (pulse) | pw (narrow)`, two BLEPs, DC removed `−(2w−1)`; `tri` = leaky-integrated BLEP square `tri = tri·(1−4dt)+sq·4dt`; `shark = 0.62·tri + 0.5·saw`; `morph` crossfades neighbours in `MORPH_ORDER=[tri,shark,saw,square,pulse,narrow,sine]` at position `morph∈[0,1]`. Above Nyquist → 0. Per-osc drift: random-walk target `±drift·6` cents every 0.15–0.75 s; per-voice fixed offsets `(rand−0.5)·3 cents · drift`. Range switch `octave −2..+2` (32'…2'), `semi ±12`, `fine ±50 ¢`. Sub: sine/square, `−1|−2` oct, tracks osc1's semitone offset. Noise: white or pink (Kellet 3-pole: 0.99765/0.0990460, 0.96300/0.2965164, 0.57000/1.0526913, +0.1848·w, ×0.25).

**Mixer drive**: `mixPre = 1 + mixDrive·5`, `s = ftanh(s·mixPre·0.8) / ftanh(mixPre·0.8) · 0.9` (`ftanh` = Padé 7/6 tanh, ±4.97 clamp).

**Filters**:
- **LADDER** (`Ladder`, :160-186): D'Angelo & Välimäki improved Moog ladder, `VT=0.312`, `x=π·fc/sr2`, `g = 4π·VT·fc·(1−x)/(1+x)`, 4 tanh-coupled one-poles, trapezoidal integration, **2× oversampled (ZOH input)**, `res 0..4 = reso·4`, input drive `0.7 + filter.drive·2.5`, output tap `V[poles−1]` (6/12/18/24 dB), output negated, ×`(1+res·0.6)·1.15`.
- **OTA** (`SVF`, :191-212): Cytomic/Zavalishin TPT SVF, `g=tan(π·min(0.49sr,fc)/sr)`, `k = 2 − 1.98·res`, `a1=1/(1+g(g+k))`, `ic1=ftanh(2v1−ic1)`, `ic2=ftanh(2v2−ic2)`; modes lp/bp/hp; `poles>2` cascades a second SVF at `res·0.6`; input `×(1+drive·2)`, output `/(1+drive)`.
- **DIODE** (`Diode`, :217-258): Zavalishin/Pirkle ZDF diode ladder, `g=tan(π·min(0.45sr,fc)/sr)`, G4..G1 chain, `K = reso·24` (self-osc edge ≈22 in this model — 17 wasn't enough), input compensation `×(1+0.3K)`, `un = ftanh((x − K·σ)/(1+K·γ))`, input `×(0.6+drive·1.5)`, output ×1.4.
- Cutoff per sample: `fc = sm.cutoff · 2^( kbd·(pitch−48)/12 + envAmt·8·fenv·velF + lfo·lfoDepthCut·3 )` clamped 15..18000 Hz, `velF = 1+(vel−1)·velFilt` (:638-644).

**Envelopes** (`ADSR`, :121-155): RC-shaped; attack toward 1.25 with `k=1−exp(−1/(a·sr))` (convex knee), decay/release `k=1−exp(−1/(t·sr·0.6))`; floors a≥0.5 ms, d≥1 ms, r≥2 ms. Filter env and amp env identical class.

**Pitch**: exp glide `glideK = 1−exp(−1/(glide·sr·0.35))` (legato only bends when a voice was already active); **SLIDE** notes = linear semitone ramp `slideFrom→target` over `slideDur` overriding glide; pitch bend global (semis); legacy LFO→pitch; `f = 440·2^((pitch+semis+cents/100−69)/12)`.

**Post**: DRIVE `postDrivePre=1+drive·9`, `ftanh(x·pre)·postNorm`; TONE one-pole LP `k=1−exp(−2π·tone/sr)`; GLUE feed-forward comp `thr=0.5−glue·0.35`, gain toward `thr/|x|`, attack coeff 0.004 / release 0.00025, makeup `(1+glue·0.8)`; VOL; DC blocker `y = x − x₋₁ + 0.9993·y₋₁`; soft clip beyond ±1.2.

**MOD matrix** (`applyMods`, :455-514): 3 LFOs (`tri|square|saw|ramp|sine|sh`, rate 0.05–30 Hz, `key` restarts on note-on) + 2 trigger envelopes (`ramp`, `fall`, `exp` fall = `e^{−4.5u}(1−0.011u)` or `lin`) fire on every note-on; `mods[] = {src, target path, depth −1..1}`; copy-on-write patch view per block; `modRange()` taper table: `filter.cutoff` 20–16000 log 5 oct, `post.tone` 400–20000 log 4 oct, env a/d/r 0.001–4 log 3 oct, LFO rate log 3 oct, `fine ±50`, `semi ±12`, `envAmt ±1`, `post.gain 0–1.5`, `pw 0.05–0.5`, `morph 0–1`, else 0–1 linear. Param smoothing: cutoff τ 20 ms (4 ms when modulated), res 20 ms, drives/gain 30 ms.

**Voices** (:398-441): `MAX_VOICES=8`; `voices ≤ 1` → **mono, last-note priority**, held-note stack, legato when `legato && stack>1`, note-off falls back to the most recent held note (Model D); poly → reuse a voice on the same note, else a free one, else steal oldest (`startedAt`). UI offers MONO / POLY(6).

### 2.2 Parameter list (ranges from `BassSection.tsx` knobs; defaults `defaultBassPatch()` `BassEngine.ts:124-158`)

| Path | Range | Default | Notes |
|---|---|---|---|
| `osc[i].on/wave/octave/semi/fine/level/pw/morph` | wave enum; oct −2..2; semi ±12; fine ±50 ¢; level 0–1; pw 0.05–0.5; morph 0–1 | osc1 saw 0.8 · osc2 square +7¢ 0.55 · osc3 off saw −1oct −5¢ 0.4 | PW only for `narrow` |
| `sub.level/wave/octave` | 0–1; sine|square; 1|2 | 0.5 / sine / 1 | |
| `noise.level/color` | 0–1; white|pink | 0 / white | |
| `mixerDrive` | 0–1 | 0.15 | |
| `filter.model/mode/cutoff/reso/envAmt/kbd/poles/drive` | ladder|ota|diode; lp|bp|hp; 20–16000 log; 0–1; −1..1; 0–1; 1–4; 0–1 | ladder / lp / 420 / 0.25 / 0.45 / 0.3 / 4 / 0.2 | |
| `filtEnv` a/d/s/r | 0.001–2 · 0.005–4 · 0–1 · 0.005–4 (log) | 0.003 / 0.28 / 0.15 / 0.2 | |
| `ampEnv` a/d/s/r | same | 0.004 / 0.3 / 0.85 / 0.12 | |
| `glide` | 0–1 s | 0.04 | |
| `legato` / `voices` | bool / 1..8 | true / 1 | |
| `drift` | 0–1 | 0.35 | |
| `velAmp` / `velFilt` | 0–1 | 0.5 / 0.4 | |
| `post.drive/tone/glue/gain` | 0–1; 400–20000 log; 0–1; 0–1.5 | 0.15 / 20000 / 0.2 / 0.8 | |
| `modSrc.lfo[3]` rate/wave/key | 0.05–30 log | 4.5 tri · 0.5 sine · 8 sh(key) | |
| `modSrc.trig[2]` ramp/fall/shape | 0.001–2 · 0.005–4 · exp|lin | A 0.005/0.35 exp · B 0.12/0.6 exp | |
| `mods[]` | {src,target,depth −1..1} | [] | |
| `lfo` (legacy) | rate/wave/toCutoff/toPitch | 4.5 tri 0 0 | honoured, hidden |

### 2.3 Patch format + storage
`BassPatch` interface (`BassEngine.ts:40-63`); deep-merged over defaults on load (`deepMerge`, worklet `mergePatch`), so old/partial patches fill in. 8 factory patches `BASS_FACTORY` (MODEL D, FAT SUB, REESE, ACID, MOOG PLUCK, SEM WARM, GROWL, 808 SINE). User patches: `bassPatchStore.ts` → localStorage `terminator.bassPatches.v1` mirrored to `bass-patches.json` via IPC (newer `savedAt` wins per name); factory never overwritten; edited name gets `*`. Project file: `ChopPreset.bass: BassPreset = {patch, patterns, currentIdx, key, lock, grid, presetName?, bendRange?}` (`serialize/restore` :843-869). Knob MIDI-learn ids `bass.<path>` persist in the chopper's CC map; knob menu COPY/PASTE/RESET/LEARN/ASSIGN TO MOD.

### 2.4 Piano roll data model (`BassEngine.ts:65-112`, `PianoRoll.tsx`)
- `BassNote {id, note 0..127, start (beats, float), dur (beats ≥0.05), vel 0.05..1, slide?}`; `BassPattern {bars 1..8, notes[], bend?: BendPoint[{beat, semis}]}`; up to `BASS_MAX_PATTERNS=16`; roll range `BASS_LOW=24 (C1)`..`BASS_HIGH=72 (C5)`, default view centred on C2 (36).
- Grid `grid` = divisions per beat: 1,2,4,8 (1/4…1/32), 3,6 (triplets), **0 = OFF** (no snap anywhere incl. live record). No two notes of same pitch+kind overlap (`addNote` trims/removes). Tools DRAW/SLIDE/ERASE/VEL; marquee, duplicate (ALT-drag), transpose in scale (↑↓), nudge (←→), S toggles slide.
- **Tie/slide**: no tie flag; a `slide` note triggers nothing — whatever is sounding bends to its pitch linearly over its `dur` (FL-style). **BEND lane**: breakpoints, linear between, flat outside (`bendAt`), range ±2 or ±12 st (`bendRange`), sampled per tick; exports via `sampleBend` (stepwise-linear at 96/beat).
- **Scheduler**: `PPQ=96` tick map; `tickDur = 60/max(20,bpm)/96`; note-on at `round(start·PPQ)`, off at `round((start+dur)·PPQ)` (≥on+1; offs past loop wrap); offs posted before ons at the same tick; ons at `at+0.0002`. Live record: start quantised to the grid (`round`), length kept (min one grid step), or exact tick when grid OFF (`commitRecorded` :546-564).

### 2.5 KEY LOCK (`theory.mts`)
15 scales (`SCALES`: chromatic, minor, major, minorPent, majorPent, blues, harmonicMinor, melodicMinor, dorian, phrygian, phrygianDom, lydian, mixolydian, locrian, wholeTone) as semitone sets. `KeyLock {root 0..11, scale}`. `snapToScale`: nearest in-scale note, **ties resolve DOWN** (bass players resolve downward), chromatic = identity. `stepInScale` moves by degrees; `scaleDegree` labels rows 1..7; `conformToKey` snaps a whole pattern. Applied in: drawing/dragging (when lock on), MIDI `noteOn` via `quantizeNote`, live record. **Pad fold**: on-screen pads `padNote(i) = 36+root + floor(i/L)·12 + steps[i mod L]` (16 unique in-key notes); MPC pads `mpcPadNote`: `MPC_PAD_BASE_NOTE=36`, `MPC_ROOT_PAD=3` (pad 4 = root, pads 1–3 below), ports matching `/MPC|MPD/` use it (`ChopperView.tsx:1968-1971`).

### 2.6 Transport sync, MIDI, export
- `start(atTime, offsetBeats, patternIdx)` phase-locks to the chopper transport anchor (anchor honoured if ≤50 ms old, else `now+0.02`); `startTime = anchor − offTicks·tickDur`; `LookAhead(base 0.25 s, boosted 0.5 s, 25 ms)` on the shared **Worker-based clock** (`lib/audioClock.ts`; a late tick >3×interval boosts the horizon for 6 s); incremental `nextTickTime += tickDur` so BPM changes apply next tick. Editing while playing: `clear tag 'seq'` without release, release changed/removed notes, rewind scheduler to now (:711-737). Arranger drives via `playTimeline` (tag `arr`).
- MIDI into bass (`ChopperView.tsx:1963-1973`): when BASS MIDI IN is on, `when = max(now, now − (performance.now()−e.timeStamp)/1000 + ctx.baseLatency)`; `0xE0` → `setBend(((v<<7)|n − 8192)/8192 · bendRange)` (records into the lane while ● REC); CCs → MIDI learn; on-screen/computer pads → `padOn(idx)`. REC with transport stopped runs the chopper's count-in.
- Export: `renderBassOffline(patch, notes, lengthSec, sampleRate, bends)` — same worklet in an `OfflineAudioContext`, stereo; used by master mixdown, stems/trackouts, arranger. **MPC / drum-rack export targets don't carry the bass** (audio-only stems + master do) — memory note `project_bass_module.md` "Owed".

### 2.7 Tests
`scripts/bass-synth.test.mts` (headless worklet via `vm`, SR 44100, block 128, seeded `Math.random`): (1) default patch pitch within 3 % of C1, peak 0.1–1.3, sustain >0.05, release tail <0.002, attack rising; (2) every filter model bounded at reso 0 and 1 (peak <1.6), cutoff 120 vs 6000 Hz brightness ×1.5, ladder/diode self-oscillate at full reso; (3) all 7 waves hit the note, |DC| <0.05; (4) sub an octave down; (5) mono legato glide mid/end/fallback pitches, no level dip; (6) poly two notes ≥1.15× louder, release; (7) scheduled events silent before `at`; (8) `clear(tag)` drops only that tag; (9) LFO on cutoff moves brightness ≥4× still-spread, trig env brightens then returns (±35 %); (10) morph endpoints equal tri/sine/saw, tri→saw brightness monotone; (11) slide bends C1→G1 over 0.3 s, original note-off releases, slide alone is silent; (12) timed `bends` ramp 0→+7 st lands on time. `bass-theory.test.mts`: scale membership, tie-down snaps, degrees, note names (60=C4), `stepInScale`, fold ranges, every scale's snap is in-scale, pad fold = 16 unique ascending in-key notes, MPC pad mapping (pad 4 root, bank B continues).

---

## 3. AUDIO INPUT / OUTPUT + RECORDING

### 3.1 Engine context (`ChopperEngine.ts:906-925`)
`new AudioContext({ latencyHint: 'interactive' })` by default; Preferences → AUDIO (read **synchronously** via `getSettingsSync` because these are constructor-only): `sampleRateHz ∈ {44100, 48000}` → `opts.sampleRate`; `bufferFrames ∈ {128,256,512,1024}` → `latencyHint = frames / (sampleRate ?? 48000)` seconds. Applied next launch. Measured on his Mac: system 48000 Hz / 5.33 ms `baseLatency`; explicit 44100 + 512 → 11.61 ms. Legacy `audio.sampleRate/bufferSize` keys deliberately ignored (they were never applied). `ppq` 960 default. Master chain: masterGain 0.85 → optional WaveShaper clip (4× OS only when engaged) → DynamicsCompressor limiter (−1 dB, ratio 20, 1 ms/50 ms) → `outputNode` → destination; an AnalyserNode (1024) taps `outputNode` for the peak meter.

### 3.2 Output device
`setOutputDevice(id)` / `reopenOutput()` (`:6473-6495`): `ctx.setSinkId({type:'none'})` then `ctx.setSinkId(id)` (the detach makes an unchanged `''` actually re-open after a device swap), fallback `setSinkId('')`; no-op pre-Chrome-110/Safari. Triggered by Preferences `audio.outputDeviceId` (`ChopperView.tsx:3005`) and by `devicechange` debounced 250 ms (ctx:975-982) — Chrome pins a context to the endpoint it opened with and keeps rendering into a dead one otherwise. Devices enumerated in `PreferencesWindow.tsx:473-491` (`enumerateDevices` after a short `getUserMedia({audio:true})` to unlock labels).

### 3.3 Input devices + constraints
- Preferences stores `audio.inputDeviceId` but **nothing applies it** (grep: no consumer) — the RECORD SAMPLE panel has its own picker persisted in localStorage `terminator_record_input` (`ChopperView.tsx:21, 3276-3283`). Picker entries: `DEFAULT_INPUT_ID` ("Microphone / plugged-in input"), enumerated `audioinput` devices minus `'default'` (labels unlocked by a one-time `getUserMedia({audio:true})`; `devicechange` listener while the panel is open), `INTERNAL_OUTPUT_ID` (🔁 Terminator output), `SYSTEM_AUDIO_ID` (Windows + Electron only).
- **Exact constraints** (`recordConstraints.ts:16-26`): `{ echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:{ideal:2}, deviceId:{exact:id} (if chosen), sampleRate:{ideal: round(ctx.sampleRate)} (desktop passes `engine.ctx.sampleRate`; the mobile hook passes null) }`. No `latency`, no `sampleSize`. Discovered trap (2026-08-22): `audio:true` is a phone-call request — Chromium turns on EC/NS/AGC and downmixes to mono. `describeRecordTrack` flashes "48 kHz · stereo · raw" or "⚠ … ON" from `track.getSettings()`. Gate `test:record-constraints` (11). Unsupported keys are ignored by the UA (iOS Safari still opens its mic). The old looper (`audio/AudioEngine.ts:397`) also asks EC/NS/AGC off but its `LoopRecorder` records **Opus** (lossy) — legacy.

### 3.4 Capture path + bit depth (`ChopperView.tsx:3413-3550`, `useSampleRecorder.ts`)
`getUserMedia` → `MediaRecorder(stream, {mimeType})` with preference `['audio/webm;codecs=pcm', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']` (PCM webm in Chromium/Electron = lossless; Safari falls to AAC) → Blob chunks → on stop: `new AudioContext().decodeAudioData(blob)` → `encodeWAV(decoded, 24)` (**24-bit WAV**, `StemExporter.ts:12`) → saved to the Sample Library RECORDINGS (`libraryBridge.saveRecording`) as `recording-YYYYMMDD-HHMMSS.wav` (or `resample-…wav`) → `loadAudioFile(file, padIdx)` where `padIdx` = RECORD INTO target else the **next empty pad** (`while (engine.padSourceKey(padIdx)) padIdx++`); flash `PAD n: recorded`. Not a worklet/ScriptProcessor capture; no float capture; decode happens at the throwaway context's (hardware) rate. Mobile hook: same pipeline, `webm`/`mp4` fallback, iOS hides device ids until permission → blind enumerate, re-enumerate after each take, `exact` deviceId falls back to default on failure.

### 3.5 Monitoring + meters
No input→output monitoring path exists (the take is never routed to the speakers — explicit "listen-only; never routed to destination (no monitoring echo)"). Level meter: a **separate** `AudioContext` + `createMediaStreamSource` → `AnalyserNode` (fftSize 512), byte-frequency RMS ×1.6 drawn on a canvas / pushed ~10 Hz; elapsed counter. No input gain, no clip indicator (noted in memory as not built).

### 3.6 Loopback / resample-own-output paths
- **🔁 Terminator output** (`INTERNAL_OUTPUT_ID`, :3438-3447): taps `engine.mixerEngine?.master.output ?? engine.outputNode` (post-master, what he hears) into `ctx.createMediaStreamDestination()`; its stream feeds the same MediaRecorder path; disconnected after the take. Nothing routed back → no feedback. Pre-master / count-in / auto-start not built.
- **🖥 System Audio** (`SYSTEM_AUDIO_ID`): Windows only — `ipc.enableLoopback()` (electron-audio-loopback installs a display-media handler), `getDisplayMedia({video:true, audio:true})`, video tracks stripped, loopback disabled. Mac throws "System audio not available on Mac" (tip: Audio Routing Kit). `main.ts:800-806` grants `media/midi/midiSysex`; `chopper:getDesktopSources` via `desktopCapturer` exists for Screen-Recording permission detection.
- **RESAMPLE** (pad menu) is offline, not recording: `renderPadAsPlayed` (mask + pitch + reverse + attack, dry) → FLAC → next empty pad.

### 3.7 Latency numbers and meter (`ChopperEngine.ts:2696-2765`, `MidiLatencyMeter.tsx`)
`hwLatencySec() = ctx.outputLatency if > 0 else 0.02 + ctx.baseLatency` (outputLatency already includes baseLatency — summing double-counted and pulled the playhead early). Input lag = median of the last 48 `(performance.now() − midiEvent.timeStamp)` samples (discard <0 or >0.5 s), worst reported alongside; UI polls every 500 ms, `~` prefix when outputLatency is estimated. Typical OUT ≈10 ms macOS Chrome, 20–40 ms Windows shared-mode. Both record paths back-date hits by handler lag + `hwLatencySec` so a player locks to what they hear (queue note 2026-08-20); MIDI→bass uses `baseLatency` compensation (§2.6). Engine-internal measurements: metronome spacing error 1.6e-15 s vs the anchor (sample-exact scheduling); scheduler tick = 25 ms Worker interval with 0.25/0.5 s look-ahead.

### 3.8 Web Audio limitations (recorded in code/memory, all confirmed here)
| Limitation | Where it bites |
|---|---|
| **2-in / 2-out only** — `channelCount ideal 2`, destination stereo; outputs 3–8 and multi-input recording impossible | `project_native_build_question.md` (the real trigger for a native build) |
| No ASIO/CoreAudio exclusive mode, no aggregate devices, no per-channel routing, no input-pair selection from a multi-channel interface (device list = OS inputs only) | record panel picker |
| Sample rate only settable at context construction (44.1/48 k), applied next launch; `decodeAudioData` resamples everything to ctx rate (hence the stems 44.1 k bridge) | `ChopperEngine:916`, `stemsResample.ts` |
| Buffer size = a `latencyHint` *suggestion*; the real quantum is 128 frames; latency floor ≈5 ms base + device buffer, ≈10–20 ms round trip; `outputLatency` unreported on Safari | `hwLatencySec`, Preferences copy |
| Capture via MediaRecorder container (PCM webm in Chromium; AAC on Safari), decoded after the fact — no float/32-bit capture, no true sample-accurate punch-in, no monitoring, bit depth capped by the codec path (24-bit WAV on write) | `finalizeRecording` |
| Output device pinned at open; device swaps need the `setSinkId` null-sink trick; no setSinkId in Safari | `reopenOutput` |
| System-audio loopback Windows-only (needs Screen Recording perms on Mac, unreliable) | `startRecording` |
| Input device preference in Preferences is decorative today | `PreferencesWindow.tsx:589-597` |
| Device labels/ids hidden until mic permission (iOS especially) | `useSampleRecorder.ts:9-15` |

A native engine (CoreAudio/ASIO/WASAPI-exclusive) removes every row above: N×N channel I/O with per-pad/strip output routing, true buffer-size control (≈3 ms round trip measured target), float capture straight into the pad buffer with input monitoring, aggregate devices, and sample-rate agility without a resampler between the library/stems (44.1 k) and the interface.