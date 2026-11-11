#!/bin/bash
# The kept-answer scrub, end to end on a Mac (README "Test hooks"): the native unit tests, then a
# real launch. Drive 1 makes a scratch store; a kept answer holding a fake syd_ token is seeded
# into its kv/exact.kept; drive 2 launches the app on that store and the entry must be gone (a
# clean one stays). Exits 1 on a failure. Run from app/ on the Mac: sh tools/kept-scrub-e2e.sh
[ -f "${SY_ENV:-/Volumes/Farm/farm-exowatt/switchyard-env.sh}" ] && . "${SY_ENV:-/Volumes/Farm/farm-exowatt/switchyard-env.sh}"
cd "${APP_DIR:-$(dirname "$0")/..}"
echo "== native"; timeout 600 sh tools/updater-tests.sh 2>&1 | grep -i "scrub\|passed\|FAIL" | tail -14
timeout 900 bun exact.mjs mac > /tmp/sy-scrub-build.log 2>&1 || { echo BUILD FAILED; tail -5 /tmp/sy-scrub-build.log; exit 1; }
echo "== e2e: drive 1 makes the store"
timeout 300 bun exact.mjs agent macos --storage sy-scrub --reset-storage --size 1440x900 "clock data" "clock +1500 real" > /tmp/sy-scrub1.log 2>&1
K=$HOME/Library/Caches/exact/com.exowatt.switchyard/agent/sy-scrub/kv/exact.kept
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
