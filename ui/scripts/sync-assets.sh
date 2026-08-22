#!/usr/bin/env bash
# Copy the large optional assets that are NOT committed here from a local checkout of the Electron repo.
# Usage: ui/scripts/sync-assets.sh [path-to-electron-terminator-repo]   (default ~/terminator)
set -euo pipefail
SRC="${1:-$HOME/terminator}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$SRC/public/videos" ] || { echo "no $SRC/public/videos — pass the Electron repo path"; exit 1; }
mkdir -p "$HERE/public/videos"
cp "$SRC"/public/videos/*.mp4 "$HERE/public/videos/"
ls -la "$HERE/public/videos"
