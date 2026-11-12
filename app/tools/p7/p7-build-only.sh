#!/bin/bash
# Phase A of p7-all.sh (sy-client): the Exact copies + both builds only; may run beside a memory-only soak. Was:
# p7 on the mini, detached (kit.sh starts it): the private Exact copies, both builds, the interleaved CPU
# batch on a quiet machine, the pixel drives, Exact's XCTests, the macOS suite. Progress: $F/p7-all.log.
# Stops at the first failed build. Each step is bounded (p7-*.sh carry their own timeouts).
F=/Volumes/Farm/farm-exowatt; K=$F/switchyard-client-p7/app/tools/p7
H=$F/switchyard-client-p7; B=$F/switchyard-client-p7-base
step() { echo "=== $(date +%T) load $(uptime | sed 's/.*averages: //') · $*"; }
die() { step "ABORT: $*"; exit 1; }
step "start head $(cat $H/app/.p7-head 2>/dev/null) base df6e18a"
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

step "BUILT (phase A done; phase B = p7-rest.sh on a quiet mini)"
