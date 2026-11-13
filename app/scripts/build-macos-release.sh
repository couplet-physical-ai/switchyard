#!/bin/sh
# The release build sy-ship's scripts/release/build-macos.sh calls: builds the macOS app with
# production trust (`mac --release`, Exact's production flavour) and prints the Switchyard.app
# path on the last line (logs go to stderr).
#   EXACT2                     the expo/exact checkout (scripts/fetch-exact.sh makes one if unset)
#   SWITCHYARD_DEFAULT_SERVER  the server a fresh install talks to (site configuration: the release
#                              workflow passes the repo's secret; unset, a fresh install asks)
#   SWITCHYARD_ORGS            the watched orgs in display order (the server's list; unset: the
#                              demo fleet's order)
#   SWITCHYARD_VERSION         informational; sy-ship stamps the version into Info.plist after
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
export SWITCHYARD_DEFAULT_SERVER="${SWITCHYARD_DEFAULT_SERVER:-}" SWITCHYARD_ORGS="${SWITCHYARD_ORGS:-}"
[ -n "$SWITCHYARD_DEFAULT_SERVER" ] || echo "build-macos-release: SWITCHYARD_DEFAULT_SERVER unset: a fresh install asks for its server" >&2
[ -n "$SWITCHYARD_ORGS" ] || echo "build-macos-release: SWITCHYARD_ORGS unset: the demo fleet's org order" >&2
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
