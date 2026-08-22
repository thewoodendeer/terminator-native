import { useEffect, useRef, useState } from 'react';
import { ChopperView } from './chopper/ChopperView';
import { EulaModal } from './chopper/EulaModal';
import { applyTheme, getStoredTheme, getDust, ThemeId } from './themes';
import { isSubscribed, isDemo } from './lib/subscription';
import { startFairyDust, stopFairyDust } from './luxe/fairyDust';

const ipcEula = (window as any).terminator as {
  eulaStatus: () => Promise<{ accepted: boolean }>;
} | undefined;

export default function App() {
  const [eulaReady, setEulaReady] = useState(false);
  const [eulaAccepted, setEulaAccepted] = useState(false);

  useEffect(() => {
    ipcEula?.eulaStatus().then(res => {
      setEulaAccepted(res.accepted);
      setEulaReady(true);
    }).catch(() => {
      // If IPC fails (e.g. browser dev mode), skip EULA
      setEulaAccepted(true);
      setEulaReady(true);
    });
  }, []);

  // Track the active theme so we only mount the ONE background video that's
  // actually visible — instead of downloading + decoding all of them at once.
  const [theme, setTheme] = useState<ThemeId>(() => getStoredTheme());
  useEffect(() => {
    const onTheme = (e: Event) => setTheme((e as CustomEvent).detail as ThemeId);
    window.addEventListener('terminator:theme', onTheme);
    return () => window.removeEventListener('terminator:theme', onTheme);
  }, []);

  // Apply the stored theme as early as possible so the user doesn't see a
  // flash of the default before their preferred one paints.
  useEffect(() => {
    applyTheme(getStoredTheme());
  }, []);

  // The 4K finish: body[data-finish="4k"] is stamped by the switch on any
  // theme, or always by a metal theme, including the picker's hover preview.
  // Both theme and finish changes re-read the attribute. While it is on, the
  // FAIRY DUST canvas (luxe/fairyDust.ts) trails the pointer; the emissive
  // lighting (lit buttons, CRT waveform, LED steps, meters) is pure CSS.
  const [fourK, setFourK] = useState<boolean>(() => document.body.dataset.finish === '4k');
  useEffect(() => {
    const read = () => setFourK(document.body.dataset.finish === '4k');
    read();
    window.addEventListener('terminator:theme', read);
    window.addEventListener('terminator:finish', read);
    return () => {
      window.removeEventListener('terminator:theme', read);
      window.removeEventListener('terminator:finish', read);
    };
  }, []);
  // The dust has its own switch in the picker (themes.ts applyDust).
  const [dust, setDust] = useState<boolean>(() => getDust());
  useEffect(() => {
    const read = () => setDust(getDust());
    window.addEventListener('terminator:dust', read);
    return () => window.removeEventListener('terminator:dust', read);
  }, []);
  const dustLive = fourK && dust;
  const dustRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!dustLive || !dustRef.current) return;
    startFairyDust(dustRef.current);
    return () => stopFairyDust();
  }, [dustLive]);

  // Mark <body> as free-tier so CSS can grey out locked sections + pads.
  // On web isSubscribed() is correct synchronously at mount (?sub=1). On Electron
  // it depends on the ASYNC device-license check, which resolves AFTER mount — so
  // we must re-apply whenever the license cache flips (terminator:license-changed,
  // dispatched by desktopAuth on refresh/sign-out). Without this the body stays
  // tt-locked forever and the whole pro UI is greyed even after a valid sign-in.
  useEffect(() => {
    const apply = () => {
      if (!isSubscribed()) document.body.classList.add('tt-locked');
      else document.body.classList.remove('tt-locked');
      document.body.classList.toggle('tt-demo', isDemo());
    };
    apply();
    window.addEventListener('terminator:license-changed', apply);
    return () => window.removeEventListener('terminator:license-changed', apply);
  }, []);

  // A tap outside a text field must let go of it. Pads, the waveform, knobs
  // and faders all preventDefault on pointerdown (they own the gesture), which
  // ALSO stops the browser from moving focus — so the project-name box stayed
  // focused, blinking, until you hit Tab. Capture-phase, before any of them.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const ae = document.activeElement as HTMLElement | null;
      if (!ae) return;
      const tag = ae.tagName;
      const isText = (tag === 'INPUT' && !/^(button|checkbox|radio|range|file|submit|color)$/i.test((ae as HTMLInputElement).type))
        || tag === 'TEXTAREA' || ae.isContentEditable;
      if (!isText) return;
      const t = e.target as Node | null;
      if (t && ae.contains(t)) return;
      ae.blur();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  if (!eulaReady) return null;

  if (!eulaAccepted) {
    return <EulaModal onAccepted={() => setEulaAccepted(true)} />;
  }

  return (
    <>
      <div className="scanlines" aria-hidden />
      {/* Per-theme background overlay. Layer divs are styled via
       *  body[data-theme="..."] selectors in terminator.css so each theme
       *  gets its own animation (rain, scanlines, sunset grid, etc.). */}
      <div className="theme-overlay" aria-hidden>
        <div className="lyr-bloom"></div>
        <div className="lyr-scan"></div>
        <div className="lyr-roll"></div>
        <div className="lyr-rain1"></div>
        <div className="lyr-rain2"></div>
        <div className="lyr-flash"></div>
        <div className="lyr-city"></div>
        <div className="lyr-glow"></div>
        <div className="lyr-glitch"></div>
        <div className="lyr-grid"></div>
        <div className="lyr-vignette"></div>
        <div className="lyr-sun"></div>
        <div className="lyr-sunlines"></div>
        <div className="lyr-stripes"></div>
        <div className="lyr-horizon"></div>
        <div className="lyr-palms"></div>
        {/* Theme-specific looping MP4 background — ONLY the active theme's clip
         *  is mounted, so we don't download + decode all of them at once (huge
         *  load + memory saving, esp. on iPhone). A freshly-mounted muted video
         *  autoplays fine on iOS, so unmounting the others is safe. The `key`
         *  forces a clean remount when the source theme changes. */}
        {theme === 'transformers' && (
          <video key="v-transformers" className="lyr-video"
            src={`${import.meta.env.BASE_URL}themes/transformers-bg.mp4`}
            autoPlay loop muted playsInline preload="auto" />
        )}
        {theme === 'ff7' && (
          <video key="v-ff7" className="lyr-video-ff7"
            src={`${import.meta.env.BASE_URL}themes/ff7-bg.mp4`}
            autoPlay loop muted playsInline preload="auto" />
        )}
        {theme === 'macos' && (
          <video key="v-macos" className="lyr-video-macos"
            src={`${import.meta.env.BASE_URL}themes/macos-bg.mp4`}
            autoPlay loop muted playsInline preload="auto" />
        )}
      </div>
      <ChopperView />
      {/* 4K finish: the fairy dust — a device-pixel canvas over everything,
       *  pointer-transparent, drawn only while a mote is alive. */}
      {dustLive && <canvas ref={dustRef} className="luxe-dust" aria-hidden />}
    </>
  );
}
