// ─────────────────────────────────────────────────────────────────────────────
// HELP + TOOLTIPS — the manual, and the labels that explain the buttons.
//
// Two things live here because they are one feature: the HELP menu teaches the
// workflow, and the tooltips teach the controls. The help window is also where
// the tooltips are switched on and off, so there is exactly one place to look.
// Same shape as the MPC Extractor's Help.tsx on purpose — one house pattern,
// two apps, so a fix to how help behaves is a fix you make twice at most.
//
// ── WHY THE TOOLTIP LAYER READS `title` ─────────────────────────────────────
// The chopper already carries ~110 `title=` attributes written next to the
// controls they describe. Re-typing those into a registry would fork the copy
// from the button on day one. So the layer reads `data-tip` if a control has
// one and falls back to `title` — every existing control gets a styled tooltip
// with no edit, and a control that deserves a fuller line gets `data-tip` next
// to it.
//
// While a tip is showing, that element's `title` is emptied so the browser's
// own yellow box cannot double up, and restored the moment the pointer leaves.
// That is also what makes the OFF switch honest: tooltips off = the native
// titles are back, exactly the behaviour the app had before this file existed.
//
// PORTALLED. Both the card and the window mount on <body>, like ThemeMenu:
// ChopperView renders inside DraggableSection wrappers that carry transforms,
// and `position: fixed` inside a transformed ancestor is positioned against
// that ancestor, not the viewport. Portalling is what keeps the maths true.
//
// TOUCH: the tip layer is skipped entirely on coarse pointers. A tooltip that
// needs a hover is a tooltip a phone can never show, and a tap-to-reveal card
// would fight every button it covers. On a phone the HELP menu IS the manual —
// which is why it is in the header of both layouts, not just the desktop one.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const TIPS_KEY = 'terminator.tips';

/** Tips are ON until switched off — a new user is the one who needs them, and
 *  they are the one who has not been to the help menu yet. */
export function readTipsEnabled(): boolean {
  try { return localStorage.getItem(TIPS_KEY) !== '0'; } catch { return true; }
}

export function writeTipsEnabled(on: boolean): void {
  try { localStorage.setItem(TIPS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

/** Hover only. A touch device has no hover state to hang this off. */
function hoverCapable(): boolean {
  try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return true; }
}

// ── The tooltip layer ────────────────────────────────────────────────────────

interface TipShot { text: string; x: number; y: number; below: boolean }

export function TipLayer({ enabled }: { enabled: boolean }) {
  const [shot, setShot] = useState<TipShot | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The element whose native title we emptied, and what it said. Restored on
  // the way out — including on unmount, so switching tips off mid-hover cannot
  // strand a control with no title.
  const held = useRef<{ el: HTMLElement; title: string } | null>(null);

  useEffect(() => {
    const restore = () => {
      const h = held.current;
      if (h) { h.el.setAttribute('title', h.title); held.current = null; }
    };
    if (!enabled || !hoverCapable()) { restore(); setShot(null); return; }

    const hide = () => { restore(); setShot(null); };

    const over = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      const el = t?.closest?.('[data-tip],[title]') as HTMLElement | null;
      if (!el) { hide(); return; }
      if (held.current && held.current.el === el) return;   // same control, still hovering
      restore();
      const text = (el.dataset.tip || el.getAttribute('title') || '').trim();
      if (!text) { setShot(null); return; }
      const native = el.getAttribute('title');
      if (native) { held.current = { el, title: native }; el.setAttribute('title', ''); }
      const r = el.getBoundingClientRect();
      // Below the control by default; above when it sits low enough that a card
      // under it would run off the window.
      const below = r.bottom + 90 < window.innerHeight;
      setShot({ text, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
    };

    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
      restore();
    };
  }, [enabled]);

  // Keep the card on screen horizontally. Measured after paint because the width
  // depends on the text, and a clamp against a guessed width jitters.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !shot) return;
    const w = card.offsetWidth;
    const half = w / 2;
    const min = 8 + half;
    const max = window.innerWidth - 8 - half;
    const x = Math.max(min, Math.min(max, shot.x));
    card.style.left = `${x}px`;
  }, [shot]);

  if (!shot) return null;
  return createPortal(
    <div
      ref={cardRef}
      className={`tt-tip${shot.below ? '' : ' tt-tip--above'}`}
      role="tooltip"
      style={{ left: shot.x, top: shot.y }}
    >
      {shot.text}
    </div>,
    document.body,
  );
}

// ── The manual ───────────────────────────────────────────────────────────────
//
// All copy lives in TOPICS. Same contract as the Extractor's help: edit `text`,
// never reorder ids — the window remembers nothing, but the deep links do.

type Block =
  | { h: string }                    // section heading
  | { p: string }                    // paragraph
  | { k: Array<[string, string]> }   // label/description table
  | { tip: string }                  // highlighted card
  /** Desktop vs mobile, side by side. Terminator ships as two real layouts —
   *  the classic desktop view and the hardware layout phones get — and the
   *  same job is often in a different place in each. Rather than write the
   *  manual for one and leave the other guessing, anything that MOVES between
   *  them gets both answers on the same line. Stacks on a narrow screen. */
  | { split: { d: string; m: string } };

interface Topic {
  id: string;
  title: string;
  blurb: string;
  body: Block[];
}

export const TOPICS: Topic[] = [
  {
    id: 'start',
    title: 'Start here',
    blurb: 'What this is, and where everything lives',
    body: [
      { p: 'Terminator is a sample chopper with an MPC-style pad grid bolted to it. You pull a sample in, cut it into pieces, and every piece lands on a pad you can play — with your fingers, your keyboard, or a MIDI controller. Then you sequence those pieces, put drums under them, and take the beat out as audio.' },
      { p: 'If you want to make a beat right now, go to the next chapter — MAKE YOUR FIRST BEAT walks the whole thing end to end. This one is the map.' },
      { h: 'TWO LAYOUTS, ONE MACHINE' },
      { p: 'Terminator ships as two real layouts and picks one for you. Everything below exists in both — the sections are just reached differently, and each chapter here tells you where.' },
      {
        split: {
          d: 'Sections stacked down the page: LOAD, WAVEFORM, PADS, SEQUENCER, DRUMS, BEAT FINISHER, EXPORT, MIXER. Click any section header to collapse it.',
          m: 'A machine with a screen: four tabs — LOAD, WAVE, SEQ, MIXER — with the pad grid always on-screen underneath, and REC · STEP · PLAY · STOP · METRO along the bottom.',
        },
      },
      { p: 'On a phone you get the hardware layout automatically. On a computer or an iPad you get the desktop one. Rotating a phone to landscape gives a third arrangement of the same parts (LOAD · SEQ · DRUMS · MIXER).' },
      { tip: 'Your work saves per sample. Come back to the same sample later and your chops, pads and sequences are still on it — see "Saving your work".' },
      { p: 'The version you are running sits next to the T-800 logo, top-left. The desktop app updates itself: a new version downloads in the background and asks to restart when it is ready; Terminator → Check for Updates… checks right now and tells you either way. The web app is always the latest.' },
    ],
  },
  {
    id: 'beat',
    title: 'Make your first beat',
    blurb: 'The whole thing, start to finish',
    body: [
      { p: 'Seven steps. Do them in order once and you will not need this page again.' },

      { h: '1 · GET A SAMPLE' },
      { p: 'Pick a playlist and hit ⤓ GET SAMPLE for a random track, or ⊞ BROWSE to choose one. Terminator reads the tempo of what loads, so the BPM box is usually already right.' },
      { split: { d: 'The LOAD section, top of the page.', m: 'The LOAD tab.' } },

      { h: '2 · CHOP IT' },
      { p: 'This is the part that makes it a beat. Play the sample, and while it is playing hit an EMPTY pad every time you hear something you want — a kick, a snare, the start of a phrase. Each hit cuts the sample at that exact moment and drops the piece onto that pad. You are chopping in time with the music, by feel, the way you would on an MPC.' },
      { p: 'Prefer to place cuts by eye? Tap the waveform where you want the cut. If nothing is playing it cuts where you tapped; if something IS playing it cuts at the playhead, because tapping means "now".' },
      { split: { d: 'The WAVEFORM section. \\ also cuts at the playhead without leaving the keys.', m: 'The WAVE tab — tap the waveform. The pads underneath stay live the whole time, so you can chop by ear without switching tabs.' } },
      { tip: 'Turn ⊹ SNAP on first and every cut lands on the nearest detected transient instead of a few milliseconds after it. It is the difference between a tight kit and a sloppy one.' },

      { h: '3 · PLAY THE PADS' },
      { p: 'Hit your chops and listen to what you built. Rearranging a loop by playing it in a different order is most of what beat-making is.' },
      { split: { d: 'Keyboard: 1234567890, then QWERTY, then ASDF, then ZXCV — 36 pads, left to right.', m: 'Tap the pads. Banks A B C D across the top give you 64 in total.' } },

      { h: '4 · SEQUENCE THE CHOPS' },
      { p: 'Now make it repeat. Press STEP, then hit your pads one at a time — each hit lands on the next step and the cursor moves along. Or press LIVE, let the loop run, and play your chops in time; every hit snaps to the grid. Full detail in "Sequencing your chops".' },
      { split: { d: 'The SEQUENCER section.', m: 'The SEQ tab → CHOP SEQ. STEP and REC on the bottom transport do the same two jobs.' } },

      { h: '5 · PUT DRUMS UNDER IT' },
      { p: 'Pick BOOM BAP or TRAP and press GENERATE for a full pattern to start from, then tap steps on the kick, snare and hat rows until it is yours. Chops and drums run off one transport, so they are locked together from the first press of play. The two keys are lights: PLAY glows green while the transport runs, STOP glows red when it is stopped. Full detail in "Sequencing drums".' },
      { split: { d: 'The DRUMS section.', m: 'The SEQ tab → DRUM SEQ (or the DRUMS tab in landscape).' } },

      { h: '6 · ARRANGE IT' },
      { p: 'A loop is not a song. BEAT FINISHER turns what you have into an intro, verse, hook and outro — it reads your actual chops and tempo and suggests arrangements built from them.' },
      { split: { d: 'The BEAT FINISHER section header opens it.', m: 'The ⚡ FINISHER button on the SEQ tab.' } },

      { h: '7 · TAKE IT WITH YOU' },
      { p: 'EXPORT renders that arrangement as a master mix, as trackouts, as an MPC project, or as an Ableton drum rack — your mixer settings baked in.' },

      { tip: 'Stuck at any point? Double-tap SPACE (or hit STOP) to silence everything, and start the section again.' },
    ],
  },
  {
    id: 'load',
    title: 'Getting a sample in',
    blurb: 'Playlists, your own files, recording',
    body: [
      { h: 'THE WAYS IN' },
      {
        k: [
          ['⤓ GET SAMPLE', 'pulls a random track from the selected playlist. The fastest way to start. Once you have pads in play — the main track chopped up, or any pad carrying its own sample — it pulls onto the NEXT EMPTY PAD as that pad\'s own source instead of replacing your main track; a bare main track (one whole-sample pad, nothing else) is still replaced, so you can keep rolling the dice until one sticks'],
          ['⊞ BROWSE', 'the whole library — preview tracks on the waveform before you commit to one'],
          ['📁 LOAD FILE', 'your own audio off this device: mp3, wav, aif, flac, ogg, m4a'],
          ['● RECORD SAMPLE', 'record straight off a mic, an audio interface, a virtual device (Loopback, BlackHole — they list under MIC / INTERFACE like any input), Terminator\'s own output (🔁 under TERMINATOR — resample what you play), or your system audio (desktop app, Windows). The input is taken RAW — no echo cancelling, noise gate or automatic gain (the phone-call processing a browser switches on by default, which is what made interface takes sound thin and pumpy), in stereo when the device has it, at the engine\'s rate — and saved as 24-bit WAV into RECORDINGS; the line under the button says what the input delivered (48 kHz · stereo · raw). The first open asks for the mic once so the inputs show their real names; plugging something in while the panel is open re-lists. The take lands on the NEXT EMPTY PAD as its own sample (right-click a pad → RECORD INTO to aim it at that pad instead) and is kept with the project; on the web it loads into the waveform. On a phone it is the ● REC button on the LOAD screen: one tap records off the mic or a plugged-in input — raw, the same way — (the button fills with the level and counts), one tap stops and the take lands on the NEXT EMPTY PAD (a pad\'s □ menu → RECORD INTO PAD aims it); once mic permission has been granted an INPUT picker under it chooses between the built-in mic and a connected audio interface\'s inputs'],
          ['⬇ DL PLAYLIST', 'pull a whole playlist onto your computer so it loads instantly forever (desktop app). The songs show up in the sample browser under TERMINATOR SAMPLES → DOWNLOADED PLAYLISTS → that playlist\'s own folder, so your YouTube folder stays what you pulled by hand; DL it again later and only the songs you are missing download'],
        ],
      },
      { p: 'You can also drag an audio file onto the window — or onto one single pad, which loads it to that pad alone and leaves the rest of your kit where it is.' },
      { h: 'THE SAMPLE LIBRARY (desktop app)' },
      { p: 'Everything you own lives in one visible place on your computer: the Terminator folder inside your Music folder. Inside it: Recordings (RECORD SAMPLE), YouTube (your imports, one folder per playlist), Imports (files dropped in from Finder), USER SAMPLES (your own samples — see below) and Drums (your own drum one-shots, see THE DRUMS). In RECORDINGS / YOUTUBE / IMPORTS and the folders you make beside them, the browser is ORGANISATION only: moving between folders never moves the file itself, so nothing you do there can lose a file; Delete sends the file to the Trash. USER SAMPLES is different on purpose: it is a real folder and the browser IS that folder.' },
      { p: 'WHERE IT LIVES is yours to change: Preferences → FOLDERS → SAMPLE LIBRARY. MOVE LIBRARY THERE copies your files and the index to the folder you pick — an external drive, a synced folder — and keeps the old one as a backup you can delete once you have checked the new one. JUST POINT uses a folder as-is (a folder that already holds a Terminator library is adopted; an empty one starts fresh). Never move the library folder by hand in Finder — the library remembers where its files are, so use MOVE and it all travels correctly. Preferences → FOLDERS is also where the projects folder and the audio cache live.' },
      {
        k: [
          ['CLICK / DOUBLE-CLICK', 'click a sample to preview it, double-click to load it. Click a folder to open it, double-click its name to rename'],
          ['SHIFT · CMD/CTRL', 'Shift-click selects a range, Cmd-click (Ctrl on Windows) adds one more. Everything you do next applies to the whole selection'],
          ['DRAG', 'drag samples or folders into any folder, or between rows to re-order (folders too). Hold Cmd/Ctrl while dragging to drop a COPY instead — you see a ghost'],
          ['⤓ LOAD → PAD', 'next to LOAD: puts the sample on the NEXT EMPTY PAD as its own source instead of replacing the main track — and the browser stays open, so you can stack several samples onto pads in one go (select a few, right-click, Load N to new pads)'],
          ['RIGHT-CLICK', 'on a sample: Load, Load to new pad, Preview / Stop; then new folder, import files, add a folder from your computer, cut / copy / paste, duplicate ("name 2"), rename, delete, reveal in Finder / Explorer. Delete, Cmd+C/X/V/D work on the keyboard too. Delete ALWAYS asks first — your files go to the Trash, never straight to oblivion'],
          ['↑ ↓ · SPACE · ENTER', 'after you click a sample, ↑ and ↓ step through the list and preview each one as you go; SPACE stops and restarts the preview; ENTER loads the highlighted sample; ← → pitch the preview down / up a semitone; ESC closes the browser'],
          ['DROP FROM FINDER', 'drag audio files from your computer straight onto a folder — they are copied in. Drag a whole folder (or use ＋ LINK FOLDER) and it is LINKED: it stays where it is on disk and shows up here, live, collapsed until you open it. Linked samples are read-only, but COPY one (or Cmd/Ctrl-drag it) and you get your own copy in IMPORTS; DELETE on a linked sample moves the real file to the Trash — it asks first; right-click the linked folder → Unlink folder removes it from the browser, nothing on disk changes, nothing on disk changes. It lists every folder and file, as deep as it goes, the way Finder shows it — each folder is read from disk the moment you open it, so even a 150,000-file library opens instantly; the search box reaches into it too (the first search of a session indexes the folder, which takes a moment). Right-click any song → Move to ▸ / Copy to ▸ lists every folder of yours (make one with ＋ FOLDER, or right-click → New folder — name it, say, SONGS I LIKE) and puts the selection there; Delete (or the Delete key) asks once and moves your files to the Trash. A TERMINATOR SAMPLES song dropped, pasted or Copy-to\'d into your folder is PULLED and becomes a real file you own'],
          ['▶ YOUTUBE', 'paste a video or playlist link into the YOUTUBE folder and press IMPORT — a playlist becomes its own folder, tracks arrive as they download, and you can cancel any time. Nothing to install: the downloader is built into the app'],
          ['◆ TERMINATOR SAMPLES', 'the built-in library. Drag any of its samples into your own folders to keep a reference to it there'],
          ['★ USER SAMPLES', 'your own samples, as a REAL folder inside the Sample Library (Preferences → FOLDERS → USER SAMPLES → OPEN). Everything you do here happens on disk: New folder makes a real folder, drag = move the file, Cmd/Ctrl-drag = copy, rename renames the file, Delete sends it to the Trash, and a drop from Finder (files or whole folders) COPIES them in. Drag a RECORDINGS / IMPORTS file in and the file moves here; drag one out to a folder beside them and it goes to Imports. Sub-folders nest as deep as you like; open the folder in Finder and it looks exactly like the browser'],
        ],
      },
      { h: 'THE METRONOME AND BPM' },
      { p: 'The BPM box drives the metronome, the sequencer, and the tempo everything syncs to. Terminator detects the tempo of a loaded sample on its own, so most of the time it is already right. TAP sets it by feel: arm TAP, tap the pads in time — the samples still play while you do it — and tap TAP again to lock.' },
      { tip: 'Loading a new sample when you already have chops SWAPS the audio and keeps the chops. Undo brings the old sample back.' },
    ],
  },
  {
    id: 'chop',
    title: 'Chopping samples',
    blurb: 'Cutting a sample into playable pieces',
    body: [
      { p: 'A chop is a start point and an end point on the waveform. Make one and it goes straight onto the next empty pad — chopping and building your kit are the same action. There is nothing to "confirm" and nothing to name.' },

      { h: 'THE MAIN WAY: CHOP WHILE IT PLAYS' },
      { p: 'Start the sample playing, then hit an EMPTY pad whenever you hear something you want. The sample keeps playing — it does not stop, it does not stutter — and the piece from that moment lands on the pad you hit. Keep going and you have a kit built entirely by ear, in time with the music.' },
      { p: 'This only fires on pads that are still empty, so once a pad has a chop on it, hitting that pad plays the chop as normal. Chopping and playing live side by side, no mode to switch.' },
      { p: 'A tap that cannot cut says so instead of doing nothing: CHOP NOT ADDED flashes when the playhead is within 10 ms of the playing chop\'s start or end (no room for a slice), or when it has run outside every chop. Let it play on a moment and hit the pad again.' },

      { h: 'THE OTHER WAYS' },
      {
        k: [
          ['TAP THE WAVEFORM', 'cuts there when nothing is playing — at the playhead when something is, because tapping means "now"'],
          ['\\', 'cut at the playhead from the keyboard, without leaving the keys (desktop)'],
          ['DRAG A CHOP EDGE', 'move a start or end point after the fact'],
        ],
      },
      { split: { d: 'The WAVEFORM section, with the action buttons in the bar above the waveform.', m: 'The WAVE tab. The pad grid stays on screen below it, so you can chop by ear without leaving the tab.' } },

      { h: 'THE BUTTONS' },
      {
        k: [
          ['⊹ SNAP', 'snaps every cut to the nearest detected transient, so chops land on the hit and not 20ms after it. Turn this on before you start'],
          ['◁ REV', 'reverses THE PAD YOU LAST HIT — hit or click a pad, press ◁ REV, and that one chop plays backwards while every other pad stays forward (live hits, the sequencer and exports all follow, and the pad shows a small ◁). Press it again on the same pad and it goes back to following the sample. Select several pads first and it flips them together'],
          ['◁ REV — RIGHT-CLICK', 'reverses the WHOLE sample instead — chops and all, live pads AND the sequencer: flip it after you recorded and the whole take flips (it is a live state, not baked into the notes). Pads you flipped yourself keep their own direction and show ◁ or ▷ to say so'],
          ['NORM', 'peak-normalises the sample to −1 dBFS. Non-destructive, and it shows the gain it applied. It follows the waveform: on the main track it normalises the main track; with a pad\'s own sample on screen (a link, a file, a recording) it normalises THAT sample — every pad playing from it, to its own peak — and remembers it with the project'],
          ['RESET / CLEAR', 'clears every chop point and puts the full sample back on pad 1. The way to start the kit over'],
          ['✂ TRIM', 'cut a section OUT of the sample: click TRIM (it reads TRIM ON), drag across the waveform to highlight — the button blinks and reads TRIM IT while something is highlighted — then click TRIM again, or press DELETE, ⌘X, or right-click the highlight → ✂ DELETE SECTION (DESELECT drops the highlight). The gap closes: chops after it slide along, chops inside it go with the cut, transients re-map. ESC, or a click anywhere outside the waveform, leaves trim mode. Main track only; it refuses a cut under 20 ms or one that would swallow the whole sample ("Nothing to trim there")'],
          ['WHAT A TRIM COSTS', 'the pads and the sequencer stop at the moment you cut; a pad whose chop was inside the cut goes EMPTY and drops its mixer route and layer choices. Non-destructive all the same: ⌘Z undoes one cut, the button counts them — ✂ TRIM (2) — and right-click TRIM → ↺ RESTORE TRIM brings every cut back with the chops it swallowed, on their old pads when those are still empty, else on the next free pads (one undo step). Stems survive trims (they are re-cut to the new timeline — no re-split), and the saved project keeps the cuts'],
        ],
      },
      { split: { d: 'TRIM sits on the waveform bar of the classic desktop view, next to SNAP / REV / NORM.', m: 'The hardware / phone layout has no TRIM — switch layouts with ▦ (next to the T-800 mark) to cut a section out.' } },

      { h: 'GETTING PRECISE' },
      { p: 'Zoom in to see what you are doing: , and . on the keyboard, or on the waveform itself — on a trackpad, two fingers left/right SCROLL through it 1:1 with your fingers and a PINCH zooms in and out around the pointer (a mouse wheel zooms too; Shift+wheel scrolls); + − FIT on mobile. Whenever the WAVEFORM is on screen, ← and → step the focused chop\'s start point to the previous or next detected transient (no transient that way? they nudge instead, so the keys always do something visible), and SHIFT with them nudges finer than an onset. They work even when no pad is focused yet (the first chop moves) — and ONLY while the waveform is in view, so arrow keys pressed while you work in another section never move a chop by accident. That pair tightens a whole kit in about a minute.' },
      { tip: 'ESC stops every ringing pad and clears the selection. It is the "get me out of this" key.' },
      { h: 'START AND END KNOBS' },
      { p: 'Next to ATTACK and PITCH/TEMPO on the waveform bar sit START and END: they move the chop points of the FOCUSED pad — the one selected, or the one you last hit (the same pad the waveform highlights: a pad merely still RINGING never steals the target). Each knob\'s travel is what you can SEE: zoom in and a full turn of the controller moves the point across just that stretch (fine surgery); zoom out and it covers the whole chop window (from the previous boundary to its other edge — it can never run past a neighbour). Right-click either to MIDI-learn it; the mapping is saved with the app and comes back on every launch.' },
    ],
  },
  {
    id: 'stems',
    title: 'Stems',
    blurb: 'Split a sample into drums, bass, vocals — per pad',
    body: [
      { p: 'STEMS (on the waveform bar, desktop app) splits the loaded sample into four layers — DRUMS, BASS, OTHER (the melody and everything else) and VOCALS — on your machine. Nothing uploads anywhere; the first split downloads the engine once (or pre-download it in Preferences → FOLDERS) and it is yours offline from then on. Full version feature.' },
      { h: 'STEMS PER SAMPLE — EVERY SOURCE IN THE KIT' },
      { p: 'STEMS works on whatever the waveform is showing: the main track, or a pad\'s OWN sample (a YouTube link you loaded onto a pad, a file, a recording). Hit the pad so its waveform comes up, press STEMS, and THAT sample is split — its pads get the chips, chops you cut from it inherit their layers, and the split is remembered for that audio. Then load the next sample onto another pad and do the same. Every source keeps its own stems side by side: sample A\'s drums on some pads, its vocal on others, sample B\'s bass next to them — one kit. One split runs at a time: press STEMS on another sample while one is going and it says so — start it again when the first is done (chops you cut during a split do queue into it); the stems themselves are written to disk the moment a split ends.' },
      { h: 'THE BIG IDEA: STEMS ARE PER PAD' },
      { p: 'Splitting does not change your chops or your pads. Instead, EVERY PAD chooses which layers of its chop it plays: the same slice can be full mix on one pad, drums-only on another, just the vocal on a third. Chip buttons (DR · BS · OT · VX) appear on the waveform bar showing the mix of the pad you last HIT (mouse, keyboard, MIDI or the sequencer — they follow your hands) — click them to toggle layers, and a chop that is PLAYING switches live, right where it is — no need to retrigger to hear the change. The waveform shows it per chop: each slice\'s stretch is drawn with what ITS pad plays — kill the drums on chop 1 and only chop 1 thins out on screen, the rest of the song keeps its own layers. The pad menu has the same switches under Stems ▸. With pads multi-selected, the chips and the menu set ALL of them.' },
      { h: 'SPLITTING' },
      {
        k: [
          ['CLICK STEMS', 'split the WHOLE song at your last-used quality, top to bottom in order — the percentage is how far through the song the engine is, and each chop\'s chips light the moment its stretch has landed (you can play along while it works)'],
          ['RIGHT-CLICK STEMS', 'WHOLE SAMPLE — FAST (seconds), WHOLE SAMPLE — FINE (about 4× slower, the cleanest separation), or REMOVE STEMS'],
          ['SEVERAL PADS AT ONCE', 'shift-click the pads first, then STEMS: every sample those pads play goes in a queue and splits back to back while you walk away — the line under the waveform says SPLITTING 2 OF 5. One engine runs at a time (that is what keeps each split at full speed), but the engine stays loaded between them so the queue pays the model load once, not per sample. Pressing STEMS on a different sample while one runs queues it too; STOP cancels the running one and the line'],
          ['NOT SPLIT YET?', 'while a split is still running, a pad whose part isn\'t done just plays the original — never silence, never a wait'],
          ['NEW CHOPS INHERIT', 'cut a new chop point inside a chop whose pad has a layer OFF and the new pad starts with the SAME layers — turn them back on per pad if you want them. Re-chopping (AUTO / transients) keeps each region\'s layers too'],
          ['REMOVE STEMS', 'right-click STEMS — every pad goes back to the untouched original (one undo step). It also stops a split that is still running'],
          ['WHILE IT RUNS', 'the button itself shows the stage — ⇣ MODELS % (the engine downloading, first time only), ✂ LOADING…, ✂ % (splitting), ✂ SAVING… — and a line under the waveform spells it out with a clock. The percentage starts moving within a second and creeps between the engine\'s real ticks — a number that sits still means a stall, not a long chunk'],
          ['STOP', 'click STEMS while it is running → "Stop splitting? Finished parts are kept." — every span already split stays, saved and reusable; a chop you cut later over an unfinished span splits just that window on its own'],
          ['FAST ↔ FINE', 'the quality you pick is remembered for next time; switching it throws the current split away and starts from zero — the two never mix inside one song'],
          ['48 kHz', '48k material is fine — it is resampled to the engine and back, no loss you can hear. Changing the DEVICE sample rate in Preferences makes it different audio, so a cached split is redone once'],
          ['YOUR MACHINE', 'the engine runs on every Mac and Windows PC at the speed of that machine — same stems everywhere. On an Apple Silicon Mac the very first split also checks the GPU against the CPU on one chunk (a few extra seconds, once per Mac); if the GPU proves identical and faster, every split from then on runs on it. Intel Macs and Windows run the same engine on the CPU'],
          ['DIM CHIPS', 'the chips only light for pads whose sound has been split — chops of the main track, or a pad\'s own sample once you split THAT (press STEMS while its waveform is up). An empty pad has no layers to choose. And a pad can never switch all four off: the last lit layer stays'],
        ],
      },
      { split: { d: 'STEMS lives on the waveform bar of the classic desktop view.', m: 'The hardware / phone layout has no split button or chips — its STEMS button is the export. Switch layouts with ▦ (next to the T-800 mark) to split a sample.' } },
      { h: 'THE KIT-BUILDING TRICK' },
      { p: 'Group ▸ in the pad menu gains ⧉ as DRUMS / as BASS / as OTHER / as VOCALS on chops of the MAIN track once it is split (a pad playing its own sample gets the Stems ▸ switches, not this shortcut): one click copies the pad into a NEW GROUP already set to that single layer — own mixer strip, own colour, own mute group. Chop the sample once, then build a drum group, a melody group and a bass group from the same slices.' },
      { h: 'SPLIT ONCE, EVER' },
      { p: 'Every split is remembered on this computer against the AUDIO itself — not the project. Load that song again in a brand-new project, from the library, from YouTube or from the file, and its layers come straight back the moment the waveform lands: no engine, no wait, chips live immediately. It works the other way too — a project you open seeds the machine, so the next session already knows the song. Change the sample (a swap, a different sample rate in Preferences) and it splits fresh, because that is different audio. A TRIM does not: the split runs on the untouched original and its layers are simply re-cut to the trimmed timeline, so your stems survive every cut and every RESTORE. REMOVE STEMS only clears the pads in front of you; the saved layers stay on disk for next time. Deleting a song under Preferences → FOLDERS is what really forgets it.' },
      { h: 'GOOD TO KNOW' },
      { p: 'ALL four layers on = the untouched original file, bit for bit. Stem choices ride cut/copy/paste, undo and SAVE PROJECT; the stem audio itself is kept on this computer, so a saved project reloads its stems instantly here — on another machine the project opens fine and offers a re-split. Reverse, pitch, LOOP, fades and time-stretch all work per-layer, and exports print exactly what each pad plays.' },
      { p: 'Disk space: saved stems are lossless FLAC (bit-identical to WAV at roughly half the bytes — a 3-minute song\'s four stems land around 50–60 MB instead of 127 MB). Preferences → FOLDERS has a STEMS section showing everything stemming keeps — the engines (with a DOWNLOAD to fetch one ahead of its first split, and a DELETE per engine) and every split song\'s saved stem audio, listed per song so you can delete just one song\'s stems. All of it is safe to delete: engines re-download on the next split, and a cleared song keeps its layer choices and re-splits when you open its project — deleting a song\'s stems there is also what makes Terminator forget it and split it fresh next time.' },
    ],
  },
  {
    id: 'pads',
    title: 'The pads',
    blurb: 'Playing, banks, pitch, per-pad tools',
    body: [
      { h: 'PLAYING THEM' },
      { split: { d: '36 pads on screen. Keyboard: 1234567890, then QWERTYUIOP, then ASDFGHJKL, then ZXCVBNM — left to right, top to bottom. − and = shift bank.', m: '16 pads, always on screen under whichever tab you are in. A B C D across the top switch banks — 64 pads in total.' } },
      {
        k: [
          ['MIDI', 'any connected controller plays the pads from anywhere in the app'],
          ['RIGHT-CLICK A PAD', 'opens its menu and, if the pad carries its own sample, shows that sample on the waveform. Nothing else changes — no mode to escape from'],
          ['SHIFT-CLICK PADS', 'select several without playing them — then any selected pad\'s right-click menu edits them all at once (see "Select many pads"). ESC or a plain click clears; keyboard/MIDI hits don\'t'],
          ['AN EMPTY PAD', 'while a sample is playing, hitting one CHOPS at that moment instead — see "Chopping samples"'],
          ['THE SMALL NUMBER TOP-LEFT', 'which chop the pad holds, counted in time order — 1 is the first slice of the sample (a pad source counts its own pieces). The big label is the key, the small one bottom-right is the pad number'],
        ],
      },
      { h: 'PER-PAD CONTROLS' },
      {
        k: [
          ['[ / ]', 'pitch the focused pad down / up a semitone. SHIFT for tenths'],
          ['BACKSPACE / DELETE', 'empty the selected pads — or the focused one when nothing is selected'],
          ['\u2318X \u00b7 \u2318C \u00b7 \u2318V', 'cut, copy and paste pads (Ctrl on Windows). Click an empty pad to aim the paste'],
          ['NOTE ON / LOOP', 'play modes on the pad menu — see below'],
        ],
      },
      { h: 'THE PAD MENU (RIGHT-CLICK)' },
      { p: 'Right-click any pad — or press its □ corner — for its menu. Every pad is a little sampler of its own: it can hold its own audio, not just a chop of the main sample.' },
      {
        k: [
          ['▶ PLAY', 'audition the pad'],
          ['⇣ LOAD LINK FROM CLIPBOARD', 'copy a YouTube link anywhere (browser, chat, notes), right-click a pad, LOAD LINK — the pull lands on THIS pad as its own SOURCE, no box to paste into. Nothing or no link copied? It says so'],
          ['⇣ IMPORT LINK…', 'the same with a box: type or paste a YouTube link (it is pre-filled when your clipboard already holds one) and press Enter / LOAD — every YouTube pull (this, the URL bar, a playlist) lands in your Sample Library → YouTube as a real file: see it in the sample browser, load it again any time, and it never downloads twice'],
          ['↥ MAKE MAIN TRACK', 'on a pad that plays its OWN sample (a link, a file, a recording): that sample becomes the MAIN track — the pad keeps its copy. Handy when you want the main-track tools (TRIM, NORM, the big chop bar) on it; STEMS no longer needs it — a pad\'s own sample splits right where it is'],
          ['📁 LOAD FILE…', 'pick an audio file — it lands on this pad (dropping a file onto a pad does the same)'],
          ['● RECORD INTO PAD', 'opens RECORD SAMPLE aimed at this pad (the panel shows → PAD n); the take lands here'],
          ['🔁 TERMINATOR OUTPUT (resample)', 'in RECORD SAMPLE\'s INPUT list under TERMINATOR: record what Terminator itself is playing — the final mix, exactly what comes out of the speakers, mixer and all. Press REC, hit pads, run the sequencer, ride faders, then STOP: the take lands on the next empty pad (or the pad you aimed RECORD INTO at) as a fresh sample you can chop again. It is tapped before the speakers and never routed back, so it cannot feed back'],
          ['COPY · PASTE · DUPLICATE', 'move content between pads; DUPLICATE gives the copy its own chop so the two can be trimmed apart'],
          ['MOVE…', 'arms MOVE mode (below); MOVE TO EMPTY sends the pad to the first free slot'],
          ['NOTE ON', 'hold to play: the pad sounds only while you hold it — pad, computer key or MIDI note — and fades out over RELEASE when you let go. Off = one-shot: a hit plays the whole chop'],
          ['LOOP', 'round and round between the chop\'s start and end. Hit the pad again to stop it (with NOTE ON on as well it loops only while held). Both switches are independent — any combination'],
          ['FADES (LOOP)', 'when a pad is in LOOP the waveform shows two purple ~ nodes on its chop: drag the left one away from the start for a fade-in, the right one back from the end for a fade-out. The tail then fades INTO the head of the next pass — a crossfade loop — so a chop turns into a pad, a drone, a synth. The two can cross: drag the fade-in all the way to the end and the fade-out all the way to the start for a full crossfade where the passes stack up and melt together. Read the ms under each node. NOTE ON, LOOP and the fades are how the PAD plays when you hit it — the sequencer still plays the chop straight'],
          ['RESAMPLE · CLEAR', 'RESAMPLE prints what the pad PLAYS — a chop or a pad\'s own sample, with its stem layers, pitch, reverse and attack (dry, no mixer) — as a lossless FLAC on the next empty pad, a fresh source you can chop again; it tells you which pad it landed on, and the file is saved with the project. CLEAR empties the pad'],
        ],
      },
      { h: 'SELECT MANY PADS (SHIFT)' },
      { p: 'Hold SHIFT and click pads to select several — a shift-click toggles a pad in or out of the selection and never plays it. The pad menu does the same job without the keyboard: ☐ SELECT near the top of any pad\'s right-click menu adds or drops that pad. Selected pads wear a ring. Then open the menu of ANY selected pad (right-click or its □) and it becomes the menu for the whole selection: the title says how many pads it drives, and every action left in it hits them all at once. ESC clears the selection, and so does a plain CLICK on a pad — but playing pads from the KEYBOARD or MIDI keeps it, so you can audition your picks without losing them. (An ESC that closes a menu or leaves MOVE mode keeps the selection too.)' },
      {
        k: [
          ['GROUP · MIXER · MUTE GROUP', 'pick once, applies to every selected pad — and + NEW puts them ALL in the SAME new group / strip / mute group, not one each. The quickest way to make five pads choke each other: shift-click the five, right-click one, Mute group ▸ + New group'],
          ['NOTE ON · LOOP', 'sets every selected pad to the same state (the clicked pad\'s next state), never a per-pad flip'],
          ['CUT / COPY ALL → PASTE', 'takes the selection in pad order; PASTE lands them on consecutive pads starting from the pad you paste on. CUT empties the originals, so cut-then-paste is how you MOVE a handful of pads somewhere else'],
          ['DUPLICATE ALL', 'copies every selected pad onto the free pads after the selection'],
          ['PLAY ALL · CLEAR', 'audition the whole selection as one hit, or empty every selected pad'],
        ],
      },
      { h: 'CUT · COPY · PASTE · DELETE (KEYBOARD)' },
      { p: 'The pad menu and the keyboard share ONE clipboard, so it does not matter which you reach for. ⌘X cuts, ⌘C copies, ⌘V pastes, DELETE (or BACKSPACE) empties — each acting on the selected pads, or on the pad the waveform is showing when nothing is selected. Ctrl instead of ⌘ on Windows.' },
      {
        k: [
          ['AIMING A PASTE', 'click an EMPTY pad — it stays selected, ringed, as the target. Then ⌘V drops the clipboard there (several copied pads fill consecutive pads from it). Clicking an empty pad still chops at that moment if a sample is playing, so aiming costs you nothing'],
          ['MOVING PADS', 'cut, click where you want them, paste. For rearranging a whole block ⇄ MOVE and the ghost drag are usually quicker — cut/paste is the one to reach for when the destination is far away or on another bank'],
          ['THE CLIPBOARD HOLDS EVERYTHING', 'a pad\'s audio, its pitch, its NOTE ON / LOOP settings and its loop FADES all travel with it — and a copied chop survives even if you clear the original before pasting'],
        ],
      },
      { p: 'A pad with its own source shows a dot; tap it and the WAVEFORM shows that source (with ← MAIN TRACK to go back) — drag its START and END there to trim it. Tap a chop pad and the waveform returns to the main sample. The whole waveform bar acts on the source ON SCREEN: RESET, ◁ REV, ATTACK, PITCH and the START / END knobs each belong to that source (every pad of it) — set the break\'s attack, pitch or reverse without touching the sample\'s — except ◁ REV, which flips the PAD you last hit (right-click it to flip the whole source). In a source view RESET puts the whole audio back on one pad and empties its other pads; ✂ CHOP ×2 / ×4 / ×8 / ×16 and HITS are that source\'s auto-chop (equal pieces, or at its transients).' },
      { h: 'SOURCES AND BLOCKS' },
      { p: 'Every pad comes from a SOURCE — the main track, or the audio you put on the pad yourself. Chop a source and its chops fill the EMPTY pads right after it as a BLOCK: a run of pads that all belong together, wearing the same colour stripe along their top (the main track wears the theme colour). Chop it again later and the new pads keep landing after that block. Chopping never shoves another source out of the way: if the pad after a block is taken (say a break sits on pad 4 next to your chops on 1–3), that source is out of room until you move the neighbour — MOVE the break down to pad 10 and chopping 1–3 carries on. Moving is what pushes; chopping only fills empty pads.' },
      {
        k: [
          ['CHOPPING A PAD SOURCE', 'tap the pad so the waveform shows its source, then ✂ CHOP ×2 / ×4 / ×8 / ×16 (equal pieces) or HITS (at its transients — as many as there are empty pads) in the banner — or double-click the waveform to cut at that point. The pad keeps the first piece; the rest become new pads of the same source in the empty pads after its block'],
          ['ON THE WAVEFORM', 'every pad that plays from that source is drawn as a chop: click one to play its pad, drag its edges to trim that pad'],
          ['MOVING A BLOCK', 'in MOVE mode (or ⌘ / Alt-drag) grabbing any pad of a block carries the WHOLE block — the ghost says which pads — and the landing zone lights as many pads as the block is long. While you hover, the pads that would be pushed aside slide over to where they will land, so you see the push before you drop. Drop it and it is done. Two single pads swap. Sequences follow every pad to its new place'],
          ['CLEAR BLOCK', 'in the pad menu of any pad in a block: empties the whole run at once'],
        ],
      },
      { tip: 'Pad sources play in the sequencer, the Beat Finisher and every export exactly like main-track chops — including REV. And a project keeps every source: a chopped source is fetched once and its pads rebuilt as the same block.' },
      { h: 'GROUPS' },
      { p: 'A GROUP is the thing a block, a colour bar, a mixer strip and a mute group all hang off. It is automatic: every sample you put on a pad — a link, a file, a recording, a browser LOAD → PAD — is its own group from the moment it lands, and every chop you cut from a pad stays in that pad\'s group. So pads in one group always share the same settings: the same strip (and its effects), the same mute group, the same bar colour. You never have to touch it.' },
      {
        k: [
          ['Group: … ▸ (pad menu)', 'shows which group the pad is in and lets you move it: pick another group to join it (the pad takes that group\'s strip + mute group), + New group to start one with this pad, ↩ Leave group to go back to its own source. "whole block" applies the move to the run'],
          ['DUPLICATE TO NEW GROUP', 'the way to play the same sound two ways: copy pad 1 to a new group on pad 2, route pad 2 to another strip with its own effects, and every chop you cut from pad 2 on follows pad 2 — while pad 1 and its chops keep theirs. (Plain Duplicate keeps the copy in the same group)'],
          ['SETTING A GROUP\'S STRIP', 'pick a Mixer track on a pad that is alone in its group (a fresh duplicate) or on a whole block that IS the group, and it becomes the group\'s strip — chops cut from it afterwards follow. A pick on one pad of a bigger group only moves that pad'],
          ['ATTACK · PITCH · FINE · REV', 'per group too: the waveform bar edits the settings of the group on screen, and a chop cut from a grouped pad plays with its group\'s. A new group starts with the original\'s settings and then goes its own way'],
          ['COLOURS', 'each group wears its own bar: sources by their identity, new groups walk the colour wheel so GROUP 2, 3, 4… are clearly different'],
        ],
      },
      { h: 'MUTE GROUPS — WHO CUTS WHOM' },
      { p: 'Chops of one sample must cut each other off — that is what makes chopping sound right. Different sources should not: your break on pads 4–6 keeps ringing under the sample chops on 1–3. So by default every SOURCE is its own MUTE GROUP: a pad chokes the other pads of its source and nothing else. The sequencer follows the same rule — a note lasts until the next hit in ITS group, not the next hit of anything.' },
      {
        k: [
          ['MUTE GROUP: … ▸ (right-click a pad)', 'lists only the groups that exist — SAMPLE 1 (main) and every other source under its own NAME, plus any GROUP n you made — then NO GROUP (polyphonic: nothing cuts this pad, it cuts nothing) and + NEW GROUP. Tick WHOLE BLOCK to move a whole run at once. The names follow the source, not its mixer strip — re-route a source and its mute group keeps its name'],
          ['GROUPS COME AND GO', 'a group exists while a pad is in it — no list of 35 empty slots. Drums keep their own choke (open/closed hat) untouched'],
        ],
      },
      { h: 'ONE MIXER STRIP PER SOURCE' },
      { p: 'Every source gets its own strip in the MIXER the moment it lands on a pad: the main track is SAMPLE 1, the next source SAMPLE 2, then SAMPLE 3… (numbers never shift — SAMPLE 3 stays SAMPLE 3 when 2 is gone). Chop a source into five pads and all five play through its strip. The strip\'s cap wears the source\'s colour — the same stripe its pads have — so grid and mixer read as one.' },
      {
        k: [
          ['MIXER: … ▸ (right-click a pad)', 'the strip this pad plays through. Pick any SAMPLE strip to move it there, + NEW MIXER TRACK to give it a strip of its own, and tick WHOLE BLOCK to move every pad of the block together. UNDOING A MOVE: pick the source\'s own SAMPLE strip again — the override is dropped and the pad follows its group from then on (the route version of ↩ Leave group)'],
          ['EMPTY STRIPS', 'a strip no pad plays through any more removes itself — unless you have set anything on it (fader, pan, sends, an insert): a tuned strip stays until you clear it'],
          ['STEMS', 'STEMS export and the Beat Finisher give you a stem per SAMPLE strip; routing saves with the project and travels with TRANSFER'],
        ],
      },
      { h: 'MOVING PADS (GHOST DRAG)' },
      { p: 'Press ⇄ MOVE above the grid (or the menu\'s MOVE…) and drag a pad: a ghost of it follows your pointer, the pad under it lights up, let go and it lands there — onto an empty pad it moves, onto a loaded pad the two swap. Sequences follow the sound to its new pad. ESC or ⇄ MOVE again to finish. Shortcut: hold ⌘ (Ctrl on Windows) or Alt / Option, click a pad and drag — any time, no mode needed.' },
      { tip: 'Double-tap SPACE is a panic stop: sequencer, drums, bass and every ringing pad, all silenced at once. The ■ STOP button does the same thing, so hitting STOP again when everything is already stopped kills any tail still sounding.' },
    ],
  },
  {
    id: 'seqchop',
    title: 'Sequencing your chops',
    blurb: 'Making your pads repeat',
    body: [
      { p: 'The chop sequencer is a grid: one row per pad, one column per step. A lit cell means that pad fires on that step. Press play and it loops.' },
      { split: { d: 'The SEQUENCER section.', m: 'The SEQ tab → CHOP SEQ. STEP and REC on the bottom transport are the same two buttons.' } },

      { h: 'START HERE: RECORD YOUR PADS IN' },
      { p: 'Read this before you go hunting for your pads in the grid. The sequencer only shows a row for a pad that already has a hit somewhere in the pattern — an empty pattern shows ONE row to get you started. So you do not build a beat by looking for pad 7\'s row; you play pad 7 in, and its row appears.' },
      {
        k: [
          ['○ STEP', 'step record. Hit a pad and it lands on the current step, then the cursor moves on one. Hit, hit, hit — you are writing the pattern one step at a time, no timing needed'],
          ['○ LIVE', 'live record. The loop plays and you perform your chops over it; how hard your hits pull onto the grid is the INPUT Q fader (next to the BPM up in LOAD) and nothing else — the SOUND is pulled by exactly as much as the written note, so what you hear is what gets recorded. 100 = dead on the line, 0 = your own timing kept. The musical way in'],
          ['○ CUE', 'count-in — one bar of metronome before LIVE arms, so you are not scrambling on beat one'],
        ],
      },
      { p: 'Once a pad has a row, you can edit it by hand: click an empty cell to add a hit, click a lit one to remove it, drag a lit one sideways to move it, and right-click a column to clear every pad on that step.' },

      { h: 'THE SHAPE OF THE LOOP' },
      {
        k: [
          ['BARS', 'how long the loop is — 1 to 4'],
          ['RESOLUTION', 'how fine the grid is — 1/2 down to 1/128. It is also WHERE live-recorded hits land: this sequencer quantizes to its own grid (the drum sequencer uses its own, at the same INPUT Q strength). Setting a grid never quantizes your playing on its own — INPUT Q decides how much'],
          ['T (TRIPS)', 'turns the current grid into its triplet — 1/16 becomes 1/16T — and back again'],
          ['○ LOOP', 'repeat at the end instead of stopping'],
          ['CLEAR', 'wipe every step in this sequence. Your pads and chops are untouched'],
        ],
      },
      { p: 'Changing the resolution mid-beat is normal: program the kick and snare on 1/8 where it is easy to see, then switch to 1/16 for the hats.' },

      { h: 'MORE THAN ONE SEQUENCE' },
      { p: 'The letters along the top — A, B, C — are separate patterns. Press + for a new empty one, DUP to copy the current one and vary it, and right-click a letter to delete it. Build your verse on A, duplicate it to B and change the ending.' },
      { p: 'Clicking another letter while the beat is playing does not cut it off — the new pattern is queued and takes over when the loop comes round, so you can switch patterns live and stay in time.' },
      { tip: 'SPACE plays and stops. It is ignored while you are typing in a field, so naming a preset never starts the transport.' },
    ],
  },
  {
    id: 'seqdrums',
    title: 'Sequencing drums',
    blurb: 'Kick, snare and hats under your chops',
    body: [
      { p: 'MY DRUMS (desktop app): the drum browser has a MY DRUMS tab next to the kits — your OWN one-shots, straight from the DRUMS folder inside your Sample Library (Preferences → FOLDERS → DRUMS → OPEN, or OPEN FOLDER in the tab; EMPTY… there moves every file in it to the Trash, after asking), plus EVERY folder of the sample browser — RECORDINGS, YOUTUBE, IMPORTS, USER SAMPLES, your own folders and every linked folder (⇗) — so one library feeds both browsers; ADD FOLDER at the bottom of the folder column links a folder from your computer and it lands in both. Linked folders open one level per click (▸ / ▾). Drop files and sub-folders in there; the tab lists them the next time the browser opens (a drums folder with more than 50,000 files says …TRUNCATED — split it into sub-folders). On a computer the browser is RESIZABLE: drag its bottom-right corner, drag the edge of the folder column — it remembers both. LOAD puts one on the lane you opened the browser from (it reads REPLACE when you came in through ＋ ADD SOUND), ADD NEW gives it a lane of its own; a project remembers the file, and if it ever goes missing the lane says ⚠ MISSING instead of quietly playing something else — open the browser from that lane and pick it again. The built-in kit ships inside the app — no download, works offline.' },
      { p: 'HOW THE DRUM BROWSER WORKS: clicking a sound (or stepping with ↑ ↓ while PREVIEW is on) AUDITIONS it — it plays, and the lane plays it in the beat so you hear it in context — but nothing is kept until you press LOAD (Enter). CLOSE (Esc, or a click away) puts the old sound back. Keys: ↑ ↓ move through the list, ← → move between the kits, the folders and the buttons, the number keys jump to a category (1 = KICK, 2 = SNARE…), R = RANDOM, P = PREVIEW on / off, Enter = LOAD, Esc = CLOSE.' },
      { p: 'Terminator has a full drum machine built in, on the same clock as your chops: five tracks — KICK, SNARE, HI-HAT, OPEN HAT and PERC — each with its own sound and its own row of steps.' },
      { split: { d: 'The DRUMS section.', m: 'The SEQ tab → DRUM SEQ. In landscape it gets its own DRUMS tab.' } },

      { h: 'THE FAST START: GENERATE' },
      { p: 'Choose BOOM BAP or TRAP, then press GENERATE. You get a complete, playable pattern in that style immediately — Boom Bap patterns come from real MIDI drum files, Trap from built-in ones. Press it again for a different one. Most beats start here and get edited rather than being built from an empty grid.' },
      { p: 'Unlike the chop sequencer, all five drum rows are always visible. Tap any step to switch it on, tap it again to switch it off. That is the whole interaction.' },

      { h: 'PLAYING DRUMS IN BY HAND' },
      { p: 'Turn on DRUM PADS (called DRUMS on mobile) and the pads become your kit instead of your chops — pad 1 is the first lane, pad 2 the second, and so on through EVERY lane, the ones you added with ＋ ADD SOUND included (nine sounds = pads 1–9; each pad wears its lane\'s name). The pads past your last lane still play chops. The grid grows so every lane has a pad — forty lanes, forty pads (the keyboard still banks 36 at a time, − and = to shift), and pressing STEP or REC turns DRUM PADS on for you. Now finger-drum them.' },
      {
        k: [
          ['○ STEP', 'each pad hit fills the next step and moves the cursor on'],
          ['○ LIVE / REC', 'the pattern loops while you play; the INPUT Q fader (next to the BPM up in LOAD) sets how hard hits pull onto the grid — sound AND written note both, so what you hear is what records. Hits land on THIS sequencer\'s division; GRID OFF has no lines at all, so it plays and records completely free'],
          ['○ CUE', 'a one-bar count-in before recording arms'],
        ],
      },
      { p: 'Switch DRUM PADS back off and the pads return to your chops, exactly as you left them.' },

      { h: 'MAKING IT SOUND HUMAN' },
      {
        k: [
          ['SWING', 'pushes the off-beat 16ths late. 0 is straight, 100 is a full triplet shuffle. A little goes a long way'],
          ['INPUT Q', 'lives next to the BPM in LOAD now, and it is the ONLY thing that quantizes what you play in: one fader for BOTH sequencers — 100 = dead on the line, 0 = your exact timing, 50 = halfway (the residual lands in SHIFT here, so playback keeps your feel). Each sequencer quantizes to ITS OWN division: chop sequencer on 1/8 records at 1/8 while the drums on 1/16 record at 1/16. Setting a grid does not quantize anything by itself; GRID OFF has no lines, so drums record free'],
          ['VELOCITY', 'per-step loudness — drag a bar up or down. Ghost notes on the snare live here'],
          ['SHIFT', 'drag a single hit early or late off the grid, for feel'],
          ['PAN', 'place a hit left or right'],
          ['REPEAT', 'retrigger a step — rolls and stutters'],
        ],
      },
      { p: 'Those last four are the bar-graph editor under the grid. Tap a track name to focus it, pick the parameter, then drag the bars. A flat velocity row is what makes a pattern sound programmed; a varied one is what makes it sound played.' },

      { h: 'THE SOUNDS' },
      { p: 'Every drum lane is ONE-SHOT and plays its sample all the way through — until the same lane hits again, when the new hit cuts the old one in 4 ms, clean and click-free, exactly the way a pad cuts its own previous hit. Nothing fades, overlaps or beats underneath; an 808 on a lane sounds like the same 808 on a pad. A sound that starts from silence (a kick, a snare) starts instantly, full transient; one that starts mid-wave (an 808 trimmed hot) gets a 3 ms click guard so it never ticks. Mute, solo and the fader are the only things that change what a lane plays.' },
      { h: 'MUTE GROUPS — lanes that cut each other' },
      { p: 'The G button on a drum lane puts it in a MUTE GROUP. Lanes sharing a number cut each other the instant one of them hits, so whichever landed last is the only one you hear — the classic closed hat stopping an open hat dead, an 808 that must not stack with its own slide, a crash killing a ride. Click G to move a lane through groups 1, 2, 3, 4 and back to off; put two or more lanes on the same number and they become one voice between them. Off is the default and nothing changes: lanes ring on under each other as they always have. Two lanes landing on the very same step is a deliberate layer, not a cut, so stacking a clap on a snare still works. The cut is the same 4 ms click-free ramp a lane uses on itself, and every export cuts exactly where you heard it.' },
      { p: '‹ and › beside a track name step through the samples for that drum, ⊞ BROWSE opens the full kit to pick by ear, and 🎲 rolls a random sound — on one track, or the whole kit at once, keeping your pattern. Auditioning a new snare against your beat is a two-second job.' },
      { h: 'THE GRID' },
      { p: 'Drums have their own bars (1, 2 or 4) and their own resolution (1/8, 1/16, 1/32, with a triplet toggle) — they do not have to match the chop sequencer. The grid is a lens: changing the resolution or flipping T never changes the tempo or moves a note — a bar is a bar. Triplet just shows 3 columns where the straight grid shows 2 (1/16 → 16 columns, 1/16T → 24), so straight notes show up as small ghost marks on the triplet grid and vice versa. GRID OFF records live hits at their exact timing with no snapping at all, if you want it truly loose.' },
      { tip: 'Chops and drums start phase-locked off one anchor, so they are together from the first press of play — you never have to nudge one to catch the other.' },
    ],
  },
  {
    id: 'bass',
    title: 'The bass',
    blurb: 'A Model D–style synth and a piano roll, locked to your key',
    body: [
      { p: 'The BASS section is a real synthesizer, not a sample: three oscillators, a sub, an analog-modelled filter and two envelopes, in the shape of the Minimoog Model D — because that is the bass sound under half the records you love. Under it sits a piano roll for the line itself. It runs on the same clock as your chops and drums and has its own BASS strip on the mixer.' },
      { split: { d: 'The BASS section, under DRUMS.', m: 'The SEQ tab → BASS. In landscape it gets its own BASS tab. Tools: ✎ DRAW, ⌫ ERASE and ↕ VEL replace right-click and CMD-drag; drag the keyboard column or use ▲▼ to scroll the rows.' } },

      { h: 'GET A SOUND IN TEN SECONDS' },
      { p: 'Open PATCH and pick one: MODEL D, FAT SUB, REESE, ACID, MOOG PLUCK, SEM WARM, GROWL, 808 SINE. Draw a few notes in the roll, press ▶. Then turn CUTOFF and EMPHASIS while it plays — every knob is live. INIT takes you back to the plain Model D patch. Found a sound? SAVE names it and it appears under USER in the PATCH menu — kept across sessions (and on disk in the desktop app). Factory patches are never overwritten: saving from one always makes a new USER patch. Saving a USER patch you have edited asks OVERWRITE / NEW / CANCEL — NEW proposes the same name with a letter on the end (1 → 1a → 1b…), or type any new name. DEL removes a user patch; a * after the name means you have turned a knob since.' },

      { h: 'THE SYNTH, LEFT TO RIGHT' },
      {
        k: [
          ['OSC 1 · 2 · 3', 'each has a waveform (triangle, shark tooth, saw, square, wide pulse, narrow pulse, sine), a range switch (32\' is two octaves down, 8\' is where you played), FINE detune and LEVEL. OSC 2 and 3 also have SEMI. Two saws a few cents apart is thickness; a square an octave down is weight'],
          ['⌇ SHAPE', 'the last button in the waveform row: instead of picking one shape, a SHAPE knob morphs through them — full left is triangle, then shark, saw, square, wide pulse, narrow pulse, full right is sine — with a little scope under it drawing the wave as you turn, so you can dial an in-between timbre and see it. It is a knob, so the MOD matrix can move it (an LFO on SHAPE = a slowly evolving bass)'],
          ['MIXER', 'SUB adds a sine (or square) locked one or two octaves under OSC 1 — the cheapest low end there is. NOISE for breath and grit. DRIVE overdrives the mixer into the filter, the classic Model D trick for warmth'],
          ['FILTER', 'LADDER is the Moog transistor ladder (24 dB, saturating, self-oscillates at full EMPHASIS). OTA is the smoother SEM/Oberheim state-variable with LP/BP/HP. DIODE is the 303/EMS diode ladder — squelchy. CUTOFF, EMPHASIS (resonance), CONTOUR (how much the envelope opens it), KBD (higher notes open it more), DRIVE'],
          ['CONTOUR / LOUDNESS', 'the filter envelope and the amp envelope: attack, decay, sustain, release. Short decay + low sustain on CONTOUR = pluck. Long release on LOUDNESS = notes that hang'],
          ['PLAY', 'GLIDE slides between notes; DRIFT is analog wobble in the tuning; LEGATO stops overlapping notes from retriggering; MONO/POLY'],
          ['MOD', 'three LFOs (rate, shape, KEY = restart on every note) and two TRIGGER envelopes — TRIG A and TRIG B fire every time a note hits: RAMP up, then FALL back to wherever the knob was, EXP or LIN curve. Assign any of the five to any knob, as many knobs as you like, each with its own depth — the MOD module lists every target under its source. Two triggers with different RAMP/FALL times is how you get, say, a snappy cutoff kick and a slow drive swell from the same note'],
          ['OUT', 'velocity to loudness and to the filter, then DRIVE (saturation), TONE (darken), GLUE (a one-knob compressor) and VOL'],
        ],
      },
      { p: 'Right-click (long-press on a phone) any knob for its menu: COPY / PASTE a value between knobs, RESET, MIDI LEARN (or CLEAR MIDI), and ASSIGN TO MOD → LFO 1-3 / TRIG A / TRIG B. Or press ○ LEARN in the header: every knob flashes — green if a controller CC already drives it, white if it is free — tap one, move a control on your hardware, and it is mapped. Mappings are remembered across sessions.' },

      { h: 'KEY AND SCALE — YOU CANNOT PLAY A WRONG NOTE' },
      { p: 'Set KEY to the root and a scale (natural minor is the default; there are fifteen, from major to blues to Phrygian dominant). With 🔒 LOCK on, everything snaps to that key: notes you draw, notes you drag, notes you play in from a MIDI keyboard. Rows outside the key are dimmed on the roll; FOLD hides them completely so only the good notes are left. Pick CHROMATIC in the scale menu, or switch LOCK off, and every note is available again. CONFORM snaps a pattern you already made onto the key.' },

      { h: 'THE PIANO ROLL' },
      {
        k: [
          ['click', 'places a note (the length of the last one you made)'],
          ['drag on empty', 'draws a note of that length'],
          ['drag a note', 'moves it — pitch snaps to the key when locked'],
          ['drag its right edge', 'changes the length'],
          ['right-click / ALT-click', 'erases (drag to erase a run)'],
          ['CMD-drag up/down on a note', 'velocity — the note gets brighter'],
          ['CMD-drag on empty', 'rectangle select — every note the box touches is selected (SHIFT keeps what was already selected); then drag any of them to move the lot, by the grid, or free when the grid is OFF'],
          ['ALT-drag a selected note', 'duplicates the selection and drags the copies'],
          ['double-click a note', 'deletes it'],
          ['SHIFT-click', 'adds to the selection; DELETE removes it'],
          ['↑ / ↓', 'moves the selection by a scale step (a semitone when chromatic); SHIFT for an octave'],
          ['← / →', 'nudges by a grid step (a 1/16 beat when the grid is OFF)'],
          ['S', 'toggles SLIDE on the selected notes'],
          ['the keyboard on the left', 'click a key to hear it — and it LIGHTS UP for every note you play: hold a note on your MIDI keyboard, the computer keys or the pads and its key glows so you can see what you are hitting; notes the sequencer plays glow dimmer'],
        ],
      },
      { h: 'THE BEND LANE — pitch automation' },
      { p: '∿ BEND opens a pitch-bend lane under the roll. Draw in it and the bass follows the line — semitones up or down, linear between the points you put down, held flat past the last one. Right-click or ALT-drag erases, ✕ BEND clears the lane, ±2 / ±12 sets its range. Your keyboard\'s pitch wheel bends the bass live over that same range, and with ● REC running it WRITES into the lane, so a performed bend becomes part of the pattern. The lane plays back live, in the Beat Finisher and in every export. For per-note glides use SLIDE notes below; the lane is the wheel.' },
      { h: 'SLIDE NOTES' },
      { p: 'The ◢ SLIDE tool draws slide notes, the FL Studio way: a slide note triggers nothing. Whatever is sounding when it starts bends to the slide note\'s pitch over the slide note\'s length, and stays there until the original note ends. Put a C on beat 1, a slide note on G starting at beat 1.5 for half a beat, and the C glides up to G over that half beat. Slide notes show the ◢ mark and an outlined body; with nothing playing under them they are silent. They print into exports exactly as they play.' },
      { p: 'GRID sets where notes snap: 1/4 to 1/32 plus 1/8T and 1/16T triplets — or OFF, which turns snapping off everywhere: drawing, moving, resizing and live recording all land exactly where you put them. BARS is the pattern length (1–8). SEQ ◀ ▶ moves between bass patterns; + makes an empty one, ⧉ copies the current one, ✕ deletes. +8va / -8va shifts the whole pattern an octave; CLEAR empties it.' },

      { h: 'PLAYING AND RECORDING FROM A KEYBOARD' },
      { p: 'MIDI IN routes your controller — and the 16 pads / pad keys — into the bass instead of the chops. With LOCK on the pads are FOLDED to the key: pad 1 is the root, pad 2 the next note of the scale, and so on up two octaves — sixteen different in-key notes, never two pads on the same pitch. Chromatic (or lock off) makes them a plain keyboard from C2. An MPC (or MPD) plugged in over MIDI is treated the same way, with one twist: its pad 4 is the ROOT, so pads 1–3 give you a few notes below it, and with LOCK on every pad is a different note of the key — banks keep climbing. A regular MIDI keyboard plays as written, and its pitch-bend wheel bends the bass (±2 semitones). Press ● REC: with the transport stopped it counts in a bar (the same click as the sequencer\'s CUE) and then rolls and records; with the transport already playing it just punches in. Click during the count to cancel. Notes land in the pattern quantised to the grid, and if LOCK is on they land in the key. Wrong notes are impossible by design. Switch MIDI IN off and the pads are yours again.' },

      { h: 'IN THE BEAT FINISHER' },
      { p: 'The arranger has a BASS row. Each section plays one bass pattern (◀ ▶ picks which, click the cell to mute it), so the verse can walk and the hook can sit on the root. Master Mixdown and Trackouts render the bass through its mixer strip — the bass gets its own stem.' },
      { tip: 'A bass line that moves less than you think is usually the one that works. Root on the one, a passing note before the change, and let the sub do the rest.' },
    ],
  },
  {
    id: 'mix',
    title: 'The mixer and FX',
    blurb: 'Where it stops sounding like a demo',
    body: [
      { p: 'The MIXER is a real desk: a channel per track — your chops and each drum voice — with faders, pans, mutes and solos, insert FX on every strip, send effects, and a master bus at the end of it.' },
      { p: 'Everything you set here is printed into every export. There is no separate "render settings" to get wrong: the mix you hear is the mix that comes out.' },
      { h: 'SELECTING STRIPS' },
      { p: 'The coloured name cap at the top of each strip is a button. Click it and it pushes IN — that strip is selected; click it again and it pops back out. Shift-click for a range, Cmd-click (Ctrl on Windows) to add one more, or drag a box across the strips. Several pushed-in caps = several selected strips, and whatever you do next — a fader move, a resize from the strip\'s right edge — applies to all of them together, keeping their balance. Double-click a cap to rename the strip.' },
      { p: 'RENAME a strip: double-click its name cap, type, Enter (Esc cancels). The name is for you — exports still file that strip\'s stem under its strip id (sample2.wav, not the name), so a renamed strip is easy to find in the ZIP.' },
      { split: { d: 'The full desk lives in the classic desktop view: strips, sends, inserts, mute / solo, the master.', m: 'The hardware / phone layout has a simpler MIXER — one SAMPLE fader plus a fader per drum track, no strips, sends or inserts. Routing you set in the pad menu still applies, you just do not see the strips there; switch layouts with ▦ to work the desk.' } },
      { h: 'SAMPLE STRIPS' },
      { p: 'SAMPLE 1 is the main track. Every other source you put on a pad — a recording, a file, a link — arrives with a strip of its own (SAMPLE 2, 3…) in its colour, and every chop of it plays through that strip. Right-click a pad → MIXER: … to move it to another strip or a new one. See "The pads" → ONE MIXER STRIP PER SOURCE.' },
      { h: 'INSERT FX' },
      { p: 'Press ＋ INSERT FX on any strip. Click an effect\'s name to open its panel; drag the grip to reorder; ✕ removes it; hold Cmd (Ctrl on Windows) and drag an effect onto another strip to COPY it there, settings and all. Hover any effect for what it does. Mute silences a channel (printed into exports); SOLO hears it alone — Alt-click a SOLO to make it the ONLY solo.' },
      { h: 'SENDS' },
      { p: 'Every strip carries four send knobs, S1 – S4, each feeding one of the four SEND RETURN strips at the right of the desk. The idea: put the reverb or delay ON THE RETURN (it is locked 100 % wet there), then turn up S1 on every channel that should sit in that room — one reverb, many channels, one fader to pull it all back. Drag a send knob up to feed it, double-click to take it out. A return nothing feeds stays silent and is left out of Trackouts; the SENDS button collapses the four returns to name + fader when you want the space back.' },
      {
        k: [
          ['CLIP · WAVE · SAT', 'three flavours of drive: rounded peaks, overdrive, tape warmth'],
          ['MB SAT', 'multiband saturation — drive the LOWS, MIDS and HIGHS separately, with movable crossovers. Fatten a kick without fizzing the hats'],
          ['PHASER · FLANGER', 'the two classic sweeps: moving notches from swept allpass stages, and the jet-plane comb from a short swept delay'],
          ['VINYL/TAPE', 'saturation, aged top end, wow and flutter and a warmth bell in one box'],
          ['WIDE · M/S EQ · PAN', 'stereo width, an EQ that treats centre and sides separately, and auto-pan'],
          ['FILTER · EQ · COMP', 'the bread and butter. COMP\'s NY-PARALLEL blends the squashed signal with the dry, time-aligned so the two never phase'],
          ['RETRO', 'the character box — six modules in one. NOISE lays a floor under the track (VINYL is rumble and crackle, TAPE is hiss, STATIC is spitty, RADIO is a narrow band like a speaker in another room). WOBBLE is a worn transport. DISTORT has EIGHT curves so it is a palette, not one sound: tube, tape, fuzz, diode, fold, bits, transistor, crush. DIGITAL drops the bit depth AND the sample rate together, which is what an early sampler actually did. SPACE puts you in a small room, MAGNETIC is tape — dropouts, a head bump, and the top going away. Every module does nothing at 0, so you can use one and leave the rest. Everything random in it is SEEDED, which means your bounce has the same crackle in the same places as the playback you liked. Engine effect, so it is in your Master Mixdown and Trackouts'],
          ['LIMITER', 'the mastering limiter — the last thing on your master, and the one device that must never fail. It CANNOT exceed its ceiling: the gain it applies is hard-clamped to exactly what each sample needs, so the styles and the release only decide how it gets there, never whether it arrives. TP (true peak) reads the level BETWEEN samples: a normal limiter only sees the samples, and a converter or an mp3 encoder can reconstruct a peak 3 dB above what it promised you — which is what makes a "0 dB" master distort on someone else\'s phone. GAIN is how hard you push in; STYLE picks the flavour (PUNCHY lets transients through, BUS barely moves, AGGRESSIVE is loud and shows it, SAFE is a catch net). LOOKAHEAD is reported to PDC, so using it does not push your track late. Engine effect, so it is in your Master Mixdown and Trackouts'],
          ['SATURATOR', 'five analogue flavours on one stage. A is a tube — asymmetric, so it thickens rather than hardens. E is germanium, a harder edge. N is a British console, the one you can leave on everything. T is a transformer: the BOTTOM saturates first, which is what makes bass sound expensive. P is punish, fold-back fuzz. The thing that makes it musical: LOWCUT, HIGHCUT and TONE sit BEFORE the curve, so they choose what actually gets distorted instead of cleaning up afterwards — put a 500 Hz LOWCUT in and your sub stops muddying the distortion entirely. DRIVE 0 is bit-clean, and DRIVE is colour not level (the auto-gain measures what the curve did and undoes it). PUNISH is six times the drive on top. Engine effect, so it is in your Master Mixdown and Trackouts'],
          ['HALL 224', 'a real algorithmic reverb, modelled on the Lexicon 224 — the box every record you love used for its big rooms. The important one: DECAY IS IN SECONDS. The engine solves the tank\'s feedback for the decay time you ask for, so 3 s measures 3 s instead of meaning "quite long". BASS is the 224\'s bass decay MULTIPLIER, not an EQ — at 2 the bottom rings twice as long as the rest, at 0.5 it clears out of the way of your kick and 808. DAMP is the treble decay, so the top goes first the way it does in a real room. MOD keeps the tail moving; without it a long decay turns into a ringing buzz. PROGRAM picks the room (HALL, CHAMBER, PLATE, ROOM, AMBIENCE) and SIZE scales it. Feed it mono and it comes back stereo. Engine effect, so it is in your Master Mixdown and Trackouts'],
          ['TAPE ECHO', 'the RE-201 Space Echo. One tape loop with THREE playback heads at fixed spacings, so the MODE switch is not "how long" — it is which heads are reading. H1+2+3 gives you that rolling, uneven pattern a single delay cannot make. TIME is the MOTOR SPEED: move it and the pitch of whatever is already on the tape bends, exactly like the hardware, which is the trick people buy these for. INTENSITY is feedback — past about 90 the loop runs away and self-oscillates, and the tape saturation is what makes that a sound instead of a scream. The tape\'s losses sit INSIDE the loop, so every repeat is darker and thicker than the one before it (a digital delay with a filter on the output cannot do that). WOW is the worn transport drifting, SAT is how hard the tape is driven, BASS and TREBLE are the front-panel tone controls, SPRING blends in the tank. Engine effect, so it is in your Master Mixdown and Trackouts'],
          ['FET COMP', 'the aggressive FET compressor — the one you reach for when a snare or a whole drum bus needs to be GRABBED rather than gently levelled. It has no THRESHOLD knob on purpose: the threshold is fixed where the hardware\'s is and you drive INTO it with INPUT, then bring the level back with OUTPUT. That is the whole workflow — more INPUT is more compression AND more colour. RATIO is the character, not just the slope (2:1 is a broad bend, 20:1 nearly a corner, and NUKE drops the threshold, squares the knee and drags the release out so it pins and breathes). DETECT decides what the side chain HEARS: HP1 / HP2 take the bottom out of it so a kick stops ducking the whole track, BAND leans on the presence region. MODE is the colour — DIST 2 even harmonics (tube-ish), DIST 3 odd (transformer-ish), BRITISH faster, harder and dirtier. The GR readout shows how many dB it is holding the channel down. Engine effect, so it is in your Master Mixdown and Trackouts'],
          ['ANALOG FILTER', 'the Moog transistor ladder, modelled properly and oversampled 4× — MODE picks how steep (LP 24 / 18 / 12 / 6) or flips it to a highpass or bandpass, CUTOFF and RESO are the classic pair (RESO past about 85 rings, at 100 it sings on its own), and DRIVE overdrives the input stage into the ladder for grit rather than volume. Wide open is not bypass: four poles at 20 kHz still cost a few dB up top, which is what a real one does. It is an ENGINE effect, so it lands in your Master Mixdown and Trackouts — the MPC project and the Drum Rack bake one-shots through the page chain, so it is not in those'],
          ['SC COMP', 'sidechain compressor — ducks THIS channel from another one. Open its panel and pick the SOURCE (put the kick there to make an 808, a pad or the sample duck under every hit); THRESH and RATIO set how hard, ATK / REL / HOLD the shape, KEY HP keeps only the source\'s lows triggering. The GR readout shows how much it is ducking'],
          ['DELAY · REVERB', 'time effects — repeats darken like tape; the reverb is a real room, bright onset, dark tail'],
          ['UTILITY', 'gain trim, mono fold-down, phase flip'],
        ],
      },
      { h: 'GAIN MATCH · PDC' },
      { p: 'GAIN MATCH (top of the mixer) trims each strip\'s FX chain back to the level it received, so you judge an effect on character, not on the volume it happens to add. Monitoring only — never printed.' },
      { p: 'PDC is plugin-delay compensation. A few effects take time to work — COMP looks ahead about 6 ms, the drives (SAT / CLIP / WAVE / MB SAT) oversample and land about 4 ms late, VINYL about 9 ms. Left alone, that channel plays late against the others, and a compressor on a send bus returns late enough to phase against the dry channel it sits beside. PDC delays every strip to the longest chain so they all arrive together, live and in exports. It is on by default; the only reason to turn it off is the last few milliseconds of pad latency, and it only costs anything while such effects are in the mix.' },
      { h: 'CONSOLE — analog-desk separation' },
      { p: 'In the box every strip is the same maths, so sources mask and smear into one another. On a real desk — an SSL, a Neve, an API — every channel is a little different: its own transformer or op-amp saturation, a tiny EQ tilt from component tolerance, a sub-sonic filter, and a summing bus that glues the whole thing. That is what you hear as "separation". CONSOLE (top of the mixer, next to PDC) puts that in: every strip gets its own channel stage, seeded by the strip\'s name so the kick is always the same kick, session after session and in every export; the master gets the summing-bus stage.' },
      { p: 'It is honest: zero latency (PDC is untouched), level-matched to within 0.1 dB so the A/B is character and not loudness, and printed into stems, master and sample exports exactly as heard. Off by default. Pick a flavour — SSL is clean and forward (odd harmonics, a hair of air), NEVE is transformer warmth (even harmonics, weight down low, softened top), API is punch (both, with a presence lift around 3 kHz) — and set AMOUNT: 50 is a real desk at nominal level, 100 is driven, 0 leaves only the sub-sonic filter. The setting saves with the project and is remembered as the default for the next one.' },
      { p: 'There are SIX flavours, in two rows of three. SSL, NEVE and API are the originals and they are FROZEN — a project you made last month has to sound like it did, so those will never change. SSL+, NEVE+ and API+ are the same three desks modelled properly: the saturation runs oversampled, so you can drive AMOUNT up without the fizz that a plain digital curve gets, and each one adds the part of the hardware the original stage could not afford. NEVE+ has the actual TRANSFORMER — its core saturates on LOW frequencies first, so the bottom compresses and thickens while the top stays clean, which is what people mean by "Neve weight" and what no fixed curve gives you. SSL+ is the op-amp: tighter, the odd harmonics staying in front. API+ is discrete class-AB: more punch, and it holds together when driven. The plus desks are engine effects, so they are in your Master Mixdown and Trackouts.' },
      { h: 'METERS · LOUDNESS · SPECTRUM' },
      { p: 'Every strip meters pre-fader (the faint ghost) and post-fader (the solid bar) with a peak-hold line and a clip light that latches. Under the MASTER fader sit four numbers — M, S, I and TP. They are a real ITU-R BS.1770-4 / EBU R128 loudness meter running on the audio thread, not an estimate: M = momentary (the last 400 ms), S = short-term (3 s), I = integrated since you pressed ⟳ (gated, so silence and quiet bars don\'t drag it down — this is the number streaming services normalise to), TP = the highest true peak (4× oversampled inter-sample peak) since reset.' },
      { p: 'CLICK that readout for the full picture: the three LUFS numbers big, with how far you sit from −14 LUFS; TRUE PEAK per side against −1 dBTP; LRA (loudness range) and PLR (peak-to-loudness, i.e. how dense the master is); a PHASE / CORRELATION bar (+1 mono-safe, negative = out of phase, your bass disappears on a mono speaker); and a SPECTRUM ANALYZER of the master with a band-balance readout. TILT is on by default: it adds 3 dB per octave so a balanced full-range mix reads FLAT — if the SUB bar towers over MID your mix is boomy, if AIR sits 12 dB under everything it is dull. Press ⟳ RESET at the top of the track and read I at the end.' },
      { tip: 'Meter accuracy is checked against the spec: a −20 dBFS 997 Hz sine in both channels reads −20.0 LUFS, left only −23.0. If the header says APPROX, the audio-thread meter could not load (an old browser) and you are seeing the older estimate.' },
      { h: 'MIDI CONTROL' },
      { p: 'Right-click any fader — every channel and the master — or any knob or slider inside an effect panel and choose MIDI Learn. Move a control on your controller and it is mapped: a pulsing ring while it waits, an amber dot once it is done. Changed your mind? Click anywhere else (or press ESC) and the arm is dropped. Right-click again for Clear MIDI. Mappings are remembered between sessions. LEARN waits for a REAL move: it ignores the side-messages some controllers send around a fader (a 14-bit low byte, a touch/button blip that only says 0 or 127) and binds on the first mid-travel value — so sweep the fader or turn the knob through its range. If a fader you learnt earlier only jumps between off and full, right-click → MIDI Learn again and sweep it.' },
      { p: 'MIDI CLOCK (send) — Preferences → MIDI. Turn it on and Terminator becomes the master clock for your gear: PLAY sends Song Position 0 + START and then 24 ticks per quarter note at the session tempo, STOP sends STOP, to every MIDI output left ON in the same panel. The ticks ride the very same anchor the drums and bass play from, so a drum machine or DAW set to external sync sits on Terminator\'s grid, and a tempo change lands at the next tick. Desktop app only (Web MIDI).' },
      { p: 'FOLLOW YOUR MPC (MIDI clock in) — the transport part needs nothing switched on. Set the MPC (or any drum machine / DAW) to SEND MIDI clock + transport on its USB or MIDI port — on an MPC that is Preferences → Sync → Sync Send: MIDI Clock (MTC is a different thing and carries no tempo) — and plug it in: its PLAY starts Terminator, its STOP stops it, and Terminator keeps its OWN BPM. Want the tempo to follow too? Preferences → MIDI → MIDI Clock (follow tempo): while the hardware is driving, the BPM readout moves to match its clock within a beat, so the two stay locked instead of drifting apart. A device that shows up as two MIDI ports (an MPC does) sends everything twice — only the port that pressed PLAY is listened to, so the tempo can never read double. Press PLAY on Terminator itself and you are back on your own tempo.' },
      { tip: 'A hardware fader mapped to a channel fader follows the same taper as the on-screen one, so half-way on the controller is half-way on the strip. Selected faders move as a gang, from MIDI too.' },
      { h: 'ON THE WAVEFORM BAR' },
      {
        k: [
          ['TRIM', 'cut a section out of the sample — highlight, click TRIM again (or DELETE / ⌘X / right-click → DELETE SECTION), the gap closes; non-destructive, right-click TRIM → RESTORE TRIM. The full story is under CHOPPING SAMPLES → THE BUTTONS'],
          ['ATTACK', '0–500 ms fade-in on every chop — live pads, the sequencer and exports alike. A few ms kills clicks on cuts that land mid-waveform; 100–500 ms turns chops into swells and pads'],
          ['PITCH/TEMPO', 'pitches the whole sample ±24 semitones — the knob (or its MIDI CC) is the way to pitch the sample; ↑ / ↓ no longer do, they belong to the BASS piano roll'],
          ['FINE', 'cents on top of PITCH/TEMPO, ±50 ¢ (100 ¢ = a semitone) — tune the sample exactly to your key when the nearest half step is not quite it; pads, sequencer and exports all follow, and a pad source gets its own FINE'],
        ],
      },
      { tip: 'Solo a channel to hear exactly what one part is contributing. It is the fastest way to find the thing that is muddying the mix.' },
    ],
  },
  {
    id: 'finish',
    title: 'Beat Finisher',
    blurb: 'Loops into an actual song',
    body: [
      { p: 'A beat is a loop. A song is loops in an order. BEAT FINISHER is where you say what that order is: intro, verse, hook, bridge, outro — each section with its own length and its own selection of your chops.' },
      { p: 'It reads what you have actually made — your chops, your tempo, your sequences — and suggests arrangements built from them. Take one as it comes, or move the sections around until it is yours.' },
      { p: 'The CHOPS row picks which chop sequence each section plays — or — NONE — for a section with no chops at all: a drum intro, a bass-and-drums breakdown, a stripped outro. Drums and bass carry the section on their own.' },
      { p: 'The arrangement you build here is what EXPORT renders. That is the join between the two: the sequencer makes the loop, the Beat Finisher makes the record.' },
    ],
  },
  {
    id: 'export',
    title: 'Exporting',
    blurb: 'Getting it out — and into your MPC',
    body: [
      { p: 'Press EXPORT and the export box opens: pick what to render at the top, how to write it underneath, then EXPORT. Everything is in the one box — trackouts are something you RENDER, not a separate button. Every option renders the full Beat Finisher arrangement with your mixer FX, sends and master strip baked in. While it runs you get a progress bar and a CANCEL: cancelling stops it before anything is written, so you never end up with half a file. Esc cancels a running export, or closes the box when nothing is running.' },
      { h: 'THE FOUR' },
      {
        k: [
          ['Master Mixdown', 'the whole thing as one stereo WAV. What you send someone'],
          ['16 or 24 bit', 'the BIT DEPTH row. 24-bit keeps more headroom if the file is going on to be mixed or mastered further; 16-bit is the deliverable — it is what a CD or a streaming upload wants, and it is dithered on the way down so quiet tails and fades stay clean instead of going gritty. MP3 is always made from 16-bit.'],
          ['Sample rate', 'there is no rate menu on purpose: an export renders at the project\'s own rate and never resamples. The box tells you what that rate is.'],
          ['WAV, FLAC or MP3', 'the FORMAT row in the export box. FLAC is LOSSLESS — the very same audio as the WAV, sample for sample, in about half the space (often far less), and every DAW opens it. MP3 is lossy and for sending someone a listen: pick the bitrate under it, 320 is the best. Master Mixdown and Trackouts can be any of the three; the MPC project and the Drum Rack are always WAV because the sampler reads WAV headers, so the row greys out there instead of quietly doing nothing'],
          ['Trackouts (Chops + Drums)', 'one WAV per track — SAMPLE 1 and every extra SAMPLE strip (sample2, sample3…), kick, snare, hihat, openhat, perc and every drum lane you added, the BASS, plus any send return that is actually fed. Mixer FX baked in. Zipped, ready for any DAW'],
          ['MPC Project', 'a zip of one-shot WAVs plus a .mpcsample program. Unzip onto your MPC and the pads and sequences load ready to play'],
          ['Ableton Drum Rack', 'a self-contained .adg plus its samples — drums first, then chops. Unzip anywhere and drag the .adg onto a track'],
        ],
      },
      { p: 'Exports render offline and faster than real time, so a long arrangement is a progress bar rather than a wait. The MPC export puts every assigned chop in mute group 1, so the machine chokes them mono-style exactly like a chop kit should.' },
      { h: 'WHAT ACTUALLY RENDERS IT' },
      { p: 'Master Mixdown and Trackouts are rendered by the app\'s own audio engine — the same voices, mixer strips, CONSOLE, delay compensation and master limiter you are listening to. That is why the file sounds like the app rather than nearly like it, and it is what lets the engine-only effects turn up in your bounce at all. The MPC project and the Ableton Drum Rack are built by the app\'s sampler exporters instead, because those formats are files to be parsed rather than audio to be mixed.' },
      { p: 'You pick where it goes: EXPORT opens a save box. Trackouts ask once — you name the master and the rest land beside it, the way a DAW does — and WAV, FLAC and MP3 are all written straight out at the depth you chose, with nothing converted afterwards.' },
      { tip: 'Nothing you export leaves your computer — the render happens right here in the app.' },
    ],
  },
  {
    id: 'save',
    title: 'Saving your work',
    blurb: 'Projects — on your account and on your computer',
    body: [
      { p: 'Press ⌘S (Ctrl+S on Windows) or SAVE PROJECT and the whole thing is saved: the sample, chops, pad assignments, pitches, sequences, drums, bass, mixer — the lot. The name field fills itself in from the sample title, so most of the time saving is one keystroke.' },
      { p: 'SAVE AS: CMD-click SAVE PROJECT (or right-click it → Save As…) opens the project list in save mode, so you can see the names you already used and type a new one — click a row to take its name (that overwrites it), Enter or SAVE to save. Right-click → Save As Copy saves the same project under the same name with the next number (Beat → Beat 2), leaving the original as it was.' },
      { p: 'NEW (next to OPEN…) starts a fresh project: sample, chops, pads, sequences, drums, bass and mixer all go back to defaults. It asks first when there is work to lose — save before you press it.' },
      { h: 'WHERE IT GOES' },
      {
        k: [
          ['ON YOUR ACCOUNT', 'projects live with your account, not this browser — the same list on your phone, iPad and desktop. LOAD PROJECT… lists them; OPEN… shows local files and cloud side by side'],
          ['ON YOUR COMPUTER (desktop app)', 'every save also writes a <name>.tproj file into your projects folder — yours to keep, back up, or double-click from Finder / Explorer. File → Save Project As… puts one anywhere you like'],
          ['YOUR PROJECTS FOLDER', 'OPEN… → Local shows the folder at the top of the list: CHANGE FOLDER… points it anywhere on your computer (a Dropbox or iCloud folder, an external drive), USE DEFAULT brings it back, OPEN shows it in Finder / Explorer. From then on every save lands there. Projects already in the old folder stay put — move the .tproj / .tprojz files over by hand if you want them in the list. Samples are not in that folder (the app keeps them by content in its own store); ⇩ FILE makes the bundle that carries them. The same setting also lives in Preferences → FOLDERS, next to every other place Terminator saves to'],
          ['SAME NAME = UPDATE', 'saving a loaded project again updates it; a new name makes a new project (a name clash asks first)'],
        ],
      },
      { h: 'YOUR OWN SAMPLES' },
      { p: 'A project made from a Terminator sample or a YouTube pull reloads anywhere — the audio is fetched again. A project made from files you loaded yourself (the main sample, pad samples) now keeps those files WITH it: each one is remembered by its content, stored on the device it was loaded on, and reloads on that device automatically — pad samples too.' },
      { h: 'TRANSFER TO DEVICE' },
      { p: 'The direct way: OPEN… → ⇄ Transfer to device on the machine that has the project (on a phone it is the ⇄ TRANSFER button under PROJECTS). It shows an 8-character code. On the other device — the desktop app or terminator in a browser — OPEN… → ⇣ Receive, type the code, and the whole project with its samples streams straight across, device to device. Nothing is uploaded anywhere; the code only lives while the window is open. Desktop → iPad, phone → laptop, any pair, on any network.' },
      { p: 'The file way — to carry such a project by hand, AirDrop or a USB stick — press ⇩ FILE: you get a single .tprojz project bundle with the samples inside (a plain .tproj when the project needs none). On the desktop app SAVE PROJECT and Save Project As… write the bundle for you when it is needed. Open one anywhere — OPEN…, LOAD FILE, drag it onto the waveform — and its samples move in. A project whose samples are not on this device says exactly which files it is missing.' },
      { p: 'Undo and redo cover everything else: ⌘Z / Ctrl+Z to undo, ⌘⇧Z or Ctrl+Y to redo, or the ↺ ↻ buttons up in the header.' },
      { tip: 'Saving projects is a subscriber feature — see "Free and full".' },
    ],
  },
  {
    id: 'look',
    title: 'Themes and layout',
    blurb: 'Making it yours',
    body: [
      { h: 'THEMES' },
      { p: 'Tap the T-800 mark in the top-left for the theme picker. Two columns: ORIGINAL is the full HiFi-receiver treatment — Terminator, Street Fighter, Sonic, FF7, Outrun, and the rest, each with its own animated backdrop. MINIMAL is the same machine in a flat colour palette when you want to see the waveform and nothing else. Hovering a theme previews it live; clicking locks it in.' },
      { split: { d: 'The picker also has a UI row: AUTO / DESKTOP / MOBILE. AUTO gives a computer or an iPad the desktop layout and a phone the hardware one; DESKTOP forces the full desktop layout — every section, the DAW mixer, the bass — on a phone; MOBILE puts the hardware-style phone layout on an iPad, or — on a computer — shows it for this visit only: a computer always opens the desktop layout next time. Terminator reloads to switch, so save first.', m: 'Tap the TERMINATOR logo (portrait) or the ◐ tab (landscape) for the picker: a palette list, PHOSPHOR for the original green look, and a UI row — AUTO / DESKTOP / MOBILE. AUTO gives an iPad the desktop layout and a phone this hardware one; DESKTOP gives you the full desktop layout with every section, the DAW mixer and the bass, right here on your phone; MOBILE keeps this layout on an iPad. Terminator reloads to switch, so save first.' } },
      { h: 'LAYOUT' },
      {
        k: [
          ['▦', 'next to the T-800 mark — cycles through the layouts'],
          ['SECTION HEADERS', 'click one to collapse that section and get the space back'],
          ['DRAG A SECTION', 'in re-arrange mode, drop sections wherever you want them. RESET LAYOUT puts everything back'],
        ],
      },
      { tip: 'On a phone Terminator loads a different build entirely — see "On your phone".' },
    ],
  },
  {
    id: 'phone',
    title: 'On your phone',
    blurb: 'The hardware layout, tab by tab',
    body: [
      { p: 'On a phone Terminator loads as a piece of hardware instead of a desktop app: a machine with a screen, four tabs and a pad grid, sized for thumbs. It is not a cut-down version — the sequencer, the drum machine and the bass synth are the same ones the desktop runs, in a different chassis. An iPad gets the desktop layout by default (it has the room); if you would rather have this hardware layout there, or the desktop one on your phone, tap TERMINATOR → UI → MOBILE / DESKTOP.' },
      { h: 'THE FOUR TABS' },
      {
        k: [
          ['LOAD', 'pull a sample, ● REC one off the mic, set the BPM (drag the number, or TAP it in), save and load projects'],
          ['WAVE', 'the waveform — chop here, with + − FIT to zoom and SNAP / NORM / CLEAR'],
          ['SEQ', 'CHOP SEQ, DRUM SEQ and BASS (the synth + piano roll), plus ⚡ FINISHER to arrange'],
          ['MIXER', 'faders for your chops and each drum track, the PEAK meter, and a real BS.1770-4 loudness readout — M / S / I / TP under the meter; tap it for the full picture (LRA, PLR, phase, spectrum analyzer) — plus the export buttons'],
          ['□ ON A PAD', 'the pad menu: 📁 LOAD FILE onto this pad, ● RECORD INTO PAD (the take lands here as its own source), CUT / COPY / PASTE / DUPLICATE (cut a pad, open another pad\'s menu, paste — that is how you move one by hand), MOVE… then MOVE HERE on another pad (a whole block moves and pushes what is in the way aside; two singles swap), NOTE ON (hold to play) and LOOP (round and round; drag the two FADE nodes on the waveform for a crossfade loop), CLEAR, CLEAR BLOCK. Pads of one source share a colour stripe'],
        ],
      },
      { h: 'THE PARTS THAT ARE ALWAYS THERE' },
      {
        k: [
          ['THE PADS', 'never leave the screen, whichever tab you are on — so you can chop by ear while looking at the waveform, or audition chops while sequencing'],
          ['A B C D', 'pad banks, 16 each, 64 in total'],
          ['DRUMS', 'switches the pads from your chops to the five drum voices, and records them into the drum grid while it plays'],
          ['REC · STEP', 'live record and step record. They follow the pads: chops normally, drums when DRUMS is on'],
          ['PLAY · STOP · METRO', 'transport and metronome'],
        ],
      },
      { p: 'Drag the handle under the screen to make the display taller or shorter — worth doing on the WAVE tab when chopping something fiddly, and on the BASS roll. Tap TERMINATOR in the header for the theme picker: the colour palettes, PHOSPHOR (the original green), and the UI switch between the MOBILE and DESKTOP layouts.' },
      { h: 'TURN IT SIDEWAYS' },
      { p: 'Landscape rearranges the same machine: tabs become LOAD · SEQ · DRUMS · BASS · MIXER — drums and bass get their own tabs instead of sharing with the chop sequencer — and the pads and transport move to the bottom edge. The ◐ tab is the theme picker. Nothing is lost either way; rotate to whichever suits what you are doing.' },
      { tip: 'Tooltips need a mouse hover, which a touch screen does not have — so on a phone this help menu is the manual. Everything the tooltips say is in here.' },
    ],
  },
  {
    id: 'keys',
    title: 'Shortcuts',
    blurb: 'Every key worth knowing',
    body: [
      { h: 'TRANSPORT' },
      {
        k: [
          ['SPACE', 'play / stop'],
          ['SPACE SPACE', 'double-tap — panic stop: sequencer, drums and every ringing pad'],
          ['ESC', 'stop all pads and clear the selection — with TRIM armed it first drops the highlight and leaves trim mode'],
        ],
      },
      { h: 'PADS' },
      {
        k: [
          ['1234567890 QWERTY…', 'play pads 1–36, left to right, top to bottom'],
          ['− / =', 'previous / next bank of 36'],
          ['[ / ]', 'pitch the focused pad down / up (SHIFT = fine)'],
          ['BACKSPACE / DELETE', 'empty the selected pads — or the focused one when nothing is selected. With a TRIM highlight on the waveform it cuts that section instead'],
          ['\u2318X \u00b7 \u2318C \u00b7 \u2318V', 'cut, copy and paste pads (Ctrl on Windows). Click an empty pad to aim the paste. With a TRIM highlight on the waveform, \u2318X cuts that section out of the sample instead'],
        ],
      },
      { h: 'CHOPPING' },
      {
        k: [
          ['ANY EMPTY PAD', 'while a sample plays, cuts at that moment — the main way to chop'],
          ['\\', 'cut at the playhead'],
          [', / .', 'zoom in / out'],
          ['← / →', 'step the focused chop\'s start to the previous / next transient (SHIFT = fine nudge)'],
        ],
      },
      { h: 'SEQUENCING' },
      {
        k: [
          ['CLICK A CELL', 'add a hit · click a lit one to remove it · drag it sideways to move it'],
          ['ALT-CLICK A LIT CELL', 'VELOCITY — cycles the hit through 100 → 75 → 50 → 25 %: a softer cell fills from the bottom by its amount and shows the number. Live recording keeps the velocity you actually played (a MIDI pad\'s velocity, a soft tap), step input and clicks start at 100. Every export plays the same dynamics'],
          ['SWING', 'the drum section\'s SWING knob swings BOTH sequencers — the chop seq\'s off-beat 16ths land late by the same amount as the drum lanes, so chops and drums groove together. Exports carry it'],
          ['NO MAIN TRACK NEEDED', 'a beat made only of pad samples (links on pads, GET SAMPLE, recordings, resamples) is a full kit: PLAY, REC, step record, the sequences, the exports and the saved project all work without a sample in the waveform'],
          ['RIGHT-CLICK A CELL', 'clear every pad on that step'],
          ['RIGHT-CLICK A LETTER', 'delete that sequence'],
        ],
      },
      { h: 'THE USUAL' },
      {
        k: [
          ['PREFERENCES', 'the ⚙ button at the top right of the desktop app, or ⌘, (Ctrl+, on Windows), or the Terminator menu → Preferences… — AUDIO (device, buffer, rate), MIDI (inputs, outputs, clock send / follow tempo), FOLDERS (library, projects, cache, stems engines), and the rest'],
          ['⌘S / Ctrl+S', 'save this sample\'s preset'],
          ['⌘Z / Ctrl+Z', 'undo'],
          ['⌘⇧Z / Ctrl+Y', 'redo'],
        ],
      },
    ],
  },
  {
    id: 'tiers',
    title: 'Free and full',
    blurb: 'What the lock icons mean',
    body: [
      { p: 'Free gets you the machine: 3 pads, 10 sample pulls, and the chopping, playing and mixing that go with them. It is a real go at it, not a screenshot.' },
      { h: 'WHAT A SUBSCRIPTION OPENS' },
      {
        k: [
          ['ALL PADS', 'the full grid, every bank'],
          ['UNLIMITED PULLS', 'the whole library, as often as you like'],
          ['YOUR OWN FILES', 'LOAD FILE and recording'],
          ['SEQUENCER · FX · EXPORT', 'the sections that are greyed out on free'],
          ['SAVED PRESETS', 'your work kept on your account, across devices'],
        ],
      },
      { p: 'There is also a one-time buy — "Buy Terminator — $40" in the header — if you would rather own it outright than subscribe.' },
    ],
  },
];

// ── Search ───────────────────────────────────────────────────────────────────
//
// Same contract as the board's help (src/renderer/board/sim/phone/apps/help.ts):
// search reads the WHOLE article, not just titles, and a result shows the line
// it matched on so you can see WHY it matched without opening it. A manual you
// can only navigate by chapter heading is a manual you have to already know.

/** Everything in a topic as one searchable blob, one line per block, so a
 *  snippet can be pulled from the exact line that matched. Every block type
 *  must contribute — a block that forgets to is a chapter that cannot be
 *  found by its own content. */
function topicText(t: Topic): string {
  const parts: string[] = [t.title, t.blurb];
  for (const b of t.body) {
    if ('h' in b) parts.push(b.h);
    else if ('p' in b) parts.push(b.p);
    else if ('tip' in b) parts.push(b.tip);
    else if ('split' in b) parts.push(`Desktop — ${b.split.d}`, `Mobile — ${b.split.m}`);
    else for (const [k, d] of b.k) parts.push(`${k} — ${d}`);
  }
  return parts.join('\n');
}

function matches(t: Topic, q: string): boolean {
  return topicText(t).toLowerCase().includes(q.toLowerCase());
}

/** The line the match was found on, trimmed around the hit — so a result row
 *  shows why it matched instead of making you open it to find out. */
function snippetFor(t: Topic, q: string): string | null {
  if (!q) return null;
  const needle = q.toLowerCase();
  for (const line of topicText(t).split('\n')) {
    if (line === t.title || line === t.blurb) continue;   // the row already shows those
    const at = line.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 32);
    const end = Math.min(line.length, at + q.length + 60);
    return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
  }
  return null;
}

/** Wrap every case-insensitive hit of `q` in a <mark>. JSX escapes its children,
 *  so topic copy stays inert whatever it contains — no innerHTML anywhere. */
function Mark({ text, q }: { text: string; q: string }) {
  // An empty needle would make indexOf return 0 forever — guard before looping.
  if (!q) return <>{text}</>;
  const hay = text.toLowerCase();
  const needle = q.toLowerCase();
  let at = hay.indexOf(needle);
  if (at < 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let i = 0, key = 0;
  while (at >= 0) {
    if (at > i) out.push(text.slice(i, at));
    out.push(<mark key={key++} className="tt-help-mark">{text.slice(at, at + q.length)}</mark>);
    i = at + q.length;
    at = hay.indexOf(needle, i);
  }
  if (i < text.length) out.push(text.slice(i));
  return <>{out}</>;
}

// ── The help window ──────────────────────────────────────────────────────────

function Body({ body, q = '' }: { body: Block[]; q?: string }) {
  return (
    <>
      {body.map((b, i) => {
        if ('h' in b) return <h4 key={i} className="tt-help-h"><Mark text={b.h} q={q} /></h4>;
        if ('p' in b) return <p key={i} className="tt-help-p"><Mark text={b.p} q={q} /></p>;
        if ('tip' in b) return <div key={i} className="tt-help-tipcard"><Mark text={b.tip} q={q} /></div>;
        if ('split' in b) return (
          <div key={i} className="tt-help-split">
            <div className="tt-help-half">
              <span className="tt-help-half-h">DESKTOP</span>
              <span className="tt-help-half-d"><Mark text={b.split.d} q={q} /></span>
            </div>
            <div className="tt-help-half">
              <span className="tt-help-half-h">MOBILE</span>
              <span className="tt-help-half-d"><Mark text={b.split.m} q={q} /></span>
            </div>
          </div>
        );
        return (
          <dl key={i} className="tt-help-k">
            {b.k.map(([k, d], j) => (
              <div key={j} className="tt-help-krow">
                <dt><Mark text={k} q={q} /></dt><dd><Mark text={d} q={q} /></dd>
              </div>
            ))}
          </dl>
        );
      })}
    </>
  );
}

export function HelpModal({ tips, onTips, onClose }: {
  tips: boolean;
  onTips: (on: boolean) => void;
  onClose: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const open = TOPICS.find(t => t.id === openId) ?? null;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const q = query.trim();
  const hits = q ? TOPICS.filter(t => matches(t, q)) : TOPICS;

  useEffect(() => {
    // ESC unwinds ONE level at a time — reading a chapter and losing the whole
    // window is the wrong amount of undo, and so is losing a search you just
    // typed. Chapter → results → clear search → close.
    //
    // Captured, because the chopper's own window-level ESC handler stops every
    // pad: reading the manual should not silence the beat you left running.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (openId) setOpenId(null);
      else if (query) setQuery('');
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, openId, query]);

  // Opening a chapter starts you at its top, not wherever the topic list was
  // scrolled to — and a new set of results starts at the top of the results,
  // not halfway down where the previous ones happened to leave you.
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [openId, q]);

  return createPortal(
    <div className="tt-help-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="tt-help-win" role="dialog" aria-modal="true" aria-label="Terminator help">
        <div className="tt-help-hdr">
          <span className="tt-help-brand">T-800</span>
          <h2 className="tt-help-hdr-t">HELP</h2>
          <button className="tt-help-x" onClick={onClose} aria-label="Close help">✕</button>
        </div>

        <div className="tt-help-scroll" ref={scrollRef}>
          {/* Search rides above the list and stays put while you scroll. Hidden
              while reading a chapter — the back button is the way out of one,
              and a search box over an article invites you to lose your place. */}
          {!open && (
            <div className="tt-help-searchbar">
              <span className="tt-help-searchicon" aria-hidden>⌕</span>
              <input
                type="search"
                className="tt-help-search"
                placeholder="Search help…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                aria-label="Search help"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                // Focus on open with a mouse; NEVER on touch, where autofocus
                // throws up the keyboard and swallows the topic list you were
                // about to read.
                autoFocus={hoverCapable()}
              />
              {query && (
                <button className="tt-help-searchx" onClick={() => setQuery('')} aria-label="Clear search">✕</button>
              )}
            </div>
          )}

          {/* The tooltip switch is a setting, not a result — it stays on the
              plain topic list and gets out of the way of a search. */}
          {!open && !q && (
          <label className="tt-help-toggle">
            <input type="checkbox" checked={tips} onChange={e => onTips(e.target.checked)} />
            <span className="tt-help-toggle-t">
              <span className="tt-help-toggle-h">TOOLTIPS</span>
              {/* TELL THE TRUTH ON THE DEVICE YOU ARE ON. `TipLayer` bails out
                  on a coarse pointer — a tooltip hangs off a hover, and a touch
                  screen has none — so on a phone this row would be promising
                  something that cannot happen. The switch STAYS rather than
                  hiding: the setting is remembered, and it is often being set
                  here for the desktop opened later. */}
              <span className="tt-help-toggle-d">
                {hoverCapable()
                  ? 'Hover any control and a label explains what it does'
                  : 'With a mouse, hovering any control explains what it does. Touch screens have no hover, so this changes nothing here — it is saved for when you are on a computer.'}
              </span>
            </span>
          </label>
          )}

          {open ? (
            <div className="tt-help-article">
              {/* Arrived from a search? Say so — "ALL TOPICS" would read as
                  though the results were about to be thrown away. */}
              <button className="tt-help-back" onClick={() => setOpenId(null)}>
                {q ? '‹ BACK TO RESULTS' : '‹ ALL TOPICS'}
              </button>
              <h3 className="tt-help-title"><Mark text={open.title} q={q} /></h3>
              <Body body={open.body} q={q} />
            </div>
          ) : hits.length === 0 ? (
            <div className="tt-help-none">
              Nothing about “{q}”. Try a shorter word — the search reads every line of every topic.
            </div>
          ) : (
            <div className="tt-help-list">
              {q && (
                <div className="tt-help-count">
                  {hits.length} {hits.length === 1 ? 'TOPIC' : 'TOPICS'}
                </div>
              )}
              {hits.map(t => {
                // When the hit is buried in the body, show the line it was found
                // on instead of the blurb — otherwise a result gives no clue why
                // it is a result.
                const snip = q ? snippetFor(t, q) : null;
                return (
                  <button key={t.id} className="tt-help-row" onClick={() => setOpenId(t.id)}>
                    <span className="tt-help-row-t"><Mark text={t.title} q={q} /></span>
                    <span className="tt-help-row-b"><Mark text={snip ?? t.blurb} q={q} /></span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button className="tt-help-done" onClick={onClose}>DONE</button>
      </div>
    </div>,
    document.body,
  );
}
