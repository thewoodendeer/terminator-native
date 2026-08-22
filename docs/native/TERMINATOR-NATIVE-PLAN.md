# TERMINATOR NATIVE — the build plan

*Written 2026-08-22 from a full read of the Electron/web codebase (six section dossiers in `docs/native/dossier-*.md`). Victor's brief: rebuild Terminator as a native, flagship DAW for Mac (Intel + Apple Silicon) and Windows — lowest latency, multi-channel interface I/O, VST/AU plugins, interface recording, locked sequencing, MIDI clock in/out, stems — "everything Ableton does natively", flawless, no matter how long it takes. **Kept separate from the Electron build** (his 2026-08-22 call): new repo, new release channel; the Electron/web app keeps shipping untouched.*

## How to read this
- **Part A** — the decisions (stack, process model, UI strategy, what native buys, the parity contract).
- **Part B** — every section of Terminator: what it does TODAY (from the code, with the subtle behaviours that must survive), the native design, what gets BETTER, and the tests that prove it.
- **Part C** — the build, phase by phase, with gates and Victor's pass per phase; testing strategy; risks; open questions.
- Numbers, ranges, formulas and file:line references live in the six dossiers — this plan points at them instead of repeating 140 KB of tables. When the plan and a dossier disagree, the dossier (read from code) wins; when a dossier and the code disagree, the code wins.

## The one-paragraph version
Keep the face, replace the heart. The React UI (the months of visual/UX tuning, themes, help, tooltips, 4K finish, keyboard map) is copied into a new repo and rendered by JUCE 9's native WebView on Mac/Windows; every audio, MIDI, timing, file and device responsibility moves into a C++20 engine library (`libterminator`) built on JUCE: CoreAudio/ASIO/WASAPI with N×N channel routing, ~2–3 ms round trip, one sample-accurate transport that all sequencers render into, VST3/AU hosting with PDC, float recording with monitoring and calibrated offset, ONNX Runtime stems in-process, exports that are the same code path as playback. Every behaviour a producer can hear or rely on today is listed and carried over; the existing ~60 test gates become C++ gates plus golden renders against the current engine. Phases 0–9 take it from an empty repo to a signed, auto-updating 3.0 that opens every existing project; Phase 10 (B11) is the DAW roadmap beyond parity (audio tracks, automation, Link, sandboxed plugins, iOS sharing the engine).

## Scope
- IN: the Chopper (Terminator) desktop app — pads/chops/sources, waveform, sequencer, drums, bass, mixer/FX/console, recording, stems, MIDI, exports, projects/library, Finish Him arranger, preferences, help/themes, licensing.
- OUT (stay in the Electron repo): MPC Extractor, The Board / Producer Sim, the web/mobile HardwareView build (it keeps the Web Audio engine; the `EngineClient` interface is designed so it CAN adopt the same UI contract later).
- Platforms: macOS 12+ universal (arm64 + x86_64), Windows 10 21H2+ x64. Windows ARM64 and iOS later.

---
# PART A — THE DECISIONS

## A0. Separate build (Victor, 2026-08-22: "keep this build separate from the Electron build")
- New repo `terminator-native` (private GitHub, linear commits on `main`), its own version line (starts 3.0.0-alpha), its own R2 prefix `terminator-native/` and updater feeds, its own entry on the KCC site when it ships. Nothing in `terminator` (Electron/web) changes for this project except: this plan + the six dossiers checked into `docs/native/` as the reference, and (later) a one-line "Terminator 3 native is available" link.
- The React UI is COPIED into the new repo (`ui/`), not shared live — the two UIs are allowed to drift; the Electron app is frozen-in-time for features once native reaches Phase 3, and retired when native reaches Phase 9 (product call, see open questions).
- Shared on disk by both apps on the same machine (read-compatible, by design): projects dir + `assets/` store, `~/Music/Terminator` library, stems model cache, settings imported once.


## A1. Why native, in one paragraph
Everything Victor hit this week that was a *platform* wall (not a bug) lives below the UI: Web Audio is
hard-wired to 2-in/2-out, its latency floor is ~10–20 ms round trip, it cannot host AU/VST, it cannot pick
a specific interface input channel, cannot do exclusive/ASIO mode on Windows, and every sequencer in the
app runs off JS timers + absolute-scheduled buffer sources instead of one sample-accurate transport. A
native engine removes all of that in one move. The UI was never the problem.

## A2. Stack decision
| Layer | Choice | Why |
|---|---|---|
| Language | C++20 | Only option that gives CoreAudio+ASIO+WASAPI, VST3/AU hosting, and Mac+Windows from ONE codebase. Swift = Mac-only (Windows lost). Rust = plugin hosting immature. |
| Framework | JUCE 9.0.1 (pricing unchanged from 8: **Starter FREE** ≤ $20k revenue — we build the whole thing on it; Indie $40/mo or $800 perpetual ≤ $300k) | Device layer for every OS, VST3/AU/LV2 hosting, MIDI, universal-binary builds, notarisation hooks, and the JUCE 9 WebView↔C++ bridge (`WebBrowserComponent` + `withNativeFunction` / relays, **plus JUCE 9's official TypeScript npm package for WebView integration** — our `EngineClient` bridge is exactly its use case) that lets the existing React UI drive the native engine. |
| Build | CMake + Ninja (brew install ninja), JUCE 9.0.1 via FetchContent pinned to the tag (nothing downloaded by hand; the osx zip is only the Projucer GUI, unused) | Same CMake on Mac/Win; GitHub Actions builds both (macos-14 arm64 + **macos-15-intel** for the Intel leg — GitHub retired macos-13 — plus windows-latest). |
| Mac targets | Universal binary (arm64 + x86_64), macOS 12+ | One .dmg, Intel + Apple Silicon. Intel slice tested on macos-13 CI runner + `arch -x86_64` under Rosetta locally. |
| Windows targets | x64, Windows 10 21H2+ (WebView2 Evergreen runtime preinstalled on Win10/11) | ASIO (Steinberg ASIO SDK, free download, cannot be redistributed in-repo — fetched in CI) + WASAPI exclusive/shared. ARM64 Windows = later. |
| Time-stretch | Signalsmith Stretch (MIT, header-only) | Better than SoundTouch, real-time capable, no GPL/commercial cost (Rubber Band is GPL+paid). Varispeed mode stays as plain resampling. |
| Resampling | r8brain-free (MIT) or libsamplerate (BSD) | Removes the 44.1k assumption: library audio at any rate, engine runs at the DEVICE rate. |
| Stems | ONNX Runtime C/C++ API in-process, same htdemucs ONNX models; CPU EP first; CoreML / WebGPU-plugin / DirectML EPs measured per platform against the SNR gate already used today | No child process, no IPC race, background queue, direct float buffers. |
| Tests | Catch2 + golden-render WAV comparisons + RTSan (Homebrew LLVM 20+ toolchain for CI/debug) + the existing TS harness contracts rewritten as C++ gates | “Export = what you hear” and sample-exact timing proven by machine before Victor's ear. |
| Updater | Sparkle (Mac) + WinSparkle (Win), feeds on the same R2 bucket under a NEW prefix | electron-updater's yml format goes away; same “binaries first, feed last” discipline. |
| Telemetry/crash | Crashpad/Breakpad via Sentry-native (optional) | A DAW that crashes silently cannot be fixed; opt-in. |
| Plugins | VST3 + AU (Mac) in v1; CLAP via clap-wrapper hosting later; out-of-process scanning from day one; out-of-process (sandboxed) plugin HOSTING = later phase | Crash-proof scan is cheap; sandboxed hosting (Bitwig-style) is a big lift, schedule it, don't pretend it's free. |
| Link | Ableton Link — GPLv2 OR free proprietary licence by emailing Ableton | Optional phase; not v1. |

## A3. Process / thread model
- **One app process** (JUCE). Threads: UI/message thread · audio callback thread (RT) · MIDI input thread (OS) ·
  loader/disk-streaming thread · analysis thread (transients/BPM/waveform peaks) · stems worker thread(s) ·
  export/render thread (runs the SAME engine offline, faster than real time) · network/yt-dlp child process.
- **RT rules (non-negotiable, enforced by RTSan + `[[clang::nonblocking]]`):** no malloc/free, no locks, no
  I/O, no std::string, no exceptions on the audio thread. UI→engine = lock-free command FIFO (SPSC/MPSC ring);
  engine→UI = lock-free state snapshots + meter/playhead FIFO drained on a 60 Hz UI timer. Voice pools,
  event buffers, plugin buffers preallocated at prepare().
- **Engine core = a UI-free static library (`libterminator`)** with a C++ API and a JSON/flatbuffer command
  protocol on top. The JUCE shell, the test binary, and the offline renderer all link the same library. Nothing
  in the engine knows about React, JUCE GUI, or files on disk (loader hands it buffers).
- **Plugin isolation**: scanning happens in a child process (a crashing plugin cannot take the app down during
  scan; known-bad list persisted). Hosting in-process for v1 (Ableton/FL/Logic parity), sandboxed hosting later.

## A4. UI strategy — the one real choice
Two viable routes; recommendation is **B for v1**, with A kept open per-section later.

- **A. Native JUCE UI.** Rewrite ~26k lines of React/CSS (ChopperView, PadGrid, WaveformView, HardwareView,
  Mixer, Drums, Bass, Help, themes, the 4K finish) in C++ Components/OpenGL. Pros: no web runtime, smallest
  memory. Cons: months of pure UI work, the hand-tuned look is re-authored by eye, the web/mobile app diverges
  permanently (two UIs), every feature built twice forever (the exact cost the 2026-08-22 analysis warned about).
- **B. Same face, native heart.** Keep the React UI, render it in JUCE 8's WebView (WKWebView on Mac, WebView2
  on Windows — OS-provided, no Chromium bundle), and replace `ChopperEngine.ts` behind an `EngineClient`
  interface. Desktop binds that interface to the C++ engine over the JUCE bridge; web/mobile bind it to the
  existing Web Audio engine. Plugin editors open as native JUCE windows. Exporters that are pure data
  transforms (.xpj/.als/.adg/MIDI/zip/Logic/FL) stay TypeScript and run on rendered buffers handed back by the
  engine. Pros: weeks not months of UI work, one UI codebase for desktop+web+phone (parity kept), the months
  of visual tuning preserved, every dossier behaviour preserved where it lives today. Cons: a bridge to
  design well (typed, versioned, batched), WKWebView/WebView2 quirks, native-feeling menus/dialogs/drag-drop go
  through the bridge.
- What B does NOT cost: latency (audio never touches the web view), multi-channel I/O, plugins, timing,
  recording — all of those live in the engine. The UI frame rate is the same 60/120 Hz canvas it is today.
- Decision rule: build B. After the engine is done, if profiling shows a screen that the web view genuinely
  cannot render well (unlikely — waveform + meters are already canvas at 60 fps), rebuild THAT screen natively.

## A5. What “even better” means per pillar (the native dividends)
1. **I/O**: any interface, any channel count, per-strip output routing (outs 3–8…), per-track input pick,
   aggregate devices, sample rates 44.1–192k, buffer 32–2048, ASIO/WASAPI-exclusive on Windows, CoreAudio on
   Mac, hot-plug device switching without stopping the app, measured round-trip latency calibration (loopback
   ping) replacing the TRIM guesswork, automatic recording offset compensation.
2. **Latency**: ≈1.5–3 ms round trip at 64 samples/48k on a real interface; MIDI→sound = MIDI timestamp
   → next block, sub-buffer accurate; finger-drumming feels like an MPC.
3. **Timing**: ONE sample-accurate transport; every sequencer (chop seq, drums, bass, arp, arranger,
   metronome, MIDI clock out) renders events into the audio block with sample offsets; swing/velocity/
   resolution semantics preserved; MIDI clock IN via a PLL (no 2× bugs), clock OUT at 24 ppqn with
   timestamped packets; tempo map ready for automation.
4. **Plugins**: VST3/AU instruments + effects on any strip, PDC, sidechain to plugins, state in project, MIDI
   learn on plugin params, crash-safe scanning.
5. **Recording**: multi-input, monitoring with zero-latency direct option, punch/count-in/takes, 24-bit/32f
   WAV, resample-own-output with exact alignment, REC-to-next-empty-pad kept.
6. **Export = what you hear** by construction (offline render runs the same engine), fixes the drum
   per-step-graph export gap.
7. **Stems** in-process with a background queue, split-on-load, GPU EPs measured per platform, no IPC race.
8. **Terminator becomes a plugin too**: the same engine compiles as VST3/AU/AUv3, so Terminator runs inside Ableton/FL/Logic — a second product from one codebase (Phase 11).
9. **App**: ~1 s launch, ~1/4 the memory, universal binary, native menus/dialogs/drag-drop/file associations
   (.tprojz), Sparkle updates, signed+notarised, Mac App Store possible later.

## A6. Parity contract (what must NOT change)
- Every user-visible behaviour in the dossiers unless a section explicitly says “CHANGED (better)”.
- Existing projects/presets/sessions (.tprojz, JSON, asset store) open unchanged; exports byte-compatible where
  a format is a target (MPC .xpj, .als/.adg, MIDI, WAV/FLAC).
- Keyboard map, MIDI note=pad mapping, pad numbering, defaults (snap OFF, one-shot pads, tempo precedence).
- “The Terminator sound”: every FX parameter range/default/curve, console flavours, mono-cut+fade on export,
  normalisation rules — golden renders from the CURRENT engine are the reference where the current engine is
  correct (the dossiers list where it is NOT).

## A7. Phase skeleton (detail per phase in Part C)
0 Foundations · 1 Audio I/O + latency + “hello pads” · 2 Sampler engine parity + EngineClient bridge + hybrid
shell boots the real UI · 3 Transport/sequencers/MIDI · 4 Mixer/FX/console/meters/PDC · 5 Recording ·
6 Plugins · 7 Stems native · 8 Persistence/library/exports/platform features · 9 Ship (installers, updater,
licence, help, themes, perf, beta) · 10 Beyond parity (the DAW roadmap: audio tracks/timeline, automation,
tempo map, comping, freeze, Link, MIDI-out tracks, sandboxed plugins, iOS sharing the engine).

---

# PART B — EVERY SECTION OF TERMINATOR: TODAY → NATIVE

## B1. THE SAMPLER CORE — sources, chops, pads, voices (native spec)

**Today (truth):** `ChopperEngine.ts` (7,319 lines) is engine + transport + sequencer + exporter in one class. Data model: `Chop{id,start,end,free?}` in effective (trimmed) seconds, min 10 ms; `Pad{index,chopId,mode oneshot|loop,color,pitch ±24,gate?,fadeIn?,fadeOut?,stems?(4-bit),reverse?}`; pad-own sources `padBuffers: Map<pad,{buffer,videoId,title,start,end}>` (several pads can share one buffer = a BLOCK); source identity `padSourceKey = 'main' | 'src:<videoId>' | 'grp:N'`; `sourceRoutes/padRoutes` → mixer strip `sampleN`; `padChoke` mute groups (default = same source chokes; `'none'` = poly; custom `grpN`); `sourceFx{attack,pitch,fine,reverse}` per source; `sourceNorm`; `trims[]` (section cuts with 3 ms seam ramps, effective↔file time mapping); undo `HistorySnapshot` (100 deep, 500 ms coalescing, keeps 2 sample buffers). Voice: one per pad (retrigger replaces), `AudioBufferSourceNode` varispeed `detune=(pad.pitch+sourcePitch+fine/100)·100`, attack ramp (default 3 ms), release tail (0–0.5 s), LOOP = rendered equal-power crossfade loop (`period = n − fo`), REV = mirrored buffer copy + `duration−end` offset, stretch = SoundTouch offline cache (128 MB LRU) with dry fallback on miss, stems = chop-length masked slices (`posOffset`), live `restemVoice` 12 ms crossfade, choke = 3 ms fade + stop. Chop-while-playing: `pos = un-led playhead + chopOffsetMs → snap (off | transient ±250 ms | 1/4 1/8 1/16 from bpm anchored at first drum transient)`; transient detectors (broadband HOP 256/FRAME 512 flux mean+0.1σ min gap 30 ms; drum-only 2-band); BPM tempogram (HOP 1024/FRAME 2048, 60 s, fold 75–165, integer). NORM = 0.891/peak non-destructive. Playhead = `now − startCtxTime − hwLatency` (×rate, loop mod, reverse/stretch mapping) + 16 ms display lead. Full detail: `dossier-chopper-core.md` (§1–§3, §10 list of 17 subtle behaviours = the parity checklist).

**Native design (C++ `libterminator`):**
- `Project` (pure data, serialisable) ↔ `Engine` (RT). Data classes mirror the TS types 1:1 (same field names in JSON): `Source{id, key, AudioData(float32 planar, N ch, sr), title, fx{attack,pitch,fine,reverse}, norm, stems?}`, `Chop`, `Pad`, `Block` (derived), `Route`, `ChokeGroup`, `Trim`, `Sequence`… The planner functions (`rearrange`, `insertPushing`, `moveBlock`, `planMoveBlock`, `chopPadSource*`, `nextSlotForSource`, `roomAfterBlock`, `refitSeqStorage`, `liveLanding`, `swingOffsetSec`, `applySnap`, transient/BPM detectors, `renderCrossfadeLoop`, `buildEffectiveBuffer`, `padClipboard`) are **pure functions today** → port them as pure C++ with the SAME tests (they are the bulk of the harness gates) — or keep them in TypeScript in the UI layer where they are UI-side logic (pad clipboard, planMoveBlock preview) — decision per function: anything that affects AUDIO or PROJECT STATE goes to C++; pure-UI planning can stay TS.
- **Voice engine**: preallocated `VoicePool` (e.g. 256 voices, one active per pad but sequencer tails + choke fades + restem crossfades need overlap), each voice = sample-accurate start offset within the block, resampling varispeed (4-point Hermite or windowed-sinc quality setting; Chromium's is linear-ish — we get BETTER by default), attack/release/fade envelopes in REAL seconds (same constants: attack default 3 ms, 5 ms seq fade to 1e-4, 3 ms stop ramp, 12 ms restem crossfade), reverse = read backwards (no mirrored copy; saves RAM; positions map identically), loop = runtime equal-power crossfade loop with identical `period`/warm-up math (golden-render test vs `renderCrossfadeLoop`), stems = read from `StemSet` planes with the pad mask (sum on the fly or cached slice — keep the LRU slice for CPU), stretch = Signalsmith Stretch offline cache (same key) + NEW real-time mode option, pitch = varispeed (kept) + NEW "preserve formant/length" mode via Stretch.
- **Choke/mute groups**, one-owner-per-hit 120 ms window, gate pads, LOOP toggle-off on re-hit, tempo precedence, empty-chop recovery, blocks push-never-overwrite, `free` chops — all preserved (checklist §10).
- Analysis thread: transients (both detectors, same params), BPM, waveform peak pyramids, silence-end detection (RMS 0.015 / 256 frames). **Peaks use JUCE `AudioThumbnail`: multi-resolution and cached TO DISK**, so a song's waveform is drawn instantly on re-open and the sample browser scrubs without recomputing — replaces the UI's 256-bucket in-memory cache.
- **Disk streaming (NEW — fixes a measured problem).** Today every source is fully decoded into RAM; the Electron renderer idles at **1.3–2.1 GB RSS** and stems add ~140 MB/song. Native uses `AudioFormatReader` + a buffering/streaming source: pads hold a *reference* to a file plus a small resident head (so a hit is instant), the rest streams on the loader thread. Consequences: memory drops by an order of magnitude, long files open immediately, the 600 s stems input cap can rise, and the 128 MB stretch LRU + stem-slice LRU stop competing for the same RAM. Fully-resident mode stays available for short one-shots and for offline render.
- Trims/effective buffer: keep the effective-time model; build the effective buffer once per edit on the loader thread, swap atomically.
- **Undo = JUCE `ValueTree` + `UndoManager` (NEW — decided up front, because retrofitting undo is painful).** Today undo is 100 whole-state snapshots, deliberately capped at 2 sample buffers so it doesn't eat RAM. A `ValueTree` shares structure instead of copying, records every property change, and serialises directly — so the project model IS the undo model: effectively unlimited history at a fraction of the memory, and the same tree writes out as the `ChopPreset` JSON (field names unchanged, B10). The existing semantics are preserved on top of it: 500 ms coalescing by group key (`pad-pitch-N`, `chop-boundary-<id>-<side>`…), begin/end batch for composite edits (paste/dup/move/clearBlock = one step), and audio buffers referenced, never copied. Known gap to close while we're here: routes/knob-drags that undo history doesn't carry today.
- Latency math becomes trivial: `playhead = samplesRendered − outputLatencySamples`; the 20 ms Safari estimate and the `outputLatency` dance disappear; chopOffsetMs (TRIM) kept as a user offset, default 0, plus the measured round-trip from calibration (B7).

**CHANGED (better):** higher-quality varispeed interpolation (switchable; "CLASSIC" = linear to match old renders), real-time stretch, no mirrored reverse copies, 24+-bit/any-rate sources without resampling at load, unlimited undo of samples by ref, per-pad polyphony option, velocity curves (linear kept as default), ARP + transient auto-slice knob + drum-only detector are ENGINE features already — expose them in the UI (decision: yes, they were built and tested).

**Gates:** chop-while-playing A–D, chop-seq-standalone, input-q, pad-loop (seam/period/RMS), pad-reverse, norm, resample-pad, waveform-live, record-constraints (as native properties), stem-mask/keys/lazy, preset round-trips — ported; plus golden renders: same project + same hits → native vs Web Audio engine within −60 dB (linear-interp mode) for one-shot/loop/reverse/pitch/attack/release/choke/NORM/masks.

## B2. TRANSPORT · CHOP SEQUENCER · DRUM MACHINE · ARRANGER (native spec)

**Today (truth):** master clock = `AudioContext.currentTime`; the chop sequencer in ChopperEngine IS the transport; drums/bass/MIDI-clock are satellites phase-locked by `seqStartHook(anchor = now + 0.02)`; all schedulers run a 25 ms Worker tick with 0.25 s (0.5 s after a late tick) look-ahead; steps scheduled as absolute `src.start(t)`; stalls: chop = drop if the slot passed else start late with offset; drums = jump whole steps; late hits never burst. Chop seq: `SeqPattern{bars 1..4, resolution ∈ {2..192} (stored), viewResolution, grid[step]=pads[], velGrid 0.05..1, revGrid (write-only), loop}`, `SEQ_MAX_STEPS 1536`, grid-is-a-lens refit by lcm/gcd, pattern switch queued at the loop boundary, pause/resume, non-loop stop, step record (fills next empty column), live record with `liveLanding` (INPUT Q 0..100, storage refit to 192 when Q<100, count-in 4 beats first click +120 ms, early hits within ½ grid step kept), one-owner rule, per-mute-group note length, 5 ms tail cuts, `lastLivePadHit` 120 ms. **Swing is applied in exports only, not in live chop playback (bug/mismatch to resolve).** Drums: `INTERNAL_SPB 96`, views 8/16/32 × triplet, bars 1..4, lanes kick/snare/hihat/openhat/perc + user lanes, per-step graphs (velocity, SHIFT ±50 ms snapped to ppq pulse, pan, REPEAT 13 rates), mute groups (time-ordered choke rule, same-instant = layer), swing on 16ths, `ceilPeak 0.977`, declick head/tail, `applyDrumAttack` (instant if head < 0.02 else 3 ms), choke 4 ms gain-only, generate (50 trap patterns; boombap/westcoast from KCC MIDI API), live/step record with SHIFT residual. Arranger: sections with `drumStepsPerBar` declared, chop events, bass notes/bends; preview via main-thread setInterval; export via `buildDrumTrackHits` etc. MIDI clock OUT 24 ppqn with 0.15 s look-ahead/25 ms pump; IN via least-squares follower with a one-port lock. Detail: `dossier-sequencing-midi.md`.

**Native design — ONE transport, everything is an event source:**
- `Transport`: sample position (int64) + tempo map (constant tempo v1, ramps later) + PPQ 960 beat position; `play(anchorSample)`, `stop`, `pause/resume`, loop range, `seek`; the audio callback asks every `EventSource` for events in `[blockStart, blockEnd)` (sample offsets) → voices start at exact sample offsets inside the block. No look-ahead, no timers, no stalls: if the UI thread freezes, audio continues.
- `EventSource`s: `ChopSequencer` (patterns, queued switch at loop boundary, pause semantics, per-group note length, tail cuts, one-owner rule, velocity, reverse per pad, INPUT Q/live record landing computed from the SAME sample clock), `DrumSequencer` (96-step internal, graphs, repeat sub-hits, mute-group choke order, SHIFT in samples snapped to ppq pulse), `BassSequencer` (PPQ 96 tick map, slides, bends), `Arp` (exact sample grid — no more setTimeout jitter), `Metronome` (click synth, accent, count-in; routed through the mixer's CLICK bus — CHANGED: today it bypasses the mixer), `ArrangerPlayer` (song mode: sections → absolute events; preview == export by construction), `MidiClockOut` (24 ppqn ticks as timestamped MIDI, generated per block from the transport: sample-exact), `MidiOutTracks` (NEW: send pad/bass/drum notes to external gear per strip).
- Swing: ONE function (`swingOffsetSec` port) applied identically in live and export for chops AND drums — resolves the live-vs-export mismatch (Victor 2026-08-22: live matches export).
- Live-record: hit timestamp = MIDI/driver timestamp (or UI event time) → sample position via the audio clock mapping (`sampleAt(hostTime)`), minus calibrated output latency; `liveLanding` math preserved (write time == audible time; SHIFT residual for drums).
- Pattern switch, tempo change (applies at next step, per-step stepDur re-read), refit of storage, queued switch only at step 0, drums immediate switch (keep), arranged drum pattern swaps on step boundaries — preserved.
- BPM range 20..300 (UI 40..300), tempo precedence metronomeBpm > detected > 120, tap tempo.
- Song mode (arranger) becomes a first-class timeline (B11 extends it into audio tracks).

**CHANGED (better):** sample-exact everything; arp/chokes/count-in no longer on JS timers; swing live parity; metronome through the mixer; MIDI out notes; tempo map ready for automation; drum per-step graphs honoured in export (fixes the "biggest export ≠ what you hear" gap) because export uses the same sequencer; nudge/humanise/probability per step as new options (off by default).

**Gates:** drum-timing, drum-transport, drum-oneshot, drum-mutegroups, input-q, chop-seq-standalone, midi-clock, midi-clock-in, chop-while-playing — every numeric assertion ported to C++ against the sample clock (tolerances become 0 samples where the old test allowed ms); plus: 10-minute stability test (no drift vs wall clock × sample rate), CPU-starve test (UI thread blocked 2 s → zero dropped/bursted events), golden render of a full project (chops+drums+bass+swing) vs current `exportMaster` within −60 dB where algorithms match.

## B3. MIDI (native spec)

**Today:** Web MIDI hub (`requestMIDIAccess` no sysex, explicit port open, statechange rebind); note→pad `note − 36` (A01 = C1) remappable per note via pad learn; velocity/127 linear; note-off → gate release; DRUM PADS mode (pad i → lane i); bass MIDI IN (+ MPC/MPD port regex → scale-degree pad fold, pitch bend ±2/±12); CC learn (two systems: `MidiMap.ts` parameterId→{min,max} persisted `midi-map.json` via IPC + `midiLearn.ts` localStorage; LearnPicker rules: first value 1..126, never a 14-bit LSB, end-stop CCs bind on 3rd message); handler-lag compensation `min(50 ms, now − e.timeStamp)`; clock IN follower (48-tick window, LSQ slope, ±15 % jump detection, hysteresis 0.3 BPM, one-port lock, START/CONTINUE/STOP transport control, "follow tempo" default OFF); clock OUT (SPP+START at anchor, 24 ppqn, stall rules, no `MIDIOutput.clear()`); latency meter; no MIDI note OUT; mobile path lacks the clock lock.

**Native design:** JUCE `MidiInput/MidiOutput` (CoreMIDI / WinMM+WinRT), per-port enable in Preferences (kept), all messages timestamped by the driver → mapped to sample positions; pad/drum/bass note routing preserved exactly (note−36, velocity linear default + optional curves, learn per note, DRUM PADS mode, MPC fold); ONE unified MIDI-learn store (merge the two systems: parameterId → {port?, channel, cc|note, min, max, mode abs/relative/toggle}, project-independent, JSON in the app's config dir, import the old `midi-map.json` + localStorage map on first run); LearnPicker rules kept verbatim (tests exist); clock IN: same follower algorithm but fed driver timestamps (jitter ≪ 1 ms) + PLL smoothing option, one-port lock, transport follow; clock OUT: generated in the audio callback from the transport with sample→host timestamps (`MidiOutput::sendBlockOfMessages`), SPP on restart from the actual position (CHANGED: today always 0), STOP flushes pending ticks (native can clear); MMC optional later; MIDI note OUT per strip/bass/drums (NEW); virtual MIDI port on Mac ("Terminator In/Out"); MIDI latency meter = driver timestamp vs sample clock (real numbers, not JS event ages); Ableton Link as optional later phase.

**Gates:** midi-clock (24 ticks/beat spacing 1e-6, SPP/START at anchor, stall rules), midi-clock-in (120 ±0.2, 120→90 within 2 beats, lock semantics incl. the 89-vs-177 two-port case), midi-learn picker cases; plus a virtual-loopback test (clock OUT → virtual port → clock IN follower reads the same BPM within 0.1), note→sound latency measured ≤ 1 buffer + driver.

## B4. MIXER · FX · CONSOLE · METERS · PDC (native spec)

**Today (truth from the code):** strips = `input(explicit 2ch) → [console ch] → ≤8 inserts → pdcDelay → matchGain → fader → mute → pan → output`; output → `toMaster` delay + 4 post-fader sends + meter taps; master = `[console bus] → inserts → fader → limiter(−1 dBFS, knee 0, 20:1, 1 ms/50 ms) → out`; default strips `sample,kick,snare,hat,openhat,perc,send1..4,master` + `sampleN`/user-lane strips created on demand. 17 mixer FX (clip, wave, sat, mbsat, wide, mseq, pan, phaser, flanger, vinyl, filter, eq, comp, sccomp, delay, reverb, utility) + 14 legacy chopper effects + the CONSOLE stage (SSL/NEVE/API, per-strip FNV-1a/mulberry32 tolerances seeded by strip NAME, bus = zero tolerance). PDC is two-tier (channel vs send-bus), with measured latencies (DynamicsCompressor ≈264 frames @44.1k, 4× WaveShaper 192 frames) — numbers that exist ONLY because Web Audio hides them. Fader −60..+6 dB (τ 8 ms), UI taper 0..0.8 → −60..0 / 0.8..1 → 0..+6; meters 4096-sample window, hold 3 s then 8 dB/s, clip ≥0.999; BS.1770-4 LUFS/TP worklet; NORM = 0.891/peak; WAV 16-bit TPDF with fixed xorshift seeds (FLAC bit-identical). Full tables: dossier `dossier-mixer-fx.md` §2–§4 (ship it in `docs/native/` as the FX bible).

**Native design:**
- `Mixer` = array of `Strip` objects processed in dependency order (sources → strips → sends → master); each Strip owns an `InsertChain` of `Effect` objects implementing `prepare(sr, maxBlock) / process(AudioBlock&) / latencySamples() / reset()`; no graph library needed for v1 (JUCE `AudioProcessorGraph` only for the PLUGIN slots, see B8 — plugins are Effects wrapping an `AudioPluginInstance`).
- **PDC becomes exact and free**: every Effect reports its latency in samples (we WRITE the compressor, so we KNOW its look-ahead; oversampling latency is known) → same two-tier plan (channel: `maxChan − own`; bus: `maxBus − own`, toMaster `= maxBus`) but computed in integer samples; offline render identical.
- Every FX ported 1:1 with the same param ids/ranges/defaults/curves so presets load unchanged; internal algorithms re-implemented in C++ (RBJ biquads, 4× oversampled shapers with proper polyphase halfband filters — REPLACES Chromium's undocumented WaveShaper oversampler; keep the same curves); `WetDry` true crossfade; `setParam` smoothing constants kept (fader/pan/send/mute τ 8 ms; FX τ 10 ms; LFO 20–50 ms; gain-match τ 250 ms ±15 dB; CONSOLE amount glide 1024 frames); sends WET forced 100.
- DynamicsCompressor semantics: port Blink's `DynamicsCompressorKernel` behaviour (it's open source; pre-delay/look-ahead 6 ms, knee maths) so COMP/limiter/legacy presets sound the same; then offer a NEW "TRUE PEAK LIMITER" master insert (look-ahead + 4× TP detection) as an addition, not a replacement.
- Reverb: port the deterministic IR generator (seeded LCG 1664525/1013904223, onset ramp, √-frac absorption, −60 dB at DECAY) + partitioned FFT convolution (JUCE `dsp::Convolution`) with the 60 ms A/B crossfade; later add a real algorithmic plate/hall as new FX.
- CONSOLE: port the worklet per-sample chain verbatim (HPF → shelves → presence → 1-pole LP → sat polynomial with hold-flat past x0 → 5 Hz DC blocker); keep FNV-1a seeds by strip name so a project sounds identical.
- Meters: one `PeakMeter` per strip computed in the audio callback (pre/post peak + RMS over 4096-sample window, posted via lock-free FIFO at ~30 Hz; silence → no posts), BS.1770-4 LUFS/TP/LRA/correlation meter on master (same designed K-filters and 12-tap Kaiser TP), spectrum via FFT on the analysis thread.
- Gain match (live-only trim) kept, never exported.
- Mono→stereo upmix at strip input kept (explicit 2ch rule) — AND strips now accept N-channel inputs from hardware (B7).
- NEW routing: per-strip **output target** (master | hardware out pair k | mono out n | another strip as sidechain/aux) → the interface's outs 3–8 finally exist; per-strip **input** (hardware in n / pair) for monitoring + recording.
- Sample rate: device rate; all internal constants in seconds → samples at prepare(); nothing assumes 44.1k.
- Export: `OfflineRenderer` drives the SAME `Mixer` faster than real time; stems = per-strip posts (pre-send, shifted by master PDC after feeding sends, exactly as today), master head-trim by limiter look-ahead; 16-bit TPDF dither with the SAME xorshift seeds/draw order (WAV == FLAC bit-identical); 24-bit round-to-nearest; 32f.

**CHANGED (better):** exact integer PDC; real oversampling; N-channel strips + hardware out routing; true-peak limiter option; meters computed on the audio thread (no analysers); plugin inserts in the same chain (B8); 64-bit summing bus as a Preferences option (default off).

**VICTOR'S PHASE-4 BRIEF (2026-08-22, verbatim intent — this is the bar the mixer/FX sessions build to; the
parity ports above stay as the compatibility layer so old projects load and sound the same, and THESE are the
new premium stock devices built on top):**
- **Summing**: the mixer must be very accurate and sound great when summing — 64-bit summing bus ON by default,
  sample-accurate PDC, no hidden gain stages, null tests against a reference sum, dither only at the export edge.
- **Rebuild the effects in JUCE, premium quality, using everything `juce::dsp` offers** (oversampling with proper
  polyphase halfbands, `ProcessorChain`, `IIR`/`FIR`/`StateVariableTPT`, `Convolution`, `LadderFilter` as a
  starting point, `BallisticsFilter`, `DelayLine` with interpolation, `Compressor`/`Limiter` as references — and go
  beyond them where the emulation needs it).
- **CONSOLE stage per mixer track**: the per-track saturation that emulates three consoles — **SSL, NEVE, API** —
  must sound premium / high quality (the current worklet chain is the parity floor; re-model transformer/
  op-amp/discrete behaviour with oversampling, per-channel tolerances kept).
- **Analog Filter** (replaces FILTER): classic **Moog** transistor-ladder filters as used on analog synths (4-pole
  24 dB/oct with resonance self-oscillation, drive, 2-pole/1-pole modes, zero-delay/TPT or oversampled).
- **Reverb**: emulates the classic **Lexicon 224** digital reverb (its algorithms/character: hall/plate programs,
  pre-delay, bass/treble decay multipliers, diffusion, the 224's dark modulated tails).
- **EQ**: works like **FabFilter Pro-Q 4** (unlimited dynamic bands, bell/shelf/cut/notch/tilt/flat-tilt, per-band
  L/R / M/S, slopes 6–96 dB/oct, linear-phase/natural/zero-latency modes, spectrum analyser, spectrum grab,
  band solo, gain-Q interaction, match/auto-gain where sensible).
- **Delay**: replicates a **Galaxy tape echo** (Roland RE-201 Space Echo-style — 3 heads, motor speed/wow/flutter,
  tape saturation + head bump, repeat rate/intensity self-oscillation, spring reverb option).
- **Compressor**: emulates a **Distressor** (Empirical Labs EL8 — ratios 1:1/2/3/4/6/10/20/Nuke, detector HP/band
  emphasis, Dist 2/Dist 3 harmonics modes, British mode, attack/release ranges/curves, the opto-style shape).
- **Channel strip**: emulates an **SSL 4000 G** channel (HPF/LPF filters, 4-band EQ with the E/G bell choices, the
  G-series compressor/gate-expander dynamics section, routing to dynamics pre/post EQ).
- **Saturation/distortion**: emulates **Soundtoys Decapitator** (styles A/E/N/T/P — tube/transistor/transformer
  flavours, Drive, Punish, Tone, HP/LP, mix, auto-gain).
- **Retro tape module**: emulates **XLN RC-20 Retro Color** — Noise (vinyl/tape/static), Wobble (wow/flutter),
  Distortion, Digital (bit/rate crush), Space, Magnetic (tape) — **with a LOT of different saturation and
  distortion options inside it** (many tape/tube/transistor/fuzz/diode/foldback algorithms selectable per stage).
- **Limiter**: emulates **FabFilter Pro-L 4** (styles transparent/punchy/dynamic/allround/aggressive/bus/safe,
  look-ahead, true-peak, oversampling, unity-gain monitoring, channel linking, loudness metering).
- **Mid/side everywhere**: every effect (and the EQ per band) can process Mid or Side (or L/R); proper M/S encode/
  decode on the strip with width control; "good mid/side processing".
- **Routing**: any channel can route to any channel to create **groups and busses** (free routing graph with
  cycle guard, sends + direct outs), plus **multi-select several mixer tracks → group them into a bus** in one
  gesture (a new bus strip, selected strips re-routed to it, colour/name inherited).
- "Put a good amount of work into the mixer and effects" — budget Phase 4 as the longest phase after the
  sampler core; each device ships with a golden/measurement gate (THD/IMD, frequency response, null against
  the reference curve where public, A/B against the plugin it emulates by Victor's ear).

**Gates (C++ ports of the existing contracts):** console.test (THD/level/tilt numbers in dossier §6), peak-meter exactness, export-flac bit-identity, norm-per-source, PDC alignment (SAT-on-kick both channels same sample; COMP-on-send single impulse), NY-comp dry/wet flat 60 Hz–8 kHz, MB SAT flat at 0 drive, master impulse == stem impulse sample, WetDry crossfade law, every FX default-patch golden render vs the current Web Audio engine (tolerance −60 dB where algorithms are identical; listed exceptions where the Chromium oversampler differs).

## B5. STEMS (native spec)

**Today:** htdemucs fp16 ONNX (FAST 166 MB; FINE = 4 ft specialists × 316 MB, one-hot rows), input `(1,2,343980)` @44.1k, output `(1,4,2,343980)` drums/bass/other/vocals; SEG 343980 / OVERLAP SEG/4 / STRIDE 257985, linear-ramp window, global fixed grid so chunks compose exactly; resample 48k↔44.1k with a windowed-sinc (Blackman, 16/32 lobes) so stems stay sample-aligned; ORT runs in a **real pinned Node child process** (V8 cage SIGTRAP), Intel = ORT 1.23.2 CPU, Apple Silicon = ORT 1.27 + WebGPU self-check (SNR ≥ 40 dB AND ≥10 % faster → verdict persisted), Windows = CPU (DirectML unmeasured); CoreML MLProgram returned WRONG stems; cache = `stems-cache.json` (LRU 300) + FLAC 16-bit assets in the asset store keyed by content hash `s1.<sha1>`; pad mask = 4-bit which-stems-play; `maskSlice` chop-length LRU; `restemVoice` hot-swap; lazy restore. Full detail: `dossier-stems-bass-io.md` §1.

**Native design:**
- `StemEngine` on its own thread pool: ORT C++ API in-process (no child, no temp file, no IPC serialisation), one warm session per model kept for the app lifetime, a priority job queue (focused pad window first, then sweep, preempt mid-batch, cancel per chunk), streaming accumulators (write finished spans straight into the engine's `StemSet` buffers and free chunk rows).
- Same chunk grid + window math (so cached stems from the Electron app remain valid and compose), same content key and cache JSON (cache shared/upgradable; `PIPELINE` bump only if output changes), same FLAC assets.
- EP policy per platform with the SAME SNR-vs-CPU self-check as a release gate AND a per-machine first-run probe: Apple Silicon → try ORT **WebGPU EP** (the verified-correct path) and CoreML EP again on a **re-exported model with STFT/ISTFT outside the graph** (that's what Espresso rejects today; STFT done with vDSP/pffft in C++); Windows → DirectML EP (measure on the Windows machine), CUDA optional; Intel Mac → CPU (AVX2 build). Never ship a GPU path without the probe passing.
- Resampler: r8brain/libsamplerate at the same quality target (flat to 20 k ±0.1 dB, ≥78 dB rejection) or port the existing kernel (it tiles bit-identically — keep it if cache bit-compatibility matters; it does for `readyRanges` assets: keep the port).
- Split-on-load option (background, low priority), per-stem GAIN (not just on/off) as a new mask mode, 6-stem model later, int8/distilled export measured.
- UI contract unchanged (`stemsSplit/onStemsChunk/stemsAvailable` bridge) — web keeps "precomputed R2 stems" fallback per the 2026-08-22 analysis.

**Gates:** stems-sum residual across a seam ≤ −33 dB (existing), SNR per EP ≥ 40 dB vs CPU, chunk-grid equality test (native vs current child on the same input → identical ready ranges + ≤ −60 dB difference on CPU), cache JSON round-trip, cancel/preempt ordering (no lost tail spans — the IPC race class of bug becomes impossible but keep the test), memory cap (≤ 32 B/frame accumulators, 600 s cap raised to “whole song” when RAM allows).

## B6. BASS SYNTH (native spec)

**Today:** one AudioWorklet (`bass-synth`), 3 PolyBLEP oscs (tri/shark/saw/square/pulse/narrow/sine/morph) + sub + noise → tanh mixer drive → LADDER (D'Angelo–Välimäki, 2× OS) | OTA (TPT SVF) | DIODE (Zavalishin/Pirkle, K=reso·24) → RC-shaped ADSRs → post DRIVE/TONE/GLUE/VOL → DC block → clip; mono last-note legato stack or poly 8; glide, SLIDE notes, BEND lane ±2/±12; 3 LFOs + 2 trig envs mod matrix; 8 factory patches; piano roll PPQ 96, grid 1..8/3/6/OFF, KEY LOCK (15 scales, ties snap DOWN, MPC pad fold root=pad 4); sample-accurate event list by absolute ctx time; exports via offline render; MPC/drum-rack exports do NOT carry bass (owed). Detail: `dossier-stems-bass-io.md` §2.

**Native design:** port the worklet to a C++ `BassSynth : Instrument` 1:1 (same equations, same constants, same patch JSON deep-merge, same factory patches) — it is already pure DSP written as per-sample code; events arrive as `MidiBuffer` with sample offsets from the unified transport (no `at` timestamps); runs inside the engine graph as a source strip (`bass`); offline render = same object. Tests: port `bass-synth.test.mts` (12 assertions) + `bass-theory.test.mts` as C++ gates with seeded RNG. CHANGED (better): true sample-accurate MIDI in (timestamped CoreMIDI → offsets), MIDI OUT of the bass pattern to external gear, bass as a VST3/AU-hostable instrument slot later (the same class can become a plugin — JUCE AudioProcessor), MPC export of bass notes as a MIDI track + rendered audio (closes the owed item).

## B7. AUDIO I/O · RECORDING · LATENCY (native spec)

**Today:** `AudioContext({latencyHint:'interactive'})`, prefs 44.1/48k + 128–1024 frames = a hint applied next launch; measured 48k/5.33 ms base, 44.1k+512 → 11.6 ms; `hwLatencySec = outputLatency || 0.02+baseLatency`; output via `setSinkId` null-sink trick; input via `getUserMedia` with EC/NS/AGC OFF, channelCount ideal 2, deviceId exact → **MediaRecorder PCM-webm** → decode → 24-bit WAV → RECORDINGS folder → next empty pad (or RECORD INTO pad); no monitoring path, separate analyser context for the level meter; 🔁 Terminator-output loopback via MediaStreamDestination; Windows-only system-audio loopback; RESAMPLE = offline render of a pad; MIDI latency meter = median of 48 event ages. Web Audio limits: 2-in/2-out, no exclusive/ASIO, no aggregate, no channel pick, no float capture, no punch, no monitoring. Detail: dossier §3.

**Native design:**
- `AudioIO` on JUCE `AudioDeviceManager` (**JUCE 9 ships a rewritten macOS CoreAudio implementation** — one more reason to pin 9, not 8): device types CoreAudio (Mac), ASIO + WASAPI (Windows; WASAPI exclusive preferred for latency, shared as fallback), input+output device pick, sample rate 44.1–192k, buffer 32–2048, N in × M out channels enabled individually; hot-plug (device removed → glide to silence, re-open, UI toast); preferences applied LIVE (no restart).
- **Latency truth**: `device.getInputLatencyInSamples()/getOutputLatencyInSamples()` + a **loopback calibration** (Preferences → AUDIO → "Measure": emits a click on a chosen out, listens on a chosen in, cross-correlates, stores the measured round trip; recording offset compensation = measured − reported). The TRIM knob stays as a manual override, default 0.
- Recording = a `Recorder` Effect at the strip input or a dedicated `InputStrip` per enabled hardware input: float32 capture straight into a preallocated ring → disk writer thread (24-bit or 32f WAV, 24 default), sample-accurate punch-in/out on the transport, count-in, loop-record with takes, **input monitoring** (direct, with the strip's inserts, or off), input gain + clip LED, stereo/mono/pair selection per take, record to: next empty pad / RECORD-INTO pad / a new SOURCE / (later) an audio track. Recording offset compensated automatically.
- Resample-own-output: a `Bounce` job = offline render of the selected strips/pads (exact), plus a live "🔁 capture master while playing" that records the master bus post-limiter with sample alignment (no MediaStream).
- System audio capture: Mac via ScreenCaptureKit audio tap (macOS 13+) or a documented "Audio Routing Kit/BlackHole" fallback; Windows via WASAPI loopback capture (native, no display-media dance).
- Per-strip output routing → any enabled output pair/mono (B4); master → selectable main out pair; cue/headphone bus as a later phase.
- MIDI (see B3 dossier when it lands): timestamps from the driver → sample offsets in the next block; MIDI→sound ≈ one buffer.

- **Channel configuration (decided, Ableton-style):** Preferences → AUDIO shows *Driver Type* (CoreAudio / ASIO / WASAPI), *Audio Input Device*, *Audio Output Device*, *Channel Configuration* → **Input Config** and **Output Config** dialogs listing every mono channel and every stereo pair of the device with on/off switches (defaults: 1/2 in, 1/2 out on; **Enable all** button); *In/Out Sample Rate*; *Default SR & Pitch Conversion* quality (Normal / High); *Buffer Size*; read-outs *Input Latency*, *Output Latency*, *Driver Error Compensation* (ms, editable — and **filled automatically by our loopback "Measure"**), *Overall Latency*; *Test Tone* (on/off, volume dB, frequency Hz) so the user can hear which output is which; a live *CPU* meter. Every enabled input becomes a selectable record/monitor source; every enabled output/pair becomes a routing target for strips and the master. Tascam Model 16 = the first test device (16 in / 14 out).

**Targets:** RTL ≈ 1.5–3 ms @64/48k on a class-compliant interface (Mac), ≈3–6 ms ASIO @64 (Windows); pad hit → sound ≤ buffer + driver; recording aligned to ≤ 1 sample after calibration. **Gates:** loopback self-test (record the click, assert offset == calibrated value ±1 sample); device-switch-while-playing no crash/no glitch beyond a fade; punch-in sample position == transport position; 24-bit/32f file correctness; monitoring path latency == buffer; every `recordconstraints` invariant (raw, stereo, no processing) becomes a property of the native path (nothing to disable).

## B8. PLUGINS — VST3 / AU hosting (native spec, NEW capability)

- Formats: VST3 (Mac+Win), AU v2 (Mac) in v1; CLAP via the clap-wrapper/`clap-juce-extensions` hosting path later; VST2 no (SDK unavailable).
- Scanning: out-of-process scanner (a second executable `terminator-scan` that JUCE's `KnownPluginList::scanAndAddDryRun` / `PluginDirectoryScanner` drives; a crash marks the plugin in a blocklist; scan results cached to `plugins.json`; "Rescan" + per-path config in Preferences → PLUGINS; default paths per OS).
- Hosting: `AudioPluginInstance` wrapped as an `Effect` (insert slot) or an `Instrument` (a strip whose input is MIDI: pad notes, bass pattern, piano roll, MIDI in); bypass/latency/`setNonRealtime` for offline render; sidechain bus negotiation (`BusesLayout`) so SC COMP-style plugins get a key from any strip; state = `getStateInformation` blob base64 in the project JSON (+ preset name); param changes → undoable; plugin editors in child windows (keep-on-top option), generic param UI fallback; MIDI learn on plugin params (same unified map); PDC = `getLatencySamples()` feeds the same two-tier plan.
- Offline render: plugins processed with `setNonRealtime(true)` in the export thread; identical block sizes as live (some plugins are block-size sensitive — render at the live block size).
- Safety: plugin crash during scan never kills the app; during hosting, v1 = in-process (document the risk in Help); v2 = sandboxed hosting per plugin process with shared-memory audio (Bitwig-style) — scheduled, not promised.
- Gates: load/unload 100× without leaks; state round-trip; latency compensation test with a known-latency test plugin (JUCE ships a `AudioPluginDemo`; build a 1000-sample-latency test VST3 in-repo); sidechain key reaches the plugin; offline == live render for a deterministic plugin.


## B9. APP SHELL · UI · PREFERENCES · GATING · PLATFORM (native spec)

**Today (truth):** Electron 41 shell, frameless 1280×900 window, native menu (File New/Open/Save/Save As/Recent ≤10, Transport Play/Stop ⌘E export, Re-arrange Layout ⇧⌘L), single-instance + `terminator://` deep links + `.tproj/.tprojz` associations, electron-updater on R2 `terminator-electron/`, EULA → browser sign-in (device token, `/api/terminator-check` every launch, 7-day offline grace) → free tier (3 pads, 10 pulls) vs $40 lifetime / KCC suite, Preferences = separate always-on-top window (AUDIO: buffer/rate/PPQ/out/in; MIDI: per-port + clock send/follow + channel; FOLDERS: projects/library/user samples/drums/YouTube/stems engines+audio store), ~40 IPC channel groups (see dossier §6), custom protocols for cache/library/drums, MPC card poll + safe eject, yt-dlp onedir, native drag-out, 9 draggable sections with layout presets, Help (17 topics, whole-article search, tooltips via `data-tip`/`title`), 11 colour themes + 15 hardware palettes + FINISH classic/4K + DUST, keyboard map (dossier §3), HardwareView phone layout (web only; never in Electron). Products sharing the repo that are NOT the DAW: MPC Extractor, The Board, (Finish Him IS the DAW's arranger UI). Dead code not to port: `isWebUI` branches, `components/EffectsPanel|MasterSection|TrackStrip|Transport|WaveformDisplay`, `drive.ts`. Full detail: `dossier-shell-ui.md`.

**Native design (separate repo `terminator-native`, separate product line):**
- JUCE `DocumentWindow` (native title bar optional; keep the frameless look via `setUsingNativeTitleBar(false)` + custom drag region, or native — decide by eye), one main window hosting `WebBrowserComponent` full-bleed; plugin editors = child `DocumentWindow`s; Preferences = a JUCE window hosting the same React PreferencesWindow page (or native JUCE — small enough either way; recommendation: web page, same code).
- **Bridge** (`EngineClient` TS ⇄ `NativeBridge` C++): typed, versioned JSON commands (`{id, cmd, args}` → promise) + event stream (`state`, `activity`, `meters`, `playhead`, `waveformTiles`, `stemsChunk`, `progress`, `midi`), batched per frame; big binary (waveform peak tiles, recorded takes for TS exporters, rendered stems) via `withResourceProvider` URLs (`terminator://blob/<id>`) so the webview fetches bytes without JSON; the UI never owns audio buffers again — it asks for peak pyramids and slices.
- Menu/shortcuts: native JUCE menu bar with the SAME items/accelerators; keyboard map preserved (pads typed into the webview; global shortcuts via JUCE `KeyPressMappingSet` where the webview must not eat them — ⌘S/⌘Z handled in-page as today).
- Files: `.tproj/.tprojz` associations, Recent (10), Open/Save dialogs native (`FileChooser`), drag-in from Finder/Explorer → `FileDragAndDropTarget` on the component → event to UI with the path, drag-OUT of exported files (native `performExternalDragDropOfFiles`).
- Single instance + `terminator://auth` deep link (JUCE `JUCEApplication::anotherInstanceStarted`, URL scheme registration in Info.plist / registry).
- Updater: Sparkle (Mac, EdDSA-signed appcast) + WinSparkle (Win), appcasts on R2 under `terminator-native/` (never touches the Electron feeds); same "binaries first, feed last" rule in a new `RELEASE-CYCLES-NATIVE.md`.
- Licensing/EULA/sign-in: identical flow against the same KCC endpoints (device token in OS keychain via JUCE/`Security.framework`/DPAPI), 7-day grace, free tier rules identical (`lib/subscription.ts` logic ported as-is in the UI; the engine enforces pad/feature caps too so the free tier can't be bypassed by poking the bridge). NEW: the native app can carry its own SKU ("Terminator Studio") — product decision, flag only.
- **Preferences reference = Ableton's layout (his call):**
  - AUDIO: see B7 (driver type, devices, Input/Output Config dialogs, sample rate, SR & pitch conversion quality, buffer, latency read-outs + driver error compensation + Measure, test tone, CPU meter).
  - PLUG-INS (his 2026-08-22 ask: "scan for my VSTs in settings like I can in Ableton"): **Rescan Plug-Ins** button (out-of-process scan with a progress bar + the name of the plugin being scanned, cancellable; crashed/blocklisted plugins listed with a *Retry* per entry; results cached, new/changed plugins picked up on launch); *Use Audio Units v2* / *v3* (Mac); *Use VST3 Plug-In System Folders*; *Use VST3 Plug-In Custom Folder* + *Browse* + path line (shows "(not available)" when unmounted, like his Seagate folder); VST2: not offered (no SDK — say so in Help); *Plug-In Windows*: multiple windows, auto-hide, auto-open; blocklist view.
  - RECORD / WARP / LAUNCH → our RECORD page: *File Type* WAV / AIFF / FLAC, *Bit Depth* 16 / 24 / 32 (float) — default 32-bit float like Ableton, *Count-In* (none / 1 / 2 / 4 bars), *Exclusive* Arm / Solo, *Start Playback with Record*, *Create Fades on Clip Edges*, *Start Playback with Tap Tempo*; plus our INPUT Q and monitoring-mode defaults.
  - LINK / TEMPO / MIDI → our MIDI page (ports, clock send/follow, channel, virtual port, Link later).
  - FILE / FOLDER + LIBRARY → our FOLDERS page (as today: projects, sample library, user samples, drums, YouTube, stems engines + audio store, disk sizes).
  - LOOK / FEEL → THEME page (theme, FINISH, palette, DUST, UI size, tooltips, layout presets).
- Preferences: same tabs + NEW AUDIO items (device type CoreAudio/ASIO/WASAPI, input/output channel enables, sample rate 44.1–192k, buffer 32–2048, "Measure latency", monitoring mode), NEW PLUGINS tab (scan paths, rescan, blocklist), NEW MIDI items (virtual port, clock source, MIDI-out enables per port). Stored as JSON in the app's config dir with a one-time import of `terminator-settings.json` values (folders, MIDI toggles, PPQ).
- Protocols: the library/cache/drums content served to the webview via the JUCE resource provider (replaces `terminator-lib://` etc.); range/streaming handled natively.
- MPC card detection + export-to-card + safe eject ported to C++ (diskutil/PowerShell/udisks shell-outs as today, or native APIs).
- yt-dlp: same onedir nightly, spawned as a child process with JUCE `ChildProcess`; same cache layout (`<videoId>.<ext>` + json) so existing caches are reused.
- Help: same `Help.tsx` data + search + tooltip layer, with new topics for AUDIO DEVICES, PLUGINS, RECORDING, MIDI OUT (house rule: help + tooltips in the same commit as each feature).
- Themes/FINISH/palettes/DUST/keyboard map: unchanged (it's the same UI code). HardwareView stays web/mobile-only (not shipped in the native desktop app; iPad gets desktop layout as today).
- Telemetry: opt-in crash reports only (Crashpad → a KCC endpoint or Sentry-native); no analytics (same as today).
- Packaging: Mac universal `.dmg` + `.zip` (Sparkle) signed + notarised with the existing identity/keychain profile; Windows NSIS x64 (unsigned today — budget a code-signing cert: SmartScreen matters more for a DAW that hosts plugins); resources: yt-dlp, ONNX models downloaded on demand (as today), drums-flac bundled, JUCE WebView2 loader.

**Out of scope for the DAW repo:** MPC Extractor, The Board/Producer Sim (stay in the Electron repo; the Extractor's ALS/Logic/FL exporters that the chopper needs come along as TS modules — see B10).

**Gates:** free-tier caps enforced engine-side test; deep-link + single-instance manual test; updater end-to-end (previous version → detects → installs); help search contract tests (existing); layout presets persist; bridge fuzz test (malformed commands never crash the engine); memory/launch benchmarks (≤ 1.5 s to interactive, ≤ 250 MB idle RSS on Mac).

## B10. PERSISTENCE · SAMPLE LIBRARY · EXPORTS (native spec)

**Today (truth):** ONE document shape for everything — `ChopPreset` JSON (project file, named preset, per-video auto-preset, session autosave, cloud row `pattern` column, transfer bundle); **no version field** (every newer field optional; two legacy fallbacks: single-pattern seq fields, `drums._inputQuantize`); `videoId` kinds: YouTube id / R2 id / `asset:<sha1>` / `local:` bundled / dead `local_` / `'none'`; `padBufferMeta` per pad; asset store = SHA-1 content addressing at `<userData>/terminator-presets/assets/<hash>.<ext>` + `.json` sidecar (512 MB cap), web = IndexedDB; `.tproj` = pretty JSON, `.tprojz` = STORED zip `{project.json, manifest.json{version:1,app:'terminator',assets[]}, samples/<hash>.<ext>}` (warn > 100 MB, refuse > 500 MB); stems audio deliberately NOT bundled/transferred; projects dir user-changeable; recents ≤ 10; session autosave on quit; cloud presets via KCC API with device token (JSON only, no sample bytes); TRANSFER = P2P WebRTC over the board-signal relay, 8-char room code, SHA-1 verified, ≤ 600 MB, ≤ 10 min wait. Library: `~/Music/Terminator/library.json` v1 virtual tree (`folder|file|link|r2` nodes, `link:<abs>` and `user:<rel>` virtual ids, system folders Recordings/YouTube/Imports/User Samples + DOWNLOADED PLAYLISTS + Drums), organisation virtual except USER SAMPLES (disk-mirrored, writable), delete = Trash, linked folders lazy-listed (caps 50,000 files / depth 16 — the "2,000" in memory is superseded), search index TTL 5 min; yt-dlp pinned nightly onedir, every pull lands in the library (`YouTube/` named by title), legacy cache adopted; curated playlists from `data/*.json` or R2 `playlists.json`; drum catalog `samples.json` opaque 16-hex ids APPEND-ONLY (presets store `sampleIndex`), resolution bundled FLAC → R2 FLAC → R2 mp3, 1,185 bundled files, guard script. Exports: Master Mixdown (16-bit WAV/FLAC, tail 2.5 s), Trackouts zip (one post-strip stem per channel + send returns), MPC Project (24-bit pad WAVs + `.mpcsample` ACVS gzip, PPQ 960, note 36+pad, 128-slot descending bank), Ableton Drum Rack (`.adg` gzip XML from Live-11 templates, 16-bit, `ReceivingNote 4+pad`, chokes), hidden-but-wired: original, sequences, MPC pattern, MIDI (SMF 960 PPQ); RESAMPLE → FLAC asset; export straight onto a detected MPC card; 16-bit = TPDF with fixed xorshift seeds (WAV == FLAC bit-identical, `test:export-flac`); Extractor-only exporters (ALS/Logic/FLP/Quick Sampler) are NOT used by the chopper. Full detail: `dossier-persistence-exports.md`.

**Native design:**
- **Project format v2 = the same JSON + `version: 2`** + new optional fields (plugin state blobs, hardware routing, automation later). Reader accepts v-less (v1) files with both legacy fallbacks; writer always emits v2; an Electron-era build can still open a v2 file it doesn't fully understand (unknown fields ignored — this is already how the loader behaves). `.tproj/.tprojz` layouts identical; asset store path + sidecar format identical so the native app can point at the SAME `terminator-presets/assets` folder (shared with the Electron app on the same machine) — sample bytes never duplicated; `.tprojz` writer emits stored zips identically (TS `zipWriter` kept in the UI layer or ported; byte-identical not required, valid zips are).
- C++ side owns: JSON (nlohmann) model ↔ `Project`, asset hashing (SHA-1), bundle pack/unpack, recents, session autosave (also periodic crash autosave every 60 s — CHANGED: desktop today saves only on quit), projects dir setting; UI side keeps: cloud preset API calls (same endpoints, token from the native keychain via bridge), TRANSFER (WebRTC in the webview — it already runs there; JUCE's webview supports WebRTC on WKWebView/WebView2; fallback: port later to a native relay client).
- Library: same `library.json` v1 read/write (C++), same system folders + virtual ids, USER SAMPLES disk mirror, Drums folder, Trash-delete via OS APIs, background indexer thread with a file watcher (no listing caps — large linked folders index incrementally and show "indexing N…"), search over the index, range/streaming via the resource provider, recordings saved as 24-bit WAV into Recordings/ with the same naming, yt-dlp child process + same cache/adoption logic, playlists from `data/` or R2, disk usage per row.
- Drums: same `samples.json` contract (append-only), bundled `drums-flac/` in Resources, R2 fallbacks, MY DRUMS + user lanes, `ceilPeak`/declick at load in C++.
- Exports: the engine renders (offline, exact); **TS exporters run in the UI** on the rendered buffers (`.mpcsample`, `.adg`, MIDI, zip, `.mpcpattern`) — unchanged code, fed via resource URLs; WAV/FLAC/MP3 encoders in C++ (libFLAC or a port of the TS FLAC encoder — port it: it is gated bit-identical and small; LAME for MP3 later), 16-bit TPDF with the same seeds; MPC card detect/export/eject native; re-enable the hidden rows (sequences, MPC pattern, MIDI, original) as real options; NEW: bass MIDI export (owed), per-strip stems with plugins, export at any rate/bit depth, export queue in background with progress.
- **Export dialog (decided — modelled on Ableton's *Export Audio/Video*, one window, same order):**
  - *Selection*: **Rendered Track** = Master · All Individual Tracks (one file per strip + active send returns, the Trackouts) · any single strip · Chops (one file per pad) · Drums only · Bass only; **Render Start** / **Render Length** in bars.beats.16ths (defaults = the loop / arrangement; drag-editable like Ableton's fields).
  - *Rendering Options*: **Include Return and Master Effects** (for individual tracks), **Render as Loop** (tail folded into the head), **Convert to Mono**, **Normalize** (−1 dBFS peak, our NORM), **Create Analysis File** (dropped — not ours), **Sample Rate** 44100 / 48000 / 88200 / 96000 / 176400 / 192000 with the "Project will be rendered at N Hz" line (SRC = the same high-quality resampler as playback).
  - *PCM*: **Encode PCM** on/off · **File Type** WAV / AIFF / FLAC · **Bit Depth** 16 / 24 / 32 (32 = float) · **Dither Options** No Dither / Triangular (= today's TPDF, fixed seeds, bit-identical WAV↔FLAC) / Rectangular / Noise-shaped (POW-r-style) — dither offered only at 16-bit.
  - *MP3*: **Encode MP3** on/off · **Quality** CBR 320 (default, highest) / 256 / 192 / 128 / VBR V0 (LAME) — both PCM and MP3 can be on at once, exactly like Ableton.
  - *Terminator targets* (a fourth group, below MP3): **MPC Project** (.mpcsample + 24-bit pad WAVs, straight to a detected MPC card), **Ableton Drum Rack** (.adg), **MIDI** (SMF), **MPC Pattern**, **Original sample** — each with its own small option set, all rendered by the same engine path.
  - Footer **Export / Cancel**; progress + cancel while rendering; renders run on the export thread, UI stays live; the last-used settings are remembered per project.
  - Principle restated: whatever Rendered Track you pick, the bytes are produced by the same transport/sequencers/mixer/plugins as playback — including swing, per-step drum graphs, PDC, console, plugins — so **export == what you hear**.
- Cloud/KCC: unchanged endpoints; "samples in R2" (phase 3 of the old plan) stays unbuilt unless asked.

**Gates:** open every fixture project (v1 + legacy shapes) → identical `Project` model vs the TS loader (JSON diff after normalisation); `.tprojz` round-trip; asset dedupe by hash; library.json round-trip + USER SAMPLES mirror ops; yt-dlp pull lands as a library node with `meta.videoId`; export byte-compare vs Electron for MPC/ADG/MIDI (deterministic) and WAV/FLAC PCM identity; FLAC encoder reference decode; MPC card path layout; transfer Electron ↔ native both directions.

## B11. BEYOND PARITY — the DAW roadmap (after Phase 9)
1. **Audio tracks + timeline**: the arranger becomes a real linear timeline — audio clips (from pads/sources/recordings), MIDI clips (drums/bass/plugin instruments), clip launcher view optional; clip gain/fades/warp (Stretch), comping from takes, freeze/bounce in place, track folders.
2. **Automation**: lanes for every strip/FX/plugin/engine param, recorded from MIDI learn, drawn, tempo map automation.
3. **Routing**: cue/headphone mix, external FX insert (hardware send/return with latency ping), group buses, VCA-style ganging.
4. **Sync**: Ableton Link, MMC, MTC; MIDI-out tracks per strip; virtual MIDI ports; MPC hardware templates (pad lights/colour feedback via MIDI out).
5. **Sound**: true-peak limiter, convolution reverb IR loader, 64-bit summing option, oversampled saturators, real-time Stretch per pad, formant pitch.
6. **Plugin sandboxing** (hosting other people's plugins out-of-process).
7. **Stems**: 6-stem model, per-stem gain masks, split-on-load, Windows GPU, precomputed R2 catalogue for web/mobile.
8. **Collab**: the 8-char transfer becomes project sync; The Shared Board session idea carried over.
9. **TERMINATOR AS A PLUGIN — VST3 / AU / AUv3** (see Phase 11; the biggest product opportunity the architecture opens).
Each item gets its own spec when scheduled; none are parity requirements.

---

# PART C — THE BUILD, STEP BY STEP

Conventions: each phase ends with (a) green gates, (b) a packaged build Victor can open, (c) an ear/hands pass by Victor on the listed items, (d) memory + `docs/native/STATUS.md` updated. Nothing is "done" until his pass. Phases are sequential; inside a phase, tasks are in build order. Effort is given in focused sessions (≈ a working day each) — an honest order-of-magnitude, not a promise.

### PHASE 0 — Foundations (≈ 4–6 sessions)
0.1 Create repo `~/Developer/terminator-native` (git init, private GitHub remote `thewoodendeer/terminator-native`, main branch; solo-repo linear commits; Electron repo untouched).
0.2 Layout: `CMakeLists.txt` · `engine/` (libterminator: `include/terminator/*.h`, `src/`) · `app/` (JUCE shell) · `tools/` (`terminator-scan`, `terminator-render` CLI) · `ui/` (the React UI, pnpm, copied from `terminator/src/renderer` minus mpc/board/finishhim? — keep finishhim, drop mpc+board) · `tests/` (Catch2 + golden fixtures) · `third_party/` (JUCE 9.0.1 tag pinned via FetchContent, Signalsmith Stretch, r8brain, ORT prebuilt per platform, Catch2, nlohmann/json, readerwriterqueue/concurrentqueue, Sparkle/WinSparkle) · `docs/native/` (this plan, the 6 dossiers, FX bible, bridge protocol, RT rules, RELEASE-CYCLES-NATIVE.md) · `.github/workflows/` (mac-universal + windows builds, tests on push).
0.3 Toolchain: `brew install ninja llvm` (LLVM 20+ for RTSan in debug/CI), CMake presets (`mac-debug`, `mac-release-universal`, `win-release`), JUCE Starter licence (free — Indie only when Terminator 3.0 starts selling; see Phase 9), ASIO SDK fetched in CI (not committed), WebView2 NuGet in CI.
0.4 RT rules doc + `rt_assert`/`[[clang::nonblocking]]` on the callback path; clang-tidy + clang-format; `-fsanitize=realtime,address,undefined` debug preset.
0.5 Skeleton: `Engine` (prepare/process/release), `CommandQueue` (lock-free), `StateSnapshot` publisher, `AudioIO` wrapper over `AudioDeviceManager`, `terminator-render` CLI (loads a project JSON, renders WAV offline) — the CLI is the test harness spine from day one.
0.6 CI green on both OSes producing a signed-nothing "hello" app that opens the JUCE window with a webview showing a static page; Mac universal verified with `lipo -info`.
0.7 Docs: bridge protocol v0 (command/event schema), `STATUS.md`.
**Gate:** CI builds + tests on macOS (arm64 + x64 runner) and Windows; RTSan clean on the empty callback.

### PHASE 1 — Audio I/O, latency truth, "hello pads" (≈ 5–8 sessions)
1.1 `AudioIO`: device type list, device pick, sample rate/buffer, channel enables, hot-plug callbacks, error surfaces; Preferences AUDIO page (React) driving it over the bridge.
1.2 Latency: reported in/out latency; loopback calibration (click out → in, cross-correlate, store round trip per device+rate+buffer); `sampleAt(hostTime)` clock mapping for MIDI/UI timestamps.
1.3 Minimal sampler: load WAV/FLAC/MP3/AAC (JUCE `AudioFormatManager` + the FLAC/opus/m4a readers; yt-dlp outputs m4a/webm-opus → need opus: bundle `libopus`/`opusfile` or keep yt-dlp `-x` to m4a/wav — decision: ask yt-dlp for m4a on Mac/Win, libopus fallback later), 16 pads, key + MIDI trigger, varispeed, attack/release, multi-output routing per pad (prove outs 3–8 on his interface).
1.4 MIDI in: JUCE `MidiInput` with timestamps → sample offsets; latency meter (driver ts vs callback).
1.5 Stress: 128 voices, device switch while playing, buffer 32..2048 at 44.1–192k, RTSan clean.
**Gate:** RTL measured on his interface ≤ 3 ms @64/48k (Mac); pad hit → sound ≤ 1 buffer + driver; outputs 3–8 play; no allocations on the callback (RTSan).
**Victor's pass:** feel the pads vs the MPC; confirm his interface, its channel count, and which outs he wants by default (ASK: interface model — unknown today).

### PHASE 2 — Sampler engine parity + bridge + the real UI boots (≈ 12–18 sessions)
2.1 Port the data model + pure planners (B1) with their tests; project JSON reader for `.tproj/.tprojz` (B10) — open his existing projects headless via `terminator-render` and render `exportMaster` → compare with the Electron export (first golden-render diff).
2.2 Voice engine complete: sources/chops/pads/blocks/routes/choke/groups/REV/LOOP/gate/fades/NORM/pitch/fine/stretch cache (Signalsmith)/stems masks (read from `StemSet` — stems themselves come in Phase 7; until then load the FLAC stem assets from the cache)/trims; **undo on `ValueTree`/`UndoManager` from the first commit of this phase**.
2.3 Analysis thread: transients (both detectors), BPM, silence-end; **`AudioThumbnail` disk-cached peaks and the streaming source layer land here, not later** — they set the memory profile everything else is measured against.
2.4 Bridge v1: `EngineClient` interface in TS (extract from `ChopperEngine.ts`: every public method + `getState()/activity/emit` becomes commands/events); `WebAudioEngineClient` (wraps the existing engine — keeps the web build alive in this repo's `ui/` for dev/testing) and `NativeEngineClient` (JUCE bridge); waveform view reads peak tiles via resource URLs.
2.5 Boot the full ChopperView in the JUCE webview against the native engine: LOAD/WAVEFORM/PADS sections working, sample browser reading the same `~/Music/Terminator` library (B10), yt-dlp pulls, RECORD SAMPLE minimal (Phase 5 completes it), themes/help/tooltips/layout all alive.
2.6 Packaged build #1 (unsigned is fine) — "the chopper works natively".
**Gate:** all B1 gates green; **idle RSS with a 4-minute song + stems loaded ≤ 400 MB (vs 1.3–2.1 GB today)** and a cold waveform draw ≤ 100 ms from the thumbnail cache; undo/redo 500 deep with bounded memory; golden renders within −60 dB in CLASSIC-interp mode for 20 of his real projects (pads/chops/reverse/loop/pitch/NORM/stems masks); UI parity checklist (dossier shell §2 rows 1–10) ticked.
**Victor's pass:** chop-while-playing by ear, snap, TRIM, blocks/move, stems chips (from cached stems), REV, LOOP, pitch/stretch; latency feel.

### PHASE 3 — Transport, sequencers, MIDI (≈ 10–14 sessions)
3.1 `Transport` + tempo map + `EventSource` framework; `ChopSequencer` (patterns, refit, queued switch, pause, non-loop, step/live record with liveLanding, INPUT Q, count-in, one-owner, tails, velocity, swing LIVE+export), `Metronome` (through mixer CLICK bus), `Arp`.
3.2 `DrumSequencer` (96-step, graphs, repeat, mute groups, SHIFT, generate incl. KCC MIDI API fetch, sample loading with ceilPeak/declick, lanes + user lanes, MY DRUMS folder), DrumSection UI on the bridge.
3.3 `BassSynth` + `BassSequencer` port (B6) + PianoRoll UI on the bridge; KEY LOCK theory port + tests.
3.4 `ArrangerPlayer` (Finish Him preview == export), arrangement types unchanged.
3.5 MIDI complete (B3): unified learn store + import of old maps, DRUM PADS mode, bass MIDI in/MPC fold, clock IN follower+lock, clock OUT sample-exact, MIDI note OUT (new), virtual port (Mac), Preferences MIDI page.
**Gate:** all B2/B3 gates; 10-minute drift test; UI-freeze test; golden render of full projects (chops+drums+bass+swing) vs Electron `exportMaster`.
**Victor's pass:** sequencer feel (live record, INPUT Q, count-in), drums swing/repeat, bass patch sounds vs Electron, MIDI clock against his MPC both directions.

### PHASE 4 — Mixer, FX, console, meters, PDC (≈ 18–26 sessions — grew with Victor's 2026-08-22 brief, see B4)
4.0 **Read B4 "VICTOR'S PHASE-4 BRIEF" first.** Parity ports are the floor (old projects load + sound the same);
    the premium devices (Moog filter, Lexicon-224 reverb, Pro-Q-4-style EQ, Galaxy tape echo, Distressor comp,
    SSL 4000 G strip, Decapitator-style saturator, RC-20-style retro tape with many saturation/distortion
    flavours, Pro-L-4-style limiter, premium SSL/NEVE/API console stage, full mid/side, any-to-any routing +
    multi-select → bus) are the deliverable. 64-bit summing default ON; a null-test gate on the sum.
4.1 Strip/Master/Send topology, **free routing graph** (any channel → any channel, groups/busses, cycle guard,
    multi-select → new bus), routing to hardware outs, pristine-strip rules, auto-created `sampleN`/lane strips, gain match, mute/solo law, fader taper, sends, M/S encode/decode + width per strip.
4.2 FX ports in this order (each with its golden test vs Electron): utility, eq, filter, pan, wide, mseq, delay, reverb, comp (Blink kernel port), sccomp, clip/wave/sat/mbsat (+ real oversampling), phaser, flanger, vinyl; console stage; legacy chopper master chain (filter/EQ3/comp/delay/reverb/clip/limiter) for the `sample` route + the 9 extra FX (keep — decide UI exposure with Victor).
4.3 Meters (peak/RMS per strip, LUFS/TP/LRA/corr/spectrum on master), clip latches, LoudnessPopup on the bridge.
4.4 PDC two-tier integer plan; offline renderer parity (stems per strip, master head-trim, tail seconds).
4.5 Export pipeline B10 end-to-end (Master Mixdown, Trackouts, MPC project, Drum Rack, + re-enabled MPC pattern/MIDI rows) — TS exporters fed by native renders; FLAC/WAV dither bit-identity.
**Gate:** B4 gates; every export format byte-compared against Electron output for the same project where deterministic.
**Victor's pass:** console flavours, NY comp, MB SAT, SC COMP, PDC on/off, limiter, loudness readings vs Electron side by side.

### PHASE 5 — Recording (≈ 6–8 sessions)
5.1 Input strips, monitoring modes, input gain/clip LED, record to next-empty-pad / RECORD INTO pad / new SOURCE, 24-bit/32f WAV writer thread, RECORDINGS folder + library entry, automatic offset compensation from calibration, punch/count-in/loop takes, 🔁 master capture, system-audio capture (Mac ScreenCaptureKit / Win WASAPI loopback).
**Gate:** B7 gates (loopback ±1 sample; punch exact; monitoring = one buffer).
**Victor's pass:** record from his interface (raw, stereo, 24-bit), resample a beat, sing/play against the click with monitoring on — the whole reason this project exists.

### PHASE 6 — Plugins (≈ 8–12 sessions)
6.1 Scanner exe + blocklist + Preferences PLUGINS; 6.2 insert hosting + editors + state + PDC + sidechain; 6.3 instrument strips (pads/bass/piano-roll MIDI → plugin); 6.4 offline render with plugins; 6.5 MIDI learn on plugin params; 6.6 crash drills.
**Gate:** B8 gates. **Victor's pass:** his favourite VST3/AU instruments and effects in the chain, export with them.

### PHASE 7 — Stems native (≈ 6–10 sessions)
7.1 ORT C++ in-process, CPU EP, same grid/window/resampler/cache/assets; 7.2 EP probe (WebGPU EP plugin / CoreML on a re-exported model / DirectML) with the SNR gate; 7.3 priority queue, split-on-load, per-stem gain option; 7.4 model download manager (sha-pinned) + Preferences FOLDERS parity.
**Gate:** B5 gates; speed ≥ Electron CPU path on both Macs, ≥ 1.3× with a passing GPU EP.
**Victor's pass:** split a song FAST/FINE, mask pads, compare speed/quality to Electron.

### PHASE 8 — Persistence, library, platform features parity (≈ 6–8 sessions)
8.1 Project save/open/Save As/Copy/recents/autosave-session/named presets/cloud presets/TRANSFER code flow; 8.2 library organiser (all row actions), linked folders WITHOUT the 2,000 cap (background index), MY DRUMS/USER SAMPLES, disk usage, Trash-delete; 8.3 yt-dlp pulls/playlists/cache/DL PLAYLIST; 8.4 MPC card detect/export/eject; 8.5 EULA + sign-in + licence + free tier; 8.6 deep links, file associations, drag in/out, native menu.
**Gate:** every IPC group in dossier shell §6 has a bridge equivalent or an explicit "dropped" note; old projects open; transfer works Electron ↔ native.

### PHASE 9 — Ship (≈ 6–10 sessions)
9.1 Sparkle/WinSparkle + R2 `terminator-native/` feeds + RELEASE-CYCLES-NATIVE.md; 9.1b **JUCE licence check before the first paid release.** Starter is free up to **$20,000/yr**, and for an INDIVIDUAL licensee the EULA counts only "revenue or funding generated by that individual's use of the Framework" — i.e. Terminator 3.0 sales, not the Electron app, the subscription site, or anything else. At $40 a copy that is **500 copies of 3.0 in a rolling 12 months** before anything is owed. Cross it → Indie: **$40/mo OR $800 perpetual (either/or, not both)**, limit $300k. Perpetual covers JUCE 9; JUCE 10 would be a discounted paid upgrade. **License as an individual, never as an entity** — corporate licensees must count ALL company revenue, JUCE-related or not. The upgrade is a key + agreement, no code change.
9.2 signing/notarisation (Mac identity + keychain profile; Windows cert to buy); 9.3 performance pass (launch ≤ 1.5 s, idle RSS, CPU at 64 samples with a full project), accessibility basics, high-DPI on Windows; 9.4 help topics + tooltips for every new feature; 9.4b **HANDOVER — the installed Electron app updates itself into 3.0** (verified feasible 2026-08-22 against the live install):
  - **Data needs no migration at all.** The native app points at the SAME userData dir Electron uses — `~/Library/Application Support/terminator` (Windows: `%APPDATA%/terminator`) — so `terminator-presets/` (538 MB, projects + the 86-file asset store), `terminator-stems/` (158 MB), `terminator-settings.json`, `terminator-session.json`, `eula-accepted.json`, `user-playlists.json`, `user-samples/` and `~/Music/Terminator` (the library) are simply already there on first launch. Nothing is copied, nothing can be lost.
  - **Two things do NOT carry over automatically, and both have a fix:** (1) the UI prefs living in Electron's Local Storage leveldb (theme, palette, FINISH, layout, UI size, tooltips, free-pull count) — fix: the FINAL Electron release (2.2.5) dumps localStorage to `userData/ui-prefs.json` on quit, and the native app reads it on first run; (2) `terminator-license.bin` is encrypted with Electron `safeStorage` (a Keychain item bound to that app's signature) — fix: native re-runs the one-click browser sign-in once, and honours `eula-accepted.json` so the EULA is not shown again.
  - **The auto-update swap itself:** Squirrel.Mac (what electron-updater drives) looks inside the downloaded zip for an app bundle with the **same CFBundleIdentifier**, checks it is signed, and replaces the bundle — it does not care what framework is inside. So the native 3.0.0 must keep `com.terminator.audio`, be signed with the same Developer ID (S7QVJJHXJ4) + notarized, ship as a `.zip` with `Terminator.app` at the root, and be published to the EXISTING `terminator-electron/latest-mac.yml` feed with a higher version (3.0.0 > 2.2.4). **Windows (same crossing, different mechanics — worked out 2026-08-22):** electron-updater downloads the `.exe` from `terminator-electron/latest.yml` (live = **2.2.3**) and runs it with `--updated /S --force-run`. So the native Windows installer must be an **NSIS installer that honours those exact arguments** (`/S` = silent, no UI; `--force-run` = relaunch the app when done; `--updated` = suppress the "welcome" page), and it must upgrade IN PLACE rather than land beside the old copy. In place means matching three things from today's electron-builder defaults:
    - **Uninstall registry GUID** — electron-builder derives it as UUID v5 of the appId in its own namespace; for `com.terminator.audio` that is **`{F9C641D4-BE56-5228-B95C-A6C4E8B7E310}`** (computed, not guessed). The native installer writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{F9C641D4-…}` so Windows sees an upgrade, and Add/Remove Programs keeps one entry.
    - **Install location + shortcuts** — the current build is electron-builder's default one-click per-user install: `%LOCALAPPDATA%\Programs\Terminator`, Start-menu + desktop shortcuts named "Terminator". Native 3.0 uses the same path and names, so the taskbar/Start pins users already have keep working.
    - **User data** — `%APPDATA%\terminator` (Roaming) is read directly by the native app, exactly like the Mac side: projects, asset store, stems, settings, session, EULA all inherited with no migration step.
    - **Signing:** today's Windows builds are unsigned, so no `publisherName` is embedded in the installed app and electron-updater skips the certificate check — the crossing works unsigned. If we buy the cert (Phase 9.2) and sign 3.0, that is still fine: the check only runs when the OLD app carried a publisher name. Sign *after* the handover, or sign both — never leave a signed-old → unsigned-new gap.
    - **Version note:** Windows is on 2.2.3 while Mac is on 2.2.4, so the Windows feed jumps 2.2.3 → 3.0.0. Both platforms cross at the same version number.
  - **After the handover, updates move to Sparkle/WinSparkle on the `terminator-native/` feed** — the Electron feed is used exactly once, for the crossing.
  - **Test it before it touches a user:** install a real 2.2.4 from the live feed, point it at a STAGING feed carrying 3.0.0, confirm it downloads, swaps, relaunches as the native app, finds every project, and then self-updates once more via Sparkle. **Do the identical drill on the Windows machine from a real installed 2.2.3** — check Add/Remove Programs shows ONE Terminator afterwards, the Start-menu shortcut still launches, and `%APPDATA%\terminator` projects are all present. **If the swap misbehaves on either OS, fall back to:** a final Electron update whose only change is a "Terminator 3 is ready" panel with a download button — no user is ever left on a broken updater.
9.5 private beta builds → Victor + a few producers; 9.6 KCC site: download links/SKU copy (separate from the Electron links), account page row.
**Gate:** smoke test of the packaged app (the 8-second rule), updater end-to-end from beta-1 → beta-2, checklist in RELEASE-CYCLES-NATIVE.md.

### PHASE 10 — Beyond parity (B11) — scheduled after Phase 9 ships.

### PHASE 11 — TERMINATOR AS A PLUGIN: VST3 / AU / AUv3 (≈ 8–12 sessions, after 9 ships)
*Why it is cheap: JUCE builds standalone apps and plugins from ONE codebase, and the plan already forces `libterminator` to be a UI-free engine with no knowledge of windows, files-on-disk or the transport clock. Most of this phase is adapting, not rewriting.*
11.1 `TerminatorProcessor : juce::AudioProcessor` wrapping the engine; formats VST3 + AU (Mac) + AUv3 (iOS/iPadOS), standalone target kept building from the same source so there is one truth.
11.2 **Host sync**: the host is the clock — `AudioPlayHead` drives our `Transport` (tempo, ppq position, play state, loop), so chops, drum grid, bass and swing lock to the host's grid. Our internal transport becomes a fallback for standalone.
11.3 **Buses**: stereo out for the simple case, plus a multi-out variant (one bus per SAMPLE strip / drum lane) so producers can route pads to separate DAW tracks — the same routing model as B4's hardware outs, pointed at host buses instead.
11.4 **Parameters + automation**: expose pad pitch/level/attack/release/mask, strip faders/pans/sends, every FX param as `AudioProcessorParameter`s so the host can automate and record them; MIDI learn stays for hardware.
11.5 **State**: `getStateInformation` = the same project tree (B10) minus device settings; large samples referenced by `asset:<sha1>` with an "embed samples in host project" option (sessions must survive being emailed to someone else).
11.6 **UI in a plugin window**: the same React UI in the WebView, resizable, with the host's scaling rules; plugin windows have no menu bar, so menu-only actions get in-UI equivalents.
11.7 **Not in the plugin**: yt-dlp pulls and app-level licence UI (host sandboxes make network + browser sign-in hostile); stems run but are gated behind an explicit user action (a 2-second-per-chunk job must never stall a host's render thread).
11.8 Validation: `pluginval` at strict level on VST3/AU, Ableton + Logic + FL smoke tests, offline bounce == live render, sample-accurate host-sync test (host at 96 BPM with a tempo change mid-bar → our grid follows within 0 samples).
**Gate:** pluginval clean, bounce parity, host-tempo-change test. **Victor's pass:** run it on a track in Ableton next to his own DAW-made beat.

*Product note: this is a second SKU from one codebase — the standalone DAW for making the beat, the plugin for using Terminator inside the DAW people already produce in.*

---

## TESTING STRATEGY (cross-phase)
1. **Golden renders**: `tests/fixtures/*.tproj` (20+ of Victor's real projects, anonymised) rendered by Electron `exportMaster/exportChops/trackouts` once and stored as reference WAVs; the native `terminator-render` CLI must match within tolerance per feature (−60 dB where algorithms are identical; documented exceptions where native is deliberately better: interpolation, oversampling).
2. **Contract ports**: every `scripts/*.test.mts` listed in the dossiers becomes a Catch2 test with the same assertions (names kept: `drum_timing`, `midi_clock`, `input_q`, `console`, `peak_meter`, `export_flac`, `pad_loop`, `chop_while_playing`, `chop_seq_standalone`, `norm`, `resample_pad`, `bass_synth`, `bass_theory`, `midi_learn`, `record_constraints`→`recording_path`, `stem_mask`, `stems_key`…).
3. **RT safety**: RTSan on every CI test run; allocation counters in debug; a "UI frozen 2 s" harness; buffer-size sweep.
4. **Device matrix**: built-in, his interface, aggregate device, ASIO (Windows machine), Bluetooth (expect graceful), hot-unplug.
5. **Bridge fuzz** + schema versioning tests.
6. **Manual/ear**: the per-phase Victor pass lists — recorded in `docs/native/STATUS.md` with date + verdict (house rule: tell him exactly what to test, wait for confirmation).

## RISKS & MITIGATIONS
| Risk | Mitigation |
|---|---|
| Scope — this is a DAW; months of work | Phases with shippable milestones; Electron app keeps shipping meanwhile (separate repo, separate channel). |
| JUCE webview quirks (WKWebView/WebView2 crashes on reload, file drop, clipboard, audio-free) | Bridge kept thin + typed; webview pointed at the Vite dev server in dev (HMR) so UI iteration stays fast; native fallbacks for dialogs/menus/drag. |
| "Same sound" disputes | Golden renders decide; Blink compressor kernel ported not approximated; Victor's ear pass per phase. |
| Plugin crashes | Out-of-process scan day one; sandboxed hosting scheduled (B11.6); blocklist. |
| ASIO SDK licence / Windows signing | Fetch SDK in CI; buy an OV/EV cert before Phase 9. |
| ORT GPU paths returning garbage | Keep the SNR-vs-CPU probe as a release gate; CPU always the fallback. |
| Two UIs drifting (native repo vs Electron/web) | Accepted by decision (separate build). Keep `EngineClient` identical in shape so back-porting the web app onto it later is a copy, not a rewrite. |
| Victor's time for device passes | Exhaust headless gates first; one consolidated pass per phase. |

## DECISIONS FROM VICTOR (2026-08-22, after reading the plan)
1. **Interface:** Tascam Model 16 (USB: 16 in / 14 out). Terminator supports **however many channels the interface has**; channel enables work **Ableton-style** — Preferences → AUDIO → *Input Config* / *Output Config* dialogs list every mono channel and stereo pair, inputs 1/2 + outputs 1/2 on by default, plus an **Enable all** button (Ableton leaves the rest off by default because every enabled channel costs CPU/bandwidth and clutters pickers — same reason here; one click turns them all on).
2. **Name:** Terminator **3.0** — the native app IS Terminator; the Electron app is retired when native reaches Phase 9.
3. **Swing:** live matches export. More generally: **an export must sound exactly like the session** — same engine code path (the parity principle throughout Part B).
4. **Export formats:** WAV, FLAC and MP3, highest quality available; the export flow is a dialog modelled on Ableton's *Export Audio/Video* (spec in B10 "Export dialog").
5. Hidden engine features (ARP, auto-slice knob, drum-only detector, extra FX): expose them (default accepted). CLAP: later. Windows code-signing cert: at Phase 9.
6. **Preferences** take Ableton's layout as the reference for AUDIO / PLUG-INS / RECORD (specs in B9).
7. **(2026-08-22, during the fourth build session) The mixer + effects bar** — recorded verbatim-in-intent in B4
   "VICTOR'S PHASE-4 BRIEF": accurate summing; all effects rebuilt in JUCE at premium quality; per-track SSL/NEVE/API
   console saturation; Moog analog filter; Lexicon 224 reverb; Pro-Q-4-style EQ; Galaxy tape echo; Distressor
   compressor; SSL 4000 G channel strip; Decapitator-style saturator; RC-20-style retro tape with many saturation/
   distortion options; Pro-L-4-style limiter; mid/side everywhere; any-to-any routing with groups/busses and
   multi-select → bus. Phase 4 is budgeted up accordingly.

## NEXT: start the build in a new chat — Phase 0 (see Part C). Kick-off prompt is in the memory note `project_native_build_question.md`.
