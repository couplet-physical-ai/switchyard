//! Contract conformance + replay over the recorded fixtures
//! (`contract/fixtures/snapshot.json` + `hour.jsonl`).

use std::path::PathBuf;

use serde_json::Value;
use switchyard::model::*;
use switchyard::wire::{WireState, shift_times};

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contract/fixtures")
}

fn snapshot() -> Value {
    serde_json::from_slice(&std::fs::read(dir().join("snapshot.json")).expect("snapshot.json"))
        .expect("json")
}

fn frames() -> Vec<Value> {
    std::fs::read_to_string(dir().join("hour.jsonl"))
        .expect("hour.jsonl")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("frame json"))
        .collect()
}

/// Parse one entity into its Rust model type (the contract's source of truth).
fn conforms(kind: &str, v: &Value) -> Result<String, String> {
    let id = |r: Result<String, serde_json::Error>| r.map_err(|e| format!("{kind}: {e}: {v}"));
    match kind {
        "org" => id(serde_json::from_value::<Org>(v.clone()).map(|x| x.id)),
        "repo" => id(serde_json::from_value::<Repo>(v.clone()).map(|x| x.id)),
        "commit" => {
            let c: Commit =
                serde_json::from_value(v.clone()).map_err(|e| format!("commit: {e}"))?;
            if c.id != ids::commit(&c.repo, &c.sha) {
                return Err(format!("commit id {} != repo@sha", c.id));
            }
            Ok(c.id)
        }
        "pipeline" => id(serde_json::from_value::<Pipeline>(v.clone()).map(|x| x.id)),
        "pr" => {
            let p: Pr = serde_json::from_value(v.clone()).map_err(|e| format!("pr: {e}"))?;
            if p.id != ids::pr(&p.repo, p.number) {
                return Err(format!("pr id {} != repo#number", p.id));
            }
            Ok(p.id)
        }
        "deploy" => {
            let d: Deploy =
                serde_json::from_value(v.clone()).map_err(|e| format!("deploy: {e}"))?;
            if d.id != ids::deploy(&d.repo, &d.sha) {
                return Err(format!("deploy id {} != repo@sha", d.id));
            }
            Ok(d.id)
        }
        "app" => id(serde_json::from_value::<App>(v.clone()).map(|x| x.id)),
        "engine" => id(serde_json::from_value::<Engine>(v.clone()).map(|x| x.id)),
        "queue" => id(serde_json::from_value::<Queue>(v.clone()).map(|x| x.id)),
        "lane" => id(serde_json::from_value::<Lane>(v.clone()).map(|x| x.id)),
        "watcher" => id(serde_json::from_value::<Watcher>(v.clone()).map(|x| x.id)),
        "stats" => id(serde_json::from_value::<Stats>(v.clone()).map(|x| x.id)),
        "group" => id(serde_json::from_value::<Group>(v.clone()).map(|x| x.id)),
        "cluster" => id(serde_json::from_value::<Cluster>(v.clone()).map(|x| x.id)),
        "flake" => id(serde_json::from_value::<Flake>(v.clone()).map(|x| x.id)),
        "trend" => id(serde_json::from_value::<Trend>(v.clone()).map(|x| x.id)),
        other => Err(format!("unknown kind {other}")),
    }
}

#[test]
fn snapshot_conforms_to_the_model() {
    let s = snapshot();
    assert_eq!(s["protocol"], PROTOCOL);
    let mut total = 0;
    for k in Kind::ALL {
        match &s[k.snapshot_field()] {
            Value::Array(a) => {
                let mut ids: Vec<String> = Vec::new();
                for v in a {
                    ids.push(conforms(k.as_str(), v).unwrap());
                }
                let n = ids.len();
                let mut sorted = ids.clone();
                sorted.sort();
                sorted.dedup();
                assert_eq!(n, sorted.len(), "{} ids unique", k.as_str());
                assert_eq!(ids, sorted, "{} sorted by id", k.as_str());
                total += n;
            }
            Value::Object(_) => {
                conforms(k.as_str(), &s[k.snapshot_field()]).unwrap();
            }
            Value::Null => assert!(k.singleton(), "{} missing", k.as_str()),
            other => panic!("{}: unexpected {other}", k.as_str()),
        }
    }
    assert!(total > 100, "a real fleet snapshot, got {total} entities");
    for k in ["repos", "commits", "pipelines", "apps", "engines", "lanes"] {
        assert!(!s[k].as_array().unwrap().is_empty(), "{k} is empty");
    }
}

#[test]
fn every_frame_conforms_and_applies_in_order() {
    let snap = snapshot();
    let mut w = WireState::from_snapshot(&snap);
    let fs = frames();
    assert!(fs.len() > 20, "a real recording, got {} frames", fs.len());
    let mut last_seq = snap["seq"].as_u64().unwrap();
    let mut last_at = snap["at"].as_i64().unwrap() - 2_000;
    let mut events = 0usize;
    for f in &fs {
        assert_eq!(f["t"], "delta");
        let seq = f["seq"].as_u64().unwrap();
        let at = f["at"].as_i64().unwrap();
        assert!(seq > last_seq, "seq increases: {seq} after {last_seq}");
        assert!(at >= last_at, "at does not go back: {at} after {last_at}");
        last_seq = seq;
        last_at = at;
        for op in f["ops"].as_array().unwrap() {
            w.apply_op(op);
            match op["op"].as_str().unwrap() {
                t @ ("upsert" | "patch" | "dot") => {
                    // Partial ops (patch, dot) are checked by the entity they produce.
                    let kind = if t == "dot" {
                        "repo"
                    } else {
                        op["kind"].as_str().unwrap()
                    };
                    let id = op["id"].as_str().unwrap();
                    let k = Kind::ALL.into_iter().find(|k| k.as_str() == kind).unwrap();
                    match w.get(k, id) {
                        Some(v) => {
                            let got = conforms(kind, v)
                                .unwrap_or_else(|e| panic!("{t} {kind} {id}: {e}"));
                            assert_eq!(id, got, "op id == entity id");
                        }
                        None => assert_ne!(t, "upsert", "an upsert always lands"),
                    }
                    if t == "dot" {
                        let recent = w
                            .get(k, id)
                            .map(|r| r["main"]["recent"].as_array().unwrap().len());
                        assert!(recent.unwrap_or(0) <= switchyard::wire::DOTS);
                    }
                }
                "remove" => {
                    assert!(op["id"].is_string());
                }
                "event" => {
                    serde_json::from_value::<Event>(op["e"].clone())
                        .unwrap_or_else(|e| panic!("event {e}: {}", op["e"]));
                    events += 1;
                }
                other => panic!("unknown op {other}"),
            }
        }
        w.seq = seq;
        w.at = at;
    }
    assert!(events > 0, "the hour has animation events");
    assert_eq!(w.seq, last_seq);
}

#[test]
fn replay_is_deterministic_and_lossless() {
    // Applying the hour twice from the snapshot gives the same state, and every
    // frame survives a round trip through the typed model unchanged.
    let snap = snapshot();
    let fs = frames();
    let run = || {
        let mut w = WireState::from_snapshot(&snap);
        for f in &fs {
            w.apply_frame(f);
        }
        w
    };
    assert_eq!(run(), run());
    for f in fs.iter().take(400) {
        for op in f["ops"].as_array().unwrap() {
            if op["op"] == "event" {
                let e: Event = serde_json::from_value(op["e"].clone()).unwrap();
                assert_eq!(serde_json::to_value(&e).unwrap(), op["e"]);
            }
            if op["op"] == "upsert" && op["kind"] == "pipeline" {
                let p: Pipeline = serde_json::from_value(op["v"].clone()).unwrap();
                assert_eq!(serde_json::to_value(&p).unwrap(), op["v"]);
            }
        }
    }
}

#[test]
fn time_shift_round_trips() {
    let snap = snapshot();
    let mut v = snap.clone();
    shift_times(&mut v, 3_600_000);
    assert_ne!(v, snap);
    assert_eq!(
        v["at"].as_i64().unwrap(),
        snap["at"].as_i64().unwrap() + 3_600_000
    );
    shift_times(&mut v, -3_600_000);
    assert_eq!(v, snap);
}

#[test]
fn fixtures_are_public_safe() {
    for name in ["snapshot.json", "hour.jsonl"] {
        let b = std::fs::read(dir().join(name)).unwrap();
        switchyard::record::check_clean(&b).unwrap_or_else(|e| panic!("{name}: {e}"));
    }
}
