# BRIDGE PROTOCOL — WebView ⇄ engine (v1, Phase 1)

The React UI (Phase 2+) and today's static page talk to the C++ shell through JUCE 9's WebView bridge,
using the **official `@juce-framework/webview` package** (`modules/juce_gui_extra/native/typescript/
webview-interop`, ESM, served at `/juce/index.js`). No hand-rolled `window.__JUCE__` plumbing: the page
imports `getNativeFunction` and uses `window.__JUCE__.backend.addEventListener`. The C++ side registers
native functions with `WebBrowserComponent::Options::withNativeFunction` and pushes events with
`emitEventIfBrowserIsVisible`.

Version field: every `terminatorInfo()` reply carries `bridgeProtocol` (integer, **1** since Phase 1). The UI
refuses to run against a protocol it does not know. Bump it whenever a command/event shape changes
incompatibly; add fields freely (additive changes don't bump).

## Transport
| Direction | Mechanism | Threading |
|---|---|---|
| JS → C++ | native functions (Promise-returning): `terminatorInfo()`, `terminatorCommand(cmd)`, `terminatorAudio(req)`, `terminatorMidi(req)`, `terminatorPads(req)` | message thread; engine-bound commands → `Engine::commands().push()` (lock-free) → audio thread at the next block |
| C++ → JS | events `terminator.snapshot` (20 Hz), `terminator.devicesChanged`, `terminator.midiChanged`, `terminator.midiMessage`, `terminator.midiClock` (3.5) | audio thread publishes `StateSnapshot` (wait-free) → message thread reads `Engine::snapshot()` → WebView |

Resources at `WebBrowserComponent::getResourceProviderRoot()` (`juce://juce.backend/` macOS · `https://juce.backend/`
Windows): the **built React UI** (`ui/dist`, bundled into the app at build time, or `TERMINATOR_UI_DIR=<dir>`)
owns `/` and every path under it when present (MIME by extension, no `..`); `/juce/index.js` (the official
`@juce-framework/webview` ESM) is always served; without a built UI the embedded Phase-1 static page is served.
Env `TERMINATOR_UI_URL` overrides the start URL (Vite dev server with HMR). Env `TERMINATOR_PROBE_FILE=<path>` =
headless smoke mode (see tools/ci/probe-app.sh) — the probe also reports `uiMode`, `chopperView`, `errors`
(uncaught page errors collected by a user script), `secureContext`, `audioWorklet`.

## `terminatorInfo()` → object
```json
{ "app": "Terminator", "version": "3.0.0-alpha.0", "juce": "9.0.1", "os": "macOS 15", "arch": "arm64",
  "cpu": "Apple M2", "bridgeProtocol": 1, "maxPads": 128, "chopPads": 64, "drumPadBase": 64, "drumLanes": 64, "bassPpq": 96, "bassMaxBars": 8, "bassMaxVoices": 8,
  "maxVoices": 256, "settingsFile": "…/Terminator3/settings.json", "device": { …see Device object… } }
```

## `terminatorCommand(cmd)` → `{ "ok": true }` | `{ "ok": false, "error": "…" }`
`cmd.type` selects the engine `CommandType` (engine/include/terminator/core/Command.h):

| `type` | fields | engine |
|---|---|---|
| `setMasterGain` | `gain` 0..4 | one-block linear ramp |
| `setTestTone` | `enabled`, `frequencyHz` (440), `amplitude` 0..1 (0.25), `outputPair` (0) | sine on outs 2p+1/2p+2 |
| `transportPlay` / `transportStop` | — | playhead counter |
| `panic` | — | stop + 3 ms fade on every voice, tone off |
| `triggerPad` | `pad` (0..63 the chopper grid · 64..127 the drum lanes, Phase 3.3), `velocity` 0..1, `atSample`? (an ENGINE sample position — the page's `NativeClock` maps a ctx time to it), `pan`? −1..1 (this hit's pan — a drum lane's PAN; overrides `setPadParams.pan`) | starts a voice at the next block (one-block latency; MIDI keeps intra-block offsets); with `atSample` it fires sample-exact at that position — inside the current block at its offset, past it the engine BOOKS it (a 64-slot RT ring, `Engine::bookTrigger`) and fires it in the block that contains it (Phase 3.2: quantized live-record hits, "quantize what I hear" with no timer jitter). Every live trigger (this, MIDI) also stamps the pad's `liveHitSample` for the chop sequencer's one-owner rule |
| `releasePad` | `pad`, `atSample`? | note-off (gate pads release over max(5 ms, release); one-shots ignore); `atSample` books it like `triggerPad` |
| `stopPad` | `pad` | 3 ms fade on that pad's voices |
| `setNoteMap` | `note` 0..127, `pad` (−1 = unmapped) | MIDI note → pad table (default note−36) |
| `setPadParams` | `pad`, `pitch` ±48 (pad PITCH ±24 + its source's PITCH ±24, summed by the UI), `fine` ±50, `attack` 0..0.5, `release` 0..0.5, `fadeOut` (one-shot/gate: linear to silence over the LAST fadeOut seconds of the region, buffer time; LOOP pads ignore it — their fades are in the render), `gain` 0..4, `outputPair`, `mode` oneshot|gate|loop, `gate` bool (NOTE ON: note-off ends the voice in ANY mode — a gated LOOP loops while held; `mode: gate` implies it), `reverse`, `chokeGroup` (−1 own pad · −2 poly · ≥0 group), `interpolation` hermite|linear, `pan` −1..1 (the Web Audio StereoPanner law — mono equal-power cos/sin, stereo side-mix; exactly 0 = no panner, unity on both; default 0), `chokeFade` seconds (the fade a hit of THIS pad applies when it cuts — retrigger / mute group — and stopPad's fade: pads 0.003, drum lanes 0.004; default 0.003), `strip` (4.1: the MIXER strip index the pad's voices sum into — 64-bit — instead of `outputPair`; −1 / absent = the direct path to the hardware pair, the Phase-1..3 behaviour) | RT pad params |
| `setPadSample` | `pad`, `key` (a `terminatorSamples` key; "" / missing = clear), `startSec`, `endSec` (≤ 0 = to the end) — seconds of THAT buffer | binds the pad to a region of an uploaded/loaded buffer (`SampleRegistry` → `Command::setPadSample`); clearing also drops the pad's loop render |
| `setSequence` / `queueSequence` | `index`, `bars` 1..4, `resolution` (stored steps/bar), `grid` [[pads]…] per stored step (null/[] = empty), `velGrid` [[0.05..1]…] aligned, `loop`, `swing` 0..1 | the chop sequencer on the sample clock (Phase 3.1, `core/ChopSequencer.h`): the shell builds a `SeqPattern` (grid bit masks + per-cell velocity) and hands it by pointer (a ring keeps the last 8 alive). `setSequence` = live replace (steps not fired yet read it); `queueSequence` = switch at the next step 0; `queueSequence {cancel: true}` = drop a pending switch (the UI re-selected the playing pattern; no-op when stopped). **One owner per hit** (Phase 3.2): a pattern hit whose pad was LIVE-triggered within 120 ms of it (before or after — `Engine::liveHitSample_`, stamped by `triggerPad`/MIDI) is skipped at fire time (`seqHitsSkipped` counts them) — the TS `lastLivePadHit` rule, in RT code |
| `midiClockEnable` {`on`} | — | **MIDI clock OUT (Phase 3.5, `core/MidiClock.h`)** — Preferences "MIDI Clock (send)"; the shell sends it from `app.midi.clock` at boot + on every settings change. On: the clock rides the transport — `seqPlay` (or `drumPlay` when nothing else runs) → Song Position 0 + START + the first tick AT the anchor sample, then 24 ticks per quarter note with the spacing re-read per tick from `setBpm` (a tempo change lands at the next tick, continuous), `seqPause` → STOP, `seqResume` → Song Position (ticks/6) + CONTINUE, `seqStop` / `drumStop` (nothing left playing) / `panic` / a self-stopping non-loop pattern → STOP; a restart = STOP, SPP 0, START. Off while running = STOP now. Every byte is generated INSIDE the callback at its exact sample, stamped with the host time that sample is HEARD (block entry + offset + the device's output latency) and sent by the MidiHub pump thread at that time to every output left on (`app.midi.outputs`, missing = on). Gates: `engine.midi clock*` (the Electron midi-clock / midi-clock-in gates ported to samples + block invariance + 10 min + pause/resume + the Engine wiring + the OUT→IN loopback) |
| `setMidiRouting` {`pads`} | — | **Phase 3.5:** `pads: true` (default) = MIDI notes play pads on the engine's direct driver→engine path (note → `setNoteMap` table); `false` = the page owns the notes (bass MIDI IN, DRUM PADS mode, MIDI OFF, pad learn) — the engine only MIRRORS them (`terminator.midiMessage`) and the page routes. The page's `ChopperEngine.midiSink` pushes it (+ the learned note map via `setNoteMap`, pads ≥ 64 → unmapped: those are drum lanes natively) |
| `setMetronome` {`enabled`, `sound` click\|hihat\|rimshot\|kick\|clap} | — | **the METRONOME (Phase 3.6, `core/Metronome.h`)** — the five TS click graphs synthesised in the callback at their exact sample; the beats ride the DRIVING sequencer's own grid (the chop sequencer while it plays — paused = silent; else the drums alone, 96/bar): every step a sequencer schedules tells the metronome its grid time + duration and the beats inside it are placed from that, so a tempo change can never put a click off the pattern (the TS walker re-read 60/bpm per beat and could sit 125 ms off the step after a change); accent on beat 0 of the bar; METRO on mid-play → the next beat; off drops the booked beats; stop/pause/restart drop them too. `setBpm` feeds the count-in beat. The clicks bypass the master gain (the TS clicks went straight to the destination; Phase 4 routes them to the mixer's CLICK bus). Gates: `engine.metronome*` |
| `countIn` {`beats` 1..16, `atSample`? 0 = the block start} · `cancelCountIn` | — | **the COUNT-IN (3.6):** `beats` clicks from `atSample` a beat (60/`setBpm`) apart, the first accented, regardless of METRO; the snapshot publishes `countInBeat` (N..1, −1 idle), `countInPending`, `countInDownbeatSample` = atSample + beats·beat — the sample the page starts the transport at (`seqPlay {atSample: that}` → its beat 0 is ONE click: the regular train is silent until the downbeat, a beat within 5 ms before it IS the downbeat). Replaces a pending count-in; `cancelCountIn` drops the rest (the TS cancelCountIn) |
| `setArp` {`enabled`, `rate` 1\|2\|4\|8 (note divisor), `direction` up\|down, `random`, `padCount` (the bank the arp walks; 0 = the 64-pad grid)} · `arpHold` {`pad` 0..63, `velocity`, `atSample`? 0 = next block} · `arpRelease` {`pad`, −1 = whatever is held} | — | **the ARP (3.6, `core/Arp.h`):** holding a pad steps through the bank every 60/bpm/rate from the hold sample (UP = (hold+step) mod padCount, DOWN = (hold−step), RANDOM seeded) at the held velocity, each step a live hit through the Sampler (mute group / retrigger rules, the one-owner stamp); the held pad's release stops it; a tempo change lands at the next step with the phase kept; `setArp enabled:false` stops a held arp; `arpHold` with the arp off = a plain trigger. A MIDI note on the DIRECT path holds/releases it when the arp is on. Gates: `engine.arp*` |
| `mixerSetStrip` {`strip` 0..63, `kind` off\|channel\|send\|bus} | — | **the MIXER (Phase 4.1, `core/Mixer.h`)** — a fixed pool of 64 strips by INDEX (0 = the master, always; the page names the rest — `native/nativeMixerShadow.ts`: sample 1 · kick 2 · snare 3 · hat 4 · openhat 5 · perc 6 · bass 7 · send1..4 8..11 · CLICK 12 · `sampleN` / user lanes 13.. on demand). A strip = its 64-bit input accumulator → [inserts — 4.2] → M/S width → fader → mute → pan → output; `off` drops what is routed to it and keeps its settings. Gates: `engine.mixer*` |
| `mixerSetFader` {`strip`, `db` −60 (= −∞, exact 0) .. +6} · `mixerSetPan` {`strip`, `pan` −1..1} · `mixerSetWidth` {`strip`, `width` 0..2} · `mixerSetMute` {`strip`, `on`} · `mixerSetSolo` {`strip`, `on`} | — | the strip's settings: the fader taper (`10^(dB/20)`, ≤ −59.5 snaps to silence), the Web Audio StereoPanner STEREO law (pan 0 = identity, bit-exact; the master has no pan), M/S width (1 = identity, bit-exact), the mute/solo law computed in the engine (silent = mute \|\| (anySolo && !solo), over every non-master strip; the master has no solo). Every move glides with the TS τ 8 ms (one-pole in closed form at the block end, linear inside the block, snapped within 1e-6 so −60 dB is exact silence and 0 dB exactly unity again) |
| `mixerSetSend` {`strip`, `send` 0..3, `db` −60 (off) .. +6, `target` strip \| −1} | — | a post-fader/mute/pan send into `target` (the send1..4 returns by convention; any strip works); a `target` that is the strip itself, the master, or would close a loop is REFUSED (`mixer.rejected`++, the level still applies) |
| `mixerSetOutput` {`strip`, `to` master\|strip\|hardware\|none, `index` the strip / the hardware PAIR (0 = outs 1/2, 1 = outs 3/4, …)} · `mixerSetMainOut` {`pair`} | — | the FREE routing graph: any strip → the master / another strip (a bus — `kind: bus`; chains of buses; multi-select → bus is this + the page's gesture) / a hardware pair direct (post-fader, never the master) / nowhere (sends only). Strips process in dependency order (a topological sort rebuilt on every routing change); a loop / itself is REFUSED (`mixer.rejected`++); the master's own pair = `mixerSetMainOut` |
| `mixerSetConsole` {`on`, `flavour` "SSL"\|"NEVE"\|"API", `amount` 0..100} · `mixerSetStrip` now takes `seed`? (the CONSOLE seed = the page's FNV-1a of the strip NAME; absent / 0 = leave) · `mixerSetLimiter` {`on`} | — | **CONSOLE (4.2c, `core/fx/ConsoleStage.h`)** — the page's analog-desk separation stage between every live strip's input and its inserts (role CHANNEL, six mulberry32 tolerances from the strip's seed — the page seeds by NAME, so "kick" is the same kick live and in an export) and on the master (role BUS, zero tolerances): HPF → shelves → presence → 1-pole LP → the bounded 2nd+3rd-order saturator → a 5 Hz DC blocker; zero latency; AMOUNT glides 1/1024 per frame; on/off global (the page's `MixerEngine.setConsole`). **The master's safety limiter** (`mixerSetLimiter`) = the page's DynamicsCompressor −1 dBFS / knee 0 / 20:1 / 1 ms / 50 ms on Blink's kernel (look-ahead int(0.006·sr) = the master's latency; its perceptual makeup lifts the mix +0.57 dB; ~+0.2 dBFS through on a +6 dBFS sine — not a brickwall, exactly the page's); OFF by default in the engine (tests keep a bit-exact master), the page shadow turns it on at attach. Gates: `engine.console*`, `engine.master limiter*` |
| `loudnessReset` | — | **METERS (4.3)** — the master's BS.1770-4 / EBU R128 meter (the page's loudness-meter worklet natively: K-weighting from the spec's analogue prototypes at the rate, 100 ms hops, M 400 ms / S 3 s / I gated −70 abs −10 rel / LRA 10th→95th −20 rel / true peak 4 × 12-tap Kaiser sinc / correlation) runs on the master output post limiter; `loudnessReset` = the popup's RESET (integrated + LRA + the holds). The snapshot `mixer.loudness` {m, s, i, lra, peakL, peakR, tpL, tpR, corr, holdPeak, holdTp, maxM, maxS, hops} (−1000 = −∞), `mixer.fxGr` {"<strip>": [GR dB per insert slot, 0 for a non-dynamics device]} for the live strips with a chain, `mixer.limiterGr`. The page reads them through `setMixerNativeMeters` (strip peaks from the rows, the master's loudness, the SC COMP's GR) while the shadow is attached. Gates: `engine.loudness*` |
| `mixerAddFx` {`strip`, `fx` the page's FxId} · `mixerRemoveFx` {`strip`, `index`} · `mixerSetFxBypass` {`strip`, `index`, `on`} · `mixerSetFxParam` {`strip`, `index`, `fx`, `key`, `value` number \| option string, `immediate`?} · `mixerReorderFx` {`strip`, `from`, `to`} · `mixerClearFx` {`strip`} | — | **the INSERT CHAIN (Phase 4.2, `core/fx/Effect.h` + `core/fx/FxPool.h`)** — ≤ 8 devices per strip (the master = strip 0), in order, between the strip's input and its width/fader; bypass = dry (bit-exact); a device with a WET param crossfades (dry 1−mix + wet mix). Params by the page's KEY (the engine's table = FX_REGISTRY's ids / ranges / defaults; enum params by their option string), FX glide τ 10 ms unless `immediate` (a restore / the first set). Every instance comes from a pool built at prepare (RT: pointers only); a full chain / a dead strip / an exhausted pool = refused (`mixer.fxRejected`++). An UNKNOWN type takes its slot as a PASS-THROUGH placeholder reporting the type (the indices stay aligned — no page type is unported after 4.2b). **Ported (4.2a): `utility` (GAIN −20..20, MODE STEREO\|MONO\|MONO-L\|MONO-R, PHASE normal\|inverted) · `eq` (LOW/MID/HIGH ±12: low shelf 80 Hz · bell 1 kHz Q 0.8 · high shelf 12 kHz) · `filter` (TYPE lowpass\|highpass\|bandpass\|notch, CUTOFF 20..20000, RESO 0..30 — Q in dB for LP/HP, linear for BP/notch, the Web Audio convention) · `wide` (WIDTH 0..200) · `mseq` (MID_HZ/MID_DB/SIDE_HZ/SIDE_DB, peaking Q 1 on M and S) · `pan` (RATE 0.1..10, DEPTH 0..100 — a sine LFO on the StereoPanner law)** — the Web Audio BiquadFilterNode maths in double (a 0 dB shelf/bell is a bit-exact pass-through). **Ported (4.2b, `core/fx/ShaperFx.h` · `ModFx.h` · `DynamicsFx.h` · `ReverbFx.h`): `clip` (AMT) · `wave` (DRIVE) · `sat` (DRIVE) · `mbsat` (LOW/MID/HIGH/LO_X/HI_X/WET — blends INTERNALLY with a phase- and latency-matched dry leg) — the page's curves at 4× through a two-stage polyphase halfband oversampler (group delay 55 samples, reported by the device) · `phaser` (RATE/DEPTH/CENTER/FEEDBACK/STAGES 4\|6\|8\|12/WET) · `flanger` (RATE/DEPTH/DELAY/FEEDBACK/WET) · `vinyl` (WARMTH/DRIVE/WOW/FLUTTER/AGE — latency 5 ms + 55) · `delay` (TIME/FEEDBACK/WET/PINGPONG) · `comp` (STYLE OFF\|LIGHT\|PUNCHY\|NY-PARALLEL\|AGGRESSIVE — picking one sets the five knobs + the NY blend; THRESHOLD/RATIO/ATTACK/RELEASE/MAKEUP) = a port of Blink's DynamicsCompressorKernel, look-ahead int(0.006·sr) samples (288 at 48 k) = its latency, the dry leg of NY-PARALLEL delayed to match · `sccomp` (**SOURCE = the key STRIP's INDEX, −1 = NONE** — the page's value is a channel NAME; the page shadow maps it before sending; the key is that strip's PRE-insert input; THRESH/RATIO/ATTACK/RELEASE/HOLD/MAKEUP/KEYHP) = the sc-comp worklet · `reverb` (ROOM/PREDELAY/DECAY/WET — the seeded IR, Blink's normalisation, built incrementally on the audio thread then crossfaded in 60 ms; zero latency).** A param change on a numeric param with a STRING value is refused (`unknown option`). Gates: `engine.fx*` |
| `setSourceStrip` {`source` bass\|click, `strip` \| −1} | — | the bass synth / the metronome (click + count-in) sum into that strip (−1 = the Phase-3 direct path: the bass dry into outs 1/2, the click post master gain). The page routes the bass to 'bass' and the click to strip 12 (a native-only CLICK strip at 0 dB until the UI grows its fader — the click rides the mix now instead of bypassing it) |
| `seqPlay` {`atSample`? 0 = next block} · `seqStop` · `seqPause` · `seqResume` · `setBpm` {`bpm` 20..300, applies at the next step} · `seqLoop` {`on`} | — | transport of the native chop sequencer; swing is applied LIVE (= export); a hit ends (3 ms fade ending AT it) at the next same-mute-group hit (choke group ≥ 0) or its own next hit (own-pad / poly), else the pattern end; pause fades the sequencer's notes and keeps the unfired hits; loop off stops after the last slot |
| `setDrumPattern` / `scheduleDrumPattern` | `bars` 1..4, `stepsPerBar` (96 — INTERNAL_SPB; ≤ 96), `lanes` [{`lane` 0..63, `steps` [internal step indices lit]}], `scheduleDrumPattern` + `atSample` (an ENGINE sample) | **the drum sequencer (Phase 3.3, `core/DrumSequencer.h`)** — the grid by pointer (a ring of 48 keeps them alive). `setDrumPattern` = the live pattern (a step not scheduled yet reads it — the engine schedules ≤ 110 ms ahead because SHIFT may be negative); `scheduleDrumPattern` = an arranged-playback SWAP: a step whose straight grid time + half a step ≥ `atSample` plays it (the TS `patternFor` half-step tolerance); `clearDrumPatterns` drops the swap list. The pattern ALWAYS loops. Lane L plays pad 64+L (bind it with `setPadSample`/`setPadParams` like any pad: attack 0 / 3 ms per the head rule, `chokeFade` 0.004, `chokeGroup` 1000+g for mute group g) |
| `setDrumGraphs` | `lanes` [{`lane`, `velocity` [0..1 × ≤ 384], `shift` [ms ±50], `pan` [−1..1], `repeat` [0..12 = REPEAT_RATES index]}] | the four step graphs (engine-level, shared by every pattern, indexed by internal step) by pointer (ring of 4). Per hit: level = lane volume × VELOCITY × drum master; SHIFT snapped to the PPQ pulse (`round(shift/pulse)·pulse`, JS rounding); PAN per hit; REPEAT = a roll every `beats × 60/bpm` from the swung+shifted hit until the step's STRAIGHT slot end, each sub-hit fading (the lane's 4 ms) INTO the next — sub-hits cut nothing and are cut by nothing but their own end |
| `setDrumLane` | `lane`, `volume` 0..1, `audible` (mute + solo resolved by the UI), `group` (0 none · ≥1 mute group) | one lane's state |
| `setDrumParams` | `swing` 0..1 (on the step's 16th slot — the shared swing formula), `masterVolume` 0..1, `ppq` 24..960 | engine-level drum params |
| `drumPlay` {`atSample`? 0 = next block, `stepOffset`? the internal step landing on the anchor — the arranger's seek} · `drumStop` | — | the drum transport (the drums share `setBpm`); `drumStop` fades every lane voice (4 ms). Mute groups cut by TIME ORDER at the hit's sample (a group mate starting at the SAME sample layers — the documented `muteGroups.ts` rule); **one owner per hit**: a lane live-triggered (`triggerPad` pad 64+L / MIDI) within 120 ms of a pattern hit owns it (`drumHitsSkipped`) |
| `setBassPatch` | `patch` — the BassEngine `BassPatch` object (partial ok: deep-merged over the worklet's defaults — `osc[3]{on,wave,octave,semi,fine,level,pw,morph}`, `sub{level,wave,octave}`, `noise{level,color}`, `mixerDrive`, `filter{model,mode,cutoff,reso,envAmt,kbd,poles,drive}`, `filtEnv/ampEnv{a,d,s,r}`, `lfo{rate,wave,toCutoff,toPitch}`, `modSrc{lfo[3]{rate,wave,key},trig[2]{ramp,fall,shape}}`, `mods[{src,target,depth}]` (target = the knob's dotted path, unknown paths ignored; `mods` replaces wholesale), `glide`, `legato`, `voices` 1..8, `drift`, `velAmp`, `velFilt`, `post{drive,tone,glue,gain}`) | **the bass synth (Phase 3.4, `core/BassSynth.h`)** — the `bass-synth` worklet ported 1:1 (same equations/constants), by pointer (ring of 8). Renders in 128-sample quanta aligned to sample 0 (block-size invariant), dry into outs 1/2 until Phase 4 |
| `setBassPattern` | `bars` 1..8, `notes` [{`id`, `note` 0..127, `start` beats, `dur` beats, `vel` 0.05..1, `slide`?}], `bend`? [semitones per PPQ-96 tick, bars×384 long; [] = no lane] | **the bass sequencer (`core/BassSequencer.h`)**: the roll's pattern as the engine's tick map (on = round(start·96), off = round((start+dur)·96) ≥ on+1, an off past the loop fires at its wrap; a slide note bends what sounds over `dur`; the lane posts per tick when it moved > 0.002 st). Live replace: sounding notes whose pitch changed / off vanished are released, the next ticks read the new map (the TS "+8va stuck note" rule). Ring of 16 |
| `setBassTimeline` | `events` [{`kind` on\|off\|slide\|bend, `atSample` (an ENGINE sample), `note`, `vel`, `dur` (slide seconds), `semis`}] | the arranger's `playTimeline` as absolute events (sorted by sample, pushed into the synth as their block comes; ring of 4). `clearBassTimeline` drops it, releases the `arr` notes, bend 0 |
| `bassPlay` {`atSample`? 0 = next block, `offsetTicks`? the absolute tick landing on the anchor} · `bassStop` · `bassArrangerDriven` {`on`} · `bassBendLane` {`on`} | — | the bass transport (shares `setBpm`; tickDur = 60/bpm/96 re-read per tick). `bassStop` releases the seq notes + bend 0 (a lane never leaves the synth bent). `bassArrangerDriven` = the pattern ticks stay quiet while the arranger drives (`mutedByArranger`); `bassBendLane false` = the wheel owns the lane while ● REC |
| `bassNote` {`on`, `note`, `velocity`, `atSample`? 0 = now, `tag`? seq\|live\|arr\|prev\|x (default live)} · `bassSlide` {`note`, `dur` s, `atSample`?, `tag`?} · `bassBend` {`semis`, `atSample`? (0 / the past = the wheel NOW; a future sample = a timed bend queued with the notes), `tag`?} · `bassMod` {`value` 0..1} · `bassClear` {`tag`? any, `release`? true} · `bassPanic` | — | the worklet's messages one-to-one: a live / preview / MPC note (mono last-note priority + legato + glide or poly), FL-style slides, the wheel, the mod wheel, clear-a-tag (drop pending, optionally release), panic (kill every voice). Events land sample-exact at `atSample` (a 512-slot RT ring; `bassEventsDropped` counts refusals) |
| `setPadLoop` | `pad`, `key`, `startSec`, `endSec`, `fadeInSec`, `fadeOutSec`, `reverse` — or `clear: true` | the shell renders the region's crossfade loop (`render::renderPadLoop`, reverse baked in — the same code the offline renderer uses) into a fresh store buffer and attaches it (`setPadLoopBuffer`); no fades → detached (raw hard-wrap). The old render is retired through the quarantine |
| `setPadLoopBuffer` *(engine-internal, not a JSON verb)* | `pad`, loop buffer + steady `[loopStart,loopEnd)` frames | attaches a pre-rendered crossfade loop (`loop::renderCrossfadeLoop`) so a LOOP pad plays a seamless period; the shell renders it on the loader thread when a pad's fades/region change (Phase 2.3). Null clears it → raw hard-wrap of the region |
| `setPadStems` *(engine-internal, not a JSON verb)* | `pad`, `planes[4]` (drums/bass/other/vocals SampleBuffers, each the base buffer's length/rate; null = absent), `mask` 4-bit | attaches the pad's decoded stem planes + mask (Phase 2.3 stems-in-the-voice). A voice with a partial mask SUMS its lit planes while reading (= `mixMaskChannels`); mask 0/15, no planes, or a lit plane missing → the ORIGINAL plays (never silence). Arriving while the pad rings = a LIVE re-stem: a twin voice at the same position/rate/envelope reads the new set with a 12 ms linear fade-in while the old one fades out over 12 ms (`restemVoice`). Send after `setPadSample` (a new sample clears the planes; the mask stays) |

Refused with `ok:false` when: not an object, unknown `type`, or the command queue is full (1023 pending —
a UI bug, never expected).

## `terminatorAudio(req)` — Preferences → AUDIO (Ableton-style)
`req.verb`: `list` (default; `forType` lists devices of another driver type) · `apply` {`deviceType`,
`inputDevice`, `outputDevice`, `sampleRate`, `bufferSize`, `inputChannels[]`, `outputChannels[]`} (saved to
settings.json) · `enableAll` (every channel of the current devices) · `default` (default output, no inputs) ·
`calibrate` {`outputChannel`, `inputChannel`} → emits a 64-frame click, records 1 s, cross-correlates on the
message thread, result arrives in the snapshot (`calibrationState` 2 + `calibrationSamples/Ms`) and in the
Device object; stored in settings `calibration.*` · `clock` → `{ ok, hostNs, clockHostNs, clockSample,
sampleRate, prepared, outputLatencyMs }` — the page's `NativeClock` (Phase 3.2, `ui/src/renderer/native/nativeClock.ts`)
calibrates host time ↔ `performance.now()` by round trip (best RTT wins; `hostNs` = `juce::Time::getHighResolutionTicks`
in ns, the clock the audio callback stamps every block with) and reads the last block's host ↔ sample anchor.
Reply: `{ ok, error?, deviceTypes[], currentType, listType, inputDevices[], outputDevices[], device }`.

### Device object
```json
{ "type": "CoreAudio", "inputDevice": "Model 16", "outputDevice": "Model 16", "sampleRate": 48000, "bufferSize": 64,
  "inputs": 2, "outputs": 2, "inputLatencySamples": 90, "outputLatencySamples": 122, "inputLatencyMs": 1.9,
  "outputLatencyMs": 2.5, "open": true, "error": "", "inputChannelNames": ["Input 1", …], "outputChannelNames": […],
  "activeInputChannels": [0,1], "activeOutputChannels": [0,1], "availableSampleRates": [44100, 48000, …],
  "availableBufferSizes": [32, 64, …], "xruns": 0, "cpuLoad": 0.03,
  "calibrationSamples": 231, "calibrationMs": 4.81, "calibrationReportedSamples": 212 }
```
(`calibrationSamples` −1 = not measured · −2 channel out of range · −3 nothing heard.)

## `terminatorMidi(req)`
`verb`: `list` (default) · `enable` {`id`, `enabled`} · `enableAll` · `refresh` · `enableOutput` {`id`, `enabled`}
(3.5: persists into the page's `app.midi.outputs` map + broadcasts `settingsChanged`) · `inject` {`note`, `velocity`,
`on`, `channel`} or {`data`: [bytes]} (tests / the probe: as if it arrived on port 0 — notes, CCs, START/STOP/clock
ticks). Reply `{ ok, error?, inputs:[{id, name, enabled, open}], outputs:[{id, name, enabled, open}] (3.5; enabled =
not turned off — missing from the map = on), messages, lastLagMs, medianLagMs, last, clock:{enabled, running, ticks,
sent, lateMs, maxLateMs, inBpm, inPort, inStarted} }`. Enabled inputs persisted in settings `midi.inputs`.
Engine side: every channel message is stamped with the shared host clock minus the driver→handler lag and pushed
into the port's lock-free queue; the audio thread maps note-on/off through the note map when `setMidiRouting` allows
(default on). **3.5:** clock ticks (0xF8) stay on the driver thread — `MidiClockSourceLock` (the port that sent
START/CONTINUE owns the clock until its STOP; the same press on another port within 500 ms is ignored; other ports'
ticks are dropped) + `MidiClockFollower` (the Electron estimator 1:1 on the DRIVER's timestamps) → `terminator.midiClock`
reports; START/CONTINUE (when the lock accepts) / STOP and every other message are mirrored as `terminator.midiMessage`.
Active sensing is dropped. MIDI OUT: a high-priority pump thread drains `Engine::midiOut()` and sends each message at
its host-time stamp (sleeps to ~1.5 ms before, spins the rest; a stamp in the past goes out at once) to every open
output.

## `terminatorPads(req)`
`verb`: `list` (default) → `{ ok, pads:[{pad, hasSample, name, file, frames, sampleRate, channels, pitch, fine,
attack, release, gain, outputPair, mode, reverse, chokeGroup}], samplesLive, bytesLive }` · `choose` {`pad`}
(native file chooser → decode on the message thread → `SampleStore` → `setPadSample`) · `loadFile` {`pad`,
`path`} · `clear` {`pad`}. Previous samples are retired through the quarantine (SampleStore) — never freed
while a voice could still read them.

## `terminatorSamples(req)` — the page's audio into the SampleStore (Phase 2.5, EngineClient shadow)
The bridge carries JSON only, so decoded audio the page holds (Web Audio `AudioBuffer`s — the main track, pad
sources, stem-mix slices) travels as **chunked base64 float32**; files the shell can read itself go by PATH.
Keys are page-chosen, single-use strings (`main:N` / `src:N` / `probe:N`); the shell keeps key → store id.
- `begin` {`key`, `sampleRate`, `channels` 1..32, `frames`} → allocates (cap 400 M floats) · `chunk` {`key`,
  `offset` frames, `data` base64 of INTERLEAVED float32 frames} → de-interleaved into the planar buffer ·
  `end` {`key`} → installs into the `SampleStore` (refused if frames are missing) → `{ ok, key, frames, sampleRate,
  channels, durationSec }` · `loadFile` {`key`, `path`} → decode natively (SampleLoader) → same reply ·
  `release` {`key`} → every pad bound to it is unbound first (sample + loop render), then the buffer is retired
  through the quarantine · `list`/`stats` → `{ keys:[…], pads:[{pad,key,loop}], pending, chunks, bytes,
  storeLive, storeRetired, storeBytes }`.
- The UI side is `ui/src/renderer/native/nativeEngineShadow.ts`: uploads once per AudioBuffer (3 MB float32 chunks
  ≈ 4 MB base64 each, base64 via FileReader off the main thread), refcounts keys across pads, releases unreferenced
  buffers after a 2 s grace; `setPadSample`/`setPadParams`/`setPadLoop` are diffed per pad and sent in order; a
  hit re-syncs its pad synchronously before `triggerPad`. A 4-minute 44.1k stereo song ≈ 42 MB float32 → ≈ 14
  chunks, ~1–2 s, pads on that buffer wait for `end` before their first native hit.

## `terminatorProcess(req)` — the bundled command-line tools as child processes (2.5c YouTube import)
`spawn` {`id`, `tool`:"ytdlp", `args`:[…]} → {ok} — the ONLY executables are the bundled ones (`tool` is a name,
never a path; unknown tool → refused); for yt-dlp the shell prepends `--no-update` + `--js-runtimes quickjs:<bundled
qjs dir>` (additive: a deno on the machine still ranks first) · `kill` {`id`} · `list` → {running:[ids]} · `tools` →
{`ytdlp`, `qjs`, `ytdlpDir`, `qjsDir`, `binDir`} ('' when not bundled). Events: `terminator.processOutput` {`id`,
`data`} (merged stdout+stderr, ≤ 8 KB per event — emitEvent's escape is quadratic) · `terminator.processExit`
{`id`, `code`}. At most 16 concurrent children; a reader thread per child; the hub kills every child on quit.
The tools ride in the app: macOS `Contents/Resources/bin/{ytdlp/yt-dlp_macos + _internal/, qjs/qjs}` (qjs universal
via lipo), Windows `<exe>/bin/{ytdlp/yt-dlp.exe + _internal/, qjs/qjs.exe}` — `cmake/ProvisionTools.cmake`, pinned
yt-dlp nightly `2026.08.16.020253` (the Electron pin) + quickjs-ng `v0.16.2`, SHA-256 verified, cached in
`third_party/.tools-cache`; `-DTERMINATOR_BUNDLE_TOOLS=OFF` skips it. The page side is
`ui/src/renderer/native/processBridge.ts` + `youtubeNative.ts` (the Electron youtubeDownloader.ts ported) and the
library's YouTube job + `downloadYouTube` pull in `libraryNative.ts`. `dirs` (terminatorFs / boot) now carries `temp`.

## `terminatorFs(req)` — the `window.terminator` shim's file/dialog backend (Phase 2.4b)
Generic, message-thread verbs the React app composes into the Electron-era IPC surface in
`ui/src/renderer/native/ipc-native.ts` (projects, recents, EULA, layout/MIDI-map/bass-patch files, presets, the
session autosave). `req.verb`:
| verb | fields | reply |
|---|---|---|
| `dirs` | — | `{ ok, dataDir, projectsDir, projectsIsDefault, settingsFile, home, music, sep }` (`dataDir` = `<userApplicationData>/Terminator3`; `projectsDir` = settings `app.projectsDir` or `<dataDir>/projects`) |
| `readText` | `path` (absolute, ≤ 64 MB) | `{ ok, text, path, name }` |
| `writeText` | `path`, `text` | atomic write, parent folders created → `{ ok, path, name }` |
| `exists` | `path` | `{ ok, exists, isDir }` |
| `list` | `dir`, `exts?` (`[".tproj"]`) | `{ ok, entries: [{ name, fileName, path, isDir, size, modifiedAt(ms) }] }` (dot-files skipped) |
| `mkdir` | `path` | `{ ok }` |
| `trash` | `path` | moves to the Trash (never unlinks) → `{ ok }` |
| `reveal` | `path` | Finder / Explorer reveal |
| `openExternal` | `url` (http(s)/mailto only) | default browser |
| `openDialog` | `title?`, `dir?`, `filters?` (`"*.tproj;*.tprojz"`), `mode` file\|dir, `multiple?` | `{ ok, path, paths }` or `{ ok, cancelled: true }` (native `FileChooser`, one at a time) |
| `saveDialog` | `title?`, `dir?`, `defaultName?`, `filters?` | `{ ok, path }` or `{ ok, cancelled: true }` |
| `clipboardReadText` | — | `{ ok, text }` |
Paths must be absolute; relative or over-long paths are refused. Errors: `{ ok:false, error }`.

**More verbs (2.5 library, 2026-08-22):** `stat` {path} → {exists,isDir,isFile,size,modifiedAt,createdAt} · `move`
{from,to} (rename, across volumes; refuses an existing target / a folder into itself) · `copy` {from,to} (file, or
folder recursively — dot-files skipped) · `writeBinary` {path, data base64, append?} (recordings + WebView drops —
the page holds the bytes; chunked appends from JS) · `openPath` {path} (open a folder in Finder/Explorer) ·
`serveRoots` {roots:[…]} (what `/lib/b64/` may serve — the page's library module registers the library root + its
linked folders after every load/save; nothing is servable before). `list` entries also carry `createdAt`.

`readBinary` {path} → {ok, url:"/blob/<token>", bytes, name} — the file's bytes through the resource provider
(one-shot token, 60 s; `.tprojz` bundles, the asset store, anything big — never bytes through `complete()`).

**Resource URLs the shell serves (GET through the page's origin):** `/lib/b64/<base64url(absolute path)>` → the
file's bytes + MIME, ONLY if it sits under a registered root and exists (else 404 — the probe asserts `/etc/hosts`
is refused); WebKit's `<audio>` preview streams it (probe `audioCanPlay: true`). `/blob/<token>` → a LARGE native-
function reply (see below) or a `readBinary` file stash, one-shot, 60 s expiry.

**LARGE REPLIES (gotcha, found 2026-08-22):** JUCE's `emitEvent` escapes every C++→JS payload into a JS string
literal with `String::replace("\\", …)` — QUADRATIC in the payload; a 230 KB `readText` (library.json) stalled the
message thread for minutes (the whole app froze — the timer, the probe, everything). `ShellServices::maybeLarge`
turns any reply whose JSON exceeds 24 KB into `{ ok:true, __largeReply:"/blob/<token>", bytes }`; `juceBridge.ts`'s
`lazy()` fetches it transparently, so callers never see it. Applied to `readText` and `list`; apply it to any new
verb that can answer big (never send > ~24 KB through `complete()`/`emitEvent`).

## `terminatorSettings(req)` — the UI's settings
`verb`: `get` → `{ ok, settings }` · `set` {`patch`} → shallow-merges into settings.json **`app`** (the Electron
`terminator-settings.json` keys, verbatim — Phase 8 imports that file here), saves, emits
`terminator.settingsChanged` → `{ ok, settings }`. `app.eula`, `app.recentProjects`, `app.projectsDir` live here.

## `terminatorWindow(req)` — windows
`verb`: `preferences` → opens (or fronts) the **Preferences window**: a second JUCE `DocumentWindow` hosting the
React `preferences/preferences.html` from the same resource provider with the SAME bridge options (one backend,
two pages; events go to both). `closePreferences` hides it. The page swaps its AUDIO/MIDI device UI for the
native panes (`ui/src/renderer/native/NativeAudioPane.tsx` = Ableton layout over `terminatorAudio`,
`NativeMidiPane.tsx` over `terminatorMidi`).

### Boot user script
Before any page script the shell injects `window.__TERMINATOR_BOOT__ = { version, settings, dirs }` so the
synchronous boot reads the Electron preload offered (`getSettingsSync`) work; plus an error collector
(`window.__terminatorErrors`) the probe reads.

## Events (C++ → JS)
### `terminator.snapshot` (20 Hz)
```json
{ "prepared": true, "sampleRate": 48000, "blockSize": 64, "outputs": 2, "inputs": 2, "playing": false,
  "playheadSamples": 0, "blocksProcessed": 1234, "samplesProcessed": 78976, "masterGain": 0.5, "testToneEnabled": false, "testToneFrequencyHz": 440,
  "clockHostNs": 123456789012345, "clockSample": 78464, "clockBlockSize": 512, "emitHostNs": 123456791234567,
  "peakL": 0.0, "peakR": 0.0, "outputPeaks": [0,0], "inputPeaks": [0,0], "commandsApplied": 3, "commandsDropped": 0,
  "cpuLoad": 0.01, "xruns": 0, "activeVoices": 0, "voiceStealing": 0, "padActiveMask": 0, "activePads": [], "lastTriggeredPad": -1,
  "seqPlaying": false, "seqPaused": false, "seqLoop": true, "seqStep": -1, "seqStepCount": 0, "seqPatternIndex": -1,
  "seqStepPhase": 0, "seqBpm": 120, "seqLoopStartSample": 0, "seqHitsFired": 0, "seqHitsSkipped": 0,
  "drumPlaying": false, "drumStep": -1, "drumStepCount": 192, "drumStepPhase": 0, "drumLoopStartSample": 0,
  "drumHitsFired": 0, "drumHitsSkipped": 0, "drumActiveMask": 0,
  "bassPlaying": false, "bassArrangerDriven": false, "bassTick": -1, "bassLoopTicks": 768, "bassLoopStartSample": 0,
  "bassVoices": 0, "bassLevel": 0, "bassNotesFired": 0, "bassEventsDropped": 0, "bassTimelineFired": 0, "bassBend": 0, "bassNotes": [],
  "lastTriggeredPadPositionSec": 0, "calibrationState": 0, "calibrationSamples": -1, "calibrationMs": -1,
  "midiMessages": 0, "midiLagMs": 0, "midiLast": "",
  "midiClockEnabled": false, "midiClockRunning": false, "midiClockTicks": 0, "midiClockPosition": 0, "midiOutDropped": 0,
  "midiNotesToPads": true, "midiSent": 0, "midiSendLateMs": 0, "midiClockInBpm": 0, "midiClockInPort": -1, "midiClockInStarted": false,
  "metronomeEnabled": false, "metronomeSound": 0, "metronomeBeat": -1, "metronomeClicks": 0, "metronomeLastClickSample": 0, "metronomeLastClickAccent": false,
  "countInBeat": -1, "countInPending": false, "countInDownbeatSample": 0,
  "arpEnabled": false, "arpHoldPad": -1, "arpStep": 0, "arpLastPad": -1, "arpHits": 0,
  "mixer": { "active": [0, 1, 2], "silent": [2], "strips": { "0": [0.5, 0.5, 0.5, 0.5, 0.35, 0.35, 1.0, 0], "1": [0.5, 0.5, 0.5, 0.5, 0.35, 0.35, 1.0, 2], "2": [0.1, 0.1, 0, 0, 0.07, 0, 0, 0] },
             "rejected": 0, "fxRejected": 0, "console": false, "limiter": true, "orderValid": true, "mainOut": 0, "bassStrip": 7, "clickStrip": 12 } }
```
`mixer` (4.1): the LIVE strips only — `active` (indices; 0 = the master), `silent` (mute / the solo law, the target),
`strips["<index>"]` = `[preL, preR, postL, postR, rmsPre, rmsPost, gain, fxCount]` = the strip's input peak per channel,
its output peak (post fader/mute/pan), RMS of both (pooled) over the 4096-sample window (the TS peak-meter worklet's),
the smoothed fader × mute gain at the block end (1 = unity; the probe asserts 0 / 1 after a move), and the devices in
its insert chain (4.2); `rejected` = lifetime routes the cycle guard refused, `fxRejected` = lifetime `mixerAddFx`
refusals (full / dead / pool exhausted — the 4.2b caps: utility/eq/filter 64, the light devices 32, the delay-line
devices 16, reverb 6), `orderValid` (false = the fallback order runs — cannot happen with the guard),
`mainOut` = the master's hardware pair, `bassStrip` / `clickStrip` = `setSourceStrip` (−1 = direct); `console` /
`limiter` (4.2c) = the desk stage is in on every live strip / the master's safety limiter is in; `loudness` / `fxGr` /
`limiterGr` (4.3) = the master's BS.1770 reading, the dynamics inserts' gain reduction per slot, the limiter's GR.
`lastLiveHitPad` / `lastLiveHitSample` (3.7): the last LIVE trigger (a `triggerPad` — at its block offset or, with
`atSample`, the booked sample — or a MIDI note on the direct path) — the page's live-record probe compares it to
the grid line it landed the hit on (0 samples at INPUT Q 100).
`metronome*` / `countIn*` / `arp*` (3.6): `metronomeBeat` = the last beat click's index in its bar (0..3), `metronomeClicks`
lifetime (beats + count-in), `metronomeLastClickSample` / `…Accent` = the last click; `countInBeat` = the TS countdown
(N..1 while counting, −1 idle), `countInPending` = between `countIn` and its downbeat, `countInDownbeatSample` = the
sample the transport should start at; `arpHoldPad` (−1 = nothing held), `arpStep` (steps since the hold), `arpLastPad`,
`arpHits` lifetime.
`midiClock*` (3.5): the clock OUT — `midiClockPosition` = ticks since START (÷ 6 = the song position in 16ths),
`midiClockTicks` lifetime, `midiOutDropped` = out-queue refusals (0), `midiSent` / `midiSendLateMs` = the pump's sends
and how late its last one was against the stamp; `midiClockIn*` = the follower's last settled BPM, the owning port, and
whether the hardware's START is in charge.
`clockHostNs`/`clockSample`/`clockBlockSize` = the last processed block's host-time ↔ engine-sample anchor (callback
entry); `emitHostNs` = the host time this snapshot was emitted (a one-way upper bound for the page's host ↔
performance.now offset: receive ≥ emit). With the `clock` verb's round trip these let the page map engine samples ↔
`performance.now()` ↔ AudioContext time at the ear (the chop-seq cursor, the drums/bass/MIDI-clock drift nudge,
`triggerPad{atSample}`) — Phase 3.2, `NativeClock`. `seqHitsSkipped` = pattern hits the one-owner rule skipped.
`drum*` (Phase 3.3): the drum sequencer's position — `drumStep` = the internal step (0..bars×96−1) the playhead is in,
`drumLoopStartSample` = the engine sample of the audible pass's step 0 (signed: a seek can put it before sample 0; the
page's `playStartTime`), `drumActiveMask` bit L = lane L (pad 64+L) sounds; `activePads` lists pads 0..127 (64+ = lanes).
`bass*` (Phase 3.4): the bass sequencer's position — `bassTick` = the PPQ-96 tick (0..bars×384−1) the playhead is in,
`bassLoopStartSample` = the engine sample of the audible pass's tick 0 (signed; the page's `startTime` origin through
NativeClock), `bassVoices` / `bassNotes` (the MIDI notes the synth's voices sound — the roll's dim keys), `bassLevel` =
the UI meter (peak over the last completed 1/30 s window — the worklet's meter semantics), `bassBend` = the current
pitch bend, `bassNotesFired` / `bassTimelineFired` / `bassEventsDropped` counters. `BassSink.elapsedSec` reads the
playhead the same way as the chops/drums (engine position at the ear).
**The page's cursors** (chop + drums) read the ENGINE's position at the ear: `(clock.sampleHeardAtPerfMs(now) −
seqLoopStartSample / drumLoopStartSample) / sampleRate` through NativeClock (`ChopperEngine.nativeCursorHook`,
`DrumSink.elapsedSec`) — not the AudioContext clock (a headless / virtual device runs it fast: CI run 32608087978 read the
ctx cursor 2 steps ahead of the native step). **Anything read out of a snapshot (`seqStep`, `drumStep`, `activePads`)
is as old as the emit + the message thread's scheduling + the WebView delivery** — the shadow measures it
(`stats.snapshotAgeMs`, from `emitHostNs`); a starved CI runner has shown > 100 ms. Never compare a live cursor to a
snapshot field without allowing for that age (the probe derives its tolerance from it).
### `terminator.devicesChanged` (Device object) — hot-plug / device error · `terminator.midiChanged` (MIDI reply) · `terminator.settingsChanged` (the `app` settings object, after a `set`)
### `terminator.midiMessage` {data:[bytes], hostNs, port, portName} — every message a device sent (2.5e → 3.5)
Notes, CCs, pitch bend, aftertouch, program change, and START/CONTINUE/STOP when the clock lock accepted them (clock
ticks + active sensing are never mirrored). The engine already got it on the direct MidiHub → engine path (driver
thread → lock-free queue → audio thread — a note plays its pad when `setMidiRouting` allows); this event mirrors it to
the page on the message thread, where the shadow injects it into the page's `midiHub` (`injectNative`: `timeStamp` =
`hostNs` mapped to performance.now() through NativeClock, `target.id/name` = the port, `nativeOwned: true`) so
ChopperView's ONE router runs unchanged — transport from the hardware, CC learn, bass MIDI IN (with the MPC/MPD pad
fold by port name), DRUM PADS, pad learn, pads (marked `nativeOwned` → no second native trigger). The page has no Web
MIDI inside the WebView. `terminatorMidi {verb:"inject", …}` feeds a message as if it arrived on port 0 — the probe's
MIDI checks (a note, then START/STOP driving the transport + the clock OUT).
### `terminator.midiClock` {bpm, port} — the clock-IN follower settled on a new tempo (3.5)
≤ once per beat, only the owning port's ticks; the page applies Preferences "MIDI Clock (follow tempo)" (and only
while the hardware's START is in charge) → `engine.setMetronomeBpm(bpm)`.

## Project v0 (terminator-render input)
```json
{ "terminatorProject": 0,
  "render":   { "sampleRate": 48000, "blockSize": 512, "channels": 2, "lengthSeconds": 2.0 },
  "master":   { "gain": 0.5 },
  "testTone": { "enabled": false, "frequencyHz": 440, "amplitude": 0.5 },
  "pads":     [ { "pad": 0, "file": "kick.wav", "startFrame": 0, "endFrame": 0, "pitch": 0, "fine": 0, "attack": 0.003,
                  "release": 0, "gain": 1, "outputPair": 0, "mode": "oneshot", "reverse": false, "chokeGroup": -1,
                  "interpolation": "hermite" } ],
  "events":   [ { "pad": 0, "time": 0.5, "velocity": 1.0, "type": "on" } ] }
```
Parsed by `parseRenderSpec` (engine/src/render/OfflineRenderer.cpp); files relative to the project file;
events are placed sample-accurately (`triggerPadAtSample` / `releasePadAtSample`); renders are block-size
invariant (test `[invariance]`). Phase 2 replaces this with the real `.tproj/.tprojz` reader (plan §B10) —
the `terminatorProject` version field stays.

## Roadmap for the bridge (Phase 2 → EngineClient)
Landed: `terminatorFs` / `terminatorSettings` / `terminatorWindow` + the native `window.terminator` shim + the
native Preferences window; **2026-08-22 (fourth session): the EngineClient SHADOW landed** — `terminatorSamples`
+ `setPadSample`/`setPadLoop`/`gate`, `nativeEngineShadow.ts` (the TS engine mirrors pads/params/hits into the
C++ engine, its live-hit voices muted), proven by the probe (upload → bind → trigger on the audio thread, and the
real `loadPadBuffer` path). Still to do from the list below: peaks via resource URLs, ownership moving to the
C++ Document, batched commands, the snapshot-driven UI reads. Original plan:
- Typed `EngineClient` interface in TypeScript (the ChopperEngine public surface, docs/native/ENGINECLIENT-SURVEY.md);
  `NativeEngineClient` over `juceBridge.ts`, `WebAudioEngineClient` = the existing engine. Start as a SHADOW: the TS
  engine keeps its state, every pad/chop/param change is mirrored to `setPadSample`/`setPadParams`/
  `setPadLoopBuffer`/`setPadStems`, hits go to `triggerPad`, the TS voices are muted; then move ownership to the
  C++ `Document` section by section.
- **Sample bytes JS → C++ — decided design (read before coding):** the JUCE bridge carries JSON only (`var`), no
  binary channel in either direction except resource URLs C++ → JS. Therefore: (1) **path-based first** — library
  files, the YouTube cache, recordings and `.tproj` assets are FILES the shell can decode itself
  (`terminatorPads loadFile {pad, path}` exists; grow it to `terminatorSamples load {path}` → a SampleStore id + peaks
  URL, independent of pads); (2) bytes that only exist in the page (drops from Finder — WKWebView gives no paths;
  `loadFromArrayBuffer`) go as **chunked base64 through a native function** (`terminatorSamples put {id, chunk,
  seq, done}` — 1.33× size, fine for tens of MB, no server needed; a loopback HTTP endpoint would need a hand-rolled
  server — not worth it); (3) recordings stop being page PCM once Phase 5 records natively; Finder drops become a
  native `FileDragAndDropTarget` on the shell (Phase 8) that hands paths to the page. Audio never needs to travel
  C++ → JS: the page asks for **peak pyramids** (`analysis/WaveformPeaks` blobs) and slices via resource URLs
  (`juce://juce.backend/peaks/<id>?lod=…`).
- Batched commands per animation frame; binary meter/playhead streams via the 20 Hz snapshot event (already) or a
  resource URL poll; the rAF-polled reads (`getPlayheadPos`, `getSeqCursorPhase`) mirror the latest snapshot into the
  page (ENGINECLIENT-SURVEY §6 hazard 4).
- Schema versioning tests + bridge fuzz (plan §Testing 5).
- Native menus/shortcuts/Recent/open-with-file (`anotherInstanceStarted`)/drag-out — Phase 8.
