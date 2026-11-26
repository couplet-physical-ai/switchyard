#!/usr/bin/env bash
# Sign, notarize, staple, zip and dmg dist/Switchyard.app (on a Mac).
#   scripts/release/package-macos.sh 0.1.0           # a release: Developer ID + notarized (fails if not)
#   scripts/release/package-macos.sh 0.1.0 --adhoc   # a local test build: ad hoc, never published
# Writes dist/Switchyard-<v>-arm64.zip (what the cask and the updater install),
# dist/Switchyard-<v>-arm64.dmg (drag to Applications) and dist/SHA256SUMS, all made from the
# stapled app, so SHA256SUMS and latest.json hash what users download.
#
# A release signs with exo-macsign (rcodesign and a Developer ID .p12 file; never a keychain):
# every Mach-O (Switchyard, libexact_canvas_gpu.dylib, libexact_modules.dylib) gets the hardened
# runtime and a secure timestamp, no entitlements; then the app and the dmg are notarized and
# stapled. Its credentials come from EXO_MACSIGN_* or its config directory (packaging/RELEASING.md
# "Signing"). exo-macsign is EXO_MACSIGN, else on PATH, else ~/.local/bin/exo-macsign, and must hash
# to packaging/exo-macsign.sha256 (the pinned release of the tool).
set -euo pipefail
cd "$(dirname "$0")/../.."
V=${1:?version}; shift
ADHOC=0
for a in "$@"; do case "$a" in --adhoc) ADHOC=1 ;; *) echo "unknown $a" >&2; exit 2 ;; esac; done
APP=dist/Switchyard.app
[[ -d "$APP" ]] || { echo "$APP missing: run build-macos.sh first" >&2; exit 1; }
ZIP=dist/Switchyard-$V-arm64.zip DMG=dist/Switchyard-$V-arm64.dmg
rm -f "$ZIP" "$DMG" dist/SHA256SUMS
xattr -cr "$APP"

if [[ $ADHOC == 1 ]]; then
  echo "ad hoc (--adhoc): NOT notarized; Gatekeeper blocks this build on other Macs. Never publish it."
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict --verbose=1 "$APP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  stage=$(mktemp -d)
  ditto "$APP" "$stage/Switchyard.app"
  ln -s /Applications "$stage/Applications"
  hdiutil create -quiet -volname "Switchyard $V" -srcfolder "$stage" -fs HFS+ -format UDZO "$DMG"
  rm -rf "$stage"
else
  export PATH="$PATH:$HOME/.local/bin"
  tool=${EXO_MACSIGN:-$(command -v exo-macsign || true)}
  [[ -n "$tool" && -x "$tool" ]] || { echo "exo-macsign not found (EXO_MACSIGN, PATH, ~/.local/bin): a release must be Developer ID signed" >&2; exit 1; }
  want=$(awk 'NF && $1 !~ /^#/ {print $1; exit}' packaging/exo-macsign.sha256)
  got=$(shasum -a 256 "$tool" | cut -d' ' -f1)
  [[ "$got" == "$want" ]] || { echo "exo-macsign at $tool is sha256 $got; packaging/exo-macsign.sha256 pins $want" >&2; exit 1; }
  echo "signing with $("$tool" --version | head -1) ($tool, sha256 ${got::12}, pinned)"
  # sign (inside out, hardened runtime, timestamp) -> notarize + staple the app -> zip it ->
  # dmg -> sign + notarize + staple the dmg -> unzip and verify as a user's Mac would.
  "$tool" release "$APP" --zip "$ZIP" --dmg "$DMG" --volname "Switchyard $V"
  # Belt and braces, with Apple's own tools: the stapled app, a copy unpacked from the zip, the dmg.
  check=$(mktemp -d)
  ditto -x -k "$ZIP" "$check"
  for app in "$APP" "$check/Switchyard.app"; do
    codesign --verify --deep --strict "$app"
    xcrun stapler validate "$app" >/dev/null
    spctl -a -vv -t exec "$app" 2>&1 | tee "$check/spctl.txt"
    grep -q 'source=Notarized Developer ID' "$check/spctl.txt" || { echo "$app: Gatekeeper does not see a notarized Developer ID app" >&2; exit 1; }
  done
  xcrun stapler validate "$DMG" >/dev/null
  spctl -a -vv -t open --context context:primary-signature "$DMG" 2>&1 | tee "$check/spctl.txt"
  grep -q 'source=Notarized Developer ID' "$check/spctl.txt" || { echo "$DMG: Gatekeeper does not see a notarized Developer ID dmg" >&2; exit 1; }
  rm -rf "$check"
fi
(cd dist && shasum -a 256 "$(basename "$ZIP")" "$(basename "$DMG")" > SHA256SUMS && cat SHA256SUMS)
