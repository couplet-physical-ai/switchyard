//! The fleet store: base fact registers (order-independent merges), indices,
//! and the derived wire entities with their serialized JSON (so snapshots and
//! ops never re-serialize). `apply` merges facts and marks derived keys dirty;
//! `flush` recomputes exactly the dirty keys and returns the ops that changed.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use rustc_hash::FxHashMap;
use serde::Serialize;

use crate::facts::*;
use crate::model::*;

mod insights;
pub use insights::{ROLLUP_KEEP_MS, group_name, team_slug};

pub const H: Ms = 3_600_000;
/// Base registers older than this are garbage-collected.
pub const RETAIN_MS: Ms = 26 * H;
/// Commits / deploys / closed PRs stay visible this long.
pub const VISIBLE_MS: Ms = 24 * H;
/// Finished pipelines stay visible this long.
pub const PIPELINE_VISIBLE_MS: Ms = 2 * H;
/// Dots per repo main line.
pub const DOTS: usize = crate::wire::DOTS;

#[derive(Clone, Debug)]
pub struct StoreConfig {
    pub woodpecker_url: String,
    pub cicd_url: String,
    /// Orgs shown even before their repos are listed.
    pub orgs: Vec<String>,
}

impl Default for StoreConfig {
    fn default() -> Self {
        StoreConfig {
            woodpecker_url: "https://ci.dev.example.com".into(),
            cicd_url: "https://cicd.apps.example.com".into(),
            orgs: Vec::new(),
        }
    }
}

/// One output op, with the entity already serialized.
#[derive(Clone, Debug, PartialEq)]
pub enum OpOut {
    Upsert {
        kind: Kind,
        id: String,
        json: Arc<str>,
    },
    Remove {
        kind: Kind,
        id: String,
    },
    /// RFC 7386 merge patch on the entity the client holds (contract v0.4).
    Patch {
        kind: Kind,
        id: String,
        json: String,
    },
    /// One Dot into `repos[id].main.recent` (contract v0.4).
    Dot {
        id: String,
        json: String,
    },
    Event(Event),
}

impl OpOut {
    /// Append this op as JSON to `out`.
    pub fn write_json(&self, out: &mut Vec<u8>) {
        match self {
            OpOut::Upsert { kind, id, json } => {
                out.extend_from_slice(b"{\"op\":\"upsert\",\"kind\":\"");
                out.extend_from_slice(kind.as_str().as_bytes());
                out.extend_from_slice(b"\",\"id\":");
                serde_json::to_writer(&mut *out, id).ok();
                out.extend_from_slice(b",\"v\":");
                out.extend_from_slice(json.as_bytes());
                out.push(b'}');
            }
            OpOut::Remove { kind, id } => {
                out.extend_from_slice(b"{\"op\":\"remove\",\"kind\":\"");
                out.extend_from_slice(kind.as_str().as_bytes());
                out.extend_from_slice(b"\",\"id\":");
                serde_json::to_writer(&mut *out, id).ok();
                out.push(b'}');
            }
            OpOut::Patch { kind, id, json } => {
                out.extend_from_slice(b"{\"op\":\"patch\",\"kind\":\"");
                out.extend_from_slice(kind.as_str().as_bytes());
                out.extend_from_slice(b"\",\"id\":");
                serde_json::to_writer(&mut *out, id).ok();
                out.extend_from_slice(b",\"v\":");
                out.extend_from_slice(json.as_bytes());
                out.push(b'}');
            }
            OpOut::Dot { id, json } => {
                out.extend_from_slice(b"{\"op\":\"dot\",\"id\":");
                serde_json::to_writer(&mut *out, id).ok();
                out.extend_from_slice(b",\"v\":");
                out.extend_from_slice(json.as_bytes());
                out.push(b'}');
            }
            OpOut::Event(e) => {
                out.extend_from_slice(b"{\"op\":\"event\",\"e\":");
                serde_json::to_writer(&mut *out, e).ok();
                out.push(b'}');
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct CommitReg {
    best: CommitFact,
    branches: BTreeSet<String>,
}

#[derive(Default)]
struct Indices {
    /// repo@sha → pipeline ids
    sha_pipelines: FxHashMap<String, BTreeSet<String>>,
    /// repo → commit keys (repo@sha)
    repo_commits: FxHashMap<String, BTreeSet<String>>,
    /// repo → pipeline ids
    repo_pipelines: FxHashMap<String, BTreeSet<String>>,
    /// repo → pr keys
    repo_prs: FxHashMap<String, BTreeSet<String>>,
    /// repo@head_sha → pr keys
    sha_prs: FxHashMap<String, BTreeSet<String>>,
    /// repo@sha → status keys
    sha_statuses: FxHashMap<String, BTreeSet<String>>,
    /// repo@sha → deploy keys
    sha_deploys: FxHashMap<String, BTreeSet<String>>,
}

fn idx_add(m: &mut FxHashMap<String, BTreeSet<String>>, k: &str, v: &str) {
    m.entry(k.to_string()).or_default().insert(v.to_string());
}
fn idx_del(m: &mut FxHashMap<String, BTreeSet<String>>, k: &str, v: &str) {
    if let Some(s) = m.get_mut(k) {
        s.remove(v);
        if s.is_empty() {
            m.remove(k);
        }
    }
}

fn split_repo(id: &str) -> (&str, &str) {
    id.split_once('/').unwrap_or((id, ""))
}
fn sha_key(repo: &str, sha: &str) -> String {
    ids::commit(repo, sha)
}

#[derive(Default)]
pub struct Store {
    pub cfg: StoreConfig,
    // ---- base registers ----
    repo_lists: BTreeMap<String, RepoList>,
    commits: FxHashMap<String, CommitReg>,
    main_hist: FxHashMap<String, MainHist>,
    pipelines: FxHashMap<String, Pipeline>,
    prs: FxHashMap<String, PrFact>,
    statuses: FxHashMap<String, StatusFact>,
    deploys: FxHashMap<String, DeployFact>,
    app_list: Option<AppList>,
    health: FxHashMap<String, HealthFact>,
    engine_lists: BTreeMap<String, EngineList>,
    queue: Option<QueueFact>,
    lanes: Option<LaneList>,
    watcher: Option<WatcherFact>,
    step_errors: FxHashMap<String, StepErrorFact>,
    rollups: BTreeMap<Ms, RollupFact>,
    /// repo → normalized team slug (from the apps list).
    repo_team: FxHashMap<String, String>,
    /// Team slug → display name when the catalog spells it as an acronym.
    team_names: BTreeMap<String, String>,
    /// Hourly gauge samples (hour → group id → (pr age, red repos)), taken by `tick`.
    gauges: BTreeMap<Ms, BTreeMap<String, (Option<Ms>, u32)>>,
    /// Groups / clusters / flakes need recomputing (a pipeline finished, a failure
    /// signature arrived, apps changed, time passed).
    insights_dirty: bool,
    /// Trends need recomputing (their inputs changed); time alone moves them only per
    /// 5-minute bucket.
    trends_dirty: bool,
    /// 5-minute bucket the trends were last computed for.
    trends_at: Ms,
    idx: Indices,
    // ---- derived ----
    tables: Vec<BTreeMap<String, Arc<str>>>,
    pub repos_t: FxHashMap<String, Repo>,
    pub commits_t: FxHashMap<String, Commit>,
    pub prs_t: FxHashMap<String, Pr>,
    pub apps_t: FxHashMap<String, App>,
    deploys_t: FxHashMap<String, Deploy>,
    dirty: Vec<BTreeSet<String>>,
    events: Vec<Event>,
    /// Logical clock: the latest `now` given to `flush`/`tick`.
    pub now: Ms,
    /// Bumps whenever any table changes (snapshot cache key).
    pub version: u64,
}

impl Store {
    pub fn new(cfg: StoreConfig) -> Store {
        let mut s = Store {
            cfg,
            tables: vec![BTreeMap::new(); Kind::COUNT],
            dirty: vec![BTreeSet::new(); Kind::COUNT],
            ..Default::default()
        };
        let orgs = s.cfg.orgs.clone();
        for o in orgs {
            s.mark(Kind::Org, &o);
        }
        s.mark(Kind::Stats, "fleet");
        s
    }

    fn mark(&mut self, k: Kind, id: &str) {
        self.dirty[k.index()].insert(id.to_string());
    }

    pub fn table(&self, k: Kind) -> &BTreeMap<String, Arc<str>> {
        &self.tables[k.index()]
    }

    pub fn pipeline(&self, id: &str) -> Option<&Pipeline> {
        self.pipelines.get(id)
    }

    /// Every retained pipeline of one commit (also those past the visible window).
    /// Every check of a PR (required first, then by name).
    pub fn pr_checks(&self, p: &PrFact) -> Vec<Check> {
        let mut checks = self.live_checks(p);
        checks.sort_by(|a, b| b.required.cmp(&a.required).then(a.name.cmp(&b.name)));
        checks
    }

    pub fn pr_all_checks(&self, id: &str) -> Option<Vec<Check>> {
        self.prs.get(id).map(|p| self.pr_checks(p))
    }

    pub fn pipelines_for(&self, repo: &str, sha: &str) -> Vec<Pipeline> {
        self.idx
            .sha_pipelines
            .get(&sha_key(repo, sha))
            .into_iter()
            .flatten()
            .filter_map(|id| self.pipelines.get(id).cloned())
            .collect()
    }

    /// Recompute the Factory Floor (groups, clusters, flakes, trends) on the next flush.
    pub fn mark_insights(&mut self) {
        self.insights_dirty = true;
        self.trends_dirty = true;
    }

    /// Anything to flush other than the Factory Floor tables.
    pub fn has_dirty_core(&self) -> bool {
        !self.events.is_empty() || self.dirty.iter().any(|d| !d.is_empty())
    }

    pub fn has_dirty(&self) -> bool {
        !self.events.is_empty()
            || self.insights_dirty
            || self.trends_dirty
            || self.trends_due(self.now)
            || self.dirty.iter().any(|d| !d.is_empty())
    }

    pub fn counts(&self) -> BTreeMap<&'static str, usize> {
        let mut m = BTreeMap::new();
        for k in Kind::ALL {
            m.insert(k.snapshot_field(), self.tables[k.index()].len());
        }
        m.insert("_pipelines_retained", self.pipelines.len());
        m.insert("_commits_retained", self.commits.len());
        m.insert("_statuses_retained", self.statuses.len());
        m
    }

    // ------------------------------------------------------------------
    // apply
    // ------------------------------------------------------------------

    /// Merge one fact. `live` = emit transient events for what changed (false
    /// during backfill, so a boot does not replay a day of animations).
    pub fn apply(&mut self, fact: Fact, live: bool) {
        match fact {
            Fact::Repos(l) => self.apply_repos(l),
            Fact::Commit(c) => self.apply_commit(c, live),
            Fact::MainHist(h) => {
                let cur = self.main_hist.get(&h.repo);
                if cur
                    .is_none_or(|c| (c.observed, content_hash(c)) < (h.observed, content_hash(&h)))
                {
                    let r = h.repo.clone();
                    self.main_hist.insert(r.clone(), h);
                    self.mark(Kind::Repo, &r);
                }
            }
            Fact::Pipeline(p) => self.apply_pipeline(p, live),
            Fact::PipelineGone { id } => self.remove_pipeline(&id),
            Fact::Pr(p) => self.apply_pr(p),
            Fact::Status(s) => self.apply_status(s),
            Fact::Deploy(d) => self.apply_deploy(d),
            Fact::Apps(a) => {
                if self
                    .app_list
                    .as_ref()
                    .is_none_or(|c| (c.observed, content_hash(c)) < (a.observed, content_hash(&a)))
                {
                    let old: BTreeSet<String> = self
                        .app_list
                        .iter()
                        .flat_map(|l| l.apps.iter().map(|x| x.id.clone()))
                        .collect();
                    let old_repos: BTreeSet<String> = self
                        .app_list
                        .iter()
                        .flat_map(|l| l.apps.iter().filter_map(|x| x.repo.clone()))
                        .collect();
                    for x in &a.apps {
                        self.dirty[Kind::App.index()].insert(x.id.clone());
                        if let Some(r) = &x.repo {
                            self.dirty[Kind::Repo.index()].insert(r.clone());
                        }
                    }
                    for id in old {
                        self.mark(Kind::App, &id);
                    }
                    for r in old_repos {
                        self.mark(Kind::Repo, &r);
                    }
                    self.app_list = Some(a);
                    self.rebuild_repo_team();
                    self.insights_dirty = true;
                    self.trends_dirty = true;
                    let ds: Vec<String> = self
                        .deploys
                        .values()
                        .map(|d| sha_key(&d.repo, &d.sha))
                        .collect();
                    for d in ds {
                        self.mark(Kind::Deploy, &d);
                    }
                    self.mark(Kind::Stats, "fleet");
                }
            }
            Fact::Health(h) => {
                let cur = self.health.get(&h.app);
                if cur.is_none_or(|c| (c.checked, content_hash(c)) < (h.checked, content_hash(&h)))
                {
                    let id = h.app.clone();
                    self.health.insert(id.clone(), h);
                    self.mark(Kind::App, &id);
                    self.mark(Kind::Stats, "fleet");
                }
            }
            Fact::Engines(e) => {
                let cur = self.engine_lists.get(&e.source);
                if cur
                    .is_none_or(|c| (c.observed, content_hash(c)) < (e.observed, content_hash(&e)))
                {
                    for x in cur
                        .iter()
                        .flat_map(|c| c.engines.iter())
                        .chain(e.engines.iter())
                    {
                        self.dirty[Kind::Engine.index()].insert(x.id.clone());
                    }
                    self.engine_lists.insert(e.source.clone(), e);
                }
            }
            Fact::Queue(q) => {
                if self
                    .queue
                    .as_ref()
                    .is_none_or(|c| (c.observed, content_hash(c)) < (q.observed, content_hash(&q)))
                {
                    let mut touched: BTreeSet<String> = BTreeSet::new();
                    if let Some(c) = &self.queue {
                        touched.extend(c.queue.items.iter().cloned());
                        self.mark(Kind::Queue, &c.queue.id.clone());
                    }
                    touched.extend(q.queue.items.iter().cloned());
                    self.mark(Kind::Queue, &q.queue.id);
                    for p in touched {
                        self.mark(Kind::Pipeline, &p);
                    }
                    self.queue = Some(q);
                    self.mark(Kind::Stats, "fleet");
                }
            }
            Fact::Lanes(l) => {
                if self
                    .lanes
                    .as_ref()
                    .is_none_or(|c| (c.observed, content_hash(c)) < (l.observed, content_hash(&l)))
                {
                    let mut touched: BTreeSet<String> = BTreeSet::new();
                    if let Some(c) = &self.lanes {
                        touched.extend(c.lanes.iter().map(|x| x.id.clone()));
                    }
                    touched.extend(l.lanes.iter().map(|x| x.id.clone()));
                    let deps: Vec<String> = self
                        .deploys
                        .values()
                        .filter(|d| touched.contains(&d.repo))
                        .map(|d| sha_key(&d.repo, &d.sha))
                        .collect();
                    for d in deps {
                        // The deploy, its commit, and through them the app and PRs.
                        self.mark(Kind::Deploy, &d);
                        self.mark(Kind::Commit, &d);
                    }
                    for r in &touched {
                        if let Some(a) = self.app_for_repo(r) {
                            self.mark(Kind::App, &a);
                        }
                        let prs: Vec<String> = self
                            .idx
                            .repo_prs
                            .get(r)
                            .map(|x| x.iter().cloned().collect())
                            .unwrap_or_default();
                        for p in prs {
                            self.mark(Kind::Pr, &p);
                        }
                    }
                    for id in touched {
                        self.mark(Kind::Lane, &id);
                        self.mark(Kind::Repo, &id);
                    }
                    self.lanes = Some(l);
                }
            }
            Fact::Watcher(w) => {
                if self
                    .watcher
                    .as_ref()
                    .is_none_or(|c| (c.observed, content_hash(c)) < (w.observed, content_hash(&w)))
                {
                    self.watcher = Some(w);
                    self.mark(Kind::Watcher, "outage");
                }
            }
            Fact::StepError(e) => {
                let k = e.key();
                if self
                    .step_errors
                    .get(&k)
                    .is_none_or(|c| (c.observed, content_hash(c)) < (e.observed, content_hash(&e)))
                {
                    let p = e.pipeline.clone();
                    self.step_errors.insert(k, e);
                    self.mark(Kind::Pipeline, &p);
                    self.insights_dirty = true;
                    self.trends_dirty = true;
                }
            }
            Fact::Rollup(r) => {
                if self.rollups.get(&r.hour).is_none_or(|c| {
                    (c.fleet.finished, content_hash(c)) < (r.fleet.finished, content_hash(&r))
                }) {
                    self.rollups.insert(r.hour, r);
                    self.insights_dirty = true;
                    self.trends_dirty = true;
                    self.trends_at = 0;
                }
            }
        }
    }

    fn apply_repos(&mut self, l: RepoList) {
        let cur = self.repo_lists.get(&l.source);
        if cur.is_some_and(|c| (c.observed, content_hash(c)) >= (l.observed, content_hash(&l))) {
            return;
        }
        let mut touched: BTreeSet<String> = BTreeSet::new();
        if let Some(c) = cur {
            touched.extend(c.repos.iter().map(|r| r.id.clone()));
        }
        touched.extend(l.repos.iter().map(|r| r.id.clone()));
        for id in touched {
            let org = split_repo(&id).0.to_string();
            self.mark(Kind::Repo, &id);
            self.mark(Kind::Org, &org);
            // The default branch decides which commits are "on main".
            let cs: Vec<String> = self
                .idx
                .repo_commits
                .get(&id)
                .map(|x| x.iter().cloned().collect())
                .unwrap_or_default();
            for c in cs {
                self.mark(Kind::Commit, &c);
            }
            if let Some(a) = self.app_for_repo(&id) {
                self.mark(Kind::App, &a);
            }
        }
        self.repo_lists.insert(l.source.clone(), l);
    }

    fn apply_commit(&mut self, c: CommitFact, live: bool) {
        let key = sha_key(&c.repo, &c.sha);
        let repo = c.repo.clone();
        match self.commits.get_mut(&key) {
            Some(reg) => {
                let mut changed = reg.branches.insert(c.branch.clone());
                if commit_version(&reg.best) < commit_version(&c) {
                    reg.best = c;
                    changed = true;
                }
                if !changed {
                    return;
                }
            }
            None => {
                if live && (self.now == 0 || c.at >= self.now - 30 * 60_000) {
                    self.events.push(Event::Push {
                        repo: c.repo.clone(),
                        sha: c.sha.clone(),
                        branch: c.branch.clone(),
                        author: c.author.clone(),
                        bot: c.bot,
                        title: c.title.clone(),
                        at: c.at,
                    });
                }
                let mut branches = BTreeSet::new();
                branches.insert(c.branch.clone());
                self.commits
                    .insert(key.clone(), CommitReg { best: c, branches });
                idx_add(&mut self.idx.repo_commits, &repo, &key);
                self.mark(Kind::Stats, "fleet");
            }
        }
        self.mark(Kind::Commit, &key);
        self.mark(Kind::Repo, &repo);
        let prs: Vec<String> = self
            .idx
            .sha_prs
            .get(&key)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        for p in prs {
            self.mark(Kind::Pr, &p);
        }
    }

    fn apply_pipeline(&mut self, p: Pipeline, live: bool) {
        let id = p.id.clone();
        let old = self.pipelines.get(&id);
        if let Some(o) = old
            && pipeline_version(o) >= pipeline_version(&p)
        {
            return;
        }
        // Old news (a reconcile catching up on a finished run) does not animate.
        let fresh = self.now == 0
            || p.finished.or(p.started).unwrap_or(p.created) >= self.now - 10 * 60_000;
        if live && fresh {
            pipeline_events(old, &p, &mut self.events);
        }
        let key = sha_key(&p.repo, &p.sha);
        // The pipeline also tells us about its commit; that view is derived
        // from the current pipeline registers (see `commit_view`), so it does
        // not depend on which observations arrived first.
        if let Some(o) = old {
            let ok = sha_key(&o.repo, &o.sha);
            if let Some(n) = o.pr {
                let k = ids::pr(&o.repo, n);
                self.dirty[Kind::Pr.index()].insert(k);
            }
            if o.repo != p.repo {
                let (orepo, oid) = (o.repo.clone(), o.id.clone());
                idx_del(&mut self.idx.repo_pipelines, &orepo, &oid);
            }
            let o = self.pipelines.get(&id).expect("old");
            if ok != key {
                let (orepo, oid) = (o.repo.clone(), o.id.clone());
                let prs: Vec<String> = self
                    .idx
                    .sha_prs
                    .get(&ok)
                    .map(|x| x.iter().cloned().collect())
                    .unwrap_or_default();
                for pr in prs {
                    self.mark(Kind::Pr, &pr);
                }
                idx_del(&mut self.idx.sha_pipelines, &ok, &oid);
                let sibs: Vec<String> = self
                    .idx
                    .sha_pipelines
                    .get(&ok)
                    .map(|s| s.iter().cloned().collect())
                    .unwrap_or_default();
                for s in sibs {
                    self.mark(Kind::Pipeline, &s);
                }
                if !self.commits.contains_key(&ok) && !self.idx.sha_pipelines.contains_key(&ok) {
                    idx_del(&mut self.idx.repo_commits, &orepo, &ok);
                }
                self.mark(Kind::Commit, &ok);
                self.mark(Kind::Repo, &orepo);
            }
        }
        if !p.sha.is_empty() {
            let known =
                self.commits.contains_key(&key) || self.idx.sha_pipelines.contains_key(&key);
            if !known && live && fresh && p.event != PipelineEvent::PullRequest {
                self.events.push(Event::Push {
                    repo: p.repo.clone(),
                    sha: p.sha.clone(),
                    branch: p.branch.clone(),
                    author: p.author.clone().unwrap_or_default(),
                    bot: p.author.as_deref().is_some_and(is_bot),
                    title: p.title.clone().unwrap_or_default(),
                    at: p.created,
                });
            }
            idx_add(&mut self.idx.repo_commits, &p.repo, &key);
        }
        idx_add(&mut self.idx.sha_pipelines, &key, &id);
        idx_add(&mut self.idx.repo_pipelines, &p.repo, &id);
        self.mark(Kind::Pipeline, &id);
        self.mark(Kind::Commit, &key);
        self.mark(Kind::Repo, &p.repo.clone());
        self.mark(Kind::Stats, "fleet");
        // Running siblings' expected durations depend on this repo's finished runs.
        self.mark_active_pipelines(&p.repo.clone());
        if let Some(o) = self.pipelines.get(&id)
            && o.repo != p.repo
        {
            let r = o.repo.clone();
            self.mark_active_pipelines(&r);
        }
        let prs: Vec<String> = self
            .idx
            .sha_prs
            .get(&key)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        for pr in prs {
            self.mark(Kind::Pr, &pr);
        }
        if let Some(n) = p.pr {
            self.mark(Kind::Pr, &ids::pr(&p.repo, n));
        }
        // Failure clusters / flakes / trends read finished runs; flaky markers read the
        // other runs on the same sha.
        let done_changed = p.state.is_done()
            || self
                .pipelines
                .get(&id)
                .is_some_and(|o| o.state.is_done() || o.state != p.state);
        if done_changed {
            self.insights_dirty = true;
            self.trends_dirty = true;
        }
        // A sibling's step outcome decides `flaky` on the runs of the same sha.
        let sibs: Vec<String> = self
            .idx
            .sha_pipelines
            .get(&key)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        for s in sibs {
            self.mark(Kind::Pipeline, &s);
        }
        self.pipelines.insert(id, p);
    }

    fn apply_pr(&mut self, p: PrFact) {
        let key = ids::pr(&p.repo, p.number);
        if let Some(o) = self.prs.get(&key) {
            if (o.observed, o.updated, content_hash(o)) >= (p.observed, p.updated, content_hash(&p))
            {
                return;
            }
            let ok = sha_key(&o.repo, &o.head_sha);
            let k2 = key.clone();
            idx_del(&mut self.idx.sha_prs, &ok, &k2);
            self.mark(Kind::Commit, &ok);
        }
        let sk = sha_key(&p.repo, &p.head_sha);
        idx_add(&mut self.idx.sha_prs, &sk, &key);
        idx_add(&mut self.idx.repo_prs, &p.repo, &key);
        self.mark(Kind::Pr, &key);
        self.mark(Kind::Commit, &sk);
        self.mark(Kind::Repo, &p.repo.clone());
        self.mark(Kind::Stats, "fleet");
        if let Some(ms) = &p.merge_sha {
            let mk = sha_key(&p.repo, ms);
            self.mark(Kind::Commit, &mk);
        }
        self.prs.insert(key, p);
    }

    fn apply_status(&mut self, s: StatusFact) {
        let sk = sha_key(&s.repo, &s.sha);
        let key = format!("{sk}|{}", s.context);
        if let Some(o) = self.statuses.get(&key)
            && (o.at, content_hash(o)) >= (s.at, content_hash(&s))
        {
            return;
        }
        idx_add(&mut self.idx.sha_statuses, &sk, &key);
        self.mark(Kind::Commit, &sk);
        self.mark(Kind::Repo, &s.repo.clone());
        let prs: Vec<String> = self
            .idx
            .sha_prs
            .get(&sk)
            .map(|x| x.iter().cloned().collect())
            .unwrap_or_default();
        for p in prs {
            self.mark(Kind::Pr, &p);
        }
        self.statuses.insert(key, s);
    }

    fn apply_deploy(&mut self, d: DeployFact) {
        let sk = sha_key(&d.repo, &d.sha);
        let key = format!("{sk}|{}", d.source);
        if let Some(o) = self.deploys.get(&key)
            && deploy_version(o) >= deploy_version(&d)
        {
            return;
        }
        idx_add(&mut self.idx.sha_deploys, &sk, &key);
        self.mark(Kind::Deploy, &sk);
        self.mark(Kind::Commit, &sk);
        self.mark(Kind::Repo, &d.repo.clone());
        let app = self.resolve_app(&d);
        self.mark(Kind::App, &app);
        self.mark(Kind::Stats, "fleet");
        let prs: Vec<String> = self
            .idx
            .repo_prs
            .get(&d.repo)
            .map(|x| x.iter().cloned().collect())
            .unwrap_or_default();
        for p in prs {
            if self
                .prs
                .get(&p)
                .is_some_and(|f| f.merge_sha.as_deref() == Some(d.sha.as_str()))
            {
                self.mark(Kind::Pr, &p);
            }
        }
        self.deploys.insert(key, d);
    }
}

impl Store {
    /// Drop one pipeline register and its index entries; a no-op for an unknown id.
    fn remove_pipeline(&mut self, id: &str) {
        let Some(p) = self.pipelines.remove(id) else {
            return;
        };
        let sk = sha_key(&p.repo, &p.sha);
        idx_del(&mut self.idx.sha_pipelines, &sk, id);
        let sibs: Vec<String> = self
            .idx
            .sha_pipelines
            .get(&sk)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        for s in sibs {
            self.mark(Kind::Pipeline, &s);
        }
        idx_del(&mut self.idx.repo_pipelines, &p.repo, id);
        if let Some(n) = p.pr {
            self.mark(Kind::Pr, &ids::pr(&p.repo, n));
        }
        self.mark(Kind::Pipeline, id);
        self.mark(Kind::Commit, &sk);
        self.mark(Kind::Repo, &p.repo);
        self.mark(Kind::Stats, "fleet");
        self.mark_active_pipelines(&p.repo);
    }

    fn mark_active_pipelines(&mut self, repo: &str) {
        let ids: Vec<String> = self
            .idx
            .repo_pipelines
            .get(repo)
            .into_iter()
            .flatten()
            .filter(|id| self.pipelines.get(*id).is_some_and(|p| p.state.is_active()))
            .cloned()
            .collect();
        for id in ids {
            self.mark(Kind::Pipeline, &id);
        }
    }
}

/// How a changed entity goes on the wire: the smallest of a full upsert, a merge
/// patch, or (repos) dot ops for main-line changes plus a patch for the rest.
fn delta_ops(k: Kind, id: String, old: &str, new: Arc<str>, ops: &mut Vec<OpOut>) {
    use crate::wire::{diff, dots_between};
    let full = new.len() + id.len() + 40;
    // Small entities: a patch would save little, the parse costs more.
    if new.len() < 300 {
        ops.push(OpOut::Upsert {
            kind: k,
            id,
            json: new,
        });
        return;
    }
    let (Ok(mut o), Ok(mut n)) = (
        serde_json::from_str::<serde_json::Value>(old),
        serde_json::from_str::<serde_json::Value>(&new),
    ) else {
        ops.push(OpOut::Upsert {
            kind: k,
            id,
            json: new,
        });
        return;
    };
    let mut alt: Vec<OpOut> = Vec::new();
    let mut via_dots = false;
    if k == Kind::Repo {
        let take = |v: &mut serde_json::Value| {
            v.get_mut("main")
                .and_then(|m| m.as_object_mut())
                .and_then(|m| m.remove("recent"))
        };
        if let (Some(serde_json::Value::Array(or)), Some(serde_json::Value::Array(nr))) =
            (take(&mut o), take(&mut n))
        {
            match dots_between(&or, &nr) {
                Some(dots) => {
                    via_dots = true;
                    for d in dots {
                        alt.push(OpOut::Dot {
                            id: id.clone(),
                            json: d.to_string(),
                        });
                    }
                }
                None => {
                    // Put them back: the whole line is patched.
                    o["main"]["recent"] = serde_json::Value::Array(or);
                    n["main"]["recent"] = serde_json::Value::Array(nr);
                }
            }
        }
    }
    if let Some(p) = diff(&o, &n) {
        alt.push(OpOut::Patch {
            kind: k,
            id: id.clone(),
            json: p.to_string(),
        });
    }
    let size: usize = alt
        .iter()
        .map(|op| match op {
            OpOut::Patch { json, id, .. } | OpOut::Dot { json, id } => json.len() + id.len() + 40,
            _ => 0,
        })
        .sum();
    if size < full || (via_dots && alt.is_empty()) {
        ops.extend(alt);
    } else {
        ops.push(OpOut::Upsert {
            kind: k,
            id,
            json: new,
        });
    }
}

fn median(mut v: Vec<Ms>) -> Option<Ms> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    Some(v[v.len() / 2])
}

pub fn is_bot(login: &str) -> bool {
    let l = login.to_ascii_lowercase();
    l.ends_with("[bot]")
        || l.ends_with("-bot")
        || l.contains("renovate")
        || l.contains("dependabot")
        || l.contains("autofix")
        || l == "github-actions"
        || l == "northwind-ci-bot"
}

/// Transient events for one pipeline observation (old → new).
fn pipeline_events(old: Option<&Pipeline>, p: &Pipeline, out: &mut Vec<Event>) {
    let at_now = p.finished.or(p.started).unwrap_or(p.created);
    if old.is_none() {
        out.push(Event::Enqueue {
            pipeline: p.id.clone(),
            lane: p.lane,
            repo: p.repo.clone(),
            sha: p.sha.clone(),
            at: p.created,
        });
    }
    let was_started = old.is_some_and(|o| o.state.rank() >= 2);
    if !was_started && p.state.rank() >= 2 {
        out.push(Event::Start {
            pipeline: p.id.clone(),
            engine: p.engine.clone(),
            at: p.started.unwrap_or(at_now),
        });
    }
    for w in &p.workflows {
        let ow = old.and_then(|o| o.workflows.iter().find(|x| x.name == w.name));
        for s in &w.steps {
            let os = ow.and_then(|x| x.steps.iter().find(|y| y.name == s.name));
            let changed = os.is_none_or(|o| o.state != s.state);
            if changed && s.state.rank() >= 2 {
                out.push(Event::Step {
                    pipeline: p.id.clone(),
                    workflow: w.name.clone(),
                    step: s.name.clone(),
                    state: s.state,
                    at: s.finished.or(s.started).unwrap_or(at_now),
                });
            }
        }
    }
    let was_done = old.is_some_and(|o| o.state.is_done());
    if !was_done && p.state.is_done() {
        out.push(Event::Finish {
            pipeline: p.id.clone(),
            state: p.state,
            at: p.finished.unwrap_or(at_now),
            culprit: false,
        });
    }
}

// ----------------------------------------------------------------------
// derive + flush
// ----------------------------------------------------------------------

fn to_json<T: Serialize>(v: &T) -> Arc<str> {
    Arc::from(serde_json::to_string(v).expect("serialize entity"))
}

impl Store {
    /// Everything time-dependent (heat, staleness, visibility windows, GC) is
    /// recomputed here; call it every few seconds with the wall clock.
    pub fn tick(&mut self, now: Ms) {
        self.now = self.now.max(now);
        self.gc(now);
        self.insights_dirty = true;
        self.sample_gauges(self.now);
        // Visibility windows and heat depend on time: re-derive what can change.
        let repos: Vec<String> = self.repos_t.keys().cloned().collect();
        for r in repos {
            self.mark(Kind::Repo, &r);
        }
        let ps: Vec<String> = self.tables[Kind::Pipeline.index()]
            .keys()
            .cloned()
            .collect();
        for p in ps {
            self.mark(Kind::Pipeline, &p);
        }
        let cs: Vec<String> = self.tables[Kind::Commit.index()].keys().cloned().collect();
        for c in cs {
            self.mark(Kind::Commit, &c);
        }
        let prs: Vec<String> = self.tables[Kind::Pr.index()].keys().cloned().collect();
        for p in prs {
            self.mark(Kind::Pr, &p);
        }
        let ds: Vec<String> = self.tables[Kind::Deploy.index()].keys().cloned().collect();
        for d in ds {
            self.mark(Kind::Deploy, &d);
        }
        self.mark(Kind::Stats, "fleet");
    }

    /// Mark every derivable key dirty (used by tests to prove that incremental
    /// flushes equal a full recompute).
    pub fn mark_all(&mut self) {
        let mut keys: Vec<(Kind, String)> = Vec::new();
        for k in Kind::ALL {
            keys.extend(self.tables[k.index()].keys().map(|x| (k, x.clone())));
        }
        for l in self.repo_lists.values() {
            keys.extend(l.repos.iter().map(|r| (Kind::Repo, r.id.clone())));
        }
        for (r, ks) in &self.idx.repo_commits {
            keys.push((Kind::Repo, r.clone()));
            keys.extend(ks.iter().map(|c| (Kind::Commit, c.clone())));
        }
        keys.extend(self.pipelines.keys().map(|c| (Kind::Pipeline, c.clone())));
        keys.extend(self.prs.keys().map(|c| (Kind::Pr, c.clone())));
        keys.extend(
            self.deploys
                .values()
                .map(|d| (Kind::Deploy, sha_key(&d.repo, &d.sha))),
        );
        keys.extend(self.health.keys().map(|c| (Kind::App, c.clone())));
        if let Some(a) = &self.app_list {
            keys.extend(a.apps.iter().map(|x| (Kind::App, x.id.clone())));
        }
        for e in self.engine_lists.values() {
            keys.extend(e.engines.iter().map(|x| (Kind::Engine, x.id.clone())));
        }
        if let Some(l) = &self.lanes {
            keys.extend(l.lanes.iter().map(|x| (Kind::Lane, x.id.clone())));
        }
        if let Some(q) = &self.queue {
            keys.push((Kind::Queue, q.queue.id.clone()));
        }
        keys.push((Kind::Watcher, "outage".into()));
        keys.push((Kind::Stats, "fleet".into()));
        for o in self.cfg.orgs.clone() {
            keys.push((Kind::Org, o));
        }
        let repo_orgs: Vec<String> = keys
            .iter()
            .filter(|(k, _)| *k == Kind::Repo)
            .map(|(_, id)| split_repo(id).0.to_string())
            .collect();
        for o in repo_orgs {
            keys.push((Kind::Org, o));
        }
        for (k, id) in keys {
            if !k.is_insight() {
                self.mark(k, &id);
            }
        }
        self.insights_dirty = true;
        self.trends_dirty = true;
        self.trends_at = 0;
    }

    fn gc(&mut self, now: Ms) {
        let cut = now - RETAIN_MS;
        let pipes = &self.pipelines;
        self.step_errors
            .retain(|_, e| pipes.contains_key(&e.pipeline));
        let rcut = now - insights::ROLLUP_KEEP_MS;
        self.rollups.retain(|h, _| *h >= rcut);
        self.gauges.retain(|h, _| *h >= now - 26 * H);
        let dead: Vec<String> = self
            .pipelines
            .iter()
            .filter(|(_, p)| {
                !p.state.is_active() && p.finished.unwrap_or(p.created).max(p.created) < cut
            })
            .map(|(k, _)| k.clone())
            .collect();
        for id in dead {
            self.remove_pipeline(&id);
        }
        let dead: Vec<String> = self
            .commits
            .iter()
            .filter(|(k, c)| c.best.at < cut && !self.idx.sha_pipelines.contains_key(*k))
            .map(|(k, _)| k.clone())
            .collect();
        for k in dead {
            if let Some(c) = self.commits.remove(&k) {
                idx_del(&mut self.idx.repo_commits, &c.best.repo, &k);
                self.mark(Kind::Commit, &k);
                self.mark(Kind::Repo, &c.best.repo);
            }
        }
        // Commits known only through pipelines that were all collected.
        let orphans: Vec<(String, String)> = self
            .idx
            .repo_commits
            .iter()
            .flat_map(|(r, ks)| ks.iter().map(move |k| (r.clone(), k.clone())))
            .filter(|(_, k)| {
                !self.commits.contains_key(k) && !self.idx.sha_pipelines.contains_key(k)
            })
            .collect();
        for (r, k) in orphans {
            idx_del(&mut self.idx.repo_commits, &r, &k);
            self.mark(Kind::Commit, &k);
            self.mark(Kind::Repo, &r);
        }
        let dead: Vec<String> = self
            .statuses
            .iter()
            .filter(|(_, s)| s.at < cut)
            .map(|(k, _)| k.clone())
            .collect();
        for k in dead {
            if let Some(s) = self.statuses.remove(&k) {
                let sk = sha_key(&s.repo, &s.sha);
                idx_del(&mut self.idx.sha_statuses, &sk, &k);
                self.mark(Kind::Commit, &sk);
            }
        }
        let dead: Vec<String> = self
            .prs
            .iter()
            .filter(|(_, p)| {
                p.state != PrState::Open && p.updated.max(p.merged_at.unwrap_or(0)) < cut
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in dead {
            if let Some(p) = self.prs.remove(&k) {
                idx_del(&mut self.idx.sha_prs, &sha_key(&p.repo, &p.head_sha), &k);
                idx_del(&mut self.idx.repo_prs, &p.repo, &k);
                self.mark(Kind::Pr, &k);
                self.mark(Kind::Repo, &p.repo);
            }
        }
        // Deploys: keep the newest per app forever (App.last_deploy), drop the rest when old.
        let mut newest: FxHashMap<String, (Ms, String)> = FxHashMap::default();
        for d in self.deploys.values() {
            let sk = sha_key(&d.repo, &d.sha);
            let e = newest
                .entry(d.repo.clone())
                .or_insert((d.started, sk.clone()));
            if (d.started, &sk) > (e.0, &e.1) {
                *e = (d.started, sk);
            }
        }
        let keep: BTreeSet<String> = newest.into_values().map(|(_, k)| k).collect();
        let dead: Vec<String> = self
            .deploys
            .iter()
            .filter(|(_, d)| d.started < cut && !keep.contains(&sha_key(&d.repo, &d.sha)))
            .map(|(k, _)| k.clone())
            .collect();
        for k in dead {
            if let Some(d) = self.deploys.remove(&k) {
                let sk = sha_key(&d.repo, &d.sha);
                idx_del(&mut self.idx.sha_deploys, &sk, &k);
                self.mark(Kind::Deploy, &sk);
            }
        }
    }

    /// Recompute every dirty derived entity at time `now` and return the ops
    /// (upserts/removes for what changed, then the transient events).
    pub fn flush(&mut self, now: Ms) -> Vec<OpOut> {
        self.flush_with(now, true)
    }

    /// [`Store::flush`], leaving the Factory Floor tables pending when `insights` is
    /// false (they read the whole fleet: the reducer refreshes them at most once a second
    /// while entities change at up to 30 frames/s).
    pub fn flush_with(&mut self, now: Ms, insights: bool) -> Vec<OpOut> {
        self.now = self.now.max(now);
        let now = self.now;
        let mut ops: Vec<OpOut> = Vec::new();
        let mut derived_events: Vec<Event> = Vec::new();
        // Order matters only for dependencies between derived kinds:
        // deploy → app/commit; commit → repo; pipeline/queue; pr; then aggregates.
        let order = [
            Kind::Deploy,
            Kind::Pipeline,
            Kind::Commit,
            Kind::Pr,
            Kind::Lane,
            Kind::Repo,
            Kind::App,
            Kind::Engine,
            Kind::Queue,
            Kind::Watcher,
            Kind::Org,
            Kind::Stats,
        ];
        // Repos are needed by apps (main_sha), so collect app dirtiness from repos.
        for k in order {
            loop {
                let keys = std::mem::take(&mut self.dirty[k.index()]);
                if keys.is_empty() {
                    break;
                }
                for id in keys {
                    let mut touched = false;
                    let json = self.derive(k, &id, now, &mut derived_events);
                    let table = &mut self.tables[k.index()];
                    match json {
                        Some(j) => match table.get(&id) {
                            Some(cur) if **cur == *j => {}
                            Some(cur) => {
                                let old = cur.clone();
                                table.insert(id.clone(), j.clone());
                                delta_ops(k, id, &old, j, &mut ops);
                                touched = true;
                            }
                            None => {
                                table.insert(id.clone(), j.clone());
                                ops.push(OpOut::Upsert {
                                    kind: k,
                                    id,
                                    json: j,
                                });
                                touched = true;
                            }
                        },
                        None => {
                            if table.remove(&id).is_some() {
                                ops.push(OpOut::Remove { kind: k, id });
                                touched = true;
                            }
                        }
                    }
                    // Groups, clusters and trends read repos, PRs, deploys and pipelines.
                    if touched && matches!(k, Kind::Repo | Kind::Pr | Kind::Deploy | Kind::Pipeline)
                    {
                        self.insights_dirty = true;
                        self.trends_dirty = true;
                    }
                }
            }
        }
        if insights {
            self.flush_insights(now, &mut ops);
        }
        if !ops.is_empty() {
            self.version += 1;
        }
        let mut evs = std::mem::take(&mut self.events);
        evs.extend(derived_events);
        ops.extend(evs.into_iter().map(OpOut::Event));
        ops
    }

    fn derive(&mut self, k: Kind, id: &str, now: Ms, ev: &mut Vec<Event>) -> Option<Arc<str>> {
        match k {
            Kind::Deploy => {
                let d = self.derive_deploy(id, now);
                let old = self.deploys_t.get(id);
                if let Some(n) = &d
                    && (old.is_some_and(|o| o.state != n.state)
                        || (old.is_none() && n.started > now - 10 * 60_000))
                {
                    ev.push(Event::Deploy {
                        app: n.app.clone(),
                        sha: n.sha.clone(),
                        state: n.state,
                        via: n.via,
                        at: n.finished.unwrap_or(n.started),
                    });
                }
                let j = d.as_ref().map(to_json);
                match d {
                    Some(d) => {
                        self.mark(Kind::App, &d.app.clone());
                        self.deploys_t.insert(id.to_string(), d);
                    }
                    None => {
                        if let Some(o) = self.deploys_t.remove(id) {
                            self.mark(Kind::App, &o.app);
                        }
                    }
                }
                j
            }
            Kind::Pipeline => self.derive_pipeline(id, now).map(|p| to_json(&p)),
            Kind::Commit => {
                let c = self.derive_commit(id, now);
                let j = c.as_ref().map(to_json);
                match c {
                    Some(c) => {
                        self.commits_t.insert(id.to_string(), c);
                    }
                    None => {
                        self.commits_t.remove(id);
                    }
                }
                j
            }
            Kind::Pr => {
                let p = self.derive_pr(id, now);
                let old = self.prs_t.get(id);
                if let (Some(o), Some(n)) = (old, &p)
                    && o.phase != n.phase
                {
                    ev.push(Event::Pr {
                        repo: n.repo.clone(),
                        number: n.number,
                        phase: n.phase,
                        at: now,
                    });
                    if n.phase == PrPhase::Merged && o.phase != PrPhase::Deployed {
                        ev.push(Event::Merge {
                            repo: n.repo.clone(),
                            number: n.number,
                            sha: n.merge_sha.clone().unwrap_or_default(),
                            at: n.merged_at.unwrap_or(n.updated),
                        });
                    }
                }
                let j = p.as_ref().map(to_json);
                match p {
                    Some(p) => {
                        self.prs_t.insert(id.to_string(), p);
                    }
                    None => {
                        self.prs_t.remove(id);
                    }
                }
                j
            }
            Kind::Repo => {
                let r = self.derive_repo(id, now);
                let old = self.repos_t.get(id);
                if let (Some(o), Some(n)) = (old, &r)
                    && o.main.state != n.main.state
                    && n.main.state.is_done()
                    && o.main.state != CiState::None
                {
                    ev.push(Event::Main {
                        repo: n.id.clone(),
                        from: o.main.state,
                        to: n.main.state,
                        culprit: n.main.culprit.clone(),
                        at: now,
                    });
                }
                let appeared = old.is_none() != r.is_none();
                let main_moved = match (&r, old) {
                    (Some(n), Some(o)) => {
                        o.main.head != n.main.head
                            || o.main.recent != n.main.recent
                            || o.app != n.app
                    }
                    (Some(_), None) => true,
                    _ => false,
                };
                if appeared {
                    let org = split_repo(id).0.to_string();
                    self.mark(Kind::Org, &org);
                }
                let j = r.as_ref().map(to_json);
                match r {
                    Some(r) => {
                        if let (Some(a), true) = (&r.app, main_moved) {
                            self.mark(Kind::App, &a.clone());
                        }
                        self.repos_t.insert(id.to_string(), r);
                    }
                    None => {
                        self.repos_t.remove(id);
                    }
                }
                j
            }
            Kind::App => {
                let a = self.derive_app(id);
                let old = self.apps_t.get(id);
                if let (Some(o), Some(n)) = (old, &a)
                    && o.health != n.health
                {
                    ev.push(Event::Health {
                        app: n.id.clone(),
                        from: o.health,
                        to: n.health,
                        at: n.checked,
                    });
                }
                let j = a.as_ref().map(to_json);
                match a {
                    Some(a) => {
                        self.apps_t.insert(id.to_string(), a);
                    }
                    None => {
                        self.apps_t.remove(id);
                    }
                }
                j
            }
            Kind::Lane => self
                .lanes
                .as_ref()
                .and_then(|l| l.lanes.iter().find(|x| x.id == id))
                .map(to_json),
            Kind::Engine => {
                // Union over sources; on duplicate ids the newest observation wins.
                let mut best: Option<(&Engine, Ms)> = None;
                for l in self.engine_lists.values() {
                    for e in &l.engines {
                        if e.id == id && best.is_none_or(|(_, o)| l.observed > o) {
                            best = Some((e, l.observed));
                        }
                    }
                }
                best.map(|(e, _)| to_json(e))
            }
            Kind::Queue => self
                .queue
                .as_ref()
                .filter(|q| q.queue.id == id)
                .map(|q| to_json(&q.queue)),
            Kind::Watcher => self.watcher.as_ref().map(|w| to_json(&w.watcher)),
            Kind::Org => {
                let n = self
                    .repos_t
                    .keys()
                    .filter(|r| split_repo(r).0 == id)
                    .count() as u32;
                if n == 0 && !self.cfg.orgs.iter().any(|o| o == id) {
                    None
                } else {
                    Some(to_json(&Org {
                        id: id.to_string(),
                        repos: n,
                    }))
                }
            }
            Kind::Stats => Some(to_json(&self.derive_stats(now))),
            // Computed together by `insights` (see `flush`), never through `derive`.
            Kind::Group | Kind::Cluster | Kind::Flake | Kind::Trend => {
                self.tables[k.index()].get(id).cloned()
            }
        }
    }

    // ---- per-kind derivations (pure functions of the registers + now) ----

    /// The app a deploy belongs to: explicit, else the apps list's app for the
    /// repo, else the repo's name.
    pub fn resolve_app(&self, d: &DeployFact) -> String {
        if !d.app.is_empty() {
            return d.app.clone();
        }
        self.app_for_repo(&d.repo)
            .unwrap_or_else(|| split_repo(&d.repo).1.to_ascii_lowercase())
    }

    pub fn app_for_repo(&self, repo: &str) -> Option<String> {
        self.app_list.as_ref().and_then(|l| {
            l.apps
                .iter()
                .filter(|a| a.repo.as_deref() == Some(repo))
                .map(|a| a.id.clone())
                .min()
        })
    }

    fn repo_meta(&self, id: &str) -> Option<(String, Option<u64>, bool)> {
        // GitHub's default branch beats Woodpecker's; sources iterate in key order.
        let mut branch: Option<(u8, String)> = None;
        let mut wid = None;
        let mut archived = false;
        for (src, l) in &self.repo_lists {
            if let Some(r) = l.repos.iter().find(|r| r.id == id) {
                let prio = if src.starts_with("github") { 2 } else { 1 };
                if branch.as_ref().is_none_or(|(p, _)| prio > *p) && !r.default_branch.is_empty() {
                    branch = Some((prio, r.default_branch.clone()));
                }
                if r.woodpecker_id.is_some() {
                    wid = r.woodpecker_id;
                }
                archived |= r.archived;
            }
        }
        let known = branch.is_some();
        if !known
            && !self.idx.repo_commits.contains_key(id)
            && !self.idx.repo_pipelines.contains_key(id)
        {
            return None;
        }
        Some((
            branch.map(|b| b.1).unwrap_or_else(|| "main".into()),
            wid,
            archived,
        ))
    }

    /// Combined CI state of one commit from its pipelines, GitHub runs and statuses.
    pub fn commit_ci(&self, repo: &str, sha: &str) -> CiState {
        let sk = sha_key(repo, sha);
        let mut states: Vec<CiState> = Vec::new();
        let mut has_wp = false;
        if let Some(ps) = self.idx.sha_pipelines.get(&sk) {
            // Latest run per (lane, event, deploy-ness): reruns supersede. A manual run
            // of a commit is a rerun of its push pipeline (the same config on the same
            // sha), so the newer of the two decides: a passing manual rerun clears an
            // older failed push run, and a failing one turns a green push red.
            let mut latest: BTreeMap<(u8, u8, bool), (u64, CiState)> = BTreeMap::new();
            for id in ps {
                if let Some(p) = self.pipelines.get(id) {
                    if p.lane == LaneKind::Roadrunner {
                        has_wp = true;
                    }
                    // A manual run carries no deploy flag (only push runs deploy), so its
                    // deploy-ness is whether it runs a deploy workflow, as a push run's is.
                    let (event, deploy) = match p.event {
                        PipelineEvent::Manual => (
                            PipelineEvent::Push,
                            p.deploy
                                || p.workflows
                                    .iter()
                                    .any(|w| w.name.to_ascii_lowercase().contains("deploy")),
                        ),
                        e => (e, p.deploy),
                    };
                    let key = (p.lane as u8, event as u8, deploy);
                    let e = latest.entry(key).or_insert((p.number, p.state));
                    if p.number >= e.0 {
                        *e = (p.number, p.state);
                    }
                }
            }
            states.extend(latest.values().map(|(_, s)| *s));
        }
        if let Some(ss) = self.idx.sha_statuses.get(&sk) {
            // Without its pipelines (older than the fetch window) a Roadrunner commit
            // reads from its statuses, one per event and workflow
            // (ci/woodpecker/<event>/<workflow>): the same rule, the newer of a push
            // and a manual run's status for one workflow counts.
            let mut wp: BTreeMap<&str, (Ms, CiState)> = BTreeMap::new();
            for k in ss {
                if let Some(s) = self.statuses.get(k) {
                    if s.context.starts_with("ci/woodpecker") {
                        if has_wp {
                            continue;
                        }
                        let wf = s
                            .context
                            .strip_prefix("ci/woodpecker/push/")
                            .or_else(|| s.context.strip_prefix("ci/woodpecker/manual/"));
                        if let Some(wf) = wf {
                            let e = wp.entry(wf).or_insert((s.at, s.state));
                            if s.at >= e.0 {
                                *e = (s.at, s.state);
                            }
                            continue;
                        }
                    }
                    states.push(s.state);
                }
            }
            states.extend(wp.values().map(|(_, s)| *s));
        }
        combine_states(states)
    }

    /// The deploy of one commit, combined over every source that reported it.
    /// A Roadrunner deploy workflow alone does not prove a deploy when GitHub
    /// Actions owns the repo's deploys (its step is then a no-op).
    pub fn combined_deploy(&self, repo: &str, sha: &str) -> Option<Deploy> {
        let sk = sha_key(repo, sha);
        let regs: Vec<&DeployFact> = self
            .idx
            .sha_deploys
            .get(&sk)?
            .iter()
            .filter_map(|k| self.deploys.get(k))
            .collect();
        if regs.is_empty() {
            return None;
        }
        let real: Vec<&&DeployFact> = regs.iter().filter(|d| d.source != "wp").collect();
        let lane = self
            .lanes
            .as_ref()
            .and_then(|l| l.lanes.iter().find(|x| x.id == repo));
        let gha_owns = lane.is_some_and(|l| l.mode == LaneMode::GhaFirst || l.fallback);
        let pick = |ds: &[&&DeployFact]| -> Option<DeployState> {
            let has = |s: DeployState| ds.iter().any(|d| d.state == s);
            if has(DeployState::Success) {
                Some(DeployState::Success)
            } else if has(DeployState::Failure) {
                Some(DeployState::Failure)
            } else if has(DeployState::Running) {
                Some(DeployState::Running)
            } else if has(DeployState::Pending) {
                Some(DeployState::Pending)
            } else {
                None
            }
        };
        let all: Vec<&&DeployFact> = regs.iter().collect();
        let (state, via_from): (DeployState, Vec<&&DeployFact>) = if !real.is_empty() {
            (pick(&real)?, real.clone())
        } else {
            let st = pick(&all)?;
            if gha_owns && st == DeployState::Success {
                return None;
            }
            (st, all.clone())
        };
        let via = via_from
            .iter()
            .filter(|d| d.state == state)
            .map(|d| d.via)
            .min_by_key(|v| match v {
                DeployVia::GhaFallback => 0,
                DeployVia::Gha => 1,
                DeployVia::Roadrunner => 2,
                DeployVia::Manual => 3,
            })
            .unwrap_or(DeployVia::Roadrunner);
        let started = regs.iter().map(|d| d.started).min().unwrap_or(0);
        let finished = if state == DeployState::Success || state == DeployState::Failure {
            regs.iter().filter_map(|d| d.finished).max()
        } else {
            None
        };
        let app = regs
            .iter()
            .find(|d| !d.app.is_empty())
            .map(|d| d.app.clone())
            .unwrap_or_default();
        let wp = regs.iter().find(|d| d.source == "wp");
        Some(Deploy {
            id: sk.clone(),
            app: self.resolve_app(&DeployFact {
                app,
                repo: repo.to_string(),
                sha: sha.to_string(),
                via,
                state,
                started,
                finished,
                pipeline: None,
                url: None,
                source: String::new(),
            }),
            repo: repo.to_string(),
            sha: sha.to_string(),
            via,
            state,
            started,
            finished,
            pipeline: wp
                .and_then(|d| d.pipeline.clone())
                .or_else(|| regs.iter().find_map(|d| d.pipeline.clone())),
            url: regs.iter().find_map(|d| d.url.clone()),
            links: Default::default(),
        })
        .map(|mut d| {
            d.links = self.deploy_links(&d);
            d
        })
    }

    /// (Woodpecker repo id, number) of a `wp:` pipeline, from its own Woodpecker URL
    /// (`…/repos/{id}/pipeline/{n}`): a function of the pipeline alone, so links never
    /// depend on which fact arrived first.
    fn wp_run_of(&self, pipeline: &str, url: Option<&str>) -> Option<(u64, u64)> {
        let n: u64 = pipeline
            .strip_prefix("wp:")?
            .rsplit(':')
            .next()?
            .parse()
            .ok()?;
        let u = url?;
        let i = u.find("/repos/")? + "/repos/".len();
        let mut parts = u[i..].split('/');
        let rid = parts.next()?.parse().ok()?;
        (parts.next() == Some("pipeline") && parts.next()?.parse::<u64>().ok()? == n)
            .then_some((rid, n))
    }

    fn deploy_links(&self, d: &Deploy) -> DeployLinks {
        let cicd = d
            .pipeline
            .as_deref()
            .and_then(|p| self.wp_run_of(p, d.url.as_deref()))
            .map(|(rid, n)| crate::links::rr_run(rid, n));
        let app = self
            .app_list
            .as_ref()
            .and_then(|l| l.apps.iter().find(|a| a.id == d.app))
            .map(|a| a.url.clone())
            .filter(|u| !u.is_empty());
        DeployLinks {
            cicd,
            commit: (!d.sha.is_empty()).then(|| crate::links::gh_commit(&d.repo, &d.sha)),
            app,
        }
    }

    fn pipeline_links(&self, p: &Pipeline) -> PipelineLinks {
        use crate::links as l;
        let mut out = PipelineLinks::default();
        if p.id.starts_with("wp:") {
            if let Some((rid, n)) = self.wp_run_of(&p.id, Some(&p.url)) {
                out.cicd = Some(l::rr_run(rid, n));
                out.woodpecker = Some(l::wp_run(rid, n));
            }
        } else if let Some(run) = p.id.strip_prefix("gha:").and_then(|r| r.parse().ok()) {
            out.github = Some(l::gh_run(&p.repo, run));
        }
        if !p.sha.is_empty() {
            out.commit = Some(l::gh_commit(&p.repo, &p.sha));
        }
        if let Some(t) = p.git_ref.as_deref().filter(|t| !t.is_empty()) {
            out.release = Some(l::gh_release(&p.repo, t));
        } else if p.event != PipelineEvent::Tag
            && !p.branch.is_empty()
            && !p.branch.starts_with("pull/")
        {
            out.branch = Some(l::gh_branch(&p.repo, &p.branch));
        }
        if let Some(n) = p.pr {
            out.pr = Some(l::gh_pr(&p.repo, n));
        }
        out
    }

    fn derive_deploy(&self, id: &str, now: Ms) -> Option<Deploy> {
        let (repo, sha) = id.split_once('@')?;
        let d = self.combined_deploy(repo, sha)?;
        if d.started < now - VISIBLE_MS {
            return None;
        }
        Some(d)
    }

    /// Durations (started → finished) of a repo's successful runs finished in the last
    /// 24 h that match `keep`, newest first, at most `n`.
    fn recent_durations(
        &self,
        repo: &str,
        now: Ms,
        n: usize,
        keep: impl Fn(&Pipeline) -> bool,
    ) -> Vec<Ms> {
        let mut runs: Vec<(Ms, &str, Ms)> = self
            .idx
            .repo_pipelines
            .get(repo)
            .into_iter()
            .flatten()
            .filter_map(|id| self.pipelines.get(id))
            .filter(|p| p.state == CiState::Success && keep(p))
            .filter_map(|p| {
                let (s, f) = (p.started?, p.finished?);
                (f >= s && f >= now - 24 * H).then_some((f, p.id.as_str(), f - s))
            })
            .collect();
        runs.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
        runs.into_iter().take(n).map(|r| r.2).collect()
    }

    fn derive_pipeline(&self, id: &str, now: Ms) -> Option<Pipeline> {
        let p = self.pipelines.get(id)?;
        let visible = p.state.is_active()
            || p.finished.unwrap_or(p.created).max(p.created) >= now - PIPELINE_VISIBLE_MS;
        if !visible {
            return None;
        }
        let mut p = p.clone();
        p.queue_pos = None;
        p.expected_ms = None;
        p.links = Box::new(self.pipeline_links(&p));
        self.mark_failures(&mut p);
        if p.state.is_active() {
            let (event, deploy) = (p.event, p.deploy);
            let d = self.recent_durations(&p.repo, now, 20, |x| {
                x.event == event && x.deploy == deploy && x.lane == p.lane
            });
            p.expected_ms = median(d);
        }
        if p.state.rank() == 1
            && let Some(q) = &self.queue
            && let Some(i) = q.queue.items.iter().position(|x| x == id)
        {
            p.queue_pos = Some(i as u32 + 1);
        }
        Some(p)
    }

    /// What we know about one commit: the best description over the commit
    /// facts and the current pipeline registers, and every branch it was seen on.
    pub fn commit_view(&self, key: &str) -> Option<(CommitFact, BTreeSet<String>)> {
        let reg = self.commits.get(key);
        let mut best: Option<CommitFact> = reg.map(|r| r.best.clone());
        let mut branches: BTreeSet<String> = reg.map(|r| r.branches.clone()).unwrap_or_default();
        for pid in self.idx.sha_pipelines.get(key).into_iter().flatten() {
            let Some(p) = self.pipelines.get(pid) else {
                continue;
            };
            if p.sha.is_empty() {
                continue;
            }
            let pr = p.event == PipelineEvent::PullRequest;
            // A PR run's branch is the PR's head branch; if the adapter only knew the
            // target (the default branch), it must not put the commit "on main".
            let head_known =
                !p.branch.is_empty() && self.repo_meta(&p.repo).is_none_or(|m| m.0 != p.branch);
            let c = CommitFact {
                repo: p.repo.clone(),
                sha: p.sha.clone(),
                branch: if pr && !head_known {
                    p.pr.map(|n| format!("pull/{n}")).unwrap_or_default()
                } else {
                    p.branch.clone()
                },
                title: p.title.clone().unwrap_or_default(),
                author: p.author.clone().unwrap_or_default(),
                bot: p.author.as_deref().is_some_and(is_bot),
                at: p.created,
                prio: if pr { 0 } else { 1 },
            };
            branches.insert(c.branch.clone());
            // Within a source priority the FIRST observation describes the commit (a
            // rerun must not move it later); order-independent: the minimum `at`.
            let key = |x: &CommitFact| (x.prio, std::cmp::Reverse(x.at), content_hash(x));
            if best.as_ref().is_none_or(|b| key(b) < key(&c)) {
                best = Some(c);
            }
        }
        best.map(|b| (b, branches))
    }

    fn derive_commit(&self, id: &str, now: Ms) -> Option<Commit> {
        let (best, branches) = self.commit_view(id)?;
        let reg = CommitReg { best, branches };
        let c = &reg.best;
        let pipes: Vec<String> = self
            .idx
            .sha_pipelines
            .get(id)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        let active = pipes
            .iter()
            .any(|p| self.pipelines.get(p).is_some_and(|x| x.state.is_active()));
        if c.at < now - VISIBLE_MS && !active {
            return None;
        }
        let default_branch = self
            .repo_meta(&c.repo)
            .map(|m| m.0)
            .unwrap_or_else(|| "main".into());
        let on_default = reg.branches.contains(&default_branch);
        let prs: Vec<&PrFact> = self
            .idx
            .sha_prs
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|k| self.prs.get(k))
            .collect();
        let pr = prs.iter().map(|p| p.number).min().or_else(|| {
            pipes
                .iter()
                .filter_map(|id| self.pipelines.get(id))
                .filter_map(|p| p.pr)
                .min()
        });
        let branch = if on_default {
            default_branch.clone()
        } else if let Some(b) = reg
            .branches
            .iter()
            .find(|b| !b.is_empty() && !b.starts_with("pull/"))
        {
            b.clone()
        } else if let Some(p) = prs.iter().min_by_key(|p| p.number) {
            p.head.clone()
        } else {
            reg.branches.iter().next().cloned().unwrap_or_default()
        };
        let ci = self.commit_ci(&c.repo, &c.sha);
        let deploy = self.combined_deploy(&c.repo, &c.sha);
        let merged_pr = self
            .idx
            .repo_prs
            .get(&c.repo)
            .into_iter()
            .flatten()
            .filter_map(|k| self.prs.get(k))
            .any(|p| p.state == PrState::Merged && prs.iter().any(|x| x.number == p.number));
        // A queued deploy workflow (waiting on `ci`) is not a deploy yet: until it runs,
        // the commit is still where its CI is.
        let deploy_stage = deploy.as_ref().and_then(|d| match d.state {
            DeployState::Running => Some(Stage::Deploying),
            DeployState::Pending => (!ci.is_active()).then_some(Stage::Deploying),
            DeployState::Success => Some(Stage::Deployed),
            DeployState::Failure => Some(Stage::Failed),
        });
        let stage = if let Some(st) = deploy_stage {
            st
        } else {
            match ci {
                CiState::Pending | CiState::Blocked => Stage::Queued,
                CiState::Running => Stage::Building,
                CiState::Failure | CiState::Error => Stage::Failed,
                CiState::Success | CiState::Skipped | CiState::Canceled => {
                    if on_default {
                        Stage::Done
                    } else if merged_pr {
                        Stage::Merged
                    } else if pr.is_some() {
                        Stage::Gating
                    } else {
                        Stage::Done
                    }
                }
                CiState::None => {
                    if c.at > now - 15 * 60_000 {
                        Stage::Pushed
                    } else {
                        Stage::Done
                    }
                }
            }
        };
        let links = CommitLinks {
            commit: crate::links::gh_commit(&c.repo, &c.sha),
            branch: (!branch.is_empty() && !branch.starts_with("pull/"))
                .then(|| crate::links::gh_branch(&c.repo, &branch)),
            pr: pr.map(|n| crate::links::gh_pr(&c.repo, n)),
        };
        Some(Commit {
            id: id.to_string(),
            repo: c.repo.clone(),
            sha: c.sha.clone(),
            title: c.title.clone(),
            author: c.author.clone(),
            bot: c.bot,
            at: c.at,
            pr,
            stage,
            ci,
            links,
            branch,
            pipelines: pipes,
            deploy: deploy.map(|d| DeployRef {
                id: d.id.clone(),
                state: d.state,
            }),
        })
    }

    /// The PR's checks with each `ci/woodpecker/<event>/<workflow>` status replaced by the
    /// live Roadrunner run of the head (GitHub's rollup lags the event stream).
    fn live_checks(&self, p: &PrFact) -> Vec<Check> {
        let sk = sha_key(&p.repo, &p.head_sha);
        let mut latest: Option<&Pipeline> = None;
        for id in self.idx.sha_pipelines.get(&sk).into_iter().flatten() {
            if let Some(x) = self.pipelines.get(id)
                && x.lane == LaneKind::Roadrunner
                && latest.is_none_or(|l| x.number > l.number)
            {
                latest = Some(x);
            }
        }
        let mut checks = p.checks.clone();
        if let Some(run) = latest {
            for c in checks.iter_mut() {
                if let Some(wf) = c
                    .name
                    .strip_prefix("ci/woodpecker/")
                    .and_then(|r| r.rsplit('/').next())
                    && let Some(w) = run.workflows.iter().find(|w| w.name == wf)
                {
                    c.state = w.state;
                }
            }
        }
        checks
    }

    fn pr_ci(&self, p: &PrFact) -> CiState {
        let pipe = self.commit_ci(&p.repo, &p.head_sha);
        let checks = combine_states(self.live_checks(p).iter().map(|c| c.state));
        // The pipelines are live; GitHub's rollup lags. Prefer live when it is active.
        if pipe.is_active() {
            return pipe;
        }
        combine_states([pipe, checks].into_iter().filter(|s| *s != CiState::None))
    }

    fn derive_pr(&self, id: &str, now: Ms) -> Option<Pr> {
        let p = self.prs.get(id)?;
        if p.state != PrState::Open && p.updated.max(p.merged_at.unwrap_or(0)) < now - VISIBLE_MS {
            return None;
        }
        let ci = self.pr_ci(p);
        let deployed = p
            .merge_sha
            .as_ref()
            .and_then(|s| self.combined_deploy(&p.repo, s))
            .is_some_and(|d| d.state == DeployState::Success);
        let review = p.review.as_deref().unwrap_or("");
        let (phase, blocked_by) = match p.state {
            PrState::Merged => (
                if deployed {
                    PrPhase::Deployed
                } else {
                    PrPhase::Merged
                },
                None,
            ),
            PrState::Closed => (PrPhase::Closed, None),
            PrState::Open => {
                if p.draft {
                    (PrPhase::Draft, None)
                } else if p.mergeable == Some(Mergeable::Conflicting) {
                    (PrPhase::Conflict, Some("merge conflict".to_string()))
                } else if ci.is_active() {
                    (PrPhase::Checks, None)
                } else if ci.is_red() {
                    let failing = self
                        .live_checks(p)
                        .iter()
                        .filter(|c| c.state.is_red())
                        .map(|c| c.name.clone())
                        .next()
                        .unwrap_or_else(|| "ci".into());
                    (PrPhase::Checks, Some(format!("failing: {failing}")))
                } else if review == "changes_requested" {
                    (PrPhase::ChangesRequested, Some("changes requested".into()))
                } else if review == "review_required" {
                    (PrPhase::Review, Some("review required".into()))
                } else {
                    (PrPhase::Mergeable, None)
                }
            }
        };
        let (checks, passed): (Vec<Check>, Vec<Check>) = self
            .pr_checks(p)
            .into_iter()
            .partition(|c| c.required || !matches!(c.state, CiState::Success | CiState::Skipped));
        let checks_passed = passed.len() as u32;
        let idle = now - p.updated;
        Some(Pr {
            id: id.to_string(),
            repo: p.repo.clone(),
            number: p.number,
            title: p.title.clone(),
            author: p.author.clone(),
            bot: p.bot,
            draft: p.draft,
            created: p.created,
            updated: p.updated,
            head_sha: p.head_sha.clone(),
            head: p.head.clone(),
            base: p.base.clone(),
            phase,
            ci,
            checks,
            checks_passed,
            review: Review {
                ai: p.ai,
                human: p.review.clone(),
            },
            merged_at: p.merged_at,
            merge_sha: p.merge_sha.clone(),
            blocked_by,
            stale_ms: (p.state == PrState::Open && idle > 72 * H).then(|| idle / H * H),
            url: p.url.clone(),
            links: PrLinks {
                checks: crate::links::gh_pr_checks(&p.repo, p.number),
                branch: (!p.head.is_empty()).then(|| crate::links::gh_branch(&p.repo, &p.head)),
            },
        })
    }

    fn derive_repo(&self, id: &str, now: Ms) -> Option<Repo> {
        let (default_branch, wid, archived) = self.repo_meta(id)?;
        if archived {
            return None;
        }
        let (org, name) = split_repo(id);
        // Live dots: commits seen on the default branch.
        let mut dots: BTreeMap<String, Dot> = BTreeMap::new();
        if let Some(h) = self.main_hist.get(id) {
            for d in &h.dots {
                dots.insert(
                    d.sha.clone(),
                    Dot {
                        culprit: false,
                        ..d.clone()
                    },
                );
            }
        }
        let mut last_activity: Ms = 0;
        let mut score = 0.0f64;
        let decay = |at: Ms| -> f64 {
            let age = (now - at).max(0) as f64 / H as f64;
            if age > 24.0 { 0.0 } else { (-age / 3.0).exp2() }
        };
        for key in self.idx.repo_commits.get(id).into_iter().flatten() {
            let Some((best, branches)) = self.commit_view(key) else {
                continue;
            };
            let reg = CommitReg { best, branches };
            let c = &reg.best;
            last_activity = last_activity.max(c.at);
            score += decay(c.at);
            if !reg.branches.contains(&default_branch) {
                continue;
            }
            let state = self.commit_ci(id, &c.sha);
            let deployed = self
                .combined_deploy(id, &c.sha)
                .is_some_and(|d| d.state == DeployState::Success);
            let prev = dots.get(&c.sha);
            dots.insert(
                c.sha.clone(),
                Dot {
                    sha: c.sha.clone(),
                    at: c.at,
                    state: if state == CiState::None {
                        prev.map(|d| d.state).unwrap_or(state)
                    } else {
                        state
                    },
                    author: if c.author.is_empty() {
                        prev.map(|d| d.author.clone()).unwrap_or_default()
                    } else {
                        c.author.clone()
                    },
                    bot: c.bot,
                    title: if c.title.is_empty() {
                        prev.map(|d| d.title.clone()).unwrap_or_default()
                    } else {
                        c.title.clone()
                    },
                    deployed: deployed || prev.is_some_and(|d| d.deployed),
                    culprit: false,
                },
            );
        }
        for pid in self.idx.repo_pipelines.get(id).into_iter().flatten() {
            if let Some(p) = self.pipelines.get(pid) {
                let t = p.finished.unwrap_or(p.started.unwrap_or(p.created));
                last_activity = last_activity.max(t);
                score += 0.5 * decay(p.created);
            }
        }
        let mut open_prs = 0u32;
        for k in self.idx.repo_prs.get(id).into_iter().flatten() {
            if let Some(p) = self.prs.get(k) {
                if p.state == PrState::Open {
                    open_prs += 1;
                }
                last_activity = last_activity.max(p.updated);
                score += 0.5 * decay(p.updated);
            }
        }
        let mut recent: Vec<Dot> = dots.into_values().collect();
        recent.sort_by(|a, b| a.at.cmp(&b.at).then(a.sha.cmp(&b.sha)));
        if recent.len() > DOTS {
            recent.drain(..recent.len() - DOTS);
        }
        // Main state = newest decided commit; culprit = oldest red of the newest red streak.
        let decided =
            |s: CiState| matches!(s, CiState::Success | CiState::Failure | CiState::Error);
        let head = recent.last().map(|d| d.sha.clone()).unwrap_or_default();
        let mut state = recent.last().map(|d| d.state).unwrap_or(CiState::None);
        let mut since = recent.last().map(|d| d.at).unwrap_or(0);
        let mut culprit = None;
        if let Some(i) = recent.iter().rposition(|d| decided(d.state)) {
            state = recent[i].state;
            let red = state.is_red();
            let mut j = i;
            let mut k = i;
            while k > 0 {
                k -= 1;
                let s = recent[k].state;
                if !decided(s) {
                    continue;
                }
                if s.is_red() != red {
                    break;
                }
                j = k;
            }
            since = recent[j].at;
            if red {
                recent[j].culprit = true;
                culprit = Some(recent[j].sha.clone());
            }
        }
        let lane = self
            .lanes
            .as_ref()
            .and_then(|l| l.lanes.iter().find(|x| x.id == id));
        let app = self.app_list.as_ref().and_then(|l| {
            l.apps
                .iter()
                .filter(|a| a.repo.as_deref() == Some(id))
                .map(|a| a.id.clone())
                .min()
        });
        // Saturating: a few events → visible warmth; a busy day → near 1.
        let heat = 1.0 - (-score / 12.0).exp();
        Some(Repo {
            id: id.to_string(),
            org: org.to_string(),
            name: name.to_string(),
            default_branch,
            lane: lane.map(|l| l.mode).unwrap_or_default(),
            lane_note: lane.and_then(|l| l.note.clone()),
            app,
            main: MainState {
                head,
                state,
                since,
                culprit,
                recent,
            },
            heat: ((heat * 20.0).round() / 20.0) as f32,
            open_prs,
            last_activity,
            p50_build_ms: median(
                self.recent_durations(id, now, 50, |x| x.event == PipelineEvent::Push),
            ),
            group: Some(self.group_of(id)),
            links: Links {
                github: crate::links::gh_repo(id),
                woodpecker: wid.map(crate::links::wp_repo),
                cicd: wid.map(crate::links::rr_repo),
            },
        })
    }

    fn derive_app(&self, id: &str) -> Option<App> {
        let meta = self
            .app_list
            .as_ref()
            .and_then(|l| l.apps.iter().find(|a| a.id == id));
        let health = self.health.get(id);
        let meta = meta?;
        // The app's deploys: the newest combined deploy of its repo's commits.
        let mut shas: BTreeSet<(String, String)> = BTreeSet::new();
        for d in self.deploys.values() {
            if self.resolve_app(d) == id {
                shas.insert((d.repo.clone(), d.sha.clone()));
            }
        }
        let combined: Vec<Deploy> = shas
            .iter()
            .filter_map(|(r, s)| self.combined_deploy(r, s))
            .collect();
        let last = combined
            .iter()
            .max_by_key(|d| (d.started, d.finished.unwrap_or(0), d.id.clone()));
        let last_ok = combined
            .iter()
            .filter(|d| d.state == DeployState::Success)
            .max_by_key(|d| (d.finished.unwrap_or(d.started), d.id.clone()));
        let live_sha = health
            .and_then(|h| h.live_sha.clone())
            .or_else(|| meta.live_sha.clone())
            .or_else(|| last_ok.map(|d| d.sha.clone()));
        let repo = meta.repo.as_ref().and_then(|r| self.repos_t.get(r));
        let main_sha = repo.map(|r| r.main.head.clone()).filter(|s| !s.is_empty());
        let behind = match (&live_sha, repo) {
            (Some(l), Some(r)) => r
                .main
                .recent
                .iter()
                .rposition(|d| d.sha.starts_with(l.as_str()) || l.starts_with(d.sha.as_str()))
                .map(|i| (r.main.recent.len() - 1 - i) as u32),
            _ => None,
        };
        Some(App {
            id: id.to_string(),
            repo: meta.repo.clone(),
            url: meta.url.clone(),
            health: health.map(|h| h.health).unwrap_or(Health::Unknown),
            latency_ms: health.and_then(|h| h.latency_ms),
            // Floored to 30 min: probes land every ~30 s and would otherwise
            // re-send every app constantly; health changes travel as events.
            checked: health
                .map(|h| h.checked - h.checked.rem_euclid(1_800_000))
                .unwrap_or(0),
            live_sha,
            main_sha,
            behind,
            last_deploy: last.map(|d| DeployRef {
                id: d.id.clone(),
                state: d.state,
            }),
            runtime: meta.runtime.clone(),
            team: meta.team.clone(),
            note: health.and_then(|h| h.note.clone()),
            status_url: meta.status_url.clone(),
            links: AppLinks {
                logs: meta.logs_url.clone(),
                repo: meta.repo.as_deref().map(crate::links::gh_repo),
            },
        })
    }

    fn derive_stats(&self, now: Ms) -> Stats {
        let day = now - VISIBLE_MS;
        let commits_24h = self
            .idx
            .repo_commits
            .values()
            .flatten()
            .filter_map(|k| self.commit_view(k))
            .filter(|(c, _)| c.at >= day)
            .count() as u32;
        let mut pipelines_24h = 0u32;
        let (mut ok, mut done) = (0u32, 0u32);
        let mut queue_ms: Vec<i64> = Vec::new();
        let mut build_ms: Vec<i64> = Vec::new();
        let (mut running, mut pending) = (0u32, 0u32);
        for p in self.pipelines.values() {
            match p.state {
                CiState::Running => running += 1,
                CiState::Pending | CiState::Blocked => pending += 1,
                _ => {}
            }
            if p.created < day {
                continue;
            }
            pipelines_24h += 1;
            if matches!(
                p.state,
                CiState::Success | CiState::Failure | CiState::Error
            ) {
                done += 1;
                if p.state == CiState::Success {
                    ok += 1;
                }
            }
            if let Some(s) = p.started {
                queue_ms.push((s - p.created).max(0));
                if let Some(f) = p.finished {
                    build_ms.push((f - s).max(0));
                }
            }
        }
        let p50 = |v: &mut Vec<i64>| -> i64 {
            if v.is_empty() {
                return 0;
            }
            v.sort_unstable();
            v[v.len() / 2]
        };
        // One deploy per commit, however many sources reported it.
        let deploys_24h = self
            .deploys
            .values()
            .filter(|d| d.started >= day)
            .map(|d| (d.repo.as_str(), d.sha.as_str()))
            .collect::<BTreeSet<_>>()
            .len() as u32;
        let apps: Vec<Health> = self
            .app_list
            .iter()
            .flat_map(|l| l.apps.iter())
            .map(|a| {
                self.health
                    .get(&a.id)
                    .map(|h| h.health)
                    .unwrap_or(Health::Unknown)
            })
            .collect();
        Stats {
            id: "fleet".into(),
            commits_24h,
            pipelines_24h,
            success_rate_24h: if done == 0 {
                0.0
            } else {
                ((ok as f64 / done as f64) * 1000.0).round() as f32 / 1000.0
            },
            p50_queue_ms: p50(&mut queue_ms),
            p50_build_ms: p50(&mut build_ms),
            deploys_24h,
            apps_up: apps.iter().filter(|h| **h == Health::Up).count() as u32,
            apps_down: apps.iter().filter(|h| **h == Health::Down).count() as u32,
            prs_open: self
                .prs
                .values()
                .filter(|p| p.state == PrState::Open)
                .count() as u32,
            running,
            pending,
        }
    }
}
