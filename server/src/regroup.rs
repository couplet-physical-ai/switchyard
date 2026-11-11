//! Groups for replayed history.
//!
//! History recorded before contract 0.5 has no `Repo.group` and no `groups` table, so a
//! replay of it would lose the team lanes. Every past state the server hands out
//! (`/snapshot?at=`, `/history`) is filled from the **live** repo → group map (the
//! group each repo is in now): `Repo.group` where it is missing, and a `groups` table
//! recounted (repos, apps, red) from the state at that time, with `group` ops added to
//! the replayed frames whenever those counts move. History recorded since 0.5 carries
//! its own groups and is passed through as recorded.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use bytes::Bytes;
use serde_json::{Value, json};

use crate::history::HistoryOut;
use crate::store::{group_name, team_slug};
use crate::wire::WireState;

/// The live repo → group map and the groups' display names.
#[derive(Clone, Debug, Default)]
pub struct GroupMap {
    repos: HashMap<String, String>,
    /// group id → (name, kind)
    names: HashMap<String, (Value, Value)>,
}

impl GroupMap {
    pub fn from_view(view: &WireState) -> GroupMap {
        let mut m = GroupMap::default();
        for (id, r) in view.iter(crate::model::Kind::Repo) {
            if let Some(g) = r.get("group").and_then(Value::as_str) {
                m.repos.insert(id.clone(), g.to_string());
            }
        }
        for (id, g) in view.iter(crate::model::Kind::Group) {
            m.names.insert(
                id.clone(),
                (
                    g.get("name").cloned().unwrap_or(Value::Null),
                    g.get("kind").cloned().unwrap_or(Value::Null),
                ),
            );
        }
        m
    }

    /// The group a repo is in now; a repo the live fleet no longer has: its org.
    pub fn group_for(&self, repo: &str) -> String {
        self.repos
            .get(repo)
            .cloned()
            .unwrap_or_else(|| format!("org:{}", repo.split('/').next().unwrap_or(repo)))
    }

    fn entry(&self, gid: &str) -> Value {
        let (name, kind) = match self.names.get(gid) {
            Some((n, k)) if !n.is_null() && !k.is_null() => (n.clone(), k.clone()),
            _ => match gid.split_once(':') {
                Some(("team", t)) => (group_name(t).into(), "team".into()),
                Some((_, o)) => (o.into(), "org".into()),
                None => (gid.into(), "org".into()),
            },
        };
        json!({"id": gid, "name": name, "kind": kind, "repos": 0, "apps": 0, "red": 0})
    }
}

/// Some repo of this state has no group (history from before contract 0.5).
pub fn ungrouped(st: &WireState) -> bool {
    st.iter(crate::model::Kind::Repo)
        .any(|(_, r)| r.get("group").and_then(Value::as_str).is_none())
}

/// Cheap test on a recorded snapshot's bytes: false only when it surely has groups.
pub fn maybe_ungrouped(snapshot: &[u8]) -> bool {
    !snapshot.windows(11).any(|w| w == b"\"groups\":[{")
}

fn bump(table: &mut BTreeMap<String, Value>, map: &GroupMap, gid: &str, field: &str) {
    let g = table
        .entry(gid.to_string())
        .or_insert_with(|| map.entry(gid));
    g[field] = (g[field].as_u64().unwrap_or(0) + 1).into();
}

/// The groups table for a state (as the live server counts it).
fn table_of(st: &WireState, map: &GroupMap) -> BTreeMap<String, Value> {
    let mut t = BTreeMap::new();
    for (id, r) in st.iter(crate::model::Kind::Repo) {
        let gid = r
            .get("group")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| map.group_for(id));
        bump(&mut t, map, &gid, "repos");
        if matches!(
            r.pointer("/main/state").and_then(Value::as_str),
            Some("failure" | "error")
        ) {
            bump(&mut t, map, &gid, "red");
        }
    }
    for (_, a) in st.iter(crate::model::Kind::App) {
        let gid = match (
            a.get("repo").and_then(Value::as_str),
            a.get("team").and_then(Value::as_str).and_then(team_slug),
        ) {
            (Some(r), _) => st
                .get(crate::model::Kind::Repo, r)
                .and_then(|x| x.get("group"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| map.group_for(r)),
            (None, Some(t)) => format!("team:{t}"),
            (None, None) => continue,
        };
        bump(&mut t, map, &gid, "apps");
    }
    t
}

/// Fill the missing `Repo.group`s and recount the groups table. Returns the `group` ops
/// that bring the previous table to the new one.
pub fn regroup_state(st: &mut WireState, map: &GroupMap) -> Vec<Value> {
    if let Some(repos) = st.tables.get_mut("repo") {
        for (id, r) in repos.iter_mut() {
            if r.is_object() && r.get("group").and_then(Value::as_str).is_none() {
                r["group"] = map.group_for(id).into();
            }
        }
    }
    let table = table_of(st, map);
    let cur = st.tables.entry("group").or_default();
    let mut ops = Vec::new();
    for (id, g) in &table {
        if cur.get(id) != Some(g) {
            ops.push(json!({"op": "upsert", "kind": "group", "id": id, "v": g}));
        }
    }
    for id in cur.keys() {
        if !table.contains_key(id) {
            ops.push(json!({"op": "remove", "kind": "group", "id": id}));
        }
    }
    *cur = table;
    ops
}

fn kind_is(op: &Value, k: &str) -> bool {
    op.get("kind").and_then(Value::as_str) == Some(k)
}

/// A folded history window (base = the state at its start) with groups filled in.
pub fn history(h: HistoryOut, map: &GroupMap, protocol: &str, epoch: &str) -> HistoryOut {
    if !maybe_ungrouped(&h.base) {
        return h;
    }
    let Ok(base) = serde_json::from_slice::<Value>(&h.base) else {
        return h;
    };
    if base.is_null() {
        return h;
    }
    let mut st = WireState::from_snapshot(&base);
    if !ungrouped(&st) {
        return h;
    }
    regroup_state(&mut st, map);
    let new_base =
        Bytes::from(serde_json::to_vec(&st.to_snapshot(protocol, epoch)).unwrap_or_default());
    let mut frames = Vec::with_capacity(h.frames.len());
    let mut filling = true;
    for f in h.frames {
        if !filling {
            frames.push(f);
            continue;
        }
        let Ok(mut v) = serde_json::from_slice::<Value>(&f) else {
            frames.push(f);
            continue;
        };
        match v.get("t").and_then(Value::as_str) {
            Some("delta") => {
                let ops = v.get("ops").and_then(Value::as_array);
                let native = ops.is_some_and(|o| o.iter().any(|op| kind_is(op, "group")));
                if native {
                    // The first frame recorded with groups (the 0.5 boot): its groups are
                    // the real ones; drop the filled-in ones it does not have.
                    let mut real: BTreeSet<String> = BTreeSet::new();
                    for op in ops.into_iter().flatten() {
                        if kind_is(op, "group")
                            && op.get("op").and_then(Value::as_str) == Some("upsert")
                            && let Some(id) = op.get("id").and_then(Value::as_str)
                        {
                            real.insert(id.to_string());
                        }
                    }
                    st.apply_frame(&v);
                    let stale: Vec<Value> = st
                        .iter(crate::model::Kind::Group)
                        .filter(|(id, _)| !real.contains(id.as_str()))
                        .map(|(id, _)| json!({"op": "remove", "kind": "group", "id": id}))
                        .collect();
                    filling = false;
                    if stale.is_empty() {
                        frames.push(f);
                    } else {
                        if let Some(o) = v.get_mut("ops").and_then(Value::as_array_mut) {
                            o.extend(stale);
                        }
                        frames.push(Bytes::from(serde_json::to_vec(&v).unwrap_or_default()));
                    }
                    continue;
                }
                let mut touched = false;
                if let Some(o) = v.get_mut("ops").and_then(Value::as_array_mut) {
                    for op in o.iter_mut() {
                        if kind_is(op, "repo") || kind_is(op, "app") {
                            touched = true;
                        }
                        if kind_is(op, "repo")
                            && op.get("op").and_then(Value::as_str) == Some("upsert")
                            && let Some(id) =
                                op.get("id").and_then(Value::as_str).map(str::to_string)
                            && let Some(r) = op.get_mut("v")
                            && r.is_object()
                            && r.get("group").and_then(Value::as_str).is_none()
                        {
                            r["group"] = map.group_for(&id).into();
                        }
                    }
                }
                if !touched {
                    st.apply_frame(&v);
                    frames.push(f);
                    continue;
                }
                st.apply_frame(&v);
                let gops = regroup_state(&mut st, map);
                if let Some(o) = v.get_mut("ops").and_then(Value::as_array_mut) {
                    o.extend(gops);
                }
                frames.push(Bytes::from(serde_json::to_vec(&v).unwrap_or_default()));
            }
            Some("snapshot") => {
                st = WireState::from_snapshot(v.get("v").unwrap_or(&Value::Null));
                if ungrouped(&st) {
                    regroup_state(&mut st, map);
                    v["v"] = st.to_snapshot(protocol, epoch);
                    frames.push(Bytes::from(serde_json::to_vec(&v).unwrap_or_default()));
                } else {
                    filling = false;
                    frames.push(f);
                }
            }
            _ => {
                st.apply_frame(&v);
                frames.push(f);
            }
        }
    }
    HistoryOut {
        base: new_base,
        base_seq: h.base_seq,
        base_at: h.base_at,
        frames,
    }
}
