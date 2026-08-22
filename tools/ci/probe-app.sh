#!/usr/bin/env bash
# Smoke-test the built app headlessly: launch with TERMINATOR_PROBE_FILE, wait for the WebView page to load,
# the shell evaluates JS inside the page and writes what it rendered, then quits. We assert the bridge and
# the engine are both alive — and, when the React UI (ui/dist) is bundled, that ChopperView actually rendered
# with no uncaught page errors. Usage: tools/ci/probe-app.sh <path-to-Terminator-binary> [out.json]
set -euo pipefail
BIN="${1:?usage: probe-app.sh <Terminator binary> [out.json]}"
OUT="${2:-build/probe.json}"
rm -f "$OUT"
TERMINATOR_PROBE_FILE="$OUT" "$BIN" &
PID=$!
for _ in $(seq 1 60); do
  sleep 1
  kill -0 "$PID" 2>/dev/null || break
done
if kill -0 "$PID" 2>/dev/null; then
  echo "::error::app did not quit within 60 s (page never loaded?)"; kill "$PID" || true; exit 1
fi
wait "$PID" || { echo "::error::app exited non-zero"; exit 1; }
echo "== probe output"; cat "$OUT"; echo
grep -Eq '"hasJuce": ?true' "$OUT" || { echo "::error::window.__JUCE__ missing — WebView bridge not injected"; exit 1; }
if grep -Eq '"uiMode": ?"react"' "$OUT"; then
  echo "== the React UI is bundled — asserting ChopperView rendered"
  grep -Eq '"chopperView": ?true' "$OUT" || { echo "::error::React UI served but ChopperView did not render (see errors above)"; exit 1; }
  grep -Eq '"errors": ?\[\]' "$OUT" || { echo "::error::the page reported uncaught errors"; exit 1; }
  grep -Eq '"prefsWindow": ?true' "$OUT" || { echo "::error::window.terminator.openPreferences() did not open the native Preferences window"; exit 1; }
  grep -Eq '"prefsReady": ?true' "$OUT" || { echo "::error::the Preferences page did not finish loading in its window"; exit 1; }
  echo "React UI OK (ChopperView + Preferences window)"
else
  grep -q '@juce-framework/webview loaded' "$OUT" || { echo "::error::page did not load the JUCE webview package"; exit 1; }
  grep -q 'Terminator 3\.' "$OUT" || { echo "::error::terminatorInfo() did not reach the page"; exit 1; }
  grep -Eq '"snapshot": ?"prepared' "$OUT" && echo "engine prepared on a real device" || echo "::warning::no audio device on this machine (engine not prepared) — bridge still OK"
fi
echo "PROBE OK"
