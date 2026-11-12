#!/bin/bash
# p7 (mini quiet): interleaved head/base (ABBA on Live), load logged per run (p7-m.sh), then the profiles.
F=/Volumes/Farm/farm-exowatt; K=$F/switchyard-client-p7/app/tools/p7; H=$F/switchyard-client-p7; B=$F/switchyard-client-p7-base
echo "=== p7 batch $(date +%T) load $(uptime | sed 's/.*averages: //') head=$(cat $H/app/.p7-head 2>/dev/null)+0005 base=df6e18a (0001-0004)" >> $F/p7-results.txt
bash $K/p7-m.sh $H head-idle-now1 idle-now $H
bash $K/p7-m.sh $B base-idle-now1 idle-now $H
bash $K/p7-m.sh $B base-idle-now2 idle-now $H
bash $K/p7-m.sh $H head-idle-now2 idle-now $H
bash $K/p7-m.sh $H head-idle-factory1 idle-factory $H
bash $K/p7-m.sh $B base-idle-factory1 idle-factory $H
bash $K/p7-m.sh $B base-idle-yard1 idle-yard $H
bash $K/p7-m.sh $H head-idle-yard1 idle-yard $H
bash $K/p7-m.sh $H head-paused-now1 paused-now $H
bash $K/p7-m.sh $B base-paused-now1 paused-now $H
bash $K/p7-m.sh $B base-busy-now1 busy-now $H
bash $K/p7-m.sh $H head-busy-now1 busy-now $H
echo "=== p7 batch core done $(date +%T) load $(uptime | sed 's/.*averages: //')" >> $F/p7-results.txt
bash $K/p7-m.sh $H head-idle-now3 idle-now $H
bash $K/p7-m.sh $B base-idle-now3 idle-now $H
bash $K/p7-m.sh $H head-busy-factory1 busy-factory $H
bash $K/p7-m.sh $B base-busy-factory1 busy-factory $H
bash $K/p7-m.sh $B base-busy-yard1 busy-yard $H
bash $K/p7-m.sh $H head-busy-yard1 busy-yard $H
echo "=== PROFILES (sample running: CPU of these two is not a measurement) $(date +%T)" >> $F/p7-results.txt
SAMPLE=1 bash $K/p7-m.sh $H prof-head-idle-now idle-now $H
SAMPLE=1 bash $K/p7-m.sh $B prof-base-idle-now idle-now $H
echo "=== p7 batch done $(date +%T) load $(uptime | sed 's/.*averages: //')" >> $F/p7-results.txt
