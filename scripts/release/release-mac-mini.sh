#!/usr/bin/env bash
# Fallback release path: build + package on the Mac mini instead of GitHub's macOS runner,
# then publish from here with gh. Use when the xcode-27 runner image is unavailable or
# cannot build Exact.
#
#   scripts/release/release-mac-mini.sh 0.1.0 [--mode app|placeholder] [--no-publish]
#
# Env: MINI (default mini-user@192.0.2.1, Tailscale), MINI_DIR (default
# /Volumes/Farm/farm-exowatt/switchyard-release: holds exact/ at the pin plus its own
# CARGO_HOME/RUSTUP_HOME; set up by `bun scripts/exact.mjs setup` there).
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
V=${1:?version}; V=${V#v}; shift
MODE=app PUBLISH=1
while [[ $# -gt 0 ]]; do case "$1" in --mode) MODE=$2; shift 2 ;; --no-publish) PUBLISH=0; shift ;; *) echo "unknown $1" >&2; exit 2 ;; esac; done
MINI=${MINI:-mini-user@192.0.2.1}
MINI_DIR=${MINI_DIR:-/Volumes/Farm/farm-exowatt/switchyard-release}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$MINI")
cd "$(dirname "$0")/../.."
sha=$(git rev-parse HEAD)
pin=$(cat app/exact.pin 2>/dev/null || cat packaging/exact.pin)
src=$MINI_DIR/src-$V
echo "mini: building $V ($MODE) from ${sha::7}, exact ${pin::12}"
timeout 60 "${SSH[@]}" "rm -rf '$src' && mkdir -p '$src'"
git archive --format=tar HEAD | timeout 300 "${SSH[@]}" "tar -C '$src' -xf - && printf '%s' '$sha' > '$src/.sha'"
timeout 7200 "${SSH[@]}" "set -e
  export CARGO_HOME='$MINI_DIR/cargo' RUSTUP_HOME='$MINI_DIR/rustup' XDG_CACHE_HOME='$MINI_DIR/cache'
  export PATH=\"\$CARGO_HOME/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin\" DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer EXACT_FEEDBACK=0
  export EXACT_DIR='$MINI_DIR/exact'
  git -C \"\$EXACT_DIR\" fetch -q origin && git -C \"\$EXACT_DIR\" checkout -q '$pin'
  cd '$src'
  # git archive has no .git: give build-macos.sh a build number
  export SWITCHYARD_BUILD_NUMBER=\$(date +%s)
  scripts/release/build-macos.sh --mode '$MODE' --version '$V'
  scripts/release/package-macos.sh '$V'
  if [ '$MODE' = app ]; then EXACT2=\$EXACT_DIR app/scripts/build.sh test macos; fi"
rm -rf dist && mkdir -p dist
timeout 600 "${SSH[@]}" "tar -C '$src/dist' -cf - Switchyard-$V-arm64.zip Switchyard-$V-arm64.dmg SHA256SUMS" | tar -C dist -xf -
(cd dist && sha256sum -c SHA256SUMS)
# latest.json (the in-app updater's feed) needs Info.plist: pull it from the mini's bundle.
mkdir -p dist/Switchyard.app/Contents
timeout 60 "${SSH[@]}" "cat '$src/dist/Switchyard.app/Contents/Info.plist'" > dist/Switchyard.app/Contents/Info.plist
python3 scripts/release/latest-json.py "$V" "$sha"
[[ $PUBLISH == 1 ]] || { echo "built: $(ls dist)"; exit 0; }
REPO=couplet-physical-ai/switchyard
if gh release view "v$V" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "v$V" -R "$REPO" dist/*.zip dist/*.dmg dist/SHA256SUMS dist/latest.json --clobber
else
  notes=$(mktemp)
  python3 scripts/release/notes.py "$V" "$sha" > "$notes"
  printf '\n_Built on the Mac mini (fallback path), mode %s, commit %s._\n' "$MODE" "${sha::7}" >> "$notes"
  gh release create "v$V" -R "$REPO" dist/*.zip dist/*.dmg dist/SHA256SUMS dist/latest.json --target "$sha" \
    --title "Switchyard $V" --notes-file "$notes"
  rm -f "$notes"
fi
gh workflow run bump-switchyard.yml -R couplet-physical-ai/homebrew-tap -f version="$V"
echo "released v$V: $(gh release view "v$V" -R "$REPO" --json url --jq .url); tap bump dispatched"
