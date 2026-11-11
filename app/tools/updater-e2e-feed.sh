#!/bin/sh
# The updater's end-to-end run against a REAL feed with the headless hook (README "Updates"):
#   app/tools/updater-e2e-feed.sh <Switchyard.app> <old version> <latest.json URL>
# e.g. app/tools/updater-e2e-feed.sh Switchyard.app 0.0.2 \
#        https://github.com/couplet-physical-ai/switchyard/releases/download/v0.0.4/latest.json
# Installs a copy stamped <old version> (CFBundleVersion M*1000000 + m*1000 + p), re-signed ad
# hoc, at ~/Applications/Switchyard.app, launches it with SWITCHYARD_UPDATE_FEED=<URL> and
# --update-now (no UI: check, download, verify, swap, relaunch), then prints the evidence: the
# log, the new pid's executable inode against the bundle's, the aside. Quits only the pids it
# started, removes the copy. Every wait is bounded.
set -u
SRC=${1:?usage: updater-e2e-feed.sh <Switchyard.app> <old version> <latest.json URL>}
OLD=${2:?old version}
URL=${3:?latest.json URL}
DEST=$HOME/Applications/Switchyard.app
EXE=$DEST/Contents/MacOS/Switchyard
LOG=$HOME/Library/Logs/Switchyard/update.log
PB=/usr/libexec/PlistBuddy
STARTED=
plist() { $PB -c "Print :$1" "$2/Contents/Info.plist" 2>/dev/null; }
build() { echo "$1" | awk -F'[.-]' '{ print $1 * 1000000 + $2 * 1000 + $3 }'; }
stop() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done; kill -KILL "$1" 2>/dev/null; true; }
cleanup() { echo "---- cleanup"; for p in $STARTED; do stop "$p"; done; rm -rf "$DEST" "$DEST.old"; echo "quit pids:${STARTED:- none}; $DEST and $DEST.old removed"; }
mkdir -p "$HOME/Applications"
if [ -e "$DEST" ] || [ -e "$DEST.old" ]; then echo "refusing: $DEST exists" >&2; exit 1; fi
trap cleanup EXIT
ditto "$SRC" "$DEST"
$PB -c "Set :CFBundleShortVersionString $OLD" "$DEST/Contents/Info.plist"
$PB -c "Set :CFBundleVersion $(build "$OLD")" "$DEST/Contents/Info.plist"
codesign --force --deep --sign - --preserve-metadata=entitlements,requirements,flags "$DEST" 2>&1 | grep -v 'replacing existing'
codesign --verify --deep --strict "$DEST" || exit 1
echo "BEFORE: $(plist CFBundleIdentifier "$DEST") $(plist CFBundleShortVersionString "$DEST") build $(plist CFBundleVersion "$DEST"), executable inode $(stat -f %i "$EXE")"
echo "feed: $URL"
from=$(($(wc -l < "$LOG" 2>/dev/null || echo 0) + 1))
open -n -g --env SWITCHYARD_UPDATE_FEED="$URL" "$DEST" --args --update-now
i=0; A=
while [ -z "$A" ] && [ $i -lt 60 ]; do A=$(tail -n +"$from" "$LOG" 2>/dev/null | grep "launch: com.exowatt.switchyard $OLD (build" | grep "at $DEST;" | head -1 | sed 's/.* pid \([0-9]*\) at .*/\1/'); sleep 1; i=$((i + 1)); done
[ -n "$A" ] || { echo "no launch line"; exit 1; }
STARTED=$A
i=0; B=
while [ -z "$B" ] && [ $i -lt 300 ]; do
  tail -n +"$from" "$LOG" | grep " pid $A " | grep -q "error:\|not installed" && break
  B=$(tail -n +"$from" "$LOG" | grep "launch: com.exowatt.switchyard" | grep "at $DEST;" | grep -v " pid $A " | head -1 | sed 's/.* pid \([0-9]*\) at .*/\1/')
  sleep 1; i=$((i + 1))
done
sleep 3
# The relaunched build may not log (one without this updater); find it by its executable.
[ -n "$B" ] || B=$(pgrep -f "^$EXE" | grep -v "^$A\$" | head -1)
STARTED="$A $B"
tail -n +"$from" "$LOG" | grep " pid $A \| pid ${B:-none} "
echo "---- AFTER: $(plist CFBundleIdentifier "$DEST") $(plist CFBundleShortVersionString "$DEST") build $(plist CFBundleVersion "$DEST"), executable inode $(stat -f %i "$EXE")"
kill -0 "$A" 2>/dev/null && echo "old pid $A: still running" || echo "old pid $A: exited"
[ -n "$B" ] && ps -o pid=,lstart=,command= -p "$B"
[ -n "$B" ] && lsof -p "$B" 2>/dev/null | awk '$4 == "txt" && $NF ~ /Switchyard.app\/Contents\/MacOS\/Switchyard$/ { print "  new pid runs inode", $8, $NF }'
[ -e "$DEST.old" ] && echo "aside: $DEST.old present ($(plist CFBundleShortVersionString "$DEST.old"))" || echo "aside: gone"
