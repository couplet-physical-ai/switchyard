#!/usr/bin/env bash
# Fresh install of the released app on the Mac mini, exactly as the README says, and proof it runs:
#   uninstall + untap → the README one-liner → launch → the bundle is <version> → one window →
#   brew info → optionally connect to live with a token FILE and snapshot the window.
#
#   scripts/release/install-e2e-mini.sh <version> [--keep]
#
# Token: SY_TOKEN_FILE=<local path, mode 600> is copied to the mini as a 600 file (never in argv
# or a URL), handed to the app as SWITCHYARD_TOKEN_FILE, and deleted afterwards. SY_SNAPSHOT=1
# asks the app for SWITCHYARD_SNAPSHOT. With a token, the run fails if the token's value appears
# anywhere under the app's Application Support, Logs or Preferences (it must live only in the
# Keychain). The script only ever quits /Applications' copy (dev builds share the bundle id).
# (Exact's own render; screencapture is blocked over ssh).
# brew on the mini belongs to felipearce; the app runs in mini-user's GUI session.
set -euo pipefail
V=${1:?version}; KEEP=${2:-}
HOST=${SY_MINI:-mini-user@192.0.2.1}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST")
# The token file and the snapshot live under the app user's home: /Volumes/Farm is a removable
# volume, which macOS privacy (TCC) keeps from apps launched this way ("couldn't be opened").
DIR=${SY_E2E_DIR:-/Users/${HOST%@*}/.switchyard-e2e}
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

# The on-screen window lister (scripts/release/windows.swift), built once on the mini.
timeout 300 "${SSH[@]}" "mkdir -p '$DIR' && cat > '$DIR/windows.swift' && { [[ -x '$DIR/sy-windows' && '$DIR/sy-windows' -nt '$DIR/windows.swift' ]] || swiftc -O -o '$DIR/sy-windows' '$DIR/windows.swift' 2>&1 | tail -3; }" < "$(dirname "$0")/windows.swift"

out=$(timeout 1800 "${SSH[@]}" 'f=$(mktemp); cat > "$f"; bash "$f" </dev/null 2>&1; rc=$?; rm -f "$f"; exit $rc' <<EOF
set -euo pipefail
A=/Applications/Switchyard.app
# Quit /Applications' Switchyard (only that path: dev builds share the bundle id): SIGTERM, up to
# 15 s, then SIGKILL — 0.1.2 ignores SIGTERM (it stayed up and a later open(1) re-used it).
quit_() {
  pkill -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' || return 0
  for i in \$(seq 1 15); do sleep 1; pgrep -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' >/dev/null || return 0; done
  echo "WARN: Switchyard ignored SIGTERM for 15 s; SIGKILL" >&2
  pkill -KILL -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' || true; sleep 1
}
W=$DIR/sy-windows
gui() { sudo -n launchctl asuser \$(id -u) sudo -n -u \$(id -un) "\$@"; }
age_() { ps -o etime= -p "\$1" 2>/dev/null | awk -F'[-:]' '{n=NF; s=\$n+60*\$(n-1); if(n>=3)s+=3600*\$(n-2); if(n>=4)s+=86400*\$(n-3); print s}' | grep . || echo 99; }
prompt_() { gui \$W SecurityAgent 2>/dev/null | grep -c '^window' || true; }
deny_() { [[ "\$(prompt_)" == 0 ]] || { sudo -n pkill -9 -x SecurityAgent || true; echo "denied the Keychain prompt (cleanup)"; }; }
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
quit_
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
mkdir -p $DIR/shots ~/Library/Logs/Switchyard; rm -f $DIR/shots/install-$V.png
deny_
# A reinstall keeps the Keychain item an earlier build wrote (\$(security find-generic-password … && echo yes)):
# the window must be up within 5 s of launch, and no Keychain prompt (SY_KC_PROMPT_OK=1 allows one).
had=\$(security find-generic-password -s com.exowatt.switchyard -a switchyard.token >/dev/null 2>&1 && echo "an earlier build's" || echo none)
gui open ${ENV[*]:-} "\$A"
np=""; for i in \$(seq 1 20); do np=\$(pgrep -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' | head -1 || true); [[ -n "\$np" ]] && break; sleep 0.25; done
win=""; while [[ -n "\$np" && \$(age_ \$np) -le 5 ]]; do gui \$W Switchyard >/dev/null 2>&1 && { win=\$(age_ \$np); break; }; sleep 0.25; done
pr=\$(prompt_)
echo "launch: window at \${win:-none} s (≤ 5 required); Keychain item before launch: \$had; prompt: \$([[ \$pr == 0 ]] && echo none || echo SHOWN)"
if [[ "\$pr" != 0 ]]; then deny_; [[ "${SY_KC_PROMPT_OK:-}" == 1 ]] || { quit_; echo "FAIL: Keychain prompt at launch" >&2; exit 1; }; fi
[[ -n "\$win" ]] || { quit_; echo "FAIL: no window within 5 s of launch" >&2; exit 1; }
sleep 20
pid=\$(pgrep -f '/Applications/Switchyard.app/Contents/MacOS/Switchyard' || true)
echo "running: \${pid:-none}"; [[ -n "\$pid" ]]
gui \$W Switchyard | tail -1
echo "--- brew info"; ($B info --cask switchyard 2>&1 | head -2)
echo "--- app log (this launch)"; grep -h "pid \$pid " ~/Library/Logs/Switchyard/*.log 2>/dev/null | grep -v "download: [0-9]*%" | tail -n 12 | cut -c1-240 || true
TOKF="$TOK_REMOTE"
if [[ -n "\$TOKF" ]]; then
  # The token may live in one place only: 0.1.3+ keep it in Application Support/<id>/token (mode
  # 0600, dir 0700; README → Security), 0.1.2 and earlier in the Keychain. Its value (read from the
  # file, never argv) must be nowhere else under the app's files, while it runs and after it quits.
  AS=~/Library/Application\ Support/com.exowatt.switchyard
  leak() { grep -rlF -f "\$TOKF" "\$AS" ~/Library/Logs/Switchyard ~/Library/Preferences/com.exowatt.switchyard.plist 2>/dev/null | grep -vx "\$AS/token" || true; }
  if [[ -e "\$AS/token" ]]; then
    m=\$(stat -f %Lp "\$AS/token"); dm=\$(stat -f %Lp "\$AS")
    echo "token file: mode \$m, dir \$dm"
    [[ "\$m" == 600 && "\$dm" == 700 ]] || { echo "FAIL: token file mode \$m / dir \$dm (want 600 / 700)" >&2; exit 1; }
  fi
  l=\$(leak); [[ -z "\$l" ]] && echo "token at rest (running): none outside the token file" || { echo "FAIL: token found in: \$l" >&2; exit 1; }
  quit_
  l=\$(leak); [[ -z "\$l" ]] && echo "token at rest (after quit): none outside the token file" || { echo "FAIL: token found in: \$l" >&2; exit 1; }
  # The app's own log is written as it quits: the connect line must be there by now.
  grep -h "pid \$pid token-file:" ~/Library/Logs/Switchyard/switchyard.log | tail -1
  grep -q "pid \$pid token-file: connected" ~/Library/Logs/Switchyard/switchyard.log || { echo "FAIL: no 'token-file: connected' for pid \$pid" >&2; exit 1; }
  if [[ "$KEEP" == --keep ]]; then sudo -n launchctl asuser \$(id -u) sudo -n -u \$(id -un) open "\$A"; fi
fi
if [[ -n "${SY_SNAPSHOT:-}" ]]; then
  grep -h "pid \$pid snapshot:" ~/Library/Logs/Switchyard/switchyard.log | tail -1 || true
  [[ -s $DIR/shots/install-$V.png ]] || { echo "FAIL: no snapshot at $DIR/shots/install-$V.png" >&2; exit 1; }
fi
if [[ "$KEEP" != --keep ]]; then quit_; fi
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
