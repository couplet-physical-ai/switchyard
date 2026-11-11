//! Replayed history from before contract 0.5 carries the live repo → group map.

use bytes::Bytes;
use serde_json::{Value, json};
use switchyard::history::HistoryOut;
use switchyard::regroup::{GroupMap, history};
use switchyard::wire::WireState;

const T0: i64 = 1_794_300_000_000;
const MIN: i64 = 60_000;

fn repo(id: &str, state: &str) -> Value {
    json!({"id": id, "org": id.split('/').next().unwrap(), "name": id.split('/').nth(1).unwrap(),
           "main": {"sha": "abc", "state": state, "at": T0}})
}

fn frame(seq: u64, at: i64, ops: Vec<Value>) -> Bytes {
    Bytes::from(
        serde_json::to_vec(&json!({"t": "delta", "seq": seq, "at": at, "ops": ops})).unwrap(),
    )
}

/// The live fleet: api + web in team Software, grid in team Power.
fn live() -> GroupMap {
    let mut w = WireState::default();
    for (id, g) in [
        ("acme/api", "team:software"),
        ("acme/web", "team:software"),
        ("volt/grid", "team:power"),
    ] {
        let mut r = repo(id, "success");
        r["group"] = g.into();
        w.apply_op(&json!({"op": "upsert", "kind": "repo", "id": id, "v": r}));
    }
    for (id, name) in [("team:software", "Software"), ("team:power", "Power")] {
        w.apply_op(&json!({"op": "upsert", "kind": "group", "id": id,
            "v": {"id": id, "name": name, "kind": "team", "repos": 9, "apps": 9, "red": 9}}));
    }
    GroupMap::from_view(&w)
}

/// A v0.4 window: no groups anywhere; then the 0.5 boot (its own groups).
fn recorded() -> HistoryOut {
    let mut base = WireState::default();
    for id in ["acme/api", "acme/web", "volt/grid", "gone/old"] {
        base.apply_op(&json!({"op": "upsert", "kind": "repo", "id": id, "v": repo(id, "success")}));
    }
    base.apply_op(&json!({"op": "upsert", "kind": "app", "id": "api",
        "v": {"id": "api", "repo": "acme/api", "url": "https://api", "health": "up", "checked": T0}}));
    base.apply_op(&json!({"op": "upsert", "kind": "app", "id": "lab",
        "v": {"id": "lab", "team": "Power", "url": "https://lab", "health": "up", "checked": T0}}));
    base.seq = 10;
    base.at = T0;
    let frames = vec![
        // api turns red (a whole-repo upsert, no group).
        frame(
            11,
            T0 + MIN,
            vec![
                json!({"op": "upsert", "kind": "repo", "id": "acme/api", "v": repo("acme/api", "failure")}),
            ],
        ),
        // Nothing about repos or apps.
        frame(
            12,
            T0 + 2 * MIN,
            vec![
                json!({"op": "upsert", "kind": "pipeline", "id": "p1", "v": {"id": "p1", "repo": "acme/api"}}),
            ],
        ),
        // grid turns red (a patch).
        frame(
            13,
            T0 + 3 * MIN,
            vec![
                json!({"op": "patch", "kind": "repo", "id": "volt/grid", "v": {"main": {"state": "failure"}}}),
            ],
        ),
        // The 0.5 boot: real groups (only Software here) and repo groups.
        frame(
            14,
            T0 + 4 * MIN,
            vec![
                json!({"op": "patch", "kind": "repo", "id": "acme/api", "v": {"group": "team:software"}}),
                json!({"op": "upsert", "kind": "group", "id": "team:software",
                   "v": {"id": "team:software", "name": "Software", "kind": "team", "repos": 2, "apps": 1, "red": 1}}),
            ],
        ),
        frame(
            15,
            T0 + 5 * MIN,
            vec![
                json!({"op": "patch", "kind": "repo", "id": "acme/api", "v": {"main": {"state": "success"}}}),
            ],
        ),
    ];
    HistoryOut {
        base: Bytes::from(serde_json::to_vec(&base.to_snapshot("0.4", "e")).unwrap()),
        base_seq: 10,
        base_at: T0,
        frames,
    }
}

fn group<'a>(w: &'a WireState, id: &str) -> &'a Value {
    w.get(switchyard::model::Kind::Group, id)
        .unwrap_or_else(|| panic!("no group {id}"))
}

#[test]
fn a_past_snapshot_has_the_live_groups() {
    let map = live();
    // `/snapshot?at=` = fold to `at`, then fill.
    let (_, h) = recorded().fold_to(T0 + 3 * MIN + 1, true, "0.5", "e");
    let h = history(h, &map, "0.5", "e");
    let s: Value = serde_json::from_slice(&h.base).unwrap();
    let repos = s["repos"].as_array().unwrap();
    assert!(repos.iter().all(|r| r["group"].is_string()), "{repos:?}");
    let w = WireState::from_snapshot(&s);
    let g = |id: &str| w.get(switchyard::model::Kind::Repo, id).unwrap()["group"].clone();
    assert_eq!(g("acme/web"), "team:software");
    assert_eq!(g("volt/grid"), "team:power");
    assert_eq!(
        g("gone/old"),
        "org:gone",
        "a repo the live fleet lost: its org"
    );
    // Counts are the state at that time; names are the live ones.
    assert_eq!(
        group(&w, "team:software"),
        &json!({"id": "team:software", "name": "Software", "kind": "team", "repos": 2, "apps": 1, "red": 1})
    );
    assert_eq!(group(&w, "team:power")["red"], 1);
    assert_eq!(
        group(&w, "team:power")["apps"],
        1,
        "an app without a repo: its team"
    );
    assert_eq!(group(&w, "org:gone")["kind"], "org");
    assert_eq!(s["groups"].as_array().unwrap().len(), 3);
}

#[test]
fn a_replay_keeps_groups_and_moves_their_counts() {
    let map = live();
    let raw = recorded();
    let raw_frames = raw.frames.clone();
    let (_, h) = raw.fold_to(T0, true, "0.5", "e");
    let h = history(h, &map, "0.5", "e");
    // The client: base, then every frame.
    let mut w = WireState::from_snapshot(&serde_json::from_slice(&h.base).unwrap());
    assert_eq!(group(&w, "team:software")["red"], 0);
    let mut after = Vec::new();
    for f in &h.frames {
        w.apply_frame(&serde_json::from_slice(f).unwrap());
        assert!(
            w.iter(switchyard::model::Kind::Repo)
                .all(|(_, r)| r["group"].is_string()),
            "a repo lost its group after {}",
            String::from_utf8_lossy(f)
        );
        after.push(w.clone());
    }
    assert_eq!(h.frames.len(), 5);
    // 11: api's upsert carries its group, and Software's red count moves.
    let f11: Value = serde_json::from_slice(&h.frames[0]).unwrap();
    assert_eq!(f11["ops"][0]["v"]["group"], "team:software");
    assert_eq!(group(&after[0], "team:software")["red"], 1);
    // 12: untouched, byte for byte.
    assert_eq!(h.frames[1], raw_frames[1]);
    // 13: a patch turns grid red: Power's count follows.
    assert_eq!(group(&after[2], "team:power")["red"], 1);
    // 14: the 0.5 boot's groups are the real ones; filled-in groups it lacks go.
    assert!(
        after[3]
            .get(switchyard::model::Kind::Group, "team:power")
            .is_none()
    );
    assert!(
        after[3]
            .get(switchyard::model::Kind::Group, "org:gone")
            .is_none()
    );
    assert_eq!(group(&after[3], "team:software")["repos"], 2);
    // After it: recorded frames as they are.
    assert_eq!(h.frames[4], raw_frames[4]);
}

#[test]
fn grouped_history_passes_through() {
    let map = live();
    let (_, h) = recorded().fold_to(T0 + 4 * MIN, true, "0.5", "e");
    let before = h.base.clone();
    let mut w = WireState::from_snapshot(&serde_json::from_slice(&before).unwrap());
    // Make it a fully grouped (0.5) state.
    switchyard::regroup::regroup_state(&mut w, &map);
    let base = Bytes::from(serde_json::to_vec(&w.to_snapshot("0.5", "e")).unwrap());
    let h = HistoryOut {
        base: base.clone(),
        base_seq: 14,
        base_at: T0 + 4 * MIN,
        frames: vec![],
    };
    let out = history(h, &map, "0.5", "e");
    assert_eq!(out.base, base, "untouched");
}
