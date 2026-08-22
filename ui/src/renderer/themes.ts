/**
 * Theme system — 6 retro/futurist palettes the user cycles through by
 * tapping the T-800 brand bar. Each theme provides:
 *   - a unique colour palette (CSS variables on <body data-theme="...">)
 *   - a font combo (brand / hud / mono)
 *   - animated overlay layers (rain, scanlines, sunset grid, etc.)
 *
 * The active theme is persisted to localStorage so it survives reloads
 * without requiring a sign-in flow.
 */

export type ThemeId =
  | 'terminator'
  | 'gta3'
  | 'ff7'
  | 'sonic'
  | 'outrun'
  | 'vicecity'
  | 'transformers'
  | 'macos'
  | 'macos9'
  | 'platinum'
  | 'gold';

export interface ThemeMeta { id: ThemeId; label: string; }

/** The two METAL themes share one CSS block (body[data-metal]) and always
 *  wear the 4K finish. Platinum = platinum surfaces + gold accents; Gold =
 *  the inverse. */
export const METAL_THEMES: ReadonlySet<ThemeId> = new Set<ThemeId>(['platinum', 'gold']);

export const THEMES: ThemeMeta[] = [
  { id: 'platinum',     label: 'PLATINUM' },
  { id: 'gold',         label: '24K GOLD' },
  { id: 'terminator',   label: 'TERMINATOR' },
  { id: 'gta3',         label: 'GTA 3 — NYC RAIN' },
  { id: 'ff7',          label: 'FF7 — SHINRA REACTOR' },
  { id: 'sonic',        label: 'SONIC — GREEN HILL' },
  { id: 'outrun',       label: 'MARIO' },
  { id: 'vicecity',     label: 'STREET FIGHTER 2' },
  { id: 'transformers', label: 'TRANSFORMERS G1' },
  { id: 'macos',        label: 'MAC OS — SYSTEM 7' },
  { id: 'macos9',       label: 'MAC OS 9' },
];

const STORAGE_KEY = 'terminator.theme';

/** A `?theme=` / `?finish=` on the app URL wins over the stored choice for
 *  THIS load and is not persisted — the site's /terminator/download embed
 *  uses it to show the 4K PLATINUM finish without touching the visitor's own
 *  saved theme on /terminator. */
function urlParam(name: string): string | null {
  try { return new URLSearchParams(window.location.search).get(name); } catch { return null; }
}

export function getStoredTheme(): ThemeId {
  const u = urlParam('theme');
  if (u && THEMES.some(t => t.id === u)) return u as ThemeId;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && THEMES.some(t => t.id === v)) return v as ThemeId;
  } catch { /* localStorage unavailable */ }
  return 'terminator';
}

// ── FINISH — a second, independent axis ─────────────────────────────────────
// The colour theme says WHAT colour things are; the finish says what they are
// MADE OF. 'classic' is the flat original look. '4k' is the material layer:
// bevelled, glossy surfaces built from the active theme's own colours, with
// emissive lighting on the real lights and pixel dust on the pointer
// (luxe/). Because the material derives its
// ramp from whatever palette is active, every colour theme — the nine
// originals AND all fifteen Minimal palettes — can wear either finish. The
// two metal themes always wear 4k; that is what makes them metal.
export type Finish = 'classic' | '4k';
const FINISH_KEY = 'terminator.finish';

export function getStoredFinish(): Finish {
  const u = urlParam('finish');
  if (u === '4k' || u === 'classic') return u;
  // Default is the 4K finish (2026-08-18 — his call: TERMINATOR theme, 4K,
  // dust off, out of the box); 'classic' only when the visitor chose it.
  try { const v = localStorage.getItem(FINISH_KEY); if (v === 'classic' || v === '4k') return v; } catch { /* */ }
  return '4k';
}

let currentFinish: Finish = getStoredFinish();
export function getFinish(): Finish { return currentFinish; }

/** Is the 4k material actually on screen right now? True for the 4k finish on
 *  any theme, and always for the two metal themes. */
export function isFinish4kActive(theme: ThemeId = (document.body.dataset.theme as ThemeId) || 'terminator'): boolean {
  return currentFinish === '4k' || METAL_THEMES.has(theme);
}

/** Stamp body[data-finish] / body[data-metal] for `theme`. Pass null when a
 *  MINIMAL palette is active (ChopperView clears body[data-theme] for those
 *  and applies --hw-* vars instead) — the finish still applies, the metal ramp
 *  never does. Exported for that one caller. */
export function syncFinishAttrs(theme: ThemeId | null): void {
  const b = document.body;
  const metal = theme !== null && METAL_THEMES.has(theme);
  if (currentFinish === '4k' || metal) b.dataset.finish = '4k';
  else delete b.dataset.finish;
  // The metal themes carry their tuned ramps under body[data-metal]; every
  // other theme derives a ramp from its own vars inside body[data-finish="4k"].
  if (metal) b.dataset.metal = theme;
  else delete b.dataset.metal;
}

// ── FAIRY DUST — the pointer trail of the 4K finish, on its own switch ──────
// Some people want the metal without the sparkle. Persisted; read by App to
// mount/unmount the dust canvas. Meaningless when the finish is classic.
// Default is OFF (2026-08-18, his call: TERMINATOR theme, 4K, dust off out of
// the box); on only when the visitor switched it on — and then it stays on
// until they switch it off, like the theme and the finish.
const DUST_KEY = 'terminator.dust';
let dustOn: boolean = (() => { try { return localStorage.getItem(DUST_KEY) === '1'; } catch { return false; } })();
export function getDust(): boolean { return dustOn; }
export function applyDust(on: boolean): void {
  dustOn = on;
  try { localStorage.setItem(DUST_KEY, on ? '1' : '0'); } catch { /* */ }
  try { window.dispatchEvent(new CustomEvent('terminator:dust', { detail: on })); } catch { /* */ }
}

export function applyFinish(f: Finish): void {
  currentFinish = f;
  if (!urlParam('finish')) { try { localStorage.setItem(FINISH_KEY, f); } catch { /* */ } }
  syncFinishAttrs((document.body.dataset.theme as ThemeId) || 'terminator');
  try { window.dispatchEvent(new CustomEvent('terminator:finish', { detail: f })); } catch { /* */ }
}

export function applyTheme(id: ThemeId): void {
  document.body.dataset.theme = id;
  syncFinishAttrs(id);
  // A URL-forced theme (the site's showcase embed) is for this load only —
  // never overwrite what the visitor chose for themselves.
  if (!urlParam('theme')) { try { localStorage.setItem(STORAGE_KEY, id); } catch { /* */ } }
  // Sync the iOS PWA status-bar tint to match the active theme.
  const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (meta) {
    const themeColors: Record<ThemeId, string> = {
      terminator:   '#00ff88',
      gta3:         '#ffd84d',
      ff7:          '#1cbeae',
      sonic:        '#0058ff',
      outrun:       '#ff006e',
      vicecity:     '#ff7a1a',
      transformers: '#dc1818',
      macos:        '#cccccc',
      macos9:       '#8b8bb0',
      platinum:     '#c9ccd1',
      gold:         '#c9a13c',
    };
    meta.content = themeColors[id] || '#00ff88';
  }
  // Let the app react to theme changes (e.g. mount only the active theme's
  // background video instead of keeping all of them loaded + decoding).
  try { window.dispatchEvent(new CustomEvent('terminator:theme', { detail: id })); } catch { /* */ }
}

export function nextTheme(current: ThemeId): ThemeId {
  const idx = THEMES.findIndex(t => t.id === current);
  return THEMES[(idx + 1) % THEMES.length].id;
}
