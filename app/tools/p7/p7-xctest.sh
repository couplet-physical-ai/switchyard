#!/bin/bash
# p7: Exact's Swift host tests of the Mac text/scroll/zoom/split paths, on an Exact copy (nice).
# usage: p7-xctest.sh <exact copy> <log> [classes]
E=$1; LOG=$2
F=/Volumes/Farm/farm-exowatt
CL=${3:-TextTouchedMacTests,PageZoomMacTests,PageScrollMacTests,InnerScrollMacTests,TextParityMacTests,TextSelectionMacTests,TextDecorationMacTests,PixelGridMacTests,PaintCaptureMacTests,SplitMacTests,SheetHostMacTests,TableFeedMacTests,CollectionMacTests,AgentStickyRevealMacTests,ScrollAnchoringMacTests,OwnerScrollMacTests,HDRColorTests,BoxFilterTests,PressWashMacTests,HeldStateTests,ProfileColorTests,TextGeometryTests,TextMetricsTests}
. $F/switchyard-env.sh
cd $E
echo "xctest start $(date +%T) load $(uptime | sed 's/.*averages: //') $E" > $LOG
git -C $E status --short >> $LOG
nice -n 15 timeout 3000 bun host/apple/build.mjs --test --only $CL >> $LOG 2>&1
echo "xctest rc=$? $(date +%T)" >> $LOG
