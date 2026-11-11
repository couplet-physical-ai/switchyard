//! `/api/v1/changes?since=` (the ledger) and `/api/v1/insights` on a scripted stream.

use serde_json::{Value, json};
use switchyard::ledger::{Ledger, insights};
use switchyard::wire::WireState;

const T0: i64 = 1_794_300_000_000;
const MIN: i64 = 60_000;

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
        json!([{"id": "team:software", "failed": 1, "red": 1}])
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
    assert_eq!(n["apps_recovered"], 1);
    assert_eq!(n["apps_down"], 0);
}

#[test]
fn a_visit_before_the_ledger_is_incomplete_and_clamped() {
    let (l, w) = scripted();
    let c = l.changes(T0 - 48 * 3_600_000, T0 + 40 * MIN, &w);
    assert_eq!(c["complete"], false);
    assert_eq!(c["since"], T0 + 40 * MIN - 24 * 3_600_000);
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
