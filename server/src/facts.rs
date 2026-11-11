//! Facts: what the upstream adapters observe. The store keeps, per fact key, the
//! greatest fact under a total order (a last-writer-wins register whose "last"
//! is a lifecycle/time version, never arrival order). Merging is therefore
//! commutative, associative and idempotent, and every derived entity is a pure
//! function of the registers: any arrival order gives the same state.

use std::hash::Hasher;

use serde::{Deserialize, Serialize};

use crate::model::*;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "f", rename_all = "snake_case")]
pub enum Fact {
    /// The complete repo list of one source (`github:<org>`, `woodpecker`).
    Repos(RepoList),
    /// One commit seen on a branch (GitHub push / list-commits / a pipeline).
    Commit(CommitFact),
    /// Default-branch history for the dot line (backfill), newest last.
    MainHist(MainHist),
    /// A CI run: Woodpecker pipeline or GitHub Actions run, full current state.
    Pipeline(Pipeline),
    /// A pull request as GitHub reports it.
    Pr(PrFact),
    /// A commit status or check run on a sha (one context).
    Status(StatusFact),
    /// A deploy of an app at a sha.
    Deploy(DeployFact),
    /// The apps platform's app list.
    Apps(AppList),
    /// One health probe of one app.
    Health(HealthFact),
    /// Engines/agents/runners of one source (`woodpecker`, `cicd`, `gha`).
    Engines(EngineList),
    Queue(QueueFact),
    Lanes(LaneList),
    Watcher(WatcherFact),
    /// The failure signature of one failed step, read from its log (once per failure).
    StepError(StepErrorFact),
    /// One closed hour of trend rollups (persisted in the data dir, loaded at boot).
    Rollup(RollupFact),
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct RepoMeta {
    pub id: String,
    pub default_branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub woodpecker_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pushed_at: Option<Ms>,
    #[serde(skip_serializing_if = "is_false", default)]
    pub archived: bool,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct RepoList {
    pub source: String,
    pub observed: Ms,
    pub repos: Vec<RepoMeta>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct CommitFact {
    pub repo: String,
    pub sha: String,
    pub branch: String,
    pub title: String,
    pub author: String,
    #[serde(skip_serializing_if = "is_false", default)]
    pub bot: bool,
    pub at: Ms,
    /// Source priority: higher describes the commit better (GitHub 2 > pipeline 1).
    pub prio: u8,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct MainHist {
    pub repo: String,
    pub observed: Ms,
    pub dots: Vec<Dot>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Mergeable {
    Mergeable,
    Conflicting,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct PrFact {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    #[serde(skip_serializing_if = "is_false", default)]
    pub bot: bool,
    pub draft: bool,
    pub state: PrState,
    pub created: Ms,
    pub updated: Ms,
    pub head_sha: String,
    pub head: String,
    pub base: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mergeable: Option<Mergeable>,
    /// GitHub reviewDecision, lower-cased: approved | changes_requested | review_required.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiReview>,
    /// Checks GitHub rolls up on the head (required ones flagged).
    pub checks: Vec<Check>,
    pub url: String,
    pub observed: Ms,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct StatusFact {
    pub repo: String,
    pub sha: String,
    pub context: String,
    pub state: CiState,
    pub at: Ms,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct DeployFact {
    /// Platform app id; empty = resolve from the apps list by repo.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub app: String,
    pub repo: String,
    pub sha: String,
    pub via: DeployVia,
    pub state: DeployState,
    pub started: Ms,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Who reports it: `wp` (a Roadrunner deploy workflow; may be a no-op when
    /// GitHub Actions owns deploys), `status` (ci/failsafe-deploy), `gha`
    /// (a deploy workflow run), `cicd` (the watcher's head verdict).
    #[serde(default)]
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct AppMeta {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployed_at: Option<Ms>,
    /// The catalog's status dashboard for the app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_url: Option<String>,
    /// The catalog's logs link for the app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logs_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct AppList {
    pub observed: Ms,
    pub apps: Vec<AppMeta>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct HealthFact {
    pub app: String,
    pub health: Health,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u32>,
    pub checked: Ms,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct EngineList {
    pub source: String,
    pub observed: Ms,
    pub engines: Vec<Engine>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct QueueFact {
    pub observed: Ms,
    pub queue: Queue,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct LaneList {
    pub observed: Ms,
    pub lanes: Vec<Lane>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct WatcherFact {
    pub observed: Ms,
    pub watcher: Watcher,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct StepErrorFact {
    /// Pipeline id (`wp:<repo>:<n>`).
    pub pipeline: String,
    pub workflow: String,
    pub step: String,
    pub class: FailClass,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i32>,
    pub observed: Ms,
}

impl StepErrorFact {
    pub fn key(&self) -> String {
        step_key(&self.pipeline, &self.workflow, &self.step)
    }
}

pub fn step_key(pipeline: &str, workflow: &str, step: &str) -> String {
    format!("{pipeline}|{workflow}/{step}")
}

/// Log-bucket histogram of durations: bucket `b` holds values in
/// [1000·1.1^b, 1000·1.1^(b+1)) ms (sub-second values go to bucket 0).
pub type Hist = std::collections::BTreeMap<u16, u32>;

/// One group's numbers for one hour (pipelines bucketed by their finish time).
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Agg {
    #[serde(default)]
    pub finished: u32,
    #[serde(default)]
    pub success: u32,
    /// failure + error (canceled / skipped excluded from the pass rate).
    #[serde(default)]
    pub failed: u32,
    #[serde(default)]
    pub deploys: u32,
    #[serde(default, skip_serializing_if = "Hist::is_empty")]
    pub intake: Hist,
    #[serde(default, skip_serializing_if = "Hist::is_empty")]
    pub run: Hist,
    /// Gauges sampled during the hour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_age_ms: Option<Ms>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub red: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct ClusterSeen {
    pub n: u32,
    pub first: Ms,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct RollupFact {
    /// Start of the hour (ms, a multiple of 3,600,000).
    pub hour: Ms,
    pub fleet: Agg,
    #[serde(default)]
    pub groups: std::collections::BTreeMap<String, Agg>,
    #[serde(default)]
    pub clusters: std::collections::BTreeMap<String, ClusterSeen>,
}

/// Deterministic content hash (FxHash of the JSON): the last tie-break of every
/// version, so two different facts with equal versions still order totally.
pub fn content_hash<T: Serialize>(v: &T) -> u64 {
    let bytes = serde_json::to_vec(v).unwrap_or_default();
    let mut h = rustc_hash::FxHasher::default();
    h.write(&bytes);
    h.finish()
}

/// Version of a pipeline observation: lifecycle first, then progress, then time.
pub fn pipeline_version(p: &Pipeline) -> (u8, Ms, Ms, usize, usize, u64) {
    let mut done = 0usize;
    let mut started = 0usize;
    for w in &p.workflows {
        for s in &w.steps {
            if s.state.is_done() {
                done += 1;
            }
            if s.started.is_some() || s.state.rank() >= 2 {
                started += 1;
            }
        }
    }
    (
        p.state.rank(),
        p.finished.unwrap_or(0),
        p.started.unwrap_or(0),
        done,
        started,
        content_hash(p),
    )
}

/// Version of a deploy: a later attempt of the same app@sha wins, then lifecycle.
pub fn deploy_version(d: &DeployFact) -> (Ms, u8, Ms, u64) {
    (
        d.started,
        d.state.rank(),
        d.finished.unwrap_or(0),
        content_hash(d),
    )
}

/// Version of a commit description (the branch set is merged separately, by union).
pub fn commit_version(c: &CommitFact) -> (u8, Ms, u64) {
    (c.prio, c.at, content_hash(c))
}
