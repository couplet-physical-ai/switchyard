#!/bin/sh
# Fetch expo/exact at the commit app/exact.pin names, apply our Exact patches, and set it up,
# once per machine. Prints the checkout's path last, so `EXACT2=$(app/scripts/fetch-exact.sh | tail -1)` works.
#   EXACT2=<dir>   use (and if missing, create) this checkout instead of the cache
# Exact has no releases: an app builds against a checkout by path (docs/start-here.md).
# Patches: scripts/patch-exact.sh applies scripts/exact-patches/*.patch after checkout and before
# setup (idempotent, loud). The cache directory's name carries a hash of the patches, so a
# patched checkout never collides with the plain pin's.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
pin=$(tr -d ' \n' < "$here/exact.pin")
patches=$here/scripts/exact-patches
phash=
if ls "$patches"/*.patch >/dev/null 2>&1; then
  phash=$(cat "$patches"/*.patch | git hash-object --stdin | cut -c1-12)
fi
dir=${EXACT2:-${XDG_CACHE_HOME:-$HOME/.cache}/switchyard/exact-$pin${phash:+-p$phash}}
export GIT_TERMINAL_PROMPT=0

if [ ! -d "$dir/.git" ]; then
  mkdir -p "$(dirname "$dir")"
  timeout 900 git clone -q --filter=blob:none https://github.com/expo/exact.git "$dir" >&2
fi
if [ "$(git -C "$dir" rev-parse HEAD)" != "$pin" ]; then
  timeout 300 git -C "$dir" fetch -q origin >&2 || true
  git -C "$dir" checkout -q "$pin" >&2
fi
"$here/scripts/patch-exact.sh" "$dir" >&2
if [ ! -f "$dir/.switchyard-setup-$pin" ]; then
  # Exact wants Bun 1.4.2 exactly; its setup installs Rust toolchains, wasm-bindgen, Binaryen, Chromium.
  (cd "$dir" && timeout 600 bun install --frozen-lockfile >&2 && timeout 3600 bun scripts/exact.mjs setup >&2) && touch "$dir/.switchyard-setup-$pin"
fi
echo "$dir"
