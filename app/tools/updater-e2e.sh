#!/bin/sh
# The updater's end-to-end run on a Mac, outside the agent (README "Updates"):
#   app/tools/updater-e2e.sh <Switchyard.app> [old version, default 0.0.2]
# Installs a copy of the app at ~/Applications/Switchyard.app stamped to an old version and
# re-signed ad hoc, launches it with the pre-release channel and auto-install on, waits for it to
# find, download, verify, swap and relaunch, prints the evidence, then quits it and removes it.
# FEED=<base URL> points it at a test feed (<base>/releases, as GitHub's API answers) instead of
# GitHub. Every wait is bounded; it refuses to touch an existing ~/Applications/Switchyard.app.
set -u
SRC=${1:?usage: updater-e2e.sh <Switchyard.app> [old version]}
OLD=${2:-0.0.2}
DEST=$HOME/Applications/Switchyard.app
EXE=$DEST/Contents/MacOS/Switchyard
LOG=$HOME/Library/Logs/Switchyard/updater.log
OUT=${TMPDIR:-/tmp}/switchyard-updater-e2e.out
PB=/usr/libexec/PlistBuddy
plist() { $PB -c "Print :$1" "$DEST/Contents/Info.plist" 2>/dev/null; }
pids() { pgrep -f "$EXE" | tr '\n' ' '; }

mkdir -p "$HOME/Applications"
if [ -e "$DEST" ]; then echo "refusing: $DEST exists" >&2; exit 1; fi
ditto "$SRC" "$DEST"
$PB -c "Set :CFBundleShortVersionString $OLD" "$DEST/Contents/Info.plist"
codesign --force --deep --sign - --preserve-metadata=entitlements,requirements,flags "$DEST"
codesign --verify --deep --strict "$DEST" || exit 1
echo "BEFORE: $(plist CFBundleIdentifier) $(plist CFBundleShortVersionString), binary sha256 $(shasum -a 256 "$EXE" | cut -c1-16)"
rm -f "$LOG" "$OUT"
open -n -g --env SWITCHYARD_UPDATE_PRERELEASE=1 --env SWITCHYARD_UPDATE_AUTOINSTALL=1 ${FEED:+--env SWITCHYARD_UPDATE_FEED=$FEED} \
  --stdout "$OUT" --stderr "$OUT" "$DEST"
sleep 3
echo "launched: pid $(pids)"
i=0
while [ $i -lt 600 ] && ! grep -q "swapped\|error:" "$LOG" 2>/dev/null; do sleep 2; i=$((i + 2)); done
sleep 10
echo "---- $LOG"
cat "$LOG" 2>/dev/null
echo "---- AFTER: $(plist CFBundleIdentifier) $(plist CFBundleShortVersionString), binary sha256 $(shasum -a 256 "$EXE" | cut -c1-16), on-disk inode $(stat -f %i "$EXE")"
codesign --verify --deep --strict "$DEST" && echo "bundle signature ok"
for p in $(pids); do
  ps -o pid=,lstart=,command= -p "$p"
  lsof -p "$p" 2>/dev/null | awk '$4 == "txt" && $NF ~ /Switchyard.app\/Contents\/MacOS\/Switchyard$/ { print "  running inode", $8 }'
done
echo "---- cleanup"
for p in $(pids); do kill -TERM "$p"; done
sleep 5
for p in $(pids); do kill -KILL "$p"; done
rm -rf "$DEST"
[ -z "$(pids)" ] && echo "quit; $DEST removed"
