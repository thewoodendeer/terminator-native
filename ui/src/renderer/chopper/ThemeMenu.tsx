import { useEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useKeepOnScreen } from '../hooks/useKeepOnScreen';
import { THEMES, type Finish } from '../themes';
import { HW_PALETTES } from './hwPalettes';
import type { UiMode } from './uiMode';

export type ThemeKind = 'original' | 'minimal';

/**
 * Desktop theme picker — a portal popover anchored to the T-800 brand mark.
 * Two columns: ORIGINAL (the HiFi-receiver `THEMES`) and MINIMAL (the Baethoven
 * `HW_PALETTES`, shared with HardwareView — data imported, never duplicated).
 *
 * Hovering an item previews it live (no commit); leaving the menu / Escape /
 * clicking outside reverts to the locked theme; clicking locks it in. Styled
 * from terminator.css (.tm-*) in DM Mono — the menu itself reads the active
 * --hw-* palette vars (mirrored onto <body>) so it matches whatever's live.
 */
/** DEMO allowance (the site's download-page embed): the only themes a demo
 *  visitor can lock in. Everything else shows greyed with a lock and opens the
 *  purchase popup. */
export const DEMO_THEMES: ReadonlySet<string> = new Set(['terminator', 'gta3', 'ff7']);
export const DEMO_PALETTES: ReadonlySet<string> = new Set(['linen', 'slate', 'lavender']);

export function ThemeMenu({ anchor, lockedKind, lockedId, finish, finishForced, onFinish, dust, onDust, onPreview, onPreviewEnd, onLock, onClose, uiMode, onUiMode, mobile, demo, onLockedTheme }: {
  anchor: DOMRect;
  lockedKind: ThemeKind;
  lockedId: string;
  /** The FINISH axis (themes.ts): 'classic' = the flat original look, '4k' =
   *  the bevelled, live-lit material on top of whatever colour theme is on.
   *  Independent of the two columns below — every theme can wear either. */
  finish: Finish;
  /** True while a METAL theme is active: those are always 4K, so the switch
   *  shows 4K lit and CLASSIC unavailable rather than lying. */
  finishForced: boolean;
  onFinish: (f: Finish) => void;
  /** The pointer's pixel dust (4K only) — its own on/off. */
  dust: boolean;
  onDust: (on: boolean) => void;
  onPreview: (kind: ThemeKind, id: string) => void;
  onPreviewEnd: () => void;
  onLock: (kind: ThemeKind, id: string) => void;
  onClose: () => void; // closes + reverts to the locked theme
  /** UI layout switch (AUTO / DESKTOP / MOBILE) — shown when both are given.
   *  Lets an iPad run the desktop layout, or a laptop the phone one. */
  uiMode?: UiMode;
  onUiMode?: (m: UiMode) => void;
  /** MOBILE variant (HardwareView): no FINISH/DUST row and no ORIGINAL column
   *  (those skin the desktop view only) — the palette list, a PHOSPHOR (palette
   *  off) item, and the UI switch. */
  mobile?: boolean;
  /** DEMO: only DEMO_THEMES / DEMO_PALETTES are pickable; the rest call onLockedTheme. */
  demo?: boolean;
  onLockedTheme?: () => void;
}) {
  // Escape closes (and the parent reverts to the locked theme).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // position:fixed below the anchor, flipping up + clamping to the viewport.
  const MENU_W = mobile ? 240 : 332, EST_H = 380;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_W - 8));
  const openUp = anchor.bottom + EST_H > window.innerHeight && anchor.top > EST_H;
  const style: CSSProperties = openUp
    ? { position: 'fixed', left, bottom: window.innerHeight - anchor.top + 4, width: MENU_W }
    : { position: 'fixed', left, top: anchor.bottom + 4, width: MENU_W };
  const menuRef = useRef<HTMLDivElement>(null);
  useKeepOnScreen(menuRef, `${Math.round(anchor.left)},${Math.round(anchor.top)}`);

  return createPortal(
    <>
      <div className="tm-backdrop" onPointerDown={onClose} />
      <div className={`tm-menu${mobile ? ' tm-menu--mobile' : ''}`} ref={menuRef} style={style} onMouseLeave={onPreviewEnd}>
        {/* UI LAYOUT — desktop or mobile chrome, on any device. Reloads. */}
        {uiMode && onUiMode && (
          <div className="tm-finish tm-ui" role="radiogroup" aria-label="UI layout">
            <span className="tm-finish-label">UI</span>
            {(['auto', 'desktop', 'mobile'] as UiMode[]).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={uiMode === m}
                className={`tm-finish-opt${uiMode === m ? ' on' : ''}`}
                onPointerDown={() => onUiMode(m)}
                title={m === 'auto' ? 'AUTO — desktop on a computer or iPad, mobile on a phone' : m === 'desktop' ? 'DESKTOP layout — every section + the DAW mixer, on any device (reloads)' : 'MOBILE layout — the hardware-style phone UI, on any device (reloads)'}>
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        {/* 4K MODE — the mobile finish switch (HardwareView's hwFinish axis).
            Same two options as the desktop FINISH row, no DUST (the pixel
            sparkle is a pointer trail — there is no pointer on a phone). A
            pointer-down commit, like the desktop row. */}
        {mobile && <div className="tm-finish" role="radiogroup" aria-label="4K mode">
          <span className="tm-finish-label">4K MODE</span>
          <button type="button" role="radio" aria-checked={finish === 'classic'}
            className={`tm-finish-opt${finish === 'classic' ? ' on' : ''}`}
            onPointerDown={() => onFinish('classic')}
            title="The original flat hardware look">CLASSIC</button>
          <button type="button" role="radio" aria-checked={finish === '4k'}
            className={`tm-finish-opt${finish === '4k' ? ' on' : ''}`}
            onPointerDown={() => onFinish('4k')}
            title="Milled, bevelled surfaces with LED lights — on any palette">4K</button>
        </div>}
        {/* FINISH switch — spans both columns. A pointer-down commit (Apple:
            respond on press, not release) so the material lands the instant
            you touch it. Locks immediately; nothing to preview or revert. */}
        {!mobile && <div className="tm-finish" role="radiogroup" aria-label="Finish">
          <span className="tm-finish-label">FINISH</span>
          {(() => {
            // What is actually on screen: a metal theme is 4K whatever the switch says.
            const shown: Finish = finishForced ? '4k' : finish;
            return <>
              <button type="button" role="radio" aria-checked={shown === 'classic'}
                className={`tm-finish-opt${shown === 'classic' ? ' on' : ''}`}
                disabled={finishForced}
                onPointerDown={() => { if (!finishForced) onFinish('classic'); }}
                title={finishForced ? 'Platinum and 24K Gold are always 4K — pick another theme for the classic look' : 'The original flat look'}>CLASSIC</button>
              <button type="button" role="radio" aria-checked={shown === '4k'}
                className={`tm-finish-opt${shown === '4k' ? ' on' : ''}`}
                onPointerDown={() => onFinish('4k')}
                title="Bevelled, glossy surfaces with a live light — on any colour theme">4K</button>
              {/* DUST: the pointer's pixel sparkle. Only meaningful in 4K, so it
                  greys out on classic rather than pretending to do something. */}
              <span className="tm-finish-sep" aria-hidden />
              <button type="button" role="switch" aria-checked={dust}
                className={`tm-finish-opt tm-dust${dust ? ' on' : ''}`}
                disabled={shown !== '4k'}
                onPointerDown={() => { if (shown === '4k') onDust(!dust); }}
                title={shown === '4k' ? (dust ? 'Pixel dust is ON — click to turn it off' : 'Pixel dust is OFF — click to turn it on') : 'Pixel dust needs the 4K finish'}>
                {dust ? '✦ DUST' : '✧ DUST'}
              </button>
            </>;
          })()}
        </div>}
        {!mobile && <div className="tm-col">
          <div className="tm-col-title">ORIGINAL</div>
          {THEMES.map(t => {
            const on = lockedKind === 'original' && lockedId === t.id;
            const locked = !!demo && !DEMO_THEMES.has(t.id);
            return (
              <button key={t.id} className={`tm-item${on ? ' on' : ''}${locked ? ' tm-locked' : ''}`}
                title={locked ? 'Get Terminator to unlock this theme' : undefined}
                onMouseEnter={locked ? undefined : () => onPreview('original', t.id)}
                onFocus={locked ? undefined : () => onPreview('original', t.id)}
                onClick={() => (locked ? onLockedTheme?.() : onLock('original', t.id))}>
                {locked ? '🔒 ' : ''}{t.label}
              </button>
            );
          })}
        </div>}
        <div className="tm-col">
          <div className="tm-col-title">{mobile ? 'PALETTE' : 'MINIMAL'}</div>
          {mobile && (
            <button className={`tm-item${lockedKind === 'minimal' && lockedId === 'phosphor' ? ' on' : ''}`}
              onClick={() => onLock('minimal', 'phosphor')} title="The original green-phosphor hardware look (palette off)">
              <span className="tm-swatch" style={{ background: '#0b1a12', borderColor: '#00ff88' }}>
                <span className="tm-swatch-dot" style={{ background: '#00ff88' }} />
              </span>
              Phosphor
            </button>
          )}
          {HW_PALETTES.map(p => {
            const on = lockedKind === 'minimal' && lockedId === p.id;
            const locked = !!demo && !DEMO_PALETTES.has(p.id);
            return (
              <button key={p.id} className={`tm-item${on ? ' on' : ''}${locked ? ' tm-locked' : ''}`}
                title={locked ? 'Get Terminator to unlock this palette' : undefined}
                onMouseEnter={locked ? undefined : () => onPreview('minimal', p.id)}
                onFocus={locked ? undefined : () => onPreview('minimal', p.id)}
                onClick={() => (locked ? onLockedTheme?.() : onLock('minimal', p.id))}>
                <span className="tm-swatch" style={{ background: p.bg, borderColor: p.border }}>
                  <span className="tm-swatch-dot" style={{ background: p.accent }} />
                </span>
                {locked ? '🔒 ' : ''}{p.name}
              </button>
            );
          })}
        </div>
      </div>
    </>,
    document.body,
  );
}
