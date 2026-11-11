#!/bin/sh
# One-liners for the client (run from anywhere):
#   app/scripts/build.sh web [outdir]   the web build (default app/dist): static files the server serves
#   app/scripts/build.sh mac            the macOS app; prints the .app path last
#   app/scripts/build.sh test web|macos the *.test.contract suites on that host
# EXACT2 names an existing exact checkout; otherwise scripts/fetch-exact.sh makes one.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
EXACT2=${EXACT2:-$("$here/scripts/fetch-exact.sh" | tail -1)}
export EXACT2 EXACT_FEEDBACK=${EXACT_FEEDBACK:-0}
cd "$here"
case "${1:-}" in
  web)
    # The commit this build is, so a page the server has since replaced can offer a reload
    # (it compares /api/v1/meta's web.sha).
    SWITCHYARD_WEB_SHA=${SWITCHYARD_WEB_SHA:-$(git -C "$here" rev-parse HEAD 2>/dev/null || true)}
    export SWITCHYARD_WEB_SHA
    timeout 1800 bun exact.mjs web-build --out "${2:-$here/dist}" ;;
  mac)
    export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
    timeout 3600 bun exact.mjs mac ${SWITCHYARD_MAC_FLAGS:---release} >&2
    find "$here/target/clients" -maxdepth 5 -type d -name Switchyard.app -path '*/macos/*' | head -1 ;;
  test)
    # Every data turn of the boot path small enough for a slow Mac (tools/turns.ts: 4 ms in Bun is
    # ~40 ms on GitHub's 3-core M1 runner, whose Hermes refuses a turn over 100 ms).
    # The max is in Bun ms on THIS machine: 4 locally, 8 on a CI runner (CI set: GitHub Actions, Woodpecker; GitHub's 3-core
    # M1 runs Bun ~2x slower, and 8 ms there is still >= 10x under Hermes' 100 ms). Each turn is
    # the median of 3 runs. TURNS_MAX overrides.
    case "${CI:-}" in ''|false|0) max=${TURNS_MAX:-4} ;; *) max=${TURNS_MAX:-8} ;; esac
    timeout 300 bun tools/turns.ts demo --max "$max"
    timeout 300 bun tools/turns.ts fixtures --max "$max"
    timeout 3600 bun exact.mjs test "${2:-web}" 'tests/*.test.contract' --size 1440x900 ;;
  *) echo "usage: app/scripts/build.sh web [outdir] | mac | test web|macos" >&2; exit 2 ;;
esac
