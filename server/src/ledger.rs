//! What happened, kept from the stream itself (events, failed steps, deploys, PRs, engine
//! load), so it works the same live and in `--demo`:
//!
//! - `GET /api/v1/changes?since=` ("since your last visit", up to 7 days),
//! - `GET /api/v1/app/{id}` (last deploys + health transitions over 7 days),
//! - `GET /api/v1/engine/{id}/history` (24 h of engine load at 1-minute resolution).
//!
//! The 7-day log is persisted (`<data-dir>/ledger.jsonl`: one record per line, appended as
//! things happen, compacted at boot and daily); engine minutes are rebuilt from `/history`
//! at boot.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::model::*;
use crate::wire::WireState;

const H: Ms = 3_600_000;
/// The log keeps 7 days (+1 h so a 7-day window is whole).
pub const KEEP_MS: Ms = 7 * 24 * H + H;
/// `/changes` answers at most this far back.
pub const CHANGES_MAX_MS: Ms = 7 * 24 * H;
/// Engine load history.
pub const ENGINE_KEEP_MS: Ms = 24 * H;
const MINUTE: Ms = 60_000;
/// Deploys kept per app beyond the window (an app that deploys rarely still has history).
const DEPLOYS_PER_APP: usize = 10;

/// One line of `ledger.jsonl`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "k", rename_all = "snake_case")]
enum Rec {
    /// The log has seen everything since `from`.
    Cover {
        from: Ms,
    },
    Main {
        repo: String,
        from: CiState,
        to: CiState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        culprit: Option<String>,
        at: Ms,
    },
    Fin {
        id: String,
        repo: String,
        failed: bool,
        at: Ms,
    },
    Dep(DepRec),
    Health {
        app: String,
        from: Health,
        to: Health,
        at: Ms,
    },
    Merge {
        repo: String,
        number: u64,
        at: Ms,
    },
    Pr {
        id: String,
        repo: String,
        created: Ms,
    },
    Fail {
        pipeline: String,
        step: String,
        repo: String,
        cluster: String,
        at: Ms,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct DepRec {
    app: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    repo: String,
    sha: String,
    via: DeployVia,
    state: DeployState,
    started: Ms,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finished: Option<Ms>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pipeline: Option<String>,
}

impl DepRec {
    fn at(&self) -> Ms {
        self.finished.unwrap_or(self.started)
    }
    fn done(&self) -> bool {
        matches!(self.state, DeployState::Success | DeployState::Failure)
    }
}

#[derive(Clone, Debug)]
struct MainEv {
    repo: String,
    to: CiState,
    from: CiState,
    culprit: Option<String>,
}

#[derive(Clone, Debug)]
struct Finish {
    repo: String,
    failed: bool,
    at: Ms,
}

/// One minute of one engine.
#[derive(Clone, Copy, Debug, Default)]
struct Minute {
    online: bool,
    /// Peak busy slots in the minute, and the last value (what a carried minute holds).
    busy: u32,
    busy_last: u32,
    slots: u32,
    cpu: Option<f32>,
    mem: Option<f32>,
    load: Option<f32>,
}

#[derive(Default)]
struct EngineHist {
    kind: String,
    host: Option<String>,
    mins: BTreeMap<Ms, Minute>,
    /// Pipeline id → last time seen running here.
    runs: BTreeMap<String, Ms>,
}

#[derive(Default)]
struct Inner {
    /// Since when the ledger has seen everything (its file, boot, replayed history).
    covered_from: Ms,
    /// (at, repo) → main-line transition.
    mains: BTreeMap<(Ms, String), MainEv>,
    /// pipeline id → finish.
    finishes: BTreeMap<String, Finish>,
    /// "app@sha" → deploy.
    deploys: BTreeMap<String, DepRec>,
    /// (app, at) → (from, to).
    health: BTreeMap<(String, Ms), (Health, Health)>,
    /// (repo, number) → merged at.
    merges: BTreeMap<(String, u64), Ms>,
    /// PR id → (created, repo).
    opened: BTreeMap<String, (Ms, String)>,
    /// (pipeline, workflow/step) → (finished, cluster, repo).
    failures: BTreeMap<(String, String), (Ms, String, String)>,
    engines: BTreeMap<String, EngineHist>,
    /// Newest frame time seen.
    now: Ms,
    pruned_at: Ms,
    compacted_at: Ms,
    path: Option<PathBuf>,
    file: Option<std::io::BufWriter<std::fs::File>>,
    /// Records to append (written at the end of each observe).
    pending: Vec<Rec>,
}

#[derive(Default)]
pub struct Ledger {
    inner: Mutex<Inner>,
}

fn red(s: CiState) -> bool {
    matches!(s, CiState::Failure | CiState::Error)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn f32_of(v: &Value, k: &str) -> Option<f32> {
    v.get(k).and_then(Value::as_f64).map(|x| x as f32)
}

impl Inner {
    /// Apply one record; true when it changed something (so it is worth persisting).
    fn put(&mut self, r: &Rec) -> bool {
        match r.clone() {
            Rec::Cover { from } => {
                if from < self.covered_from {
                    self.covered_from = from;
                    return true;
                }
                false
            }
            Rec::Main {
                repo,
                from,
                to,
                culprit,
                at,
            } => self
                .mains
                .insert(
                    (at, repo.clone()),
                    MainEv {
                        repo,
                        to,
                        from,
                        culprit,
                    },
                )
                .is_none(),
            Rec::Fin {
                id,
                repo,
                failed,
                at,
            } => {
                let new = Finish { repo, failed, at };
                match self.finishes.get(&id) {
                    Some(f) if f.at == new.at && f.failed == new.failed => false,
                    _ => {
                        self.finishes.insert(id, new);
                        true
                    }
                }
            }
            Rec::Dep(d) => {
                let key = format!("{}@{}", d.app, d.sha);
                match self.deploys.get(&key) {
                    Some(cur) if *cur == d => false,
                    _ => {
                        self.deploys.insert(key, d);
                        true
                    }
                }
            }
            Rec::Health { app, from, to, at } => {
                self.health.insert((app, at), (from, to)).is_none()
            }
            Rec::Merge { repo, number, at } => self.merges.insert((repo, number), at).is_none(),
            Rec::Pr { id, repo, created } => match self.opened.get(&id) {
                Some((c, _)) if *c == created => false,
                _ => {
                    self.opened.insert(id, (created, repo));
                    true
                }
            },
            Rec::Fail {
                pipeline,
                step,
                repo,
                cluster,
                at,
            } => {
                let v = (at, cluster, repo);
                match self.failures.get(&(pipeline.clone(), step.clone())) {
                    Some(cur) if *cur == v => false,
                    _ => {
                        self.failures.insert((pipeline, step), v);
                        true
                    }
                }
            }
        }
    }

    /// Apply and, when it changed something, queue it for the file.
    fn record(&mut self, r: Rec) {
        if self.put(&r) && self.path.is_some() {
            self.pending.push(r);
        }
    }

    fn records(&self) -> Vec<Rec> {
        let mut out = vec![Rec::Cover {
            from: self.covered_from,
        }];
        for ((at, _), m) in &self.mains {
            out.push(Rec::Main {
                repo: m.repo.clone(),
                from: m.from,
                to: m.to,
                culprit: m.culprit.clone(),
                at: *at,
            });
        }
        for (id, f) in &self.finishes {
            out.push(Rec::Fin {
                id: id.clone(),
                repo: f.repo.clone(),
                failed: f.failed,
                at: f.at,
            });
        }
        out.extend(self.deploys.values().cloned().map(Rec::Dep));
        for ((app, at), (from, to)) in &self.health {
            out.push(Rec::Health {
                app: app.clone(),
                from: *from,
                to: *to,
                at: *at,
            });
        }
        for ((repo, number), at) in &self.merges {
            out.push(Rec::Merge {
                repo: repo.clone(),
                number: *number,
                at: *at,
            });
        }
        for (id, (created, repo)) in &self.opened {
            out.push(Rec::Pr {
                id: id.clone(),
                repo: repo.clone(),
                created: *created,
            });
        }
        for ((pipeline, step), (at, cluster, repo)) in &self.failures {
            out.push(Rec::Fail {
                pipeline: pipeline.clone(),
                step: step.clone(),
                repo: repo.clone(),
                cluster: cluster.clone(),
                at: *at,
            });
        }
        out
    }

    /// Drop what is older than the keep windows (the newest deploys of each app stay).
    fn prune(&mut self, now: Ms) {
        let cut = now - KEEP_MS;
        // Nothing older than the cut is kept: coverage starts there at the earliest.
        self.covered_from = self.covered_from.max(cut);
        self.mains.retain(|(at, _), _| *at >= cut);
        self.finishes.retain(|_, f| f.at >= cut);
        self.health.retain(|(_, at), _| *at >= cut);
        self.merges.retain(|_, at| *at >= cut);
        self.opened.retain(|_, (c, _)| *c >= cut);
        self.failures.retain(|_, v| v.0 >= cut);
        let mut per_app: BTreeMap<&str, Vec<(Ms, &str)>> = BTreeMap::new();
        for (k, d) in &self.deploys {
            per_app.entry(&d.app).or_default().push((d.at(), k));
        }
        let mut keep: BTreeSet<String> = BTreeSet::new();
        for v in per_app.values_mut() {
            v.sort_by(|a, b| b.cmp(a));
            for (i, (at, k)) in v.iter().enumerate() {
                if i < DEPLOYS_PER_APP || *at >= cut {
                    keep.insert(k.to_string());
                }
            }
        }
        self.deploys.retain(|k, _| keep.contains(k));
        let ecut = now - ENGINE_KEEP_MS;
        for e in self.engines.values_mut() {
            // Keep the last minute before the window: it carries into the window.
            let first_in = e.mins.range(ecut..).next().map(|(k, _)| *k);
            let carry = e.mins.range(..ecut).next_back().map(|(k, m)| (*k, *m));
            e.mins.retain(|k, _| *k >= ecut);
            if let (Some((k, m)), true) = (carry, first_in != Some(ecut)) {
                e.mins.insert(k.max(ecut - MINUTE), m);
            }
            e.runs.retain(|_, t| *t >= now - H);
        }
        self.pruned_at = now;
    }

    /// Rewrite the file with exactly what is kept.
    fn compact(&mut self, now: Ms) {
        let Some(path) = self.path.clone() else {
            return;
        };
        self.file = None;
        let mut body = String::new();
        for r in self.records() {
            if let Ok(l) = serde_json::to_string(&r) {
                body.push_str(&l);
                body.push('\n');
            }
        }
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, body).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
        self.file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()
            .map(std::io::BufWriter::new);
        self.compacted_at = now;
    }

    fn write_pending(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let recs = std::mem::take(&mut self.pending);
        if let Some(f) = self.file.as_mut() {
            for r in recs {
                if let Ok(l) = serde_json::to_string(&r) {
                    let _ = writeln!(f, "{l}");
                }
            }
            let _ = f.flush();
        }
    }

    fn sample_engine(&mut self, id: &str, e: &Value, at: Ms) {
        let h = self.engines.entry(id.to_string()).or_default();
        h.kind = s(e, "kind").to_string();
        h.host = e.get("host").and_then(Value::as_str).map(str::to_string);
        let m = h.mins.entry(at - at.rem_euclid(MINUTE)).or_default();
        let busy = e.get("busy").and_then(Value::as_u64).unwrap_or(0) as u32;
        m.busy = m.busy.max(busy);
        m.busy_last = busy;
        m.online = e.get("online").and_then(Value::as_bool).unwrap_or(false);
        m.slots = e.get("slots").and_then(Value::as_u64).unwrap_or(0) as u32;
        m.cpu = f32_of(e, "cpu");
        m.mem = f32_of(e, "mem");
        m.load = f32_of(e, "load");
        for p in e
            .get("running")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(p) = p.as_str() {
                h.runs.insert(p.to_string(), at);
            }
        }
    }
}

impl Ledger {
    pub fn new(covered_from: Ms) -> Ledger {
        Ledger {
            inner: Mutex::new(Inner {
                covered_from,
                ..Default::default()
            }),
        }
    }

    /// Persist to `path`: load what it holds (the last 7 days), compact it, append from
    /// now on. Call before the stream is observed.
    pub fn attach(&self, path: &Path, now: Ms) -> usize {
        let mut g = self.inner.lock();
        g.path = Some(path.to_path_buf());
        let mut n = 0;
        if let Ok(text) = std::fs::read_to_string(path) {
            let mut cover: Option<Ms> = None;
            for l in text.lines() {
                match serde_json::from_str::<Rec>(l) {
                    Ok(Rec::Cover { from }) => cover = Some(cover.map_or(from, |c| c.min(from))),
                    Ok(r) => {
                        g.put(&r);
                        n += 1;
                    }
                    Err(_) => {}
                }
            }
            if let Some(c) = cover {
                g.covered_from = g.covered_from.min(c.max(now - KEEP_MS));
            }
        }
        g.now = now;
        g.prune(now);
        g.compact(now);
        n
    }

    pub fn set_covered_from(&self, t: Ms) {
        let mut g = self.inner.lock();
        g.record(Rec::Cover { from: t });
        g.write_pending();
    }

    /// Engine minutes start from the state at `at` (the base of the replayed history).
    pub fn seed_engines(&self, view: &WireState, at: Ms) {
        let mut g = self.inner.lock();
        for (id, e) in view.iter(Kind::Engine) {
            g.sample_engine(id, e, at);
        }
    }

    /// Record one frame (already applied to `view`, the client view after it).
    pub fn observe(&self, frame: &Value, view: &WireState) {
        let Some(ops) = frame.get("ops").and_then(Value::as_array) else {
            return;
        };
        let at = frame.get("at").and_then(Value::as_i64).unwrap_or(0);
        let mut g = self.inner.lock();
        g.now = g.now.max(at);
        for op in ops {
            let kind = s(op, "kind");
            match op.get("op").and_then(Value::as_str) {
                Some("event") => {
                    let Some(e) = op
                        .get("e")
                        .and_then(|e| serde_json::from_value::<Event>(e.clone()).ok())
                    else {
                        continue;
                    };
                    match e {
                        Event::Main {
                            repo,
                            from,
                            to,
                            culprit,
                            at,
                        } => g.record(Rec::Main {
                            repo,
                            from,
                            to,
                            culprit,
                            at,
                        }),
                        Event::Finish {
                            pipeline,
                            state,
                            at,
                            ..
                        } => {
                            let repo = view
                                .get(Kind::Pipeline, &pipeline)
                                .map(|p| s(p, "repo").to_string())
                                .unwrap_or_default();
                            g.record(Rec::Fin {
                                id: pipeline,
                                repo,
                                failed: red(state),
                                at,
                            });
                        }
                        Event::Deploy {
                            app,
                            sha,
                            state,
                            via,
                            at,
                        } => {
                            // The entity (same frame, before its events) is the better
                            // source; the event fills in a deploy seen only as an event.
                            let key = format!("{app}@{sha}");
                            let mut d = g.deploys.get(&key).cloned().unwrap_or(DepRec {
                                app,
                                repo: String::new(),
                                sha,
                                via,
                                state,
                                started: at,
                                finished: None,
                                pipeline: None,
                            });
                            if d.state != state {
                                d.state = state;
                                if d.done() && d.finished.is_none() {
                                    d.finished = Some(at);
                                }
                            }
                            if d.done() && d.finished.is_none() {
                                d.finished = Some(at);
                            }
                            g.record(Rec::Dep(d));
                        }
                        Event::Health { app, from, to, at } => {
                            g.record(Rec::Health { app, from, to, at })
                        }
                        Event::Merge {
                            repo, number, at, ..
                        } => g.record(Rec::Merge { repo, number, at }),
                        _ => {}
                    }
                }
                Some("upsert") | Some("patch") | Some("dot") if kind == "engine" => {
                    let id = s(op, "id");
                    if let Some(e) = view.get(Kind::Engine, id) {
                        let e = e.clone();
                        g.sample_engine(id, &e, at);
                    }
                }
                Some("upsert") | Some("patch") if kind == "deploy" => {
                    let id = s(op, "id");
                    let Some(d) = view
                        .get(Kind::Deploy, id)
                        .and_then(|v| serde_json::from_value::<Deploy>(v.clone()).ok())
                    else {
                        continue;
                    };
                    g.record(Rec::Dep(DepRec {
                        app: d.app,
                        repo: d.repo,
                        sha: d.sha,
                        via: d.via,
                        state: d.state,
                        started: d.started,
                        finished: d.finished,
                        pipeline: d.pipeline,
                    }));
                }
                Some("upsert") | Some("patch") if kind == "pr" => {
                    let id = s(op, "id");
                    if let Some(p) = view.get(Kind::Pr, id)
                        && let Some(c) = p.get("created").and_then(Value::as_i64)
                        && c >= at - KEEP_MS
                    {
                        let repo = s(p, "repo").to_string();
                        g.record(Rec::Pr {
                            id: id.to_string(),
                            repo,
                            created: c,
                        });
                    }
                }
                Some("upsert") | Some("patch") if kind == "pipeline" => {
                    let id = s(op, "id");
                    let Some(p) = view.get(Kind::Pipeline, id) else {
                        continue;
                    };
                    if !matches!(s(p, "state"), "failure" | "error") {
                        continue;
                    }
                    let Some(fin) = p.get("finished").and_then(Value::as_i64) else {
                        continue;
                    };
                    let mut recs = Vec::new();
                    for w in p
                        .get("workflows")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        for st in w
                            .get("steps")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                        {
                            if let Some(c) = st.get("cluster").and_then(Value::as_str) {
                                recs.push(Rec::Fail {
                                    pipeline: id.to_string(),
                                    step: format!("{}/{}", s(w, "name"), s(st, "name")),
                                    repo: s(p, "repo").to_string(),
                                    cluster: c.to_string(),
                                    at: fin,
                                });
                            }
                        }
                    }
                    for r in recs {
                        g.record(r);
                    }
                }
                _ => {}
            }
        }
        let now = g.now;
        if now - g.pruned_at >= MINUTE {
            g.prune(now);
        }
        if g.path.is_some() && now - g.compacted_at >= 24 * H {
            g.pending.clear();
            g.compact(now);
        }
        g.write_pending();
    }

    /// `Changes` for (since, until] against the current client view.
    pub fn changes(&self, since: Ms, until: Ms, view: &WireState) -> Value {
        let g = self.inner.lock();
        let complete = since >= g.covered_from;
        let since = since.max(until - CHANGES_MAX_MS);
        let inw = |t: Ms| t > since && t <= until;
        let group = |repo: &str| -> Value {
            view.get(Kind::Repo, repo)
                .and_then(|r| r.get("group").cloned())
                .unwrap_or(Value::Null)
        };
        let is_red_now = |repo: &str| {
            view.get(Kind::Repo, repo)
                .and_then(|r| r.pointer("/main/state"))
                .and_then(Value::as_str)
                .is_some_and(|x| x == "failure" || x == "error")
        };
        // Latest cluster a repo failed with in the window (for "what broke it").
        let mut repo_cluster: BTreeMap<&str, (Ms, &str)> = BTreeMap::new();
        let mut clusters: BTreeMap<&str, u32> = BTreeMap::new();
        for (at, c, repo) in g.failures.values() {
            if !inw(*at) {
                continue;
            }
            *clusters.entry(c.as_str()).or_default() += 1;
            let e = repo_cluster
                .entry(repo.as_str())
                .or_insert((*at, c.as_str()));
            if *at > e.0 {
                *e = (*at, c.as_str());
            }
        }
        // Main transitions: the newest per repo in the window decides.
        let mut last_main: BTreeMap<&str, (Ms, &MainEv)> = BTreeMap::new();
        let mut red_start: BTreeMap<&str, Ms> = BTreeMap::new();
        let mut recovered = Vec::new();
        for ((at, _), m) in g.mains.iter().filter(|((at, _), _)| *at <= until) {
            let at = *at;
            if red(m.to) && !red(m.from) {
                red_start.insert(m.repo.as_str(), at);
            }
            if inw(at) {
                last_main.insert(m.repo.as_str(), (at, m));
                if red(m.from) && !red(m.to) {
                    let mut o = json!({"repo": m.repo, "at": at});
                    if let Some(gr) = group(&m.repo).as_str() {
                        o["group"] = gr.into();
                    }
                    if let Some(t0) = red_start.get(m.repo.as_str()) {
                        o["red_ms"] = (at - t0).into();
                    }
                    recovered.push(o);
                }
            }
        }
        let mut reds: Vec<Value> = last_main
            .values()
            .filter(|(_, m)| red(m.to) && is_red_now(&m.repo))
            .map(|(at, m)| {
                let mut o = json!({"repo": m.repo, "at": at});
                if let Some(gr) = group(&m.repo).as_str() {
                    o["group"] = gr.into();
                }
                if let Some(c) = &m.culprit {
                    o["culprit"] = c.clone().into();
                }
                if let Some((_, c)) = repo_cluster.get(m.repo.as_str()) {
                    o["cluster"] = (*c).into();
                }
                o
            })
            .collect();
        reds.sort_by_key(|o| std::cmp::Reverse(o["at"].as_i64().unwrap_or(0)));
        recovered.sort_by_key(|o| std::cmp::Reverse(o["at"].as_i64().unwrap_or(0)));
        let red_repos: std::collections::BTreeSet<&str> =
            reds.iter().filter_map(|o| o["repo"].as_str()).collect();
        let mut still: Vec<Value> = view
            .iter(Kind::Repo)
            .filter(|(id, r)| {
                is_red_now(id)
                    && !red_repos.contains(id.as_str())
                    && r.pointer("/main/since").and_then(Value::as_i64).unwrap_or(0) <= since
            })
            .map(|(id, r)| {
                let mut o = json!({"repo": id, "since": r.pointer("/main/since").cloned().unwrap_or(Value::Null)});
                if let Some(gr) = r.get("group").and_then(Value::as_str) {
                    o["group"] = gr.into();
                }
                o
            })
            .collect();
        still.sort_by_key(|o| o["since"].as_i64().unwrap_or(0));
        // First sighting: the cluster's own (7 d of rollups) or the log's, the earlier.
        let mut first_fail: BTreeMap<&str, Ms> = BTreeMap::new();
        for (at, c, _) in g.failures.values() {
            let e = first_fail.entry(c.as_str()).or_insert(*at);
            *e = (*e).min(*at);
        }
        let new_cluster = |c: &str| {
            let fs = view
                .get(Kind::Cluster, c)
                .and_then(|x| x.get("first_seen"))
                .and_then(Value::as_i64);
            let fl = first_fail.get(c).copied();
            match (fs, fl) {
                (Some(a), Some(b)) => a.min(b) > since,
                (Some(a), None) | (None, Some(a)) => a > since,
                (None, None) => false,
            }
        };
        let mut cl: Vec<(u32, &str)> = clusters.iter().map(|(c, n)| (*n, *c)).collect();
        cl.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
        let clusters_new = cl.iter().filter(|(_, c)| new_cluster(c)).count();
        let cl: Vec<Value> = cl
            .iter()
            .take(20)
            .map(|(n, c)| json!({"id": c, "count": n, "new": new_cluster(c)}))
            .collect();
        let deps: Vec<&DepRec> = g.deploys.values().filter(|d| inw(d.at())).collect();
        let mut deploys: Vec<Value> = deps
            .iter()
            .map(|d| json!({"app": d.app, "sha": d.sha, "state": d.state, "at": d.at()}))
            .collect();
        let deploys_n = deps.iter().filter(|d| d.done()).count();
        let deploys_failed = deps
            .iter()
            .filter(|d| d.state == DeployState::Failure)
            .count();
        deploys.sort_by_key(|o| std::cmp::Reverse(o["at"].as_i64().unwrap_or(0)));
        deploys.truncate(50);
        let mut hl: Vec<(&str, Ms, Health, Health)> = g
            .health
            .iter()
            .filter(|((_, at), _)| inw(*at))
            .map(|((app, at), (from, to))| (app.as_str(), *at, *from, *to))
            .collect();
        hl.sort_by_key(|h| (h.1, h.0));
        let apps_down = hl.iter().filter(|h| h.3 == Health::Down).count();
        let apps_recovered = hl
            .iter()
            .filter(|h| h.3 == Health::Up && matches!(h.2, Health::Down | Health::Degraded))
            .count();
        let mut apps: Vec<Value> = hl
            .iter()
            .map(|(app, at, from, to)| json!({"app": app, "from": from, "to": to, "at": at}))
            .collect();
        apps.truncate(200);
        let fins: Vec<&Finish> = g.finishes.values().filter(|f| inw(f.at)).collect();
        let failed = fins.iter().filter(|f| f.failed).count();
        // Per group: failed runs, reds, and PRs opened / merged / stuck.
        #[derive(Default)]
        struct G {
            failed: u32,
            red: u32,
            opened: u32,
            merged: u32,
            stuck: u32,
        }
        let group_or_org = |repo: &str| -> String {
            group(repo)
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("org:{}", repo.split('/').next().unwrap_or(repo)))
        };
        let mut groups: BTreeMap<String, G> = BTreeMap::new();
        for f in fins.iter().filter(|f| f.failed) {
            if let Some(gr) = group(&f.repo).as_str() {
                groups.entry(gr.to_string()).or_default().failed += 1;
            }
        }
        for o in &reds {
            if let Some(gr) = o["group"].as_str() {
                groups.entry(gr.to_string()).or_default().red += 1;
            }
        }
        // Opened: PRs created in the window (seen on the stream, or still open in the view).
        let mut opened: BTreeMap<&str, &str> = BTreeMap::new();
        for (id, (c, repo)) in &g.opened {
            if inw(*c) {
                opened.insert(id.as_str(), repo.as_str());
            }
        }
        for (id, p) in view.iter(Kind::Pr) {
            if p.get("created").and_then(Value::as_i64).is_some_and(inw) {
                opened.insert(id.as_str(), s(p, "repo"));
            }
        }
        for repo in opened.values() {
            groups.entry(group_or_org(repo)).or_default().opened += 1;
        }
        let merged: Vec<&str> = g
            .merges
            .iter()
            .filter(|(_, at)| inw(**at))
            .map(|((repo, _), _)| repo.as_str())
            .collect();
        for repo in &merged {
            groups.entry(group_or_org(repo)).or_default().merged += 1;
        }
        // Stuck: open, not a draft, no activity for 3 days (`stale_ms`), as of now.
        let (mut stuck, mut stuck_bot) = (0usize, 0usize);
        for (_, p) in view.iter(Kind::Pr) {
            let open = !matches!(s(p, "phase"), "merged" | "closed" | "deployed" | "draft");
            if !open || p.get("stale_ms").is_none() {
                continue;
            }
            if p.get("bot").and_then(Value::as_bool) == Some(true) {
                stuck_bot += 1;
            } else {
                stuck += 1;
                groups.entry(group_or_org(s(p, "repo"))).or_default().stuck += 1;
            }
        }
        let mut gl: Vec<(String, G)> = groups.into_iter().collect();
        gl.sort_by(|a, b| {
            (b.1.red, b.1.failed, b.1.stuck)
                .cmp(&(a.1.red, a.1.failed, a.1.stuck))
                .then(a.0.cmp(&b.0))
        });
        let flakes = view
            .iter(Kind::Flake)
            .filter(|(_, f)| f.get("last_at").and_then(Value::as_i64).is_some_and(inw))
            .count();
        json!({
            "since": since,
            "until": until,
            "complete": complete,
            "counts": {
                "red": reds.len(), "recovered": recovered.len(), "still_red": still.len(),
                "pipelines": fins.len(), "failed": failed, "deploys": deploys_n,
                "deploys_failed": deploys_failed, "clusters_new": clusters_new, "flakes": flakes,
                "prs_opened": opened.len(), "prs_merged": merged.len(),
                "prs_stuck": stuck, "prs_stuck_bot": stuck_bot,
                "apps_down": apps_down, "apps_recovered": apps_recovered,
            },
            "red": reds,
            "recovered": recovered,
            "still_red": still,
            "clusters": cl,
            "deploys": deploys,
            "apps": apps,
            "groups": gl.into_iter().map(|(id, x)| json!({"id": id, "failed": x.failed, "red": x.red,
                "prs": {"opened": x.opened, "merged": x.merged, "stuck": x.stuck}})).collect::<Vec<_>>(),
        })
    }

    /// `AppHistory` (`GET /api/v1/app/{id}`): the app now, its last deploys and its health
    /// transitions over 7 days. None when the app is unknown.
    pub fn app(&self, id: &str, view: &WireState, now: Ms) -> Option<Value> {
        let g = self.inner.lock();
        let app = view.get(Kind::App, id).cloned();
        // The log, plus deploys only the view still has (visible window).
        let mut deps: BTreeMap<String, DepRec> = BTreeMap::new();
        for (k, d) in &g.deploys {
            if d.app == id {
                deps.insert(k.clone(), d.clone());
            }
        }
        for (_, v) in view.iter(Kind::Deploy) {
            if s(v, "app") != id {
                continue;
            }
            if let Ok(d) = serde_json::from_value::<Deploy>(v.clone()) {
                deps.entry(format!("{}@{}", d.app, d.sha))
                    .or_insert(DepRec {
                        app: d.app,
                        repo: d.repo,
                        sha: d.sha,
                        via: d.via,
                        state: d.state,
                        started: d.started,
                        finished: d.finished,
                        pipeline: d.pipeline,
                    });
            }
        }
        let health: Vec<(Ms, Health, Health)> = g
            .health
            .range((id.to_string(), Ms::MIN)..=(id.to_string(), Ms::MAX))
            .filter(|((_, at), _)| *at >= now - 7 * 24 * H)
            .map(|((_, at), (f, t))| (*at, *f, *t))
            .collect();
        if app.is_none() && deps.is_empty() && health.is_empty() {
            return None;
        }
        let mut dl: Vec<&DepRec> = deps.values().collect();
        dl.sort_by_key(|d| std::cmp::Reverse((d.at(), d.started)));
        let deploys: Vec<Value> = dl
            .iter()
            .take(DEPLOYS_PER_APP)
            .map(|d| {
                let mut o = json!({"sha": d.sha, "via": d.via, "state": d.state,
                    "started": d.started, "at": d.at()});
                if let Some(f) = d.finished {
                    o["finished"] = f.into();
                    o["duration_ms"] = (f - d.started).max(0).into();
                }
                if let Some(p) = &d.pipeline {
                    o["pipeline"] = p.clone().into();
                }
                o
            })
            .collect();
        // Time in each health state over the window, from the transitions (the state
        // before the first one is its `from`).
        let lo = (now - 7 * 24 * H).max(g.covered_from.min(now));
        let mut spans: BTreeMap<&'static str, Ms> = BTreeMap::new();
        let name = |h: Health| match h {
            Health::Up => "up",
            Health::Degraded => "degraded",
            Health::Down => "down",
            Health::Unknown => "unknown",
        };
        let mut t = lo;
        let mut cur: Option<Health> = health.first().map(|h| h.1);
        for (at, _, to) in &health {
            if let Some(c) = cur {
                *spans.entry(name(c)).or_default() += (at - t).max(0);
            }
            t = (*at).max(lo);
            cur = Some(*to);
        }
        let now_h = app
            .as_ref()
            .and_then(|a| a.get("health").cloned())
            .and_then(|h| serde_json::from_value::<Health>(h).ok())
            .or(cur);
        if let Some(c) = now_h {
            *spans.entry(name(c)).or_default() += (now - t).max(0);
        }
        let mut hv: Vec<Value> = health
            .iter()
            .map(|(at, f, t)| json!({"from": f, "to": t, "at": at}))
            .collect();
        hv.reverse();
        Some(json!({
            "id": id,
            "app": app,
            "deploys": deploys,
            "health": hv,
            "health_ms": spans,
            "since": lo,
            "complete": lo <= now - 7 * 24 * H,
        }))
    }

    /// `EngineHistory` (`GET /api/v1/engine/{id}/history`): 24 h at one-minute resolution,
    /// columnar. A minute without a change carries the previous one; `null` = no data.
    pub fn engine_history(&self, id: &str, view: &WireState, now: Ms) -> Option<Value> {
        let g = self.inner.lock();
        let e = g.engines.get(id);
        let cur = view.get(Kind::Engine, id);
        if e.is_none() && cur.is_none() {
            return None;
        }
        let end = now - now.rem_euclid(MINUTE);
        let from = end - ENGINE_KEEP_MS + MINUTE;
        let n = (ENGINE_KEEP_MS / MINUTE) as usize;
        let (mut busy, mut slots, mut cpu, mut mem, mut load) = (
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
            Vec::with_capacity(n),
        );
        let r1 = |x: Option<f32>| x.map(|v| ((v as f64) * 10.0).round() / 10.0);
        let empty = BTreeMap::new();
        let mins = e.map_or(&empty, |e| &e.mins);
        let mut last: Option<Minute> = mins.range(..from).next_back().map(|(_, m)| *m);
        let mut it = mins.range(from..).peekable();
        for i in 0..n {
            let t = from + i as Ms * MINUTE;
            let mut this = None;
            while let Some((k, m)) = it.peek() {
                if **k > t {
                    break;
                }
                this = Some(**m);
                it.next();
            }
            if let Some(m) = this {
                last = Some(m);
            }
            match (this, last) {
                (Some(m), _) | (None, Some(m)) if m.online => {
                    // A carried minute holds the state, not the peak.
                    let b = if this.is_some() { m.busy } else { m.busy_last };
                    busy.push(Value::from(b));
                    slots.push(Value::from(m.slots));
                    cpu.push(json!(r1(m.cpu)));
                    mem.push(json!(r1(m.mem)));
                    load.push(json!(r1(m.load)));
                }
                _ => {
                    busy.push(Value::Null);
                    slots.push(Value::Null);
                    cpu.push(Value::Null);
                    mem.push(Value::Null);
                    load.push(Value::Null);
                }
            }
        }
        // Repos served in the last hour: the pipelines it ran (a host: its agents ran).
        let mut runs: BTreeMap<&str, Ms> = BTreeMap::new();
        let mut ids: Vec<&str> = vec![id];
        for a in cur
            .and_then(|c| c.get("agents"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            ids.extend(a.as_str());
        }
        for i in ids {
            for (p, t) in g.engines.get(i).map(|e| &e.runs).into_iter().flatten() {
                let e = runs.entry(p.as_str()).or_insert(*t);
                *e = (*e).max(*t);
            }
        }
        let mut repos: BTreeMap<String, u32> = BTreeMap::new();
        for (p, t) in runs {
            if t < now - H {
                continue;
            }
            let repo = view
                .get(Kind::Pipeline, p)
                .map(|v| s(v, "repo").to_string())
                .or_else(|| {
                    p.split_once(':')
                        .and_then(|(_, r)| r.rsplit_once(':'))
                        .map(|(r, _)| r.to_string())
                })
                .unwrap_or_default();
            if !repo.is_empty() {
                *repos.entry(repo).or_default() += 1;
            }
        }
        let mut rl: Vec<(String, u32)> = repos.into_iter().collect();
        rl.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let kind = cur
            .map(|c| s(c, "kind").to_string())
            .or_else(|| e.map(|e| e.kind.clone()))
            .unwrap_or_default();
        let host = cur
            .and_then(|c| c.get("host").and_then(Value::as_str).map(str::to_string))
            .or_else(|| e.and_then(|e| e.host.clone()));
        Some(json!({
            "id": id,
            "kind": kind,
            "host": host,
            "from": from,
            "step_ms": MINUTE,
            "n": n,
            "busy": busy,
            "slots": slots,
            "cpu": cpu,
            "mem": mem,
            "load": load,
            "repos": rl.iter().map(|(r, n)| json!({"repo": r, "runs": n})).collect::<Vec<_>>(),
        }))
    }
}

/// `Insights`: the Factory Floor tables of a client view, sorted for display.
pub fn insights(view: &WireState, at: Ms) -> Value {
    let all = |k: Kind| -> Vec<Value> { view.iter(k).map(|(_, v)| v.clone()).collect() };
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
    let mut groups = all(Kind::Group);
    groups.sort_by_key(|g| (s(g, "name").to_lowercase(), s(g, "id").to_string()));
    let mut clusters = all(Kind::Cluster);
    clusters.sort_by(|a, b| {
        (n(b, "open") > 0, n(b, "count_1h"), n(b, "count"))
            .cmp(&(n(a, "open") > 0, n(a, "count_1h"), n(a, "count")))
            .then(s(a, "id").cmp(s(b, "id")))
    });
    let mut flakes = all(Kind::Flake);
    flakes.sort_by(|a, b| {
        n(b, "flips_24h")
            .cmp(&n(a, "flips_24h"))
            .then(s(a, "id").cmp(s(b, "id")))
    });
    let names: BTreeMap<String, String> = view
        .iter(Kind::Group)
        .map(|(id, g)| (id.clone(), s(g, "name").to_string()))
        .collect();
    let mut trends = all(Kind::Trend);
    trends.sort_by(|a, b| {
        let key = |t: &Value| {
            let id = s(t, "id");
            (
                id != "fleet",
                names
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| id.to_string())
                    .to_lowercase(),
            )
        };
        key(a).cmp(&key(b))
    });
    json!({"at": at, "groups": groups, "clusters": clusters, "flakes": flakes, "trends": trends})
}
