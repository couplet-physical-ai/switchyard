#!/usr/bin/env bash
# Write Casks/switchyard.rb in a checkout of couplet-physical-ai/homebrew-tap.
#   scripts/release/bump-cask.sh <version> <sha256 of the zip> <tap checkout> [--push]
# --push commits ("switchyard <version>") and pushes to the tap's main.
set -euo pipefail
here=$(cd "$(dirname "$0")/../.." && pwd)
V=${1:?version} SHA=${2:?sha256} TAP=${3:?tap checkout}
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "bad sha256 $SHA" >&2; exit 2; }
BUNDLE_ID=${SWITCHYARD_BUNDLE_ID:-com.exowatt.switchyard}
mkdir -p "$TAP/Casks"
sed -e "s/@VERSION@/$V/" -e "s/@SHA256@/$SHA/" -e "s/@BUNDLE_ID@/$BUNDLE_ID/g" \
  "$here/packaging/homebrew/switchyard.rb.in" > "$TAP/Casks/switchyard.rb"
if command -v ruby >/dev/null; then ruby -c "$TAP/Casks/switchyard.rb" >/dev/null; fi
if [[ "${4:-}" == --push ]]; then
  cd "$TAP"
  git add Casks/switchyard.rb
  if git diff --cached --quiet; then echo "cask already at $V"; exit 0; fi
  git -c user.name="${GIT_AUTHOR_NAME:-switchyard-release}" -c user.email="${GIT_AUTHOR_EMAIL:-switchyard-release@users.noreply.github.com}" \
    commit -qm "switchyard $V"
  GIT_TERMINAL_PROMPT=0 timeout 120 git push -q origin HEAD:main
  echo "tap: switchyard $V pushed ($(git rev-parse --short HEAD))"
fi
