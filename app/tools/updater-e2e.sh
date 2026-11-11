#!/bin/sh
# The updater's end-to-end run on a Mac, outside the agent (README "Updates"):
#   app/tools/updater-e2e.sh <Switchyard.app> [old version, default 0.0.2] [new version, default 0.0.3]
# 1. Makes two copies of the app stamped to OLD and NEW and re-signed ad hoc: OLD installed at
#    ~/Applications/Switchyard.app, NEW zipped into a local feed (latest.json + the zip) served
#    on 127.0.0.1 (SWITCHYARD_UPDATE_FEED, the env-only test hook).
# 2. Launches OLD: ~10 s later it checks, downloads, verifies and is "Update ready". Quits it.
# 3. Launches OLD again with SWITCHYARD_UPDATE_AUTOINSTALL=1 (the env-only hook that presses
#    "Relaunch to update"): it swaps with two renames and relaunches; the new process is NEW and
#    sweeps the aside bundle and the staging folders at launch.
# 4. Prints the evidence, quits what it started (by pid, never by name: other copies of
#    Switchyard may run on this Mac), removes the copy and the feed.
# Every wait is bounded; it refuses to touch an existing ~/Applications/Switchyard.app.
set -u
SRC=${1:?usage: updater-e2e.sh <Switchyard.app> [old version] [new version]}
OLD=${2:-0.0.2}
NEW=${3:-0.0.3}
PORT=${PORT:-18765}
DEST=$HOME/Applications/Switchyard.app
EXE=$DEST/Contents/MacOS/Switchyard
LOG=$HOME/Library/Logs/Switchyard/update.log
PB=/usr/libexec/PlistBuddy
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sy-updater-e2e.XXXXXX")
FEED=$WORK/feed
SERVER=
STARTED=

plist() { $PB -c "Print :$1" "$2/Contents/Info.plist" 2>/dev/null; }
# This run's lines of the shared log, from pid $1.
lines() { grep " pid $1 " "$LOG" 2>/dev/null; }
# Wait up to $2 s for a line matching $3 from pid $1.
await() { i=0; while [ $i -lt "$2" ]; do lines "$1" | grep -q "$3" && return 0; sleep 1; i=$((i + 1)); done; echo "timed out after $2 s waiting for pid $1: $3" >&2; return 1; }
# The pid of the copy at $DEST that logged its launch as version $1, newer than the line count $2.
launched() { i=0; while [ $i -lt 60 ]; do p=$(tail -n +"$2" "$LOG" 2>/dev/null | grep "launch: com.exowatt.switchyard $1 pid [0-9]* at $DEST;" | tail -1 | sed 's/.* pid \([0-9]*\) at .*/\1/'); [ -n "$p" ] && { echo "$p"; return 0; }; sleep 1; i=$((i + 1)); done; return 1; }
stop() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done; kill -KILL "$1" 2>/dev/null; true; }
cleanup() {
  echo "---- cleanup"
  for p in $STARTED; do stop "$p"; done
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null
  rm -rf "$DEST" "$DEST.old" "$WORK"
  echo "quit pids:${STARTED:- none}; feed server $SERVER stopped; $DEST removed"
}
trap cleanup EXIT

mkdir -p "$HOME/Applications" "$FEED"
if [ -e "$DEST" ] || [ -e "$DEST.old" ]; then echo "refusing: $DEST exists" >&2; trap - EXIT; rm -rf "$WORK"; exit 1; fi
build() { echo "$1" | awk -F'[.-]' '{ print $1 * 1000000 + $2 * 1000 + $3 }'; }
stamp() { # stamp <app> <version>: CFBundleShortVersionString and CFBundleVersion (M*1000000 + m*1000 + p)
  $PB -c "Set :CFBundleShortVersionString $2" "$1/Contents/Info.plist"
  $PB -c "Set :CFBundleVersion $(build "$2")" "$1/Contents/Info.plist"
  codesign --force --deep --sign - --preserve-metadata=entitlements,requirements,flags "$1" 2>&1 | grep -v 'replacing existing signature'
  codesign --verify --deep --strict "$1" || exit 1
}
ditto "$SRC" "$WORK/new/Switchyard.app" && stamp "$WORK/new/Switchyard.app" "$NEW"
ditto -c -k --sequesterRsrc --keepParent "$WORK/new/Switchyard.app" "$FEED/Switchyard-$NEW-arm64.zip"
SHA=$(shasum -a 256 "$FEED/Switchyard-$NEW-arm64.zip" | cut -d' ' -f1)
printf '{"version":"%s","build":%s,"url":"http://127.0.0.1:%s/Switchyard-%s-arm64.zip","sha256":"%s","notes":"- the end-to-end run'"'"'s release","published":"%s","minimumSystemVersion":"14.0","bundleId":"com.exowatt.switchyard"}\n' \
  "$NEW" "$(build "$NEW")" "$PORT" "$NEW" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$FEED/latest.json"
echo "feed: http://127.0.0.1:$PORT/latest.json"; cat "$FEED/latest.json"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$FEED" > "$WORK/server.log" 2>&1 &
SERVER=$!
i=0; until curl -sf -m 2 -o /dev/null "http://127.0.0.1:$PORT/latest.json"; do i=$((i + 1)); [ $i -lt 20 ] || { echo "the feed server did not start"; exit 1; }; sleep 1; done
echo "feed server up after ${i}s (pid $SERVER)"
ditto "$SRC" "$DEST" && stamp "$DEST" "$OLD"
echo "BEFORE: $DEST $(plist CFBundleIdentifier "$DEST") $(plist CFBundleShortVersionString "$DEST"), executable inode $(stat -f %i "$EXE")"
sleep 1

echo "==== 1. an installed $OLD finds $NEW, downloads and verifies it: Update ready"
from=$(($(wc -l < "$LOG" 2>/dev/null || echo 0) + 1))
open -n -g --env SWITCHYARD_UPDATE_FEED="http://127.0.0.1:$PORT" "$DEST"
A=$(launched "$OLD (build $(build "$OLD"))" "$from") || { echo "no launch line from $DEST"; exit 1; }
STARTED="$A"
await "$A" 90 "ready: $NEW\|error:"
lines "$A"
echo "process $A: $(ps -o pid=,command= -p "$A")"
stop "$A"; STARTED=
echo "quit $A; $DEST is still $(plist CFBundleShortVersionString "$DEST") (nothing swaps without the button)"

echo "==== 2. the button (SWITCHYARD_UPDATE_AUTOINSTALL=1): two renames, relaunch, sweep"
from=$(($(wc -l < "$LOG") + 1))
open -n -g --env SWITCHYARD_UPDATE_FEED="http://127.0.0.1:$PORT" --env SWITCHYARD_UPDATE_AUTOINSTALL=1 "$DEST"
B=$(launched "$OLD (build $(build "$OLD"))" "$from") || { echo "no launch line from $DEST"; exit 1; }
STARTED="$B"
await "$B" 90 "install: swapped\|error:"
C=$(launched "$NEW (build $(build "$NEW"))" "$from") || { echo "no relaunch as $NEW"; lines "$B"; exit 1; }
STARTED="$B $C"
await "$C" 20 "sweep:"
sleep 1
lines "$B"
lines "$C"
echo "---- AFTER: $DEST $(plist CFBundleIdentifier "$DEST") $(plist CFBundleShortVersionString "$DEST"), executable inode $(stat -f %i "$EXE")"
codesign --verify --deep --strict "$DEST" && echo "bundle signature ok"
[ -e "$DEST.old" ] && echo "aside STILL THERE: $DEST.old" || echo "aside $DEST.old: gone (swept)"
kill -0 "$B" 2>/dev/null && echo "old process $B still running" || echo "old process $B: exited"
ps -o pid=,lstart=,command= -p "$C"
lsof -p "$C" 2>/dev/null | awk '$4 == "txt" && $NF ~ /Switchyard.app\/Contents\/MacOS\/Switchyard$/ { print "  pid '"$C"' runs inode", $8, $NF }'
echo "server log:"; cat "$WORK/server.log"
