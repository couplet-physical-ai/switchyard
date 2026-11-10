#!/usr/bin/env bash
# Build Switchyard.app for macOS (arm64) into dist/.
#
#   scripts/release/build-macos.sh --version 0.1.0 [--mode app|placeholder|exact-probe]
#
# Modes:
#   app          the real client: app/ built with Exact (needs EXACT_DIR = a checkout of
#                expo/exact at the pinned commit, `bun scripts/exact.mjs setup` done there).
#   placeholder  a tiny AppKit window (packaging/placeholder) to prove the release path
#                (GitHub release -> Homebrew cask -> install -> launch) without Exact.
#   exact-probe  builds Exact's own Caltrain example from EXACT_DIR: proves the toolchain
#                on this machine (GitHub's macOS image or the Mac mini) and times it.
# Runs on GitHub Actions (release.yml) and on the Mac mini (release-mac-mini.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
MODE=app VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE=$2; shift 2 ;;
    --version) VERSION=$2; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ -n "$VERSION" ]] || { echo "--version is required" >&2; exit 2; }
BUNDLE_ID=${SWITCHYARD_BUNDLE_ID:-com.exowatt.switchyard}
BUILD=${SWITCHYARD_BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo 1)}
OUT=$ROOT/dist
rm -rf "$OUT/Switchyard.app" && mkdir -p "$OUT"
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
start=$(date +%s)

case "$MODE" in
placeholder)
  app=$OUT/Switchyard.app
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  xcrun --sdk macosx swiftc -O -target arm64-apple-macos14.0 \
    packaging/placeholder/main.swift -o "$app/Contents/MacOS/Switchyard"
  sed -e "s/@VERSION@/$VERSION/" -e "s/@BUILD@/$BUILD/" -e "s/@BUNDLE_ID@/$BUNDLE_ID/" \
    packaging/placeholder/Info.plist.in > "$app/Contents/Info.plist"
  ;;
exact-probe)
  : "${EXACT_DIR:?set EXACT_DIR to the expo/exact checkout}"
  stamp=$(mktemp); sleep 1
  (cd "$EXACT_DIR" && bun host/apple/build.mjs --bundle)
  built=$(find "$EXACT_DIR/target" -maxdepth 6 -name '*.app' -type d -newer "$stamp" 2>/dev/null | head -1); rm -f "$stamp"
  [[ -n "$built" ]] || { echo "exact-probe: no .app produced under $EXACT_DIR/target" >&2; exit 1; }
  ditto "$built" "$OUT/Switchyard.app"
  ;;
app)
  : "${EXACT_DIR:?set EXACT_DIR to the expo/exact checkout}"
  [[ -f app/app.contract ]] || { echo "app/ does not exist yet; use --mode placeholder" >&2; exit 1; }
  export EXACT2="$EXACT_DIR"   # app/exact.mjs finds the exact checkout through EXACT2
  stamp=$(mktemp); sleep 1
  # The client's own release command (owned by app/) wins: it prints the built .app path last.
  if [[ -x app/scripts/build-macos-release.sh ]]; then
    built=$(SWITCHYARD_VERSION="$VERSION" app/scripts/build-macos-release.sh | tail -1)
  else
    (cd app && bun exact.mjs mac --bundle ${SWITCHYARD_MAC_FLAGS:-})
    built=$(find app "$EXACT_DIR/target" -maxdepth 8 -type d -name 'Switchyard.app' -newer "$stamp" 2>/dev/null | head -1)
    [[ -n "$built" ]] || built=$(find app "$EXACT_DIR/target" -maxdepth 8 -type d -name '*.app' -newer "$stamp" 2>/dev/null | head -1)
  fi
  rm -f "$stamp"
  [[ -n "$built" && -d "$built" ]] || { echo "app: no .app produced" >&2; exit 1; }
  echo "app bundle: $built"
  ditto "$built" "$OUT/Switchyard.app"
  ;;
*) echo "unknown mode $MODE" >&2; exit 2 ;;
esac

lipo -archs "$OUT/Switchyard.app/Contents/MacOS/"* 2>/dev/null | head -3 || true
echo "built $OUT/Switchyard.app ($MODE, $VERSION) in $(( $(date +%s) - start ))s"
