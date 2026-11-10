#!/bin/sh
# The release build sy-ship's scripts/release/build-macos.sh calls: builds the macOS app with
# production trust and prints the Switchyard.app path last. SWITCHYARD_VERSION is the version.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
SWITCHYARD_MAC_FLAGS="--release" exec "$here/scripts/build.sh" mac
