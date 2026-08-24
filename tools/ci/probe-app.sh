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
# 150 s: the React probe's self-test runs the sequencers in real time (≈ 25 s on a Mac, 60+ s on a starved CI runner —
# the 3.7 tip's universal job was killed at 60 s mid-test); the cap only has to catch "the page never loaded"
for _ in $(seq 1 150); do
  sleep 1
  kill -0 "$PID" 2>/dev/null || break
done
if kill -0 "$PID" 2>/dev/null; then
  echo "::error::app did not quit within 150 s (page never loaded, or the self-test hung?)"; kill "$PID" || true; exit 1
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
  grep -Eq '"midiMirrored": ?true' "$OUT" || { echo "::error::shadow self-test: an injected MIDI note did not reach the page's engine (terminator.midiMessage → midiHub.injectNative → the router → triggerPad nativeOwned)"; exit 1; }
  grep -Eq '"midiNoDoubleTrigger": ?true' "$OUT" || { echo "::error::shadow self-test: a MIDI note triggered the native pad twice (direct path + shadow)"; exit 1; }
  grep -Eq '"midiTransportOk": ?true' "$OUT" || { echo "::error::shadow self-test: an injected MIDI START/STOP did not start/stop the page's transport (midiStartPlays / midiStopStops)"; exit 1; }
  grep -Eq '"midiClockOk": ?true' "$OUT" || { echo "::error::shadow self-test: the native MIDI clock OUT did not run/tick/stop with the transport (see midiClockRunning / midiClockTicksGrew / midiClockStopped / midiOutDropped)"; exit 1; }
  # the Sample Library: tree loaded (4 system folders), /lib/b64/ refuses paths outside the registered roots, and
  # when the library already holds a file the shell served it byte-complete
  # the offline exporter (4.5e): the project rendered through the real engine + mixer and a real WAV landed on disk
  grep -Eq '"export": ?\{[^}]*"ok": ?true' "$OUT" || { echo "::error::export self-test: rendering a project to WAV failed (see the export block above)"; exit 1; }
  grep -Eq '"export": ?\{[^}]*"bytes": ?[1-9]' "$OUT" || { echo "::error::export self-test: the WAV it reported writing has no bytes"; exit 1; }
  grep -Eq '"export": ?\{[^}]*"peak": ?0\.[0-9]*[1-9]' "$OUT" || { echo "::error::export self-test: the render is SILENT (peak 0) — a file full of nothing is a failed export"; exit 1; }
  grep -Eq '"export": ?\{[^}]*"flacSmaller": ?true' "$OUT" || { echo "::error::export self-test: the FLAC is missing, empty, or not smaller than the WAV"; exit 1; }
  # MP3 rides the BUNDLED `lame` — when the build ships one it MUST encode with nothing else on the machine
  if grep -Eq '"export": ?\{[^}]*"lameBundled": ?true' "$OUT"; then
    grep -Eq '"export": ?\{[^}]*"mp3Ok": ?true' "$OUT" || { echo "::error::export self-test: the bundled lame did not produce an MP3 (see mp3Error)"; exit 1; }
    grep -Eq '"export": ?\{[^}]*"mp3Bytes": ?[1-9]' "$OUT" || { echo "::error::export self-test: the MP3 it reported writing has no bytes"; exit 1; }
    echo "MP3 export through the bundled lame OK: $(grep -Eo '"mp3Bytes": ?[0-9]+' "$OUT")"
  else
    echo "::warning::lame not bundled in this build (TERMINATOR_BUNDLE_TOOLS=OFF?) — MP3 export needs one on the machine"
  fi
  grep -Eq '"export": ?\{[^}]*"progressReports": ?[1-9]' "$OUT" || { echo "::error::export self-test: the render reported no progress (the bar would never move)"; exit 1; }
  grep -Eq '"export": ?\{[^}]*"cancelled": ?true' "$OUT" || { echo "::error::export self-test: cancelling a render did not stop it"; exit 1; }
  grep -Eq '"export": ?\{[^}]*"cancelWroteNothing": ?true' "$OUT" || { echo "::error::export self-test: a CANCELLED export still reported files"; exit 1; }
  grep -Eq '"export": ?\{[^}]*"cancelLeftNoFile": ?true' "$OUT" || { echo "::error::export self-test: a CANCELLED export left a half-written file on disk"; exit 1; }
  grep -Eq '"systemOk": ?true' "$OUT" || { echo "::error::library self-test: the library tree did not load (system folders missing)"; exit 1; }
  grep -Eq '"outsideRootBlocked": ?true' "$OUT" || { echo "::error::library self-test: /lib/b64/ served a path OUTSIDE the registered roots"; exit 1; }
  if grep -Eq '"ytdlpBundled": ?true' "$OUT"; then
    grep -Eq '"ytdlpOk": ?true' "$OUT" || { echo "::error::the bundled yt-dlp did not answer --version through terminatorProcess (see ytdlpError)"; exit 1; }
    echo "yt-dlp bundled + runs: $(grep -Eo '"ytdlpVersion": ?"[^"]*"' "$OUT") (qjs: $(grep -Eo '"qjsBundled": ?[a-z]+' "$OUT"))"
    if grep -Eq '"ytDownload":' "$OUT"; then
      # TERMINATOR_PROBE_NET=1 asked for the real pull — YouTube/network flakiness is a warning, not a build failure
      if grep -Eq '"ytDownload": ?\{[^}]*"ok": ?true' "$OUT"; then echo "YouTube pull OK (end-to-end through the bundled yt-dlp + qjs): $(grep -Eo '"ytDownload": ?\{[^}]*\}' "$OUT")";
      else echo "::warning::the end-to-end YouTube pull did not succeed: $(grep -Eo '"ytDownload": ?\{[^}]*\}' "$OUT")"; fi
    fi
  else
    echo "::warning::yt-dlp not bundled in this build (TERMINATOR_BUNDLE_TOOLS=OFF?) — YouTube import unavailable"
  fi
  if grep -Eq '"servedUrl":' "$OUT"; then
    grep -Eq '"servedOk": ?true' "$OUT" || { echo "::error::library self-test: a managed library file was not served byte-complete at its /lib/b64/ URL"; exit 1; }
    echo "library file served OK (fetch); audio element: $(grep -Eo '"audioCanPlay": ?[a-z]+' "$OUT")"
  else
    echo "library OK (empty library on this machine — serving not exercised)"
  fi
  # the asset store: put → has → get (bytes byte-identical through /blob/) → the Electron-store fallback probe
  grep -Eq '"assetsOk": ?true' "$OUT" || { echo "::error::asset-store self-test failed (see the assets object above)"; exit 1; }
  if grep -Eq '"enginePrepared": ?true' "$OUT"; then
    grep -Eq '"lastTriggeredPad": ?63' "$OUT" || { echo "::error::engine is running but the shadow's trigger never reached the audio thread (lastTriggeredPad != 63)"; exit 1; }
    grep -Eq '"seqAdvances": ?true' "$OUT" || { echo "::error::the native chop sequencer did not run (setSequence + seqPlay → seqPlaying/step/hits)"; exit 1; }
    grep -Eq '"seqStopped": ?true' "$OUT" || { echo "::error::seqStop did not stop the native chop sequencer"; exit 1; }
    echo "native chop sequencer OK (bridge: setSequence → seqPlay → steps + hits → seqStop)"
    # Phase 3.2: the PAGE's transport (engine.playSeq / stopSeq) drives the native sequencer — pattern pushed, hits
    # fire, the TS cursor tracks the native step through NativeClock, stop lands natively
    grep -Eq '"seqPageOk": ?true' "$OUT" || { echo "::error::the page transport did not drive the native chop sequencer (seqPageOk false — see seqPage* fields: native playing / pattern index / hits / cursor tracking / stopped)"; exit 1; }
    echo "page transport → native chop sequencer OK: $(grep -Eo '"seqPageCursor": ?\{[^}]*\}' "$OUT") drift=$(grep -Eo '"seqPageDriftMs": ?[-0-9.e]+' "$OUT") clock rtt=$(grep -Eo '"clockRttMs": ?[-0-9.e]+' "$OUT" | head -1) snapshot age/tol=$(grep -Eo '"seqPageCursorAgeMs": ?\{[^}]*\}' "$OUT")"
    # Phase 3.3: the drum machine drives the NATIVE DrumSequencer — a lane's buffer mirrored + bound, the pattern
    # pushed, drumEngine.start() → native drumPlaying, hits fire, getStep() tracks the native step, stop lands natively
    grep -Eq '"drumPageOk": ?true' "$OUT" || { echo "::error::the drum machine did not drive the native drum sequencer (drumPageOk false — see the drums object: laneBound / nativePlaying / stepCount / hits / cursor / stopped)"; exit 1; }
    echo "drum machine → native drum sequencer OK: $(grep -Eo '"drumPageCursor": ?\{[^}]*\}' "$OUT") $(grep -Eo '"drumPageCursorAgeMs": ?\{[^}]*\}' "$OUT")"
    # Phase 3.4: the BASS drives the native BassSequencer + BassSynth — the patch pushed, a pattern pushed, bass.start()
    # → native bassPlaying, notes fire, the synth sounds (meter), getPlayheadBeats() tracks the native tick, stop lands
    grep -Eq '"bassPageOk": ?true' "$OUT" || { echo "::error::the bass did not drive the native bass sequencer/synth (bassPageOk false — see the bass object: nativePlaying / loopTicks / notesFired / level / cursor / stopped)"; exit 1; }
    echo "bass → native bass sequencer + synth OK: $(grep -Eo '"bassPageCursor": ?\{[^}]*\}' "$OUT") $(grep -Eo '"bassPageCursorAgeMs": ?\{[^}]*\}' "$OUT") level=$(grep -Eo '"level": ?[-0-9.e]+' "$OUT" | head -1)"
    # Phase 3.6: METRO → the native metronome clicks ON the sequencer's grid, STOP silences it; REC from stopped runs the
    # count-in in the engine and the transport starts ON its downbeat (the page took the exact anchor → ≤ 3 samples);
    # the ARP holds/steps/releases natively
    grep -Eq '"metroPageOk": ?true' "$OUT" || { echo "::error::the metronome / count-in / arp did not run natively (metroPageOk false — see metroEnabled / metroClicks / metroOnGrid / metroStops / countInRan / countInClicks / countInTransportStarted / countInExact / arpOk)"; exit 1; }
    # Phase 3.7: a live-recorded hit (with its input stamp) lands on the engine clock — the page wrote the step and the
    # engine got the hit at that line's exact sample (chop pad 62 + drum lane 0)
    grep -Eq '"liveRecOk": ?true' "$OUT" || { echo "::error::live record did not land on the engine clock (liveRecOk false — see liveRecArmed / liveRecStep / liveRecHitPad / liveRecOffsetSamples / drumLiveRec)"; exit 1; }
    grep -Eq '"mixerPageOk": ?true' "$OUT" || { echo "::error::the page mixer did not drive the native mixer (mixerPageOk false — see mixerStripsLive / mixerSources / mixerFaderDown / mixerFaderUp / mixerMuteOn / mixerMuteOff / mixerOrderValid / mixerRejected / mixerPadStrip)"; exit 1; }
    echo "live record on the engine clock OK: chop step=$(grep -Eo '"liveRecStep": ?-?[0-9]+' "$OUT") offset=$(grep -Eo '"liveRecOffsetSamples": ?[-0-9.e]+|"liveRecOffsetSamples": ?null' "$OUT") drums=$(grep -Eo '"drumLiveRec": ?\{[^}]*\}' "$OUT")"
    echo "metronome + count-in + arp native OK: $(grep -Eo '"metroLastClick": ?\{[^}]*\}' "$OUT") countIn offset=$(grep -Eo '"countInOffsetSamples": ?[-0-9.e]+|"countInOffsetSamples": ?null' "$OUT") anchorTaken=$(grep -Eo '"countInAnchorTaken": ?(true|false)' "$OUT") arpHits=$(grep -Eo '"arpHits": ?[0-9]+' "$OUT" | head -1)"
    # Phase 5.1c: the RECORD arm + the input monitor over the bridge handler — a take armed a minute ahead reports
    # ARMED and captures nothing, and the monitor verb answers
    grep -Eq '"armed": ?true' "$OUT" || { echo "::error::the record ARM did not take over the bridge (see record51c)"; exit 1; }
    grep -Eq '"monitorOk": ?true' "$OUT" || { echo "::error::input monitoring did not take over the bridge (see record51c)"; exit 1; }
    echo "record arm + monitor OK: $(grep -Eo '"record51c": ?\{[^}]*\}' "$OUT")"
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
