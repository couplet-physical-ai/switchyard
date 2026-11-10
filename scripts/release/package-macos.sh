#!/usr/bin/env bash
# Sign (ad hoc: no Developer ID exists), zip and dmg dist/Switchyard.app.
#   scripts/release/package-macos.sh 0.1.0
# Writes dist/Switchyard-<v>-arm64.zip (what the cask installs), dist/Switchyard-<v>-arm64.dmg
# (a drag-to-Applications image for manual installs) and dist/SHA256SUMS.
set -euo pipefail
cd "$(dirname "$0")/../.."
V=${1:?version}
APP=dist/Switchyard.app
[[ -d "$APP" ]] || { echo "$APP missing: run build-macos.sh first" >&2; exit 1; }
xattr -cr "$APP"
# Keep a valid signature the build made (Exact signs its own bundle, entitlements included);
# otherwise sign ad hoc, preserving whatever entitlements are present.
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "keeping the build's signature: $(codesign -dv "$APP" 2>&1 | grep -E '^Signature|^TeamIdentifier' | tr '\n' ' ')"
else
  codesign --force --deep --sign - --preserve-metadata=entitlements,requirements,flags "$APP"
fi
codesign --verify --deep --strict --verbose=1 "$APP"
ZIP=dist/Switchyard-$V-arm64.zip DMG=dist/Switchyard-$V-arm64.dmg
rm -f "$ZIP" "$DMG"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
stage=$(mktemp -d)
ditto "$APP" "$stage/Switchyard.app"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -volname "Switchyard $V" -srcfolder "$stage" -fs HFS+ -format UDZO "$DMG"
rm -rf "$stage"
(cd dist && shasum -a 256 "$(basename "$ZIP")" "$(basename "$DMG")" > SHA256SUMS && cat SHA256SUMS)
