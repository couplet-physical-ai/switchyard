//! Wire model: the entities, ops, events and frames of `contract/CONTRACT.md`.
//!
//! Every entity serializes with its own `id`, so a snapshot is a set of arrays of
//! values and an op carries the same value it would have in a snapshot.

use serde::{Deserialize, Serialize};

/// Wire protocol version (`contract/CONTRACT.md`). Minor bumps are additive.
pub const PROTOCOL: &str = "0.6";

pub type Ms = i64;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Org,
    Repo,
    Commit,
    Pipeline,
    Pr,
    Deploy,
    App,
    Engine,
    Queue,
    Lane,
    Watcher,
    Stats,
    Group,
    Cluster,
    Flake,
    Trend,
}

impl Kind {
    pub const ALL: [Kind; 16] = [
        Kind::Org,
        Kind::Repo,
        Kind::Commit,
        Kind::Pipeline,
        Kind::Pr,
        Kind::Deploy,
        Kind::App,
        Kind::Engine,
        Kind::Queue,
        Kind::Lane,
        Kind::Watcher,
        Kind::Stats,
        Kind::Group,
        Kind::Cluster,
        Kind::Flake,
        Kind::Trend,
    ];
    pub const COUNT: usize = 16;

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Org => "org",
            Kind::Repo => "repo",
            Kind::Commit => "commit",
            Kind::Pipeline => "pipeline",
            Kind::Pr => "pr",
            Kind::Deploy => "deploy",
            Kind::App => "app",
            Kind::Engine => "engine",
            Kind::Queue => "queue",
            Kind::Lane => "lane",
            Kind::Watcher => "watcher",
            Kind::Stats => "stats",
            Kind::Group => "group",
            Kind::Cluster => "cluster",
            Kind::Flake => "flake",
            Kind::Trend => "trend",
        }
    }

    /// Snapshot field holding this kind (arrays, except the two singletons).
    pub fn snapshot_field(self) -> &'static str {
        match self {
            Kind::Org => "orgs",
            Kind::Repo => "repos",
            Kind::Commit => "commits",
            Kind::Pipeline => "pipelines",
            Kind::Pr => "prs",
            Kind::Deploy => "deploys",
            Kind::App => "apps",
            Kind::Engine => "engines",
            Kind::Queue => "queues",
            Kind::Lane => "lanes",
            Kind::Watcher => "watcher",
            Kind::Stats => "stats",
            Kind::Group => "groups",
            Kind::Cluster => "clusters",
            Kind::Flake => "flakes",
            Kind::Trend => "trends",
        }
    }

    /// Factory Floor kinds: computed together from the whole fleet, not per key.
    pub fn is_insight(self) -> bool {
        matches!(
            self,
            Kind::Group | Kind::Cluster | Kind::Flake | Kind::Trend
        )
    }

    pub fn singleton(self) -> bool {
        matches!(self, Kind::Watcher | Kind::Stats)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum CiState {
    Success,
    Failure,
    Running,
    Pending,
    Blocked,
    Skipped,
    Canceled,
    Error,
    #[default]
    None,
}

impl CiState {
    pub fn is_done(self) -> bool {
        matches!(
            self,
            CiState::Success
                | CiState::Failure
                | CiState::Skipped
                | CiState::Canceled
                | CiState::Error
        )
    }
    pub fn is_active(self) -> bool {
        matches!(self, CiState::Running | CiState::Pending | CiState::Blocked)
    }
    pub fn is_red(self) -> bool {
        matches!(self, CiState::Failure | CiState::Error)
    }
    /// Lifecycle rank: a later observation of the same run never moves backwards.
    pub fn rank(self) -> u8 {
        match self {
            CiState::None => 0,
            CiState::Pending | CiState::Blocked => 1,
            CiState::Running => 2,
            CiState::Success
            | CiState::Failure
            | CiState::Skipped
            | CiState::Canceled
            | CiState::Error => 3,
        }
    }
    /// Severity used when several signals describe one commit (worst wins).
    pub fn severity(self) -> u8 {
        match self {
            CiState::None => 0,
            CiState::Skipped => 1,
            CiState::Success => 2,
            CiState::Canceled => 3,
            CiState::Pending => 4,
            CiState::Blocked => 5,
            CiState::Running => 6,
            CiState::Error => 7,
            CiState::Failure => 8,
        }
    }
}

/// Combine the CI signals of one commit: anything still active → active
/// (running beats pending), else any red → failure/error, else success
/// if any success, else canceled/skipped/none.
pub fn combine_states<I: IntoIterator<Item = CiState>>(states: I) -> CiState {
    let mut any = false;
    let (
        mut running,
        mut pending,
        mut blocked,
        mut failure,
        mut error,
        mut success,
        mut canceled,
        mut skipped,
    ) = (false, false, false, false, false, false, false, false);
    for s in states {
        any = true;
        match s {
            CiState::Running => running = true,
            CiState::Pending => pending = true,
            CiState::Blocked => blocked = true,
            CiState::Failure => failure = true,
            CiState::Error => error = true,
            CiState::Success => success = true,
            CiState::Canceled => canceled = true,
            CiState::Skipped => skipped = true,
            CiState::None => {}
        }
    }
    if !any {
        return CiState::None;
    }
    if running {
        CiState::Running
    } else if pending {
        CiState::Pending
    } else if blocked {
        CiState::Blocked
    } else if failure {
        CiState::Failure
    } else if error {
        CiState::Error
    } else if success {
        CiState::Success
    } else if canceled {
        CiState::Canceled
    } else if skipped {
        CiState::Skipped
    } else {
        CiState::None
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum LaneMode {
    RoadrunnerFirst,
    GhaFirst,
    Primary,
    Ci,
    Failsafe,
    CiOnly,
    #[default]
    None,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub struct Org {
    pub id: String,
    pub repos: u32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Links {
    pub github: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub woodpecker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cicd: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Repo {
    pub id: String,
    pub org: String,
    pub name: String,
    pub default_branch: String,
    pub lane: LaneMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    pub main: MainState,
    /// 0..1 recent activity, quantized to 1/100.
    pub heat: f32,
    pub open_prs: u32,
    pub last_activity: Ms,
    /// Median duration of the repo's successful push pipelines in the last 24 h.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub p50_build_ms: Option<Ms>,
    /// The repo's group (team from the apps catalog, else its org).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group: Option<String>,
    pub links: Links,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct MainState {
    pub head: String,
    pub state: CiState,
    pub since: Ms,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub culprit: Option<String>,
    pub recent: Vec<Dot>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Dot {
    pub sha: String,
    pub at: Ms,
    pub state: CiState,
    pub author: String,
    #[serde(skip_serializing_if = "is_false", default)]
    pub bot: bool,
    pub title: String,
    #[serde(skip_serializing_if = "is_false", default)]
    pub deployed: bool,
    #[serde(skip_serializing_if = "is_false", default)]
    pub culprit: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Pushed,
    Queued,
    Building,
    Gating,
    Merged,
    Deploying,
    Deployed,
    Failed,
    Done,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Commit {
    pub id: String,
    pub repo: String,
    pub sha: String,
    pub branch: String,
    pub title: String,
    pub author: String,
    #[serde(skip_serializing_if = "is_false", default)]
    pub bot: bool,
    pub at: Ms,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<u64>,
    pub stage: Stage,
    pub ci: CiState,
    pub pipelines: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deploy: Option<DeployRef>,
    #[serde(default, skip_serializing_if = "CommitLinks::is_empty")]
    pub links: CommitLinks,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct CommitLinks {
    /// The commit on GitHub.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub commit: String,
    /// Its branch on GitHub (absent for `pull/N` pseudo-branches).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Its PR on GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<String>,
}

impl CommitLinks {
    pub fn is_empty(&self) -> bool {
        *self == CommitLinks::default()
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum LaneKind {
    Roadrunner,
    Gha,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PipelineEvent {
    Push,
    PullRequest,
    Tag,
    Cron,
    Manual,
    Deployment,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Pipeline {
    pub id: String,
    pub lane: LaneKind,
    pub repo: String,
    pub number: u64,
    pub sha: String,
    pub branch: String,
    /// Tag runs: the tag.
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    pub event: PipelineEvent,
    pub state: CiState,
    pub created: Ms,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_pos: Option<u32>,
    /// While pending/running: the typical duration (started → finished) of this repo's
    /// recent successful runs of the same kind (event + deploy), for progress rings.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub expected_ms: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// For pull_request pipelines: the PR number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<u64>,
    /// True when this pipeline deploys (a deploy workflow / deploy-app run).
    #[serde(skip_serializing_if = "is_false", default)]
    pub deploy: bool,
    /// Failed, but every failed step passed on the same sha within [`FLAKE_MS`].
    #[serde(skip_serializing_if = "is_false", default)]
    pub flaky: bool,
    pub workflows: Vec<Workflow>,
    pub url: String,
    /// Deep links (server-built from configured bases).
    #[serde(default, skip_serializing_if = "PipelineLinks::is_empty")]
    pub links: Box<PipelineLinks>,
}

/// Where a pipeline can be opened.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct PipelineLinks {
    /// Roadrunner console: the run (Woodpecker pipelines).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cicd: Option<String>,
    /// Woodpecker UI: the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub woodpecker: Option<String>,
    /// GitHub Actions: the run (gha pipelines).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github: Option<String>,
    /// The commit on GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The branch on GitHub (push / cron / manual runs; a PR run: its head branch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The release / tag on GitHub (tag runs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    /// The PR on GitHub (pull_request runs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<String>,
}

impl PipelineLinks {
    pub fn is_empty(&self) -> bool {
        *self == PipelineLinks::default()
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Workflow {
    pub name: String,
    pub state: CiState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub steps: Vec<Step>,
    /// Where the workflow opens: Roadrunner on its first step, or the GitHub Actions run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Step {
    pub name: String,
    pub state: CiState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
    /// Failed steps: the failure cluster id.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cluster: Option<String>,
    /// Where the step (its log) opens: the Roadrunner run on this step, or the GitHub
    /// Actions job.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PrPhase {
    Draft,
    Checks,
    Review,
    ChangesRequested,
    Mergeable,
    Conflict,
    Merged,
    Closed,
    Deployed,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Check {
    pub name: String,
    pub state: CiState,
    #[serde(skip_serializing_if = "is_false", default)]
    pub required: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AiReview {
    Pending,
    Commented,
    Approved,
    Skipped,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Review {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiReview>,
    /// GitHub review decision: approved | changes_requested | review_required.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub human: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Pr {
    pub id: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    #[serde(skip_serializing_if = "is_false", default)]
    pub bot: bool,
    pub draft: bool,
    pub created: Ms,
    pub updated: Ms,
    pub head_sha: String,
    pub head: String,
    pub base: String,
    pub phase: PrPhase,
    pub ci: CiState,
    /// Required checks and checks that have not passed (full list: `/pr` detail).
    pub checks: Vec<Check>,
    /// How many other checks passed (success / skipped).
    #[serde(skip_serializing_if = "is_zero_u32", default)]
    pub checks_passed: u32,
    pub review: Review,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<Ms>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_ms: Option<i64>,
    pub url: String,
    #[serde(default, skip_serializing_if = "PrLinks::is_empty")]
    pub links: PrLinks,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct PrLinks {
    /// The PR's checks tab.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub checks: String,
    /// Its head branch on GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

impl PrLinks {
    pub fn is_empty(&self) -> bool {
        *self == PrLinks::default()
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum DeployVia {
    Roadrunner,
    Gha,
    GhaFallback,
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum DeployState {
    Pending,
    Running,
    Success,
    Failure,
}

impl DeployState {
    pub fn rank(self) -> u8 {
        match self {
            DeployState::Pending => 1,
            DeployState::Running => 2,
            DeployState::Success | DeployState::Failure => 3,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Deploy {
    pub id: String,
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
    #[serde(default, skip_serializing_if = "DeployLinks::is_empty")]
    pub links: DeployLinks,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct DeployLinks {
    /// The deploy run in the Roadrunner console (Roadrunner deploys).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cicd: Option<String>,
    /// The commit deployed, on GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// The app (its URL).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
}

impl DeployLinks {
    pub fn is_empty(&self) -> bool {
        *self == DeployLinks::default()
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct DeployRef {
    pub id: String,
    pub state: DeployState,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Up,
    Degraded,
    Down,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct App {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    pub url: String,
    pub health: Health,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u32>,
    pub checked: Ms,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_deploy: Option<DeployRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The app's status page (health, latency, resources), from the apps catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_url: Option<String>,
    #[serde(default, skip_serializing_if = "AppLinks::is_empty")]
    pub links: AppLinks,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct AppLinks {
    /// Its runtime logs, from the apps catalog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logs: Option<String>,
    /// Its repo on GitHub.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

impl AppLinks {
    pub fn is_empty(&self) -> bool {
        *self == AppLinks::default()
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    Dagger,
    WpAgent,
    GhaRunner,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Engine {
    pub id: String,
    pub kind: EngineKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// The machine this engine/agent runs on ("VM 153", "Mac mini").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Heartbeat seen recently and accepting work.
    pub online: bool,
    pub slots: u32,
    pub busy: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mem: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<Ms>,
    /// Pipeline ids running here.
    pub running: Vec<String>,
    /// For an engine host: the agent engine ids it serves.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    /// Its page: the Roadrunner engine page (Dagger hosts), Woodpecker's agents
    /// (agents), the runner scale sets (GitHub runners).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Queue {
    pub id: String,
    /// Workflows waiting for an agent slot.
    pub pending: u32,
    /// Workflows running.
    pub running: u32,
    /// Workflows waiting on `depends_on`.
    #[serde(default)]
    pub waiting: u32,
    /// Distinct pipelines with a running workflow.
    #[serde(default)]
    pub pipelines_running: u32,
    #[serde(skip_serializing_if = "is_false", default)]
    pub paused: bool,
    pub oldest_wait_ms: i64,
    /// Pending pipeline ids in queue order (≤ 50).
    pub items: Vec<String>,
    /// Its page (Woodpecker's queue).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Lane {
    pub id: String,
    pub mode: LaneMode,
    #[serde(skip_serializing_if = "is_false", default)]
    pub fallback: bool,
    #[serde(skip_serializing_if = "is_false", default)]
    pub held: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Watcher {
    pub id: String,
    pub tripped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<Ms>,
    pub gh_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Stats {
    pub id: String,
    pub commits_24h: u32,
    pub pipelines_24h: u32,
    pub success_rate_24h: f32,
    pub p50_queue_ms: i64,
    pub p50_build_ms: i64,
    pub deploys_24h: u32,
    pub apps_up: u32,
    pub apps_down: u32,
    pub prs_open: u32,
    pub running: u32,
    pub pending: u32,
}

/// A step failing and passing on the same sha within this long is a flake.
pub const FLAKE_MS: Ms = 6 * 3_600_000;

pub use crate::signature::FailClass;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub kind: GroupKind,
    pub repos: u32,
    pub apps: u32,
    pub red: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "snake_case")]
pub enum GroupKind {
    Team,
    Org,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Cluster {
    pub id: String,
    pub signature: String,
    pub step: String,
    pub class: FailClass,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i32>,
    pub count: u32,
    pub count_1h: u32,
    pub repos: Vec<String>,
    pub repo_count: u32,
    pub groups: Vec<String>,
    pub first_seen: Ms,
    pub last_seen: Ms,
    pub examples: Vec<String>,
    pub open: u32,
    #[serde(skip_serializing_if = "is_zero_u32", default)]
    pub flaky: u32,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Flake {
    pub id: String,
    pub repo: String,
    pub workflow: String,
    pub step: String,
    pub flips_24h: u32,
    pub failures_24h: u32,
    pub last_at: Ms,
    pub shas: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Metric {
    /// Absent = no data in that window (a merge patch cannot carry `null` values).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub h1: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub h24: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub d7: Option<f64>,
    pub dir: i8,
    #[serde(skip_serializing_if = "is_false", default)]
    pub bad: bool,
    pub spark: Vec<Option<f64>>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Trend {
    pub id: String,
    pub at: Ms,
    pub intake_ms: Metric,
    pub run_ms: Metric,
    pub pass_rate: Metric,
    pub pipelines: Metric,
    pub deploys: Metric,
    pub pr_age_ms: Metric,
    pub red: Metric,
    pub hours_7d: u32,
}

/// Transient visual events: the animation drivers. Never stored as entities.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum Event {
    Push {
        repo: String,
        sha: String,
        branch: String,
        author: String,
        #[serde(skip_serializing_if = "is_false", default)]
        bot: bool,
        title: String,
        at: Ms,
    },
    Enqueue {
        pipeline: String,
        lane: LaneKind,
        repo: String,
        sha: String,
        at: Ms,
    },
    Start {
        pipeline: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        engine: Option<String>,
        at: Ms,
    },
    Step {
        pipeline: String,
        workflow: String,
        step: String,
        state: CiState,
        at: Ms,
    },
    Finish {
        pipeline: String,
        state: CiState,
        at: Ms,
        #[serde(skip_serializing_if = "is_false", default)]
        culprit: bool,
    },
    Pr {
        repo: String,
        number: u64,
        phase: PrPhase,
        at: Ms,
    },
    Merge {
        repo: String,
        number: u64,
        sha: String,
        at: Ms,
    },
    Deploy {
        app: String,
        sha: String,
        state: DeployState,
        via: DeployVia,
        at: Ms,
    },
    Health {
        app: String,
        from: Health,
        to: Health,
        at: Ms,
    },
    Main {
        repo: String,
        from: CiState,
        to: CiState,
        #[serde(skip_serializing_if = "Option::is_none")]
        culprit: Option<String>,
        at: Ms,
    },
}

pub fn is_zero_u32(n: &u32) -> bool {
    *n == 0
}

pub fn is_false(b: &bool) -> bool {
    !*b
}

/// Id helpers (one place, so client and server agree).
pub mod ids {
    pub fn commit(repo: &str, sha: &str) -> String {
        format!("{repo}@{sha}")
    }
    pub fn pr(repo: &str, number: u64) -> String {
        format!("{repo}#{number}")
    }
    pub fn wp_pipeline(repo: &str, number: u64) -> String {
        format!("wp:{repo}:{number}")
    }
    pub fn gha_pipeline(run_id: u64) -> String {
        format!("gha:{run_id}")
    }
    /// A deploy is identified by what was deployed: `owner/name@sha`.
    pub fn deploy(repo: &str, sha: &str) -> String {
        format!("{repo}@{sha}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combine_prefers_active_then_red() {
        use CiState::*;
        assert_eq!(combine_states([]), None);
        assert_eq!(combine_states([Success, Running]), Running);
        assert_eq!(combine_states([Success, Failure]), Failure);
        assert_eq!(combine_states([Success, Skipped]), Success);
        assert_eq!(combine_states([Canceled, Skipped]), Canceled);
        assert_eq!(combine_states([Pending, Failure]), Pending);
    }

    #[test]
    fn event_wire_shape() {
        let e = Event::Main {
            repo: "o/r".into(),
            from: CiState::Success,
            to: CiState::Failure,
            culprit: Some("abc".into()),
            at: 5,
        };
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(
            s,
            r#"{"k":"main","repo":"o/r","from":"success","to":"failure","culprit":"abc","at":5}"#
        );
    }
}
