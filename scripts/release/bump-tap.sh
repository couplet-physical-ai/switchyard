#!/usr/bin/env bash
# Move the tap's cask to a published release: download its SHA256SUMS and zip, check the zip
# hashes to its line, render packaging/homebrew/switchyard.rb.in into a fresh clone of the tap
# and push it (scripts/release/bump-cask.sh --push).
#   scripts/release/bump-tap.sh 0.1.9
# Needs gh, authenticated with push to the tap.
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
V=${1:?version}; V=${V#v}
REPO=couplet-physical-ai/switchyard TAP=couplet-physical-ai/homebrew-tap
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
zip="Switchyard-$V-arm64.zip"
timeout 300 gh release download "v$V" -R "$REPO" -p SHA256SUMS -p "$zip" -D "$work"
sha=$(awk -v f="$zip" '$2 == f {print $1}' "$work/SHA256SUMS")
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "no sha256 for $zip in v$V's SHA256SUMS" >&2; exit 1; }
real=$(shasum -a 256 "$work/$zip" | cut -d' ' -f1)
[[ "$real" == "$sha" ]] || { echo "SHA256SUMS says $sha, the asset is $real" >&2; exit 1; }
timeout 120 gh repo clone "$TAP" "$work/tap" -- -q --depth 1
scripts/release/bump-cask.sh "$V" "$sha" "$work/tap" --push
