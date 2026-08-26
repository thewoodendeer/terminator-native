#!/usr/bin/env bash
# PACKAGE THE MAC APP — build → sign → notarise → staple → DMG + zip, with the gates that matter.
#
# What this is for: an un-notarised DMG is Gatekeeper-blocked on every Mac that is not this one, and a build
# that crashes on launch cannot self-update (the app dies before its updater runs), so shipping one means every
# user who takes it needs a MANUAL reinstall. Both of those are checked HERE, before anything is uploaded.
# Nothing in this script uploads or publishes: it writes artefacts to release/mac/ and stops.
#
#   tools/release/package-mac.sh [--no-build] [--no-notarize] [--identity <id>] [--profile <keychain-profile>]
#
# Requires: the Developer ID Application identity in the login keychain, and a notarytool keychain profile
# (`xcrun notarytool store-credentials <name> --key ~/.appstore-keys/AuthKey_XXXX.p8 --key-id … --issuer …`).
# The credentials never appear here — the profile name is a capability, not a secret.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PRESET="mac-release-universal"
BUILD_DIR="build/${PRESET}"
APP_SRC="${BUILD_DIR}/app/Terminator_artefacts/Release/Terminator.app"
OUT_DIR="release/mac"
IDENTITY="${TERMINATOR_SIGN_IDENTITY:-Developer ID Application: victor borges (S7QVJJHXJ4)}"
PROFILE="${TERMINATOR_NOTARY_PROFILE:-KCC_EXTRACTOR_NOTARY}"
# The team the signature must belong to, taken from the identity itself — "Developer ID Application: name (TEAM)".
TEAM_ID="${TERMINATOR_TEAM_ID:-}"
DO_BUILD=1
DO_NOTARIZE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build)    DO_BUILD=0 ;;
    --no-notarize) DO_NOTARIZE=0 ;;
    --identity)    IDENTITY="${2:?--identity needs a value}"; shift ;;
    --profile)     PROFILE="${2:?--profile needs a value}"; shift ;;
    -h|--help)     sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$TEAM_ID" ]; then
  TEAM_ID="$(printf '%s' "$IDENTITY" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')"
fi

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. build ────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$DO_BUILD" = 1 ]; then
  step "building ${PRESET}"
  cmake --preset "$PRESET" >/dev/null
  cmake --build --preset "$PRESET"
fi
[ -d "$APP_SRC" ] || die "no app at $APP_SRC — run without --no-build"

# ── 2. what did we actually build? ──────────────────────────────────────────────────────────────────────────
cache="${BUILD_DIR}/CMakeCache.txt"
VERSION="$(sed -n 's/^TERMINATOR_VERSION_STRING:STRING=//p' "$cache")"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_SRC/Contents/Info.plist")"
[ -n "$VERSION" ] || die "could not read TERMINATOR_VERSION_STRING from $cache"
step "Terminator $VERSION  ·  $BUNDLE_ID"

# THE HANDOVER GATE (plan 9.4b). Squirrel.Mac swaps a downloaded bundle into the installed one only when the
# CFBundleIdentifier matches, so the release that crosses over from Electron 2.2.4 must carry the ELECTRON id.
# An alpha/beta may keep its own id (both apps coexist on one Mac while 3.0 is in alpha); a FINAL release may
# not — that would silently strand every existing user on 2.2.x with an updater that finds nothing to swap.
case "$VERSION" in
  *-alpha*|*-beta*|*-rc*) : ;;
  *) [ "$BUNDLE_ID" = "com.terminator.audio" ] || die \
       "version $VERSION is a FINAL release but the bundle id is $BUNDLE_ID.
   The 3.0.0 that existing Electron users auto-update INTO must be com.terminator.audio, or Squirrel.Mac
   will not swap it in (plan 9.4b). Re-configure with -DTERMINATOR_BUNDLE_ID=com.terminator.audio." ;;
esac

# THE BUILD NUMBER SPARKLE COMPARES. JUCE writes `project(VERSION)` into CFBundleVersion, which makes every
# 3.0.0-alpha.N identical ("3.0.0") — an updater that can never see one alpha as newer than another, silently.
# app/CMakeLists.txt derives a monotonic integer instead and stamps it POST_BUILD; this is the check that it
# actually landed on the bundle being shipped.
BUILD_NUM="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_SRC/Contents/Info.plist")"
SHORT_VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_SRC/Contents/Info.plist")"
case "$BUILD_NUM" in
  *.*) die "CFBundleVersion is '$BUILD_NUM' — the POST_BUILD stamp did not run, so this build advertises the
   same number as every other pre-release of $VERSION and no user would ever be offered it" ;;
esac
[ "$SHORT_VER" = "$VERSION" ] || die "CFBundleShortVersionString is '$SHORT_VER' but the build is '$VERSION' —
   the update dialog would name the wrong version"
echo "   CFBundleVersion $BUILD_NUM · CFBundleShortVersionString $SHORT_VER"

# BOTH ARCHITECTURES (BUILD-RULES gate 4) — a release that is arm64-only bricks every Intel Mac it reaches.
lipo -info "$APP_SRC/Contents/MacOS/Terminator" | grep -q "x86_64" \
  && lipo -info "$APP_SRC/Contents/MacOS/Terminator" | grep -q "arm64" \
  || die "the app binary is not universal: $(lipo -info "$APP_SRC/Contents/MacOS/Terminator")"

# THE onnxruntime FLOOR (BUILD-RULES): the runtime is dlopen'd, never linked. A link-time dependency would
# raise the app's own floor from macOS 12 to 13.4 — i.e. it would stop launching on older Macs entirely.
! otool -L "$APP_SRC/Contents/MacOS/Terminator" | grep -q onnxruntime \
  || die "the app LINKS onnxruntime — that raises the minimum macOS from 12 to 13.4 (it must be dlopen'd)"

# ── 3. sign, deepest first ──────────────────────────────────────────────────────────────────────────────────
# A staging copy, so a re-run never signs an already-signed tree and the build output stays pristine.
# Clear the ARTEFACTS rather than the directory: `rm -rf release/mac` loses a race with Finder whenever that
# folder is open in a window (Finder rewrites .DS_Store mid-delete and rm reports "Directory not empty"), and
# it would also throw away an appcast generated beside them. What must be pristine is the app copy itself.
mkdir -p "$OUT_DIR"
rm -rf "$OUT_DIR/Terminator.app" "$OUT_DIR/.dmg-stage" "$OUT_DIR/notarize-app.zip"
find "$OUT_DIR" -maxdepth 1 \( -name 'Terminator-*.dmg' -o -name 'Terminator-*.zip' -o -name 'notary-*.log' \) -delete
APP="$OUT_DIR/Terminator.app"
ditto "$APP_SRC" "$APP"

ENTITLEMENTS="${BUILD_DIR}/app/Terminator_artefacts/JuceLibraryCode/Terminator.entitlements"
[ -f "$ENTITLEMENTS" ] || die "no entitlements at $ENTITLEMENTS"
grep -q "disable-library-validation" "$ENTITLEMENTS" \
  || die "the entitlements are missing com.apple.security.cs.disable-library-validation — a hardened process
   refuses to load a VST3/AU signed by another team, so plugin hosting would work unsigned and die signed"

# WHAT MUST BE IN THE BUNDLE. A count would pass on the wrong 109 files; these are the four things whose
# absence turns into a user-visible hole (no YouTube import, no MP3 export, no stems, no updates).
for required in \
  "Contents/Resources/bin/ytdlp" \
  "Contents/Resources/bin/qjs" \
  "Contents/Resources/bin/lame" \
  "Contents/Frameworks/libonnxruntime.1.23.2.dylib"; do
  [ -e "$APP/$required" ] || die "$required is missing from the bundle — this build was made with the tools or
   the stem runtime switched off, and shipping it would quietly remove a feature"
done
UPDATER="no"
if [ -d "$APP/Contents/Frameworks/Sparkle.framework" ]; then
  UPDATER="Sparkle"
  # THE FEED AND THE KEY. Sparkle reads both out of this plist at launch: a blank public key makes it refuse
  # every download it is ever offered, and a wrong feed URL points the whole install base at nothing. Both fail
  # SILENTLY in a shipped app — the user simply never gets another update — so they are asserted here.
  plist="$APP/Contents/Info.plist"
  feed="$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$plist" 2>/dev/null || true)"
  edkey="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$plist" 2>/dev/null || true)"
  case "$feed" in https://*) : ;; *) die "SUFeedURL is '$feed' — an updater feed must be an https URL" ;; esac
  case "$feed" in *terminator-electron*) die "SUFeedURL points at the ELECTRON feed ($feed). The native app has
   its own channel (terminator-native/); writing into the 2.x feed would push this build at 2.x users." ;; esac
  [ ${#edkey} -ge 40 ] || die "SUPublicEDKey is missing or too short — Sparkle would reject every update it is
   offered, and no user would ever be told why"
fi

step "signing the nested code (bundles as units, deepest first)"
# TWO KINDS of nested code, and they are signed differently:
#   * a nested BUNDLE (.framework / .app / .xpc) is signed as ONE unit. Sparkle's framework carries its own
#     Updater.app and two XPC services, and signing the executables inside them file-by-file would leave each
#     bundle's own seal inconsistent — the app would then fail `codesign --verify --deep --strict`, and Sparkle
#     would refuse to launch its updater.
#   * a LOOSE Mach-O (yt-dlp's ~100 dylibs, qjs, lame, onnxruntime) is signed as a file.
# Deepest path first in both cases: a signature covers what is underneath it, so signing a parent before its
# children invalidates the parent.
# `--preserve-metadata=entitlements` keeps whatever entitlements the vendor shipped (Sparkle's XPC services
# have needed them in the past); our own binaries have none, so it is a no-op for them.
# EVERY signature here is timestamped, and a timestamp is a round trip to timestamp.apple.com — 110+ of them,
# back to back. Apple's TSA throttles under exactly that load, and a throttled call fails the whole package run
# on a file that signs perfectly a second later (observed 2026-08-25 on one of yt-dlp's Cryptodome .so files).
# So a FAILURE IS RETRIED, three times with a short backoff, and the real error is printed when it finally
# gives up — the same rule the pinned-tool downloads already follow: a transient timeout is retried, a wrong
# identity is not (codesign fails on a bad identity the same way every attempt, and still stops the build).
sign_one() { # <path> [extra codesign args...]
  local target="$1"; shift
  local attempt out
  for attempt in 1 2 3; do
    if out="$(codesign --force --timestamp --options runtime --preserve-metadata=entitlements \
                       --sign "$IDENTITY" "$@" "$target" 2>&1)"; then
      return 0
    fi
    [ "$attempt" -lt 3 ] && sleep $((attempt * 3))
  done
  printf '   codesign failed 3x on %s\n%s\n' "$target" "$out" >&2
  return 1
}

BUNDLES=()
while IFS= read -r d; do BUNDLES+=("$d"); done < <(
  find "$APP" -mindepth 1 -type d \( -name "*.framework" -o -name "*.app" -o -name "*.xpc" -o -name "*.bundle" \) \
    | awk '{print gsub(/\//,"/") "\t" $0}' | sort -rn | cut -f2-)

# A file is covered by a nested bundle's own signature only when that bundle is an .app / .xpc / .bundle — those
# seal their Contents/MacOS/… themselves. A .framework does NOT: signing `Sparkle.framework/Versions/B` seals
# the loose helper executables in that directory by hash but leaves their EXISTING signature alone, so
# `Versions/B/Autoupdate` shipped carrying the Sparkle project's certificate. Apple rejected the whole app for
# it — "The binary is not signed with a valid Developer ID certificate", twice, once per architecture. Sparkle's
# own documented recipe signs Autoupdate explicitly for exactly this reason.
covered_by_bundle() {
  local f="$1" b
  for b in ${BUNDLES+"${BUNDLES[@]}"}; do
    case "$b" in *.framework) continue ;; esac
    case "$f" in "$b"/*) return 0 ;; esac
  done
  return 1
}

loose=0
while IFS= read -r f; do
  case "$f" in "$APP/Contents/MacOS/Terminator") continue ;; esac
  covered_by_bundle "$f" && continue
  file -b "$f" | grep -q "Mach-O" || continue
  sign_one "$f" || die "codesign failed on $f (see the error above)"
  loose=$((loose + 1))
done < <(find "$APP" -type f | awk '{print gsub(/\//,"/") "\t" $0}' | sort -rn | cut -f2-)

for b in ${BUNDLES+"${BUNDLES[@]}"}; do
  # A VERSIONED framework is signed at its version directory, not at the .framework wrapper (the wrapper is a
  # tree of symlinks into it). Everything else signs at the bundle root.
  target="$b"
  case "$b" in *.framework) [ -d "$b/Versions/B" ] && target="$b/Versions/B"
                            [ -d "$b/Versions/A" ] && target="$b/Versions/A" ;; esac
  sign_one "$target" || die "codesign failed on the nested bundle $target (see the error above)"
done
echo "   ${loose} loose binaries + ${#BUNDLES[@]} nested bundle(s) signed · updater: ${UPDATER}"
[ "$loose" -gt 100 ] || die "only ${loose} loose binaries found — the bundled tools (yt-dlp/qjs/lame) or
   onnxruntime are missing from this build"

step "signing the app"
codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/   /'

# EVERY Mach-O, OURS. `codesign --verify --deep --strict` passes on a bundle whose nested binaries are validly
# signed by SOMEBODY ELSE — which is exactly what shipped: Sparkle's own Autoupdate kept the Sparkle project's
# certificate, `--verify` was happy, and Apple rejected the submission ten minutes later. This asks the question
# Apple asks: our team, and a secure timestamp (an un-timestamped signature stops verifying the day the
# certificate expires). Seconds locally against a round trip to the notary service.
step "checking every binary is ours"
notmine=0
while IFS= read -r f; do
  file -b "$f" | grep -q "Mach-O" || continue
  info="$(codesign -dv --verbose=4 "$f" 2>&1 || true)"
  case "$info" in
    *"TeamIdentifier=$TEAM_ID"*) : ;;
    *) echo "   NOT OURS: $f"; echo "$info" | grep -E "TeamIdentifier|Authority" | head -2 | sed 's/^/      /'
       notmine=$((notmine + 1)); continue ;;
  esac
  case "$info" in
    *"Timestamp="*) : ;;
    *) echo "   NO TIMESTAMP: $f"; notmine=$((notmine + 1)) ;;
  esac
done < <(find "$APP" -type f)
[ "$notmine" -eq 0 ] || die "$notmine binary/binaries are not signed by team $TEAM_ID with a secure timestamp.
   Apple would reject this submission — fix the signing loop, do not upload."
echo "   every Mach-O in the bundle is signed by $TEAM_ID with a timestamp"

# ── 4. notarise the app, staple it ──────────────────────────────────────────────────────────────────────────
ZIP="$OUT_DIR/Terminator-${VERSION}-mac.zip"
notarise() { # <path-to-submit> <what>
  step "notarising $2"
  xcrun notarytool submit "$1" --keychain-profile "$PROFILE" --wait 2>&1 | tee "$OUT_DIR/notary-$2.log" \
    | sed 's/^/   /'
  grep -q "status: Accepted" "$OUT_DIR/notary-$2.log" \
    || die "notarisation of $2 was not Accepted — upload NOTHING. Run:
   xcrun notarytool log <submission-id> --keychain-profile $PROFILE"
}

if [ "$DO_NOTARIZE" = 1 ]; then
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT_DIR/notarize-app.zip"
  notarise "$OUT_DIR/notarize-app.zip" "app"
  rm -f "$OUT_DIR/notarize-app.zip"
  xcrun stapler staple "$APP"
  # A machine that is offline when it first runs the app has no way to ask Apple, so the ticket has to be IN
  # the bundle. `validate` proves it is.
  xcrun stapler validate "$APP" || die "the notarisation ticket did not staple to the app"
fi

# The distributed zip carries the STAPLED bundle — zipping before stapling ships an app that needs the network
# to pass Gatekeeper on first launch.
step "zipping the app"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

# ── 5. the DMG ──────────────────────────────────────────────────────────────────────────────────────────────
step "building the DMG"
DMG="$OUT_DIR/Terminator-${VERSION}.dmg"
STAGE="$OUT_DIR/.dmg-stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Terminator.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Terminator ${VERSION}" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
if [ "$DO_NOTARIZE" = 1 ]; then
  notarise "$DMG" "dmg"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG" || die "the notarisation ticket did not staple to the DMG"
fi

# ── 6. GATEKEEPER, for real ─────────────────────────────────────────────────────────────────────────────────
# `spctl` is the question every user's Mac asks. "accepted / Notarized Developer ID" is the only passing answer.
if [ "$DO_NOTARIZE" = 1 ]; then
  step "Gatekeeper assessment"
  spctl -a -vvv -t install "$APP" 2>&1 | sed 's/^/   /'
  spctl -a -vvv -t install "$APP" 2>&1 | grep -q "source=Notarized Developer ID" \
    || die "Gatekeeper does not see this app as notarised — it would be blocked on every Mac but this one"
fi

# ── 7. DOES IT RUN? (the rule that exists because 1.4.0 shipped and crashed) ────────────────────────────────
# Building successfully proves nothing about whether the app RUNS. This is the SIGNED, STAPLED bundle — the
# exact bytes a user gets — put through the full app probe: engine on a device, the page rendered, the
# sequencers, the mixer, the licence bridge. The cheapest check in the cycle, against a rollback.
step "smoke-testing the packaged app"
# TERMINATOR_PROBE_UPDATER=1 only makes sense HERE: Sparkle refuses to start in an unsigned build, so this is
# the one run that can prove the shipped bundle would actually update. Automatic checks are off in that mode —
# the gate never reaches the network.
TERMINATOR_PROBE_UPDATER=1 tools/ci/probe-app.sh "$APP/Contents/MacOS/Terminator" "$OUT_DIR/probe-packaged.json" \
  || die "the PACKAGED app failed its probe — do not upload it. See $OUT_DIR/probe-packaged.json"

# ── 8. what to feed the updater ─────────────────────────────────────────────────────────────────────────────
step "artefacts"
for f in "$ZIP" "$DMG"; do
  [ -f "$f" ] || continue
  printf '   %s\n      %s bytes\n      sha512 %s\n' \
    "$f" "$(stat -f%z "$f")" "$(openssl dgst -sha512 -binary "$f" | openssl base64 -A)"
done
printf '\n\033[32mPACKAGED OK — %s (%s)\033[0m\n' "$VERSION" "$BUNDLE_ID"
printf 'Nothing has been uploaded. The upload order (binaries first, feed LAST) is in docs/native/RELEASE-CYCLES-NATIVE.md.\n'
