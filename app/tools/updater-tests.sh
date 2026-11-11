#!/bin/sh
# The updater's and the test hooks' native unit tests (modules/apple/UpdaterTests.swift and
# HooksTests.swift, README "Updates" and "Test hooks"; KeychainTests.swift, "Security"): compiles UpdaterCore.swift,
# HooksCore.swift and the two test files with swiftc into a CLI and runs it. Exits
# nonzero when a case fails or the build does.
#   app/tools/updater-tests.sh                  on a Mac
#   MINI=user@host app/tools/updater-tests.sh   from elsewhere: copies the files to the Mac
#                                               over ssh and runs them there
set -eu
cd "$(dirname "$0")/.."
SRC="modules/apple/UpdaterCore.swift modules/apple/UpdaterTests.swift modules/apple/HooksCore.swift modules/apple/HooksTests.swift modules/apple/Keychain.swift modules/apple/KeychainTests.swift" # fx-kc: + the token at rest

if [ "$(uname -s)" != Darwin ]; then
  MINI=${MINI:?not a Mac: set MINI=user@host of one}
  # shellcheck disable=SC2086
  tar czf - $SRC tools/updater-tests.sh \
    | timeout 900 ssh -o BatchMode=yes -o ConnectTimeout=10 "$MINI" \
      'set -e; d=$(mktemp -d /tmp/sy-updater-tests.XXXXXX); trap "rm -rf $d" EXIT; tar xzf - -C "$d"; cd "$d"; [ -f "${SWITCHYARD_ENV:-/dev/null}" ] && . "$SWITCHYARD_ENV"; sh tools/updater-tests.sh'
  exit $?
fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/sy-updater-tests.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
printf 'import Foundation\nexit(SYUpdaterTests.run())\n' > "$OUT/main.swift"
echo "swiftc $(swiftc --version 2>&1 | head -1)"
# shellcheck disable=SC2086
timeout 600 swiftc -swift-version 5 -O -D SWITCHYARD_UPDATER_TESTS $SRC "$OUT/main.swift" -o "$OUT/updater-tests"
timeout 600 "$OUT/updater-tests"
