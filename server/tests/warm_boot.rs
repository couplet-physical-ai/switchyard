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
    run(7, CiState::Running, at)
}

fn run(n: u64, state: CiState, at: Ms) -> Fact {
    Fact::Pipeline(Pipeline {
        id: format!("wp:acme/api:{n}"),
        lane: LaneKind::Roadrunner,
        repo: "acme/api".into(),
        number: n,
        sha: "abc".into(),
        branch: "main".into(),
        git_ref: None,
        event: PipelineEvent::Push,
        state,
        created: at - 1_000,
        started: Some(at - 500),
        finished: state.is_done().then_some(at),
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
    let mut client = WireState::from_snapshot(&s);
    while let Ok(f) = rx.try_recv() {
        let v: Value = serde_json::from_slice(&f.json).unwrap();
        client.apply_frame(&v);
        for op in v["ops"].as_array().into_iter().flatten() {
            // Events, and the run going now (a whole fact); never the half-built repos.
            assert!(
                op["op"] == "event" || (op["op"] == "upsert" && op["kind"] == "pipeline"),
                "only events and runs while rebuilding: {op}"
            );
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

/// A client connected before a restart (its world: the old process's, with a phantom
/// pending pipeline the new process never builds) resumes into a reset, refetches the
/// last state, and the settle delta removes the phantom; then a PipelineGone during
/// normal running removes a pipeline from it as well.
#[tokio::test]
async fn a_client_from_before_the_restart_drops_what_the_new_process_does_not_have() {
    let hub = Hub::new(
        "new".into(),
        1024,
        1024,
        History::Mem(MemHistory::new(3_600_000)),
    );
    hub.set_seq(900);
    let mut rx = hub.tx.subscribe();
    let adapters = Arc::new(Adapters::default());
    adapters.register("github", true, None);
    adapters.backfilling("github", true);
    let store = Arc::new(parking_lot::RwLock::new(Store::new(StoreConfig::default())));
    let (tx, ingest) = tokio::sync::mpsc::channel(16);
    let clock: Clock = Arc::new(now);
    let mut last = last_state();
    let phantom = json!({"id": "wp:acme/api:61", "lane": "roadrunner", "repo": "acme/api",
        "number": 61, "sha": "abc", "branch": "main", "event": "push", "state": "pending",
        "created": 1, "deploy": false, "flaky": false, "workflows": [], "url": "u"});
    last["pipelines"] = json!([phantom]);
    // The client, as the old process left it.
    let mut client = WireState::from_snapshot(&last);
    assert_eq!(pipes(&client), vec!["wp:acme/api:61"]);
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
            warm: Some(last),
            ..ReducerCfg::default()
        },
    ));
    tokio::time::sleep(Duration::from_millis(100)).await;
    // It resumes from the old process's last frame: a reset, then the snapshot.
    assert!(
        hub.since(900).is_none(),
        "a resume from before the restart is a reset"
    );
    client = WireState::from_snapshot(&snapshot_of(&hub));
    while rx.try_recv().is_ok() {}
    // The new process rebuilds: a real pipeline, never the phantom.
    tx.send(Ingest {
        facts: vec![pipeline(now())],
        live: true,
    })
    .await
    .unwrap();
    adapters.ok("github", now(), None);
    adapters.backfilling("github", false);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while hub.is_settling() {
        assert!(tokio::time::Instant::now() < deadline, "never settled");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    while let Ok(f) = rx.try_recv() {
        client.apply_frame(&serde_json::from_slice(&f.json).unwrap());
    }
    assert_eq!(
        pipes(&client),
        vec!["wp:acme/api:7"],
        "the phantom is gone, the real one is in"
    );
    // Running: Woodpecker deletes wp:acme/api:7 (a 404) → the client drops it too.
    tx.send(Ingest {
        facts: vec![Fact::PipelineGone {
            id: "wp:acme/api:7".into(),
        }],
        live: true,
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    while let Ok(f) = rx.try_recv() {
        client.apply_frame(&serde_json::from_slice(&f.json).unwrap());
    }
    assert!(
        pipes(&client).is_empty(),
        "a gone pipeline leaves the connected client"
    );
    assert_eq!(
        client.entities(),
        WireState::from_snapshot(&snapshot_of(&hub)).entities()
    );
}

fn pipes(w: &WireState) -> Vec<String> {
    w.entities()
        .iter()
        .filter(|(k, _)| k.starts_with("pipeline"))
        .flat_map(|(_, t)| t.keys().cloned())
        .collect()
}

/// A run the last state shows running that finishes while the store rebuilds reaches
/// clients finished at once (not when the boot settles, minutes later); a historic run the
/// backfill brings in waits for the settle.
#[tokio::test]
async fn a_run_that_finishes_during_the_boot_is_finished_at_once() {
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
    let mut last = last_state();
    // The last state: wp:acme/api:7 running (as the old process last saw it).
    let t = now();
    let Fact::Pipeline(p7) = run(7, CiState::Running, t) else {
        unreachable!()
    };
    last["pipelines"] = json!([serde_json::to_value(&p7).unwrap()]);
    let mut client = WireState::from_snapshot(&last);
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
            warm: Some(last),
            ..ReducerCfg::default()
        },
    ));
    tokio::time::sleep(Duration::from_millis(100)).await;
    while rx.try_recv().is_ok() {}
    // During the boot: #7 finished, #5 (an old finished run) comes in with the backfill.
    tx.send(Ingest {
        facts: vec![
            run(7, CiState::Success, now()),
            run(5, CiState::Success, now() - 3_600_000),
        ],
        live: true,
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(hub.is_settling(), "still booting");
    while let Ok(f) = rx.try_recv() {
        client.apply_frame(&serde_json::from_slice(&f.json).unwrap());
    }
    let p = client.get(Kind::Pipeline, "wp:acme/api:7").expect("#7");
    assert_eq!(
        p["state"], "success",
        "finished while the boot runs, shown finished at once"
    );
    assert!(
        client.get(Kind::Pipeline, "wp:acme/api:5").is_none(),
        "the backfill's history waits for the settle"
    );
    // The settle brings the rest; the client ends on the settled fleet.
    adapters.ok("github", now(), None);
    adapters.backfilling("github", false);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while hub.is_settling() {
        assert!(tokio::time::Instant::now() < deadline, "never settled");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    while let Ok(f) = rx.try_recv() {
        client.apply_frame(&serde_json::from_slice(&f.json).unwrap());
    }
    assert_eq!(pipes(&client), vec!["wp:acme/api:5", "wp:acme/api:7"]);
    assert_eq!(
        client.entities(),
        WireState::from_snapshot(&snapshot_of(&hub)).entities()
    );
}
