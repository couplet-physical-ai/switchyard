#!/bin/bash
# p7 on the mini, detached (kit.sh starts it): the private Exact copies, both builds, the interleaved CPU
# batch on a quiet machine, the pixel drives, Exact's XCTests, the macOS suite. Progress: $F/p7-all.log.
# Stops at the first failed build. Each step is bounded (p7-*.sh carry their own timeouts).
F=/Volumes/Farm/farm-exowatt; K=$F/switchyard-client-p7/app/tools/p7
H=$F/switchyard-client-p7; B=$F/switchyard-client-p7-base
step() { echo "=== $(date +%T) load $(uptime | sed 's/.*averages: //') · $*"; }
die() { step "ABORT: $*"; exit 1; }
step "start head $(cat $H/app/.p7-head 2>/dev/null) base 3e4d2df"
df -h /Volumes/Farm | tail -1
[ "$(df -g /Volumes/Farm | tail -1 | awk '{print $4}')" -ge 20 ] || die "under 20 GB free on /Volumes/Farm"
for e in p7 p7base; do [ -d $F/switchyard-exact-$e ] || cp -cR $F/switchyard-exact $F/switchyard-exact-$e || die "cp exact-$e"; done
sh $H/app/scripts/patch-exact.sh $F/switchyard-exact-p7 || die "patch head Exact"
sh $B/app/scripts/patch-exact.sh $F/switchyard-exact-p7base || die "patch base Exact"
git -C $F/switchyard-exact-p7 status --short; echo "-- base:"; git -C $F/switchyard-exact-p7base status --short
git -C $F/switchyard-exact-p7 status --short | grep -q TextViewportIndexMac || die "head Exact lacks 0005"
git -C $F/switchyard-exact-p7base status --short | grep -q TextViewportIndexMac && die "base Exact has 0005"

step "build head"; bash $K/p7-build.sh $H $F/switchyard-exact-p7 $F/p7-build-head.log
grep -q "build rc=0" $F/p7-build-head.log || { tail -40 $F/p7-build-head.log; die "head build failed ($F/p7-build-head.log)"; }
step "build base"; bash $K/p7-build.sh $B $F/switchyard-exact-p7base $F/p7-build-base.log
grep -q "build rc=0" $F/p7-build-base.log || { tail -40 $F/p7-build-base.log; die "base build failed ($F/p7-build-base.log)"; }

step "CPU batch (p7-results.txt)"; bash $K/p7-batch.sh
step "pixel drives (p7-shots/)"
bash $K/p7-shots.sh $H head; bash $K/p7-shots.sh $B base; bash $K/p7-shots.sh $B base2; bash $K/p7-shots.sh $H head2
for d in head base base2 head2; do echo "$d: $(ls $F/p7-shots/$d/*.png 2>/dev/null | wc -l) pictures, $(tail -1 $F/p7-shots/$d/drive.log)"; done

step "Exact XCTests on the head copy (p7-xctest-head.log)"
bash $K/p7-xctest.sh $F/switchyard-exact-p7 $F/p7-xctest-head.log
tail -3 $F/p7-xctest-head.log
if ! grep -q "xctest rc=0" $F/p7-xctest-head.log; then
  step "head XCTests failed: the same classes on the base copy, to tell a 0005 failure from a standing one (p7-xctest-base.log)"
  bash $K/p7-xctest.sh $F/switchyard-exact-p7base $F/p7-xctest-base.log "$(grep -o 'CL=${3:-[^}]*' $K/p7-xctest.sh | sed 's/CL=${3:-//; s/TextTouchedMacTests,//')"
  tail -3 $F/p7-xctest-base.log
fi

step "macOS tests/*.test.contract on head (p7-macos-suite.log)"
if ! lsof -nP -iTCP:8097 -sTCP:LISTEN > /dev/null 2>&1; then
  (. $F/switchyard-env.sh; export SY_EXACT2=$F/switchyard-exact-p7 EXACT2=$F/switchyard-exact-p7 EXACT_APP_DIR=$H/app; cd $H/app
   nice -n 15 timeout 1800 bun exact.mjs test macos 'tests/*.test.contract' --size 1440x900 > $F/p7-macos-suite.log 2>&1; echo "suite rc=$? $(date +%T)" >> $F/p7-macos-suite.log)
  tail -2 $F/p7-macos-suite.log
else echo "suite skipped: :8097 busy"; fi
step "DONE"
