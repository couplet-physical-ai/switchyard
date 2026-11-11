#!/bin/sh
# Copy app/ to the Mac mini's build checkout (macOS builds and drives run there).
# MINI and MINI_DIR override the defaults; the exact checkout there is EXACT2 in switchyard-env.sh.
set -eu
MINI=${MINI:?set MINI=user@host of the Mac that builds}
MINI_DIR=${MINI_DIR:-/Volumes/Farm/farm-exowatt/switchyard-client}
cd "$(dirname "$0")/.."
tar czf - --exclude=./target --exclude=./dist --exclude=./.exact --exclude=./node_modules --exclude=./screenshots . \
  | timeout 120 ssh -o BatchMode=yes -o ConnectTimeout=10 "$MINI" "mkdir -p '$MINI_DIR/app' && tar xzf - -C '$MINI_DIR/app'"
# The recorded fixtures (contract/, read-only here) for tests/live-fixtures.test.contract.
tar czf - -C .. contract/fixtures contract/CONTRACT.md \
  | timeout 120 ssh -o BatchMode=yes -o ConnectTimeout=10 "$MINI" "tar xzf - -C '$MINI_DIR'"
