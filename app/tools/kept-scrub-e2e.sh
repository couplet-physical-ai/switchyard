#!/bin/bash
# The kept-answer scrub, end to end on a Mac (README "Test hooks"): the native unit tests, then a
# real launch. Drive 1 makes a scratch store; a kept answer holding a fake syd_ token is seeded
# into its kv/exact.kept; drive 2 launches the app on that store and the entry must be gone (a
# clean one stays). Then the token at rest (fx-kc, README "Security"): drive 3 saves a token in
# Settings; it must be in exactly one file, the module's token file (0600, its folder 0700), and
# nowhere else in the store (kv/exact.kept, exact.state) or the logs; drive 4 relaunches on the
# same store and the token is read back. (Under the agent the file is the drive's scratch tree's
# and no Keychain is touched.) Drives 5-6, under a test app id only, repeat it on the platform's
# stores (EXACT_STORE=real: the real ~/Library/Application Support/<id>/token, kv/exact.kept, the
# prefs domain), then sign out (Forget token: the file goes, `migrated` stays).
# Exits 1 on a failure. Run from app/ on the Mac: sh tools/kept-scrub-e2e.sh
# This app/, found before the env is sourced (switchyard-env.sh cds into the shared checkout).
HERE=$(cd "$(dirname "$0")/.." && pwd)
[ -f "${SY_ENV:-/Volumes/Farm/farm-exowatt/switchyard-env.sh}" ] && . "${SY_ENV:-/Volumes/Farm/farm-exowatt/switchyard-env.sh}"
cd "${APP_DIR:-$HERE}" || exit 1
echo "== in $(pwd)"
echo "== native"; timeout 600 sh tools/updater-tests.sh 2>&1 | grep -i "scrub\|passed\|FAIL" | tail -14
timeout 900 bun exact.mjs mac > /tmp/sy-scrub-build.log 2>&1 || { echo BUILD FAILED; tail -5 /tmp/sy-scrub-build.log; exit 1; }
echo "== e2e: drive 1 makes the store"
timeout 300 bun exact.mjs agent macos --storage sy-scrub --reset-storage --size 1440x900 "clock data" "clock +1500 real" > /tmp/sy-scrub1.log 2>&1
APPID=${APPID:-$(sed -n 's/.*"id": "\([^"]*\)".*/\1/p' app.json | head -1)}
K=$HOME/Library/Caches/exact/$APPID/agent/sy-scrub/kv/exact.kept
ls -d "$K" || exit 1
printf '%s' '{"a":["https://switchyard.example.com","syd_SEEDEDfake0123456789"],"v":{"token":"syd_SEEDEDfake0123456789","has":true}}' > "$K/seeded1"
printf '%s' '{"a":["https://x"],"v":{"ok":true}}' > "$K/seededclean"
ls "$K" | tr '\n' ' '; echo
echo "== e2e: drive 2 launches the app on that store (no reset)"
timeout 300 bun exact.mjs agent macos --storage sy-scrub --size 1440x900 "clock data" "clock +3000 real" "logs" > /tmp/sy-scrub2.log 2>&1
grep -i "scrub" /tmp/sy-scrub2.log | head -3
if [ -e "$K/seeded1" ]; then echo "FAIL: seeded token entry still there"; exit 1; else echo "OK: seeded token entry gone"; fi
if [ -e "$K/seededclean" ]; then echo "OK: clean entry kept"; else echo "NOTE: clean entry gone (runner forgot it)"; fi
grep -rl "syd_SEEDEDfake" "$K" 2>/dev/null | head -2
echo "== e2e: drive 3 saves a token (the token at rest)"
T=syd_E2Erest$(date +%s)Q7x
timeout 300 bun exact.mjs agent macos --storage sy-scrub --size 1440x900 "clock data" "tap open-settings" "clock settle" "type server-field demo" "type token-field $T" "tap settings-save" "clock data" "clock settle" "clock +1500 real" "state tok" "logs" > /tmp/sy-scrub3.log 2>&1
R=$HOME/Library/Caches/exact/$APPID/agent/sy-scrub
fail=0
grep -q 'status "ready"' /tmp/sy-scrub3.log || { echo "FAIL: drive 3 did not save the token"; fail=1; }
held=$(grep -rl "$T" "$R" 2>/dev/null)
echo "files holding the token: $(echo "$held" | sed "s|$R/||" | tr '\n' ' ')"
if [ "$(echo "$held" | grep -c .)" != 1 ] || [ "$(basename "$held")" != token ]; then echo "FAIL: the token is not in exactly one file, the token file"; fail=1; else echo "OK: only the token file holds it"; fi
[ -n "$held" ] && [ "$(stat -f %Lp "$held")" = 600 ] && [ "$(stat -f %Lp "$(dirname "$held")")" = 700 ] && echo "OK: token file 0600, folder 0700" || { echo "FAIL: modes $(stat -f %Lp "$held" 2>/dev/null) / $(stat -f %Lp "$(dirname "$held")" 2>/dev/null)"; fail=1; }
if grep -q "$T" /tmp/sy-scrub3.log; then echo "FAIL: the token is in the drive's output or logs"; fail=1; else echo "OK: not in the drive's logs"; fi
# …nor anywhere else the app writes: its Application Support tree (kv/exact.kept, exact.state)
# other than a token file, its logs, its prefs (the UserDefaults domain) and its caches
A="$HOME/Library/Application Support/$APPID"
n=$(grep -rlF "$T" "$A" 2>/dev/null | grep -v "/token$" | grep -c .); [ "$n" = 0 ] && echo "OK: not in Application Support/$APPID (kv/exact.kept, state)" || { echo "FAIL: in $n files under Application Support/$APPID"; fail=1; }
n=$(grep -rlF "$T" "$HOME/Library/Logs/Switchyard" 2>/dev/null | grep -c .); [ "$n" = 0 ] && echo "OK: not in ~/Library/Logs/Switchyard" || { echo "FAIL: in $n log files"; fail=1; }
n=$(defaults read "$APPID" 2>/dev/null | grep -cF "$T"); [ "$n" = 0 ] && echo "OK: not in the prefs (defaults read $APPID)" || { echo "FAIL: in the prefs"; fail=1; }
n=$(grep -rlF "$T" "$HOME/Library/Caches/exact/$APPID" "$HOME/Library/Caches/$APPID" 2>/dev/null | grep -vxF "$held" | grep -c .); [ "$n" = 0 ] && echo "OK: not in the caches other than the drive's token file" || { echo "FAIL: in $n cache files: $(grep -rlF "$T" "$HOME/Library/Caches/exact/$APPID" "$HOME/Library/Caches/$APPID" 2>/dev/null | grep -vxF "$held" | tr '\n' ' ')"; fail=1; }
echo "== e2e: drive 4 relaunches on the same store"
timeout 300 bun exact.mjs agent macos --storage sy-scrub --size 1440x900 "clock data" "clock settle" "state tok" "state conn" > /tmp/sy-scrub4.log 2>&1
grep -q 'status "ready"' /tmp/sy-scrub4.log && grep -q 'has true' /tmp/sy-scrub4.log && echo "OK: the token is read back after a relaunch" || { echo "FAIL: not read back"; fail=1; }
grep -q "$T" /tmp/sy-scrub4.log && { echo "FAIL: the token is in drive 4's output"; fail=1; }
# Drives 5-6: the same on the platform's own stores (EXACT_STORE=real): the token file in the
# real ~/Library/Application Support/$APPID, Exact's kv/exact.kept and state beside it, the prefs
# domain. They write that app's real data, so they run only under a test id (app.json's id, e.g.
# com.exowatt.switchyard.kctest in a scratch clone), never the shipped app's.
if [ "$APPID" = com.exowatt.switchyard ]; then
  echo "SKIP: drives 5-6 (the platform's stores) would write the installed app's data; run in a clone whose app.json id is a test id"
  exit $fail
fi
echo "== e2e: drive 5 saves a token on the platform's stores (EXACT_STORE=real, $APPID)"
T2=syd_E2Ereal$(date +%s)Q7x
EXACT_STORE=real timeout 300 bun exact.mjs agent macos --size 1440x900 "clock data" "tap open-settings" "clock settle" "type server-field demo" "type token-field $T2" "tap settings-save" "clock data" "clock settle" "clock +1500 real" "state tok" > /tmp/sy-scrub5.log 2>&1
grep -q 'status "ready"' /tmp/sy-scrub5.log || { echo "FAIL: drive 5 did not save the token"; fail=1; }
held=$(grep -rlF "$T2" "$A" 2>/dev/null)
echo "files under Application Support/$APPID holding it: $(echo "$held" | sed "s|$A/||" | tr '\n' ' ')"
if [ "$held" = "$A/token" ]; then echo "OK: only $A/token holds it (not kv/exact.kept, not the state)"; else echo "FAIL: not only the token file"; fail=1; fi
[ "$(stat -f %Lp "$A/token" 2>/dev/null)" = 600 ] && [ "$(stat -f %Lp "$A")" = 700 ] && echo "OK: token file 0600, folder 0700" || { echo "FAIL: modes $(stat -f %Lp "$A/token" 2>/dev/null) / $(stat -f %Lp "$A" 2>/dev/null)"; fail=1; }
[ -f "$A/migrated" ] && [ "$(stat -f %Lp "$A/migrated")" = 600 ] && echo "OK: migrated marked (0600)" || { echo "FAIL: no 0600 migrated mark"; fail=1; }
n=$(grep -rlF "$T2" "$HOME/Library/Logs/Switchyard" 2>/dev/null | grep -c .); [ "$n" = 0 ] && echo "OK: not in ~/Library/Logs/Switchyard" || { echo "FAIL: in $n log files"; fail=1; }
n=$(defaults read "$APPID" 2>/dev/null | grep -cF "$T2"); [ "$n" = 0 ] && echo "OK: not in the prefs (defaults read $APPID: $(defaults read "$APPID" 2>/dev/null | grep -c '=') keys)" || { echo "FAIL: in the prefs"; fail=1; }
n=$(grep -rlF "$T2" "$HOME/Library/Caches/$APPID" "$HOME/Library/Caches/exact/$APPID" 2>/dev/null | grep -c .); [ "$n" = 0 ] && echo "OK: not in the caches" || { echo "FAIL: in $n cache files"; fail=1; }
grep -qF "$T2" /tmp/sy-scrub5.log && { echo "FAIL: the token is in drive 5's output"; fail=1; }
# The Keychain: attributes only (no -w: never reads a value, never prompts). This build never adds
# an item; one there is an older build's, left (transitionally) and never read.
if timeout 10 security find-generic-password -s "$APPID" -a switchyard.token >/dev/null 2>&1; then echo "NOTE: an older build's Keychain item ($APPID / switchyard.token) is there; this build never reads or writes it"; else echo "OK: no Keychain item ($APPID / switchyard.token)"; fi
echo "== e2e: drive 6 signs out (Forget token)"
EXACT_STORE=real timeout 300 bun exact.mjs agent macos --size 1440x900 "clock data" "clock settle" "tap open-settings" "clock settle" "tap settings-forget" "clock data" "clock settle" "state tok" > /tmp/sy-scrub6.log 2>&1
grep -q 'has false' /tmp/sy-scrub6.log && [ ! -e "$A/token" ] && echo "OK: signed out: the token file is gone" || { echo "FAIL: the token file is still there after Forget token"; fail=1; }
[ -f "$A/migrated" ] && echo "OK: migrated stays" || { echo "FAIL: migrated gone"; fail=1; }
n=$(grep -rlF "$T2" "$A" "$HOME/Library/Logs/Switchyard" 2>/dev/null | grep -c .); [ "$n" = 0 ] && echo "OK: the token is nowhere under Application Support/$APPID or the logs" || { echo "FAIL: still in $n files"; fail=1; }
exit $fail
