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
# otherwise the <from> release zip is installed directly. SY_SEED_TOKEN=1 seeds a fake token into
# kv/exact.kept before the update and requires <to> to scrub it (and log it) at its first launch.
# SY_TOKEN_FILE=<local 600 file>: the Keychain case. <from> connects with that token first (so the
# token is in the Keychain, written by <from>), then the update: <to>'s window must be on screen
# within 5 s of its launch and no Keychain prompt (a SecurityAgent window) may appear. SY_KC_PROMPT_OK=1
# allows the prompt (a version whose Keychain item cannot be read silently by the next, e.g.
# 0.1.2 → 0.1.3) but still requires the window.
set -euo pipefail
FROM=${1:?from-version}; TO=${2:?to-version}; KEEP=${3:-}
HOST=${SY_MINI:-mini-user@192.0.2.1}
ARG=${SY_UPDATE_ARG:---update-now}
REPO=couplet-physical-ai/switchyard
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST")

FEED=${SY_UPDATE_FEED:-https://github.com/$REPO/releases/latest/download/latest.json}
OPEN_ENV=(); [[ -n "${SY_UPDATE_FEED:-}" ]] && OPEN_ENV=(--env "SWITCHYARD_UPDATE_FEED=$SY_UPDATE_FEED")
# SY_UPDATE_MODE=ui: no --update-now; the app checks at launch and SWITCHYARD_UPDATE_AUTOINSTALL=1
# presses Relaunch through the same UI path a person uses.
if [[ "${SY_UPDATE_MODE:-headless}" == ui ]]; then ARG=""; OPEN_ENV+=(--env SWITCHYARD_UPDATE_AUTOINSTALL=1); fi
feed=$(curl -fsSL --retry 3 "$FEED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
[[ "$feed" == "$TO" ]] || { echo "latest.json names $feed, not $TO" >&2; exit 1; }

DIR=/Users/${HOST%@*}/.switchyard-e2e
TOK_REMOTE=""
if [[ -n "${SY_TOKEN_FILE:-}" ]]; then
  [[ "$(stat -c %a "$SY_TOKEN_FILE")" == 600 ]] || { echo "$SY_TOKEN_FILE must be mode 600" >&2; exit 1; }
  TOK_REMOTE=$DIR/secret/token
  tar -C "$(dirname "$SY_TOKEN_FILE")" -cf - "$(basename "$SY_TOKEN_FILE")" \
    | timeout 60 "${SSH[@]}" "umask 077 && mkdir -p '$DIR/secret' && tar -C '$DIR/secret' -xOf - > '$TOK_REMOTE' && chmod 600 '$TOK_REMOTE'"
fi
cleanup() { [[ -z "$TOK_REMOTE" ]] || timeout 60 "${SSH[@]}" "rm -P '$TOK_REMOTE' 2>/dev/null || rm -f '$TOK_REMOTE'; rmdir '$DIR/secret' 2>/dev/null || true"; }
trap cleanup EXIT
# The on-screen window lister (scripts/release/windows.swift), built once on the mini.
timeout 300 "${SSH[@]}" "mkdir -p '$DIR' && cat > '$DIR/windows.swift' && { [[ -x '$DIR/sy-windows' && '$DIR/sy-windows' -nt '$DIR/windows.swift' ]] || swiftc -O -o '$DIR/sy-windows' '$DIR/windows.swift' 2>&1 | tail -3; }" < "$(dirname "$0")/windows.swift"

# The script goes to a file first: run from stdin, a command that reads stdin (sudo, brew) would
# swallow the rest of it and the run would "pass" having done nothing. PASS must be printed.
out=$(timeout 1800 "${SSH[@]}" 'f=$(mktemp); cat > "$f"; bash "$f" </dev/null 2>&1; rc=$?; rm -f "$f"; exit $rc' <<EOF
set -euo pipefail
A=/Applications/Switchyard.app
# brew runs as the mini's brew owner, from /tmp (a function: an unbalanced '(' inside this
# heredoc-in-\$( ) breaks macOS bash 3.2's parser, which release-lint runs).
brew_() ( cd /tmp && sudo -n -Hu felipearce env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 /opt/homebrew/bin/brew "\$@" )
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
# a Keychain prompt is a SecurityAgent window (any layer); none = no prompt
# a process's age in seconds (macOS ps has etime, not etimes); 99 when it is gone
age_() { ps -o etime= -p "\$1" 2>/dev/null | awk -F'[-:]' '{n=NF; s=\$n+60*\$(n-1); if(n>=3)s+=3600*\$(n-2); if(n>=4)s+=86400*\$(n-3); print s}' | grep . || echo 99; }
prompt_() { gui \$W SecurityAgent 2>/dev/null | grep -c '^window' || true; }
# deny a prompt left on screen (the mini has nobody to answer it)
deny_() { [[ "\$(prompt_)" == 0 ]] || { sudo -n pkill -9 -x SecurityAgent || true; echo "denied the Keychain prompt (cleanup)"; }; }
v() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "\$A/Contents/Info.plist"; }
quit_
# Dev builds registered with LaunchServices (sy-client's targets, old release dirs) would take
# switchyard:// links or be what open(1) finds: unregister every Switchyard.app but /Applications'.
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
\$LSR -dump 2>/dev/null | sed -nE 's/^path: +(.*Switchyard[^/]*\\.app)( \\(0x.*)?\$/\\1/p' | sort -u | { grep -v '^/Applications/' || true; } \\
  | while IFS= read -r p; do \$LSR -u "\$p" 2>/dev/null || true; echo "unregistered \$p"; done
if [[ "${SY_FROM_TAP:-}" != 1 ]]; then
brew_ uninstall --cask switchyard >/dev/null 2>&1 || true
rm -rf "\$A" "\$A.old"
# Install <from> exactly: the cask at that version, from the release's own zip.
tmp=\$(mktemp -d); curl -fsSL --retry 3 -o "\$tmp/s.zip" "https://github.com/$REPO/releases/download/v$FROM/Switchyard-$FROM-arm64.zip"
ditto -x -k "\$tmp/s.zip" /Applications/ && rm -rf "\$tmp"
xattr -dr com.apple.quarantine "\$A" 2>/dev/null || true
fi
echo "installed: \$(v)"; [[ "\$(v)" == "$FROM" ]]
# On a person's Mac the brew user is the one who runs the app. On the mini brew belongs to
# felipearce and the app runs as this user, so a tap-installed bundle is not ours to swap (the
# updater rightly refuses: "needs admin rights"). Give it to the app's user, as on a real Mac.
if [[ "\$(stat -f %Su "\$A")" != "\$(id -un)" ]]; then
  sudo -n chown -R "\$(id -un)" "\$A"; echo "owner: \$(id -un) (was the brew user)"
fi
LOG=~/Library/Logs/Switchyard/switchyard.log; mkdir -p ~/Library/Logs/Switchyard; touch \$LOG
if [[ -n "$TOK_REMOTE" ]]; then
  # <from> writes the token to the Keychain (a fresh item: the one an earlier build made is gone)
  security delete-generic-password -s com.exowatt.switchyard -a switchyard.token >/dev/null 2>&1 || true
  deny_
  L1=\$(wc -l < \$LOG)
  gui open --env SWITCHYARD_TOKEN_FILE=$TOK_REMOTE "\$A"
  for i in \$(seq 1 40); do sleep 1; tail -n +\$((L1+1)) \$LOG | grep -q "token-file: connected" && break; done
  tail -n +\$((L1+1)) \$LOG | grep "token-file:" | tail -1
  tail -n +\$((L1+1)) \$LOG | grep -q "token-file: connected" || { echo "FAIL: $FROM did not connect with the token file" >&2; exit 1; }
  sleep 2; quit_
  security find-generic-password -s com.exowatt.switchyard -a switchyard.token >/dev/null 2>&1 && echo "keychain: token stored by $FROM" || { echo "FAIL: no Keychain item after $FROM connected" >&2; exit 1; }
fi
# SY_SEED_TOKEN=1: a kept answer holding a fake syd_ token, as 0.1.0 and earlier left real ones in
# kv/exact.kept; the updated app must scrub it at its first launch (and log it under its pid).
K="\$HOME/Library/Application Support/com.exowatt.switchyard/kv/exact.kept"
if [[ "${SY_SEED_TOKEN:-}" == 1 ]]; then
  mkdir -p "\$K"
  printf '%s' '{"a":["https://switchyard.example.com","syd_SEEDEDfake0123456789"],"v":{"token":"syd_SEEDEDfake0123456789","has":true}}' > "\$K/e2e-seeded-token"
  echo "seeded: fake syd_ token in exact.kept"
fi
mkdir -p ~/Library/Logs/Switchyard; : > ~/Library/Logs/Switchyard/update.log
L0=\$(wc -l < ~/Library/Logs/Switchyard/switchyard.log 2>/dev/null || echo 0)
\$LSR -f "\$A"
sudo -n launchctl asuser \$(id -u) sudo -n -u \$(id -un) open ${OPEN_ENV[*]:-} "\$A" ${ARG:+--args $ARG}
for i in \$(seq 1 120); do
  sleep 2
  [[ "\$(v)" == "$TO" ]] && pgrep -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' >/dev/null && break
done
if [[ -n "$TOK_REMOTE" ]]; then
  # The Keychain case: <to>'s window within 5 s of its launch, and no prompt.
  np=\$(pgrep -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' | head -1 || true)
  [[ -n "\$np" ]] || { echo "FAIL: $TO is not running" >&2; exit 1; }
  up=\$(age_ \$np); win=""
  while [[ \$(age_ \$np) -le 5 ]]; do
    gui \$W Switchyard >/dev/null 2>&1 && { win=\$(age_ \$np); break; }; sleep 0.25
  done
  [[ -z "\$win" ]] && gui \$W Switchyard >/dev/null 2>&1 && [[ \$up -gt 5 ]] && win="≤\$up (seen late)"
  pr=\$(prompt_)
  echo "keychain case: $TO pid \$np window at \${win:-none} s; Keychain prompt: \$([[ \$pr == 0 ]] && echo none || echo SHOWN)"
  if [[ "\$pr" != 0 ]]; then deny_; [[ "${SY_KC_PROMPT_OK:-}" == 1 ]] || { quit_; echo "FAIL: Keychain prompt after the update" >&2; exit 1; }; fi
  [[ -n "\$win" && "\$win" != ≤* ]] || { quit_; echo "FAIL: no window within 5 s of $TO's launch" >&2; exit 1; }
fi
echo "other Switchyard processes: \$(pgrep -fl 'Switchyard.app/Contents/MacOS/Switchyard' | grep -v '^[0-9]* /Applications/' || echo none)"
echo "after update: \$(v) (running: \$(pgrep -f '^/Applications/Switchyard.app/Contents/MacOS/Switchyard' || echo none))"
echo "--- update.log"; tail -20 ~/Library/Logs/Switchyard/update.log || true
[[ "\$(v)" == "$TO" ]] || { echo "FAIL: bundle is \$(v), expected $TO" >&2; exit 1; }
codesign --verify --deep --strict "\$A" && echo "signature: ok"
if [[ "${SY_SEED_TOKEN:-}" == 1 ]]; then
  # <from> may scrub it already (0.1.1+ do, at launch, before updating); either way one launch of
  # this run must have logged the scrub, and nothing may be left.
  for i in \$(seq 1 15); do tail -n +\$((L0+1)) ~/Library/Logs/Switchyard/switchyard.log | grep -q " scrub:" && break; sleep 2; done
  tail -n +\$((L0+1)) ~/Library/Logs/Switchyard/switchyard.log | grep " scrub:" | tail -2 || { echo "FAIL: no launch of this run logged a scrub" >&2; exit 1; }
  if [[ -e "\$K/e2e-seeded-token" ]] || grep -rqs syd_SEEDED "\$K"; then echo "FAIL: seeded token still in exact.kept" >&2; exit 1; fi
  echo "token at rest after update: none"
fi
sleep 10; [[ ! -e "\$A.old" ]] && echo ".old: swept" || { ls -ld "\$A.old"; echo "FAIL: .old not swept" >&2; exit 1; }
echo "--- brew info"; brew_ info --cask switchyard 2>&1 | head -3 || true
if [[ "$KEEP" != --keep ]]; then quit_; rm -rf "\$A"; fi
echo E2E-PASS
EOF
) || { echo "$out"; echo "update e2e: FAILED" >&2; exit 1; }
echo "$out"
grep -qx E2E-PASS <<<"$out" || { echo "update e2e: did not reach the end" >&2; exit 1; }
echo "update e2e: $FROM → $TO OK"
