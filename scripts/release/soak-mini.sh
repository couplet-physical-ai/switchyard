#!/usr/bin/env bash
# Live soak of the installed release on the Mac mini: /Applications' Switchyard connected to the live
# server for <minutes> (default 20), its RSS sampled every minute, then:
#   - the process must still be alive (0.1.3 died of a Hermes OOM after ~18 min live),
#   - RSS must plateau: the last <SY_SOAK_TAIL> minutes (default 5) may grow at most
#     SY_SOAK_TAIL_PCT % (default 8), and the end may be at most SY_SOAK_HALF_PCT % (default 25)
#     above the RSS at the halfway minute.
#   - the JS heap must plateau the same way when the app logs `heap:` lines (0.1.5+): RSS alone
#     does not show the leak (0.1.4 here: RSS flat at 173 MB, then a Hermes OOM at minute 4 — the
#     JS heap hits its own cap). SY_SOAK_NEED_HEAP=1 fails a run with no heap lines.
#   - SY_SOAK_HEAP_CAP_MB=<n>: the max heap over the last 10 minutes must be ≤ n;
#   - no new Switchyard crash report (.ips) in ~/Library/Logs/DiagnosticReports during the run
#     (a GCBase::oom one is named as such).
# fps is derived from the heap line's `frames <n>` (a running count) when present.
# Numbers in a heap line: the first `<n>MB`/`<n>mb`/`used=<n>` is read as the used heap in MB.
#
#   SY_TOKEN_FILE=<local 600 file> scripts/release/soak-mini.sh <version> [minutes]
#
# SY_SOAK_CYCLE=live:8,factory:8,yard:9 (0.1.6+) cycles the views: each segment opens
# switchyard://view/<name> in the running app, requires its `route: /<name>` log line (Live is
# `route: /`), and is gated on its own: the heap cap and plateau over the segment (its first
# minute is the switch) and its least-squares heap slope ≤ SY_SOAK_SLOPE_MB_MIN (0.3) and external
# slope ≤ SY_SOAK_EXT_SLOPE_MB_MIN (0.05) (external memory is what leaked in 0.1.3/0.1.4), on
# segments of ≥ 10 min its second-half mean at most SY_SOAK_HALF_MB (1.5) above the first, and
# frames > 0 on the Yard. A Live segment of ≥ 12 min must also show no slow creep on its post-GC
# floor (each minute's lowest heap sample, CSV column heapmin): floor slope ≤ SY_SOAK_LIVE_SLOPE_MB_MIN
# (0.1 MB/min) OR floor half-means ≤ +SY_SOAK_LIVE_HALF_MB (1 MB); when both legs are within 20 %
# of their limits the run is BORDERLINE (exit 3: report, do not promote). Use ≥ 15-min segments: an 8-min slope is ±0.25 MB/min by GC noise alone. A Factory segment with 0 frames is only
# reported (the board draws when a run changes place). The total length is the segments' sum.
#
# The token goes over as a 600 file (never argv or a URL) and is deleted afterwards. The app is
# quit at the end (only /Applications' copy; dev builds share the bundle id). CSV: /tmp/sy-soak-<v>.csv
set -euo pipefail
V=${1:?version}; MIN=${2:-20}
CYCLE=${SY_SOAK_CYCLE:-}
if [[ -n "$CYCLE" ]]; then
  MIN=0; for seg in ${CYCLE//,/ }; do
    [[ "$seg" =~ ^(live|factory|yard):[0-9]+$ ]] || { echo "bad SY_SOAK_CYCLE segment $seg (want live|factory|yard:<min>)" >&2; exit 2; }
    MIN=$(( MIN + ${seg#*:} ))
  done
fi
HOST=${SY_MINI:-mini-user@192.0.2.1}
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 "$HOST")
DIR=/Users/${HOST%@*}/.switchyard-e2e
TAIL=${SY_SOAK_TAIL:-5}; TAIL_PCT=${SY_SOAK_TAIL_PCT:-8}; HALF_PCT=${SY_SOAK_HALF_PCT:-25}
[[ -n "${SY_TOKEN_FILE:-}" ]] || { echo "SY_TOKEN_FILE is required (a live soak)" >&2; exit 1; }
[[ "$(stat -c %a "$SY_TOKEN_FILE")" == 600 ]] || { echo "$SY_TOKEN_FILE must be mode 600" >&2; exit 1; }
TOK_REMOTE=$DIR/secret/token
tar -C "$(dirname "$SY_TOKEN_FILE")" -cf - "$(basename "$SY_TOKEN_FILE")" \
  | timeout 60 "${SSH[@]}" "umask 077 && mkdir -p '$DIR/secret' && tar -C '$DIR/secret' -xOf - > '$TOK_REMOTE' && chmod 600 '$TOK_REMOTE'"
cleanup() { timeout 60 "${SSH[@]}" "rm -P '$TOK_REMOTE' 2>/dev/null || rm -f '$TOK_REMOTE'; rmdir '$DIR/secret' 2>/dev/null || true" || true; }
trap cleanup EXIT

CSV=/tmp/sy-soak-$V.csv
out=$(timeout $(( MIN * 60 + 600 )) "${SSH[@]}" 'f=$(mktemp); cat > "$f"; bash "$f" </dev/null 2>&1; rc=$?; rm -f "$f"; exit $rc' <<EOF
set -euo pipefail
A=/Applications/Switchyard.app
P='^/Applications/Switchyard.app/Contents/MacOS/Switchyard'
gui() { sudo -n launchctl asuser \$(id -u) sudo -n -u \$(id -un) "\$@"; }
quit_() {
  pkill -f "\$P" || return 0
  for i in \$(seq 1 15); do sleep 1; pgrep -f "\$P" >/dev/null || return 0; done
  pkill -KILL -f "\$P" || true; sleep 1
}
v=\$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "\$A/Contents/Info.plist")
[[ "\$v" == "$V" ]] || { echo "FAIL: /Applications has \$v, not $V" >&2; exit 1; }
quit_
LOG=~/Library/Logs/Switchyard/switchyard.log; mkdir -p ~/Library/Logs/Switchyard; touch \$LOG
M=\$(mktemp); trap 'rm -f \$M' EXIT
gui open --env SWITCHYARD_TOKEN_FILE=$TOK_REMOTE "\$A"
pid=""; for i in \$(seq 1 40); do pid=\$(pgrep -f "\$P" | head -1 || true); [[ -n "\$pid" ]] && break; sleep 0.25; done
[[ -n "\$pid" ]] || { echo "FAIL: $V did not start" >&2; exit 1; }
for i in \$(seq 1 40); do grep -q "pid \$pid token-file: connected" \$LOG && break; sleep 1; done
grep -q "pid \$pid token-file: connected" \$LOG || { quit_; echo "FAIL: $V (pid \$pid) did not connect live" >&2; exit 1; }
echo "soak: $V pid \$pid connected live; $MIN min, RSS every minute"
# the view schedule: minute → view (empty CYCLE: one segment, the default view)
sched=""; at=0
for seg in ${CYCLE//,/ }; do sched="\$sched \$at:\${seg%%:*}"; at=\$(( at + \${seg#*:} )); done
view=default
route_() {  # switch the running app to view \$1 and require its route line
  local want=/\$1; [[ \$1 == live ]] && want=/
  local L0=\$(wc -l < \$LOG)
  gui open "switchyard://view/\$1"
  for i in \$(seq 1 30); do tail -n +\$((L0+1)) \$LOG | grep -q "pid \$pid route: \$want\$" && break
    grep -q "pid \$pid route: \$want\$" \$LOG && [[ "\$(grep "pid \$pid route:" \$LOG | tail -1 | sed 's/.*route: //')" == "\$want" ]] && break; sleep 1; done
  [[ "\$(grep "pid \$pid route:" \$LOG | tail -1 | sed 's/.*route: //')" == "\$want" ]] || { quit_; echo "FAIL: no 'route: \$want' after switchyard://view/\$1" >&2; exit 1; }
  echo "view: \$1 (route: \$want) at minute \$m"
}
HL=\$(wc -l < \$LOG)
echo "CSV,minute,rss_mb,heap,view,heapmin"
for m in \$(seq 0 $MIN); do
  [[ \$m -gt 0 ]] && sleep 60
  for e in \$sched; do [[ \${e%%:*} == \$m ]] && { view=\${e#*:}; route_ \$view; }; done
  if ! kill -0 \$pid 2>/dev/null; then
    echo "FAIL: $V (pid \$pid) died at minute \$m" >&2
    ls -t ~/Library/Logs/DiagnosticReports/Switchyard* 2>/dev/null | head -1 | sed 's/^/crash report: /'
    grep "pid \$pid " \$LOG | tail -3
    exit 1
  fi
  rss=\$(ps -o rss= -p \$pid | tr -d ' '); heap=\$(grep "pid \$pid heap:" \$LOG | tail -1 | sed 's/.* heap: *//' | cut -c1-80 || true)
  # the minute's post-GC floor: the lowest heap: total logged since the last sample
  hmin=\$(tail -n +\$((HL+1)) \$LOG | grep "pid \$pid heap:" | sed -E 's/.* heap: *([0-9.]+).*/\1/' | sort -n | head -1 || true)
  HL=\$(wc -l < \$LOG)
  echo "CSV,\$m,\$((rss / 1024)),\${heap:-},\$view,\${hmin:-}"
done
quit_
for f in \$(find ~/Library/Logs/DiagnosticReports -name 'Switchyard*.ips' -newer \$M 2>/dev/null); do
  echo "FAIL: crash report during the soak: \$f\$(grep -q 'GCBase::oom' "\$f" && echo ' (GCBase::oom)')" >&2; exit 1
done
echo "crash reports during the soak: none"
echo SOAK-DONE
EOF
) || { echo "$out"; echo "soak: FAILED" >&2; exit 1; }
echo "$out" | grep -v '^CSV,'
echo "$out" | grep '^CSV,' | cut -d, -f2- > "$CSV"
cat "$CSV"
grep -qx SOAK-DONE <<<"$out" || { echo "soak: did not reach the end" >&2; exit 1; }
python3 - "$CSV" "$MIN" "$TAIL" "$TAIL_PCT" "$HALF_PCT" "${SY_SOAK_NEED_HEAP:-0}" "${SY_SOAK_HEAP_CAP_MB:-0}" <<'PY'
import csv, os, re, sys
path, n, tail, tail_pct, half_pct, need_heap, cap = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), sys.argv[6] == "1", float(sys.argv[7])
rows = [r for r in csv.DictReader(open(path))]

def plateau(name, xs):
    t = min(tail, len(xs) - 1)
    end, half, t0 = xs[-1], xs[len(xs) // 2], xs[-1 - t]
    tg = 100.0 * (end - t0) / t0; hg = 100.0 * (end - half) / half
    ok = tg <= tail_pct and hg <= half_pct
    print(f"{name}: start {xs[0]:g}, min {min(xs):g}, max {max(xs):g}, half {half:g}, end {end:g}; last {t} min {tg:+.1f}% "
          f"(≤ {tail_pct}%), end vs half {hg:+.1f}% (≤ {half_pct}%) → {'plateau' if ok else 'GROWING'}")
    return ok

ok = plateau("RSS MB", [float(r["rss_mb"]) for r in rows])
def mb(h):
    m = re.search(r"used=([0-9.]+)", h) or re.search(r"([0-9.]+)\s*[mM][bB]", h)
    return float(m.group(1)) if m else None
heap = [mb(r["heap"]) for r in rows if r["heap"]]
heap = [h for h in heap if h is not None]
cycled = any((r.get("view") or "default") != "default" for r in rows)
if len(heap) >= 3:
    # cycled: the heap legitimately steps at a view switch, so its plateau is gated per segment below
    hp = plateau("JS heap MB", heap)
    if cycled: print("  (whole-run heap plateau reported only: SY_SOAK_CYCLE gates it per segment)")
    else: ok = hp and ok
    if cap > 0:
        last10 = max(heap[-11:])
        print(f"JS heap: max over the last 10 min {last10:g} MB (cap {cap:g})")
        ok = ok and last10 <= cap
elif need_heap: print("FAIL: no heap: lines from the app (SY_SOAK_NEED_HEAP=1)"); ok = False
else: print("JS heap: no heap: lines logged (RSS only; RSS did not show 0.1.4's leak)")
# fps from the heap line's running frame count (`frames <n>`), when it has one
fr = [(i, re.search(r"frames\s+([0-9]+)", r["heap"])) for i, r in enumerate(rows)]
fr = [(i, int(m.group(1))) for i, m in fr if m]
if len(fr) >= 2:
    fps = [(b[1] - a[1]) / (60.0 * (b[0] - a[0])) for a, b in zip(fr, fr[1:]) if b[0] > a[0] and b[1] >= a[1]]
    if fps: print(f"fps (from frames): first {fps[0]:.1f}, last {fps[-1]:.1f}, min {min(fps):.1f}, mean {sum(fps)/len(fps):.1f}")
def slope(xs):
    n = len(xs); mx = (n - 1) / 2.0; my = sum(xs) / n
    return sum((i - mx) * (x - my) for i, x in enumerate(xs)) / sum((i - mx) ** 2 for i in range(n))
def ext(h):
    m = re.search(r"ext\s+([0-9.]+)", h); return float(m.group(1)) if m else None
slope_max = float(os.environ.get("SY_SOAK_SLOPE_MB_MIN", "0.3"))
ext_max = float(os.environ.get("SY_SOAK_EXT_SLOPE_MB_MIN", "0.05"))
half_max = float(os.environ.get("SY_SOAK_HALF_MB", "1.5"))
live_slope_max = float(os.environ.get("SY_SOAK_LIVE_SLOPE_MB_MIN", "0.1"))
live_half_mb = float(os.environ.get("SY_SOAK_LIVE_HALF_MB", "1"))
borderline = []
# per view segment (SY_SOAK_CYCLE): its own heap cap + plateau, and frames > 0 on the Yard
segs = []
for i, r in enumerate(rows):
    v = r.get("view") or "default"
    if not segs or segs[-1][0] != v or (i and rows[i-1].get("view") != v): segs.append((v, []))
    segs[-1][1].append(r)
if cycled:
    for v, rs in segs:
        hs = [mb(r["heap"]) for r in rs[1:] if r["heap"]]; hs = [h for h in hs if h is not None]
        fs = [int(m.group(1)) for m in (re.search(r"frames\s+([0-9]+)", r["heap"]) for r in rs) if m]
        dfr = (fs[-1] - fs[0]) if len(fs) >= 2 else 0
        mins = max(1, len(rs) - 1)
        line = f"segment {v} ({mins} min): frames +{dfr} ({dfr / (60.0 * mins):.1f} fps)"
        if hs:
            line += f", heap {hs[0]:g} → {hs[-1]:g} MB, max {max(hs):g}"
            if cap > 0 and max(hs) > cap: line += f" OVER CAP {cap:g}"; ok = False
            # least-squares slopes: a GC sawtooth swings ±2 MB minute to minute, so two single samples
            # (the old "last 3 min" check) trip on a peak; a slope over the segment does not.
            if len(hs) >= 4:
                hsl = slope(hs); line += f", slope {hsl:+.2f} MB/min (≤ {slope_max:g})"
                if hsl > slope_max: line += " GROWING"; ok = False
            if len(hs) >= 10:  # half-means: robust to the sawtooth on ≥ 10-min segments
                k = len(hs) // 2; d = sum(hs[k:]) / (len(hs) - k) - sum(hs[:k]) / k
                line += f", half-means {d:+.2f} MB (≤ {half_max:g})"
                if d > half_max: line += " HALVES GROWING"; ok = False
            # slow creep where nothing redraws (Live): the post-GC floor (each minute's lowest heap
            # sample), not the raw samples — an 8-min raw slope is ±0.25 MB/min from GC noise alone
            fl = [float(r["heapmin"]) for r in rs[1:] if r.get("heapmin")]
            if v == "live" and len(fl) >= 12:
                k = len(fl) // 2; fsl = slope(fl); fh = sum(fl[k:]) / (len(fl) - k) - sum(fl[:k]) / k
                creep_ok = fsl <= live_slope_max or fh <= live_half_mb
                line += (f", creep (post-GC floor): slope {fsl:+.3f} (≤ {live_slope_max:g}) or half-means {fh:+.2f} MB"
                         f" (≤ {live_half_mb:g}) → {'ok' if creep_ok else 'CREEP'}")
                if not creep_ok: ok = False
                # borderline: both legs within 20 % of their limits → report, do not promote
                if creep_ok and fsl > 0.8 * live_slope_max and fh > 0.8 * live_half_mb:
                    line += " BORDERLINE"; borderline.append(f"live floor slope {fsl:+.3f}, half-means {fh:+.2f} MB")
            elif v == "live" and len(rs) >= 13:
                line += " — FAIL: no post-GC floor (heapmin) samples"; ok = False
            es = [ext(r["heap"]) for r in rs[1:] if r["heap"]]; es = [e for e in es if e is not None]
            if len(es) >= 4:
                esl = slope(es); line += f", ext slope {esl:+.3f} (≤ {ext_max:g})"
                if esl > ext_max: line += " EXT GROWING"; ok = False
        if v == "yard" and dfr <= 0: line += " — FAIL: the Yard drew no frames"; ok = False
        if v == "factory" and dfr <= 0: line += " (no run changed place: reported, not gated)"
        print(line)
print(f"soak: alive {n} min, " + ("all memory/frame gates pass" if ok else "a memory/frame gate FAILED (see above)"))
if ok and borderline:
    print("soak: BORDERLINE (report, do not promote): " + "; ".join(borderline)); sys.exit(3)
sys.exit(0 if ok else 1)
PY
echo "soak: $V OK"
