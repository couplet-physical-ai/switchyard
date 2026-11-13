#!/usr/bin/env python3
"""Release notes from commit subjects, grouped by the repo's `area: what` convention.

    scripts/release/notes.py <version> [<to-ref>] [<from-ref>] [--changes]

--changes prints only the grouped change list (for latest.json's `notes`).

<from-ref> defaults to the newest earlier v* tag that is not a 0.0.x release-path check
(so 0.1.0 covers everything); none = the whole history. Prints Markdown on stdout.
Python 3 stdlib only (macOS runners ship bash 3.2, which has no associative arrays).
"""
import re
import subprocess
import sys

REPO = "couplet-physical-ai/switchyard"
SECTIONS = [
    ("client", "Client (macOS + web)"), ("server", "Server"), ("contract", "Wire contract"),
    ("ci", "CI (Roadrunner)"), ("release", "Release & install"), ("docs", "Docs"), ("other", "Other"),
]
RULES = [  # (regex on the lower-cased area, section)
    (r"^(client|app)\b", "client"),
    (r"^(server|perf)\b|adapter$", "server"),
    (r"^contract\b", "contract"),
    (r"^ci\b", "ci"),
    (r"^(release|install|packaging|placeholder|tap|cask)\b", "release"),
    (r"^(docs?|readme)\b|docs$", "docs"),
]


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    args = [a for a in sys.argv[1:] if a != "--changes"]
    changes_only = len(args) != len(sys.argv) - 1
    version = args[0].lstrip("v")
    to = args[1] if len(args) > 1 else "HEAD"
    frm = args[2] if len(args) > 2 else ""
    if not frm:
        tags = git("tag", "--list", "v*", "--merged", to, "--sort=-v:refname").split()
        frm = next((t for t in tags if t != f"v{version}" and not t.startswith("v0.0.")), "")
    rng = f"{frm}..{to}" if frm else to
    groups: dict[str, list[str]] = {k: [] for k, _ in SECTIONS}
    for line in git("log", "--no-merges", "--reverse", "--format=%H%x09%s", rng).splitlines():
        sha, _, subject = line.partition("\t")
        area, sep, text = subject.partition(": ")
        key = "other"
        if sep:
            for rx, section in RULES:
                if re.search(rx, area.strip().lower()):
                    key = section
                    break
        groups[key].append(f"- {text if key != 'other' else subject} ({sha[:7]})")
    out = [] if changes_only else [
        f"## Switchyard {version}", "",
        "macOS (Apple Silicon, macOS 14+) and web. Install or upgrade:", "",
        "```sh",
        "brew tap couplet-physical-ai/tap && brew trust couplet-physical-ai/tap && brew install --cask switchyard",
        "# already installed? click Update in the app (or: brew upgrade --cask --greedy switchyard)",
        "```", "",
        "The app is ad-hoc signed (no Developer ID); the cask clears the quarantine flag. Without Homebrew:",
        "download the dmg below, drag Switchyard to Applications, then run",
        "`xattr -dr com.apple.quarantine /Applications/Switchyard.app`. Checksums: `SHA256SUMS`.",
        "Web: https://switchyard.apps.example.internal", "",
    ]
    any_change = False
    for key, title in SECTIONS:
        if groups[key]:
            any_change = True
            out += [f"### {title}", "", *groups[key], ""]
    if not any_change:
        out += [f"_No changes since {frm or 'the start'}._", ""]
    if changes_only:
        print("\n".join(out).strip())
        return 0
    out.append(f"**Full changes**: https://github.com/{REPO}/compare/{frm}...v{version}" if frm
               else f"**Full history**: https://github.com/{REPO}/commits/v{version}")
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
