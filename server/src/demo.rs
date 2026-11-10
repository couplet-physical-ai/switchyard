//! `--demo`: serve the recorded fixtures (`contract/fixtures/snapshot.json` +
//! `hour.jsonl`) as if they were live, looping, with every timestamp shifted so
//! the recording ends "now". At boot the previous loop is pre-recorded into the
//! history ring, so "last hour, sped up" works immediately.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use bytes::Bytes;
use serde_json::Value;

use crate::hub::{Hub, Snapshot};
use crate::model::Ms;
use crate::runtime::{Adapters, Clock};
use crate::wire::shift_times;

pub struct Fixtures {
    pub snapshot: Value,
    /// Delta frames (`t: "delta"`) in order.
    pub frames: Vec<Value>,
}

impl Fixtures {
    pub fn load(dir: &Path) -> Result<Fixtures> {
        let snap = std::fs::read(dir.join("snapshot.json"))
            .with_context(|| format!("read {}/snapshot.json", dir.display()))?;
        let snapshot: Value = serde_json::from_slice(&snap).context("parse snapshot.json")?;
        let hour = std::fs::read_to_string(dir.join("hour.jsonl"))
            .with_context(|| format!("read {}/hour.jsonl", dir.display()))?;
        let mut frames = Vec::new();
        for (i, line) in hour.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let v: Value =
                serde_json::from_str(line).with_context(|| format!("hour.jsonl line {}", i + 1))?;
            if v.get("t").and_then(Value::as_str) == Some("delta") {
                frames.push(v);
            }
        }
        Ok(Fixtures { snapshot, frames })
    }

    pub fn start(&self) -> Ms {
        self.snapshot.get("at").and_then(Value::as_i64).unwrap_or(0)
    }

    pub fn end(&self) -> Ms {
        self.frames
            .last()
            .and_then(|f| f.get("at"))
            .and_then(Value::as_i64)
            .unwrap_or(self.start())
    }

    /// Loop length: the recording plus a short pause before it restarts.
    pub fn period(&self) -> Ms {
        (self.end() - self.start()).max(60_000) + 3_000
    }
}

fn ops_bytes(frame: &Value, delta: Ms) -> Vec<u8> {
    let mut ops = frame.get("ops").cloned().unwrap_or(Value::Array(vec![]));
    shift_times(&mut ops, delta);
    let s = serde_json::to_vec(&ops).unwrap_or_else(|_| b"[]".to_vec());
    // Strip the surrounding brackets: the hub wants the inside of the array.
    if s.len() >= 2 {
        s[1..s.len() - 1].to_vec()
    } else {
        Vec::new()
    }
}

fn snapshot_bytes(fx: &Fixtures, delta: Ms, seq: u64, at: Ms, epoch: &str) -> Bytes {
    let mut s = fx.snapshot.clone();
    shift_times(&mut s, delta);
    if let Some(m) = s.as_object_mut() {
        m.insert("seq".into(), Value::from(seq));
        m.insert("at".into(), Value::from(at));
        m.insert("epoch".into(), Value::from(epoch));
    }
    Bytes::from(serde_json::to_vec(&s).unwrap_or_default())
}

/// Play the fixtures forever.
pub async fn run_demo(
    hub: Arc<Hub>,
    fx: Arc<Fixtures>,
    clock: Clock,
    adapters: Arc<Adapters>,
    speed: f64,
) {
    let speed = if speed > 0.0 { speed } else { 1.0 };
    let t0 = fx.start();
    let period = fx.period();
    // Pre-record the previous loop into history (no client is connected yet).
    let now = clock();
    let prev_start = now - period;
    let delta = prev_start - t0;
    let seq = hub.publish_reset(prev_start);
    hub.force_snapshot(Snapshot::new(
        seq,
        prev_start,
        snapshot_bytes(&fx, delta, seq, prev_start, &hub.epoch),
    ));
    for f in &fx.frames {
        let at = f.get("at").and_then(Value::as_i64).unwrap_or(t0) + delta;
        hub.publish(&ops_bytes(f, delta), at);
    }
    adapters.ok("demo", now, Some(0));
    loop {
        let start = clock();
        let delta = start - t0;
        let seq = hub.publish_reset(start);
        hub.force_snapshot(Snapshot::new(
            seq,
            start,
            snapshot_bytes(&fx, delta, seq, start, &hub.epoch),
        ));
        let wall0 = tokio::time::Instant::now();
        for f in &fx.frames {
            let rel = f.get("at").and_then(Value::as_i64).unwrap_or(t0) - t0;
            let wait = Duration::from_millis(((rel.max(0) as f64) / speed) as u64);
            tokio::time::sleep_until(wall0 + wait).await;
            let at = t0 + rel + delta;
            hub.publish(&ops_bytes(f, delta), at);
            adapters.ok("demo", clock(), Some(0));
        }
        let rest =
            Duration::from_millis(((period - (fx.end() - t0)).max(1_000) as f64 / speed) as u64);
        tokio::time::sleep(rest).await;
    }
}
