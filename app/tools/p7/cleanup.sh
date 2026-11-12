#!/bin/bash
# p7: remove everything kit.sh made on the mini (after collect.sh). Kills only p7's own processes, by pid.
#   MINI=user@host bash app/tools/p7/cleanup.sh
set -u
: "${MINI:?MINI=user@host of the Mac mini}"
F=/Volumes/Farm/farm-exowatt
timeout 300 ssh -o BatchMode=yes -o ConnectTimeout=10 "$MINI" "
  for p in \$(pgrep -f '$F/switchyard-client-p7(-base)?/app/(tools/p7|target)'); do echo kill \$p; kill \$p; done
  rm -rf $F/switchyard-client-p7 $F/switchyard-client-p7-base $F/switchyard-exact-p7 $F/switchyard-exact-p7base $F/p7-runs $F/p7-shots /tmp/p7-data
  rm -f $F/p7-all.log $F/p7-results.txt $F/p7-build-*.log $F/p7-xctest-*.log $F/p7-macos-suite.log
  ls -d $F/*p7* 2>/dev/null; df -h /Volumes/Farm | tail -1"
