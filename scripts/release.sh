#!/usr/bin/env bash
# Cut a Switchyard release with one command:
#
#   scripts/release.sh 0.1.0            # tag v0.1.0 on origin/main, build + publish, bump the tap
#   scripts/release.sh 0.1.0 --dry-run  # print what would happen
#
# 1. checks origin/main's HEAD is green on Roadrunner (gh rr status; --skip-ci to bypass);
# 2. tags it v<version> and pushes the tag -> .github/workflows/release.yml builds the arm64
#    .app on GitHub's macOS runner, ad-hoc signs it and publishes zip + dmg + SHA256SUMS;
# 3. waits for that run, then runs the tap's bump-switchyard workflow so
#    a fresh `brew install` gets it at once (it also runs every 20 min); installed apps see it
#    through latest.json and their Update button.
# Needs: gh (authenticated, push to this repo), git. Fallback when GitHub's macOS runners are
# unavailable: scripts/release/release-mac-mini.sh (builds on the Mac mini).
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
V=${1:?usage: scripts/release.sh <version> [--dry-run] [--skip-ci]}; shift
V=${V#v}
DRY=0 SKIPCI=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; --skip-ci) SKIPCI=1 ;; *) echo "unknown $a" >&2; exit 2 ;; esac; done
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || { echo "bad version $V" >&2; exit 2; }
REPO=couplet-physical-ai/switchyard TAP=couplet-physical-ai/homebrew-tap
cd "$(dirname "$0")/.."
timeout 60 git fetch -q origin main --tags
sha=$(git rev-parse origin/main)
if git rev-parse -q --verify "refs/tags/v$V" >/dev/null; then echo "tag v$V already exists" >&2; exit 1; fi
echo "release v$V at origin/main ${sha::7}: $(git log -1 --format=%s "$sha")"
if [[ $SKIPCI == 0 ]]; then
  if ! timeout 120 gh rr status "$sha" -R "$REPO" >/tmp/sy-rr-status.$$ 2>&1; then
    cat /tmp/sy-rr-status.$$; rm -f /tmp/sy-rr-status.$$
    echo "main ${sha::7} is not green on Roadrunner (use --skip-ci to release anyway)" >&2; exit 1
  fi
  rm -f /tmp/sy-rr-status.$$; echo "Roadrunner: green"
fi
if [[ $DRY == 1 ]]; then echo "dry run: would tag v$V at ${sha::7}, push it, watch release.yml, dispatch $TAP bump-switchyard"; exit 0; fi
git tag -a "v$V" "$sha" -m "Switchyard $V"
timeout 60 git push -q origin "v$V"
echo "pushed tag v$V; waiting for the release workflow…"
run=""
for _ in $(seq 1 30); do
  run=$(gh run list -R "$REPO" -w release.yml --branch "v$V" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
  [[ -n "$run" ]] && break; sleep 10
done
[[ -n "$run" ]] || { echo "no release run appeared for v$V" >&2; exit 1; }
echo "https://github.com/$REPO/actions/runs/$run"
timeout 9000 gh run watch "$run" -R "$REPO" --exit-status --interval 30 >/dev/null || { echo "release run $run failed" >&2; exit 1; }
gh release view "v$V" -R "$REPO" --json url --jq .url
if [[ "$V" == 0.0.* || "$V" == *-* ]]; then
  echo "v$V is a prerelease: the tap stays on the latest release"; exit 0
fi
gh workflow run bump-switchyard.yml -R "$TAP" -f version="$V"
sleep 15
brun=$(gh run list -R "$TAP" -w bump-switchyard.yml --limit 1 --json databaseId --jq '.[0].databaseId')
timeout 600 gh run watch "$brun" -R "$TAP" --exit-status --interval 10 >/dev/null || { echo "tap bump run $brun failed" >&2; exit 1; }
echo "tap: $(gh api "repos/$TAP/commits/main" --jq '.sha[0:7] + " " + .commit.message')"
echo "done: installed apps offer Update (latest.json); brew upgrade --cask --greedy switchyard also works"
