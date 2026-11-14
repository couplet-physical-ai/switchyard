#!/bin/bash
# p7-text's proof of exact-patches/0005 on the Mac mini, ONE command from the devbox, once the mini is free:
#   MINI=user@host bash app/tools/p7/kit.sh        (from this worktree; ~75-90 min on the mini, detached)
# It makes two APFS clones there: switchyard-client-p7 (this tree: 3e4d2df + 0005) and
# switchyard-client-p7-base (3e4d2df, `git archive`, no 0005). It syncs them, then starts
# app/tools/p7/p7-all.sh detached. That makes two private Exact copies (head 0001-0005, base
# 0001-0004), builds both, runs the interleaved CPU batch, the pixel drives, Exact's XCTests and
# the macOS suite. Progress: ssh $MINI tail -f /Volumes/Farm/farm-exowatt/p7-all.log.
# Results: MINI=… bash app/tools/p7/collect.sh. Cleanup: MINI=… bash app/tools/p7/cleanup.sh.
set -u
: "${MINI:?MINI=user@host of the Mac mini}"
F=/Volumes/Farm/farm-exowatt
here=$(cd "$(dirname "$0")" && pwd); app=$(cd "$here/../.." && pwd); repo=$(cd "$app/.." && pwd)
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 $MINI"
export GIT_TERMINAL_PROMPT=0
timeout 30 $SSH "df -h /Volumes/Farm | tail -1; uptime; ls -d $F/switchyard-client-p7* $F/switchyard-exact-p7* 2>/dev/null; pgrep -fl 'p7-all.sh' || true" || exit 1
free=$(timeout 30 $SSH "df -g /Volumes/Farm | tail -1 | awk '{print \$4}'")
[ "${free:-0}" -ge 20 ] || { echo "ABORT: /Volumes/Farm has ${free:-?} GB free (< 20)"; exit 1; }
for c in p7 p7-base; do
  timeout 600 $SSH "cd $F && [ -d switchyard-client-$c ] || (cp -cR switchyard-client switchyard-client-$c && cd switchyard-client-$c/app && find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +)" || exit 1
done
MINI=$MINI MINI_DIR=$F/switchyard-client-p7 timeout 300 sh "$app/tools/mini-sync.sh" || exit 1
tmp=$(mktemp -d /tmp/p7-base.XXXXXX)
git -C "$repo" archive 3e4d2df app contract/fixtures contract/CONTRACT.md | tar x -C "$tmp" || exit 1
[ ! -e "$tmp/app/scripts/exact-patches/0005-mac-text-pass-touched-only.patch" ] || { echo "ABORT: base tree has 0005"; exit 1; }
MINI=$MINI MINI_DIR=$F/switchyard-client-p7-base timeout 300 sh "$tmp/app/tools/mini-sync.sh" || exit 1
rm -rf "$tmp"
git -C "$repo" rev-parse --short HEAD | timeout 30 $SSH "cat > $F/switchyard-client-p7/app/.p7-head"
timeout 60 $SSH "rm -rf $F/switchyard-client-p7/app/target $F/switchyard-client-p7-base/app/target; ls $F/switchyard-client-p7/app/scripts/exact-patches; echo base:; ls $F/switchyard-client-p7-base/app/scripts/exact-patches" || exit 1
timeout 30 $SSH "rm -f $F/p7-results.txt; (nohup bash $F/switchyard-client-p7/app/tools/p7/p7-all.sh > $F/p7-all.log 2>&1 < /dev/null &); sleep 3; cat $F/p7-all.log" || exit 1
echo "started: ssh $MINI tail -f $F/p7-all.log   (DONE or ABORT ends it)"
