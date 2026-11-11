#!/usr/bin/env bash
# Fresh install of the released app on the Mac mini, exactly as the README says, and proof it runs:
#   uninstall + untap → the README one-liner → launch → the bundle is <version> → one window →
#   brew info → optionally connect to live with a token FILE and snapshot the window.
#
#   scripts/release/install-e2e-mini.sh <version> [--keep]
#
# Token: SY_TOKEN_FILE=<local path, mode 600> is copied to the mini as a 600 file (never in argv
# or a URL), handed to the app as SWITCHYARD_TOKEN_FILE, and deleted afterwards. SY_SNAPSHOT=1
# asks the app for SWITCHYARD_SNAPSHOT (Exact's own render; screencapture is blocked over ssh).
# brew on the mini belongs to felipearce; the app runs in mini-user's GUI session.
set -euo pipefail
V=${1:?version}; KEEP=${2:-}
HOST=${SY_MINI:-mini-user@192.0.2.1}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST")
DIR=/Volumes/Farm/farm-exowatt/switchyard-release
B='cd /tmp && sudo -n -Hu felipearce env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 /opt/homebrew/bin/brew'
# The README's one-liner, with brew run as its owner.
ONE_LINER="($B tap couplet-physical-ai/tap && $B trust couplet-physical-ai/tap && $B install --cask switchyard)"

TOK_REMOTE=""
if [[ -n "${SY_TOKEN_FILE:-}" ]]; then
  [[ "$(stat -c %a "$SY_TOKEN_FILE")" == 600 ]] || { echo "$SY_TOKEN_FILE must be mode 600" >&2; exit 1; }
  TOK_REMOTE=$DIR/secret/token
  tar -C "$(dirname "$SY_TOKEN_FILE")" -cf - "$(basename "$SY_TOKEN_FILE")" \
    | timeout 60 "${SSH[@]}" "umask 077 && mkdir -p '$DIR/secret' && tar -C '$DIR/secret' -xOf - > '$TOK_REMOTE' && chmod 600 '$TOK_REMOTE'"
fi
cleanup() { [[ -z "$TOK_REMOTE" ]] || timeout 60 "${SSH[@]}" "rm -P '$TOK_REMOTE' 2>/dev/null || rm -f '$TOK_REMOTE'; rmdir '$DIR/secret' 2>/dev/null || true"; }
trap cleanup EXIT

ENV=()
[[ -n "$TOK_REMOTE" ]] && ENV+=(--env "SWITCHYARD_TOKEN_FILE=$TOK_REMOTE")
[[ -n "${SY_SNAPSHOT:-}" ]] && ENV+=(--env "SWITCHYARD_SNAPSHOT=$DIR/shots/install-$V.png:12")

out=$(timeout 1800 "${SSH[@]}" 'f=$(mktemp); cat > "$f"; bash "$f" </dev/null 2>&1; rc=$?; rm -f "$f"; exit $rc' <<EOF
set -euo pipefail
A=/Applications/Switchyard.app
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
pkill -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' || true
($B uninstall --cask switchyard >/dev/null 2>&1 || true)
($B untap couplet-physical-ai/tap >/dev/null 2>&1 || true)
rm -rf "\$A" "\$A.old"
\$LSR -dump 2>/dev/null | sed -nE 's/^path: +(.*Switchyard[^/]*\\.app)( \\(0x.*)?\$/\\1/p' | sort -u \\
  | while IFS= read -r p; do \$LSR -u "\$p" 2>/dev/null || true; done
echo "--- one-liner"
$ONE_LINER 2>&1 | tail -4
v=\$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "\$A/Contents/Info.plist")
echo "installed: \$v"; [[ "\$v" == "$V" ]]
xattr -p com.apple.quarantine "\$A" >/dev/null 2>&1 && { echo "FAIL: quarantine flag present" >&2; exit 1; } || echo "quarantine: none"
codesign --verify --deep --strict "\$A" && echo "signature: ok"
\$LSR -f "\$A"
mkdir -p $DIR/shots ~/Library/Logs/Switchyard
sudo -n launchctl asuser \$(id -u) sudo -n -u \$(id -un) open ${ENV[*]:-} "\$A"
sleep 20
pid=\$(pgrep -f '/Applications/Switchyard.app/Contents/MacOS/Switchyard' || true)
echo "running: \${pid:-none}"; [[ -n "\$pid" ]]
[[ -x /tmp/sy-windows ]] && sudo -n launchctl asuser \$(id -u) sudo -n -u \$(id -un) /tmp/sy-windows Switchyard | tail -1
echo "--- brew info"; ($B info --cask switchyard 2>&1 | head -2)
echo "--- app log (this launch)"; grep -h "pid \$pid " ~/Library/Logs/Switchyard/*.log 2>/dev/null | grep -v "download: [0-9]*%" | tail -n 12 | cut -c1-240 || true
ls -la $DIR/shots/install-$V.png 2>/dev/null || true
if [[ "$KEEP" != --keep ]]; then pkill -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' || true; fi
echo E2E-PASS
EOF
) || { echo "$out"; echo "install e2e: FAILED" >&2; exit 1; }
echo "$out"
grep -qx E2E-PASS <<<"$out" || { echo "install e2e: did not reach the end" >&2; exit 1; }
if [[ -n "${SY_SNAPSHOT:-}" ]]; then
  mkdir -p /tmp/sy-shots
  timeout 60 "${SSH[@]}" "cat '$DIR/shots/install-$V.png'" > "/tmp/sy-shots/install-$V.png" 2>/dev/null && echo "snapshot: /tmp/sy-shots/install-$V.png"
fi
echo "install e2e: v$V from the tap OK"
