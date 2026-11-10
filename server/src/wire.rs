//! A client-side view of the wire: a snapshot plus applied frames, as JSON
//! values. Used by the demo server (search/commit/pr over fixtures), by the
//! recorder, and by replay tests (snapshot + frames == next snapshot).

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::model::Kind;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WireState {
    pub seq: u64,
    pub at: i64,
    pub tables: BTreeMap<&'static str, BTreeMap<String, Value>>,
}

fn kind_of(s: &str) -> Option<Kind> {
    Kind::ALL.into_iter().find(|k| k.as_str() == s)
}

impl WireState {
    pub fn from_snapshot(v: &Value) -> WireState {
        let mut w = WireState {
            seq: v.get("seq").and_then(Value::as_u64).unwrap_or(0),
            at: v.get("at").and_then(Value::as_i64).unwrap_or(0),
            tables: BTreeMap::new(),
        };
        for k in Kind::ALL {
            let mut t = BTreeMap::new();
            match v.get(k.snapshot_field()) {
                Some(Value::Array(a)) => {
                    for e in a {
                        if let Some(id) = e.get("id").and_then(Value::as_str) {
                            t.insert(id.to_string(), e.clone());
                        }
                    }
                }
                Some(o @ Value::Object(_)) => {
                    let id = o
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(k.as_str())
                        .to_string();
                    t.insert(id, o.clone());
                }
                _ => {}
            }
            w.tables.insert(k.as_str(), t);
        }
        w
    }

    /// Apply one frame. Returns false for a reset (caller must re-snapshot).
    pub fn apply_frame(&mut self, f: &Value) -> bool {
        match f.get("t").and_then(Value::as_str) {
            Some("delta") => {
                if let Some(ops) = f.get("ops").and_then(Value::as_array) {
                    for op in ops {
                        self.apply_op(op);
                    }
                }
                self.seq = f.get("seq").and_then(Value::as_u64).unwrap_or(self.seq);
                self.at = f.get("at").and_then(Value::as_i64).unwrap_or(self.at);
                true
            }
            Some("snapshot") => {
                if let Some(v) = f.get("v") {
                    *self = WireState::from_snapshot(v);
                }
                true
            }
            Some("hb") => true,
            Some("reset") => false,
            _ => true,
        }
    }

    pub fn apply_op(&mut self, op: &Value) {
        let kind = op.get("kind").and_then(Value::as_str).and_then(kind_of);
        let id = op.get("id").and_then(Value::as_str);
        match (op.get("op").and_then(Value::as_str), kind, id) {
            (Some("upsert"), Some(k), Some(id)) => {
                if let Some(v) = op.get("v") {
                    self.tables
                        .entry(k.as_str())
                        .or_default()
                        .insert(id.to_string(), v.clone());
                }
            }
            (Some("remove"), Some(k), Some(id)) => {
                self.tables.entry(k.as_str()).or_default().remove(id);
            }
            _ => {}
        }
    }

    pub fn get(&self, k: Kind, id: &str) -> Option<&Value> {
        self.tables.get(k.as_str())?.get(id)
    }

    pub fn iter(&self, k: Kind) -> impl Iterator<Item = (&String, &Value)> {
        self.tables
            .get(k.as_str())
            .into_iter()
            .flat_map(|t| t.iter())
    }

    /// Back to snapshot JSON (deterministic order).
    pub fn to_snapshot(&self, protocol: &str, epoch: &str) -> Value {
        let mut m = Map::new();
        m.insert("protocol".into(), Value::from(protocol));
        m.insert("epoch".into(), Value::from(epoch));
        m.insert("seq".into(), Value::from(self.seq));
        m.insert("at".into(), Value::from(self.at));
        for k in Kind::ALL {
            let t = self.tables.get(k.as_str());
            if k.singleton() {
                m.insert(
                    k.snapshot_field().into(),
                    t.and_then(|t| t.values().next().cloned())
                        .unwrap_or(Value::Null),
                );
            } else {
                m.insert(
                    k.snapshot_field().into(),
                    Value::Array(t.map(|t| t.values().cloned().collect()).unwrap_or_default()),
                );
            }
        }
        Value::Object(m)
    }

    /// Entity tables only (for equality checks independent of seq/at).
    pub fn entities(&self) -> &BTreeMap<&'static str, BTreeMap<String, Value>> {
        &self.tables
    }
}

/// Keys whose numeric values are Unix-ms timestamps (shifted in demo mode).
pub const TIME_KEYS: &[&str] = &[
    "at",
    "since",
    "created",
    "updated",
    "started",
    "finished",
    "checked",
    "last_ok",
    "merged_at",
    "last_activity",
    "last_seen",
    "deployed_at",
    "from_at",
];

/// Shift every timestamp field in a JSON value by `delta` ms (recursively).
pub fn shift_times(v: &mut Value, delta: i64) {
    match v {
        Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                if TIME_KEYS.contains(&k.as_str())
                    && let Some(n) = x.as_i64()
                    && n > 1_000_000_000_000
                {
                    *x = Value::from(n + delta);
                    continue;
                }
                shift_times(x, delta);
            }
        }
        Value::Array(a) => {
            for x in a {
                shift_times(x, delta);
            }
        }
        _ => {}
    }
}
