# ENGINECLIENT SURVEY — ChopperEngine public surface × UI call sites (read-only survey, 2026-08-22)

Source: `terminator/src/renderer/chopper/ChopperEngine.ts` (class body lines 618–7319, **294 public members**,
286 callable). Purpose: the spec for Phase 2.4's typed `EngineClient` (NativeEngineClient over the JUCE bridge
/ WebAudioEngineClient wrapping the existing engine). Line numbers = the Electron repo at the time of survey.

## 1. Public surface by area (name → line)
**I/O / graph / lifecycle:** `ctx` 619 · `drumBusInput` 622 · `outputNode` 638 · `mixerEngine?` 643 ·
`TRANSPORT_LEAD_S` 869 · `attachMixer` 1088 · `recordInputLag` 2728 · `getLatencyReport` 2743 · `resetInputLag`
2765 · `setOutputDevice` 6473 · `getPeakLevel` 6500 · `dispose` 7303.
**Loading / sources / waveform:** `getMasterBpm` 625 · `buffer` 695 · `trackTitle` 696 · `bpm` 697 · `growPadsTo`
1138 · `loadPadBuffer(padIdx, buffer, videoId, title, start?, end?)` 1152 · `loadAudioKeepChops` 1175 ·
`getPadBuffer` 1229 · `setPadTrim` 1233 · `removePadBuffer` 1241 · `padSourceKey` 1322 · `resolvePadSource` 1593 ·
`padRenderPlan` 1616 · `renderPadAsPlayed` 1626 · `setWaveformLive` 1672 · `padSourceBuffer` 1878 ·
`padsOnSource` 1880 · `bufferForPadSource` 1937 · `padSourceWaveformBuffer` 1949 · `waveformBuffer` 1989 ·
`waveformRev` 2088 · `takeWaveformDirty` 2089 · `sourceBuffer` 2097 · `reversedOf` 2235 · `sourceSettings` 2519 ·
`attackFor` 2531 · `pitchFor` 2533 · `reversedFor` 2537 · `setSourceAttack` 2572 · `setSourcePitch` 2576 ·
`setSourceFine` 2581 · `toggleSourceReverse` 2586 · `resetPadSource` 2594 · `setLoading` 2918 · `decodeAudio`
2925 · `loadFromArrayBuffer` 2935 · `loadFromAudioBuffer` 2943 · `clearAll` 3033 · `padSourceOf` 4091.
**Chops:** `bufferForPadChop` 1859 · `roomAfterBlock` 2251 · `chopPadSource` 2258 · `chopPadSourceTo` 2281 ·
`autoChopPadSource` 2294 · `padSourceChops` 2311 · `clearAllChops` 3017 · `autoChop` 3057 · `toggleAcDrumsOnly`
3102 · `setTransientSensitivity` 3108 · `autoSliceTransients` 3119 · `stepChopBoundaryToTransient` 3424 ·
`adjustChopBoundary` 3448 · `setChopBoundary` 3456 · `toggleChopMode` 3500 · `setSnapMode` 3505 · `transientsFor`
3519 · `sliceAtTime` 3790 · `slicePlayheadAt` 3811 · `assignChopToPad` 3901 · `cloneChop` 3917 · `chopRegion` 3938 ·
`reviveChop` 3947 · `setSelectedChopStart` 4126 · `setChopOffset` 6657.
**Pads:** `movePad` 1254 · `padReverse` 2539 · `padReverseOverridden` 2542 · `setPadsReverse` 2550 ·
`togglePadsReverse` 2564 · `selectPad` 3880 · `focusedPad` 3897 · `padLite` 3928 · `hasPadContent` 3934 ·
`setPadsLoop` 3955 · `setPadsGate` 3965 · `unassignPad` 3978 · `clearPad` 3988 · `setPadMode` 4038 ·
`togglePadMode` 4045 · `setPadLoop` 4052 · `setPadGate` 4062 · `setPadFades` 4073 · `setPadPitch` 4100 ·
`adjustPadPitch` 4109 · `setPadLock` 4120.
**Blocks / groups / routes / choke:** `groups` 1335 · `groupLabel` 1343 · `setPadGroup` 1361 · `setPadsGroup`
1374 · `duplicatePadToNewGroup` 1401 · `blockRange` 1419 · `nextSlotForSource` 1526 · `makeRoomAt` 1534 ·
`moveBlock` 1542 · `planMoveBlock` 1566 · `clearBlock` 2320 · `onRoutesChanged` 2341 · `padRoute` 2347 ·
`routesInUse` 2355 · `padsOnRoute` 2357 · `newRouteName` 2374 · `setPadRoute` 2377 · `setPadsRoute` 2386 ·
`routeNames` 2408 · `sourcesOnRoute` 2415 · `routeOutput` 2423 · `dropRoute` 2443 · `chokeGroupOf` 2461 ·
`chokeGroups` 2473 · `chokeGroupLabel` 2480 · `setPadChoke` 2493 · `setPadsChoke` 2502 · `routesForEvents` 7113.
**Voices:** `getPlayheadPos` 2810 · `triggerPad(padIdx, velocity=1, eventTimestamp?, {reverse?})` 4138 ·
`triggerPadAt(padIdx, when, velocity, opts)` 4166 · `releasePad` 4686 · `stopAllPads` 4751.
**Transport / sequencer:** `addSequence` 5315 · `selectSequence` 5344 · `duplicateSequence` 5370 ·
`deleteSequence` 5397 · `getSeqStepCount` 5410 · `getSeqStepDuration` 5420 · `setSeqBars` 5426 ·
`setSeqResolution` 5443 · `seqColumnStride` 5454 · `seqStepForColumn` 5456 · `getSeqViewStepCount` 5458 ·
`toggleSeqStep` 5528 · `seqStepVelocity` 5552 · `setSeqStepVelocity` 5557 · `setSeqSwing` 5572 · `getSeqSwing`
5578 · `seqSwingOffsetSec` 5582 · `toggleSeqStepReverse` 5589 · `clearSeqStep` 5603 · `moveSeqNote` 5614 ·
`clearSeq` 5645 · `toggleSeqLoop` 5675 · `playSeq` 5891 · `setTransportHooks(onStart(atTime), onStop(restart))`
5940 · `togglePlaySeq` 5945 · `pauseSeq` 5950 · `resumeSeq` 5982 · `stopSeq` 6288 · `getSeqCursorStep` 6318 ·
`getSeqCursorPhase` 6346.
**Metronome / count-in / record:** `toggleMetronome` 4870 · `startMetronomeForDrums` 4913 ·
`inputQuantizeStrength` 4922 · `getInputQuantize` 4926 · `setInputQuantize` 4930 · `setMetronomeBpm` 4938 ·
`setMetronomeSound` 4949 · `startRecordingSeq` 5677 · `stopRecordingSeq` 5705 · `startLiveRecord` 5778 ·
`runCountIn(onDownbeat)` 5856 · `stopLiveRecord` 5869 · `setCountInEnabled` 5875 · `toggleCountIn` 5876 ·
`toggleLiveRecord` 5877 · `setRecordStep` 5882.
**Arp:** `toggleArp` 4775 · `setArpRate` 4780 · `toggleArpDirection` 4784 · `toggleArpRandom` 4788 (NOT wired to
any UI control today — engine feature to expose, plan decision 5).
**Master / FX:** `toggleReverseSample` 4848 · `setMasterVolume` 6370 · `setChopVolume` 6377 · `getChopVolume`
6381 · `setNormalize` 6411 · `getNormalize` 6417 · `sourceNormKeyFor` 6421 · `setSourceNormalize` 6426 ·
`peakNormGain` (static) 6432 · `setMasterClip` 6453 · `getMasterClip` 6467 · `setMasterPitch` 6509 ·
`adjustMasterPitch` 6514 · `setFilterFreq` 6518 · `setFilterEnabled` 6519 · `setEQ` 6520 · `setCompStyle` 6526 ·
`setCompMix` 6527 · `setDelayTime` 6565 · `setDelayFeedback` 6566 · `setDelayMix` 6567 · `setReverbMix` 6570 ·
`setReverbDecay` 6573 · `setAttack` 6574 · `setRelease` 6575 · extra-FX block 6585–6631 (39 `set*/toggle*`:
clipper amount/drive/mix, waveshaper drive/mix, saturator drive/mix/lowFreq/highFreq, widener width/mix, MSEQ
mid/side freq+gain/mix, bitcrusher bits/rate/mix, autopan rate/depth/mix, trancegate rate/depth/attack/release/mix,
chorus rate/depth/mix + toggles). `MasterFXPanel.tsx`/`ExtraFXPanel.tsx` are UNRENDERED today (only `FXKnob`
imported) — the master FX setters are dead from the UI; Phase 4 decides exposure.
**Stems:** `hasStems` 1695 · `setStemsPending(meta, ranges, load)` 1703 · `ensureStemsDecoded` 1722 ·
`stemsArePending` 1736 · `stemsMeta` 1737 · `setStemBuffers(stems, meta?, ranges?)` 1746 · `addStemReadyRange`
1780 · `padStems` 1801 · `setPadStems` 1802 · `setPadsStems` 1804 · `stemTargetKind` 1873 · `hasSourceStems` 1885 ·
`hasStemsForPad` 1887 · `sourceStemsMeta` 1891 · `setSourceStemBuffers` 1896 · `addSourceStemReadyRange` 1908 ·
`sourceStemsSnapshot` 1919.
**Stretch:** `setBpm` 6633 · `toggleStretch` 6635 · `setTargetBpm` 6648. **Trims:** `effToFile` 2099 · `fileToEff`
2100 · `trimsInfo` 2101 · `addTrim` 2108 · `restoreTrims` 2161. **Undo:** `undo` 5223 · `redo` 5230 · `canUndo`
5237 · `canRedo` 5238 · `clearHistory` 5242 · `dropLastHistory` 5251 · `attachDrumEngine` 5255 · `recordHistory`
5261 · `beginHistoryBatch` 5266 · `endHistoryBatch` 5270. **Export:** `exportOriginal` 6778 · `exportSeq` 6786 ·
`exportSequences` 6802 · `exportMaster` 6821 · `renderArrangementMix` 6973 · `renderArrangementChopSource` 7086 ·
`exportChops` 7119. **Serialization:** `getPresetData` 3185 · `loadPreset` 3242. **Events/state:**
`onRoutesChanged` 2341 · `onNote` 2344 · `subscribe` 2622 · `subscribeActivity` 2665 · `getActivity` 2671 ·
`getState` 2815.
`ChopperActivity` = `{activePads, lastTriggeredPad, playing}`. `ChopperState` fields: see dossier-chopper-core
§1.1 + lines 401–521 (note `transients: Float32Array` — the one non-JSON field).

## 2. Who calls what
- **ChopperView.tsx (6356 lines): 131 members** — the concentration. Also reads `ctx`, `buffer`, `sourceBuffer`,
  `outputNode`, `drumBusInput`, `mixerEngine`; assigns `onNote`, `onRoutesChanged`.
- **PadGrid.tsx: 23** (block/group/route/choke/stems/reverse/move/plan). **WaveformView.tsx: 3**
  (`getPlayheadPos`, `setWaveformLive`, `takeWaveformDirty` — otherwise state-driven). **Timeline.tsx: 1**
  (`getSeqCursorPhase` in a rAF loop). **HardwareView.tsx: 78** and it builds its OWN ChopperEngine (line 194).
- DrumSection: 10 (`ctx getInputQuantize getState recordHistory runCountIn setInputQuantize
  startMetronomeForDrums stopLiveRecord subscribe toggleCountIn`). BassSection: 4. Arranger: `ctx getMasterBpm
  stopAllPads triggerPadAt` / `buffer decodeAudio exportChops getChopVolume mixerEngine renderArrangementMix` /
  `getMasterBpm getState` / `buffer mixerEngine renderArrangementChopSource routesForEvents`. MixerSection,
  Preferences, FinishHim: no ChopperEngine use.
- **Dead public surface (69):** arp, master/extra FX setters, several getters (`getSeqStepCount` etc.),
  `setStemBuffers` family (used via stemsController), `toggleChopMode`, `togglePlaySeq`, …

## 3. Outbound channels (there is NO generic event bus)
- `subscribe(handler)` — rAF-coalesced, keep-latest full `ChopperState` clone (`emit()` × 169 sites;
  `setTimeout 0` when hidden). Subscribers: ChopperView, HardwareView, DrumSection, BassSection.
- `subscribeActivity(handler)` — synchronous, change-gated `{activePads,lastTriggeredPad,playing}` (the hot
  per-note path). Subscriber: ChopperView only.
- Assignable fields: `onRoutesChanged`, `onNote(msg)`. `setTransportHooks(onStart(atTime: ctx time), onStop
  (restart))`. `runCountIn(onDownbeat)`. Object handoffs: `attachMixer`, `attachDrumEngine`, raw nodes `ctx`,
  `outputNode`, `drumBusInput`, `routeOutput(route)`.
- Polled on rAF: `getPlayheadPos`, `getSeqCursorPhase`, `waveformRev`, `takeWaveformDirty` (drain-on-read).

## 4. Sibling singletons the UI talks to
- `DrumEngine` (drums/DrumEngine.ts, 2595 lines) — DrumSection uses ~50 methods (addSequence, addTrackFrom*,
  browse session, generate, step graphs, swing, start/stop, live/step rec, subscribe…); ChopperView: `generate
  getState liveHit playLive randomizeAllSamples recordStepHit restore routeTrackOutput serialize setPpq start
  stepsPerBar stop subscribe`.
- `BassEngine` (bass/BassEngine.ts, 909) — BassSection ~25 (patterns, patch, key/lock, mods, subscribe);
  PianoRoll ~15; ChopperView: `getState mpcNoteOff mpcNoteOn noteOff noteOn outputNode padOff padOn panic reset
  restore serialize setBend start stop`.
- `MixerEngine` (src/mixer/MixerEngine.ts, 1317) — MixerSection: `applySolo channelMeta channels console
  gainMatchOn getChannel master pdcOn reorderFX setConsole setGainMatch setPdc soloExclusive`; ChopperView:
  `addChannel channelMeta channels getChannelInput isPristine master removeChannel restore serialize setChannelMeta`.
- `midiHub` singleton (chopper/midiHub.ts): `getState outputs subscribe onMessage start rescan`.
- `StemsController` (chopper/stemsController.ts): `start startMany cancel ensureChopSplit hasStemsFor removeStems
  restore restoreSource tryCache tryCacheSource targetForPad state onState onNote`.
- `libraryBridge` (chopper/libraryBridge.ts): 20 promise/listener members (`get listLink searchLinks createFolder
  rename move copy duplicate remove importPaths addR2Ref importR2 reveal pickFolder pickFiles saveRecording
  youtubeImport youtubeCancel onChanged onYouTubeProgress pathForFile`).
- `window.terminator` (preload.ts, 332 lines): export/MPC, system, projects, assets, settings, library root,
  stems, drums/misc groups (dossier-shell-ui §6 has the channel table).

## 5. Sizes
ChopperEngine 7319 · ChopperView 6356 · HardwareView 2786 · PadGrid 1213 · WaveformView 1065 · Timeline 473 ·
DrumEngine 2595 · MixerEngine 1317 · BassEngine 909 · preload 332. `src/renderer` (ts/tsx/mts, minus board/mpc/
dist) = **46,689 lines** (chopper 27,921 · drums 4,150 · audio 3,968 · bass 2,445 · components 1,259 ·
finishhim 1,197 · arranger 1,165 · preferences 663 · test 598 · lib 551 · luxe 305 · hooks 94); `src/mixer`
another 4,952.

## 6. The four boundary-crossing hazards for EngineClient (decide before extracting)
1. **Raw AudioNode handoffs** (`ctx`, `outputNode`, `drumBusInput`, `routeOutput`, `attachMixer`,
   `attachDrumEngine`, `bassEngine.outputNode`) → bus/route IDs; MixerEngine + DrumEngine + BassEngine move
   behind the same boundary (native), not wired in the renderer.
2. **AudioBuffer in/out** (`decodeAudio`, `loadFromAudioBuffer`, `loadPadBuffer`, `renderPadAsPlayed`,
   `waveformBuffer`, `padSourceWaveformBuffer`, `setStemBuffers`, `setSourceStemBuffers`,
   `renderArrangementChopSource`, `reversedOf`, `peakNormGain`, `renderArrangementMix` inputs) → sample handles +
   explicit transfer (asset ids / resource URLs / peak tiles).
3. **Two push cadences are load-bearing**: keep a coalesced full-state (delta/patch protocol — the full clone is
   the documented 12–46 ms cost) AND a synchronous change-gated activity channel.
4. **rAF-polled reads** (`getPlayheadPos`, `getSeqCursorPhase`, `waveformRev`, `takeWaveformDirty`) need a
   cheap synchronous read (snapshot mirrored into the page at 60 Hz / SharedArrayBuffer-like event) — async RPC
   will not do.
Also: HardwareView instantiates a second ChopperEngine → the client must support >1 engine instance (or the
native app serves the phone layout from the same engine).
