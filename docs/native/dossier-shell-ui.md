# TERMINATOR — APP SHELL / UI / GATING / PLATFORM DOSSIER
Repo `~/terminator`, branch `mpc-stem-extractor`, read-only survey 2026-08-22. Chopper version `package.json` **2.2.4**; web SW `v192`.

---

## 1. PRODUCTS IN THIS REPO

| Product | Entry | How entered | Size | Own main process | Part of "Terminator the DAW"? |
|---|---|---|---|---|---|
| **Chopper ("Terminator", T-800)** | `src/renderer/index.html` → `main.tsx` → `App.tsx` → `chopper/ChopperView.tsx` | DMG/EXE (`electron-builder.json`) or KCC iframe at `/terminator` (`public/terminator-app/`) | `chopper/` 27.9k lines + `drums/` 4.2k + `bass/` 2.3k + `audio/` 4.0k + `arranger/` 1.2k + `src/mixer/` | `src/main/main.ts` | **YES — this is the product** |
| **HardwareView (web/mobile layout)** | same HTML, `chopper/HardwareView.tsx` (2786 lines) | phone auto-route, `?ui=mobile`, `?v2`/`?hardware`; **never in Electron** (`forceClassic = !isWeb`, ChopperView:567) | part of chopper | – | YES (alternate layout, own engine instances) |
| **Finish Him / Beat Finisher** | `finishhim/FinishHimPortal.tsx` (1197 lines) | BEAT FINISHER section header (ChopperView:5607) / `⚡ FINISHER` tab (HardwareView:1966); pro-gated | 1 file | – | YES — the arranger UI (engine in `arranger/`, previews through the chopper transport; AI suggestions via KCC `/api/finish-him`) |
| **MPC Extractor** | `src/renderer/mpc-extractor.html` → `mpc/App.tsx` (3460 lines) | own DMG/EXE (`electron-builder.extractor.json`, `src/main/extractor-main.ts`, EXTRACTOR_VERSION 1.5.0) or KCC `/stems` | `mpc/` 20k lines | `extractor-main.ts` (explicitly "completely separate… different appId") | NO — separate product; shares repo + some exporters/audio utils/help pattern |
| **THE BOARD / Producer Sim** | no HTML entry; `board/main.ts` lazy-imported by `mpc/TheBoard.tsx` | type `theboard` in the Extractor (mpc/App.tsx:649) or header button (:1574) | 131 files / **51.4k TS lines** (sim/ 77 files, 25.6k) — biggest thing in repo | rides the Extractor's | NO — Extractor's 3D front-end + game; own audio engine (`board/audio.ts`); paywall `board/gate.ts` with `PAYWALL_OFF = true` since 2026-08-05. Only chopper coupling: `chopper/transfer/projectTransfer.ts` reuses the board WebRTC net stack |
| **Preferences window** | `preferences/preferences.html` → `PreferencesWindow.tsx` | Electron-only second BrowserWindow | 663 lines | via `src/main/preferences.ts` | YES |

Shared across chopper layouts: engines (`ChopperEngine`, `DrumEngine`, `BassEngine`, `MixerEngine`), exporters, `Help.tsx`, `ThemeMenu.tsx`/`hwPalettes.ts`, `SampleBrowser`, `DrumBrowser`, `TransferModal`, `projectAssets.ts`. `TERMINATOR-DESKTOP-PLAN.md` describes a separate future C++/JUCE "terminator-desktop" repo (VST3/AU hosting) — nothing in this repo implements it; the 2026-08-22 native-build question was answered "not now; trigger = multi-channel I/O or plugin hosting".

Dead code a rebuild must not port: `const isWebUI = true` (ChopperView:9) kills every `!isWebUI` branch (STRETCH toggle 4856–4884, `wave-actions-row` 5209, second preset panel 5453–5493, `▶ YOUTUBE FOLDER` 4772); `components/EffectsPanel|MasterSection|TrackStrip|Transport|WaveformDisplay.tsx` are unreferenced; `renderer/drive.ts` dead (R2 replaced it).

---

## 2. SCREEN MAP — desktop ChopperView (JSX 4554–5953)

Root `.chopper-view[data-layout][data-uisize][data-palette]`. Nine free-positioned `DraggableSection`s (snap 16px, 4 corner resize handles) with ids `LOAD, WAVEFORM, PADS, SEQUENCER, DRUMS, BASS, BEAT FINISHER, EXPORT, MIXER` (:268). Layout presets cycled by `▦`: `default / two-col / mpc / scroll-size`; persisted via `chopper:saveLayout`; `⇧⌘L` re-arrange mode shows `✓ DONE` / `RESET LAYOUT` (4564).

| # | Panel | Line | Controls (exact labels) |
|---|---|---|---|
| 1 | Brand bar `.app-mode-bar` | 4571 | `T-800` + `v2.2.4` (click → ThemeMenu) · `▦` layout cycler · `Buy Terminator — $40` (free tier) · `⬇ DESKTOP APP` (web+subscribed) · `?` Help · `⚙` Preferences (Electron) · `↺` Undo · `↻` Redo |
| 2 | LOAD toolbar | 4669 | `PLAYLIST` select · `⤓ GET SAMPLE`/`PULLING…` · `⊞ BROWSE` · `📁 LOAD FILE` (`<label>`-wrapped file input; `🔒` when free) · `● RECORD SAMPLE` (Electron) · `⬇ DL PLAYLIST`/`CACHED n/m`/`DEL xxMB` (Electron) · `<UrlInput>` YouTube URL (Electron) · BPM input (click-to-type, wheel, popup) · `TAP`/`TapTempoButton` · metro sound `CLICK · HI-HAT · RIM · KICK · CLAP` · `♩ ON/OFF` · `INPUT Q` 0–100 fader (MIDI-mappable) |
| 3 | PRESETS `.chopper-web-presets` | 4890 | `Project name…` · `SAVE PROJECT` (⌘-click = Save As; right-click menu `Save / Save As… / Save As Copy`) · `OPEN…` · `NEW` · `⇩ FILE` · `LOAD PROJECT…` select · `DEL PROJECT…` select · overwrite confirm |
| 4 | UI size | 4974 | `S M L` |
| 5 | MIDI row | 4991 | `MidiStatusPill` (LED, device, `RESCAN`, monitor) · `MIDI ON/OFF` · `MidiLatencyMeter` · `LEARN` · `KILL` · `TAP TEMPO` |
| 6 | Transport | 5052 | `▶ PLAY` · `■ STOP` |
| 7 | RECORD SAMPLE panel | 5070 | `INPUT` select (`🎙 Microphone / plugged-in input`, `Mic / Interface` group, `🔁 Terminator output — resample what you play`, `🖥 System Audio` non-Mac) · `● REC`/`■ STOP` · meter + `MM:SS` · `✓ Saved to USER SAMPLES` · `→ PAD n ×` |
| 8 | Download progress / status strip / `StemsSplitStatus` | 5129–5158 | |
| 9 | **WAVEFORM** (left col) | 5163 | pad-source banner (`SOURCE · PAD n`, `✂ CHOP ×2 ×4 ×8 ×16 HITS`, `← MAIN TRACK`) · `<WaveformView>` zoom `+ − FIT` + wave actions `⊹ SNAP`, `◁ REV`, `RESET`, `✂ TRIM`, `NORM`+dB, `✂ STEMS` (+ `DR BS OT VX` chips; right-click menu `WHOLE SAMPLE — FAST / FINE / ✕ REMOVE STEMS`) · knobs `ATTACK, PITCH/TEMPO, FINE, START, END` (MIDI-mappable) · TRIM right-click `✂ DELETE SECTION / DESELECT` |
| 10 | **PADS** | 5382 | `<PadGrid>` — web desktop = 16-col grid up to 80 pads; 36 keyboard slots per bank, `-`/`=` bank; `MOVE` tool; pad context menu (see below); `LinkPrompt` |
| 11 | **SEQUENCER** (right col) → `Timeline.tsx` | 5497 | `SeqPager` `◀ SEQ n/m ▶ + ⧉ ✕` · `▶ PLAY/■ STOP` · `LOOP` · `○/● STEP` · `○/● REC` (count-in) · `n BARS` · grid resolution · `TRIPS` · `CLEAR`; per-step VELOCITY/SWING (recent commits) |
| 12 | **DRUMS** → `DrumSection.tsx` | 5541 | genre `Boom Bap / Trap / West Coast` · generate · `browse` · `DRUM PADS` · `CLEAR` · `🎲` · `CLIP` · `SWING` · `INPUT Q` · `GRID 1/8·1/16·1/32·OFF + T` · `BARS 1·2·4` · `＋ ADD SOUND` · step graphs `VELOCITY / SHIFT / PAN / REPEAT`; DrumBrowser (kits, `MY DRUMS`, folders) |
| 13 | **BASS** → `bass/BassSection.tsx` | 5570 | `SYNTH` show/hide · `PATCH` (FACTORY/USER) `SAVE/DEL/INIT` · `LEARN` · `KEY` + scale · `🔒 LOCK` `CONFORM` `FOLD` · `MIDI IN` · meter; Model-D style: 3 OSC (wave/SHAPE/range/SEMI/FINE/PW/LEVEL), SUB/NOISE/DRIVE, filter LADDER/OTA/DIODE LP/BP/HP, CONTOUR + LOUDNESS envs, GLIDE/DRIFT/LEGATO/POLY, mod matrix, `<PianoRoll>` with bend lane + slides |
| 14 | **BEAT FINISHER** | 5605 | header-only launcher → FinishHimPortal (xbox/ps2/mac skins, intro video `TAP TO SKIP ▶`, arrangement grid rows ARRANGEMENT/CHOPS/drum lanes/BASS, `Undo/Redo`, `◀ Preview ■ Stop`, export target + format, `Export ›`) |
| 15 | **EXPORT** | 5620 | format select: `Master Mixdown`, `Trackouts (Chops + Drums)`, `MPC Project (.mpcsample + WAVs)`, `Ableton Drum Rack (.adg)` (hidden/commented: original-wav, seq-wav, seqs-zip, mpc-pattern, midi) · `WAV`/`FLAC` toggle · `⬇ EXPORT` + progress |
| 16 | **MIXER** → `src/mixer/MixerSection.tsx` (full width) | 5726 | `GAIN MATCH`, `PDC`, `CONSOLE SSL/NEVE/API` + amount, `SENDS`, `S M L`; strips = sample strips + 4 sends + MASTER; each: name, FX chain (drag, ⌘-drag copy), meter, fader (right-click `0 dB / −∞ / Set value… / MIDI Learn / Clear MIDI`), pan, `M S`, `S1–S4`; master `CLIP` (Electron) + LUFS `M S I TP` → `LoudnessPopup` (BS.1770 + spectrum). Insert FX: `CLIP, WAVE, SAT, MB SAT, WIDE, M/S EQ, PAN, PHASER, FLANGER, VINYL/TAPE, FILTER, EQ, COMP, SC COMP, DELAY, REVERB, UTILITY` |
| 17 | Export bar | 5735 | `■ STOP` (panic) · `SIGN OUT` |
| 18 | Free-tier banner | 5767 | `FREE TIER · n pulls left · NOW ON macOS & WINDOWS · tap to unlock — $40 once` |

**Modals/overlays (tail 5772–5951):** `SubscribeModal`, `HelpModal`+`TipLayer`, intro video, `FinishHimPortal`, `SampleBrowser` (LCD, spectrum seek, `▶/❚❚ VOL PITCH`, filter, `LibraryTree` roots `TERMINATOR SAMPLES`(R2)/`DOWNLOADED PLAYLISTS`/`RECORDINGS`/`YOUTUBE`/`IMPORTS`/`USER SAMPLES`/linked; tree tools `＋ FOLDER ＋ FILES ＋ LINK FOLDER ▶ YOUTUBE`; row menu `Load / Load to new pad / Preview / New folder / Import files… / Add folder… / Cut Copy Paste Move to Copy to Duplicate / Rename / Delete… / Reveal in Finder`; footer `★ LOAD PRESET ⤓ LOAD → PAD ⤓ LOAD`), `OpenProjectModal` (tabs `Local | Cloud`, search, `Change folder… / Use default / Open`, `Browse… Refresh Open file… ⇄ Transfer to device ⇣ Receive`; `mode="save"` variant), `TransferModal` (8-char code send / `XXXX XXXX` receive), `EulaModal`, `SignInModal`, `ThemeMenu`. **Pad context menu** (PadGrid:544–787): `▶ Play`, select, `⇣ Load link from clipboard`, `⇣ Import link…`, `📁 Load file…`, `● Record into pad`, `Cut Copy Paste Duplicate Move… Move to empty`, `NOTE ON`, `LOOP`, `Resample`, `↥ Make main track`, `Group ▸`, `Stems ▸` (DR/BS/OT/VX/ALL), `Mixer ▸`, `Mute group ▸`, `Clear`, `Clear block (a–b)`. Ghost-drag block moves with push preview.

**Native app menu** (main.ts:487–606): Terminator (`About`, `Check for Updates…`, `Preferences…`, `Hide`, `Quit`) · File (`New ⌘N`, `Open… ⌘O`, `Save ⌘S`, `Save As… ⇧⌘S`, `Recent Projects ▸` max 10, `Preferences… ⌘,`) · Edit (roles + disabled shortcut-doc rows; `Re-arrange Layout ⇧⌘L`, `Reset Layout`) · Transport (`Play/Stop Space`, `Export ⌘E`) · Window. Menu → renderer via `shortcut:*` channels (`playStop savePreset export rearrange resetLayout new open saveAs`) + `file:loadRecent`.

### HardwareView (phone) differences
Routing: `uiMode.ts` `auto|desktop|mobile`, key `terminator.uiMode`; AUTO = touch AND `min(screen.w,h) < 600` → **iPads get desktop**; `?ui=` one-load override; switching reloads (confirm). Portrait: header (`TERMINATOR` logo→ThemeMenu, `?`, `↩ ↪`) · resizable DISPLAY (title, MIDI pill, big VT323 BPM drag/tap, LED spectrum, count-in) · tabs `LOAD · WAVE · SEQ · MIXER` (🔒 on pro tabs) · **pads always on screen** (banks `A B C D`, surface cycle `DRUMS→BASS→CHOPS`, 2×2 LIVE drum surface, bass surface with KEY/SCALE) · transport `REC STEP PLAY STOP METRO`. LOAD: `↻ GET SAMPLE ≡ BROWSE LOAD FILE ● REC INPUT ↺ REV RESET` palette/`4K` toggles, `PITCH` knob, PROJECTS (`SAVE`, `LOAD PROJECT…`, `DEL PROJECT…`, `⇄ TRANSFER ⇣ RECEIVE ⇩ FILE`). WAVE: `+ − FIT SNAP NORM CLEAR`. SEQ: `CHOP SEQ · DRUM SEQ · BASS` + `⚡ FINISHER` (reskins `.hw-chop-skin/.hw-drum-skin/.hw-bass-skin`). MIXER: custom pointer-capture faders (native range scroll-hijacked in iOS iframe), LUFS row, `EXPORT MPC · ADG · STEMS · MIX`. Landscape early-return: tabs `LOAD SEQ DRUMS BASS MIXER ◐ ?` + bottom 8 pads. Mobile-only: chassis, palettes, 4K key `terminator.hwFinish`, LIVE surface, landscape; no keyboard pad triggering, no DAW mixer (mixer blob preserved through `lastMixerRef`). Pad rule verified: number bottom-right (`{idx+1}` unpadded), `□` menu bottom-left, lit red `#7a1000/#aa2010` (palette/4K override to accent), snap default OFF, MIDI note−36 = pad.

---

## 3. KEYBOARD MAP + tooltip/help rules

Main handler ChopperView 4217–4419 (skips text entry, piano roll, SampleBrowser open); pad triggers 3706–3751 web / `PadGrid captureKeyboard` Electron.

| Key | Action |
|---|---|
| `Space` | transport play/stop (seq + drums + bass); `Space×2` <300 ms = panic |
| `Esc` | leave TRIM → stop all pads + clear selection; Help: unwind one level |
| `1234567890 QWERTYUIOP ASDFGHJKL ZXCVBNM` | pads 0–35 of bank; playing+empty pad = drop chop |
| `-` / `=` | prev/next 36-pad bank (Board arranger: bars zoom) |
| `\` | slice at playhead onto next empty pad |
| `,` / `.` | zoom in/out around last pad |
| `←`/`→` (+Shift fine) | focused chop start to prev/next transient / nudge |
| `[` / `]` (+Shift 0.1) | focused pad pitch ∓0.5 st (Board: lane height) |
| `↑`/`↓` | formerly master pitch — now owned by piano roll |
| `Backspace`/`Delete` | clear focused/selected pads or cut TRIM |
| `⌘S` save · `⌘Z`/`⇧⌘Z`/`⌘Y` undo/redo · `⌘X/C/V` pads (or TRIM cut) · `⌘N ⌘O ⇧⌘S ⌘E ⌘, ⇧⌘L` via menu · `⌘R` reload (main.ts:644) · `⌘⇧I` DevTools dev-only |

Help (`Help.tsx`, HELP-MENUS.md canonical): copy is data (`Topic{id,title,blurb,body:Block[]}`, blocks `h|p|k|tip|split{d,m}`); 17 topics (`start beat load chop stems pads seqchop seqdrums bass mix finish export save look phone keys tiers`); search = whole-article `topicText/matches/snippetFor(−32/+60)`, `<Mark>` highlighting via text nodes, empty-needle guard, ESC unwinds one level, `‹ BACK TO RESULTS` vs `‹ ALL TOPICS`, never autofocus on coarse pointer (`hoverCapable()`), 16px input on phones, 44px targets; portalled modal `T-800 / HELP / ✕ / DONE`; three entry points (brand bar, hw header, landscape tabs). **Tooltips**: `TipLayer` reads `data-tip` else native `title=` (~110 in ChopperView), blanks/restores title, bails on coarse pointer, key `terminator.tips` default ON, switch lives in Help. House rule: every add/remove updates help + tooltips in the same commit.

---

## 4. PREFERENCES (`PreferencesWindow.tsx`, separate 500×600 always-on-top BrowserWindow, stored in `userData/terminator-settings.json` via `settings:get/set`, broadcast `settings:changed`)

| Tab | Settings |
|---|---|
| **AUDIO** (`settings.audio`) | Buffer Size `Auto / 128 / 256 / 512 / 1024` (`bufferFrames`) · Sample Rate `Auto (system) / 44100 / 48000` (`sampleRateHz`, read sync at boot via `settings:getSync`) · Sequencer Resolution PPQ `24 SP-1200 / 48 LM-1 / 96 MPC60 / 192 / 480 / 960 MPC4000` (default 960) · Output Device · Input Device |
| **MIDI** (`settings.midi`) | per-device toggles `inputs{}` `outputs{}` (default on) · `MIDI Clock (send)` · `MIDI Clock (follow tempo)` · `MIDI Channel 1–16` |
| **FOLDERS** | Projects (`CHANGE… / USE DEFAULT / OPEN`, `projectsDir`) · Sample Library (`MOVE LIBRARY THERE / JUST POINT / USE DEFAULT / OPEN`, `libraryDir`, default `~/Music/Terminator`) · User Samples `OPEN` · Drums (`OPEN`, `EMPTY…` → Trash) · YouTube `OPEN` · STEMS: engines FAST/FINE `DOWNLOAD ⇣ n% / DELETE`, models dir (`stemsModelsDir`), audio store `CLEAR ALL`, per-song `DELETE`, `OPEN ENGINES / OPEN AUDIO`; disk sizes per row (`chopper:folderSizes`) |

Other persisted state: `section-layout.json`, `midi-map.json`, `bass-patches.json`, `terminator-session.json`, `terminator-presets/` (+ `assets/<sha1>.<ext>`+`.json`), `user-playlists.json`, `user-samples/`, `eula-accepted.json`, `terminator-eula-records.json`, `terminator-license.bin`, `terminator-stems/gpu.json`, `recentProjects` in settings. localStorage: `terminator.theme`, `.finish`, `.dust`, `.hwPalette.on/.id`, `.hwFinish`, `.uiMode`, `.tips`, `terminator.free-pulls`.

---

## 5. GATING

| Surface | Rule | Code |
|---|---|---|
| Web (KCC iframe, prod) | `?sub=1` = subscribed; else free tier: 3 pads, 10 pulls (`terminator.free-pulls`), seq/drums/FX/presets/export greyed (`body.tt-locked`, `.tt-gated-*`), `Buy Terminator — $40` → `/api/checkout/terminator-lifetime`; `?auth=1` shows SIGN OUT; `?demo=1` = all pads/sections playable, no save/rec/export/finisher, limited themes, 10 listens then popup | `lib/subscription.ts`, `App.tsx:74`, `ChopperView:1200–1270` |
| dev:web tunnel | `__TERMINATOR_WEB__=false` → always unlocked | `vite.config.ts:167` |
| Electron dev | `import.meta.env.DEV` → unlocked, no sign-in overlay | `subscription.ts:39`, ChopperView:642 |
| Electron packaged | EULA first (`eula:status`; name+email → local JSON + Supabase `eula_acceptances` insert with anon key; Formspree slot empty) → `SignInModal` (`SIGN IN VIA BROWSER` → `terminator://auth?code&state` deep link, nonce in memory, code→device token via KCC `/api/terminator/desktop-token`, stored `safeStorage`-encrypted; `license:check` re-validates `/api/terminator-check` every launch, 401/403 → locked, 7-day offline grace; `GET TERMINATOR ($40)`; `Continue with limited access →` = free tier) | `desktopLicense.ts`, `desktopAuth.ts`, ChopperView:633–678 |
| STEMS | desktop-only (worker in main); web click → desktop download upsell; free desktop → SubscribeModal | `stemsController.ts:57`, ChopperView:3188/3841 |
| SubscribeModal | LIFETIME $40 vs KCC SUITE; `Already own it? Download the desktop app →` | `components/SubscribeModal.tsx` |
| Board | `gate.ts` $9.99 early access, `PAYWALL_OFF = true` | board/gate.ts:45 |
| Discord | `DISCORD_INVITE = https://discord.gg/tGcfa8KJpe` (Extractor help + Board help; not chopper) | `lib/discord.ts` |

Cloud presets (`presets:list/save/delete`) proxy to `https://killaviccheatcodes.app/api/terminator-presets` with the device token (main only).

---

## 6. MAIN-PROCESS SURFACE (`src/main/main.ts`, preload `src/preload/preload.ts` → `window.terminator`)

Window: `BrowserWindow 1280×900 min 900×600, frame:false, titleBarStyle hiddenInset, bg #0a0a0a, contextIsolation, sandbox, nodeIntegration off, devTools only unpackaged`, maximized, loads `index.html?classic=1`; `will-navigate` locked, `setWindowOpenHandler deny`; native right-click Cut/Copy/Paste/Select All; `⌘R` reload; permissions granted only `media, midi, midiSysex`; Chromium switches `AudioServiceOutOfProcess` off, `autoplay no-user-gesture`, `WebMIDI`; `electron-audio-loopback initMain({forceCoreAudioTap})`. Single-instance lock → `second-instance` routes `terminator://` or `.tproj(z)` argv; macOS `open-file`/`open-url`; `protocols: terminator`. Updater: packaged only, 3 s deferred silent check, autoDownload, `Restart Now / Later` dialog; manual `Check for Updates…` dialogs every outcome; feed generic R2 `terminator-electron/latest-mac.yml|latest.yml`. MPC card: poll every 2 s (`mpcDetector` — PowerShell Get-Volume / diskutil / lsblk; export dir `<card>/<MPC…>/Samples/User/TERMINATOR`) → `mpc:status`; `mpc:eject` (Shell.Application Eject + mountvol / `diskutil eject` / udisksctl). Preferences window separate (see §4).

Custom protocols (privileged, stream): `terminator-cache://<file>` (YouTube folder), `terminator-lib://file/<nodeId>` (range-aware library files), `terminator-drums://sample/<16hex>.flac|mp3` (bundled `Resources/drums-flac`) and `://user/<rel>`.

| Channel group | Channels → purpose |
|---|---|
| License | `license:startBrowserSignIn`, `license:check`→`{unlocked,email}`, `license:signOut`, `license:openBuyPage`; event `auth:signed-in` |
| Cloud presets | `presets:list/save/delete` |
| Stems/MPC export | `export-stem`(save dialog WAV), `export-all-stems`(folder), `mpc:export-all`(card), `mpc:eject`; event `mpc:status` |
| YouTube/playlists | `chopper:listPlaylists` (local `data/*.json` else R2 `playlists.json`), `chopper:downloadYouTube`→`{cacheUrl,title,durationSec,videoId}`, `chopper:cacheStatus`, `chopper:downloadPlaylist` (5 workers, event `cache:progress`), `chopper:deletePlaylistCache`, `chopper:getCacheDir/setCacheDir(noop)/getCacheDirInfo/resetCacheDir/revealCacheDir`, `chopper:getUserPlaylists/addUserPlaylist/removeUserPlaylist` |
| Presets/session | `chopper:savePreset/loadPreset` (per videoId), `saveSession/loadSession`, `listNamedPresets/saveNamedPreset/loadNamedPreset/deleteNamedPreset` |
| Projects | `chopper:openProjectDialog`, `readProjectFile`, `listProjectFiles`, `deleteProjectFile`, `showSaveDialog({bundle})`, `saveProjectFile`(.tproj JSON), `saveProjectBundle`(.tprojz), `getProjectsDir/chooseProjectsDir/resetProjectsDir/revealProjectsDir`; assets `chopper:assetPut/assetGet/assetHas` (sha hash); events `project:open-file`, `file:loadRecent`; `recents:get/add/remove` |
| Persistence blobs | `chopper:saveLayout/loadLayout`, `saveMidiMap/loadMidiMap`, `saveBassPatches/loadBassPatches` |
| Settings/prefs | `settings:get`, `settings:getSync`, `settings:set` (broadcast `settings:changed`), `prefs:open` |
| EULA | `eula:status`, `eula:accept(name,email)` |
| Library | `library:get/listLink/searchLinks/createFolder/rename/move/copy/duplicate/remove/importPaths/addR2Ref/importR2/reveal/pickFolder/pickFiles/saveRecording/youtubeImport/youtubeCancel`, `library:getRoot/chooseRoot(move|point)/resetRoot/revealRoot`; events `library:changed`, `library:yt-progress`, `library:moveProgress` |
| Stems | `stems:split{pcmL,pcmR,srcRate,quality fast|fine,windows,sweep}` (≤10 min), `stems:queueWindow`, `stems:cancel`, `stems:running`, `stems:modelsInfo`, `stems:downloadModels`, `stems:deleteModels`, `stems:cacheGet/cachePut/cacheDrop`, `stems:usage`, `stems:deleteSongStems`, `stems:clearAudio`, `stems:revealAudio/revealModels`; events `stems:progress/chunk/done/error/engine/modelProgress`. Worker = forked **real Node** (`bin/stems-node`) + onnxruntime (Electron-as-Node SIGTRAPs) |
| Drums/user | `drums:userList/userDir/userReveal/userEmpty`, `chopper:folderSizes`, `chopper:saveUserSample/listUserSamples/deleteUserSample/loadUserSample` |
| Misc | `chopper:startDrag` (native file drag-out), `chopper:getDesktopSources`, `chopper:revealInFinder`, `chopper:openExternal`, `clipboard:readText`, `enable-loopback-audio/disable-loopback-audio`, `pathForFile` (webUtils) |

Web shim `ipc-browser.ts` mirrors the same shape over IndexedDB (`kv`, `audio`), R2 playlists, blob downloads; desktop-only calls return `{error:'Not available on web.'}`; `eulaStatus` → accepted, `checkLicense` → locked.

---

## 7. PACKAGING / PLATFORM

- **Build**: single `vite.config.ts` (root `src/renderer`, modes default=Electron renderer → `dist/renderer`, `web` → `dist-web` base `/terminator-app/`, `extractor` → `dist-extractor`); pages `main`, `mpc`, `preferences`; `electron.vite.config.ts` is **empty (0 lines)**; main via `tsc -p tsconfig.main.json` → `dist/main`. Defines `__TERMINATOR_WEB__`, `__DEBUG_TOOLS__`, `__TERMINATOR_VERSION__`. CSP only in `cspByMode()` (dev vs prod; connect/media-src: R2 pub domain, `board-signal` + `kcc-samples` workers, killaviccheatcodes.app, Supabase, custom schemes; prod `script-src 'self' 'wasm-unsafe-eval'`).
- **electron-builder.json**: appId `com.terminator.audio`, `files: dist/**, data/**` (minus `dist/drums`), `asarUnpack` onnxruntime-node/common + `stemsWorkerChild.js`/`stemsResample.js`, `afterPack` prunes foreign ORT slices. **mac**: `dmg + zip` **universal**, hardened runtime, notarize, identity `S7QVJJHXJ4`, entitlements (JIT, unsigned-exec-mem, disable-library-validation for yt-dlp, audio-input), `x64ArchFiles` for ORT/bin, file associations `.tproj/.tprojz`; extraResources `bin/mac/ytdlp` (onedir nightly, spawned with `--js-runtimes node:<electron>`), `bin/stems-node/darwin-arm64|x64`, `ort-darwin-x64` (ORT 1.23.2 Intel fallback). **win**: `nsis x64`, unsigned (SmartScreen), extraResources `bin/win/ytdlp`, `bin/stems-node/win-x64`. **all**: `drag-icon.png`, `drums-flac/*.flac|mp3` (~1182 files; DMG ≈ 490 MB). Linux icon only. Publish generic R2 `terminator-electron/`. Windows exe built by GitHub Actions "Release Windows — Terminator".
- **Native/heavy deps**: electron ^41, electron-builder ^26.8, react 19, vite 8, onnxruntime-node ^1.27 (+1.23.2 alias), electron-audio-loopback, electron-updater, soundtouchjs, lamejs, three/yuka/mediabunny (Board), sharp (dev).
- **Web build**: PWA `manifest.webmanifest` (`T-800`, theme `#00ff96`), `sw.js` `CACHE_VERSION v192` (shell network-first, hashed assets cache-first; register only in `MODE==='web'` non-localhost), deployed by rsync into ss `public/terminator-app/`, phone testing via cloudflared tunnel. Electron-only: yt-dlp URL/playlist download, RECORD system audio, STEMS, MPC card, library/folders, Preferences, native drag-out, .tproj files, menu/updater. Web-only: `?sub/?auth/?demo`, HardwareView, IndexedDB persistence, R2 playlist browsing.

---

## 8. THEMES / LOOK

Three axes. **Colour theme** (`themes.ts`, `body[data-theme]`, key `terminator.theme`): `platinum PLATINUM #c9ccd1`, `gold 24K GOLD #c9a13c`, `terminator TERMINATOR #00ff88` (default), `gta3 GTA 3 — NYC RAIN`, `ff7 FF7 — SHINRA REACTOR`, `sonic SONIC — GREEN HILL`, `outrun MARIO`, `vicecity STREET FIGHTER 2`, `transformers TRANSFORMERS G1`, `macos MAC OS — SYSTEM 7`, `macos9 MAC OS 9`; per-theme overlay layers (`lyr-rain/scan/grid/sun/palms…`) + looping MP4 for transformers/ff7/macos (`public/themes/`); metal themes always 4K (`data-metal`). **Hardware palettes** (`hwPalettes.ts`, 15: Linen default, Sand, Wheat, Clay, Paper, Slate, Midnight, Plum, Mono, Electric, Crimson, Honey, Tangerine, Glacier, Lavender; off = phosphor green/navy). **FINISH axis** `classic|4k` (default 4K; desktop key `terminator.finish`, mobile `terminator.hwFinish`): oklab three-stop metal ramp derived from live palette (`--m-base/hi/mid/lo/deep/ink/acc/room/lcd`), fixed upper-left key light (`--ldx -0.5 --ldy -0.7 --lang 155deg`), hairline bevels + grain, recessed-glass display, milled keycaps, **emissive lit elements** (lit pads/buttons/LED steps/meters glow), IBM Plex Mono HUD; `DUST` pixel pointer trail (`luxe/fairyDust.ts`, desktop, default OFF); `hitFlash.ts` LED flare on playhead. Rejected: light following the mouse. Fonts `Outfit` / `DM Mono` / `VT323` (BPM digits). Phosphor palette `#26d64e/#16883a/#35ff69`, chassis `#bbb8b2`, navy `#2a324b`; LCD with scanlines; chunky chiclet pads (asymmetric borders, 3px press travel), lit red `#7a1000/#aa2010`; tiny uppercase letter-spaced labels; `T-800` brand; scanline overlay; demo limits `DEMO_THEMES {terminator,gta3,ff7}` / `DEMO_PALETTES {linen,slate,lavender}`.

---

## 9. BACKLOG a rebuild should fold in

| Item | Source |
|---|---|
| Time-stretch off the synchronous trigger path (pre-render cache per chop/ratio) | BACKLOG.md #4 |
| Richer waveform, metering, animations, theme consistency; desktop text size revisit | BACKLOG.md |
| Re-enable MPC Pattern + MIDI export rows; delete `drive.ts` | BACKLOG.md |
| Drum export ignores per-step VELOCITY/PAN/SHIFT/REPEAT + triplets; gain-match not baked; per-pad-buffer pads manual≠seq/export | audio_engine_pass Owed |
| Drums bundled + USER folder organiser in both browsers (built, partly unpushed); "showing 2,000 of N" notice | queue files |
| NEW PROJECT button, cents fine-tune fader, bass Save-As rules, Save As Copy menus, MIDI CLOCK SEND, MIDI pitch-bend → bass + automation lane, MPC-as-controller for BASS | queue 2026-08-19 |
| STEMS on Intel Macs: friendly "needs Apple Silicon/Windows" message; Windows bump to 2.2.4 | desktop release memo |
| Peak-meter worklet (52 analysers ≈ 9 pts audio thread) | electron lag memo |
| Launchkey fader ON/OFF under MIDI learn (blocked on his readout) | queue |
| Ear passes owed: console flavours, FX defaults, 4K feel, bass module, trap sounds | memories |
| Extractor/Board engine divergences (BUGHUNT §A/§B) — out of chopper scope | BUGHUNT-2026-08-02 |
| Git history contains real-named drum MP3s (force-push decision) | audio_engine_pass |

---

## 10. ALSO DON'T FORGET

- **No analytics/telemetry**: no Sentry/PostHog/gtag anywhere; only outbound data paths = EULA insert to Supabase (`eula.ts`, hardcoded anon key; Formspree `WEBHOOK_URL=''`), license check/preset sync to KCC API, R2 fetches, `board/gate.ts` activate, `workers/board-signal` relay. Analytics designed-not-built (blocked on "Nothing uploads" wording in mpc/App.tsx).
- **Versions**: chopper = `package.json` only (`__TERMINATOR_VERSION__` shown as `v2.2.4` superscript, ChopperView:4585); Extractor `EXTRACTOR_VERSION` + `extraMetadata.version`; `public/extractor-version.json` is a stale 1.0.0 artefact, unused by any updater; live feeds Chopper Mac 2.2.4 / Win 2.2.3, Extractor 1.5.0.
- Release authority `RELEASE-CYCLES.md` (binaries first, verify 200+size, yml last, never regress versions, smoke-test packaged app, link bump in ss `utils/<app>/downloads.ts`).
- Projects: `.tproj` (JSON `ChopPreset`) / `.tprojz` (zip + samples by `asset:<sha1>`), 8-char-code transfer via WebRTC, recents max 10, sessions autosave, `NO_SAMPLE_ID='none'` projects allowed.
- Sample library root `~/Music/Terminator` (`library.json` virtual tree; system folders RECORDINGS/YOUTUBE/IMPORTS/USER SAMPLES; USER SAMPLES disk-mirrored writable; Drums under root); delete = Trash, never unlink.
- Drum library served by opaque 16-hex ids (`drums-flac/` bundled, R2 `drums-flac/` fallback); `public/drums/` must never ship.
- Audio engine constraints referenced by UI: `audioClock.ts` Blob-worker look-ahead; iOS Safari rules (no fileInput.click in iframe, no WaveShaper in OfflineAudioContext, audio only in gesture); Electron `?classic=1` always desktop.
- Tests: ~60 npm test scripts (harness gates for FLAC, stems, MIDI clock, drum timing, bass synth/theory, console, logic export) — see `package.json`.