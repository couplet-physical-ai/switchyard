#!/bin/sh
# Apply Switchyard's Exact patches to an Exact checkout: app/scripts/patch-exact.sh <exact dir>
# Every scripts/exact-patches/*.patch, in name order, to the working tree (HEAD stays at the pin).
# Idempotent: a patch that reverse-applies cleanly is already in and is skipped. Otherwise
# `git apply --check` first, then `git apply`; a patch that neither applies nor is in exits 1.
# Called by scripts/fetch-exact.sh (after checkout, before setup) and by the release paths
# (sy-ship's scripts/release/*, right after their own checkout of the pin).
set -eu
dir=${1:?usage: patch-exact.sh <exact checkout dir>}
patches=$(cd "$(dirname "$0")" && pwd)/exact-patches
[ -d "$dir/.git" ] || [ -f "$dir/.git" ] || { echo "patch-exact: $dir is not a git checkout" >&2; exit 1; }
export GIT_TERMINAL_PROMPT=0
for p in "$patches"/*.patch; do
  [ -f "$p" ] || continue
  name=$(basename "$p")
  if git -C "$dir" apply --reverse --check "$p" >/dev/null 2>&1; then
    echo "patch-exact: $name already in $dir" >&2
    continue
  fi
  if ! git -C "$dir" apply --check "$p"; then
    echo "patch-exact: $name neither applies to nor is in $dir (exact $(git -C "$dir" rev-parse --short HEAD)): refresh the patch for this pin" >&2
    exit 1
  fi
  git -C "$dir" apply "$p"
  echo "patch-exact: applied $name to $dir" >&2
done
