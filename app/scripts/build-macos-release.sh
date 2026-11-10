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
app=$(SWITCHYARD_MAC_FLAGS="--release" "$here/scripts/build.sh" mac | tail -1)
[ -n "$app" ] && [ -d "$app" ] || { echo "build-macos-release: no Switchyard.app was built" >&2; exit 1; }
# A bake without app.ts's data module still links (every source then answers "unknown source"):
# refuse it here rather than ship it.
exe="$app/Contents/MacOS/Switchyard"
if ! LC_ALL=C grep -q "loadToken" "$exe"; then
  echo "build-macos-release: $exe has no data module (app.ts was not baked in; is EXACT2 set up?)" >&2
  exit 1
fi
echo "$app"
