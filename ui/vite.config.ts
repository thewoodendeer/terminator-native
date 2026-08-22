import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// ── Terminator 3.0 native UI build ─────────────────────────────────────────────
// This config mirrors the Electron repo's vite.config.ts for the ONE page the native app hosts (index.html →
// main.tsx → App → ChopperView) plus the Preferences page. Differences, on purpose:
//  • mode `native` only: the bundle is served to the JUCE WebView (WKWebView / WebView2) by the shell's
//    resource provider (app/src/WebShell.cpp) from `ui/dist`; `TERMINATOR_UI_URL=http://localhost:5173` points
//    the shell at this dev server instead (HMR inside the WebView).
//  • the version shown in the UI is the native version — read from the root CMakeLists.txt
//    (TERMINATOR_VERSION_STRING, the one version spot), never from a package.json.
//  • `__TERMINATOR_NATIVE__ = true`: the few places that branch on "am I Electron?" use it (gating is unlocked
//    until Phase 8/9 ports the licence flow — see lib/subscription.ts).
//  • no extractor / board / web modes, no service worker, no foley manifest.

const ROOT = path.resolve(__dirname);
const NATIVE_ROOT = path.resolve(ROOT, '..');

function nativeVersion(): string {
  try {
    const cm = fs.readFileSync(path.join(NATIVE_ROOT, 'CMakeLists.txt'), 'utf8');
    const m = /set\(TERMINATOR_VERSION_STRING\s+"([^"]+)"/.exec(cm);
    if (m) return m[1];
  } catch { /* fall through */ }
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
}

// CSP is swapped at HTML-emit time: dev needs inline + eval + ws for HMR; the built bundle locks down.
// Same origins as the Electron prod CSP minus the Electron custom schemes (the native shell serves the
// library/cache/drums through its resource provider, i.e. same-origin).
function cspByMode(): Plugin {
  return {
    name: 'terminator-native-csp',
    transformIndexHtml(html, ctx) {
      const isDev = ctx.server !== undefined;
      const common = [
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "media-src 'self' blob: data: https://kcc-samples.killavicbeats.workers.dev https://killaviccheatcodes.app https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
      ];
      const csp = isDev
        ? [
            "default-src 'self' blob: data:",
            ...common,
            "connect-src 'self' blob: ws: wss: https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev https://board-signal.killavicbeats.workers.dev https://kcc-samples.killavicbeats.workers.dev https://killaviccheatcodes.app https://aifbxlzvuemalfbfstim.supabase.co",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          ].join('; ')
        : [
            "default-src 'self' blob: data:",
            ...common,
            "connect-src 'self' blob: wss: https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev https://board-signal.killavicbeats.workers.dev https://kcc-samples.killavicbeats.workers.dev https://killaviccheatcodes.app https://aifbxlzvuemalfbfstim.supabase.co",
            "script-src 'self' 'wasm-unsafe-eval'",
          ].join('; ');
      return html.replace(
        /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*\/>/i,
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  if (mode !== 'native') {
    // eslint-disable-next-line no-console
    console.warn(`[terminator-ui] building in mode "${mode}" — the native shell expects --mode native`);
  }
  return {
    root: 'src/renderer',
    publicDir: path.resolve(ROOT, 'public'),
    envDir: ROOT,
    plugins: [react(), cspByMode()],
    base: './',
    define: {
      __TERMINATOR_WEB__: JSON.stringify(false),
      __DEBUG_TOOLS__: JSON.stringify(false),
      __TERMINATOR_NATIVE__: JSON.stringify(true),
      __TERMINATOR_VERSION__: JSON.stringify(nativeVersion()),
    },
    build: {
      outDir: path.resolve(ROOT, 'dist'),
      emptyOutDir: true,
      target: 'es2022',
      rollupOptions: {
        input: {
          main: path.resolve(ROOT, 'src/renderer/index.html'),
          preferences: path.resolve(ROOT, 'src/renderer/preferences/preferences.html'),
        },
      },
    },
    resolve: {
      alias: { '@': path.resolve(ROOT, 'src/renderer') },
    },
    server: {
      port: 5173,
      strictPort: true,
    },
  };
});
