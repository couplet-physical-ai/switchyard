#!/usr/bin/env bash
# End-to-end proof of the in-app updater on the Mac mini, from the tap:
#   install <from> with brew → run the app's headless update hook → it relaunches as the newest
#   release → the old bundle (.old) is swept → brew still reports a sane version.
#
#   scripts/release/update-e2e-mini.sh <from-version> <to-version> [--keep]
#
# <to-version> must be the release the feed (latest.json) names: the stable latest feed, or
# SY_UPDATE_FEED=<url> (passed to the app as SWITCHYARD_UPDATE_FEED, e.g. a prerelease's
# …/releases/download/vX/latest.json). The hook is the app's headless trigger: launch argument
# --update-now (check → download → verify → swap → relaunch, no UI; override with SY_UPDATE_ARG).
# Its log is read from ~/Library/Logs/Switchyard/update.log. SY_UPDATE_MODE=ui takes the UI path
# (AUTOINSTALL) instead of the headless hook. --keep leaves the app installed afterwards.
# SY_FROM_TAP=1: <from> is already installed from the tap (brew install before <to> was cut);
# otherwise the <from> release zip is installed directly.
set -euo pipefail
FROM=${1:?from-version}; TO=${2:?to-version}; KEEP=${3:-}
HOST=${SY_MINI:-mini-user@192.0.2.1}
ARG=${SY_UPDATE_ARG:---update-now}
REPO=couplet-physical-ai/switchyard
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST")
BREW='(cd /tmp && sudo -n -Hu felipearce env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 /opt/homebrew/bin/brew'

FEED=${SY_UPDATE_FEED:-https://github.com/$REPO/releases/latest/download/latest.json}
OPEN_ENV=(); [[ -n "${SY_UPDATE_FEED:-}" ]] && OPEN_ENV=(--env "SWITCHYARD_UPDATE_FEED=$SY_UPDATE_FEED")
# SY_UPDATE_MODE=ui: no --update-now; the app checks at launch and SWITCHYARD_UPDATE_AUTOINSTALL=1
# presses Relaunch through the same UI path a person uses.
if [[ "${SY_UPDATE_MODE:-headless}" == ui ]]; then ARG=""; OPEN_ENV+=(--env SWITCHYARD_UPDATE_AUTOINSTALL=1); fi
feed=$(curl -fsSL --retry 3 "$FEED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
[[ "$feed" == "$TO" ]] || { echo "latest.json names $feed, not $TO" >&2; exit 1; }

# The script goes to a file first: run from stdin, a command that reads stdin (sudo, brew) would
# swallow the rest of it and the run would "pass" having done nothing. PASS must be printed.
out=$(timeout 1800 "${SSH[@]}" 'f=$(mktemp); cat > "$f"; bash "$f" </dev/null 2>&1; rc=$?; rm -f "$f"; exit $rc' <<EOF
set -euo pipefail
A=/Applications/Switchyard.app
v() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "\$A/Contents/Info.plist"; }
pkill -f 'Switchyard.app/Contents/MacOS/Switchyard' || true
# Dev builds registered with LaunchServices (sy-client's targets, old release dirs) would take
# switchyard:// links or be what open(1) finds: unregister every Switchyard.app but /Applications'.
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
\$LSR -dump 2>/dev/null | sed -nE 's/^path: +(.*Switchyard[^/]*\\.app)( \\(0x.*)?\$/\\1/p' | sort -u | { grep -v '^/Applications/' || true; } \\
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
sudo -n launchctl asuser \$(id -u) sudo -n -u \$(id -un) open ${OPEN_ENV[*]:-} "\$A" ${ARG:+--args $ARG}
for i in \$(seq 1 120); do
  sleep 2
  [[ "\$(v)" == "$TO" ]] && pgrep -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' >/dev/null && break
done
echo "other Switchyard processes: \$(pgrep -fl 'Switchyard.app/Contents/MacOS/Switchyard' | grep -v '^[0-9]* /Applications/' || echo none)"
echo "after update: \$(v) (running: \$(pgrep -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' || echo none))"
echo "--- update.log"; tail -20 ~/Library/Logs/Switchyard/update.log || true
[[ "\$(v)" == "$TO" ]] || { echo "FAIL: bundle is \$(v), expected $TO" >&2; exit 1; }
codesign --verify --deep --strict "\$A" && echo "signature: ok"
sleep 10; [[ ! -e "\$A.old" ]] && echo ".old: swept" || { ls -ld "\$A.old"; echo "FAIL: .old not swept" >&2; exit 1; }
echo "--- brew info"; $BREW info --cask switchyard 2>&1 | head -3) || true
if [[ "$KEEP" != --keep ]]; then pkill -f 'Switchyard.app/Contents/MacOS/Switchyard' || true; rm -rf "\$A"; fi
echo E2E-PASS
EOF
) || { echo "$out"; echo "update e2e: FAILED" >&2; exit 1; }
echo "$out"
grep -qx E2E-PASS <<<"$out" || { echo "update e2e: did not reach the end" >&2; exit 1; }
echo "update e2e: $FROM → $TO OK"
