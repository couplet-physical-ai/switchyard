//! Stream limits clients rely on: the served snapshot follows the stream within a
//! second (demo playback included), and no stream message exceeds 512 KB, not even a
//! long catch-up or a boot backfill.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures::StreamExt;
use parking_lot::RwLock;
use serde_json::{Value, json};
use switchyard::api::{AppState, router};
use switchyard::auth::{Auth, AuthMode};
use switchyard::demo::{Fixtures, run_demo};
use switchyard::history::{History, MemHistory};
use switchyard::hub::{Hub, MAX_MESSAGE, Snapshot, encode_ops_chunked};
use switchyard::runtime::{Adapters, Clock, wall_clock};
use switchyard::wire::WireState;

const T0: i64 = 1_794_300_000_000;

fn app(id: &str, note: &str) -> Value {
    json!({"op": "upsert", "kind": "app", "id": id, "v": {"id": id, "health": "up", "note": note}})
}

#[tokio::test]
async fn demo_snapshot_follows_the_stream_within_a_second() {
    // Frames 2.5 s apart at --speed 5 (0.5 s of wall time), with one 40 s gap (8 s of
    // wall time): the snapshot must catch up during the gap, not at the next frame.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("snapshot.json"),
        json!({"protocol": "0.4", "epoch": "rec", "seq": 0, "at": T0, "apps": []}).to_string(),
    )
    .unwrap();
    let mut hour = String::new();
    let mut at = T0;
    for i in 1..=8 {
        at += if i == 5 { 40_000 } else { 2_500 };
        let f = json!({"t": "delta", "seq": i, "at": at, "ops": [app(&format!("a{i}"), "x")]});
        hour.push_str(&f.to_string());
        hour.push('\n');
    }
    std::fs::write(dir.path().join("hour.jsonl"), hour).unwrap();
    let fx = Arc::new(Fixtures::load(dir.path()).unwrap());
    let hub = Hub::new(
        "e".into(),
        256,
        256,
        History::Mem(MemHistory::new(3_600_000)),
    );
    let adapters = Arc::new(Adapters::default());
    adapters.register("demo", true, None);
    tokio::spawn(run_demo(hub.clone(), fx, wall_clock(), adapters, 5.0));
    // Let the pre-recorded previous loop and the loop start settle.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut behind_since: Option<Instant> = None;
    let mut worst = Duration::ZERO;
    let mut caught_up_in_gap = false;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(9) {
        let (stream, snap) = (hub.seq(), hub.snapshot().seq);
        if snap < stream {
            let t = *behind_since.get_or_insert_with(Instant::now);
            worst = worst.max(t.elapsed());
        } else {
            behind_since = None;
            if start.elapsed() > Duration::from_secs(4) {
                caught_up_in_gap = true;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        worst <= Duration::from_millis(1_300),
        "snapshot trailed the stream by {worst:?}"
    );
    assert!(
        caught_up_in_gap,
        "the snapshot caught up while no frame arrived"
    );
    let snap: Value = serde_json::from_slice(&hub.snapshot().json).unwrap();
    assert_eq!(snap["seq"].as_u64(), Some(hub.snapshot().seq));
}

#[test]
fn a_big_flush_becomes_several_frames() {
    use switchyard::model::Kind;
    use switchyard::store::OpOut;
    let big = "x".repeat(40_000);
    let ops: Vec<OpOut> = (0..60)
        .map(|i| OpOut::Upsert {
            kind: Kind::App,
            id: format!("a{i}"),
            json: Arc::from(json!({"id": format!("a{i}"), "note": big}).to_string()),
        })
        .collect();
    let chunks = encode_ops_chunked(&ops);
    assert!(chunks.len() >= 5);
    let mut n = 0;
    for c in &chunks {
        assert!(c.len() <= MAX_MESSAGE, "{} bytes", c.len());
        let arr: Value = serde_json::from_slice(&[b"[".as_slice(), c, b"]"].concat()).unwrap();
        n += arr.as_array().unwrap().len();
    }
    assert_eq!(n, 60, "every op, in order, exactly once");
}

#[tokio::test]
async fn a_one_hour_resume_never_sends_more_than_512_kb_at_once() {
    // An hour of busy frames (~6 MB) sits in the ring; a client resuming from the start
    // gets them as several messages, none over 512 KB, ending at the latest seq.
    let hub = Hub::new("e".into(), 4096, 4096, History::Off);
    hub.set_snapshot(Snapshot::new(
        0,
        T0,
        Bytes::from_static(br#"{"protocol":"0.4","seq":0,"at":0}"#),
    ));
    let note = "y".repeat(20_000);
    for i in 0..300 {
        let op = app(&format!("a{}", i % 40), &note).to_string();
        hub.publish(op.as_bytes(), T0 + i * 12_000);
    }
    let last = hub.seq();
    let clock: Clock = Arc::new(|| T0 + 3_600_000);
    let st = Arc::new(AppState {
        hub: hub.clone(),
        mirror: Arc::new(RwLock::new(WireState::default())),
        store: None,
        adapters: Arc::new(Adapters::default()),
        auth: Arc::new(Auth::new(
            AuthMode::Open,
            "x-auth-request-email",
            vec![],
            None,
        )),
        traces: None,
        logs: None,
        clock,
        mode: "test",
        version: "0".into(),
        git_sha: "0".into(),
        orgs: vec![],
        static_dir: None,
        public_url: "http://127.0.0.1".into(),
    });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, router(st)).await.unwrap() });
    let (mut ws, _) =
        tokio_tungstenite::connect_async(format!("ws://{addr}/api/v1/stream?since=0"))
            .await
            .unwrap();
    let (mut messages, mut ops, mut biggest, mut got) = (0, 0, 0, 0u64);
    while got < last {
        let m = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("frames keep coming")
            .unwrap()
            .unwrap();
        let b = m.into_data();
        biggest = biggest.max(b.len());
        let f: Value = serde_json::from_slice(&b).unwrap();
        if f["t"] == "delta" {
            messages += 1;
            ops += f["ops"].as_array().unwrap().len();
            got = f["seq"].as_u64().unwrap();
        }
    }
    assert!(biggest <= MAX_MESSAGE, "largest message {biggest} bytes");
    assert_eq!(ops, 300, "every frame's ops arrive exactly once");
    assert!(
        messages >= 12,
        "6 MB arrive as several messages, got {messages}"
    );
}
