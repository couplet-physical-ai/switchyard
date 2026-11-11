#!/usr/bin/env python3
"""Write dist/latest.json, the in-app updater's feed, for one release.

    scripts/release/latest-json.py <version> [<commit>]

Published as a release asset on every release, so the stable address
https://github.com/couplet-physical-ai/switchyard/releases/latest/download/latest.json
always names the newest (non-prerelease) build. Shape (Copper's appcast plus `published`):

  {"version": "0.1.1", "build": 1001,
   "url": "https://github.com/.../releases/download/v0.1.1/Switchyard-0.1.1-arm64.zip",
   "dmg": "https://github.com/.../releases/download/v0.1.1/Switchyard-0.1.1-arm64.dmg",
   "sha256": "<hex of the zip>", "notes": "<markdown change list>",
   "published": "2026-11-10T23:59:00Z", "minimumSystemVersion": "14.0",
   "bundleId": BUNDLE_ID, "commit": "<sha>"}

`build` is the bundle's CFBundleVersion (M*1000000 + m*1000 + p), which the updater compares.
The zip's sha256 is read from dist/SHA256SUMS (written by package-macos.sh).
"""
import datetime
import json
import pathlib
import plistlib
import subprocess
import sys

REPO = "couplet-physical-ai/switchyard"
BUNDLE_ID = "com.exowatt.switchyard"
ROOT = pathlib.Path(__file__).resolve().parents[2]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    v = sys.argv[1].lstrip("v")
    commit = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
    zip_name, dmg_name = f"Switchyard-{v}-arm64.zip", f"Switchyard-{v}-arm64.dmg"
    sums = {}
    for line in (ROOT / "dist/SHA256SUMS").read_text().splitlines():
        h, _, name = line.partition("  ")
        sums[name.strip()] = h.strip()
    sha = sums.get(zip_name, "")
    if len(sha) != 64:
        print(f"no sha256 for {zip_name} in dist/SHA256SUMS", file=sys.stderr)
        return 1
    core = v.split("-")[0].split("+")[0].split(".")
    build = int(core[0]) * 1_000_000 + int(core[1]) * 1_000 + int(core[2])
    # The updater requires the bundle's CFBundleVersion == build, CFBundleShortVersionString ==
    # version and CFBundleIdentifier == bundleId: read the shipped Info.plist (any platform).
    plist = ROOT / "dist/Switchyard.app/Contents/Info.plist"
    if not plist.exists():
        print(f"{plist} missing: latest.json must be checked against the shipped bundle", file=sys.stderr)
        return 1
    info = plistlib.loads(plist.read_bytes())
    want = {"CFBundleVersion": str(build), "CFBundleShortVersionString": v, "CFBundleIdentifier": BUNDLE_ID}
    bad = {k: info.get(k) for k, w in want.items() if str(info.get(k)) != w}
    if bad:
        print(f"Info.plist disagrees with latest.json: {bad} (want {want})", file=sys.stderr)
        return 1
    notes = subprocess.run([sys.executable, str(ROOT / "scripts/release/notes.py"), v, commit, "--changes"],
                           capture_output=True, text=True, cwd=ROOT).stdout.strip()
    sha_full = subprocess.run(["git", "rev-parse", commit], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    base = f"https://github.com/{REPO}/releases/download/v{v}"
    feed = {
        "version": v,
        "build": build,
        "url": f"{base}/{zip_name}",
        "dmg": f"{base}/{dmg_name}",
        "sha256": sha,
        "notes": notes,
        "published": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "minimumSystemVersion": "14.0",
        "bundleId": BUNDLE_ID,
        "commit": sha_full or None,
    }
    out = ROOT / "dist/latest.json"
    out.write_text(json.dumps(feed, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({k: (val if k != "notes" else f"{len(val)} chars") for k, val in feed.items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
