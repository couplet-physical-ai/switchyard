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
use crate::hub::{Hub, Snapshot, encode_ops_chunked};
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
    /// When `last_error` happened (an adapter back to `ok` keeps its last error).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lag_ms: Option<i64>,
    pub synced: bool,
    /// The adapter's slow boot backfill is still loading (it may be `synced`, i.e.
    /// ready, before that). Settling waits for it.
    #[serde(skip_serializing_if = "is_false")]
    pub backfilling: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub requests: u64,
}

fn is_false(b: &bool) -> bool {
    !*b
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
                last_error_at: None,
                lag_ms: None,
                synced: false,
                backfilling: false,
                note,
                requests: 0,
            },
        );
    }
    pub fn ok(&self, name: &str, now: Ms, lag_ms: Option<i64>) {
        if let Some(a) = self.inner.lock().get_mut(name) {
            if matches!(a.state, AdapterState::Degraded | AdapterState::Error) {
                tracing::info!(adapter = name, after = ?a.last_error, "adapter recovered");
            }
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
            Self::set_error(name, a, AdapterState::Degraded, why);
        }
    }
    pub fn error(&self, name: &str, why: String) {
        if let Some(a) = self.inner.lock().get_mut(name) {
            let st = if a.synced {
                AdapterState::Degraded
            } else {
                AdapterState::Error
            };
            Self::set_error(name, a, st, why);
        }
    }
    /// Record a failure; log when the adapter leaves `ok` (or the reason changes), not on
    /// every repeat.
    fn set_error(name: &str, a: &mut AdapterStatus, st: AdapterState, why: String) {
        if a.state != st || a.last_error.as_deref() != Some(why.as_str()) {
            tracing::warn!(adapter = name, state = ?st, error = %why, "adapter unhealthy");
        }
        a.state = st;
        a.last_error = Some(why);
        a.last_error_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as Ms)
                .unwrap_or(0),
        );
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
    /// Mark the adapter's slow boot backfill as running (`true`) or done (`false`).
    pub fn backfilling(&self, name: &str, on: bool) {
        if let Some(a) = self.inner.lock().get_mut(name) {
            a.backfilling = on;
        }
    }
    /// Every enabled adapter is synced and done with its boot backfill.
    pub fn settled(&self) -> bool {
        self.inner
            .lock()
            .values()
            .all(|a| a.state == AdapterState::Disabled || (a.synced && !a.backfilling))
    }
}

pub struct ReducerCfg {
    pub frame_ms: u64,
    pub tick_ms: u64,
    pub snapshot_ms: u64,
    /// Keep the boot out of history until these adapters are synced (and quiet for
    /// `settle_quiet_ms`, at most `settle_max_ms`); None records the boot as it happens.
    pub settle_on: Option<Arc<Adapters>>,
    pub settle_quiet_ms: Ms,
    pub settle_max_ms: Ms,
    /// Hourly trend rollups (`<data-dir>/rollups.jsonl`): loaded at boot, appended as
    /// hours close, kept 8 days. None: in memory only.
    pub rollups: Option<std::path::PathBuf>,
    /// Refresh the Factory Floor tables at most this often (they scan the fleet).
    pub insights_every_ms: Ms,
}

/// Load the persisted rollups (dropping those older than the keep window) and rewrite
/// the file compacted. Returns them and the newest hour.
pub fn load_rollups(path: &std::path::Path, now: Ms) -> (Vec<crate::facts::RollupFact>, Ms) {
    let keep = now - crate::store::ROLLUP_KEEP_MS;
    let mut out: BTreeMap<Ms, crate::facts::RollupFact> = BTreeMap::new();
    if let Ok(s) = std::fs::read_to_string(path) {
        for l in s.lines() {
            if let Ok(r) = serde_json::from_str::<crate::facts::RollupFact>(l)
                && r.hour >= keep
            {
                out.insert(r.hour, r);
            }
        }
    }
    let mut body = String::new();
    for r in out.values() {
        body.push_str(&serde_json::to_string(r).unwrap_or_default());
        body.push('\n');
    }
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, body).is_ok() {
        std::fs::rename(&tmp, path).ok();
    }
    let last = out.keys().next_back().copied().unwrap_or(0);
    (out.into_values().collect(), last)
}

fn append_rollups(path: &std::path::Path, rs: &[crate::facts::RollupFact]) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        for r in rs {
            let _ = writeln!(f, "{}", serde_json::to_string(r).unwrap_or_default());
        }
    }
}

impl Default for ReducerCfg {
    fn default() -> Self {
        ReducerCfg {
            frame_ms: 33,
            tick_ms: 5_000,
            snapshot_ms: 1_000,
            settle_on: None,
            settle_quiet_ms: 5_000,
            settle_max_ms: 600_000,
            rollups: None,
            insights_every_ms: 1_000,
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
    let boot_at = at;
    let mut rollups_written: Ms = 0;
    let mut last_insights: Ms = 0;
    if let Some(p) = &cfg.rollups {
        let (rs, last) = load_rollups(p, at);
        tracing::info!(hours = rs.len(), "trend rollups loaded");
        let mut s = store.write();
        for r in rs {
            s.apply(crate::facts::Fact::Rollup(r), false);
        }
        rollups_written = last;
    }
    let mut ready_since: Option<Ms> = None;
    if cfg.settle_on.is_some() {
        hub.begin_settle();
    }
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
                let ins = now - last_insights >= cfg.insights_every_ms;
                if s.has_dirty_core() || (ins && s.has_dirty()) {
                    let ops = s.flush_with(now, ins);
                    if ins {
                        last_insights = now;
                    }
                    // A big flush (a boot backfill) goes out as several frames.
                    for chunk in encode_ops_chunked(&ops) {
                        hub.publish(&chunk, now);
                    }
                }
            }
            _ = slow.tick() => {
                let now = clock();
                store.write().tick(now);
                // Closed hours become rollups: persisted, then kept as facts. Not while
                // the boot is still filling the registers in.
                if !hub.is_settling() {
                    let rs = store.read().closed_rollups(rollups_written, now);
                    if !rs.is_empty() {
                        rollups_written = rs.iter().map(|r| r.hour).max().unwrap_or(rollups_written);
                        if let Some(p) = &cfg.rollups {
                            append_rollups(p, &rs);
                        }
                        let mut s = store.write();
                        for r in rs {
                            s.apply(crate::facts::Fact::Rollup(r), false);
                        }
                    }
                }
            }
            _ = snap.tick() => {
                if hub.is_settling() {
                    let now = clock();
                    let ready = cfg.settle_on.as_ref().is_none_or(|a| a.settled());
                    if !ready {
                        ready_since = None;
                    }
                    let since = *ready_since.get_or_insert(now);
                    if (ready && now - since >= cfg.settle_quiet_ms)
                        || now - boot_at >= cfg.settle_max_ms
                    {
                        let (seq, json) = {
                            let s = store.read();
                            let seq = hub.seq();
                            (seq, build_snapshot(&s, seq, now, &hub.epoch))
                        };
                        let h = hub.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            h.end_settle(Snapshot::new(seq, now, json))
                        })
                        .await;
                        tracing::info!(seq, boot_s = (now - boot_at) / 1000, "boot settled; history resumes");
                        snap_key = (store.read().version, seq);
                        continue;
                    }
                }
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

#[cfg(test)]
mod settle_tests {
    use super::*;

    #[test]
    fn ready_before_settled_while_backfilling() {
        let a = Adapters::default();
        a.register("github", true, None);
        a.register("off", false, None);
        a.backfilling("github", true);
        assert!(!a.ready() && !a.settled());
        a.ok("github", 1, None);
        assert!(a.ready(), "ready once the first pass is in");
        assert!(!a.settled(), "not settled while the slow backfill loads");
        a.backfilling("github", false);
        assert!(a.settled());
    }
}
