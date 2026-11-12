//! Warm boot: after a restart, clients are served the fleet as it was before it while
//! the store rebuilds (never the half-empty fleet a cold boot fills in from nothing),
//! then move to the rebuilt fleet in one delta when the boot settles.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use switchyard::facts::Fact;
use switchyard::history::{History, MemHistory};
use switchyard::hub::{FrameKind, Hub};
use switchyard::model::*;
use switchyard::runtime::{Adapters, Clock, Ingest, ReducerCfg, run_reducer};
use switchyard::store::{Store, StoreConfig};
use switchyard::wire::WireState;

fn now() -> Ms {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as Ms
}

fn repo(id: &str, state: &str) -> Value {
    let (org, name) = id.split_once('/').unwrap();
    json!({"id": id, "org": org, "name": name, "default_branch": "main", "lane": "none",
           "main": {"head": "abc", "state": state, "since": 1, "recent": []},
           "heat": 0.0, "open_prs": 0, "last_activity": 1,
           "links": {"github": format!("https://github.com/{id}")}})
}

/// The fleet before the restart: two repos, one of them red.
fn last_state() -> Value {
    json!({"protocol": PROTOCOL, "epoch": "old", "seq": 900, "at": 1,
           "repos": [repo("acme/api", "success"), repo("acme/old", "failure")]})
}

fn pipeline(at: Ms) -> Fact {
    Fact::Pipeline(Pipeline {
        id: "wp:acme/api:7".into(),
        lane: LaneKind::Roadrunner,
        repo: "acme/api".into(),
        number: 7,
        sha: "abc".into(),
        branch: "main".into(),
        git_ref: None,
        event: PipelineEvent::Push,
        state: CiState::Running,
        created: at - 1_000,
        started: Some(at - 500),
        finished: None,
        queue_pos: None,
        expected_ms: None,
        engine: None,
        title: Some("change".into()),
        author: Some("dev".into()),
        pr: None,
        deploy: false,
        flaky: false,
        workflows: vec![],
        url: "https://ci.example/repos/1/pipeline/7".into(),
        links: Default::default(),
    })
}

fn snapshot_of(hub: &Hub) -> Value {
    serde_json::from_slice(&hub.snapshot().json).unwrap()
}

fn ids(s: &Value, field: &str) -> Vec<String> {
    s[field]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|e| e["id"].as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn clients_keep_the_last_state_until_the_boot_settles() {
    let hub = Hub::new(
        "new".into(),
        1024,
        1024,
        History::Mem(MemHistory::new(3_600_000)),
    );
    let mut rx = hub.tx.subscribe();
    let adapters = Arc::new(Adapters::default());
    adapters.register("github", true, None);
    adapters.backfilling("github", true);
    let store = Arc::new(parking_lot::RwLock::new(Store::new(StoreConfig::default())));
    let (tx, ingest) = tokio::sync::mpsc::channel(16);
    let clock: Clock = Arc::new(now);
    tokio::spawn(run_reducer(
        store,
        hub.clone(),
        ingest,
        clock,
        ReducerCfg {
            frame_ms: 10,
            snapshot_ms: 20,
            settle_on: Some(adapters.clone()),
            settle_quiet_ms: 50,
            warm: Some(last_state()),
            ..ReducerCfg::default()
        },
    ));
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Booting: the last state is what clients get, with this boot's seq and epoch.
    assert!(hub.is_settling());
    let s = snapshot_of(&hub);
    assert_eq!(ids(&s, "repos"), vec!["acme/api", "acme/old"]);
    assert_eq!(s["epoch"], "new");
    let reset = rx.recv().await.unwrap();
    assert_eq!(reset.kind, FrameKind::Reset);
    assert_eq!(s["seq"].as_u64().unwrap(), reset.seq);

    // The store rebuilds (a pipeline, its repo): nothing of it reaches clients yet.
    tx.send(Ingest {
        facts: vec![pipeline(now())],
        live: true,
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    while let Ok(f) = rx.try_recv() {
        let v: Value = serde_json::from_slice(&f.json).unwrap();
        for op in v["ops"].as_array().into_iter().flatten() {
            assert_eq!(op["op"], "event", "only events while rebuilding: {op}");
        }
    }
    assert_eq!(
        ids(&snapshot_of(&hub), "repos"),
        vec!["acme/api", "acme/old"]
    );
    assert!(ids(&snapshot_of(&hub), "pipelines").is_empty());

    // The boot settles: one move from the last state to the rebuilt fleet.
    adapters.ok("github", now(), None);
    adapters.backfilling("github", false);
    let mut client = WireState::from_snapshot(&s);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while hub.is_settling() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the boot never settled"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    while let Ok(f) = rx.try_recv() {
        let v: Value = serde_json::from_slice(&f.json).unwrap();
        client.apply_frame(&v);
    }
    let settled = snapshot_of(&hub);
    assert_eq!(ids(&settled, "repos"), vec!["acme/api"], "acme/old is gone");
    assert_eq!(ids(&settled, "pipelines"), vec!["wp:acme/api:7"]);
    assert_eq!(
        client.entities(),
        WireState::from_snapshot(&settled).entities(),
        "a client that kept the last state and applied the stream holds the settled fleet"
    );
    assert_eq!(client.seq, settled["seq"].as_u64().unwrap());
    // History records the restart as the settled fleet.
    let h = hub.history.query(now(), now()).unwrap();
    let base: Value = serde_json::from_slice(&h.base).unwrap();
    assert_eq!(ids(&base, "repos"), vec!["acme/api"]);
}

#[test]
fn the_last_state_is_the_last_checkpoint_plus_its_frames() {
    use switchyard::hub::{Frame, Snapshot};
    let h = History::Mem(MemHistory::new(3_600_000));
    let t = 1_794_400_000_000;
    let base = json!({"protocol": PROTOCOL, "epoch": "e", "seq": 1, "at": t,
                      "repos": [repo("acme/api", "success")]});
    h.checkpoint(&Arc::new(Snapshot::new(
        1,
        t,
        serde_json::to_vec(&base).unwrap().into(),
    )));
    let ops = serde_json::to_vec(&json!({"op": "upsert", "kind": "repo", "id": "acme/web",
                                         "v": repo("acme/web", "failure")}))
    .unwrap();
    h.append(&Arc::new(Frame::delta(2, t + 1_000, &ops)));
    let last = h.last_state(t + 60_000, 3_600_000, PROTOCOL, "e").unwrap();
    let v: Value = serde_json::from_slice(&last).unwrap();
    assert_eq!(ids(&v, "repos"), vec!["acme/api", "acme/web"]);
    assert_eq!(v["seq"], 2);
    // Too old: a cold boot.
    assert!(
        h.last_state(t + 3 * 3_600_000, 3_600_000, PROTOCOL, "e")
            .is_none()
    );
    assert!(
        History::Mem(MemHistory::new(1))
            .last_state(t, 3_600_000, PROTOCOL, "e")
            .is_none()
    );
}
