//! `/history` and `snapshot?at=` semantics (contract v0.3): the base is the fleet AT
//! `from`, the frames are what happened after it, `base=0` drops the base, and a restart
//! inside the window is a `t:"snapshot"` entry.

use bytes::Bytes;
use serde_json::{Value, json};
use switchyard::history::{History, MemHistory};
use switchyard::hub::{Hub, Snapshot};
use switchyard::wire::WireState;

const T0: i64 = 1_794_300_000_000;

fn snap(seq: u64, at: i64, apps: &[(&str, &str)]) -> Snapshot {
    let apps: Vec<Value> = apps
        .iter()
        .map(|(id, h)| json!({"id": id, "health": h}))
        .collect();
    let v = json!({"protocol": "0.3", "epoch": "e", "seq": seq, "at": at, "apps": apps});
    Snapshot::new(seq, at, Bytes::from(serde_json::to_vec(&v).unwrap()))
}

fn upsert(id: &str, health: &str) -> Vec<u8> {
    let op = json!({"op": "upsert", "kind": "app", "id": id, "v": {"id": id, "health": health}});
    serde_json::to_vec(&op).unwrap()
}

fn health(state: &WireState, id: &str) -> Option<String> {
    state
        .entities()
        .get("app")?
        .get(id)?
        .get("health")?
        .as_str()
        .map(str::to_string)
}

/// A hub whose history holds: snapshot at T0 (a=up), then a→down at T0+10 s,
/// b appears at T0+20 s, a→up at T0+30 s.
fn hub() -> std::sync::Arc<Hub> {
    let hub = Hub::new(
        "e".into(),
        64,
        64,
        History::Mem(MemHistory::new(24 * 3_600_000)),
    );
    hub.set_snapshot(snap(0, T0, &[("a", "up")]));
    hub.publish(&upsert("a", "down"), T0 + 10_000);
    hub.publish(&upsert("b", "up"), T0 + 20_000);
    hub.publish(&upsert("a", "up"), T0 + 30_000);
    hub
}

fn base_state(base: &Bytes) -> WireState {
    WireState::from_snapshot(&serde_json::from_slice::<Value>(base).unwrap())
}

fn frame_ats(frames: &[Bytes]) -> Vec<i64> {
    frames
        .iter()
        .map(|f| {
            serde_json::from_slice::<Value>(f).unwrap()["at"]
                .as_i64()
                .unwrap()
        })
        .collect()
}

#[test]
fn base_is_the_state_at_from() {
    let h = hub();
    let out = h.history.query(T0 + 15_000, T0 + 60_000).unwrap();
    let (from, out) = out.fold_to(T0 + 15_000, false, "0.3", "e");
    assert_eq!(from, T0 + 15_000);
    let st = base_state(&out.base);
    assert_eq!(st.at, T0 + 15_000);
    assert_eq!(
        st.seq, 1,
        "the base carries the seq of the last folded frame"
    );
    assert_eq!(health(&st, "a").as_deref(), Some("down"));
    assert_eq!(health(&st, "b"), None);
    assert_eq!(frame_ats(&out.frames), vec![T0 + 20_000, T0 + 30_000]);
    // Replaying the rest lands on the current state.
    let mut st = st;
    for f in &out.frames {
        assert!(st.apply_frame(&serde_json::from_slice(f).unwrap()));
    }
    assert_eq!(health(&st, "a").as_deref(), Some("up"));
    assert_eq!(health(&st, "b").as_deref(), Some("up"));
}

#[test]
fn snapshot_at_includes_a_frame_at_that_instant() {
    let h = hub();
    let out = h.history.query(T0 + 20_000, T0 + 20_000).unwrap();
    let (_, out) = out.fold_to(T0 + 20_000, true, "0.3", "e");
    let st = base_state(&out.base);
    assert_eq!(health(&st, "b").as_deref(), Some("up"));
    assert_eq!(health(&st, "a").as_deref(), Some("down"));
}

#[test]
fn base_0_returns_only_what_happened_after_from() {
    let h = hub();
    let out = h
        .history
        .query(T0 + 10_000, T0 + 60_000)
        .unwrap()
        .after(T0 + 10_000);
    assert_eq!(&out.base[..], b"null");
    assert_eq!(frame_ats(&out.frames), vec![T0 + 20_000, T0 + 30_000]);
    let body: Value = serde_json::from_slice(&out.to_json(T0 + 10_000, T0 + 60_000)).unwrap();
    assert!(body["base"].is_null());
    assert_eq!(body["frames"].as_array().unwrap().len(), 2);
}

#[test]
fn a_from_before_the_oldest_state_moves_up() {
    let h = hub();
    let out = h.history.query(T0 - 600_000, T0 + 60_000).unwrap();
    let (from, out) = out.fold_to(T0 - 600_000, false, "0.3", "e");
    assert_eq!(from, T0);
    assert_eq!(base_state(&out.base).at, T0);
    assert_eq!(out.frames.len(), 3);
}

#[test]
fn a_restart_inside_the_window_replaces_the_state() {
    let h = hub();
    // A restart: new snapshot (only c) after a reset.
    let seq = h.publish_reset(T0 + 40_000);
    // The checkpoint written right after a reset carries the reset's seq.
    h.force_snapshot(snap(seq, T0 + 40_000, &[("c", "up")]));
    h.publish(&upsert("c", "down"), T0 + 50_000);
    let out = h.history.query(T0 + 45_000, T0 + 60_000).unwrap();
    let (_, out) = out.fold_to(T0 + 45_000, false, "0.3", "e");
    let st = base_state(&out.base);
    assert_eq!(health(&st, "c").as_deref(), Some("up"));
    assert_eq!(health(&st, "a"), None, "state before the restart is gone");
    assert_eq!(frame_ats(&out.frames), vec![T0 + 50_000]);
}
