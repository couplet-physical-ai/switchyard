#!/usr/bin/env bash
# Cut a Switchyard release with one command:
#
#   scripts/release.sh 0.1.0            # tag v0.1.0 on origin/main, build + sign + notarize on the
#                                       # release Mac, publish, bump the tap
#   scripts/release.sh 0.1.0 --dry-run  # print what would happen
#   scripts/release.sh 0.1.5 --gate     # publish as a PRERELEASE (not Latest, tap untouched) for
#                                       # the mini gates (RELEASING.md "Gated releases")
#   scripts/release.sh 0.1.5 --promote  # after the gates pass: make it Latest, bump the tap
#
# 1. checks origin/main's HEAD is green (every finished check run of the commit passed or was
#    skipped, none still running; --skip-ci to bypass);
# 2. tags it v<version> (annotated) and pushes the tag;
# 3. runs scripts/release/release-mac-mini.sh at that commit: the release Mac builds the arm64
#    .app, signs it with the Developer ID, notarizes and staples the app and the dmg, and this
#    machine publishes zip + dmg + SHA256SUMS + latest.json and moves the tap's cask
#    (scripts/release/bump-tap.sh). Installed apps see it through latest.json and their Update
#    button.
# Needs: gh (authenticated, push to this repo and the tap), git, ssh to the release Mac, and the
# site configuration in the environment (MINI or SY_MINI, SWITCHYARD_DEFAULT_SERVER,
# SWITCHYARD_ORGS; packaging/RELEASING.md).
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
V=${1:?usage: scripts/release.sh <version> [--dry-run] [--skip-ci] [--gate] [--promote]}; shift
V=${V#v}
DRY=0 SKIPCI=0 GATE=0 PROMOTE=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; --skip-ci) SKIPCI=1 ;; --gate) GATE=1 ;; --promote) PROMOTE=1 ;; *) echo "unknown $a" >&2; exit 2 ;; esac; done
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || { echo "bad version $V" >&2; exit 2; }
REPO=couplet-physical-ai/switchyard
cd "$(dirname "$0")/.."
if [[ $PROMOTE == 1 ]]; then
  [[ "$(gh release view "v$V" -R "$REPO" --json isPrerelease --jq .isPrerelease)" == true ]] || { echo "v$V is not a prerelease (already promoted?)" >&2; exit 1; }
  [[ $DRY == 1 ]] && { echo "dry run: would make v$V Latest and bump the tap"; exit 0; }
  gh release edit "v$V" -R "$REPO" --prerelease=false --latest >/dev/null
  echo "v$V is Latest: $(curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])') on the stable feed"
  scripts/release/bump-tap.sh "$V"
  echo "done: installed apps offer Update (latest.json); brew upgrade --cask --greedy switchyard also works"; exit 0
fi
timeout 60 git fetch -q origin main --tags
sha=$(git rev-parse origin/main)
if git rev-parse -q --verify "refs/tags/v$V" >/dev/null; then echo "tag v$V already exists" >&2; exit 1; fi
echo "release v$V at origin/main ${sha::7}: $(git log -1 --format=%s "$sha")"
if [[ $SKIPCI == 0 ]]; then
  # name<TAB>status<TAB>conclusion of every check run on the commit.
  checks=$(timeout 120 gh api "repos/$REPO/commits/$sha/check-runs?per_page=100" \
    --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv') || { echo "could not read the checks of ${sha::7}" >&2; exit 1; }
  bad=$(printf '%s\n' "$checks" | awk -F'\t' 'NF && !($2 == "completed" && ($3 == "success" || $3 == "skipped" || $3 == "neutral"))')
  if [[ -z "$checks" || -n "$bad" ]]; then
    printf '%s\n' "${bad:-no check runs}"
    echo "main ${sha::7} is not green (use --skip-ci to release anyway)" >&2; exit 1
  fi
  echo "checks: green ($(printf '%s\n' "$checks" | grep -c .))"
fi
pre=(); [[ $GATE == 1 ]] && pre=(--prerelease)
if [[ $DRY == 1 ]]; then echo "dry run: would tag v$V at ${sha::7}, push it, REF=$sha scripts/release/release-mac-mini.sh $V$([[ $GATE == 1 ]] && echo ' --prerelease')"; exit 0; fi
msg="Switchyard $V"; [[ $GATE == 1 ]] && msg="$msg [gated]"
git tag -a "v$V" "$sha" -m "$msg"
timeout 60 git push -q origin "v$V"
echo "pushed tag v$V; building on the release Mac…"
REF=$sha scripts/release/release-mac-mini.sh "$V" ${pre[@]+"${pre[@]}"}
if [[ $GATE == 1 ]]; then
  echo "v$V is a gated PRERELEASE: not Latest, tap untouched. Gates: RELEASING.md 'Gated releases'; then scripts/release.sh $V --promote"
  echo "feed: https://github.com/$REPO/releases/download/v$V/latest.json"
fi
