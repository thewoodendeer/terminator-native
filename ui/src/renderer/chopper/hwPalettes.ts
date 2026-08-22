/**
 * HardwareView palette themes (also the desktop picker's MINIMAL column). 15
 * flat, tactile palettes — the 9 neutral Baethoven ones (5 light, 4 dark) plus
 * Baethoven's 6 coloured light schemes. Linen is the default. The original phosphor-green
 * hardware look is the fallback whenever palette mode is OFF, so the whole
 * feature is reversible by removing the `data-palette` attribute (+ the inline
 * --hw-* vars) from `.hw-machine`.
 *
 * Mirrors the App-level theme system in themes.ts (localStorage `terminator.*`
 * key prefix, read-on-mount + unknown-id guard) but is SCOPED to `.hw-machine`
 * via CSS custom properties instead of `<body data-theme>` — so it never
 * touches the desktop ChopperView or the App-level theme system. New module;
 * themes.ts / App.tsx are left untouched.
 */

export type HwPalette = {
  id: string;
  name: string;
  dark: boolean;
  bg: string;
  panel: string;
  pad: string;
  text: string;
  accent: string;
  border: string;
  muted: string;
  faint: string;
};

export const HW_PALETTES: HwPalette[] = [
  { id: 'linen',    name: 'Linen',    dark: false, bg: '#e9e7e0', panel: '#f5f3ec', pad: '#2b2926', text: '#2a2824', accent: '#2a2824', border: '#dcd8cd', muted: '#75716a', faint: '#a6a195' },
  { id: 'sand',     name: 'Sand',     dark: false, bg: '#ece6db', panel: '#f6f1e7', pad: '#2a2722', text: '#2a2620', accent: '#2a2620', border: '#d4cab8', muted: '#7a7264', faint: '#a89e8c' },
  { id: 'wheat',    name: 'Wheat',    dark: false, bg: '#efe7d5', panel: '#f9f3e6', pad: '#2b2820', text: '#2b2619', accent: '#2b2619', border: '#dacfb4', muted: '#7c7460', faint: '#ac9f87' },
  { id: 'clay',     name: 'Clay',     dark: false, bg: '#ece2d8', panel: '#f7f0e8', pad: '#2c2622', text: '#2c2520', accent: '#2c2520', border: '#d8c9b7', muted: '#7d7065', faint: '#ad9d8c' },
  { id: 'paper',    name: 'Paper',    dark: false, bg: '#f4f3f0', panel: '#ffffff', pad: '#1f1e1c', text: '#1a1816', accent: '#161412', border: '#dcd8d0', muted: '#6f6a62', faint: '#9b958a' },
  { id: 'slate',    name: 'Slate',    dark: true,  bg: '#0f1419', panel: '#151b22', pad: '#dfe5ea', text: '#eef2f6', accent: '#eaf0f5', border: '#2c353f', muted: '#8a95a0', faint: '#5f6a74' },
  { id: 'midnight', name: 'Midnight', dark: true,  bg: '#0d0f1a', panel: '#131524', pad: '#e2e3ee', text: '#edeef6', accent: '#e6e7f5', border: '#282c4a', muted: '#8a8da6', faint: '#5f6279' },
  { id: 'plum',     name: 'Plum',     dark: true,  bg: '#160f16', panel: '#1d141d', pad: '#ece2ea', text: '#f2eaf0', accent: '#efe3ec', border: '#362636', muted: '#9d8d99', faint: '#6f6069' },
  { id: 'mono',     name: 'Mono',     dark: true,  bg: '#000000', panel: '#0b0b0b', pad: '#ffffff', text: '#ffffff', accent: '#ffffff', border: '#2a2a2a', muted: '#888888', faint: '#555555' },
  // Baethoven's six coloured LIGHT schemes — a saturated desktop behind pale
  // panels and dark ink. Values copied verbatim from BAETHOVEN.dc.html THEMES
  // (bg / panel / pad / txt / acc / cbrd / muted / faint), same mapping as the
  // nine above, so the two apps stay one palette family. All read as light:
  // the ink is dark, so `dark` is false regardless of how loud the desktop is.
  { id: 'electric',  name: 'Electric',  dark: false, bg: '#0a84ff', panel: '#f4f6fb', pad: '#11233d', text: '#0c1b32', accent: '#0858b0', border: '#c3d2ea', muted: '#5b6b85', faint: '#93a6c2' },
  { id: 'crimson',   name: 'Crimson',   dark: false, bg: '#ff453a', panel: '#fbf5f4', pad: '#3d1513', text: '#331110', accent: '#b02a22', border: '#ead0cd', muted: '#85605c', faint: '#c2938e' },
  { id: 'honey',     name: 'Honey',     dark: false, bg: '#f4d35e', panel: '#fdf7e3', pad: '#2e2814', text: '#2c2611', accent: '#2c2611', border: '#e3d29a', muted: '#7d7044', faint: '#a89a6a' },
  { id: 'tangerine', name: 'Tangerine', dark: false, bg: '#fe7f2d', panel: '#fff4ea', pad: '#3a1e0a', text: '#331a07', accent: '#c24e0a', border: '#f2cba6', muted: '#8a5f3c', faint: '#c59872' },
  { id: 'glacier',   name: 'Glacier',   dark: false, bg: '#ccfbfe', panel: '#f2feff', pad: '#10282b', text: '#0e2528', accent: '#0e2528', border: '#a9e4e8', muted: '#4f767a', faint: '#86a8ab' },
  { id: 'lavender',  name: 'Lavender',  dark: false, bg: '#bdadea', panel: '#f6f3fc', pad: '#231a36', text: '#211833', accent: '#211833', border: '#d6cae9', muted: '#645a7e', faint: '#9488ad' },
];

const ON_KEY = 'terminator.hwPalette.on';
const ID_KEY = 'terminator.hwPalette.id';

// ── 4K MODE — the mobile FINISH axis ────────────────────────────────────────
// Mirrors the desktop's Finish (themes.ts): the palette says WHAT colour the
// machine is, 4K says what it is MADE OF. Stamped as data-finish="4k" on
// `.hw-machine` (HardwareView.css derives the material ramp from the active
// --hw-* palette vars, phosphor fallbacks included, so every palette AND the
// phosphor look wear it). Its own storage key — the desktop's finish is a
// different surface and the two choices must not fight over one key. Same
// `?finish=` URL override as the desktop, so the site's download embed
// (?demo=1&finish=4k) shows the material without touching the visitor's
// saved choice.
export type HwFinish = 'classic' | '4k';
const FINISH_KEY = 'terminator.hwFinish';

function urlFinish(): HwFinish | null {
  try {
    const v = new URLSearchParams(window.location.search).get('finish');
    return v === '4k' || v === 'classic' ? v : null;
  } catch { return null; }
}

export function getStoredHwFinish(): HwFinish {
  const u = urlFinish();
  if (u) return u;
  // Default is 4K — same out-of-the-box call as the desktop (2026-08-18).
  try { const v = localStorage.getItem(FINISH_KEY); if (v === 'classic' || v === '4k') return v; } catch { /* */ }
  return '4k';
}

export function persistHwFinish(f: HwFinish): void {
  // A URL-forced finish (the site's embed) is for this load only.
  if (urlFinish()) return;
  try { localStorage.setItem(FINISH_KEY, f); } catch { /* */ }
}

export function getStoredPaletteOn(): boolean {
  // DEFAULT true → Linen on first load (this is the "Linen is default" line).
  // Flip this default to `false` to boot in the original green hardware look.
  try {
    const v = localStorage.getItem(ON_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch { /* localStorage unavailable */ }
  return true;
}

export function getStoredPaletteId(): string {
  try {
    const v = localStorage.getItem(ID_KEY);
    if (v && HW_PALETTES.some(p => p.id === v)) return v;   // guard unknown id
  } catch { /* localStorage unavailable */ }
  return 'linen';
}

export function persistPaletteOn(on: boolean): void {
  try { localStorage.setItem(ON_KEY, on ? '1' : '0'); } catch { /* */ }
}

export function persistPaletteId(id: string): void {
  try { localStorage.setItem(ID_KEY, id); } catch { /* */ }
}

export function paletteById(id: string): HwPalette {
  return HW_PALETTES.find(p => p.id === id) ?? HW_PALETTES[0];
}

export function nextPaletteId(current: string): string {
  const idx = HW_PALETTES.findIndex(p => p.id === current);
  return HW_PALETTES[(idx + 1) % HW_PALETTES.length].id;
}
