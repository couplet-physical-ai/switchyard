#!/usr/bin/env bash
# End-to-end proof of the in-app updater on the Mac mini, from the tap:
#   install <from> with brew → run the app's headless update hook → it relaunches as the newest
#   release → the old bundle (.old) is swept → brew still reports a sane version.
#
#   scripts/release/update-e2e-mini.sh <from-version> <to-version> [--keep]
#
# <to-version> must be the release the feed (latest.json) names. The hook is the app's headless
# trigger (launch argument, default --update-now; override with SY_UPDATE_ARG). Its log is read
# from ~/Library/Logs/Switchyard/update.log. --keep leaves the app installed afterwards.
# SY_FROM_TAP=1: <from> is already installed from the tap (brew install before <to> was cut);
# otherwise the <from> release zip is installed directly.
set -euo pipefail
FROM=${1:?from-version}; TO=${2:?to-version}; KEEP=${3:-}
HOST=${SY_MINI:-mini-user@192.0.2.1}
ARG=${SY_UPDATE_ARG:---update-now}
REPO=couplet-physical-ai/switchyard
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST")
BREW='(cd /tmp && sudo -n -Hu felipearce env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 /opt/homebrew/bin/brew'

feed=$(curl -fsSL --retry 3 "https://github.com/$REPO/releases/latest/download/latest.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
[[ "$feed" == "$TO" ]] || { echo "latest.json names $feed, not $TO" >&2; exit 1; }

timeout 1800 "${SSH[@]}" "bash -s" <<EOF
set -euo pipefail
A=/Applications/Switchyard.app
v() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "\$A/Contents/Info.plist"; }
pkill -f 'Switchyard.app/Contents/MacOS/Switchyard' || true
# Dev builds registered with LaunchServices (sy-client's targets, old release dirs) would take
# switchyard:// links or be what `open` finds: unregister every Switchyard.app but /Applications'.
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
\$LSR -dump 2>/dev/null | sed -nE 's/^path: +(.*Switchyard[^/]*\\.app)( \\(0x.*)?\$/\\1/p' | sort -u | grep -v '^/Applications/' \\
  | while IFS= read -r p; do \$LSR -u "\$p" 2>/dev/null || true; echo "unregistered \$p"; done
if [[ "${SY_FROM_TAP:-}" != 1 ]]; then
$BREW uninstall --cask switchyard >/dev/null 2>&1 || true)
rm -rf "\$A" "\$A.old"
# Install <from> exactly: the cask at that version, from the release's own zip.
tmp=\$(mktemp -d); curl -fsSL --retry 3 -o "\$tmp/s.zip" "https://github.com/$REPO/releases/download/v$FROM/Switchyard-$FROM-arm64.zip"
ditto -x -k "\$tmp/s.zip" /Applications/ && rm -rf "\$tmp"
xattr -dr com.apple.quarantine "\$A" 2>/dev/null || true
fi
echo "installed: \$(v)"; [[ "\$(v)" == "$FROM" ]]
mkdir -p ~/Library/Logs/Switchyard; : > ~/Library/Logs/Switchyard/update.log
\$LSR -f "\$A"
launchctl asuser \$(id -u) open "\$A" --args $ARG
for i in \$(seq 1 120); do
  sleep 2
  [[ "\$(v)" == "$TO" ]] && pgrep -f 'Switchyard.app/Contents/MacOS/Switchyard' >/dev/null && break
done
echo "after update: \$(v) (running: \$(pgrep -f 'Switchyard.app/Contents/MacOS/Switchyard' || echo none))"
echo "--- update.log"; tail -20 ~/Library/Logs/Switchyard/update.log || true
[[ "\$(v)" == "$TO" ]] || { echo "FAIL: bundle is \$(v), expected $TO" >&2; exit 1; }
codesign --verify --deep --strict "\$A" && echo "signature: ok"
sleep 10; [[ ! -e "\$A.old" ]] && echo ".old: swept" || { ls -ld "\$A.old"; echo "FAIL: .old not swept" >&2; exit 1; }
echo "brew: \$($BREW info --cask switchyard 2>&1 | head -1))"
if [[ "$KEEP" != --keep ]]; then pkill -f 'Switchyard.app/Contents/MacOS/Switchyard' || true; rm -rf "\$A"; fi
EOF
echo "update e2e: $FROM → $TO OK"
