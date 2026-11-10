#!/usr/bin/env python3
"""Validate Switchyard's wire-contract fixtures against contract/CONTRACT.md.

Usage: validate_fixtures.py [CONTRACT_DIR]   (default: contract)

Checks (stdlib only, so CI needs no install):
  * fixtures/snapshot.json is a Snapshot: required top-level keys, every entity has the
    contract's required fields, every enum value is one the contract names, ids match
    their documented shape, times are Unix milliseconds;
  * fixtures/hour.jsonl is one Frame per line: `t` in delta|hb|reset, `seq` strictly
    increasing across deltas, `at` non-decreasing, every Op is upsert|remove|event|patch|dot
    with a known kind (unknown kinds are allowed by the contract but reported), every Event
    has a known `k` and its required fields;
  * the ops are replayed onto the snapshot's entities: `patch` (RFC 7386 JSON Merge Patch on
    an entity the client holds) and `dot` (upsert one Dot into repos[id].main.recent, sorted by
    (at, sha), newest 12 kept) must leave an entity that still matches the contract;
  * no fixture carries an internal address (192.168.*, 10.*, *.lab.example.com).

Exit 0 = valid; 1 = invalid (every problem printed); missing fixtures are reported and
pass until the server thread delivers them.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

CI_STATE = {"success", "failure", "running", "pending", "blocked", "skipped", "canceled", "error", "none"}
LANE_MODE = {"roadrunner_first", "gha_first", "primary", "ci", "failsafe", "ci_only", "none"}
STAGE = {"pushed", "queued", "building", "gating", "merged", "deploying", "deployed", "failed", "done"}
PR_PHASE = {"draft", "checks", "review", "changes_requested", "mergeable", "conflict", "merged", "closed", "deployed"}
DEPLOY_STATE = {"pending", "running", "success", "failure"}
DEPLOY_VIA = {"roadrunner", "gha", "gha_fallback", "manual"}
HEALTH = {"up", "degraded", "down", "unknown"}
ENGINE_KIND = {"dagger", "wp_agent", "gha_runner"}
PIPE_LANE = {"roadrunner", "gha"}
PIPE_EVENT = {"push", "pull_request", "tag", "cron", "manual", "deployment"}
AI_REVIEW = {"pending", "commented", "approved", "skipped"}

# Entity kind -> (required fields, {field: allowed enum})
ENTITIES: dict[str, tuple[list[str], dict[str, set[str]]]] = {
    "org": (["id", "repos"], {}),
    "repo": (["id", "org", "name", "default_branch", "lane", "main", "heat", "open_prs", "links"], {"lane": LANE_MODE}),
    "commit": (["repo", "sha", "branch", "title", "author", "at", "stage", "ci", "pipelines"], {"stage": STAGE, "ci": CI_STATE}),
    "pipeline": (["lane", "repo", "number", "sha", "branch", "event", "state", "created", "workflows", "url"],
                 {"lane": PIPE_LANE, "event": PIPE_EVENT, "state": CI_STATE}),
    "pr": (["repo", "number", "title", "author", "draft", "created", "updated", "head_sha", "base", "phase", "checks", "review", "url"],
           {"phase": PR_PHASE}),
    "deploy": (["app", "repo", "sha", "via", "state", "started"], {"via": DEPLOY_VIA, "state": DEPLOY_STATE}),
    "app": (["url", "health", "checked"], {"health": HEALTH}),
    "engine": (["id", "kind", "slots", "busy", "running"], {"kind": ENGINE_KIND}),
    "queue": (["id", "pending", "running", "oldest_wait_ms", "items"], {"id": PIPE_LANE}),
    "lane": (["id", "mode"], {"mode": LANE_MODE}),
    "watcher": (["id", "tripped", "gh_status"], {}),
    "stats": (["id", "commits_24h", "pipelines_24h", "success_rate_24h", "prs_open"], {}),
}
# Snapshot collection key -> entity kind
COLLECTIONS = {
    "orgs": "org", "repos": "repo", "commits": "commit", "pipelines": "pipeline", "prs": "pr",
    "deploys": "deploy", "apps": "app", "engines": "engine", "queues": "queue", "lanes": "lane",
}
SNAPSHOT_KEYS = ["protocol", "seq", "at", "orgs", "repos", "commits", "pipelines", "prs", "deploys",
                 "apps", "engines", "queues", "lanes", "watcher", "stats"]
STATS_KEYS = ["commits_24h", "pipelines_24h", "success_rate_24h", "p50_queue_ms", "p50_build_ms",
              "deploys_24h", "apps_up", "apps_down", "prs_open"]
EVENTS: dict[str, list[str]] = {
    "push": ["repo", "sha", "branch", "author", "title", "at"],
    "enqueue": ["pipeline", "lane", "repo", "sha", "at"],
    "start": ["pipeline", "at"],  # engine is optional (unknown until an agent picks it up)
    "step": ["pipeline", "workflow", "step", "state", "at"],
    "finish": ["pipeline", "state", "at"],
    "pr": ["repo", "number", "phase", "at"],
    "merge": ["repo", "number", "sha", "at"],
    "deploy": ["app", "sha", "state", "via", "at"],
    "health": ["app", "from", "to", "at"],
    "main": ["repo", "from", "to", "at"],
}
INTERNAL = re.compile(r"(?<![\d.])(?:192\.168|10)\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?(?![\d.])|\.lab\.example\.com", re.I)
REPO_ID = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
MS_MIN, MS_MAX = 1_500_000_000_000, 4_000_000_000_000  # 2017 .. 2096, in ms

errors: list[str] = []
notes: list[str] = []


def err(where: str, msg: str) -> None:
    if len(errors) < 500:
        errors.append(f"{where}: {msg}")


def is_ms(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and MS_MIN <= v <= MS_MAX


def check_entity(kind: str, v, where: str) -> None:
    if not isinstance(v, dict):
        err(where, f"{kind} is {type(v).__name__}, not an object")
        return
    required, enums = ENTITIES[kind]
    for f in required:
        if f not in v:
            err(where, f"{kind} missing `{f}`")
    for f, allowed in enums.items():
        if f in v and v[f] not in allowed:
            err(where, f"{kind}.{f} = {v[f]!r} not in {sorted(allowed)}")
    for f in ("at", "created", "updated", "started", "finished", "checked", "since"):
        if f in v and v[f] is not None and not is_ms(v[f]):
            err(where, f"{kind}.{f} = {v[f]!r} is not Unix milliseconds")
    if kind == "repo":
        if "id" in v and not REPO_ID.match(str(v["id"])):
            err(where, f"repo id {v['id']!r} is not owner/name")
        m = v.get("main")
        if isinstance(m, dict):
            if m.get("state") not in CI_STATE:
                err(where, f"repo.main.state = {m.get('state')!r}")
            for i, d in enumerate(m.get("recent") or []):
                if not isinstance(d, dict) or d.get("state") not in CI_STATE or "sha" not in d:
                    err(f"{where}.main.recent[{i}]", "bad Dot (needs sha + CiState)")
            if len(m.get("recent") or []) > 40:
                err(where, "repo.main.recent has more than 40 dots")
        if isinstance(v.get("heat"), (int, float)) and not 0 <= v["heat"] <= 1:
            err(where, f"repo.heat {v['heat']} outside 0..1")
    if kind == "pipeline":
        for wi, w in enumerate(v.get("workflows") or []):
            if not isinstance(w, dict) or w.get("state") not in CI_STATE:
                err(f"{where}.workflows[{wi}]", "bad Workflow state")
                continue
            for si, s in enumerate(w.get("steps") or []):
                if not isinstance(s, dict) or s.get("state") not in CI_STATE or "name" not in s:
                    err(f"{where}.workflows[{wi}].steps[{si}]", "bad Step")
    if kind == "pr":
        for ci, c in enumerate(v.get("checks") or []):
            if not isinstance(c, dict) or c.get("state") not in CI_STATE:
                err(f"{where}.checks[{ci}]", "bad check state")
        ai = (v.get("review") or {}).get("ai")
        if ai is not None and ai not in AI_REVIEW:
            err(where, f"pr.review.ai = {ai!r}")
    if kind == "queue" and len(v.get("items") or []) > 50:
        err(where, "queue.items has more than 50 entries")


def entities_of(coll):
    """A collection may be a list of entities or an id -> entity map."""
    if isinstance(coll, dict):
        return list(coll.items())
    if isinstance(coll, list):
        return [(e.get("id", i) if isinstance(e, dict) else i, e) for i, e in enumerate(coll)]
    return None


def entity_id(kind: str, e, fallback):
    """The wire id of a snapshot entity: its `id`, a map key, or the contract's derived form."""
    if isinstance(e, dict) and isinstance(e.get("id"), str):
        return e["id"]
    if isinstance(fallback, str):
        return fallback
    if not isinstance(e, dict):
        return None
    if kind == "commit" and "repo" in e and "sha" in e:
        return f"{e['repo']}@{e['sha']}"
    if kind == "pr" and "repo" in e and "number" in e:
        return f"{e['repo']}#{e['number']}"
    if kind == "deploy" and "app" in e and "sha" in e:
        return f"{e['app']}:{e['sha']}"
    return None


def check_snapshot(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    for m in INTERNAL.finditer(text):
        err(path.name, f"internal address {m.group(0)!r} at offset {m.start()}")
    snap = json.loads(text)
    if not isinstance(snap, dict):
        err(path.name, "snapshot is not an object")
        return
    for k in SNAPSHOT_KEYS:
        if k not in snap:
            err(path.name, f"missing top-level `{k}`")
    if not is_ms(snap.get("at")):
        err(path.name, "`at` is not Unix milliseconds")
    if not isinstance(snap.get("seq"), int):
        err(path.name, "`seq` is not an integer")
    for coll, kind in COLLECTIONS.items():
        items = entities_of(snap.get(coll, []))
        if items is None:
            err(path.name, f"`{coll}` is neither a list nor a map")
            continue
        for ident, e in items:
            check_entity(kind, e, f"{path.name}:{coll}[{ident}]")
            key = entity_id(kind, e, ident)
            if key is not None and isinstance(e, dict):
                STATE[(kind, key)] = e
        notes.append(f"{coll}: {len(items)}")
    if isinstance(snap.get("watcher"), dict):
        check_entity("watcher", snap["watcher"], f"{path.name}:watcher")
    stats = snap.get("stats")
    if isinstance(stats, dict):
        for k in STATS_KEYS:
            if k not in stats:
                err(path.name, f"stats missing `{k}`")


# Replayed state: (kind, id) -> entity, seeded from snapshot.json, moved by hour.jsonl's ops.
STATE: dict[tuple[str, str], dict] = {}
DOT_KEEP = 12
replay = {"patched": 0, "dots": 0, "patch_unknown": 0, "dot_unknown": 0}


def merge_patch(target, patch):
    """RFC 7386: objects merge recursively, null deletes, anything else replaces."""
    if not isinstance(patch, dict):
        return patch
    out = dict(target) if isinstance(target, dict) else {}
    for k, v in patch.items():
        if v is None:
            out.pop(k, None)
        else:
            out[k] = merge_patch(out.get(k), v)
    return out


def check_dot(d, where: str) -> bool:
    if not isinstance(d, dict):
        err(where, "dot `v` is not an object")
        return False
    ok = True
    for f in ("sha", "at", "state"):
        if f not in d:
            err(where, f"dot missing `{f}`")
            ok = False
    if "at" in d and not is_ms(d["at"]):
        err(where, f"dot.at = {d['at']!r} is not Unix milliseconds")
        ok = False
    if "state" in d and d["state"] not in CI_STATE:
        err(where, f"dot.state = {d['state']!r} not in CiState")
        ok = False
    return ok


def check_op(op, where: str, kinds_seen: dict) -> None:
    if not isinstance(op, dict) or op.get("op") not in {"upsert", "remove", "event", "patch", "dot"}:
        err(where, f"bad op {op!r:.80}")
        return
    if op["op"] == "event":
        e = op.get("e")
        if not isinstance(e, dict):
            err(where, "event op without `e` object")
            return
        k = e.get("k")
        if k not in EVENTS:
            kinds_seen.setdefault(f"event:{k}", 0)
            kinds_seen[f"event:{k}"] += 1
            return
        for f in EVENTS[k]:
            if f not in e:
                err(where, f"event {k} missing `{f}`")
        if "at" in e and not is_ms(e["at"]):
            err(where, f"event {k}.at is not Unix milliseconds")
        return
    if op["op"] == "dot":
        ident = op.get("id")
        if not isinstance(ident, str):
            err(where, "dot without string `id` (a repo id)")
            return
        if not REPO_ID.match(ident):
            err(where, f"dot id {ident!r} is not owner/name")
        if not check_dot(op.get("v"), where):
            return
        repo = STATE.get(("repo", ident))
        if repo is None:
            replay["dot_unknown"] += 1
            return
        main = repo.setdefault("main", {})
        recent = [d for d in (main.get("recent") or []) if isinstance(d, dict) and d.get("sha") != op["v"]["sha"]]
        recent.append(op["v"])
        recent.sort(key=lambda d: (d.get("at", 0), str(d.get("sha", ""))))
        main["recent"] = recent[-DOT_KEEP:]
        replay["dots"] += 1
        check_entity("repo", repo, f"{where} (repo after dot)")
        return
    kind, ident = op.get("kind"), op.get("id")
    if not isinstance(ident, str):
        err(where, f"{op['op']} without string `id`")
    if kind not in ENTITIES and op["op"] == "patch":
        err(where, f"patch of unknown kind {kind!r}: a patch needs an entity the client holds")
        return
    if kind not in ENTITIES:
        kinds_seen.setdefault(f"kind:{kind}", 0)
        kinds_seen[f"kind:{kind}"] += 1
        return
    if op["op"] == "patch":
        if not isinstance(op.get("v"), dict):
            err(where, f"patch {kind} `v` is not an object")
            return
        cur = STATE.get((kind, ident))
        if cur is None:
            replay["patch_unknown"] += 1
            return
        merged = merge_patch(cur, op["v"])
        STATE[(kind, ident)] = merged
        replay["patched"] += 1
        check_entity(kind, merged, f"{where} ({kind} {ident} after patch)")
        return
    if op["op"] == "remove":
        STATE.pop((kind, ident), None)
        return
    if "v" not in op:
        err(where, f"upsert {kind} without `v`")
    else:
        check_entity(kind, op["v"], where)
        if isinstance(op["v"], dict):
            STATE[(kind, ident)] = op["v"]


def check_hour(path: Path) -> None:
    last_seq, last_at, frames, ops = None, None, 0, 0
    unknown: dict[str, int] = {}
    with path.open(encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            where = f"{path.name}:{n}"
            for m in INTERNAL.finditer(line):
                err(where, f"internal address {m.group(0)!r}")
            try:
                fr = json.loads(line)
            except json.JSONDecodeError as e:
                err(where, f"not JSON: {e}")
                continue
            frames += 1
            t = fr.get("t") if isinstance(fr, dict) else None
            if t not in {"delta", "hb", "reset"}:
                err(where, f"frame t = {t!r}")
                continue
            if t == "reset":
                continue
            seq, at = fr.get("seq"), fr.get("at")
            if not isinstance(seq, int):
                err(where, "frame without integer seq")
            if not is_ms(at):
                err(where, "frame `at` is not Unix milliseconds")
            if t == "delta":
                if isinstance(seq, int) and last_seq is not None and seq <= last_seq:
                    err(where, f"delta seq {seq} not after {last_seq}")
                if isinstance(seq, int):
                    last_seq = seq
                for i, op in enumerate(fr.get("ops") or []):
                    ops += 1
                    check_op(op, f"{where}.ops[{i}]", unknown)
            if is_ms(at):
                if last_at is not None and at < last_at:
                    err(where, f"frame at {at} before previous {last_at}")
                last_at = at
    notes.append(f"{path.name}: {frames} frames, {ops} ops")
    notes.append(f"{path.name}: replayed {replay['patched']} patch(es), {replay['dots']} dot(s) onto snapshot state"
                 + (f"; {replay['patch_unknown']} patch(es) / {replay['dot_unknown']} dot(s) on entities the snapshot lacks (not checked)"
                    if replay['patch_unknown'] or replay['dot_unknown'] else ""))
    for k, c in sorted(unknown.items()):
        notes.append(f"{path.name}: {c} op(s) with unknown {k} (allowed: clients skip them)")
    if frames == 0:
        err(path.name, "no frames")


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "contract")
    fx = root / "fixtures"
    if not (root / "CONTRACT.md").is_file():
        print(f"{root}/CONTRACT.md missing", file=sys.stderr)
        return 1
    found = False
    for name, fn in (("snapshot.json", check_snapshot), ("hour.jsonl", check_hour)):
        p = fx / name
        if p.is_file():
            found = True
            try:
                fn(p)
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                err(name, f"unreadable: {e}")
        else:
            print(f"note: {p} not present yet")
    for extra in sorted(fx.glob("*.json")) if fx.is_dir() else []:
        if extra.name != "snapshot.json":
            try:
                json.loads(extra.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                err(extra.name, f"not JSON: {e}")
    for n in notes:
        print(n)
    if errors:
        print(f"\n{len(errors)} problem(s):", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1
    print("fixtures OK" if found else "no fixtures yet: nothing to check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
