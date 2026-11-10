#!/bin/sh
# The release build sy-ship's scripts/release/build-macos.sh calls: builds the macOS app with
# production trust (`mac --release`, Exact's production flavour) and prints the Switchyard.app
# path on the last line (logs go to stderr).
#   EXACT2                     the expo/exact checkout (scripts/fetch-exact.sh makes one if unset)
#   SWITCHYARD_DEFAULT_SERVER  the server a fresh install talks to (default: the team's)
#   SWITCHYARD_VERSION         informational; sy-ship stamps the version into Info.plist after
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
export SWITCHYARD_DEFAULT_SERVER="${SWITCHYARD_DEFAULT_SERVER:-https://switchyard.apps.example.com}"
SWITCHYARD_MAC_FLAGS="--release" exec "$here/scripts/build.sh" mac
