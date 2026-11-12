//! Woodpecker (Roadrunner) adapter.
//!
//! Real time: ONE `GET /api/stream/events` SSE connection (bot token: the only
//! identity with perms on every active repo) carries every pipeline, workflow
//! and step transition fleet-wide, each event with the full tree. Around it:
//! a boot backfill of 24 h, a gap reconcile on every (re)connect, and cheap
//! periodic polls for what SSE does not carry (queue, agents, inventory).
//! Total steady load: one stream + well under 1 request/s.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use serde::Deserialize;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::facts::*;
use crate::model::*;
use crate::runtime::{Adapters, Clock, Ingest};

pub const NAME: &str = "woodpecker";

#[derive(Deserialize, Clone, Debug, Default)]
pub struct WpRepo {
    pub id: u64,
    #[serde(default)]
    pub full_name: String,
    #[serde(default)]
    pub default_branch: String,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub private: bool,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct WpStep {
    #[serde(default)]
    pub id: u64,
    /// Position in the pipeline (Woodpecker's step URLs use it).
    #[serde(default)]
    pub pid: u64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub exit_code: i32,
    #[serde(default)]
    pub started: i64,
    #[serde(default)]
    pub finished: i64,
    #[serde(default, rename = "type")]
    pub kind: String,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct WpWorkflow {
    #[serde(default)]
    pub id: u64,
    #[serde(default)]
    pub pid: u64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub started: i64,
    #[serde(default)]
    pub finished: i64,
    #[serde(default)]
    pub agent_id: u64,
    #[serde(default)]
    pub children: Option<Vec<WpStep>>,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct WpPipeline {
    #[serde(default)]
    pub id: u64,
    pub number: u64,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub created: i64,
    #[serde(default)]
    pub updated: i64,
    #[serde(default)]
    pub started: i64,
    #[serde(default)]
    pub finished: i64,
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default, rename = "ref")]
    pub git_ref: String,
    #[serde(default)]
    pub refspec: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub forge_url: String,
    #[serde(default)]
    pub workflows: Option<Vec<WpWorkflow>>,
    /// Feed rows carry the repo inline.
    #[serde(default)]
    pub repo_id: u64,
    #[serde(default)]
    pub full_name: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct WpEvent {
    pub repo: WpRepo,
    pub pipeline: WpPipeline,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct WpTask {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub agent_id: u64,
    #[serde(default)]
    pub agent_name: String,
    #[serde(default)]
    pub pipeline_number: u64,
    #[serde(default)]
    pub repo_id: u64,
    #[serde(default)]
    pub created: i64,
}

#[derive(Deserialize, Clone, Debug, Default)]
pub struct WpQueueInfo {
    #[serde(default)]
    pub pending: Option<Vec<WpTask>>,
    #[serde(default)]
    pub waiting_on_deps: Option<Vec<WpTask>>,
    #[serde(default)]
    pub running: Option<Vec<WpTask>>,
    #[serde(default)]
    pub paused: bool,
}

/// An agent. NOTE: the API also returns the agent's secret `token`; it is not
/// declared here, so serde drops it on ingest and it is never stored or logged.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct WpAgent {
    pub id: u64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub capacity: i64,
    #[serde(default)]
    pub last_contact: i64,
    #[serde(default)]
    pub no_schedule: bool,
    #[serde(default)]
    pub custom_labels: BTreeMap<String, String>,
}

pub fn map_state(s: &str) -> CiState {
    match s {
        "success" => CiState::Success,
        "failure" => CiState::Failure,
        "running" => CiState::Running,
        "pending" | "created" => CiState::Pending,
        "blocked" => CiState::Blocked,
        "declined" | "killed" | "canceled" => CiState::Canceled,
        "skipped" => CiState::Skipped,
        "error" => CiState::Error,
        _ => CiState::None,
    }
}

/// A pipeline Woodpecker stored before reading its config: `created` with no workflows.
/// If no workflow matches the event it is deleted unpublished (a 404 from then on);
/// otherwise it is published again with its workflows moments later.
pub fn pre_config(p: &WpPipeline) -> bool {
    p.status == "created" && p.workflows.as_ref().is_none_or(|w| w.is_empty())
}

pub fn map_event(e: &str) -> PipelineEvent {
    match e {
        "pull_request" | "pull_request_closed" | "pull_request_metadata" => {
            PipelineEvent::PullRequest
        }
        "tag" | "release" => PipelineEvent::Tag,
        "cron" => PipelineEvent::Cron,
        "manual" => PipelineEvent::Manual,
        "deployment" => PipelineEvent::Deployment,
        _ => PipelineEvent::Push,
    }
}

fn ms(s: i64) -> Option<Ms> {
    (s > 0).then_some(s * 1000)
}

/// `refs/pull/193/merge` → 193.
pub fn pr_number(git_ref: &str) -> Option<u64> {
    let rest = git_ref.strip_prefix("refs/pull/")?;
    rest.split('/').next()?.parse().ok()
}

/// "VM 153" for `dagger-ci-153-1`, "Mac mini" for `rr-mac-mini-*`.
pub fn agent_host(name: &str) -> Option<String> {
    if let Some(rest) = name.strip_prefix("dagger-ci-") {
        let vm = rest.split('-').next()?;
        if vm.chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("VM {vm}"));
        }
    }
    if name.contains("mac-mini") {
        return Some("Mac mini".into());
    }
    None
}

pub struct Mapper {
    pub public_url: String,
    pub agents: BTreeMap<u64, String>,
}

impl Mapper {
    pub fn agent(&self, id: u64) -> Option<String> {
        if id == 0 {
            return None;
        }
        Some(
            self.agents
                .get(&id)
                .cloned()
                .unwrap_or_else(|| format!("agent {id}")),
        )
    }

    /// Map one Woodpecker pipeline (list row, detail or SSE event) to facts:
    /// the pipeline itself, plus a deploy fact for each deploy workflow. Nothing for a
    /// pipeline that is not real yet ([`pre_config`]).
    pub fn facts(&self, repo: &str, repo_id: u64, p: &WpPipeline) -> Vec<Fact> {
        if pre_config(p) {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(2);
        let event = map_event(&p.event);
        let pr = if event == PipelineEvent::PullRequest {
            pr_number(&p.git_ref)
        } else {
            None
        };
        let branch = if event == PipelineEvent::PullRequest {
            p.refspec
                .split(':')
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or(&p.branch)
                .to_string()
        } else {
            p.branch.clone()
        };
        let title = if !p.title.trim().is_empty() {
            p.title.trim().to_string()
        } else {
            p.message.lines().next().unwrap_or("").trim().to_string()
        };
        let workflows: Vec<Workflow> = p
            .workflows
            .iter()
            .flatten()
            .map(|w| Workflow {
                name: w.name.clone(),
                state: map_state(&w.state),
                started: ms(w.started),
                finished: ms(w.finished),
                engine: self.agent(w.agent_id),
                steps: w
                    .children
                    .iter()
                    .flatten()
                    .map(|s| Step {
                        name: s.name.clone(),
                        state: map_state(&s.state),
                        started: ms(s.started),
                        finished: ms(s.finished),
                        exit_code: (s.finished > 0 || map_state(&s.state).is_done())
                            .then_some(s.exit_code),
                        cached: None,
                        cluster: None,
                        url: (s.pid != 0).then(|| crate::links::wp_step(repo_id, p.number, s.pid)),
                    })
                    .collect(),
                url: Some(
                    w.children
                        .iter()
                        .flatten()
                        .map(|s| s.pid)
                        .find(|&pid| pid != 0)
                        .map(|pid| crate::links::wp_step(repo_id, p.number, pid))
                        .unwrap_or_else(|| crate::links::wp_run(repo_id, p.number)),
                ),
            })
            .collect();
        let state = map_state(&p.status);
        let engine = p
            .workflows
            .iter()
            .flatten()
            .filter(|w| map_state(&w.state) == CiState::Running)
            .chain(p.workflows.iter().flatten())
            .find(|w| w.agent_id != 0)
            .and_then(|w| self.agent(w.agent_id));
        let deploy_wfs: Vec<&WpWorkflow> = p
            .workflows
            .iter()
            .flatten()
            .filter(|w| w.name.to_ascii_lowercase().contains("deploy"))
            .collect();
        let pid = ids::wp_pipeline(repo, p.number);
        let pipeline = Pipeline {
            id: pid.clone(),
            lane: LaneKind::Roadrunner,
            repo: repo.to_string(),
            number: p.number,
            sha: p.commit.clone(),
            branch,
            git_ref: (event == PipelineEvent::Tag)
                .then(|| crate::links::tag_of(&p.git_ref).map(str::to_string))
                .flatten(),
            event,
            state,
            created: p.created * 1000,
            started: ms(p.started),
            finished: ms(p.finished),
            queue_pos: None,
            expected_ms: None,
            engine,
            title: (!title.is_empty()).then_some(title),
            author: (!p.author.is_empty()).then(|| p.author.clone()),
            pr,
            deploy: !deploy_wfs.is_empty() && event == PipelineEvent::Push,
            flaky: false,
            workflows,
            url: format!(
                "{}/repos/{repo_id}/pipeline/{}",
                self.public_url.trim_end_matches('/'),
                p.number
            ),
            links: Default::default(),
        };
        if event == PipelineEvent::Push {
            for w in deploy_wfs {
                let st = map_state(&w.state);
                let ds = match st {
                    CiState::Pending | CiState::Blocked | CiState::None => DeployState::Pending,
                    CiState::Running => DeployState::Running,
                    CiState::Success => DeployState::Success,
                    CiState::Failure | CiState::Error | CiState::Canceled => DeployState::Failure,
                    CiState::Skipped => continue,
                };
                out.push(Fact::Deploy(DeployFact {
                    app: String::new(),
                    repo: repo.to_string(),
                    sha: p.commit.clone(),
                    via: DeployVia::Roadrunner,
                    state: ds,
                    started: ms(w.started).unwrap_or(p.created * 1000),
                    finished: ms(w.finished),
                    pipeline: Some(pid.clone()),
                    url: Some(pipeline.url.clone()),
                    source: "wp".into(),
                }));
            }
        }
        out.insert(0, Fact::Pipeline(pipeline));
        out
    }
}

pub fn engines_fact(
    agents: &[WpAgent],
    q: &WpQueueInfo,
    repos: &BTreeMap<u64, String>,
    now: Ms,
) -> EngineList {
    let mut running: BTreeMap<u64, Vec<String>> = BTreeMap::new();
    for t in q.running.iter().flatten() {
        if let Some(r) = repos
            .get(&t.repo_id)
            .cloned()
            .or_else(|| t.labels.get("woodpecker-ci.org/repo-full-name").cloned())
        {
            running
                .entry(t.agent_id)
                .or_default()
                .push(ids::wp_pipeline(&r, t.pipeline_number));
        }
    }
    let engines = agents
        .iter()
        .map(|a| {
            let mut r = running.get(&a.id).cloned().unwrap_or_default();
            let busy = r.len() as u32;
            r.sort();
            r.dedup();
            Engine {
                id: format!("wp-agent-{}", a.id),
                kind: EngineKind::WpAgent,
                label: Some(a.name.clone()),
                platform: (!a.platform.is_empty()).then(|| a.platform.clone()),
                host: agent_host(&a.name),
                slots: a.capacity.max(0) as u32,
                busy,
                cpu: None,
                mem: None,
                load: None,
                last_seen: ms(a.last_contact - a.last_contact.rem_euclid(30)),
                online: a.last_contact > 0
                    && now - a.last_contact * 1000 < 90_000
                    && !a.no_schedule,
                running: r,
                agents: Vec::new(),
                url: Some(crate::links::engine_page(agent_host(&a.name).as_deref())),
            }
        })
        .collect();
    EngineList {
        source: NAME.into(),
        observed: now,
        engines,
    }
}

pub fn queue_fact(q: &WpQueueInfo, repos: &BTreeMap<u64, String>, now: Ms) -> QueueFact {
    let name = |t: &WpTask| -> Option<String> {
        repos
            .get(&t.repo_id)
            .cloned()
            .or_else(|| t.labels.get("woodpecker-ci.org/repo-full-name").cloned())
    };
    let mut items: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    let mut oldest = now;
    for t in q.pending.iter().flatten() {
        oldest = oldest.min(t.created * 1000);
        if let Some(r) = name(t) {
            let id = ids::wp_pipeline(&r, t.pipeline_number);
            if seen.insert(id.clone()) {
                items.push(id);
            }
        }
    }
    let running: BTreeSet<(u64, u64)> = q
        .running
        .iter()
        .flatten()
        .map(|t| (t.repo_id, t.pipeline_number))
        .collect();
    let pending = q.pending.as_ref().map(|v| v.len()).unwrap_or(0) as u32;
    items.truncate(50);
    QueueFact {
        observed: now,
        queue: Queue {
            id: "roadrunner".into(),
            pending,
            running: q.running.as_ref().map(|v| v.len()).unwrap_or(0) as u32,
            waiting: q.waiting_on_deps.as_ref().map(|v| v.len()).unwrap_or(0) as u32,
            oldest_wait_ms: if pending == 0 {
                0
            } else {
                (now - oldest).max(0)
            },
            pipelines_running: running.len() as u32,
            paused: q.paused,
            items,
            url: Some(crate::links::wp_queue()),
        },
    }
}

// ---------------------------------------------------------------- client

#[derive(Clone)]
pub struct WpClient {
    pub base: String,
    pub public_url: String,
    token: String,
    http: reqwest::Client,
    adapters: Arc<Adapters>,
}

impl WpClient {
    pub fn new(
        base: String,
        public_url: String,
        token: String,
        http: reqwest::Client,
        adapters: Arc<Adapters>,
    ) -> WpClient {
        WpClient {
            base: base.trim_end_matches('/').to_string(),
            public_url,
            token,
            http,
            adapters,
        }
    }

    pub async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> anyhow::Result<T> {
        self.get_opt(path)
            .await?
            .ok_or_else(|| anyhow::anyhow!("GET {path}: HTTP 404 Not Found"))
    }

    /// [`WpClient::get`], with a 404 as `Ok(None)` (every other failure is an error).
    pub async fn get_opt<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
    ) -> anyhow::Result<Option<T>> {
        self.adapters.request(NAME, 1);
        let r = self
            .http
            .get(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        let st = r.status();
        if st == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !st.is_success() {
            anyhow::bail!("GET {path}: HTTP {st}");
        }
        Ok(Some(r.json().await?))
    }

    pub async fn repos(&self) -> anyhow::Result<Vec<WpRepo>> {
        let mut out = Vec::new();
        for page in 1..=40 {
            let v: Vec<WpRepo> = self
                .get(&format!("/api/repos?active=true&page={page}&perPage=50"))
                .await?;
            let n = v.len();
            out.extend(v.into_iter().filter(|r| r.active));
            if n < 50 {
                break;
            }
        }
        Ok(out)
    }

    /// One pipeline's detail; `None` once Woodpecker has deleted it (404).
    pub async fn pipeline(&self, repo_id: u64, number: u64) -> anyhow::Result<Option<WpPipeline>> {
        self.get_opt(&format!("/api/repos/{repo_id}/pipelines/{number}"))
            .await
    }

    /// Pipelines of one repo created after `after_ms` (list rows, no workflows).
    pub async fn pipelines_after(
        &self,
        repo_id: u64,
        after_ms: Ms,
    ) -> anyhow::Result<Vec<WpPipeline>> {
        let after = rfc3339(after_ms);
        let mut out = Vec::new();
        for page in 1..=20 {
            let v: Vec<WpPipeline> = self
                .get(&format!(
                    "/api/repos/{repo_id}/pipelines?after={after}&perPage=50&page={page}"
                ))
                .await?;
            let n = v.len();
            out.extend(v);
            if n < 50 {
                break;
            }
        }
        Ok(out)
    }
}

/// RFC 3339 UTC for a unix-ms instant (no chrono dependency).
pub fn rfc3339(ms: Ms) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

// ---------------------------------------------------------------- task

/// Lines read from the end of a failed step's log: pytest's `FAILED` lines can sit
/// thousands of lines before the end (classifying 5,000 lines takes ~3 ms).
pub const LOG_LINES: usize = 5_000;

/// One failed step whose log should be read for its failure signature.
#[derive(Clone, Debug, PartialEq)]
pub struct LogJob {
    pub pipeline: String,
    pub repo_id: u64,
    pub number: u64,
    pub step_id: u64,
    pub workflow: String,
    pub step: String,
    pub exit_code: Option<i32>,
    pub finished: Ms,
}

/// The failed steps of a finished pipeline (none while it runs, none without step ids).
pub fn log_jobs(repo: &str, repo_id: u64, p: &WpPipeline) -> Vec<LogJob> {
    if !map_state(&p.status).is_done() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for w in p.workflows.iter().flatten() {
        for s in w.children.iter().flatten() {
            if s.id == 0 || !matches!(map_state(&s.state), CiState::Failure | CiState::Error) {
                continue;
            }
            out.push(LogJob {
                pipeline: ids::wp_pipeline(repo, p.number),
                repo_id,
                number: p.number,
                step_id: s.id,
                workflow: w.name.clone(),
                step: s.name.clone(),
                exit_code: Some(s.exit_code),
                finished: ms(s.finished).or(ms(p.finished)).unwrap_or(0),
            });
        }
    }
    out
}

/// Read failed steps' logs (live jobs first, then the boot backlog), at most one
/// request per 400 ms, each log once; emit their signatures as facts.
pub async fn read_logs(
    client: WpClient,
    mut live: mpsc::Receiver<LogJob>,
    mut back: mpsc::Receiver<LogJob>,
    tx: mpsc::Sender<Ingest>,
    clock: Clock,
) {
    let mut done: std::collections::HashSet<(String, u64)> = std::collections::HashSet::new();
    loop {
        let job = tokio::select! {
            biased;
            Some(j) = live.recv() => j,
            Some(j) = back.recv() => j,
            else => return,
        };
        let now = clock();
        if job.finished > 0 && job.finished < now - 24 * 3_600_000 {
            continue;
        }
        if !done.insert((job.pipeline.clone(), job.step_id)) {
            continue;
        }
        if done.len() > 50_000 {
            done.clear();
        }
        let path = format!(
            "/api/repos/{}/logs/{}/{}",
            job.repo_id, job.number, job.step_id
        );
        client.adapters.request(NAME, 1);
        let body = async {
            let r = client
                .http
                .get(format!("{}{path}", client.base))
                .bearer_auth(&client.token)
                .timeout(Duration::from_secs(30))
                .send()
                .await?;
            if !r.status().is_success() {
                anyhow::bail!("HTTP {}", r.status());
            }
            Ok::<_, anyhow::Error>(r.bytes().await?)
        }
        .await;
        let lines = match body {
            Ok(b) => crate::signature::decode_wp_log(&b, LOG_LINES),
            Err(e) => {
                debug!(error = %e, pipeline = %job.pipeline, "step log unavailable");
                Vec::new()
            }
        };
        let sig = crate::signature::extract(&job.workflow, &job.step, job.exit_code, &lines);
        let f = Fact::StepError(StepErrorFact {
            pipeline: job.pipeline,
            workflow: job.workflow,
            step: job.step,
            class: sig.class,
            line: sig.line,
            exit_code: sig.exit_code,
            observed: now,
        });
        if tx
            .send(Ingest {
                facts: vec![f],
                live: true,
            })
            .await
            .is_err()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

struct Shared {
    repos: BTreeMap<u64, String>,
    agents: BTreeMap<u64, String>,
    /// Last known status per pipeline (repo_id, number) for reconcile diffs.
    known: BTreeMap<(u64, u64), String>,
}

pub struct WpAdapter {
    pub client: WpClient,
    pub tx: mpsc::Sender<Ingest>,
    /// Failed steps to read logs for: live, and the boot backlog (set up by `run`).
    pub logs_live: Option<mpsc::Sender<LogJob>>,
    pub logs_back: Option<mpsc::Sender<LogJob>>,
    pub adapters: Arc<Adapters>,
    pub clock: Clock,
    pub backfill_ms: Ms,
}

impl WpAdapter {
    fn mapper(&self, sh: &Shared) -> Mapper {
        Mapper {
            public_url: self.client.public_url.clone(),
            agents: sh.agents.clone(),
        }
    }

    pub async fn run(mut self) {
        let (lt, lr) = mpsc::channel::<LogJob>(1000);
        let (bt, br) = mpsc::channel::<LogJob>(2000);
        self.logs_live = Some(lt);
        self.logs_back = Some(bt);
        tokio::spawn(read_logs(
            self.client.clone(),
            lr,
            br,
            self.tx.clone(),
            self.clock.clone(),
        ));
        let sh = Arc::new(Mutex::new(Shared {
            repos: BTreeMap::new(),
            agents: BTreeMap::new(),
            known: BTreeMap::new(),
        }));
        self.adapters.syncing(NAME);
        // 1. Inventory + agents first (names for everything else).
        loop {
            match self.inventory(&sh).await {
                Ok(()) => break,
                Err(e) => {
                    self.adapters.error(NAME, format!("inventory: {e}"));
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            }
        }
        self.poll_queue(&sh).await.ok();
        // 2. The stream, opened before the backfill so live events win.
        let (reconnected_tx, mut reconnected_rx) = mpsc::channel::<()>(4);
        {
            let s = self.stream_task(sh.clone(), reconnected_tx);
            tokio::spawn(s);
        }
        // 3. Backfill the last day.
        if let Err(e) = self.backfill(&sh).await {
            warn!(error = %e, "woodpecker backfill incomplete");
            self.adapters.degraded(NAME, format!("backfill: {e}"));
        }
        self.adapters.ok(NAME, (self.clock)(), None);
        info!("woodpecker: backfill done");
        // 4. Periodic polls.
        let mut q = tokio::time::interval(Duration::from_secs(5));
        let mut rec = tokio::time::interval(Duration::from_secs(60));
        let mut inv = tokio::time::interval(Duration::from_secs(600));
        q.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        rec.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        inv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = q.tick() => {
                    if let Err(e) = self.poll_queue(&sh).await { self.adapters.degraded(NAME, format!("queue: {e}")); }
                }
                _ = rec.tick() => {
                    if let Err(e) = self.reconcile(&sh).await { self.adapters.degraded(NAME, format!("reconcile: {e}")); }
                }
                Some(()) = reconnected_rx.recv() => {
                    if let Err(e) = self.reconcile(&sh).await { self.adapters.degraded(NAME, format!("reconcile: {e}")); }
                }
                _ = inv.tick() => {
                    if let Err(e) = self.inventory(&sh).await { self.adapters.degraded(NAME, format!("inventory: {e}")); }
                }
            }
        }
    }

    async fn send(&self, facts: Vec<Fact>, live: bool) {
        if !facts.is_empty() {
            let _ = self.tx.send(Ingest { facts, live }).await;
        }
    }

    async fn inventory(&self, sh: &Arc<Mutex<Shared>>) -> anyhow::Result<()> {
        let repos = self.client.repos().await?;
        let agents: Vec<WpAgent> = self.client.get("/api/agents").await?;
        let now = (self.clock)();
        let list = RepoList {
            source: NAME.into(),
            observed: now,
            repos: repos
                .iter()
                .map(|r| RepoMeta {
                    id: r.full_name.clone(),
                    default_branch: r.default_branch.clone(),
                    woodpecker_id: Some(r.id),
                    pushed_at: None,
                    archived: false,
                })
                .collect(),
        };
        {
            let mut g = sh.lock();
            g.repos = repos.iter().map(|r| (r.id, r.full_name.clone())).collect();
            g.agents = agents.iter().map(|a| (a.id, a.name.clone())).collect();
        }
        self.send(vec![Fact::Repos(list)], false).await;
        Ok(())
    }

    async fn poll_queue(&self, sh: &Arc<Mutex<Shared>>) -> anyhow::Result<()> {
        let q: WpQueueInfo = self.client.get("/api/queue/info").await?;
        let agents: Vec<WpAgent> = self.client.get("/api/agents").await?;
        let now = (self.clock)();
        let repos = {
            let mut g = sh.lock();
            g.agents = agents.iter().map(|a| (a.id, a.name.clone())).collect();
            g.repos.clone()
        };
        let facts = vec![
            Fact::Queue(queue_fact(&q, &repos, now)),
            Fact::Engines(engines_fact(&agents, &q, &repos, now)),
        ];
        self.send(facts, true).await;
        Ok(())
    }

    async fn backfill(&self, sh: &Arc<Mutex<Shared>>) -> anyhow::Result<()> {
        let now = (self.clock)();
        let since = now - self.backfill_ms;
        let feed: Vec<WpPipeline> = self.client.get("/api/user/feed?latest=true").await?;
        let mut targets: Vec<(u64, String)> = feed
            .iter()
            .filter(|f| f.created * 1000 >= since)
            .map(|f| (f.repo_id, f.full_name.clone()))
            .collect();
        targets.sort();
        targets.dedup();
        info!(repos = targets.len(), "woodpecker: backfilling");
        let mapper = self.mapper(&sh.lock());
        // List rows for every active repo of the day (concurrency 8).
        let lists = futures::stream::iter(targets.clone())
            .map(|(rid, name)| {
                let c = self.client.clone();
                async move { (rid, name, c.pipelines_after(rid, since).await) }
            })
            .buffer_unordered(8)
            .collect::<Vec<_>>()
            .await;
        let mut details: Vec<(u64, String, u64)> = Vec::new();
        let mut facts = Vec::new();
        for (rid, name, r) in lists {
            match r {
                Ok(ps) => {
                    // Failed runs (and passes of the same sha: reruns) need their steps
                    // for failure clusters and flakes.
                    let failed_shas: BTreeSet<String> = ps
                        .iter()
                        .filter(|p| {
                            matches!(map_state(&p.status), CiState::Failure | CiState::Error)
                        })
                        .map(|p| p.commit.clone())
                        .collect();
                    for p in ps {
                        let recent = p.created * 1000 >= now - 3 * 3_600_000;
                        if recent
                            || !map_state(&p.status).is_done()
                            || failed_shas.contains(&p.commit)
                        {
                            details.push((rid, name.clone(), p.number));
                        }
                        if !pre_config(&p) {
                            sh.lock().known.insert((rid, p.number), p.status.clone());
                        }
                        facts.extend(mapper.facts(&name, rid, &p));
                        if facts.len() >= 500 {
                            self.send(std::mem::take(&mut facts), false).await;
                        }
                    }
                }
                Err(e) => debug!(repo = %name, error = %e, "backfill list failed"),
            }
        }
        self.send(facts, false).await;
        // Details (workflows + steps): active first, then newest.
        details.sort_by_key(|d| std::cmp::Reverse(d.2));
        info!(n = details.len(), "woodpecker: fetching pipeline details");
        let got = futures::stream::iter(details)
            .map(|(rid, name, n)| {
                let c = self.client.clone();
                async move { (rid, name, n, c.pipeline(rid, n).await) }
            })
            .buffer_unordered(8)
            .collect::<Vec<_>>()
            .await;
        let mut facts = Vec::new();
        for (rid, name, n, r) in got {
            match r {
                Ok(Some(p)) => {
                    self.queue_logs(&name, rid, &p, false);
                    facts.extend(mapper.facts(&name, rid, &p));
                }
                Ok(None) => facts.push(gone(sh, &name, rid, n)),
                Err(_) => {}
            }
        }
        self.send(facts, false).await;
        Ok(())
    }

    fn queue_logs(&self, repo: &str, rid: u64, p: &WpPipeline, live: bool) {
        let q = if live {
            &self.logs_live
        } else {
            &self.logs_back
        };
        if let Some(q) = q {
            for j in log_jobs(repo, rid, p) {
                let _ = q.try_send(j);
            }
        }
    }

    /// Catch what a dropped stream lost: active pipelines + latest per repo.
    async fn reconcile(&self, sh: &Arc<Mutex<Shared>>) -> anyhow::Result<()> {
        let active: Vec<WpPipeline> = self.client.get("/api/pipelines").await?;
        let feed: Vec<WpPipeline> = self.client.get("/api/user/feed?latest=true").await?;
        let mut need: BTreeSet<(u64, u64)> = BTreeSet::new();
        let active_keys: BTreeSet<(u64, u64)> =
            active.iter().map(|p| (p.repo_id, p.number)).collect();
        {
            let g = sh.lock();
            for p in active.iter().chain(feed.iter()) {
                if g.known.get(&(p.repo_id, p.number)) != Some(&p.status) {
                    need.insert((p.repo_id, p.number));
                }
            }
            // Locally running but no longer active upstream: it finished unseen.
            for ((rid, n), st) in g.known.iter() {
                if !map_state(st).is_done() && !active_keys.contains(&(*rid, *n)) {
                    need.insert((*rid, *n));
                }
            }
        }
        let names = sh.lock().repos.clone();
        let mapper = self.mapper(&sh.lock());
        let mut facts = Vec::new();
        for (rid, n) in need.into_iter().take(200) {
            let Some(name) = names.get(&rid).cloned() else {
                continue;
            };
            match self.client.pipeline(rid, n).await {
                Ok(Some(p)) => {
                    if !pre_config(&p) {
                        sh.lock().known.insert((rid, n), p.status.clone());
                    }
                    self.queue_logs(&name, rid, &p, true);
                    facts.extend(mapper.facts(&name, rid, &p));
                }
                Ok(None) => facts.push(gone(sh, &name, rid, n)),
                Err(e) => debug!(error = %e, "reconcile detail failed"),
            }
        }
        self.send(facts, true).await;
        self.adapters.ok(NAME, (self.clock)(), None);
        Ok(())
    }

    fn stream_task(
        &self,
        sh: Arc<Mutex<Shared>>,
        reconnected: mpsc::Sender<()>,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let client = self.client.clone();
        let tx = self.tx.clone();
        let adapters = self.adapters.clone();
        let clock = self.clock.clone();
        let logs = self.logs_live.clone();
        async move {
            let mut backoff = 1u64;
            loop {
                let started = std::time::Instant::now();
                let r =
                    stream_once(&client, &sh, &tx, &adapters, &clock, &reconnected, &logs).await;
                if let Err(e) = r {
                    warn!(error = %e, "woodpecker stream dropped");
                    adapters.degraded(NAME, format!("stream: {e}"));
                }
                if started.elapsed() > Duration::from_secs(60) {
                    backoff = 1;
                }
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(30);
            }
        }
    }
}

async fn stream_once(
    client: &WpClient,
    sh: &Arc<Mutex<Shared>>,
    tx: &mpsc::Sender<Ingest>,
    adapters: &Arc<Adapters>,
    clock: &Clock,
    reconnected: &mpsc::Sender<()>,
    logs: &Option<mpsc::Sender<LogJob>>,
) -> anyhow::Result<()> {
    adapters.request(NAME, 1);
    let resp = client
        .http
        .get(format!("{}/api/stream/events", client.base))
        .bearer_auth(&client.token)
        .header("accept", "text/event-stream")
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("stream HTTP {}", resp.status());
    }
    let _ = reconnected.try_send(());
    info!("woodpecker: event stream connected");
    let mut body = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
    // Topics are fixed at connect: reconnect every 30 min to pick up new repos.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
    loop {
        let chunk = tokio::select! {
            c = tokio::time::timeout(Duration::from_secs(75), body.next()) => c,
            _ = tokio::time::sleep_until(deadline) => return Ok(()),
        };
        let chunk = match chunk {
            Err(_) => anyhow::bail!("idle 75 s"),
            Ok(None) => anyhow::bail!("closed"),
            Ok(Some(Err(e))) => anyhow::bail!("read: {e}"),
            Ok(Some(Ok(c))) => c,
        };
        buf.extend_from_slice(&chunk);
        while let Some(pos) = find_double_newline(&buf) {
            let ev: Vec<u8> = buf.drain(..pos + 2).collect();
            let mut data = Vec::new();
            for line in ev.split(|b| *b == b'\n') {
                if let Some(d) = line
                    .strip_prefix(b"data: ")
                    .or_else(|| line.strip_prefix(b"data:"))
                {
                    data.extend_from_slice(d);
                }
            }
            if data.is_empty() {
                continue;
            }
            match serde_json::from_slice::<WpEvent>(&data) {
                Ok(e) => {
                    let facts = {
                        let mut g = sh.lock();
                        g.repos
                            .entry(e.repo.id)
                            .or_insert_with(|| e.repo.full_name.clone());
                        if !pre_config(&e.pipeline) {
                            g.known
                                .insert((e.repo.id, e.pipeline.number), e.pipeline.status.clone());
                        }
                        let m = Mapper {
                            public_url: client.public_url.clone(),
                            agents: g.agents.clone(),
                        };
                        m.facts(&e.repo.full_name, e.repo.id, &e.pipeline)
                    };
                    if let Some(q) = logs {
                        for j in log_jobs(&e.repo.full_name, e.repo.id, &e.pipeline) {
                            let _ = q.try_send(j);
                        }
                    }
                    let _ = tx.send(Ingest { facts, live: true }).await;
                    adapters.alive(
                        NAME,
                        clock(),
                        Some((clock() - e.pipeline.updated.max(e.pipeline.created) * 1000).max(0)),
                    );
                }
                Err(err) => debug!(error = %err, "unparsed woodpecker event"),
            }
        }
    }
}

/// Woodpecker deleted this pipeline (404): forget it and take it off the board.
fn gone(sh: &Mutex<Shared>, repo: &str, rid: u64, n: u64) -> Fact {
    sh.lock().known.remove(&(rid, n));
    Fact::PipelineGone {
        id: ids::wp_pipeline(repo, n),
    }
}

fn find_double_newline(b: &[u8]) -> Option<usize> {
    b.windows(2).position(|w| w == b"\n\n")
}
