//! A pipeline Woodpecker deleted (a 404 for its detail) leaves the board: the store
//! drops it and live clients get a remove op for it.

use serde_json::{Value, json};
use switchyard::adapters::woodpecker::WpPipeline;
use switchyard::facts::*;
use switchyard::model::*;
use switchyard::store::{OpOut, Store, StoreConfig};
use switchyard::wire::WireState;

const NOW: Ms = 1_794_340_000_000;
const REPO: &str = "acme/api";

fn pending(n: u64) -> Fact {
    let raw: WpPipeline = serde_json::from_value(json!({
        "number": n, "event": "push", "status": "pending", "branch": "main",
        "commit": "2222222222222222222222222222222222222222", "created": NOW / 1000 - 60,
        "workflows": [{"id": 1, "name": "ci", "state": "pending"}]
    }))
    .unwrap();
    let m = switchyard::adapters::woodpecker::Mapper {
        public_url: "https://ci.example".into(),
        agents: Default::default(),
    };
    m.facts(REPO, 7, &raw).remove(0)
}

fn wire(ops: &[OpOut], w: &mut WireState) {
    for op in ops {
        let mut b = Vec::new();
        op.write_json(&mut b);
        let v: Value = serde_json::from_slice(&b).unwrap();
        w.apply_op(&v);
    }
}

#[test]
fn gone_removes_a_pending_pipeline_and_tells_clients() {
    let id = ids::wp_pipeline(REPO, 61);
    let mut s = Store::new(StoreConfig::default());
    let mut w = WireState::default();
    s.apply(pending(61), true);
    s.apply(pending(62), true);
    wire(&s.flush(NOW), &mut w);
    assert_eq!(s.pipeline(&id).map(|p| p.state), Some(CiState::Pending));
    assert!(w.get(Kind::Pipeline, &id).is_some());

    s.apply(Fact::PipelineGone { id: id.clone() }, true);
    let ops = s.flush(NOW + 1_000);
    assert!(
        ops.contains(&OpOut::Remove {
            kind: Kind::Pipeline,
            id: id.clone()
        }),
        "a remove op for the pipeline: {ops:?}"
    );
    wire(&ops, &mut w);
    assert!(s.pipeline(&id).is_none());
    assert!(!s.table(Kind::Pipeline).contains_key(&id));
    assert!(w.get(Kind::Pipeline, &id).is_none());
    // Its sibling is untouched.
    let other = ids::wp_pipeline(REPO, 62);
    assert!(s.pipeline(&other).is_some());
    assert!(w.get(Kind::Pipeline, &other).is_some());
    // Nothing comes back on later flushes.
    s.tick(NOW + 5_000);
    s.flush(NOW + 5_000);
    assert!(!s.table(Kind::Pipeline).contains_key(&id));
}

#[test]
fn gone_for_an_unknown_pipeline_is_a_no_op() {
    let mut s = Store::new(StoreConfig::default());
    s.apply(pending(62), true);
    s.flush(NOW);
    let before = s.table(Kind::Pipeline).clone();
    s.apply(
        Fact::PipelineGone {
            id: ids::wp_pipeline(REPO, 99),
        },
        true,
    );
    let ops = s.flush(NOW);
    assert!(
        !ops.iter().any(|o| matches!(o, OpOut::Remove { .. })),
        "{ops:?}"
    );
    assert_eq!(s.table(Kind::Pipeline), &before);
}

/// Woodpecker reuses a deleted pipeline's number (help-agent #65: a phantom, then a
/// pull request's run). The real run replaces the phantom whole, in the store and in a
/// connected client: no state, created time, event, PR link or workflow of the phantom
/// survives, whatever the two lifecycles; a late fact of the phantom changes nothing.
#[test]
fn a_reused_number_replaces_the_old_run_whole() {
    let id = ids::wp_pipeline(REPO, 65);
    let run = |sha: &str, event: &str, status: &str, created: i64, extra: Value| {
        let mut v = json!({
            "number": 65, "event": event, "status": status, "branch": "main",
            "commit": sha, "created": created, "started": created + 5,
            "workflows": [{"id": 1, "name": "phantom-ci", "state": status, "started": created + 5}]
        });
        if let (Some(o), Some(x)) = (v.as_object_mut(), extra.as_object()) {
            o.extend(x.clone());
        }
        let raw: WpPipeline = serde_json::from_value(v).unwrap();
        let m = switchyard::adapters::woodpecker::Mapper {
            public_url: "https://ci.example".into(),
            agents: Default::default(),
        };
        m.facts(REPO, 7, &raw).remove(0)
    };
    let t0 = NOW / 1000 - 3_600;
    // The phantom: a running pull-request run (lifecycle ahead of the new run's pending).
    let phantom = run(
        "1111111111111111111111111111111111111111",
        "pull_request",
        "running",
        t0,
        json!({"ref": "refs/pull/41/head", "pull_request_title": "old"}),
    );
    let mut s = Store::new(StoreConfig::default());
    let mut w = WireState::default();
    s.apply(phantom.clone(), true);
    wire(&s.flush(NOW), &mut w);
    let before = w.get(Kind::Pipeline, &id).cloned().unwrap();
    assert_eq!(before["event"], "pull_request");
    assert_eq!(before["pr"], 41);

    // The real run on the reused number: a push, pending, another commit, later.
    let real = run(
        "2222222222222222222222222222222222222222",
        "push",
        "pending",
        t0 + 1_800,
        json!({"workflows": [{"id": 1, "name": "ci", "state": "pending"}], "started": 0}),
    );
    s.apply(real, true);
    wire(&s.flush(NOW + 1_000), &mut w);
    let p = s.pipeline(&id).expect("the real run");
    assert_eq!(
        p.state,
        CiState::Pending,
        "the real run, not the phantom's running"
    );
    assert_eq!(p.sha, "2222222222222222222222222222222222222222");
    assert_eq!(p.event, PipelineEvent::Push);
    assert_eq!(p.pr, None);
    assert_eq!(p.created, (t0 + 1_800) * 1000);
    assert_eq!(p.started, None);
    // The client holds exactly the store's entity: nothing of the phantom merged in.
    let store_json: Value = serde_json::from_str(&s.table(Kind::Pipeline)[&id]).unwrap();
    let client = w.get(Kind::Pipeline, &id).unwrap();
    assert_eq!(client, &store_json);
    for k in ["pr", "started", "git_ref"] {
        assert!(
            client.get(k).is_none(),
            "{k} of the phantom survived: {client}"
        );
    }
    assert_eq!(client["workflows"][0]["name"], "ci");
    assert!(
        !s.table(Kind::Commit)
            .get(&format!("{REPO}@1111111111111111111111111111111111111111"))
            .is_some_and(|c| c.contains(&id)),
        "the phantom's commit no longer lists the run"
    );

    // A late fact of the phantom (a reconcile, a replay) is old news.
    s.apply(phantom, true);
    wire(&s.flush(NOW + 2_000), &mut w);
    assert_eq!(s.pipeline(&id).unwrap().state, CiState::Pending);
    assert_eq!(w.get(Kind::Pipeline, &id).unwrap()["event"], "push");
}
