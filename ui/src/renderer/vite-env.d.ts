/// <reference types="vite/client" />

// Native (JUCE WebView) build flag — `true` in ui/vite.config.ts (mode native), never defined in the Electron
// repo's bundle. Branch on it with `typeof __TERMINATOR_NATIVE__ !== 'undefined' && __TERMINATOR_NATIVE__`.
declare const __TERMINATOR_NATIVE__: boolean;
