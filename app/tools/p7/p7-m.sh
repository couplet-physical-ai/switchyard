#!/bin/bash
# p7-text, on the mini (p6-m.sh with each clone on its own Exact copy): one perf drive of a clone's dev app, real taps, EXACT_AGENT=live.
#   idle-<tab>   : the frozen mock (serves tstream; 3 builds running: the 1 Hz timers tick), <tab> on
#                  top (now|factory|yard), 56 s of CPU (ps -o time every 2 s) and frames.
#   paused-<tab> : the same mock, the Yard's Pause, then <tab> on top: 56 s.
#   busy-<tab>   : a FRESH 10x recorded-fleet server, <tab> busy: window A 30 s frames + CPU.
# SAMPLE=1: `sample <pid> 10` inside the window (idle/paused) or after window A (busy).
# CANVAS=<gpu|board,info>: SWITCHYARD_CANVAS for the A/B. EXACT_CANVAS_STATS=1 always.
#   idlerm-<tab> : idle-<tab> with prefers-reduced-motion (Live's beat and chips still).
# usage: p6-m.sh <clone> <label> <mode> [mockclone]
D=$1; label=$2; mode=$3; MOCKD=${4:-$1}
F=/Volumes/Farm/farm-exowatt
case $D in *-base) E=$F/switchyard-exact-p7base ;; *) E=$F/switchyard-exact-p7 ;; esac
export SY_EXACT2=$E
. $F/switchyard-env.sh; export EXACT2=$E
cd $D/app; export EXACT_APP_DIR=$D/app
export EXACT_CANVAS_STATS=1
[ -n "$CANVAS" ] && export SWITCHYARD_CANVAS=$CANVAS || unset SWITCHYARD_CANVAS
OUT=$F/p7-results.txt; R=$F/p7-runs; mkdir -p $R
cpu() { ps -o time= -p $1 2>/dev/null | awk -F'[:.]' '{ if (NF==4) print $1*3600+$2*60+$3+$4/100; else print $1*60+$2+$3/100 }'; }
spid=""
case $mode in
  busy-*)
    tab=${mode#busy-}; port=8423
    rm -rf /tmp/p7-data; mkdir -p /tmp/p7-data
    nohup timeout 600 $F/switchyard-srv/bin/switchyard-server --demo --speed 10 --listen 127.0.0.1:$port --fixtures $D/contract/fixtures --data-dir /tmp/p7-data > $R/srv-$label.log 2>&1 < /dev/null &
    spid=$!
    ops=("tap now-setup-connect" "type server-field http://127.0.0.1:$port" "tap settings-save" "perf frames live 6000" "tap tab-$tab" "perf frames live 8000" "perf frames live 30000" "perf frames report" "perf frames live 12000" "logs" "screenshot $R/shot-$label.png")
    winA=2; winB=3; secs=28 ;;
  idle-*|paused-*|idlerm-*)
    tab=${mode#*-}; port=8422
    (cd $MOCKD/app && nohup timeout 600 bun server/mock.ts --fixtures ../contract/fixtures --frozen --port $port > $R/mock-$label.log 2>&1 < /dev/null & echo $! > $R/mock-$label.pid); spid=$(cat $R/mock-$label.pid)
    if [ ${mode%%-*} = paused ]; then
      ops=("tap now-setup-connect" "type server-field http://127.0.0.1:$port" "tap settings-save" "perf frames live 6000" "tap tab-yard" "perf frames live 1500" "tap pause" "tap tab-$tab" "perf frames live 6000" "perf frames live 30000" "perf frames live 28000" "logs" "screenshot $R/shot-$label.png")
      winA=3
    elif [ ${mode%%-*} = idlerm ]; then
      ops=("prefer prefers-reduced-motion reduce" "tap now-setup-connect" "type server-field http://127.0.0.1:$port" "tap settings-save" "perf frames live 6000" "tap tab-$tab" "perf frames live 6000" "perf frames live 30000" "perf frames live 28000" "logs" "screenshot $R/shot-$label.png")
      winA=2
    else
      ops=("tap now-setup-connect" "type server-field http://127.0.0.1:$port" "tap settings-save" "perf frames live 6000" "tap tab-$tab" "perf frames live 6000" "perf frames live 30000" "perf frames live 28000" "logs" "screenshot $R/shot-$label.png")
      winA=2
    fi
    winB=99; secs=56 ;;
esac
sleep 2
st="p7$(date +%s)$RANDOM"
log=$R/drive-$label.log
timeout 400 bun tools/perf-drive.mjs macos --storage $st --size 1440x900 "${ops[@]}" > $log 2>&1 &
ap=$!
pid=""; for i in $(seq 1 300); do pid=$(pgrep -n -f "$D/app/target/.*/Switchyard"); [ -n "$pid" ] && break; sleep 1; done
echo "app pid $pid canvas=${CANVAS:-default}" > $log.meta
for i in $(seq 1 300); do [ $(grep -c "^callbacks" $log) -ge $winA ] && break; sleep 0.5; done
la=$(uptime | sed 's/.*averages: //')
sleep 1; c0=$(cpu $pid); w0=$(date +%s); c1=$c0; w1=$w0
smp=0
for i in $(seq 1 $((secs/2))); do
  sleep 2; c=$(cpu $pid); [ -z "$c" ] && break; c1=$c; w1=$(date +%s)
  if [ "$SAMPLE" = 1 ] && [ $winB = 99 ] && [ $i = 10 ] && [ $smp = 0 ]; then smp=1; (timeout 30 sample $pid 10 -file $R/sample-$label.txt > /dev/null 2>&1 &); fi
done
lb=$(uptime | sed 's/.*averages: //')
if [ "$SAMPLE" = 1 ] && [ $winB != 99 ]; then
  for i in $(seq 1 120); do [ $(grep -c "^callbacks" $log) -ge $winB ] && break; sleep 0.5; done
  sleep 2; timeout 30 sample $pid 6 -file $R/sample-$label.txt > /dev/null 2>&1
fi
wait $ap; rc=$?
[ -n "$spid" ] && kill $spid 2>/dev/null
{
  echo "== $label ($mode, canvas ${CANVAS:-default}) $(date +%T) rc=$rc · cpu $(awk -v a=$c0 -v b=$c1 -v w=$((w1-w0)) 'BEGIN{ if (b=="" || w<=0) print "?"; else printf "%.2f%%", (b-a)*100/w}') over $((w1-w0)) s · load $la → $lb"
  grep -E "^(callbacks|frame time|work records)" $log | sed 's/^/   /'
  echo "   snapshot GETs $(grep -c 'GET .*/api/v1/snapshot' $log) · stream opens $(grep -c 'GET ws.*/api/v1/t\?stream' $log) · stream ended $(grep -c 'stream ended' $log)"
  grep -h 'canvas stats' $log 2>/dev/null | sed 's/.*canvas stats/canvas stats/' | sed 's/module [0-9.]* MB; //' | sort | uniq -c | sort -rn | head -6 | sed 's/^/   /'
  grep -h 'canvas: SWITCHYARD_CANVAS' $log 2>/dev/null | head -1 | sed 's/^/   /'
} >> $OUT
