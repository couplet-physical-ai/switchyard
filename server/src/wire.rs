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

pub fn kind_of(s: &str) -> Option<Kind> {
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
            (Some("patch"), Some(k), Some(id)) => {
                if let (Some(p), Some(cur)) = (
                    op.get("v"),
                    self.tables.get_mut(k.as_str()).and_then(|t| t.get_mut(id)),
                ) {
                    merge_patch(cur, p);
                }
            }
            (Some("dot"), _, Some(id)) => {
                if let (Some(d), Some(repo)) = (
                    op.get("v"),
                    self.tables.get_mut("repo").and_then(|t| t.get_mut(id)),
                ) {
                    apply_dot(repo, d);
                }
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
    "first_seen",
    "last_at",
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

/// Dots a repo keeps on its main line (`Repo.main.recent`).
pub const DOTS: usize = 12;

/// RFC 7386 JSON Merge Patch: objects merge recursively, `null` removes a field,
/// anything else (arrays, scalars) replaces.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(p) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(serde_json::Map::new());
    }
    let t = target.as_object_mut().expect("object");
    for (k, v) in p {
        if v.is_null() {
            t.remove(k);
        } else {
            merge_patch(t.entry(k.clone()).or_insert(Value::Null), v);
        }
    }
}

/// The smallest merge patch turning `old` into `new` (`None` when equal).
pub fn diff(old: &Value, new: &Value) -> Option<Value> {
    if old == new {
        return None;
    }
    match (old, new) {
        (Value::Object(o), Value::Object(n)) => {
            let mut p = serde_json::Map::new();
            for (k, nv) in n {
                match o.get(k) {
                    Some(ov) => {
                        if let Some(d) = diff(ov, nv) {
                            p.insert(k.clone(), d);
                        }
                    }
                    None => {
                        p.insert(k.clone(), nv.clone());
                    }
                }
            }
            for k in o.keys() {
                if !n.contains_key(k) {
                    p.insert(k.clone(), Value::Null);
                }
            }
            Some(Value::Object(p))
        }
        // A null leaf cannot be expressed as a merge-patch value; we never emit nulls.
        _ => Some(new.clone()),
    }
}

/// The `dot` op: put one Dot into `repo.main.recent` (replace the one with the same
/// sha, else insert), keep it sorted by (at, sha) ascending, keep the newest [`DOTS`].
pub fn apply_dot(repo: &mut Value, dot: &Value) {
    let Some(recent) = repo
        .get_mut("main")
        .and_then(|m| m.get_mut("recent"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    insert_dot(recent, dot);
}

fn insert_dot(recent: &mut Vec<Value>, dot: &Value) {
    let sha = dot.get("sha").and_then(Value::as_str).unwrap_or("");
    recent.retain(|d| d.get("sha").and_then(Value::as_str) != Some(sha));
    recent.push(dot.clone());
    let key = |d: &Value| {
        (
            d.get("at").and_then(Value::as_i64).unwrap_or(0),
            d.get("sha")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        )
    };
    recent.sort_by_key(key);
    if recent.len() > DOTS {
        let n = recent.len() - DOTS;
        recent.drain(..n);
    }
}

/// Dot ops turning `old`'s main line into `new`'s, or `None` when the dot rule cannot
/// reproduce it exactly (then the caller patches `main.recent` whole).
pub fn dots_between(old: &[Value], new: &[Value]) -> Option<Vec<Value>> {
    let mut cur = old.to_vec();
    let mut ops = Vec::new();
    for d in new {
        if !old.iter().any(|o| o == d) {
            insert_dot(&mut cur, d);
            ops.push(d.clone());
        }
    }
    (cur == new).then_some(ops)
}

/// Ops turning the client view `old` into `new` (a server restart inside a history
/// window, sent as one delta instead of a whole snapshot). With `patch`, changed
/// entities go as merge patches when smaller (contract ≥ 0.4), else as upserts.
pub fn state_diff(old: &WireState, new: &WireState, patch: bool) -> Vec<Value> {
    let mut ops = Vec::new();
    for k in Kind::ALL {
        for (id, nv) in new.iter(k) {
            let up = || serde_json::json!({"op": "upsert", "kind": k.as_str(), "id": id, "v": nv});
            match old.get(k, id) {
                None => ops.push(up()),
                Some(ov) if ov == nv => {}
                Some(ov) => {
                    let p = patch.then(|| diff(ov, nv)).flatten().map(|p| {
                        serde_json::json!({"op": "patch", "kind": k.as_str(), "id": id, "v": p})
                    });
                    match p {
                        Some(p) if p.to_string().len() < nv.to_string().len() => ops.push(p),
                        _ => ops.push(up()),
                    }
                }
            }
        }
        for (id, _) in old.iter(k) {
            if new.get(k, id).is_none() {
                ops.push(serde_json::json!({"op": "remove", "kind": k.as_str(), "id": id}));
            }
        }
    }
    ops
}

#[cfg(test)]
mod patch_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn diff_then_merge_round_trips() {
        let a = json!({"id":"x","n":1,"o":{"a":1,"b":[1,2]},"gone":true,"same":"s"});
        let b = json!({"id":"x","n":2,"o":{"a":1,"b":[1,3],"c":"new"},"same":"s"});
        let p = diff(&a, &b).unwrap();
        assert_eq!(p, json!({"n":2,"o":{"b":[1,3],"c":"new"},"gone":null}));
        let mut t = a.clone();
        merge_patch(&mut t, &p);
        assert_eq!(t, b);
        assert!(diff(&b, &b).is_none());
    }

    #[test]
    fn dots_reproduce_the_main_line_or_refuse() {
        let d = |sha: &str, at: i64, state: &str| json!({"sha":sha,"at":at,"state":state});
        let old: Vec<Value> = (0..12)
            .map(|i| d(&format!("s{i:02}"), i * 10, "success"))
            .collect();
        // A new head, and the previous head's state changing.
        let mut new = old[1..].to_vec();
        new[10] = d("s11", 110, "failure");
        new.push(d("s12", 120, "running"));
        let ops = dots_between(&old, &new).unwrap();
        assert_eq!(ops.len(), 2);
        let mut repo = json!({"main":{"recent":old.clone()}});
        for o in &ops {
            apply_dot(&mut repo, o);
        }
        assert_eq!(repo["main"]["recent"], Value::Array(new));
        // A dot vanishing (not pushed out by a newer one) cannot be expressed as dots.
        let shrunk = old[..11].to_vec();
        assert!(dots_between(&old, &shrunk).is_none());
    }
}
