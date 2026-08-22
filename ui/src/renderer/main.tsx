import React from 'react';
import { createRoot } from 'react-dom/client';
// Order matters: ipc-browser auto-installs window.terminator at module load
// as a side effect. It MUST be imported before App, because App reads
// window.terminator at module-evaluation time and ES imports execute their
// dependents' bodies before the importing module's body runs. Importing here
// first guarantees window.terminator is set by the time App.tsx evaluates.
// In Electron the preload script populates window.terminator first; the
// auto-installer detects that and bails (idempotent).
import './ipc-browser';
import App from './App';
import './styles/terminator.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

// Service worker: web build only, and only in real deployments. Dev mode hits
// localhost where the SW would cache Vite's HMR shell and fight live reload.
// In Electron the renderer runs from `file://` (or the custom protocol) where
// SWs aren't useful — the bundle is already on disk.
const __isWeb = (import.meta as any).env?.MODE === 'web';
if (__isWeb && 'serviceWorker' in navigator) {
  const isDevHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isDevHost) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('[sw] registration failed:', err);
      });
    });
  }
}
