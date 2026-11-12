#!/bin/bash
# p7: nice dev build of a clone against its private Exact. usage: p7-build.sh <clone> <exact copy> <log>
D=$1; E=$2; LOG=$3
F=/Volumes/Farm/farm-exowatt
export SY_EXACT2=$E
. $F/switchyard-env.sh; export EXACT2=$E
cd $D/app; export EXACT_APP_DIR=$D/app
echo "start $(date +%T) load $(uptime | sed 's/.*averages: //') EXACT2=$EXACT2" > $LOG
nice -n 15 timeout 2400 bun exact.mjs mac >> $LOG 2>&1
echo "build rc=$? $(date +%T)" >> $LOG
