#!/usr/bin/env bash
# Fail if a tracked file names the site's internal network: its company hosts (any host under
# the company domain, internal or not), its private GitHub orgs, or a private / shared-space
# IPv4 address (RFC 1918, carrier-grade NAT 100.64/10 as used by Tailscale).
#
#   scripts/check-no-internal.sh            # every tracked file at the working tree
#   NO_INTERNAL_EXTRA=<file> scripts/...    # plus one extended regex per line from <file>
#                                           # (e.g. a private repo-name list kept outside this repo)
#
# This repository is public: site-specific values (base URLs, orgs, the default server) come
# from runtime configuration (server/.env.example, packaging/RELEASING.md), and tests use
# synthetic names (Northwind-*, *.example.com). Binary files are skipped. The patterns are
# written so this script never matches itself.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

patterns=(
  # the company's hosts and addresses (public website included: nothing here needs it)
  'exowatt[.](com|internal)'
  # the company's private GitHub orgs
  'exowatt-(labs|ems|exodyne)'
  # private and shared IPv4 space, as dotted quads (versions like 1.10.2 pass)
  '(^|[^0-9.])(10[.][0-9]{1,3}|172[.](1[6-9]|2[0-9]|3[01])|192[.]168|100[.](6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7]))[.][0-9]{1,3}[.][0-9]{1,3}([^0-9.]|$)'
)
if [[ -n "${NO_INTERNAL_EXTRA:-}" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] || patterns+=("$line")
  done < "$NO_INTERNAL_EXTRA"
fi

args=()
for p in "${patterns[@]}"; do args+=(-e "$p"); done

# git grep: tracked files only, -I skips binaries; exit 1 = no match.
set +e
out=$(git grep -n -I -i -E "${args[@]}" -- . 2>&1)
rc=$?
set -e
case $rc in
  0)
    printf '%s\n' "$out" | cut -c1-240
    n=$(printf '%s\n' "$out" | wc -l)
    echo "check-no-internal: ${n} line(s) name internal hosts, orgs or private addresses (above)." >&2
    echo "Move site-specific values to runtime config; use synthetic names in tests and docs." >&2
    exit 1 ;;
  1) echo "check-no-internal: clean ($(git ls-files | wc -l) tracked files)" ;;
  *) echo "check-no-internal: git grep failed (exit $rc): $out" >&2; exit 2 ;;
esac
