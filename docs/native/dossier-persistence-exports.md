I have everything needed. Here is the dossier.

# TERMINATOR — Persistence · Library/Cache/Download · Exports (read-only survey, branch `mpc-stem-extractor`, 2026-08-22)

All paths are absolute under `~/terminator/`. "CV" = `src/renderer/chopper/ChopperView.tsx`, "CE" = `src/renderer/chopper/ChopperEngine.ts`, "main" = `src/main/main.ts`.

---

## 1. PERSISTENCE

### 1.1 The one document: `ChopPreset` (the project/preset/session JSON)

There is exactly one serialized shape for project files, named presets, per-video presets, the session autosave, the crash autosave, cloud rows and transfer bundles: `ChopPreset` — CE:57-140. Built by `buildPreset(videoId)` in CV:2084 = `withAssetManifest({ ...engine.getPresetData(videoId), sourceStems, drums: drumEngine.serialize(), bass: bassEngine.serialize(), mixer: mixerEngine.serialize() })`. **There is no top-level `version` field** — back-compat is entirely "every newer field is optional; loader guards on presence". The main-process copy of the type (`src/main/presets.ts:4-13`) is a stale subset (videoId/savedAt/name/trackTitle/chops/pads/bpm/nextChopId) — main never validates beyond `videoId`.

| Field (CE line) | Type / meaning | Loader behaviour (CE `loadPreset` 3242-3418, CV `applyPreset` 2127) |
|---|---|---|
| `videoId` | YouTube id (11 chars), R2 id, `asset:<sha1>`, `local:<path>` (bundled easter-egg), legacy `local_<filename>` (dead — not re-fetchable), or `'none'` (`NO_SAMPLE_ID`, CE:54 — drums+bass-only project) | `loadTrackById` (CV:2172) fetches by id; `'none'` skips audio |
| `savedAt` ISO, `name?`, `trackTitle?` | | |
| `chops[]` `{id,start,end,free?}` seconds in the **TRIMMED** timeline | | re-applied after `trims` |
| `pads[]` `{index,chopId,mode,pitch,gate?,fadeIn?,fadeOut?,stems?(mask int),reverse?}` | | `normalizeMask(stems)` |
| `padBufferMeta?` `Record<padIdx,{videoId,title,start,end}>` | per-pad own source (asset/R2/YouTube id + trim) | `restorePadSamples` (CV:2095) — fetches each id once, shares the AudioBuffer; `local_` → counted missing |
| `sourceRoutes?`, `padRoutes?`, `padGroups?`, `nextSampleTrack?`, `padChoke?`, `nextChokeGroup?`, `sourceFx?` | mixer routing / groups / choke / per-source attack-pitch-fine-reverse (2026-08-19) | defaults rebuilt when absent |
| `bpm`, `nextChopId`, `metronomeBpm?` (transport tempo, distinct from detected `bpm`), `chopOffsetMs?`, `stretchEnabled?`, `targetBpm?`, `reverseSample?`, `chopVolume?` | | |
| `timeline?`, `timelineLength?` | legacy pad timeline | |
| `sequences?: SeqPattern[]` (CE:269 `{bars,resolution,grid:number[][],revGrid?,velGrid?,loop,viewResolution?}`), `currentSeqIdx?` | chop step-seq; legacy single-pattern fields `seqBars/seqResolution/seqGrid/seqLoop` still read when `sequences` absent (CE:3310-3348) | any resolution dividing 384 accepted |
| `normalize?`, `normalizeGain?`, `sourceNorm?` `Record<'src:<videoId>',gain>` | non-destructive −1 dBFS NORM | |
| `master?` (ChopperState.master), `extraFX?` {clipper,waveshaper,saturator,widener,mseq,bitcrusher,autopan,trancegate,chorus}, `masterClip?` | internal master chain | setters in order (compStyle before compMix) |
| `inputQuantize?` | migrated from `drums._inputQuantize` if missing (CE:3408) | |
| `drums?: DrumPreset` (`src/renderer/drums/DrumEngine.ts:134`) | `tracks[{key,sampleIndex,sampleGenre,muted,solo,volume,name?,color?,kitKey?,added?,muteGroup?,userPath?,userName?}]`, `sequences: Record<TrackKey,boolean[]>[]`, `seqIndex,bars,masterVolume,genre,drumSwing,stepDivision?,gridRes?(=96),_gridOff?,_inputQuantize?,_triplet?,ppq?(960),stepVelocity/Shift/Pan/Repeat?` | `restore()` 1073; **`sampleIndex` indexes `samples.json` per genre/category — append-only rule**; `userPath` = `<rel path in Drums folder>` or `lib:<nodeId>` |
| `bass?: BassPreset` (`src/renderer/bass/BassEngine.ts:102`) | `{patch,patterns,currentIdx,key,lock,grid,presetName?,bendRange?}` | `restore()` / `reset()` if absent |
| `mixer?: MixerPreset` (`src/mixer/MixerEngine.ts:71`) | `{channels: Partial<Record<ChannelName,{fader,pan,mute,solo,sends[],fx[{id,bypassed,params}]}>>, master:{fader,fx[]}, console?}` | |
| `trims?: TrimRegion[]` (`trimRegions.ts:35` `{startSec,endSec,chops[]}` **FILE** time) | cuts re-applied before chops | |
| `stems?` `{quality:'fast'|'fine', assets: Partial<Record<StemName,'asset:<sha1>'>>, readyRanges:[s,e][] (ORIGINAL time)}`, `sourceStems?` keyed by pad videoId | stem audio lives in the asset store as `<title> — DRUMS.stems.flac` etc. (`stemsController.ts:596-599`); **deliberately NOT bundled/transferred** (`projectAssets.ts:115`) — receiver re-splits | |
| `assets?` `[{hash,name,mime,bytes}]` | manifest stamped by `withAssetManifest` (`projectAssets.ts:135`) only when the project references `asset:` ids | |

### 1.2 Asset store (`src/renderer/chopper/projectAssets.ts`)
- Id = `asset:` + SHA-1 hex of the file bytes (`hashBytes`, :41). Dedupe is by hash: `put()` no-ops if present (:67, main:1298 `if (!(await findAssetFile(h)))`).
- **Desktop**: `<userData>/terminator-presets/assets/<hash>.<ext>` + sidecar `<hash>.json` `{hash,name,mime,bytes,savedAt}` (main:1277-1318; hash regex `^[a-f0-9]{16,64}$`; 512 MB cap).
- **Web/iPad**: IndexedDB `terminator` v1, store `audio`, key `asset:<hash>` holding `{audio,title,durationSec:0,videoId,cachedAt,mime}` — outside the LRU index so never evicted (`ipc-browser.ts:268-284`).
- Session memory cache in front of the device store; `release(hash)` drops bytes but keeps meta (stems ≈140 MB/song).
- What becomes an asset: LOAD FILE / drops, recordings (web), RESAMPLE pad (CV:3153 → FLAC 16-bit `"<title> — PAD n (resample).flac"`), stem splits.

### 1.3 Project files on disk (desktop) — `.tproj` / `.tprojz`
- `.tproj` = `JSON.stringify(ChopPreset, null, 2)` (main:1426-1449). `.tprojz` = **stored (method 0) zip** (`zipWriter.ts`/`zipReader.ts`) of `project.json` (the preset, manifest-stamped) + `manifest.json` `{version:1, app:'terminator', assets:[{hash,name,mime,bytes}]}` + `samples/<hash>.<ext>` (`buildProjectBundle` :145). Written when `projectNeedsBundle()` (any `asset:` ref); warn >100 MB, refuse >500 MB. Writing one ext deletes the twin of the other ext (main:1443, 1466).
- Import: `importProjectBytes` (CV:2851) — `PK` magic → `unpackProjectBundle` (samples → local store) else JSON; then `missingAssets()` flash; then `loadTrackById(videoId, trackTitle, preset)`.
- Folder: default `<userData>/terminator-presets/` (`getPresetsDir`, main:349); user-changeable `settings.projectsDir` in `<userData>/terminator-settings.json` (main:355-367; OPEN… → FOLDER row / Prefs FOLDERS → PROJECTS). Only project FILES move — assets, named-preset store, session stay in userData. `listProjectFiles` lists both exts newest-first; `deleteProjectFile` contained to that dir; OS file associations for both exts (electron-builder.json mac/win `fileAssociations`), double-click routed through the single-instance lock.
- Recent Projects: `settings.recentProjects[{name,id:<abs path>,loadedAt}]` max 10 (main:131-165).
- Web: "Open file…" picker + `⇩ FILE` download/share (`deliverFiles`, `lib/download.ts`) of `.tprojz`/`.tproj`.

### 1.4 Named presets / cloud rows (the "SAVE PROJECT" button)
- **Desktop (Electron)**: cloud-first. `doSaveProject` (CV:2638) → `postPreset` → main `presets:save` proxies to `https://killaviccheatcodes.app/api/terminator-presets` with the device-token Bearer (main:249-296; route lives in the subscription-starter repo). Row shape read back: `{id, name, created_at, pattern: ChopPreset}` (CV:1749-1768 — the whole preset is the `pattern` column). Overwrite protocol: POST `{name,data,id?,overwrite?,confirmable:true}` → `{needsConfirm, existingId}` prompt. On success it ALSO writes `<name>.tproj/.tprojz` locally (`afterSaved`, CV:2616). Without cloud (ipc has no `cloudPresetsList`) the legacy name-keyed store is used: `<presetsDir>/named_<safeName>.json` (`presets.ts:52-86`, name sanitised, ≤64 chars, stores `{...preset, name}`).
- **Web**: same API, cookie auth; `listNamedPresets` fallback in `ipc-browser.ts:375` keys IndexedDB `kv` as `named:<safeName>`.
- Cloud rows are JSON only — samples referenced by `asset:` id are NOT uploaded ("Phase 3 samples in R2" not built, memory note). A cloud row loaded on a device without the bytes flashes the missing names from the `assets` manifest.

### 1.5 Per-video auto-preset
- `chopper:savePreset/loadPreset` → `<presetsDir>/<videoId>.json` (`presets.ts:25-37`, id regex `^[A-Za-z0-9_-]{1,32}$`); web: IndexedDB `kv` `preset:<videoId>`. Read in `loadTrackById` when no explicit preset is passed (CV:2203) — loading a track restores its last chops automatically. **Gap**: `savePreset` for `asset:`/R2 ids fails the regex on desktop (silently `{error}`) — only YouTube-shaped ids get auto-presets.

### 1.6 Session / crash recovery
- Desktop: `beforeunload` → `chopper:saveSession` → `<userData>/terminator-session.json` (full ChopPreset); restored on mount (CV:2437-2458), skipped on web.
- Web: `localStorage.terminator_autosave` `{ts, preset}` every 30 s + on tab-hide, auto-restored if <2 h old and not `local_` (CV:2460-2518); `terminator_session_snapshot` written synchronously before an iOS export share sheet (CV:2150) and restored/cleared on mount.
- Other userData JSON: `section-layout.json`, `midi-map.json`, `bass-patches.json` (main:1103-1160); `localStorage`: `terminator.layout`, `terminator.uiSize`, `terminator.midiTapNote`, `terminator_record_input`, palette key, `terminator.library.expanded.v2` (sessionStorage), `terminator.library.lastLoaded.v1`.

### 1.7 TRANSFER TO DEVICE (8-char code) — `src/renderer/chopper/transfer/projectTransfer.ts`
- Peer-to-peer WebRTC, **no server storage**: sender = `SignalHost` room whose id IS the code (`newRoomId()` from `board/sim/net/signal.ts`), receiver `signalJoin(code)`; handshake over the Board's relay `WsTransport` (wss://board-signal.killavicbeats.workers.dev), STUN/TURN via `ice.ts`. Bundle = the same `.tprojz` bytes, streamed on the reliable `bulk` DataChannel in 16 KB frames `[u32 kind LE][payload]`: 1 HEAD `{name,size,sha1,v:1}`, 2 DATA `[u32 offset][bytes]`, 3 END, 4 DONE, 5 FAIL `{error}`; receiver caps at 600 MB, SHA-1 verified, imports via `importProjectBytes`. Expiry: sender waits ≤10 min for a join (:86); code valid "while this window is open". UI `TransferModal.tsx`; entry points OPEN… footer (desktop) / PROJECTS row (phone).

### 1.8 Known gaps / not saved
- Stems audio never bundles/transfers (by design); `local_` ids dead; cloud rows carry no sample bytes; per-video auto-preset only for YouTube-shaped ids; `padBufferMeta` for `local_` lost; no schema version field; `presets.ts` ChopPreset type is stale; old `userData/user-playlists.json` (+YouTube URLs) no longer surfaced; legacy `userData/user-samples/*.wav` migrated into the library on first `getLibrary()`.

---

## 2. SAMPLE LIBRARY · CACHES · DOWNLOADS

### 2.1 Library root + index (`src/main/library.ts`)
- Root `~/Music/Terminator/` (`app.getPath('music')`, :75); override `settings.libraryDir` (Prefs FOLDERS → SAMPLE LIBRARY: "MOVE LIBRARY THERE" copies managed files + index non-destructively, `moveLibrary` :934; "JUST POINT" adopts an existing `library.json`).
- `library.json` (atomic tmp+rename, :143): `{version:1, root:string[], nodes:Record<id,LibNode>}`; `LibNode` :36 `{id,type:'folder'|'file'|'link'|'r2',name,children?,path?,meta?{source:'recording'|'youtube'|'import'|'linked'|'user',videoId?,durationSec?,r2Id?,r2Playlist?,size?,createdAt?},system?,readonly?,mirrored?,lazy?}`. Ids `Date.now().toString(36)+rand` for real nodes; `link:<abs path>` for linked-folder children; `user:<rel path>` for USER SAMPLES.
- System folders (:65): `recordings`→`Recordings/`, `youtube`→`YouTube/`, `imports`→`Imports/`, `user`→`User Samples/`; plus `dl-playlists` "DOWNLOADED PLAYLISTS" (:893) whose files land in `YouTube/Playlists/<playlist>/`. Organisation is virtual (move never moves managed files; delete = Trash), EXCEPT **USER SAMPLES** which is scanned from disk every read and writable on disk (mkdir/rename/move/copy/trash), cap 50 000 files / depth 16 (:72).
- Linked folders (`type:'link'`, dropped directories): listed lazily one level at a time (`listLink`), search index per root TTL 5 min capped 400 hits/root; full walk cap `LINK_MAX_FILES = 50000`, depth 16 (:298). (The memory note's "2,000 files / depth 4" is superseded — code says 50 000/16.)
- Also: `Drums/` = user drums (`userDrums.ts`, served `terminator-drums://user/<rel>`, same 50 000/16 caps, EMPTY → Trash).
- IPC surface: `library:get/listLink/searchLinks/createFolder/rename/move/copy/duplicate/remove/importPaths/addR2Ref/importR2/reveal/pickFolder/pickFiles/saveRecording/youtubeImport/youtubeCancel`, events `library:changed`, `library:yt-progress` (main:1838-1923); renderer bridge `libraryBridge.ts` (`LIB_ID_PREFIX='lib:'`, `libFileUrl`). Browser = `SampleBrowser.tsx` hosting `LibraryTree.tsx` (TERMINATOR R2 playlists first, then the user's library).
- Tests: `npm run test:library`, `test:user-drums`, `test:user-samples`, `test:range-serve`, `test:disk-usage`.

### 2.2 Custom protocols (main:41-56 registered streamable; handlers 719-800)
| Scheme | Resolves to | Notes |
|---|---|---|
| `terminator-lib://file/<nodeId>` | `library.resolveReadable(id)` → file under root or a linked dir | range-aware (`rangeServe.ts`: 206/416, MIME table) |
| `terminator-drums://sample/<16hex>.(flac|mp3)` | `Resources/drums-flac/` (packaged) or `<repo>/drums-flac/` | 404 → renderer falls through to R2 |
| `terminator-drums://user/<rel>` | `<library>/Drums/<rel>` | contained, audio ext only |
| `terminator-cache://<file>` | legacy cache dir (now = `<library>/YouTube`) | basename-only containment |

### 2.3 YouTube / yt-dlp (`src/main/youtubeDownloader.ts`, `scripts/download-ytdlp.js`)
- Pinned nightly `2026.08.16.020253`, SHA-256-verified, ONEDIR (`bin/mac/ytdlp/yt-dlp_macos`, `bin/win/ytdlp/yt-dlp.exe` + `_internal/`, mac `Python.framework` stripped for codesign), stamp `.ytdlp-tag`; packaged via mac/win `extraResources → bin/ytdlp`; `preelectron:pack` provisions it. Spawned with `--no-update --js-runtimes node:<process.execPath>` + `ELECTRON_RUN_AS_NODE=1`; packaged builds never use PATH.
- Format `bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best`, no remux; one silent retry on HTTP 403. Playlist enumerate `--flat-playlist -J` cap 200, RD/UL mixes refused; batch = 3 workers; cancel by jobId.
- **Every pull lands in the library** (main:313-347 `pullYouTube`): cache hit = `findYouTubeFile(videoId)` by `meta.videoId`; miss → download into `YouTube/` named by title (` [videoId]` suffix on clash) → `addYouTubeFile` node; renderer gets `cacheUrl: terminator-lib://file/<id>`. Legacy hidden cache `<userData>/terminator-audio-cache/<videoId>.<ext>+.json` is adopted on first sight (`adoptYouTubeFile`, `migrateLegacyAudioCache`). Playlist DL (`chopper:downloadPlaylist`, 5 workers) → `DOWNLOADED PLAYLISTS/<name>`.
- Curated playlists: `data/playlist*.json` (yt-dlp NDJSON/array, `playlists.ts`) else R2 `playlists.json` (`{playlists:[{name,entries:[{id,title,duration}]}]}`). R2 sample audio: `r2.ts` `R2_BASE=https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev`, manifest `playlists.json?v=2`, worker `kcc-samples.killavicbeats.workers.dev`; web caches fetched audio in IndexedDB `audio` with a 200 MB LRU (`cache:audioIndex`).
- Disk usage: `chopper:folderSizes` → projects/library/cache(YouTube)/drums/drumsBundled (`diskUsage.ts`, cap 200 000 entries).

### 2.4 Drum catalog
- `src/renderer/drums/samples.json` (copy in `drums-flac/samples.json`): `{boombap:{kick:[16-hex ids]…}, trap:{…,rim,clapsnap}, westcoast:{…}}` — counts boombap 141/134/104/36/111, trap 84/151/68/83/97/34/57, westcoast 26/17/9/8/22. **APPEND-ONLY** (presets store `sampleIndex`). Display names are aliases (`drumAliases.ts`); real filenames only in gitignored `drums-flac/newids.json`.
- Resolution order (`drumR2.ts:25`): desktop `terminator-drums://sample/<id>.flac` → `R2/drums-flac/<id>.flac` → `R2/drums/<id>.mp3` (web = R2 only). Bundled: `drums-flac/` (1 185 files, ~1 180 expected) via `extraResources` filter `*.flac,*.mp3`, guarded by `scripts/check-drums-bundle.js` (≥1 100 files, opaque names, filter present). Nine samples remain MP3-only.
- Lanes: `TRACK_DEFS` = kick/snare/hihat/openhat/perc; `BUILTIN_TRACK_KEYS` adds `clapsnap`,`rim` as browsable slots; `TrackKey = string` (user lanes).

### 2.5 Stems on disk
- Models: `<userData>/terminator-stems/models/` from R2 `stems-models/onnx/` (`stemsModels.ts`); index `<presetsDir>/stems-cache.json` `{version:1, entries:{<audioKey>:{fast?:{quality,assets{drums,bass,other,vocals:'asset:…'},readyRanges,sampleRate,frames,title,savedAt}}}}` (`stemsCache.ts`, max 300 keys); audio = asset-store FLACs named `<title> — <STEM>.stems.flac` (older `.stems.wav`), deletable per song from Prefs.

### 2.6 Owed / open (from memory notes)
Victor's real Electron pass of the library; recording quality items (16-bit, no monitoring); Windows `webUtils.getPathForFile`/trash untested; dead CV code (`loadUserSampleIntoWaveform`…); the queued "drums bundled + user library" batch is now largely built (bundled drums, Drums folder, USER SAMPLES writable, Prefs FOLDERS rows PROJECTS/SAMPLE LIBRARY/USER SAMPLES/DRUMS/YOUTUBE/STEMS) — the DrumBrowser's own folder-organiser and Cmd-drag copy there should be re-verified against the queue note.

---

## 3. EXPORTS

### 3.1 WAV/FLAC encoders
- `encodeWAV(buf, 8|16|24|32)` (`src/renderer/audio/StemExporter.ts:12`): 44-byte header; 32 = IEEE float (fmt 3); 24 = round-to-nearest int; 16 = **TPDF dither** then round; no normalisation.
- `encodeFLAC(chans Int16/Int32[], sr, 16|24, {blockSize 4096, maxLpcOrder 8})` pure TS (`flacEncoder.ts:424`), `quantizeTPDF16` == encodeWAV's 16-bit quantiser; worker wrapper `encodeFlac16(AudioBuffer)` (`flacEncode.ts`, inline worker, sync fallback). Gates `test:flac` (reference `flac -d` round-trip bit-identical, 17 cases), `test:flac-decode` (Chrome decodeAudioData vs WAV), `test:export-flac` (FLAC only on master/stems, never MPC/ADG, identical samples).

### 3.2 Chopper export inventory (what the user sees)
Desktop EXPORT section (CV:5639-5718) = dropdown over `EXPORT_FORMATS` (`exporters/formats.ts`) + WAV/FLAC toggle (`FLAC_CAPABLE` = master-wav, wav-stems) → `runExport(engine, fmt, progress, ctx{drumEngine, arrangement, bpm}, audioFormat)` (`exporters/index.ts:57`). Mobile (`HardwareView.tsx:2047-2050`): MPC / ADG / STEMS / MIX buttons → same `runExport` with ctx (legacy no-mixer render inside). Beat Finisher modal `exportFinishHim` (CV:1018) → same `exportArrangement` + drum-rack. Plus `⇩ FILE` (project file) and RESAMPLE (FLAC asset to a pad). Hidden-but-wired handlers: original-wav, seq-wav, seqs-zip, mpc-pattern, midi (formats.ts:34-39); `handleExportSeq/Master/Chops` (CV:4422) write via `export-stem`/`export-all-stems` save dialogs or straight onto a detected MPC card (`mpc:export-all` → `<card>/<MPC folder>/Samples/User/TERMINATOR/[<title> CHOPS/]`, `mpcDetector.ts`). No bass MIDI export exists.

| Export (label) | Format / file | Render path | Bit depth / FLAC | Layout |
|---|---|---|---|---|
| Master Mixdown | `<title>-master.wav|flac` | `exportArrangement target:'master'` → desktop `renderArrangementDAW` (chops→chopGain(level×NORM)→padBus→internal master chain→SAMPLE strip; drums per-lane with live envelope/choke/mute-groups/VEL-SHIFT-PAN-REPEAT graphs + swing; bass worklet offline; sends; master FX→fader→limiter); mobile legacy `engine.renderArrangementMix` | 16 (TPDF) WAV or FLAC 16; tail 2.5 s | single file |
| Trackouts (Chops + Drums) | `<title>-stems.zip` (stored zip) | DAW: one post-strip stem per mixer channel (`sample`, extra SAMPLE strips, kick/snare/hihat/openhat/perc + added lanes, bass, active `send1-4` returns); legacy: `chops.wav`,`drums.wav`,`bass.wav` | 16 WAV or FLAC | `<title>/<stem>.wav` |
| MPC Project | `<title>-mpc.zip` | drums used first → `PAD01_kick.wav`…, then chops `PADnn_<title>_<bpm>BPM_padNN.wav` contiguous; one MPC sequence per section; chops mute-group 1, drums 0; swing baked into drum ticks | **24-bit** WAV per pad (drums through mixer strip FX; chops `renderChopThroughMaster` → SAMPLE strip FX → −1 dBFS safety limiter, latency-trimmed) | `<title>/…` + `<title>/<title>.mpcsample` = gzip(`ACVS\n3.8.0.25\nSerialisableAC50ExportData\njson\nOSX\n` + JSON `{data:{sequences[128 keys desc],muteGroups[128],simultPlayTargets[128]}}`), PPQ 960, note 36+pad, int64 max placeholder |
| Ableton Drum Rack | `<setName>.zip` | `buildDrumRackZip`: drums (choke 0) then chops (choke 1), each 16-bit WAV; `.adg` = gzip XML from Live-11 templates (`exporters/templates/drumRack-*.xml`), `ReceivingNote = 4 + padIdx` reversed order, RelativePathType 6 | **16-bit** always | flat `<setName>.adg`, `Samples/<name>.wav`, `README.txt` → extract into Ableton User Library |
| (hidden) Original Song | `<title>.wav` | raw buffer | 24 | |
| (hidden) Current/All Sequences | `<title>_seqNN.wav` / `-sequences.zip` | `renderEventsToWav` (mixer: per-route strips → master bus; else offline internal chain) | 24 | |
| (hidden) MPC Pattern | `<title>.mpcpattern` JSON `{pattern:{length:int64max,events[],version:2,quantisation,numFilterTypes:30}}` | current sequence, 50 % gate | — | |
| (hidden) MIDI | `<title>.mid` SMF format 1, 960 PPQ, tempo track + one track per sequence, note 36+pad vel 100 | | — | |
| ⇩ FILE | `.tprojz` / `.tproj` | see §1.3 | | |
| RESAMPLE pad | asset `… (resample).flac` | `engine.renderPadAsPlayed` | FLAC 16 | asset store |

Delivery: `lib/download.ts` `deliverFiles` (anchor download; iOS share sheet with the "needs-tap" SAVE card).

### 3.3 MPC Extractor exporters (separate product `src/renderer/mpc/`, NOT used by the Chopper)
`engine.ts` `ExportFormat = {codec:'wav',bits:16|24|32} | {codec:'mp3',kbps}`; UI targets (`App.tsx:2708`): ZIP trackouts, TRACKOUTS (24-bit WAVs, streamed to `~/Downloads/<base>_Trackouts` for giant songs), MASTER, ABLETON (`alsExporter.ts` `exportTrackoutsAls` — .xpj → .als via template surgery, Simpler 1-Shot, atem slices), LOGIC (`logicExporter.ts` — Mac Electron only, `~/Music/Logic/<name>.logicx` + `Samples/KCCSLOTnn.wav`, blob-patching, 960 PPQ 1:1), plus `flpExporter.ts` (`exportFlp` — from-scratch FLP event stream, 96 PPQ) and `qsExporter.ts` (Quick Sampler `.pst` per pad into `~/Music/Audio Music Apps`). The Chopper shares only `zipWriter`, `encodeWAV`, the FLAC encoder and the `.mpcsample` writer with it.

### 3.4 Gates (package.json)
| Script | Asserts |
|---|---|
| `test:export-flac` | FLAC_CAPABLE set; FLAC vs WAV samples identical; MPC/ADG never FLAC |
| `test:flac` / `test:flac-decode` | encoder bit-identical through `flac -d`/ffmpeg; Chrome decode == WAV decode |
| `test:norm` | per-source NORM gain = 0.891/peak, main NORM on bus, survives preset round-trip |
| `test:logic-project` / `test:logic-arrange` / `test:logic-stems` | Logic writers never change blob length; arrangement places right sequences/lengths; stem→track pairing by index not arrival |
| `sweep:xpj` | parse every .xpj through the real parser → stable hit tables for diffing |
| also: `test:library`, `test:user-drums`, `test:user-samples`, `test:youtube`, `test:range-serve`, `test:disk-usage`, `test:stems-cache`, `test:resample-pad`, `test:drum-mutegroups`, `test:chop-seq-standalone`, `test-exports-main.js` (Electron hidden-window export suite) |

---

**Rebuild checklist for a native DAW (file compatibility):** read/write `ChopPreset` JSON with every optional field tolerated and the two legacy fallbacks (single-pattern seq fields; `drums._inputQuantize`); resolve `videoId` kinds (YouTube id → library `meta.videoId` lookup, R2 id, `asset:<sha1>` → `<presets>/assets/<hash>.*`, `'none'`); implement the stored-zip `.tprojz` (project.json/manifest.json/samples/<hash>.<ext>); SHA-1 content addressing with `<hash>.json` sidecars; `library.json` v1 tree with `link:`/`user:` virtual ids; `samples.json` index order as the drum-sample contract; 16-bit TPDF quantiser identical to `encodeWAV`/`quantizeTPDF16` so FLAC/WAV exports stay byte-comparable; `.mpcsample` ACVS header + 128-slot descending bank; `.adg` template constants (`ReceivingNote 4+pad`, `ChokeGroup`, `RelativePathType 6`).