# TERMINATOR CHOPPER ENGINE — ARCHITECTURE DOSSIER (for a native C++/JUCE rebuild)

Source of truth: `~/terminator/src/renderer/chopper/ChopperEngine.ts` (7319 lines, read in full), plus `ChopperView.tsx`, `PadGrid.tsx`, `WaveformView.tsx`, `trimRegions.ts`, `padClipboard.ts`, `bpmDetect.ts`, `useSampleRecorder.ts`, `recordConstraints.ts`, `usePadActivity.ts`, `stemMask.ts`, `lib/audioClock.ts`, `lib/swing.ts`, `audio/effects/*`, `audio/compressorLatency.ts`, `audio/StemExporter.ts`, and the `scripts/*.test.mts` gates. All line numbers below are `ChopperEngine.ts` unless prefixed. Units: seconds unless stated; "buffer seconds" = un-rate-adjusted source time; "real seconds" = context clock.

---

## 1. DATA MODEL

### 1.1 Core persistent types (quoted from ChopperEngine.ts)

| Type | Definition (file:line) | Fields / defaults / ranges |
|---|---|---|
| `Chop` | :237–247 | `{ id: number; start: number; end: number; free?: boolean }`. `start/end` in **effective (trimmed) timeline seconds**. `free` = independent region (made by pad DUPLICATE via `cloneChop`/`reviveChop`), not part of the contiguous slice chain: boundary drags don't couple to neighbours, removal never merges a neighbour. Min chop length 10 ms (0.01) everywhere. |
| `Pad` | :249–273 | `{ index; chopId: number\|null; mode: 'oneshot'\|'loop'; color; pitch; gate?; fadeIn?; fadeOut?; stems?: StemMask; reverse?: boolean }`. `pitch` semitones −24..+24 (clamped :4105). `color = hsl(round((i×137.508) mod 360),100%,60%)` :364. `gate` = NOTE ON (sounds only while held). `fadeIn/fadeOut` seconds inside the chop (LOOP = crossfade, one-shot = envelope), each capped: fadeIn ≤ region, fadeOut ≤ region − 64 frames/sr (:4076–4087). `stems` 4-bit mask 1..15, absent = 15 = original. `reverse` undefined = follow source. |
| `PadPlay` | :216 | `{ mode; gate; fadeIn; fadeOut; pitch }` — the bundle that travels with a pad through every rearrangement. |
| `PadBuffer` (private) | :154–160 | `{ buffer: AudioBuffer; videoId: string; title: string; start: number; end: number }` — a pad's OWN source and its trim region. Held in `padBuffers: Map<padIdx, PadBuffer>`. Several pads may share one `AudioBuffer` with different `start/end` (= one BLOCK). |
| `PadSlot` | :165–168 | `{kind:'buffer', buffer, videoId, title, start, end, play?, group?, stems?} \| {kind:'chop', chopId, pitch, mode, play?, group?, stems?} \| null` — the unit the rearrangement planner moves. |
| `SeqPattern` | :275–296 | `{ bars: number; resolution: number; grid: number[][]; revGrid?: boolean[][]; velGrid?: number[][]; loop: boolean; viewResolution?: number }`. `grid[step] = pad indices firing at that stored step`. `resolution` = STORED steps/bar; `viewResolution` = displayed grid, `resolution % viewResolution === 0`. `velGrid` cells 0.05..1 (`clampVel` :25, absent = 1). `revGrid` is written but **no longer read at playback** (:6136–6140). |
| Sequencer constants | :529–539 | `SEQ_MAX_STEPS = 1536` (4 bars × 384), `SEQ_MAX_VIEW_STEPS = 512`, `SEQ_RESOLUTIONS = {2,3,4,6,8,12,16,24,32,48,64,96,128,192}` (straight 1/2…1/128 + triplets; all divide 384). bars 1..4 (:5428). |
| `PatternEvent` | :298–306 | `{ padIdx; time; maxDur; reverse?; velocity? }` — offline render events. |
| `PadVoice` | :380–397 | `{ src; gain; startCtxTime; chopStart; originalChopStart?; stretchRatio?; reverseOrigEnd?; playbackRate?; loopPeriod?; loopWarmup?; gate?; velocity?; stemBase?; posOffset? }` — one voice per pad (`voices: Map<padIdx, PadVoice>`; a retrigger replaces it). |
| `ChopperActivity` | :402–406 | `{ activePads: number[]; lastTriggeredPad; playing }` — hot-path channel, separate from full state. |
| `ChopperState` | :400–521 | Full published snapshot (see table below for `master`). |
| `ChopPreset` | :59–147 | The project/preset JSON (section 7). |
| `HistorySnapshot` | :313–359 | Undo unit (section 1.5). |
| `TrimRegion` / `TrimChop` | trimRegions.ts:26–39 | `{ startSec; endSec; chops: TrimChop[] }` in **FILE time**; `TrimChop {id; startSec; endSec; padIdx?; stems?}`. |
| `StemMask` | stemMask.ts:12–27 | bit0 drums, bit1 bass, bit2 other, bit3 vocals; `MASK_ALL = 0b1111`; `toggleStem` refuses to clear the last bit; `normalizeMask(garbage) → 15`. `ReadyRange = [start,end]` sorted/disjoint, `spanReady` EPS 1e-3, `addReadyRange` EPS 1e-4. |

### 1.2 `ChopperState.master` (defaults :1094–1104, clamps in setters :6370–6575)

| Field | Default | Range / unit |
|---|---|---|
| volume | 0.85 | 0..1 → masterGain (setTargetAtTime τ 10 ms) |
| pitch | 0 | semitones −24..24 (global = 'main' source pitch) |
| fine | undefined→0 | cents −50..50, rounded |
| filterFreq / filterEnabled | 20000 / false | Hz 20..20000; lowpass Q 6, mix 1 |
| eqLow/eqMid/eqHigh | 0 | dB ±24 (EQ3: lowshelf 60 Hz, peaking 2 kHz Q1, highshelf 12 kHz) |
| compStyle / compMix | 'off' / 0 | `COMP_PRESETS` :369–375 (off/light/punchy/ny/aggressive: drive 0/3/6/12/18 dB, ratio 1/2/4/8/12, attack .01/.03/.01/.001/.001, release .15/.2/.08/.05/.03, makeup 0/2/4/6/8, mix 0/1/1/0.5/1); compressor threshold −18 dBFS, knee 6 (Compressor.ts:173–174) |
| delayTime/delayFeedback/delayMix | 0.25 / 0.3 / 0 | s (R = 1.5×L :6565), fb ≤ 0.95, mix ≤ 0.001 = bypass |
| reverbMix / reverbDecay | 0 / 2 | mix ≤ 0.001 = bypass; decay 0.1..10 s, synthesized stereo IR (Reverb.ts:426–446, LCG seed 0x1234567, −60 dB at decay, pre-HPF 200 Hz) |
| attack | 0.003 | 0..0.5 s (linear ramp) |
| release | 0 | 0..0.5 s tail fade after chop end |

### 1.3 Engine-level defaults (constructor/fields)

| Field | Default | Notes |
|---|---|---|
| `snapMode` | `'off'` :783 | `'off'\|'transient'\|'1/4'\|'1/8'\|'1/16'` |
| `chopMode` | `true` :782 | empty-pad tap while playing = chop |
| `transientSensitivity` | web 0 / desktop 0.3 :795 | 0..1 |
| `acDrumsOnly` | false | swaps transient set |
| `arpEnabled/arpRate/arpDirection/arpRandom` | false / 4 / 'up' / false :797–800 | rate: 1=1/4, 2=1/8, 4=1/16, 8=1/32 |
| `metronomeBpm / Sound / Enabled` | 120 / 'click' / false :883–885 | bpm clamp 20..300 |
| `countInEnabled / countInBeats` | true / 4 :895–896 | |
| `inputQuantize` | 100 :851 | 0..100 |
| `seqBars / seqResolution / seqViewResolution` | 2 / 4 / 4 :812–814 | working state; `sequences[0]` literal is `{bars:2,resolution:16,grid:[],loop:true}` :821 but `syncCurrentToArray` overwrites it from working state → effective default 2 bars @ 1/4 |
| `seqLoop` | true | |
| `chopVolume / normalizeGain` | 1 / 1 | |
| `nextChopId` | 1 | |
| `nextSampleTrack / nextGroupNo / nextChokeGroup` | 2 / 2 / 1 | |
| `chopOffsetMs` | 0 | clamp ±200 :6658 |
| `stretchEnabled / targetBpm` | false / 0 | targetBpm clamp 20..300 |
| `HISTORY_MAX / MAX_HISTORY_SAMPLES / COALESCE_MS` | 100 / 2 / 500 :770–777 | |
| `STRETCH_CACHE_MAX_BYTES` | 128 MB :524 | LRU by estimated bytes |
| `STEM_SLICE_CACHE_MAX` | 96 entries :1658 | |
| loop render cache | ≤24 entries per buffer :4732 | |

### 1.4 Sources, blocks, groups, strips, mute groups (state maps)

| Map | Key → value | Semantics |
|---|---|---|
| `padSourceKey(i)` :1310–1317 | → `'main'` (main-track chop), `'src:<videoId>'` (own sample), or `padGroups` override `'grp:N'` | identity of the SOURCE/GROUP behind a pad; null = empty |
| `padGroups: Map<padIdx,string>` | override group key | set by `setPadGroup/setPadsGroup('new'→'grp:N')`, `duplicatePadToNewGroup` |
| `sourceRoutes: Map<sourceKey,'sampleN'>` | default mixer strip per source/group; `'main'` is always `'sample'` | numbering never reused (`nextSampleTrack`) |
| `padRoutes: Map<padIdx,'sampleN'>` | per-pad override | `padRoute(i)` = own → source default → `'sample'` :2347 |
| `padChoke: Map<padIdx,string>` | mute-group override: `'none'` (poly) or `'grpN'` (note: **no colon**, vs group key `'grp:N'`) | `chokeGroupOf(i)` = own → `padSourceKey(i)` → `'none'` :2461 |
| `sourceFx: Map<sourceKey,{attack?,pitch?,fine?,reverse?}>` | per-source waveform-bar settings | `'main'` reads `masterState.attack/pitch/fine` + `reverseSample`; others default attack = master attack, pitch 0, fine 0, reverse false :2519–2523 |
| `sourceNorm: Map<'src:<videoId>', gain>` | per-source NORM multiplier | applied per voice |
| `routeBuses: Map<route,GainNode>` | one GainNode per non-'sample' route | created on demand :2423 |

A **BLOCK** = contiguous run of pads sharing `padSourceKey` (`blockRange` :1419). Blocks move as a unit and push others aside (`insertPushing` :1513), never overwrite.

### 1.5 Undo snapshot (`HistorySnapshot` :313–359, `buildSnapshot` :5069)
chops, pads, nextChopId, sequences (deep), currentSeqIdx, bpm, targetBpm, `buffer` (= the ORIGINAL `fileBuffer`), trims, trackTitle, 6 transient arrays, reverseBuffer, padBuffers (refs), padRoutes, padChoke, sourceRoutes, padGroups, sourceFx, nextSampleTrack, nextChokeGroup, reverseSample, inputQuantize, `drums` (DrumEngine.serialize()). Not captured: stems audio (derived), masterState knobs, metronome, mixer. Coalescing by group key within 500 ms (`pushHistory(group)`); `beginHistoryBatch/endHistoryBatch` collapses composite edits; `pruneHistorySamples` frees buffers beyond the 2 most recent distinct samples. Pad pitch/fades/boundary drags use groups `pad-pitch-N`, `pad-fade-N`, `chop-boundary-<id>-<side>`, `auto-slice`.

---

## 2. AUDIO GRAPH

### 2.1 Context & wiring (constructor :905–1104)
- `new AudioContext({ latencyHint: 'interactive' })`; desktop prefs override: `sampleRate` 44100|48000, `latencyHint = bufferFrames/rate` for bufferFrames ∈ {128,256,512,1024} (:914–925). Read synchronously from `window.terminator.getSettingsSync().audio`.
- Live chain (:1048–1091):
  `voice.src → voice.gain → busFor(pad)` where `busFor` = `chopGain` (no mixer attached, or route 'sample') else `routeOutput(route)` (:2435–2439)
  `chopGain(gain = chopVolume × normalizeGain) → padBus` ; drums feed `padBus` directly (`drumBusInput`)
  `padBus → [extra FX rack, lazily spliced: clipper→waveshaper→saturator→widener→mseq→bitcrusher→autopan→trancegate→chorus] → Filter(lowpass, Q6, 20 kHz, mix 1, bypassed until filterEnabled) → EQ3 → compMixIn → {dry leg (direct, or through compDryDelay while 0<mix<1) + Compressor} → compMixOut → Delay → Reverb → masterGain(0.85) → masterClip (WaveShaper, null curve = passthrough, oversample 'none' until enabled) → masterLimiter (DynamicsCompressor thr −1 dB, knee 0, ratio 20, attack 1 ms, release 50 ms) → outputNode → ctx.destination`
  `outputNode → meterAnalyser (fftSize 1024)` for `getPeakLevel()`.
- `attachMixer(mixer)` :1113–1118: removes `masterLimiter` from the live path (`masterClip → outputNode`), since the DAW mixer's master strip has its own −1 dB/20:1 brickwall. The view then does `engine.outputNode.disconnect(); engine.outputNode.connect(mixer.getChannelInput('sample'))` and `engine.routeOutput(name).connect(mixer.getChannelInput(name))` per extra strip (ChopperView:690–691, 1649). Route buses are **dry** (no internal FX chain); only the 'sample' route passes through the internal filter/EQ/comp/delay/reverb.
- Metronome clicks connect straight to `ctx.destination` (:4993 etc.) — they bypass the mixer and master chain entirely.
- Parallel-compression latency: `compressorLatencySec(sr)` measures DynamicsCompressor look-ahead by impulse (≈6 ms / 256 frames @44.1k) once per rate (compressorLatency.ts:494–527); `compDryDelay.delayTime = sec`, spliced only while `0.001 < compMix < 0.999` (:6534–6550). Offline chains mirror it via `compressorLatencyKnown`.
- `setParam` (effects/param.ts): live sets glide with `setTargetAtTime(τ 10 ms)`; inside `OfflineAudioContext` sets are instant (avoid 50 ms sweeps at export head).
- Output device: `setOutputDevice(id)` / `reopenOutput()` :6473–6495 — `setSinkId({type:'none'})` then `setSinkId(id)` to force a real re-open; debounced 250 ms on `devicechange`.
- Resume: on `visibilitychange`/`pageshow`/`statechange` when state ≠ 'running' (:934–953); `triggerPad` resumes then replays the hit once running (:4144–4149).

### 2.2 Latency math (one definition :2695–2715)
`hwLatencySec = ctx.outputLatency > 0 ? outputLatency : 0.02 + (baseLatency ?? 0)`. `outputLatency` already includes `baseLatency` (never summed). `hwLatencyMeasured()` = outputLatency > 0 (Safari returns 0 → 20 ms estimate).
- Playhead (`getPlaybackPos` :2774–2802), follows `lastTriggeredPad`'s voice: `elapsed = max(0, now − startCtxTime − hwLatency) × playbackRate`; LOOP: `elapsed %= loopPeriod`; reverse: `reverseOrigEnd − elapsed`; stretch: `originalChopStart + posOffset + elapsed × stretchRatio`; else `chopStart + posOffset + elapsed`. Display lead: `getPlayheadPos = pos + 0.016` (:2810–2813) — drawn dot only; chop placement uses the un-led value.
- Recorded hit time (:4246–4249): `hitTime = now − min(0.05, (performance.now() − event.timeStamp)/1000) − hwLatencySec`.
- Input-lag meter: `recordInputLag(ts)` keeps the last 48 lags (drops <0 or >0.5 s), `getLatencyReport` = {outputMs, inputMs (median), worstMs, totalMs, samples, outputMeasured} (:2717–2765).
- CHOP OFFSET (`chopOffsetMs`, UI "TRIM"/"Chop timing offset", ±200 ms): added to the playhead position before snapping when a chop is dropped (:3830, 3851).

### 2.3 Voice lifecycle (`startVoice` :4329–4535)
1. Resolve source: pad's own buffer (`bufferForPadSource` — stem-masked slice or original) else main chop (`bufferForPadChop`). `posOffset = regionStart − slice.start` (stem slices play in slice coordinates).
2. Reverse: `reverseOverride ?? reversedFor(pad)` (pad override → source REV). Reversed buffer = full mirrored copy (`reversedOf`: main keeps `reverseBuffer`, others WeakMap); start offset `buffer.duration − end`, `reverseOrigEnd = end`.
3. Stretch (desktop): if `stretchEnabled && bpm>0 && targetBpm>0 && |ratio−1| > 0.005`, cache lookup by `stretchKey(buf,start,end,ratio)` (`b<token>_start4_end4_ratio4`); hit → play cached stereo buffer from 0; miss → play dry now and `_warmOneChop` async. SoundTouch `tempo = targetBpm/bpm` (pitch preserved), slice → CHUNK 4096 extract, max 4× length (:6722–6771). Warm-all sweep on toggle/targetBpm/chop-set change. Stretch + pitch combine (stretched buffer is then detuned).
4. LOOP: `loopBufferFor(srcBuf, start, dur, fadeIn, fadeOut)` → `renderCrossfadeLoop` (:180–218): `period = n − fo` (fo capped to n−64 frames), env = equal-power `sin(π/2·j/fi) × cos(π/2·(j−(n−fo))/fo)`, overlap-add of `M = ceil(n/period)` warm-up passes + one steady period, power-normalised so steady Σenv² ≤ 1; `src.loop = true, loopStart = M·period/sr, loopEnd = loopStart + period/sr`; no fades → raw region looped (no render). Set `src.buffer` once (set-twice throws).
5. Pitch = varispeed: `detune = (pad.pitch + pitchFor(pad)) × 100` cents; `playbackRate = 2^(semis/12)`; `pitchFor = sourcePitch + fine/100` (:2533).
6. Gain envelope: `atk = max(attackFor(pad), looping ? 0 : fadeIn/playbackRate)`; `vel = velocity × normGainFor(pad)` (pad sources only); `atk>0 ? ramp 0→vel over atk : setValueAtTime(vel)`.
7. One-shot start: `src.start(t, playStart, playDur + rel × playbackRate)` (duration in buffer seconds); `realDur = playDur/playbackRate`; release: `setValueAtTime(velocity, t+realDur)` → `linearRamp 0.0001 at t+realDur+rel` (note: anchors on raw `velocity`, not NORM-scaled `vel`); one-shot fadeOut: `setValueAtTime(velocity, max(t+atk, t+realDur−fo/rate))` → `0.0001 at t+realDur`.
8. `onended` removes the voice only if it is still the map's current src. `when` (from `triggerPadAt`) schedules everything at `t = max(now, when)`.
- `stopVoice` :4737: cancel → hold current → linear ramp to 0 over 3 ms → `stop(t+4 ms)`; entry removed immediately.
- `releasePad` :4686: gate voices only: ramp to 0.0001 over `max(5 ms, release)`, stop +5 ms; voice stays registered until `onended`. Also stops the ARP when it's the hold pad.
- Retrigger of an un-gated LOOP pad while looping = stop (toggle) (:4226–4234).
- Choke: `chokeGroup(pad)` stops every voice with the same `chokeGroupOf` (or itself when 'none') (:2611–2618). `triggerPadAt` :4166 captures the previous voice and chokes via `setTimeout` at `when` (3 ms fade, stop +4 ms).
- Polyphony: one voice per pad; across pads unlimited except mute groups (default = same source chokes, different sources don't).
- Live re-stem (`restemVoice` :4547–4678): when a pad's mask/stems change mid-note, a new source starts at the same position with a 12 ms equal-gain crossfade; stretch needs the cached render first.

### 2.4 Sequencer voice path (`scheduleSeqStepAudio` :6072–6213)
Per stored step at `startAt`: late steps (stall) start now `late` s into the chop, skipped if `late ≥ stepDur − 5 ms`; pads hand-played within 120 ms while live-recording are filtered out (`lastLivePadHit`); choke timer at `startAt` stops live voices in the firing mute groups; `cutSeqTails` hard-cuts earlier tails of the same groups with a 5 ms fade (only when the new hit lands before the natural end — BPM raised); per pad: `rate = 2^(semis/12)`, `maxDur` = distance to next step where the same tail group fires (wrapping if loop) else pattern end, `bufDur = min(chopDur − late·rate, (maxDur − late)·rate)`, envelope `0 → vel over atk = clamp(attackFor, 0.5 ms, realDur−5 ms)`, then hold, `vel → 0.0001` over the final 5 ms; `src.start(startAt, startSec, bufDur)`; `detune` as live; reverse via `reversedFor`. Tail group = `chokeGroupOf` or `pad:<i>` when 'none' (:6063).

### 2.5 Gain staging summary
voice `vel` (× per-source NORM) → chopGain (`chopVolume × mainNormGain`, τ 10 ms) or route bus (`chopVolume`) → padBus → FX → masterGain (0.85) → clip (drive `1 + amount×5` into hard ceiling `10^(−0.1/20)` ≈ 0.9886, 2048-pt curve, 4× oversample :6453–6466) → limiter (−1 dB, 20:1) [live only without mixer]. NORM = `0.891/peak` (−1 dBFS) scanned over all channels (:6395–6406, 6432–6439), non-destructive.

---

## 3. CHOP WORKFLOW

- **Load** (`installMainBuffer` :2947–2999): snapshot previous sample, set `buffer = fileBuffer = decoded`, trims = [], clear stems/masks, stop seq & pads, `autoChop(1, detectSilenceEnd())` (RMS threshold 0.015 over 256-frame windows :3001), emit; then after a tick: broadband + drum transient detection; then `estimateBPMAsync` (bpmDetect.ts: tempogram, HOP 1024/FRAME 2048, first 60 s, comb weights [1,.7,.5,.4], coarse 60–200 then ±2 BPM at 0.1, fold to 75..165, integer result; 0 if <8 s). `bpm>0` → `bpm`, `targetBpm`, and `metronomeBpm` only if it was 0 or 120.
- **Chop-while-playing** (`_doTrigger` :4205 → `sliceAtCurrentPosition` :3817–3876): an empty-pad tap while any voice rings = chop. The playing pad is `lastTriggeredPad` if ringing else first voice. Pad-source playing → `pos = getPlaybackPos() + chopOffsetMs/1000`, `snapInBuffer` (that buffer's own transients), `chopPadSourceTo(playingPad, pos, target)` (refused within 10 ms of edges → `onNote`). Main → `pos += chopOffsetMs/1000`, `applySnap`, find containing chop, require ≥10 ms each side, new chop `[pos, src.end)`, `src.end = pos`, spliced after; target pad gets it, inherits the source pad's stem mask and group; `lastSlicedChopId` set.
- **Empty-chop recovery** (:4213–4222): no chops + main buffer + no pad sources → `autoChop(1)` and replay pad 0; with pad sources present, an empty-pad tap with nothing playing does nothing.
- **Snap** (`applySnap` :3543): off → as-is; transient → nearest of the 3 candidates around the binary-search insertion within 0.25 s window (:3585); 1/4,1/8,1/16 → `step = (60/bpm)(4/div)`, anchor = first drum transient (else first broadband, else 0) folded into [0, beat) (:3558–3581), falling back to transient when bpm = 0. UI only toggles off↔transient (ChopperView:4053); drag preview snaps in WaveformView (mirror of snapToTransient), Shift = free move.
- **Transient detectors**: broadband :3728–3774 (HOP 256/FRAME 512, mono mean-square energy, half-wave flux, threshold mean + 0.1σ, local max `> prev && >= next`, min gap 30 ms); drum-only :3606–3713 (one-pole LP 200 Hz kick band, HP by subtraction at 1500 Hz, per-band flux, thr mean + 0.5σ, min gap 50 ms, kick needs `eLow/eHigh > 0.4`, snare needs `> 0.15`, merged/deduped keeping the stronger). `transientsFor(buffer)` caches per pad-source buffer (:3518–3527). `acDrumsOnly` swaps the active set.
- **Auto-slice by transient** (`autoSliceTransients` :3119–3183): `wantCount = round(effMax × sens^0.7)`, `effMax = min(N, web 256 / desktop ∞)`; strongest `wantCount` by strength, re-sorted by time; boundaries `[0,…cuts…,dur]`, slivers < 20 ms dropped; pad count = chop count; stem masks carry over from the old chop each new start falls in. **Not reachable from the current UI** (no callers of `autoSliceTransients/setTransientSensitivity/toggleAcDrumsOnly` in `src/`; only a stale dist bundle). `autoChop(n, startOffset)` :3057 = equal division; main block placed via `rearrange`/`insertPushing` pushing pad-source blocks right.
- **Zero-crossing**: none. Click suppression relies on the 3 ms default attack, 3 ms stop ramps, 5 ms sequencer fades, 3 ms trim seam ramps (`SEAM_FADE_SEC`, trimRegions.ts:43).
- **Boundary edits**: `setChopBoundary(id, side, v, freeMove)` :3456 — coalesced undo, clamp to buffer, snap unless freeMove; free chops move alone; chain chops move the shared boundary with the neighbour (min 10 ms), neighbours that are `free` don't couple. `adjustChopBoundary(delta)` free. `stepChopBoundaryToTransient` EPS 1e-3. Keyboard (ChopperView:4270–4307): ←/→ step start to prev/next transient (fallback nudge `viewSpan×dur×0.002`), Shift = fine `×0.0005`; pad-source pads nudge their trim start. START/END knobs (MIDI-mappable `chop.start/chop.end`) ranges clipped to the chop's window and the visible view (ChopperView:5246–5312). `[`/`]` pad pitch ±0.5 st (Shift ±0.1).
- **Double-click / tap slice**: WaveformView dblclick or a no-drag tap → `onSliceTime(t)`; main: `padIdx = nextSlotForSource('main')` (refused if taken), `slicePlayheadAt(padIdx)` if something plays else `sliceAtTime(t, padIdx)` (ChopperView:5360–5363; `sliceAtTime` :3790 snaps, 10 ms min). Pad-source view: `chopPadSource(hit.padIdx, [t])` (:5335). `\` key = `slicePlayheadAt(findNextEmptyPad())`.
- **RESET / DEL ALL / NEW**: RESET = `autoChop(1)` (main) or `resetPadSource` (pad source: lowest pad keeps whole audio, others emptied :2594); DEL ALL = `clearAllChops` :3017 (main chops only, pad sources stay; mobile HardwareView); NEW = `clearAll` :3033.
- **TRIM (section cut)** `addTrim(t0,t1)` :2108: effective-time span ≥ 20 ms and < whole; chops after slide, straddling chops clipped (inside part rides the trim under the same id), inside chops swallowed with their pad/mask; transients cut; `rebuildEffective` = `buildEffectiveBuffer(fileBuffer, trims)` (kept ranges concatenated, 3 ms seam ramps), caches flushed, stems re-cut. `restoreTrims` :2161 maps everything back to file time and re-seats swallowed chops on their old pad if empty else `nextSlotForSource('main')`.
- **Per-pad samples vs main chops**: `padBuffers` wins in `startVoice`/`resolvePadSource`; `loadPadBuffer(idx, buf, videoId, title, start?, end?)` (undoable, drops pad route override on source change, `ensureSourceRoute`); `setPadTrim` clamps to ≥10 ms; `removePadBuffer`, `unassignPad` (non-destructive), `clearPad` (splices main chop and merges region into previous chop, or next if first; shared chopIds and free chops are not merged) :3988–4036.
- **SOURCES/BLOCKS** (:1303–1561): `blockRange`, `nextSlotForSource` (after its block else first empty), `roomAfterBlock` (free slots after block, scan ≤64), `chopPadSource(pad, times)` (returns −1 if not enough room — never pushes), `chopPadSourceTo(pad, time, target)` (pushes), `autoChopPadSource(pad, n|'transients')`, `moveBlock` (Julienne-style push-aside; singles swap via `movePad`), `planMoveBlock` (dry run for the ghost preview), `makeRoomAt`, `clearBlock`. Every rearrangement remaps sequencer step references (`rearrange` :1480–1510, `movePad` :1226).
- **Pad clipboard** (padClipboard.ts): `PadContent` (chop entries remember their region; `reviveChop` resurrects a cleared chop as `free`), `PAD_GRID_MAX = 64`, `copyPads`, `cutPads` (unassign, never clearPad), `pastePads` (consecutive from `at`, one undo batch, cap at lock/64), `duplicatePads` (clone chop per copy via `cloneChop` → `free`), `clearPads` back-to-front. `setPadSlot` always rewrites pitch/mode/gate/fades/stems/reverse.
- **Groups/strips/mute groups**: `setPadGroup(s)` ('new' → `grp:N` seeded with the clicked pad's route + fx), `duplicatePadToNewGroup`, `setPadRoute(s)` ('new' → `sampleN`; picking a whole group sets `sourceRoutes`; picking the default drops the override), `setPadChoke(s)` ('new' → `grpN`, 'none' = poly). UI (PadGrid □/right-click menu) exposes all of these plus Stems per pad, LOOP, NOTE ON, Move/Move to empty, Resample, Make main track, Clear/Clear block.
- **Per-source REV/ATTACK/PITCH/FINE**: `toggleSourceReverse(key)` (main → `toggleReverseSample`), `setSourceAttack` 0..0.5, `setSourcePitch` ±24, `setSourceFine` ±50 ¢; per-pad override `setPadsReverse([..], bool|null)` — asking for the source's current direction clears the override; `togglePadsReverse` flips all to `!reversedFor(first)`.

---

## 4. ARP · METRONOME · TRANSPORT

- **Tempo precedence** (`getMasterBpm`/`seqTempo`/`arpTempo` :548–553, 5414, 4793): `metronomeBpm > 0 ? metronomeBpm : bpm > 0 ? bpm : 120`. Sources that set `metronomeBpm`: BPM field/drag (MIDI-mappable `master.bpm` 20..300), tap tempo (desktop `TapTempoButton`, web TAP-armed pads; "resets after 2 s of no taps"), MIDI clock follower (ChopperView:1893), preset load, detected BPM on load only if 0/120.
- **ARP** (:4773–4844): `triggerPad` → `startArp(pad, vel)` when `arpEnabled`; `arpFire`: random pad / up `(hold + step) mod n` / down `(hold − step) mod n`; fires via `_doTrigger`; `interval = 60 / arpTempo / arpRate`; drift-free `target = start + step × interval` with `setTimeout`; `releasePad(hold)` stops. **Not exposed in the current UI** (no callers of `toggleArp/setArpRate/...` in src).
- **Metronome** (:4868–5065): flag + sound; clicks only while `seqPlaying && !seqPaused` (or `drumMetronomeActive`), gated off during count-in; beat = `60/metronomeBpm`, accent on beat 0 of 4; look-ahead scheduler (Worker tick 25 ms, horizon `metroLook` 0.25 s / 0.5 s boosted 6 s after a late tick); beats older than 50 ms are skipped not bursted; sounds: click (osc 1400/900 Hz, 60 ms), hihat (noise HPF 9k/7k), rimshot (BPF 1200 Q.5 noise + 200 Hz sine), kick (180/140→40 Hz, 300 ms), clap (3 bursts 0/8/16 ms, BPF 1800). Toggling METRO mid-play phase-locks to the loop anchor.
- **Count-in** (`scheduleCountIn` :5827): `countInBeats` (4) clicks at `seqTempo`, first at `now + 0.12`, first accented, visual `countInBeat N..1`, downbeat callback at `downbeat − 0.02`; hits during the count-in are kept (`earlyHits`, max 32) and those within half a grid step before the "1" land on step 0.
- **Transport** (`playSeq` :5891): stop (with `seqRestarting` so satellites keep REC), anchor `seqPlayStart = now + 0.02` (`TRANSPORT_LEAD_S`), prime the scheduler synchronously, start Worker clock (`SEQ_INTERVAL` 25 ms, `seqLook` 0.25/0.5 s), fire `seqStartHook(anchor)` (drums/bass phase-lock). `stopSeq` :6288 clears timers/scheduled sources/tails, disarms live record, fires stop hook, stops metronome. `pauseSeq/resumeSeq` freeze `seqPausedElapsed` and re-anchor. Queued sequence switch at loop boundary; non-loop patterns stop at `seqStopAt`. Step duration `(60/tempo)(4/resolution)`, re-read per step so tempo changes land within one step.
- **Live record** (`startLiveRecord` :5778): arms (with count-in unless already playing or count-in disabled); `liveLanding(elapsed, stepDur, stride, strength)` (:540–548): `line = round(elapsed/gridDur)·gridDur`, `corrected = elapsed + s·(line − elapsed)`, snapped to nearest stored step — sound time == written time. INPUT Q < 100 refits storage to 192/bar (`ensureRecordStorage`). Early hits are scheduled on their line via `triggerPadAt`; late ones sound now; GATE pads and ARP stay live. Step record (`startRecordingSeq`): each hit fills the next empty COLUMN, wraps.
- **Swing**: `setSeqSwing(0..1)` mirrored from the drum SWING knob (ChopperView:1700); `swingOffsetSec` (swing.ts) pushes odd 16ths late by `swing × half-16th`, snapped toward 96-PPQ pulses. **Applied only in `patternToEvents` (exports/arranger, :6858) — the live step scheduler (:6230–6286) applies no swing offset.**

---

## 5. RECORD SAMPLE / RESAMPLE

- Constraints (`recordAudioConstraints` recordConstraints.ts:16–26): `echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:{ideal:2}`, `deviceId:{exact}` when picked, `sampleRate:{ideal: engine rate}` when known. `describeRecordTrack` reports "48 kHz · stereo · raw" or flags forced processing.
- Desktop panel (ChopperView:3266–3565): inputs = `enumerateDevices` audioinput (minus 'default'), plus `DEFAULT_INPUT_ID`, `SYSTEM_AUDIO_ID` (Electron loopback via `getDisplayMedia`, not on Mac), `INTERNAL_OUTPUT_ID` (taps `mixerEngine.master.output ?? engine.outputNode` into a `MediaStreamDestination` — Terminator's own output; nothing routed back, no feedback). Capture: `MediaRecorder` preferring `audio/webm;codecs=pcm` → `audio/webm` → `audio/mp4`; meter = listen-only AnalyserNode (fftSize 512) in a separate AudioContext — **no monitoring path**. Stop → decode → `encodeWAV(decoded, 24)` (24-bit PCM) → saved to the Sample Library RECORDINGS (`libraryBridge.saveRecording`) → loaded onto the aimed pad (RECORD INTO) else the first pad with no source (`while (engine.padSourceKey(i)) i++`) — never the main track. File `recording-YYYYMMDD-HHMMSS.wav` / `resample-…` for the internal tap.
- Mobile/web hook (`useSampleRecorder.ts`): same constraints/mime chain, `exact` device with fallback to default, 24-bit WAV, iOS device labels only after first permission, `devicechange` refresh.
- RESAMPLE a pad (`padRenderPlan` :1616 / `renderPadAsPlayed` :1626): plan = stem-resolved slice, `detuneCents = (pad.pitch + pitchFor)×100`, `reversedFor`, `attackFor`; offline render `rate = 2^(cents/1200)`, `outFrames = ceil(srcDur/rate × sr)`, attack ramp, reverse from the mirrored buffer, dry (no strip/limiter); the view stores it as a FLAC asset on the next empty pad (ChopperView:3154–3165).

---

## 6. EXPORT (engine)

- `exportChops(bitDepth=24)` :7119 → every pad with a source → `renderChopThroughMaster(chop, pitch, bitDepth, buffer)`: with mixer: dry pitched slice (detune = pad + source pitch + fine) → `mixer.renderWithMixerFX(dry,'sample')` → `applySafetyLimiter` (−1 dB/20:1; renders +latency frames and cuts the look-ahead off the head) → WAV; legacy: `buildOfflineChain` + tail `max(0.3, reverbDecay if reverbMix>0)`. Note: no attack envelope, fades, or per-pad NORM applied here; name `<title>_<bpm>BPM_padNN`.
- `exportSeq / exportSequences / exportMaster` :6786–6839 → `patternToEvents` (swing applied, per-group note length, `reversedFor`, velocity) → `renderEventsToWav(events, dur+0.5, sr, bitDepth)`: mixer attached → one dry render per route (`renderArrangementChopSource`: 'sample' route through the internal chain **with masterClip**, other routes dry) → `mixer.renderChannelPostOffline` → `mixer.renderMasterBusOffline`; no mixer → `buildOfflineChain(withMasterClip:false)` + internal limiter, voices → chopGain(`chopVolume × normalizeGain`). Offline voice = `scheduleOfflineChop` :6882 (same math as the sequencer: varispeed budget, 0.5 ms..(realDur−5 ms) attack from the waveform bar, 5 ms end fade, reverse from mirrored buffer). Sample rate = main buffer's rate (or ctx rate).
- `renderArrangementMix` :6973 (Beat Finisher/arranger): chops + drum hits (`applyDrumAttack`, `DRUM_CHOKE_S` chain choke per buffer, mute-group cuts, pan) + bass buffer through `buildOfflineChain` (with clip), default 16-bit.
- `buildOfflineChain` :7143 clones filter/EQ/comp(+dry-delay)/delay/reverb/masterGain/[clip]/[limiter unless mixer attached] from `masterState`.
- `exportOriginal` :6778 raw buffer. WAV encoder (StemExporter.ts:12–80): 8/16/24/32; 16-bit = TPDF dither (two xorshift32 streams) + round; 24-bit = round-to-nearest; 32 = IEEE float. FLAC (`encodeFLAC`, 16/24) is chosen at the exporters layer only for `master-wav` and `wav-stems` (exporters/index.ts:55); PCM inside FLAC == WAV's (test:export-flac).
- "Mono cut" = the sequencer's same-mute-group cut (5 ms fade) — there is no separate mono-cut option.

---

## 7. SERIALIZATION

`ChopPreset` (:59–147) produced by `getPresetData(videoId)` :3185; the view adds `sourceStems`, `drums`, `bass`, `mixer` and wraps `withAssetManifest` (ChopperView:2084–2090). No schema version field (only `savedAt` ISO). Keys: `videoId` (`'none'` = `NO_SAMPLE_ID` for a kit without main track), `name?`, `trackTitle?`, `chops[{id,start,end,free?}]`, `pads[{index,chopId,mode,pitch,gate?,fadeIn?,fadeOut?,stems?,reverse?}]`, `padBufferMeta{idx→{videoId,title,start,end}}`, `sourceRoutes`, `padGroups`, `padRoutes`, `nextSampleTrack`, `padChoke`, `nextChokeGroup`, `sourceFx`, `bpm`, `nextChopId`, legacy `timeline/timelineLength/seqBars/seqResolution/seqGrid/seqLoop`, `sequences[]`, `currentSeqIdx`, `normalize`, `normalizeGain`, `sourceNorm`, `master`, `extraFX`, `masterClip`, `stretchEnabled`, `targetBpm`, `chopOffsetMs`, `reverseSample`, `chopVolume`, `metronomeBpm`, `inputQuantize`, `drums`, `bass`, `mixer`, `trims?`, `stems?{quality,assets,readyRanges}`, `sourceStems?`.
`loadPreset` :3242 back-compat: bails only if no buffer AND no pad meta/sequences; re-applies trims first; legacy single-pattern fields when `sequences` absent; resolution accepted if in `SEQ_RESOLUTIONS` or divides 384 else 16; `viewResolution` must divide resolution; masks via `normalizeMask`; `nextGroupNo/nextSampleTrack/nextChokeGroup` recomputed ≥ any used number; `inputQuantize` migrates from `drums._inputQuantize`; `compStyle` must be set before `compMix`; `metronomeBpm`/`chopVolume` re-applied by the view even when audio fails. Pad samples are restored by the view (`restorePadSamples`, `local_` ids = missing). Files: `.tproj` = JSON; `.tprojz` = stored zip `{project.json, manifest.json {version:1, app:'terminator', assets[{hash,name,mime,bytes}]}, samples/<sha1>.<ext>}`, asset ids `asset:<sha1>` (projectAssets.ts).

---

## 8. TESTS / HARNESSES (golden gates for the port)

Harness: `vite.harness.config.mts` bundles `scripts/*.test.mts` to `scripts/logic/.harness/*.mjs` (node22 ESM); engine tests run on `scripts/fake-web-audio.mts` (Proxy AudioNodes, real Float32 buffers, `tone()`/`settle()`); `npm run test:<name>`.

| Script | Asserts |
|---|---|
| `test:chop-while-playing` | A: zero main chops + link on pad → hit link, hit empty pad splits the link at the playhead (~0.5 s) onto that pad, main not resurrected; B: main chop-while-playing → 2 chops, cut at playhead; C: nothing playing → empty tap changes nothing; D: pad-source split with main chops present |
| `test:chop-seq-standalone` | PLAY with nothing loaded no-ops; PLAY/STOP/live REC work from pad samples alone; `resolvePadSource` == `bufferForPadSource` through a source stem mask; velocity 1 default, `setSeqStepVelocity` 0.5, floor 0.05, carried by events, by `moveSeqNote`, by preset round-trip; swing leaves downbeat, pushes odd 16th late, 32nd inside an odd 16th shifts with it; `exportSeq/exportMaster` render without a main track |
| `test:input-q` | `liveLanding`: Q100 on line, Q0 within half a stored step, Q50 halfway, monotonic, `at == step×stepDur`; different divisions land differently; degenerate inputs; DrumEngine reads the same global fader with SHIFT residuals |
| `test:pad-loop` | `renderCrossfadeLoop`: no fades → period n, raw; seams ≤ 1.5× natural step, first sample silent, period = n − min(fo, n−64), length = (ceil(n/P)+1)·P, steady RMS ≈ one pass |
| `test:pad-reverse` | per-pad override vs source REV semantics, `patternToEvents` carries `reverse`, preset round-trip, undo |
| `test:norm` | per-source NORM key `src:<videoId>`, gain 0.891/peak on the voice, main NORM independent, preset round-trip |
| `test:resample-pad` | `padRenderPlan` for main chops/pad sources: slice, cents, reverse, attack, stem slice |
| `test:waveform-live` | `setWaveformLive(true)` keeps the same composite buffer across mid-drag commits; release rebuilds once |
| `test:export-flac` | FLAC_CAPABLE set; fLaC header; PCM bit-identical to 16-bit WAV (same TPDF PRNG) |
| `test:record-constraints` | raw constraints, ideal stereo/rate, exact device, describe string |
| `test:stem-mask` / `test:stems-key` / `test:stems-lazy` / `test:stems-progress` | mask bit math & ready ranges; content-hash key; lazy decode contract (original plays until decoded, decode kicked once); progress estimator |
| `test:flac` | FLAC encoder correctness |
| `test:midi-clock` / `test:midi-clock-in` | 24 PPQN sender booking/stall behaviour; follower BPM estimate + one-port lock |
| `test:peak-meter` | meter worklet vs reference window |
| `test:drum-timing`, `drum-oneshot`, `drum-transport`, `drum-mutegroups` | DrumEngine (satellite) timing/choke/transport |
| `test:console`, `test:bass-*`, `test:qs-slices`, `test:logic-*` | console worklet, bass engine, MPC/Quick Sampler and Logic exporters (not chopper core) |

---

## 9. WEB-AUDIO / ELECTRON LIMITATIONS WORKED AROUND

- Constructor-only audio prefs (rate/buffer) read synchronously; Safari `outputLatency` 0 → 20 ms estimate; `baseLatency` never added to a measured `outputLatency`.
- Context suspension/`interrupted` on iOS → resume on visibility/pageshow/statechange; audio only inside a user gesture → `triggerPad` resumes and replays; output endpoint pinning → `setSinkId` null-sink re-open on `devicechange`.
- `AudioBufferSourceNode.buffer` set-once; `start()` throws on bad offsets (guarded with disconnect); `onended` needed to prune nodes (scheduledSources self-prune).
- DynamicsCompressor hidden ~6 ms look-ahead (measured per rate) — dry-leg delay, export head trim, limiter removed when the mixer has one; WaveShaper 4× oversample latency (measured, `oversampleLatencySec`); clipper oversample only when active.
- Main-thread timers throttled → Worker clock + adaptive look-ahead; full-state emit coalesced per rAF, activity channel separate (12–46 ms renders made MIDI late).
- Stereo-centric: stem slices/composites `min(2, channels)`, stretch slices forced to 2 ch, offline contexts 2 ch, loop render preserves channel count.
- Memory: 128 MB stretch LRU (iOS tab-kill), 2 undo samples, stem slice cache 96, lazy stem decode (~140 MB saved), `rendered = null` after export.
- SoundTouch lazily imported (first stretched hit may play dry); web caps auto-slice at 256 pads; MediaRecorder container differs per platform (decode then re-encode); system-audio capture needs Electron loopback (unavailable on Mac).
- No TODO/FIXME comments in the engine (grep empty); the comments are incident notes (dates) explaining each guard.

---

## 10. SUBTLE BEHAVIOURS — easy to get wrong

1. **Chop position = un-led playhead + chopOffset, then snap**; the drawn dot is +16 ms. Both share `getPlaybackPos` (the voice of `lastTriggeredPad`).
2. **`playDur` is buffer seconds, envelopes are real seconds** (÷ playbackRate); release anchors use raw `velocity`, attack uses NORM-scaled `vel`.
3. **Mute groups default to source identity**; 'none' still chokes itself; sequencer tail groups use `pad:<i>` for polyphonic pads; `grp:N` (group) vs `grpN` (custom mute group) are different key formats.
4. **A new main track keeps pad sources and pushes them right**; `loadPreset` clears pad sources (restored by the view); empty-pad tap never resurrects the main track once pad sources exist.
5. **REV is baked into buffers** (mirrored copy + `duration − end` offset); a ringing voice keeps its direction; pad override clears itself when it equals the source's direction.
6. **Swing applies only to exports/patternToEvents, not the live chop-seq scheduler**; live drums do swing.
7. **Stretch never computes on the hit path** (cache miss plays dry, warms async); `|ratio−1| ≤ 0.005` = no stretch; stretched buffers are keyed by buffer identity token (stems).
8. **Stems**: masked pads play the ORIGINAL until the span is ready/decoded (never silence); slices are chop-length in their own coordinates (`posOffset`); waveform composite is patched in place; drawing/masking kicks lazy decode.
9. **Route buses are dry and carry `chopVolume` only** (`applyChopGain`) but are created with `chopVolume × normalizeGain` (:2427) — a transient inconsistency until the next `applyChopGain`; main NORM lives on chopGain, per-source NORM on the voice.
10. **Clicks and the metronome bypass the mixer**; the internal limiter leaves the live path when a mixer is attached (exports mirror it).
11. **Sequencer one-owner rule**: a hand-played pad within 120 ms of its scheduled step suppresses the pattern's copy; INPUT Q < 100 silently refits storage to 1/192; a grid change is a lossless refit (lcm/gcd), never moves notes.
12. **`free` chops** (duplicates/revived) are decoupled from the chain: drags don't couple, clears don't merge, waveform draws their end handles.
13. **Chop pushing rules**: chopping a source needs empty pads right after its block (returns −1, never pushes); `chopPadSourceTo` and `moveBlock` DO push; singles swap.
14. **Tempo**: `metronomeBpm` wins over detected `bpm`; detected BPM only seeds it when it is 0/120; `setMetronomeBpm` needs no re-anchor (per-step stepDur).
15. **Trims**: chops/transients/stems live in effective time, the trim list and swallowed chops in file time; `effToFile(t, end=true)` picks the before-side of a seam.
16. **Undo batches** (paste/dup/move/clearBlock) collapse to one step; drag gestures coalesce within 500 ms by group key; the drum engine's state rides every chop snapshot.
17. Unwired-but-present engine features (ARP, transient auto-slice knob, drum-only detector toggle, `setSelectedChopStart`, `toggleChopMode`) exist and are tested/serialized-adjacent; decide explicitly whether the native build exposes them.