#!/usr/bin/env bash
# The release path: build, sign (Developer ID), notarize and staple on the release Mac, then
# publish from here with gh and move the tap. scripts/release.sh wraps it (tag, gate, promote).
#
#   scripts/release/release-mac-mini.sh 0.1.0 [--mode app|placeholder] [--prerelease] [--no-publish]
#
# Env:
#   MINI       user@host of the release Mac (default SY_MINI; no built-in host)
#   MINI_DIR   its working directory (default /Volumes/Farm/farm-exowatt/switchyard-release: one
#              Exact checkout exact/ at the pin with its own CARGO_HOME/RUSTUP_HOME, set up by
#              `bun scripts/exact.mjs setup` there; one working tree src/ whose app/target is kept)
#   MINI_LOCK  optional lock file on the release Mac: the Exact setup, the build and the macOS
#              tests run under `nice -n 10 lockf -t 10800 $MINI_LOCK`, so they queue behind other
#              builds sharing that Mac (notarization waits do not hold it)
#   MINI_RUSTUP_HOME, MINI_CACHE
#              RUSTUP_HOME and XDG_CACHE_HOME on the release Mac (default $MINI_DIR/rustup and
#              $MINI_DIR/cache); point them at the account's own (~/.rustup, ~/.cache) to reuse
#              its toolchains and Exact's module caches
#   MINI_MIN_FREE_GB  refuse to start with less free on $MINI_DIR's volume (default 20)
#   REF        the commit to release (default HEAD)
#   SWITCHYARD_DEFAULT_SERVER, SWITCHYARD_ORGS
#              site configuration baked into the app (an app release refuses to build without
#              the server); kept with the private deployment, never in this repository
# The release Mac signs with exo-macsign and the Developer ID credentials in its config directory
# (packaging/RELEASING.md "Signing"); package-macos.sh fails the release if signing or
# notarization fails.
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
V=${1:?version}; V=${V#v}; shift
MODE=app PUBLISH=1 PRE=0
while [[ $# -gt 0 ]]; do case "$1" in
  --mode) MODE=$2; shift 2 ;;
  --prerelease) PRE=1; shift ;;
  --no-publish) PUBLISH=0; shift ;;
  *) echo "unknown $1" >&2; exit 2 ;;
esac; done
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || { echo "bad version $V" >&2; exit 2; }
[[ "$V" == 0.0.* || "$V" == *-* ]] && PRE=1   # test builds never become Latest
MINI=${MINI:-${SY_MINI:?set MINI or SY_MINI=user@host of the release Mac (packaging/RELEASING.md)}}
MINI_DIR=${MINI_DIR:-/Volumes/Farm/farm-exowatt/switchyard-release}
MINI_LOCK=${MINI_LOCK:-}
if [[ "$MODE" == app ]]; then
  [[ -n "${SWITCHYARD_DEFAULT_SERVER:-}" ]] || { echo "SWITCHYARD_DEFAULT_SERVER is unset: the app would ship without its server (packaging/RELEASING.md)" >&2; exit 1; }
  [[ -n "${SWITCHYARD_ORGS:-}" ]] || echo "warning: SWITCHYARD_ORGS is unset: the app shows the demo fleet's org order" >&2
fi
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=60 "$MINI")
cd "$(dirname "$0")/../.."
sha=$(git rev-parse "${REF:-HEAD}^{commit}")
pin=$(git show "$sha:app/exact.pin" 2>/dev/null || git show "$sha:packaging/exact.pin")
pin=$(printf '%s' "$pin" | tr -d '[:space:]')
src=$MINI_DIR/src   # one working tree; app/target survives between releases (warm builds)
echo "mini: building $V ($MODE) from ${sha::7}, exact ${pin::12}"
# The volume is shared with other builds: refuse to start under MINI_MIN_FREE_GB free.
min_gb=${MINI_MIN_FREE_GB:-20}
free_kb=$(timeout 30 "${SSH[@]}" "mkdir -p '$MINI_DIR' && df -k '$MINI_DIR' | awk 'NR==2 {print \$4}'")
if [[ -z "$free_kb" || "$free_kb" -lt $((min_gb * 1024 * 1024)) ]]; then
  echo "mini: $MINI_DIR has $(( ${free_kb:-0} / 1024 / 1024 )) GB free (< $min_gb GB): not starting a build; free space first" >&2
  exit 3
fi
# Replace the sources, keep app/target (and nothing else) from the previous release.
timeout 300 "${SSH[@]}" "mkdir -p '$src' && find '$src' -mindepth 1 -maxdepth 1 ! -name app -exec rm -rf {} + && { [ ! -d '$src/app' ] || find '$src/app' -mindepth 1 -maxdepth 1 ! -name target -exec rm -rf {} +; }"
git archive --format=tar "$sha" | timeout 300 "${SSH[@]}" "tar -C '$src' -xf - && printf '%s' '$sha' > '$src/.sha'"
q() { printf '%q' "$1"; }
lock=""; [[ -z "$MINI_LOCK" ]] || lock="nice -n 10 /usr/bin/lockf -t 10800 $(q "$MINI_LOCK")"
timeout 10800 "${SSH[@]}" "set -e
  export CARGO_HOME='$MINI_DIR/cargo' RUSTUP_HOME=$(q "${MINI_RUSTUP_HOME:-$MINI_DIR/rustup}") XDG_CACHE_HOME=$(q "${MINI_CACHE:-$MINI_DIR/cache}") CARGO_BUILD_JOBS=\${CARGO_BUILD_JOBS:-6}
  export PATH=\"\$CARGO_HOME/bin:\$HOME/.cargo/bin:\$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin\" DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer EXACT_FEEDBACK=0
  export EXACT_DIR='$MINI_DIR/exact'
  export SWITCHYARD_DEFAULT_SERVER=$(q "${SWITCHYARD_DEFAULT_SERVER:-}") SWITCHYARD_ORGS=$(q "${SWITCHYARD_ORGS:-}")
  [ -d \"\$EXACT_DIR/.git\" ] || git clone -q --filter=blob:none https://github.com/expo/exact.git \"\$EXACT_DIR\"
  if [ \"\$(git -C \"\$EXACT_DIR\" rev-parse HEAD)\" != '$pin' ]; then git -C \"\$EXACT_DIR\" fetch -q origin && git -C \"\$EXACT_DIR\" checkout -q -f '$pin'; fi
  cd '$src'
  if [ -x app/scripts/patch-exact.sh ]; then app/scripts/patch-exact.sh \"\$EXACT_DIR\"; fi
  if [ ! -f \"\$EXACT_DIR/.switchyard-setup-$pin\" ]; then (cd \"\$EXACT_DIR\" && $lock sh -c 'bun install --frozen-lockfile && bun scripts/exact.mjs setup') && touch \"\$EXACT_DIR/.switchyard-setup-$pin\"; fi
  $lock scripts/release/build-macos.sh --mode '$MODE' --version '$V'
  scripts/release/package-macos.sh '$V'
  # Smoke: the shipped zip, unpacked, must still be running after 5 s.
  d=\$(mktemp -d); ditto -x -k 'dist/Switchyard-$V-arm64.zip' \"\$d\"
  exe=\$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' \"\$d/Switchyard.app/Contents/Info.plist\")
  \"\$d/Switchyard.app/Contents/MacOS/\$exe\" > \"\$d/out.log\" 2>&1 & pid=\$!
  sleep 5
  if kill -0 \$pid 2>/dev/null; then echo 'smoke: running after 5 s'; kill \$pid; wait \$pid 2>/dev/null || true; rm -rf \"\$d\"
  else echo 'smoke: exited early:'; cat \"\$d/out.log\"; exit 1; fi
  if [ '$MODE' = app ]; then $lock env EXACT2=\"\$EXACT_DIR\" app/scripts/build.sh test macos; fi"
rm -rf dist && mkdir -p dist
timeout 600 "${SSH[@]}" "tar -C '$src/dist' -cf - Switchyard-$V-arm64.zip Switchyard-$V-arm64.dmg SHA256SUMS" | tar -C dist -xf -
(cd dist && shasum -a 256 -c SHA256SUMS)
# latest.json (the in-app updater's feed) hashes the stapled zip (SHA256SUMS) and checks the
# shipped Info.plist: pull it from the mini's bundle.
mkdir -p dist/Switchyard.app/Contents
timeout 60 "${SSH[@]}" "cat '$src/dist/Switchyard.app/Contents/Info.plist'" > dist/Switchyard.app/Contents/Info.plist
python3 scripts/release/latest-json.py "$V" "$sha"
if [[ "$(uname -s)" == Darwin ]]; then
  # What came over is what Gatekeeper takes: a notarized Developer ID app (stapled) and dmg.
  chk=$(mktemp -d); ditto -x -k "dist/Switchyard-$V-arm64.zip" "$chk"
  spctl -a -vv -t exec "$chk/Switchyard.app" 2>&1 | tee "$chk/out" && grep -q 'source=Notarized Developer ID' "$chk/out"
  xcrun stapler validate "$chk/Switchyard.app" && xcrun stapler validate "dist/Switchyard-$V-arm64.dmg"
  rm -rf "$chk"
fi
[[ $PUBLISH == 1 ]] || { echo "built: $(ls dist)"; exit 0; }
REPO=couplet-physical-ai/switchyard
pre=(); [[ $PRE == 1 ]] && pre=(--prerelease)
if gh release view "v$V" -R "$REPO" >/dev/null 2>&1; then
  gh release upload "v$V" -R "$REPO" dist/*.zip dist/*.dmg dist/SHA256SUMS dist/latest.json --clobber
else
  notes=$(mktemp)
  python3 scripts/release/notes.py "$V" "$sha" > "$notes"
  printf '\n_Built on the release Mac, Developer ID signed, notarized and stapled; mode %s, commit %s._\n' "$MODE" "${sha::7}" >> "$notes"
  gh release create "v$V" -R "$REPO" dist/*.zip dist/*.dmg dist/SHA256SUMS dist/latest.json --target "$sha" \
    --title "Switchyard $V" --notes-file "$notes" ${pre[@]+"${pre[@]}"}
  rm -f "$notes"
fi
echo "released v$V: $(gh release view "v$V" -R "$REPO" --json url --jq .url)"
if [[ $PRE == 1 ]]; then
  echo "v$V is a prerelease: not Latest, the tap is left alone (scripts/release.sh $V --promote moves both)"
else
  scripts/release/bump-tap.sh "$V"
fi
