//! `/api/v1/changes?since=` (the ledger) and `/api/v1/insights` on a scripted stream.

use serde_json::{Value, json};
use switchyard::ledger::{Ledger, insights};
use switchyard::wire::WireState;

const T0: i64 = 1_794_300_000_000;
const MIN: i64 = 60_000;
const DAY: i64 = 86_400_000;

fn repo(id: &str, group: &str, state: &str, since: i64) -> Value {
    json!({"op": "upsert", "kind": "repo", "id": id, "v": {
        "id": id, "group": group, "main": {"head": "x", "state": state, "since": since, "recent": []}}})
}

fn failed_run(id: &str, repo: &str, at: i64, cluster: &str) -> Value {
    json!({"op": "upsert", "kind": "pipeline", "id": id, "v": {
        "id": id, "repo": repo, "state": "failure", "finished": at,
        "workflows": [{"name": "ci", "state": "failure", "steps": [
            {"name": "rust", "state": "failure", "cluster": cluster}]}]}})
}

fn pr(id: &str, repo: &str, created: i64, phase: &str, extra: Value) -> Value {
    let mut v = json!({"id": id, "repo": repo, "created": created, "phase": phase});
    if let (Some(o), Some(x)) = (v.as_object_mut(), extra.as_object()) {
        o.extend(x.clone());
    }
    json!({"op": "upsert", "kind": "pr", "id": id, "v": v})
}

fn ev(e: Value) -> Value {
    json!({"op": "event", "e": e})
}

/// Apply a frame to the view, then let the ledger see it (as `run_mirror` does).
fn feed(l: &Ledger, w: &mut WireState, seq: u64, at: i64, ops: Vec<Value>) {
    let f = json!({"t": "delta", "seq": seq, "at": at, "ops": ops});
    w.apply_frame(&f);
    l.observe(&f, w);
}

fn scripted() -> (Ledger, WireState) {
    let l = Ledger::new(T0);
    let mut w = WireState::default();
    // Before the visit: api already red since T0, grid red at T0+5m.
    feed(
        &l,
        &mut w,
        1,
        T0,
        vec![
            repo("acme/api", "team:software", "failure", T0),
            repo("volt/grid", "team:power", "success", T0),
            repo("acme/web", "team:software", "success", T0),
            json!({"op": "upsert", "kind": "cluster", "id": "f:old", "v": {"id": "f:old", "first_seen": T0 - 3_600_000}}),
            json!({"op": "upsert", "kind": "cluster", "id": "f:new", "v": {"id": "f:new", "first_seen": T0 + 20 * MIN}}),
        ],
    );
    feed(
        &l,
        &mut w,
        2,
        T0 + 5 * MIN,
        vec![
            repo("volt/grid", "team:power", "failure", T0 + 5 * MIN),
            ev(
                json!({"k": "main", "repo": "volt/grid", "from": "success", "to": "failure", "at": T0 + 5 * MIN}),
            ),
        ],
    );
    // After the visit (since = T0 + 10m):
    feed(
        &l,
        &mut w,
        3,
        T0 + 20 * MIN,
        vec![
            failed_run("wp:acme/web:9", "acme/web", T0 + 20 * MIN, "f:new"),
            repo("acme/web", "team:software", "failure", T0 + 20 * MIN),
            ev(
                json!({"k": "finish", "pipeline": "wp:acme/web:9", "state": "failure", "at": T0 + 20 * MIN}),
            ),
            ev(
                json!({"k": "main", "repo": "acme/web", "from": "success", "to": "failure", "culprit": "abc1234", "at": T0 + 20 * MIN}),
            ),
        ],
    );
    feed(
        &l,
        &mut w,
        4,
        T0 + 30 * MIN,
        vec![
            repo("volt/grid", "team:power", "success", T0 + 30 * MIN),
            ev(
                json!({"k": "main", "repo": "volt/grid", "from": "failure", "to": "success", "at": T0 + 30 * MIN}),
            ),
            failed_run("wp:acme/api:3", "acme/api", T0 + 31 * MIN, "f:old"),
            ev(
                json!({"k": "deploy", "app": "grid", "sha": "def5678", "state": "success", "via": "roadrunner", "at": T0 + 32 * MIN}),
            ),
            ev(
                json!({"k": "health", "app": "grid", "from": "down", "to": "up", "at": T0 + 33 * MIN}),
            ),
            ev(
                json!({"k": "merge", "repo": "volt/grid", "number": 4, "sha": "def5678", "at": T0 + 29 * MIN}),
            ),
            // Opened after the visit; one already merged (it stays in the ledger).
            pr("acme/web#5", "acme/web", T0 + 15 * MIN, "review", json!({})),
            pr(
                "volt/grid#4",
                "volt/grid",
                T0 + 12 * MIN,
                "merged",
                json!({}),
            ),
            // Opened long ago and idle > 3 d: stuck (a human one and a bot one; drafts never).
            pr(
                "acme/api#1",
                "acme/api",
                T0 - 9 * 86_400_000,
                "review",
                json!({"stale_ms": 432_000_000}),
            ),
            pr(
                "acme/api#2",
                "acme/api",
                T0 - 9 * 86_400_000,
                "checks",
                json!({"stale_ms": 432_000_000, "bot": true}),
            ),
            pr(
                "acme/api#3",
                "acme/api",
                T0 - 9 * 86_400_000,
                "draft",
                json!({"stale_ms": 432_000_000}),
            ),
        ],
    );
    (l, w)
}

#[test]
fn changes_since_a_visit() {
    let (l, w) = scripted();
    let c = l.changes(T0 + 10 * MIN, T0 + 40 * MIN, &w);
    assert_eq!(c["complete"], true);
    // web went red after the visit, with its culprit and what broke it.
    assert_eq!(
        c["red"],
        json!([{"repo": "acme/web", "group": "team:software", "at": T0 + 20 * MIN,
        "culprit": "abc1234", "cluster": "f:new"}])
    );
    // grid recovered; it was red for 25 min.
    assert_eq!(
        c["recovered"],
        json!([{"repo": "volt/grid", "group": "team:power", "at": T0 + 30 * MIN,
        "red_ms": 25 * MIN}])
    );
    // api was red before the visit and still is.
    assert_eq!(
        c["still_red"],
        json!([{"repo": "acme/api", "group": "team:software", "since": T0}])
    );
    assert_eq!(
        c["clusters"],
        json!([{"id": "f:new", "count": 1, "new": true}, {"id": "f:old", "count": 1, "new": false}])
    );
    assert_eq!(
        c["deploys"],
        json!([{"app": "grid", "sha": "def5678", "state": "success", "at": T0 + 32 * MIN}])
    );
    assert_eq!(
        c["groups"],
        json!([
            {"id": "team:software", "failed": 1, "red": 1, "prs": {"opened": 1, "merged": 0, "stuck": 1}},
            {"id": "team:power", "failed": 0, "red": 0, "prs": {"opened": 1, "merged": 1, "stuck": 0}},
        ])
    );
    let n = &c["counts"];
    assert_eq!(n["red"], 1);
    assert_eq!(n["recovered"], 1);
    assert_eq!(n["still_red"], 1);
    assert_eq!(n["pipelines"], 1);
    assert_eq!(n["failed"], 1);
    assert_eq!(n["deploys"], 1);
    assert_eq!(n["clusters_new"], 1);
    assert_eq!(n["prs_merged"], 1);
    assert_eq!(n["prs_opened"], 2);
    assert_eq!(n["prs_stuck"], 1);
    assert_eq!(n["prs_stuck_bot"], 1);
    assert_eq!(n["apps_recovered"], 1);
    assert_eq!(n["apps_down"], 0);
}

#[test]
fn a_visit_before_the_ledger_is_incomplete_and_clamped() {
    let (l, w) = scripted();
    let c = l.changes(T0 - 10 * DAY, T0 + 40 * MIN, &w);
    assert_eq!(c["complete"], false);
    assert_eq!(c["since"], T0 + 40 * MIN - 7 * DAY, "clamped to 7 days");
    // Everything in the ledger is "after the visit" now.
    assert_eq!(c["counts"]["recovered"], 1);
    // A window with nothing in it.
    let quiet = l.changes(T0 + 35 * MIN, T0 + 40 * MIN, &w);
    assert_eq!(quiet["counts"]["red"], 0);
    assert_eq!(quiet["counts"]["pipelines"], 0);
    assert_eq!(
        quiet["still_red"].as_array().unwrap().len(),
        2,
        "api and web"
    );
}

#[test]
fn insights_sort_for_display() {
    let mut w = WireState::default();
    let up = |kind: &str, v: Value| json!({"op": "upsert", "kind": kind, "id": v["id"], "v": v});
    w.apply_frame(&json!({"t": "delta", "seq": 1, "at": T0, "ops": [
        up("group", json!({"id": "team:zeta", "name": "Zeta"})),
        up("group", json!({"id": "org:acme", "name": "acme"})),
        up("cluster", json!({"id": "f:a", "open": 0, "count_1h": 5, "count": 9})),
        up("cluster", json!({"id": "f:b", "open": 1, "count_1h": 0, "count": 1})),
        up("cluster", json!({"id": "f:c", "open": 2, "count_1h": 3, "count": 3})),
        up("flake", json!({"id": "x|ci/a", "flips_24h": 1})),
        up("flake", json!({"id": "y|ci/b", "flips_24h": 4})),
        up("trend", json!({"id": "team:zeta"})),
        up("trend", json!({"id": "fleet"})),
        up("trend", json!({"id": "org:acme"})),
    ]}));
    let i = insights(&w, T0);
    let ids = |k: &str| -> Vec<String> {
        i[k].as_array()
            .unwrap()
            .iter()
            .map(|x| x["id"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(
        ids("clusters"),
        ["f:c", "f:b", "f:a"],
        "open first, then the last hour"
    );
    assert_eq!(ids("flakes"), ["y|ci/b", "x|ci/a"]);
    assert_eq!(ids("trends"), ["fleet", "org:acme", "team:zeta"]);
    assert_eq!(ids("groups"), ["org:acme", "team:zeta"]);
}

#[test]
fn a_week_of_changes_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ledger.jsonl");
    let now = T0 + 6 * DAY;
    let l = Ledger::new(i64::MAX);
    l.attach(&path, T0 - DAY);
    l.set_covered_from(T0 - DAY);
    let mut w = WireState::default();
    // Day 0: grid breaks and recovers; day 5: api breaks (and stays red).
    feed(
        &l,
        &mut w,
        1,
        T0,
        vec![
            repo("volt/grid", "team:power", "success", T0),
            repo("acme/api", "team:software", "success", T0),
            ev(
                json!({"k": "main", "repo": "volt/grid", "from": "success", "to": "failure", "at": T0}),
            ),
            ev(
                json!({"k": "main", "repo": "volt/grid", "from": "failure", "to": "success", "at": T0 + 2 * 3_600_000}),
            ),
        ],
    );
    feed(
        &l,
        &mut w,
        2,
        T0 + 5 * DAY,
        vec![
            repo("acme/api", "team:software", "failure", T0 + 5 * DAY),
            ev(
                json!({"k": "main", "repo": "acme/api", "from": "success", "to": "failure", "at": T0 + 5 * DAY}),
            ),
            ev(
                json!({"k": "deploy", "app": "grid", "sha": "abc", "state": "success", "via": "roadrunner", "at": T0 + 5 * DAY}),
            ),
        ],
    );
    let before = l.changes(T0 - 1, now, &w);
    assert_eq!(before["complete"], true);
    assert_eq!(before["counts"]["recovered"], 1);
    assert_eq!(before["counts"]["red"], 1);
    assert_eq!(before["counts"]["deploys"], 1);
    drop(l);
    // A new process: the file brings the week back.
    let l2 = Ledger::new(i64::MAX);
    assert!(l2.attach(&path, now) >= 4);
    let after = l2.changes(T0 - 1, now, &w);
    assert_eq!(before, after);
    // Records older than 7 days are compacted away at boot.
    let l3 = Ledger::new(i64::MAX);
    l3.attach(&path, T0 + 8 * DAY);
    let c = l3.changes(T0 - 1, T0 + 8 * DAY, &w);
    assert_eq!(c["counts"]["recovered"], 0, "day 0 is gone");
    assert_eq!(c["counts"]["red"], 1, "day 5 is kept");
    assert_eq!(c["complete"], false);
    let lines = std::fs::read_to_string(&path).unwrap();
    assert!(!lines.contains("volt/grid\",\"from"), "{lines}");
}

#[test]
fn app_history_has_its_last_deploys_and_health() {
    let l = Ledger::new(T0 - 8 * DAY);
    let mut w = WireState::default();
    let dep = |sha: &str, state: &str, started: i64, finished: Option<i64>| {
        let mut v = json!({"id": format!("acme/api@{sha}"), "app": "api", "repo": "acme/api", "sha": sha,
            "via": "roadrunner", "state": state, "started": started, "pipeline": "wp:acme/api:1"});
        if let Some(f) = finished {
            v["finished"] = f.into();
        }
        json!({"op": "upsert", "kind": "deploy", "id": v["id"], "v": v})
    };
    let mut ops = vec![
        json!({"op": "upsert", "kind": "app", "id": "api", "v": {"id": "api", "url": "https://api.example", "health": "up", "checked": T0}}),
    ];
    for i in 0..12 {
        ops.push(dep(
            &format!("s{i:02}"),
            "success",
            T0 + i * 3_600_000,
            Some(T0 + i * 3_600_000 + 90_000),
        ));
    }
    ops.push(dep("s99", "running", T0 + 20 * 3_600_000, None));
    feed(&l, &mut w, 1, T0 + 20 * 3_600_000, ops);
    feed(
        &l,
        &mut w,
        2,
        T0 + 21 * 3_600_000,
        vec![ev(
            json!({"k": "health", "app": "api", "from": "up", "to": "down", "at": T0 + 21 * 3_600_000}),
        )],
    );
    feed(
        &l,
        &mut w,
        3,
        T0 + 22 * 3_600_000,
        vec![ev(
            json!({"k": "health", "app": "api", "from": "down", "to": "up", "at": T0 + 22 * 3_600_000}),
        )],
    );
    let now = T0 + 23 * 3_600_000;
    let a = l.app("api", &w, now).unwrap();
    let d = a["deploys"].as_array().unwrap();
    assert_eq!(d.len(), 10, "the last 10");
    assert_eq!(d[0]["sha"], "s99", "newest first, a running one included");
    assert!(d[0].get("duration_ms").is_none());
    assert_eq!(d[1]["sha"], "s11");
    assert_eq!(d[1]["duration_ms"], 90_000);
    assert_eq!(d[1]["via"], "roadrunner");
    assert_eq!(d[1]["state"], "success");
    assert_eq!(
        a["health"],
        json!([
            {"from": "down", "to": "up", "at": T0 + 22 * 3_600_000},
            {"from": "up", "to": "down", "at": T0 + 21 * 3_600_000},
        ])
    );
    assert_eq!(a["health_ms"]["down"], 3_600_000);
    assert_eq!(a["app"]["url"], "https://api.example");
    assert!(l.app("nope", &w, now).is_none());
}

#[test]
fn engine_history_is_columnar_by_the_minute() {
    let l = Ledger::new(T0);
    let mut w = WireState::default();
    let eng = |busy: u32, cpu: f64, running: Vec<&str>| {
        json!({"op": "upsert", "kind": "engine", "id": "wp-agent-1", "v": {"id": "wp-agent-1", "kind": "wp_agent",
            "host": "VM 153", "online": true, "slots": 3, "busy": busy, "cpu": cpu, "running": running}})
    };
    let base = T0 - T0 % MIN;
    feed(
        &l,
        &mut w,
        1,
        base + 10_000,
        vec![
            json!({"op": "upsert", "kind": "pipeline", "id": "wp:acme/api:7", "v": {"id": "wp:acme/api:7", "repo": "acme/api", "state": "running"}}),
            eng(2, 41.25, vec!["wp:acme/api:7", "wp:volt/grid:3"]),
        ],
    );
    feed(
        &l,
        &mut w,
        2,
        base + 20_000,
        vec![eng(1, 30.0, vec!["wp:acme/api:7"])],
    );
    feed(
        &l,
        &mut w,
        3,
        base + 3 * MIN + 5_000,
        vec![eng(0, 5.0, vec![])],
    );
    let h = l.engine_history("wp-agent-1", &w, base + 4 * MIN).unwrap();
    let n = h["n"].as_u64().unwrap() as usize;
    assert_eq!(n, 1440);
    assert_eq!(h["step_ms"], 60_000);
    assert_eq!(h["host"], "VM 153");
    assert_eq!(h["from"], base + 4 * MIN - 24 * 3_600_000 + MIN);
    let busy = h["busy"].as_array().unwrap();
    assert_eq!(busy.len(), n);
    // ..., base: peak 2; base+1m, +2m carry the last value (1); base+3m: 0; base+4m: 0.
    assert_eq!(
        &busy[n - 5..],
        &[json!(2), json!(1), json!(1), json!(0), json!(0)]
    );
    assert!(busy[0].is_null(), "before anything was seen");
    let cpu = h["cpu"].as_array().unwrap();
    assert_eq!(cpu[n - 5], json!(30.0), "the minute's last cpu");
    assert_eq!(h["slots"][n - 1], 3);
    assert_eq!(
        h["repos"],
        json!([{"repo": "acme/api", "runs": 1}, {"repo": "volt/grid", "runs": 1}])
    );
    assert!(l.engine_history("nope", &w, base).is_none());
    // A Dagger host serves what its agents ran.
    feed(
        &l,
        &mut w,
        4,
        base + 3 * MIN + 30_000,
        vec![
            json!({"op": "upsert", "kind": "engine", "id": "dagger:VM 153",
        "v": {"id": "dagger:VM 153", "kind": "dagger", "host": "VM 153", "online": true, "slots": 6, "busy": 1,
              "cpu": 99.8, "running": [], "agents": ["wp-agent-1"]}}),
        ],
    );
    let host = l
        .engine_history("dagger:VM 153", &w, base + 4 * MIN)
        .unwrap();
    assert_eq!(host["repos"], h["repos"]);
    assert_eq!(host["cpu"][n - 2], json!(99.8));
}
