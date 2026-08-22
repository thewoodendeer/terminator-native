# ui/ — the React UI (Phase 2)

Empty on purpose in Phase 0. In Phase 2 the React UI is COPIED here from the Electron repo
(`terminator/src/renderer`, minus `mpc/` and `board/`, keeping `finishhim/`), gets its own pnpm gate, and
binds to the native engine through a typed `EngineClient` over `@juce-framework/webview`
(docs/native/BRIDGE-PROTOCOL.md). Until then the shell serves `app/resources/index.html`.
Dev loop planned: `TERMINATOR_UI_URL=http://localhost:5173 Terminator.app` → Vite HMR inside the WebView.
