#!/bin/bash
# p7: fetch the mini's results to $OUT (default /tmp/p7/mini) and judge them.
#   MINI=user@host bash app/tools/p7/collect.sh [out dir]
# Pass: Live idle with timers, head mean <= 1.5 %; board/Yard idle head <= base + 0.15 pp; paused <= 0.2 %;
# busy fps head >= base - 0.3 and board/Yard >= 59; the window pictures base vs head identical
# step by step (or differing only where base vs base2 differs); TextTouchedMacTests and the other
# XCTest classes pass (or fail the same on base); the macOS suite rc=0.
set -u
: "${MINI:?MINI=user@host of the Mac mini}"
F=/Volumes/Farm/farm-exowatt
OUT=${1:-/tmp/p7/mini}; mkdir -p "$OUT"
here=$(cd "$(dirname "$0")" && pwd)
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 $MINI"
timeout 300 $SSH "cd $F && tar czf - p7-all.log p7-results.txt p7-build-*.log p7-xctest-*.log p7-macos-suite.log p7-shots p7-runs/sample-*.txt p7-runs/drive-*.log 2>/dev/null" | tar xzf - -C "$OUT"
echo "== p7-all.log (steps)"; grep "^===" "$OUT/p7-all.log"
echo; echo "== CPU (p7-results.txt)"
grep "^== " "$OUT/p7-results.txt" | sed 's/ (.*rc=/ rc=/'
python3 - "$OUT/p7-results.txt" <<'EOF'
import re, sys, collections
runs = collections.defaultdict(list); fps = collections.defaultdict(list)
cur = None
for line in open(sys.argv[1]):
    m = re.match(r'== (prof-)?(head|base)-(\w+-\w+?)\d* \(.*cpu ([0-9.]+)%', line)
    if m and not m.group(1): cur = (m.group(2), m.group(3)); runs[cur].append(float(m.group(4))); continue
    if line.startswith('== '): cur = None
    m = re.search(r'callbacks \d+ .* ([0-9.]+) FPS', line)
    if m and cur and cur[1].startswith('busy'): fps[cur].append(float(m.group(1)))
mean = lambda v: sum(v) / len(v) if v else float('nan')
ok = True
print(f"{'mode':16} {'base %':>16} {'head %':>16}  fps base / head")
for mode in sorted({k[1] for k in runs}):
    b, h = runs[('base', mode)], runs[('head', mode)]
    fb, fh = fps[('base', mode)], fps[('head', mode)]
    print(f"{mode:16} {mean(b):6.2f} {str(b):>9} {mean(h):6.2f} {str(h):>9}  {fb} / {fh}")
    if mode == 'idle-now' and not mean(h) <= 1.5: ok = False; print('   FAIL: Live idle with timers > 1.5 %')
    if mode in ('idle-factory', 'idle-yard') and not mean(h) <= mean(b) + 0.15: ok = False; print('   FAIL: idle regression')
    if mode.startswith('paused') and not mean(h) <= 0.2: ok = False; print('   FAIL: paused > 0.2 %')
    if mode.startswith('busy') and fb and fh and mean(fh) < mean(fb) - 0.3: ok = False; print('   FAIL: busy fps regression')
    if mode in ('busy-factory', 'busy-yard') and fh and mean(fh) < 59: ok = False; print('   FAIL: busy < 59 fps')
print('CPU:', 'PASS' if ok else 'FAIL')
EOF
echo; echo "== pictures (window server), step by step"
for pair in "base head" "base base2" "head head2"; do set -- $pair; echo "-- $1 vs $2"; python3 "$here/cmpshots.py" "$OUT/p7-shots/$1" "$OUT/p7-shots/$2" "$OUT/p7-shots/diff-$1-$2" 2>/dev/null; done
echo; echo "== profiles: refreshVisibleText and the main thread (samples)"
for s in "$OUT"/p7-runs/sample-prof-*.txt; do [ -f "$s" ] || continue
  echo "-- $(basename $s): $(grep -c . $s) lines; refreshVisibleText $(grep -m1 'Presenter.refreshVisibleText' $s | sed 's/^[ +!:|]*//' | cut -c1-60); TextViewportIndex.init $(grep -m1 'TextViewportIndex.init' $s | sed 's/^[ +!:|]*//' | cut -c1-40)"
  [ -f /tmp/p6/samp.py ] && python3 /tmp/p6/samp.py "$s" 8 2>/dev/null | sed -n '1,6p'
done
echo; echo "== XCTests"; for l in "$OUT"/p7-xctest-*.log; do [ -f "$l" ] && { echo "-- $(basename $l)"; grep -E "Executed|error:|failed|xctest rc" "$l" | tail -12; }; done
echo; echo "== macOS suite"; tail -3 "$OUT/p7-macos-suite.log" 2>/dev/null
