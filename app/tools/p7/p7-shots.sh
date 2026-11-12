#!/bin/bash
# p7: the same deterministic drive on a clone (the built-in demo on the agent's clock), the window
# server's picture (rasters and bands as shown) after timer ticks, a scroll of Live's list (held
# mid-gesture and after), a resize and new rows. usage: p7-shots.sh <clone> <label>
D=$1; label=$2
F=/Volumes/Farm/farm-exowatt
case $D in *-base) E=$F/switchyard-exact-p7base ;; *) E=$F/switchyard-exact-p7 ;; esac
export SY_EXACT2=$E
. $F/switchyard-env.sh; export EXACT2=$E
cd $D/app; export EXACT_APP_DIR=$D/app
R=$F/p7-shots/$label; rm -rf $R; mkdir -p $R
w() { echo "screenshot $R/$1.png window"; }
ops=("clock data" "tap now-setup-demo" "clock data" "clock +4000" "$(w 01-start)"
  "clock +1000" "$(w 02-tick1)" "clock +1000" "clock +1000" "$(w 03-tick3)"
  "tap now-scroll wheel 0 500" "clock +300" "$(w 04-scrolled)" "clock +1000" "$(w 05-scrolled-tick)"
  "tap now-scroll wheel 0 400 hold" "$(w 06-midscroll)" "clock +1000" "$(w 07-midscroll-tick)" "tap now-scroll wheel 0 0 release" "clock +300" "$(w 08-released)"
  "tap now-scroll wheel 0 -900" "clock +1000" "$(w 09-back-top-tick)"
  "resize 1180x780" "clock +1000" "$(w 10-resized)" "clock +1000" "$(w 11-resized-tick)"
  "resize 1440x900" "clock +1000" "$(w 12-restored)"
  "clock +20000" "$(w 13-later)" "clock +1000" "$(w 14-later-tick)" "logs")
echo "== $label $(date +%T) load $(uptime | sed 's/.*averages: //') EXACT2=$EXACT2" > $R/drive.log
timeout 900 bun exact.mjs agent macos --reset-storage --size 1440x900 "${ops[@]}" >> $R/drive.log 2>&1
echo "rc=$? $(date +%T)" >> $R/drive.log
