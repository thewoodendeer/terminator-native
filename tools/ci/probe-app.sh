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
  # the native-engine shadow (audio through the C++ engine): attached to ChopperView's engine, and its self-test
  # pushed a synthetic buffer through terminatorSamples, bound + triggered pad 63 and released it
  grep -Eq '"attached": ?true' "$OUT" || { echo "::error::the native engine shadow did not attach to the ChopperEngine"; exit 1; }
  grep -Eq '"upload": ?true' "$OUT" || { echo "::error::shadow self-test: the sample upload (terminatorSamples begin/chunk/end) failed"; exit 1; }
  grep -Eq '"storeFrames": ?12000' "$OUT" || { echo "::error::shadow self-test: the SampleStore does not hold the uploaded frames"; exit 1; }
  grep -Eq '"bind": ?true' "$OUT" || { echo "::error::shadow self-test: setPadSample by key failed"; exit 1; }
  grep -Eq '"loop": ?true' "$OUT" || { echo "::error::shadow self-test: setPadLoop (native crossfade-loop render) failed"; exit 1; }
  grep -Eq '"trigger": ?true' "$OUT" || { echo "::error::shadow self-test: triggerPad failed"; exit 1; }
  grep -Eq '"release": ?true' "$OUT" || { echo "::error::shadow self-test: sample release failed"; exit 1; }
  grep -Eq '"syncBound": ?true' "$OUT" || { echo "::error::shadow self-test: a pad source loaded into the TS engine was not mirrored (describe/diff/upload/bind) to the native pad"; exit 1; }
  grep -Eq '"syncUnbound": ?true' "$OUT" || { echo "::error::shadow self-test: removing the pad source did not unbind the native pad"; exit 1; }
  # the Sample Library: tree loaded (4 system folders), /lib/b64/ refuses paths outside the registered roots, and
  # when the library already holds a file the shell served it byte-complete
  grep -Eq '"systemOk": ?true' "$OUT" || { echo "::error::library self-test: the library tree did not load (system folders missing)"; exit 1; }
  grep -Eq '"outsideRootBlocked": ?true' "$OUT" || { echo "::error::library self-test: /lib/b64/ served a path OUTSIDE the registered roots"; exit 1; }
  if grep -Eq '"servedUrl":' "$OUT"; then
    grep -Eq '"servedOk": ?true' "$OUT" || { echo "::error::library self-test: a managed library file was not served byte-complete at its /lib/b64/ URL"; exit 1; }
    echo "library file served OK (fetch); audio element: $(grep -Eo '"audioCanPlay": ?[a-z]+' "$OUT")"
  else
    echo "library OK (empty library on this machine — serving not exercised)"
  fi
  if grep -Eq '"enginePrepared": ?true' "$OUT"; then
    grep -Eq '"lastTriggeredPad": ?63' "$OUT" || { echo "::error::engine is running but the shadow's trigger never reached the audio thread (lastTriggeredPad != 63)"; exit 1; }
    echo "native engine shadow OK (upload → bind → trigger reached the audio thread)"
  else
    echo "::warning::no audio device on this machine (engine not prepared) — shadow upload/bind/commands OK, trigger not observable"
  fi
  echo "React UI OK (ChopperView + Preferences window + native engine shadow)"
else
  grep -q '@juce-framework/webview loaded' "$OUT" || { echo "::error::page did not load the JUCE webview package"; exit 1; }
  grep -q 'Terminator 3\.' "$OUT" || { echo "::error::terminatorInfo() did not reach the page"; exit 1; }
  grep -Eq '"snapshot": ?"prepared' "$OUT" && echo "engine prepared on a real device" || echo "::warning::no audio device on this machine (engine not prepared) — bridge still OK"
fi
echo "PROBE OK"
