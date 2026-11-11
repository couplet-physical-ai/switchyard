#!/usr/bin/env python3
"""Lint the release shell: every `run:` block of .github/workflows/*.yml plus scripts/release*/**.sh.

    python3 scripts/ci/check_release_shell.py

1. `bash -n` on each block / script (GitHub expressions `${{ … }}` replaced by a word first).
2. The macOS runner's /bin/bash is 3.2: under `set -u` an EMPTY array expanded as "${a[@]}" is
   "unbound variable" there (bash >= 4.4 allows it, so Linux never notices). That broke the
   v0.1.0 publish (pre=() on a non-prerelease). Any "${name[@]}" / ${name[*]} of an array that is
   ever assigned empty (`name=()`) must be guarded: ${name[@]+"${name[@]}"}.
3. Each block runs once more through bash with every expression set to an empty word and an
   EMPTY-array fake of each guarded array, to exercise the non-prerelease branch: only the array
   lines are kept, so nothing else executes.
Stdlib only; exits 1 on any problem.
"""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXPR = re.compile(r"\$\{\{[^}]*\}\}")
EMPTY_ASSIGN = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)=\(\s*\)")
USE = re.compile(r"(?<![+])\"?\$\{([A-Za-z_][A-Za-z0-9_]*)\[[@*]\]\}")
GUARDED = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\+")
problems: list[str] = []


def run_blocks(path: pathlib.Path):
    """Yield (line, text) of each `run: |` block (plain YAML scan, no PyYAML on the CI image)."""
    lines = path.read_text().splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^(\s*)(?:- )?run:\s*(\|[-+]?|>[-+]?)?\s*(.*)$", lines[i])
        if not m:
            i += 1
            continue
        if m.group(2) is None:
            yield i + 1, m.group(3)
            i += 1
            continue
        start, body, indent = i + 1, [], None
        i += 1
        while i < len(lines):
            ln = lines[i]
            if ln.strip() == "":
                body.append("")
                i += 1
                continue
            lead = len(ln) - len(ln.lstrip())
            if indent is None:
                indent = lead
            if lead < indent:
                break
            body.append(ln[indent:])
            i += 1
        yield start, "\n".join(body)


def check(where: str, text: str) -> None:
    src = EXPR.sub("x", text)
    r = subprocess.run(["bash", "-n"], input=src, capture_output=True, text=True)
    if r.returncode:
        problems.append(f"{where}: bash -n: {r.stderr.strip()}")
    empties = set(EMPTY_ASSIGN.findall(src))
    guarded = set(GUARDED.findall(src))
    for n, line in enumerate(src.splitlines(), 1):
        for name in USE.findall(line):
            if name in empties and not GUARDED.search(line):
                problems.append(f"{where}+{n}: \"${{{name}[@]}}\" of an array that can be empty: "
                                f"bash 3.2 + set -u fails; write ${{{name}[@]+\"${{{name}[@]}}\"}}")
    # Exercise the guarded expansions with empty arrays under set -u (the non-prerelease branch).
    for name in guarded & empties:
        probe = f"set -u\n{name}=()\nprintf '%s\\n' x ${{{name}[@]+\"${{{name}[@]}}\"}} >/dev/null\n"
        r = subprocess.run(["bash", "-c", probe], capture_output=True, text=True)
        if r.returncode:
            problems.append(f"{where}: empty {name}=() under set -u fails: {r.stderr.strip()}")


def main() -> int:
    for wf in sorted((ROOT / ".github/workflows").glob("*.yml")):
        for line, text in run_blocks(wf):
            check(f"{wf.relative_to(ROOT)}:{line}", text)
    for sh in sorted(list(ROOT.glob("scripts/release*.sh")) + list(ROOT.glob("scripts/release/*.sh"))):
        check(str(sh.relative_to(ROOT)), sh.read_text())
    for p in problems:
        print(p)
    print(f"release shell: {'OK' if not problems else f'{len(problems)} problem(s)'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
