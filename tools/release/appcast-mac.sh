#!/usr/bin/env bash
# THE MAC APPCAST — turn the packaged zip into the feed every installed copy polls.
#
# Run it AFTER tools/release/package-mac.sh. It writes release/mac/appcast-mac.xml and uploads NOTHING: the
# upload order (binaries FIRST, appcast LAST) is in docs/native/RELEASE-CYCLES-NATIVE.md and is done by hand.
#
#   tools/release/appcast-mac.sh
#
# The EdDSA signature is made by Sparkle's own generate_appcast against the private key in this Mac's login
# keychain. That key is the one irreplaceable thing in the whole release: lose it and no installed copy of 3.0
# can ever be updated again.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="release/mac"
SRC_DIR="$OUT_DIR/appcast-src"
APPCAST="appcast-mac.xml"
BASE_URL="https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev/terminator-native"
SPARKLE_BIN="$(ls -d third_party/.sparkle-cache/Sparkle-*/bin 2>/dev/null | tail -1 || true)"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$SPARKLE_BIN" ] || die "Sparkle is not provisioned — configure a macOS app build first (cmake/Sparkle.cmake)"
APP="$OUT_DIR/Terminator.app"
[ -d "$APP" ] || die "no packaged app at $APP — run tools/release/package-mac.sh first"

# The version the FEED will advertise comes out of the packaged bundle, never out of a variable: what users
# compare against is the CFBundleVersion in the app they already have.
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
HUMAN="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
ZIP="$(ls "$OUT_DIR"/Terminator-*-mac.zip 2>/dev/null | tail -1 || true)"
[ -f "$ZIP" ] || die "no packaged zip in $OUT_DIR — run tools/release/package-mac.sh first"
step "appcast for $HUMAN (CFBundleVersion $BUILD) from $(basename "$ZIP")"

# NEVER REGRESS A LIVE FEED. Publishing a build number the live feed has already passed is how an install base
# gets stranded: Sparkle only ever moves users FORWARD, so a lower number reaches nobody and a repeated one
# reaches nobody either. Checked against the feed itself, not against memory.
step "what is live right now"
LIVE_XML="$OUT_DIR/.live-appcast.xml"
if curl -fsS "$BASE_URL/$APPCAST" -o "$LIVE_XML" 2>/dev/null; then
  LIVE="$(sed -n 's/.*<sparkle:version>\([0-9]*\)<\/sparkle:version>.*/\1/p' "$LIVE_XML" | sort -n | tail -1)"
  echo "   live feed advertises build ${LIVE:-none}"
  if [ -n "${LIVE:-}" ] && [ "$BUILD" -le "$LIVE" ]; then
    die "this build is $BUILD and the live feed is already on $LIVE. Bump TERMINATOR_VERSION_STRING and
   re-package — a version that is not strictly higher reaches nobody."
  fi
  # Re-use the live feed so older items keep their entries rather than being silently dropped.
  mkdir -p "$SRC_DIR"; cp "$LIVE_XML" "$SRC_DIR/$APPCAST"
else
  echo "   nothing published yet at $BASE_URL/$APPCAST — this will be the first item"
  rm -rf "$SRC_DIR"
fi
rm -f "$LIVE_XML"

# ONLY the zip goes in. A DMG in the same folder would give Sparkle a second enclosure for the same version;
# the DMG is the HUMAN download from the website, the zip is what the updater swaps in.
mkdir -p "$SRC_DIR"
cp "$ZIP" "$SRC_DIR/"

step "signing + generating"
"$SPARKLE_BIN/generate_appcast" --download-url-prefix "$BASE_URL/" -o "$SRC_DIR/$APPCAST" "$SRC_DIR"
cp "$SRC_DIR/$APPCAST" "$OUT_DIR/$APPCAST"

# ── what the feed must actually say ─────────────────────────────────────────────────────────────────────────
step "checking the feed"
xml="$OUT_DIR/$APPCAST"
grep -q "<sparkle:version>$BUILD</sparkle:version>" "$xml" \
  || die "the appcast does not advertise build $BUILD — Sparkle compares CFBundleVersion, and this feed would
   offer nobody this release"
grep -q "<sparkle:shortVersionString>$HUMAN</sparkle:shortVersionString>" "$xml" \
  || die "the appcast does not carry the human version $HUMAN (that is what the update dialog shows)"
grep -q 'sparkle:edSignature="' "$xml" \
  || die "the appcast has NO EdDSA signature — every client would refuse the download, and none would say why"
grep -q "url=\"$BASE_URL/$(basename "$ZIP")\"" "$xml" \
  || die "the enclosure URL is not $BASE_URL/$(basename "$ZIP") — check --download-url-prefix"
case "$(grep -o 'url="[^"]*"' "$xml" | head -1)" in
  *terminator-electron*) die "the enclosure points into the ELECTRON channel — that feed belongs to 2.x" ;;
esac
MIN_OS="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist" 2>/dev/null || true)"
[ -n "$MIN_OS" ] || die "the bundle has no LSMinimumSystemVersion — Sparkle then GUESSES one (it guessed 10.13),
   and every Mac too old to run this build would be offered a download it cannot launch"
grep -q "<sparkle:minimumSystemVersion>$MIN_OS</sparkle:minimumSystemVersion>" "$xml" \
  || die "the appcast's minimumSystemVersion is not $MIN_OS — Sparkle would offer this to Macs that cannot run it"
python3 -c "import sys,xml.etree.ElementTree as E; E.parse(sys.argv[1])" "$xml" \
  || die "the generated appcast is not well-formed XML"

step "$xml"
sed 's/^/   /' "$xml"
printf '\n\033[32mAPPCAST OK — build %s (%s)\033[0m\n' "$BUILD" "$HUMAN"
printf 'Nothing uploaded. Binaries FIRST, verify 200 + byte size, appcast LAST — docs/native/RELEASE-CYCLES-NATIVE.md.\n'
