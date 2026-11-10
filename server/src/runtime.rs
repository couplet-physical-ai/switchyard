//! The reducer task: the single owner of writes to the store. Adapters send
//! batches of facts over a bounded channel; every frame tick (≤ 30/s) the
//! dirty entities are re-derived and ONE frame is published for all clients.

use std::collections::BTreeMap;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::facts::Fact;
use crate::hub::{Hub, Snapshot, encode_ops};
use crate::model::{Kind, Ms, PROTOCOL};
use crate::store::Store;

pub type Clock = Arc<dyn Fn() -> Ms + Send + Sync>;

pub fn wall_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as Ms)
            .unwrap_or(0)
    })
}

pub fn now_ms() -> Ms {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as Ms)
        .unwrap_or(0)
}

/// A batch of facts from one adapter. `live = false` for backfill (no animations).
pub struct Ingest {
    pub facts: Vec<Fact>,
    pub live: bool,
}

/// Build the snapshot JSON from the store's serialized tables (no re-serialization).
pub fn build_snapshot(store: &Store, seq: u64, at: Ms, epoch: &str) -> Bytes {
    let mut size = 256;
    for k in Kind::ALL {
        size += store.table(k).values().map(|j| j.len() + 1).sum::<usize>() + 16;
    }
    let mut v = Vec::with_capacity(size);
    write!(v, "{{\"protocol\":\"{PROTOCOL}\",\"epoch\":").ok();
    serde_json::to_writer(&mut v, epoch).ok();
    write!(v, ",\"seq\":{seq},\"at\":{at}").ok();
    for k in Kind::ALL {
        write!(v, ",\"{}\":", k.snapshot_field()).ok();
        let t = store.table(k);
        if k.singleton() {
            match t.values().next() {
                Some(j) => v.extend_from_slice(j.as_bytes()),
                None => v.extend_from_slice(b"null"),
            }
            continue;
        }
        v.push(b'[');
        for (i, j) in t.values().enumerate() {
            if i > 0 {
                v.push(b',');
            }
            v.extend_from_slice(j.as_bytes());
        }
        v.push(b']');
    }
    v.push(b'}');
    Bytes::from(v)
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdapterState {
    Disabled,
    Starting,
    Syncing,
    Ok,
    Degraded,
    Error,
}

#[derive(Serialize, Clone, Debug)]
pub struct AdapterStatus {
    pub name: String,
    pub state: AdapterState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_ok: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lag_ms: Option<i64>,
    pub synced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub requests: u64,
}

/// Shared adapter health board (readyz, meta).
#[derive(Default)]
pub struct Adapters {
    inner: Mutex<BTreeMap<String, AdapterStatus>>,
}

impl Adapters {
    pub fn register(&self, name: &str, enabled: bool, note: Option<String>) {
        self.inner.lock().insert(
            name.to_string(),
            AdapterStatus {
                name: name.to_string(),
                state: if enabled {
                    AdapterState::Starting
                } else {
                    AdapterState::Disabled
                },
                last_ok: None,
                last_error: None,
                lag_ms: None,
                synced: false,
                note,
                requests: 0,
            },
        );
    }
    pub fn ok(&self, name: &str, now: Ms, lag_ms: Option<i64>) {
        if let Some(a) = self.inner.lock().get_mut(name) {
            a.state = AdapterState::Ok;
            a.last_ok = Some(now);
            a.synced = true;
            a.lag_ms = lag_ms;
        }
    }
    /// A live signal (stream event) arrived: fresh, but does not count as the
    /// initial sync.
    pub fn alive(&self, name: &str, now: Ms, lag_ms: Option<i64>) {
        if let Some(a) = self.inner.lock().get_mut(name) {
            a.last_ok = Some(now);
            a.lag_ms = lag_ms;
            if a.synced {
                a.state = AdapterState::Ok;
            }
        }
    }
    pub fn syncing(&self, name: &str) {
        if let Some(a) = self.inner.lock().get_mut(name)
            && !a.synced
        {
            a.state = AdapterState::Syncing;
        }
    }
    pub fn degraded(&self, name: &str, why: String) {
        if let Some(a) = self.inner.lock().get_mut(name) {
            a.state = AdapterState::Degraded;
            a.last_error = Some(why);
        }
    }
    pub fn error(&self, name: &str, why: String) {
        if let Some(a) = self.inner.lock().get_mut(name) {
            a.state = if a.synced {
                AdapterState::Degraded
            } else {
                AdapterState::Error
            };
            a.last_error = Some(why);
        }
    }
    pub fn request(&self, name: &str, n: u64) {
        if let Some(a) = self.inner.lock().get_mut(name) {
            a.requests += n;
        }
    }
    pub fn list(&self) -> Vec<AdapterStatus> {
        self.inner.lock().values().cloned().collect()
    }
    pub fn ready(&self) -> bool {
        self.inner
            .lock()
            .values()
            .all(|a| a.state == AdapterState::Disabled || a.synced)
    }
}

pub struct ReducerCfg {
    pub frame_ms: u64,
    pub tick_ms: u64,
    pub snapshot_ms: u64,
}

impl Default for ReducerCfg {
    fn default() -> Self {
        ReducerCfg {
            frame_ms: 33,
            tick_ms: 5_000,
            snapshot_ms: 1_000,
        }
    }
}

/// Run the reducer until the ingest channel closes.
pub async fn run_reducer(
    store: Arc<RwLock<Store>>,
    hub: Arc<Hub>,
    mut rx: mpsc::Receiver<Ingest>,
    clock: Clock,
    cfg: ReducerCfg,
) {
    let mut frame = tokio::time::interval(Duration::from_millis(cfg.frame_ms));
    frame.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut slow = tokio::time::interval(Duration::from_millis(cfg.tick_ms));
    slow.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut snap = tokio::time::interval(Duration::from_millis(cfg.snapshot_ms));
    snap.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut snap_key: (u64, u64) = (u64::MAX, u64::MAX);
    // A boot is a discontinuity for anyone replaying history across it.
    let at = clock();
    let seq = hub.publish_reset(at);
    {
        let s = store.read();
        hub.set_snapshot(Snapshot::new(
            seq,
            at,
            build_snapshot(&s, seq, at, &hub.epoch),
        ));
    }
    loop {
        tokio::select! {
            m = rx.recv() => {
                let Some(first) = m else { break };
                let mut s = store.write();
                for f in first.facts { s.apply(f, first.live); }
                // Drain whatever else is queued without waiting.
                let mut n = 0;
                while n < 256 {
                    match rx.try_recv() {
                        Ok(b) => { for f in b.facts { s.apply(f, b.live); } n += 1; }
                        Err(_) => break,
                    }
                }
            }
            _ = frame.tick() => {
                let now = clock();
                let mut s = store.write();
                if s.has_dirty() {
                    let ops = s.flush(now);
                    if !ops.is_empty() {
                        hub.publish(&encode_ops(&ops), now);
                    }
                }
            }
            _ = slow.tick() => {
                let now = clock();
                store.write().tick(now);
            }
            _ = snap.tick() => {
                let key = (store.read().version, hub.seq());
                if key != snap_key {
                    snap_key = key;
                    let at = clock();
                    let (seq, json) = {
                        let s = store.read();
                        let seq = hub.seq();
                        (seq, build_snapshot(&s, seq, at, &hub.epoch))
                    };
                    let h = hub.clone();
                    tokio::task::spawn_blocking(move || h.set_snapshot(Snapshot::new(seq, at, json)));
                }
            }
        }
    }
}
