//! GitHub adapter (GraphQL polling; one query covers many repos, cost ~1 point).
//!
//! * Boot + hourly: every non-archived repo per org with its default branch and
//!   the last 20 default-branch commits with their rollup state (the dot line
//!   of quiet repos), as `Repos` + `MainHist` facts.
//! * Every 45 s (Northwind-Labs) / 90 s (others): the most recently pushed repos,
//!   their newest default-branch commits, and the HEAD's checks + statuses
//!   (GitHub Actions runs, `ci/failsafe-deploy`, everything not on Woodpecker).
//! * Every 60 s: the 50 most recently updated open PRs (non-dependabot) and the
//!   PRs closed/merged since the last sweep; every 10 min all open
//!   non-dependabot PRs; every 30 min the dependabot ones.
//!
//! Roadrunner pipelines come from Woodpecker's event stream, not from here.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::adapters::apps::parse_time;
use crate::adapters::woodpecker::rfc3339;
use crate::facts::*;
use crate::model::*;
use crate::runtime::{Adapters, Clock, Ingest};
use crate::store::is_bot;

pub const NAME: &str = "github";

const HEADS_QUERY: &str = r#"query($org:String!,$n:Int!,$hist:Int!,$after:String){
 rateLimit{cost remaining}
 organization(login:$org){repositories(first:$n,after:$after,isArchived:false,orderBy:{field:PUSHED_AT,direction:DESC}){
  pageInfo{hasNextPage endCursor}
  nodes{nameWithOwner pushedAt isPrivate defaultBranchRef{name target{... on Commit{
   oid
   statusCheckRollup{contexts(first:40){nodes{__typename
    ... on StatusContext{context state targetUrl createdAt}
    ... on CheckRun{name status conclusion startedAt completedAt detailsUrl checkSuite{app{slug} workflowRun{databaseId event createdAt workflow{name}}}}}}}
   history(first:$hist){nodes{oid committedDate messageHeadline author{name user{login}} statusCheckRollup{state}}}
  }}}}}}}"#;

const HIST_QUERY: &str = r#"query($org:String!,$n:Int!,$hist:Int!,$after:String){
 rateLimit{cost remaining}
 organization(login:$org){repositories(first:$n,after:$after,isArchived:false,orderBy:{field:PUSHED_AT,direction:DESC}){
  pageInfo{hasNextPage endCursor}
  nodes{nameWithOwner pushedAt isPrivate defaultBranchRef{name target{... on Commit{
   history(first:$hist){nodes{oid committedDate messageHeadline author{name user{login}} statusCheckRollup{state}}}
  }}}}}}}"#;

const PR_QUERY: &str = r#"query($q:String!,$n:Int!,$after:String){
 rateLimit{cost remaining}
 search(query:$q,type:ISSUE,first:$n,after:$after){
  issueCount pageInfo{hasNextPage endCursor}
  nodes{... on PullRequest{
   number title url isDraft state createdAt updatedAt mergedAt closedAt
   mergeCommit{oid}
   author{__typename login} repository{nameWithOwner}
   baseRefName headRefName headRefOid
   mergeable reviewDecision
   commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:25){nodes{__typename
    ... on StatusContext{context state targetUrl createdAt}
    ... on CheckRun{name status conclusion startedAt completedAt detailsUrl checkSuite{app{slug} workflowRun{databaseId event createdAt workflow{name}}}}}}}}}}
  }}}}"#;

pub fn rollup_state(s: &str) -> CiState {
    match s {
        "SUCCESS" => CiState::Success,
        "FAILURE" => CiState::Failure,
        "ERROR" => CiState::Error,
        "PENDING" | "EXPECTED" => CiState::Pending,
        _ => CiState::None,
    }
}

pub fn check_state(status: &str, conclusion: Option<&str>) -> CiState {
    match status {
        "COMPLETED" => match conclusion.unwrap_or("") {
            "SUCCESS" => CiState::Success,
            "FAILURE" | "TIMED_OUT" | "STARTUP_FAILURE" => CiState::Failure,
            "CANCELLED" | "STALE" => CiState::Canceled,
            "SKIPPED" | "NEUTRAL" => CiState::Skipped,
            "ACTION_REQUIRED" => CiState::Blocked,
            _ => CiState::None,
        },
        "IN_PROGRESS" => CiState::Running,
        "QUEUED" | "PENDING" | "WAITING" | "REQUESTED" => CiState::Pending,
        _ => CiState::None,
    }
}

fn s<'a>(v: &'a Value, p: &str) -> Option<&'a str> {
    v.pointer(p).and_then(Value::as_str)
}

/// Security scanning is not delivery: CodeQL & co. stay out of CI state.
fn is_scanning(ctx: &Value) -> bool {
    let app = s(ctx, "/checkSuite/app/slug").unwrap_or("");
    let wf = s(ctx, "/checkSuite/workflowRun/workflow/name").unwrap_or("");
    let name = s(ctx, "/name").or_else(|| s(ctx, "/context")).unwrap_or("");
    app == "github-advanced-security"
        || app == "dependabot"
        || wf.eq_ignore_ascii_case("codeql")
        || wf.starts_with("Dependabot")
        || wf.contains("Dependency Submission")
        || name.eq_ignore_ascii_case("codeql")
}

/// Turn one commit's rollup contexts into facts: statuses (for CI state),
/// GitHub Actions runs (as pipelines), and deploys (failsafe status, deploy
/// workflows).
pub fn contexts_to_facts(
    repo: &str,
    sha: &str,
    branch: &str,
    pr: Option<u64>,
    contexts: &[Value],
    now: Ms,
) -> Vec<Fact> {
    let mut out = Vec::new();
    let mut runs: BTreeMap<u64, (Value, Vec<&Value>)> = BTreeMap::new();
    for c in contexts {
        if is_scanning(c) {
            continue;
        }
        match c.get("__typename").and_then(Value::as_str) {
            Some("StatusContext") => {
                let ctx = s(c, "/context").unwrap_or("").to_string();
                let state = rollup_state(s(c, "/state").unwrap_or(""));
                let at = s(c, "/createdAt").and_then(parse_time).unwrap_or(now);
                if ctx == "ci/failsafe-deploy" {
                    let ds = match state {
                        CiState::Success => DeployState::Success,
                        CiState::Failure | CiState::Error => DeployState::Failure,
                        _ => DeployState::Running,
                    };
                    out.push(Fact::Deploy(DeployFact {
                        app: String::new(),
                        repo: repo.into(),
                        sha: sha.into(),
                        via: DeployVia::Roadrunner,
                        state: ds,
                        started: at,
                        finished: (ds != DeployState::Running).then_some(at),
                        pipeline: None,
                        url: s(c, "/targetUrl").map(str::to_string),
                        source: "status".into(),
                    }));
                }
                out.push(Fact::Status(StatusFact {
                    repo: repo.into(),
                    sha: sha.into(),
                    context: ctx,
                    state,
                    at,
                    url: s(c, "/targetUrl").map(str::to_string),
                }));
            }
            Some("CheckRun") => {
                if let Some(id) = c
                    .pointer("/checkSuite/workflowRun/databaseId")
                    .and_then(Value::as_u64)
                {
                    let run = c
                        .pointer("/checkSuite/workflowRun")
                        .cloned()
                        .unwrap_or(Value::Null);
                    runs.entry(id)
                        .or_insert_with(|| (run, Vec::new()))
                        .1
                        .push(c);
                } else {
                    let name = s(c, "/name").unwrap_or("check").to_string();
                    let st = check_state(s(c, "/status").unwrap_or(""), s(c, "/conclusion"));
                    let at = s(c, "/completedAt")
                        .or_else(|| s(c, "/startedAt"))
                        .and_then(parse_time)
                        .unwrap_or(now);
                    out.push(Fact::Status(StatusFact {
                        repo: repo.into(),
                        sha: sha.into(),
                        context: name,
                        state: st,
                        at,
                        url: s(c, "/detailsUrl").map(str::to_string),
                    }));
                }
            }
            _ => {}
        }
    }
    for (id, (run, jobs)) in runs {
        let wf = s(&run, "/workflow/name").unwrap_or("workflow").to_string();
        let states: Vec<CiState> = jobs
            .iter()
            .map(|j| check_state(s(j, "/status").unwrap_or(""), s(j, "/conclusion")))
            .collect();
        let state = combine_states(states.iter().copied());
        let starts: Vec<Ms> = jobs
            .iter()
            .filter_map(|j| s(j, "/startedAt").and_then(parse_time))
            .collect();
        let ends: Vec<Ms> = jobs
            .iter()
            .filter_map(|j| s(j, "/completedAt").and_then(parse_time))
            .collect();
        let created = s(&run, "/createdAt")
            .and_then(parse_time)
            .or_else(|| starts.iter().min().copied())
            .unwrap_or(now);
        let started = starts.iter().min().copied();
        let finished = if state.is_done() {
            ends.iter().max().copied()
        } else {
            None
        };
        let event = match s(&run, "/event").unwrap_or("") {
            "pull_request" | "pull_request_target" => PipelineEvent::PullRequest,
            "schedule" => PipelineEvent::Cron,
            "workflow_dispatch" | "repository_dispatch" => PipelineEvent::Manual,
            "release" => PipelineEvent::Tag,
            "deployment" => PipelineEvent::Deployment,
            _ => {
                if pr.is_some() {
                    PipelineEvent::PullRequest
                } else {
                    PipelineEvent::Push
                }
            }
        };
        let url = jobs
            .iter()
            .find_map(|j| s(j, "/detailsUrl"))
            .and_then(|u| {
                u.find("/job/")
                    .map(|i| u[..i].to_string())
                    .or(Some(u.to_string()))
            })
            .unwrap_or_else(|| format!("https://github.com/{repo}/actions/runs/{id}"));
        // A deploy-named workflow deploys only outside PRs (PR runs are previews/plans).
        let deploy =
            wf.to_ascii_lowercase().contains("deploy") && event != PipelineEvent::PullRequest;
        let pid = ids::gha_pipeline(id);
        let steps: Vec<Step> = jobs
            .iter()
            .zip(states.iter())
            .map(|(j, st)| Step {
                name: s(j, "/name").unwrap_or("job").to_string(),
                state: *st,
                started: s(j, "/startedAt").and_then(parse_time),
                finished: s(j, "/completedAt").and_then(parse_time),
                exit_code: None,
                cached: None,
                cluster: None,
                // The job's page (its log).
                url: s(j, "/detailsUrl")
                    .filter(|u| u.contains("/job/"))
                    .map(str::to_string),
            })
            .collect();
        if deploy && event != PipelineEvent::PullRequest {
            let ds = match state {
                CiState::Success => Some(DeployState::Success),
                CiState::Failure | CiState::Error => Some(DeployState::Failure),
                CiState::Running => Some(DeployState::Running),
                CiState::Pending | CiState::Blocked => Some(DeployState::Pending),
                _ => None,
            };
            if let Some(ds) = ds {
                let manual = event == PipelineEvent::Manual;
                out.push(Fact::Deploy(DeployFact {
                    app: String::new(),
                    repo: repo.into(),
                    sha: sha.into(),
                    via: if manual {
                        DeployVia::GhaFallback
                    } else {
                        DeployVia::Gha
                    },
                    state: ds,
                    started: started.unwrap_or(created),
                    finished,
                    pipeline: Some(pid.clone()),
                    url: Some(url.clone()),
                    source: "gha".into(),
                }));
            }
        }
        out.push(Fact::Pipeline(Pipeline {
            id: pid,
            lane: LaneKind::Gha,
            repo: repo.into(),
            number: id,
            sha: sha.into(),
            branch: branch.into(),
            event,
            state,
            created,
            started,
            finished,
            queue_pos: None,
            expected_ms: None,
            engine: None,
            title: Some(wf.clone()),
            author: None,
            pr,
            deploy,
            flaky: false,
            workflows: vec![Workflow {
                name: wf,
                state,
                started,
                finished,
                engine: None,
                steps,
            }],
            url,
            links: Default::default(),
        }));
    }
    out
}

fn commit_author(n: &Value) -> String {
    s(n, "/author/user/login")
        .or_else(|| s(n, "/author/name"))
        .unwrap_or("")
        .to_string()
}

pub fn pr_fact(n: &Value, now: Ms) -> Option<(PrFact, Vec<Fact>)> {
    let repo = s(n, "/repository/nameWithOwner")?.to_string();
    let number = n.get("number")?.as_u64()?;
    let state = match s(n, "/state").unwrap_or("") {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ => PrState::Open,
    };
    let author = s(n, "/author/login").unwrap_or("ghost").to_string();
    let bot = s(n, "/author/__typename") == Some("Bot") || is_bot(&author);
    let head_sha = s(n, "/headRefOid").unwrap_or("").to_string();
    let empty = Vec::new();
    let contexts = n
        .pointer("/commits/nodes/0/commit/statusCheckRollup/contexts/nodes")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut checks: Vec<Check> = Vec::new();
    for c in contexts {
        if is_scanning(c) {
            continue;
        }
        let (name, st) = match c.get("__typename").and_then(Value::as_str) {
            Some("StatusContext") => (
                s(c, "/context").unwrap_or("").to_string(),
                rollup_state(s(c, "/state").unwrap_or("")),
            ),
            Some("CheckRun") => {
                let wf = s(c, "/checkSuite/workflowRun/workflow/name");
                let name = s(c, "/name").unwrap_or("");
                (
                    wf.map(|w| format!("{w} / {name}"))
                        .unwrap_or_else(|| name.to_string()),
                    check_state(s(c, "/status").unwrap_or(""), s(c, "/conclusion")),
                )
            }
            _ => continue,
        };
        if name.is_empty() {
            continue;
        }
        let required = name.starts_with("ci/woodpecker/");
        checks.push(Check {
            name,
            state: st,
            required,
        });
    }
    let head = s(n, "/headRefName").unwrap_or("").to_string();
    let extra = if head_sha.is_empty() || state != PrState::Open {
        Vec::new()
    } else {
        contexts_to_facts(&repo, &head_sha, &head, Some(number), contexts, now)
    };
    let f = PrFact {
        repo,
        number,
        title: s(n, "/title").unwrap_or("").to_string(),
        author,
        bot,
        draft: n.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        state,
        created: s(n, "/createdAt").and_then(parse_time).unwrap_or(now),
        updated: s(n, "/updatedAt").and_then(parse_time).unwrap_or(now),
        head_sha,
        head,
        base: s(n, "/baseRefName").unwrap_or("").to_string(),
        merged_at: s(n, "/mergedAt").and_then(parse_time),
        merge_sha: s(n, "/mergeCommit/oid").map(str::to_string),
        mergeable: match s(n, "/mergeable") {
            Some("MERGEABLE") => Some(Mergeable::Mergeable),
            Some("CONFLICTING") => Some(Mergeable::Conflicting),
            Some(_) => Some(Mergeable::Unknown),
            None => None,
        },
        review: s(n, "/reviewDecision").map(|r| r.to_ascii_lowercase()),
        ai: None,
        checks,
        url: s(n, "/url").unwrap_or("").to_string(),
        observed: now,
    };
    Some((f, extra))
}

/// Repo rows of a heads/history page → facts.
pub fn repo_page_facts(nodes: &[Value], with_heads: bool, now: Ms) -> (Vec<RepoMeta>, Vec<Fact>) {
    let mut metas = Vec::new();
    let mut facts = Vec::new();
    for r in nodes {
        let Some(id) = s(r, "/nameWithOwner") else {
            continue;
        };
        let Some(branch) = s(r, "/defaultBranchRef/name") else {
            continue;
        };
        metas.push(RepoMeta {
            id: id.to_string(),
            default_branch: branch.to_string(),
            woodpecker_id: None,
            pushed_at: s(r, "/pushedAt").and_then(parse_time),
            archived: false,
        });
        let empty = Vec::new();
        let hist = r
            .pointer("/defaultBranchRef/target/history/nodes")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        if with_heads {
            let day = now - 24 * 3_600_000;
            for c in hist {
                let at = s(c, "/committedDate").and_then(parse_time).unwrap_or(now);
                if at < day {
                    continue;
                }
                let author = commit_author(c);
                facts.push(Fact::Commit(CommitFact {
                    repo: id.to_string(),
                    sha: s(c, "/oid").unwrap_or("").to_string(),
                    branch: branch.to_string(),
                    title: s(c, "/messageHeadline").unwrap_or("").to_string(),
                    bot: is_bot(&author),
                    author,
                    at,
                    prio: 2,
                }));
            }
            if let Some(oid) = s(r, "/defaultBranchRef/target/oid") {
                let ctx = r
                    .pointer("/defaultBranchRef/target/statusCheckRollup/contexts/nodes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                facts.extend(contexts_to_facts(id, oid, branch, None, &ctx, now));
            }
        } else {
            let mut dots: Vec<Dot> = hist
                .iter()
                .filter_map(|c| {
                    let author = commit_author(c);
                    Some(Dot {
                        sha: s(c, "/oid")?.to_string(),
                        at: s(c, "/committedDate").and_then(parse_time)?,
                        state: s(c, "/statusCheckRollup/state")
                            .map(rollup_state)
                            .unwrap_or(CiState::None),
                        bot: is_bot(&author),
                        author,
                        title: s(c, "/messageHeadline").unwrap_or("").to_string(),
                        deployed: false,
                        culprit: false,
                    })
                })
                .collect();
            dots.sort_by_key(|d| d.at);
            facts.push(Fact::MainHist(MainHist {
                repo: id.to_string(),
                observed: now,
                dots,
            }));
        }
    }
    (metas, facts)
}

pub struct GithubAdapter {
    pub api: String,
    pub token: String,
    pub orgs: Vec<String>,
    pub http: reqwest::Client,
    pub tx: mpsc::Sender<Ingest>,
    pub adapters: Arc<Adapters>,
    pub clock: Clock,
}

impl GithubAdapter {
    async fn gql(&self, query: &str, vars: Value) -> anyhow::Result<Value> {
        self.adapters.request(NAME, 1);
        let r = self
            .http
            .post(format!("{}/graphql", self.api.trim_end_matches('/')))
            .bearer_auth(&self.token)
            .json(&json!({"query": query, "variables": vars}))
            .timeout(Duration::from_secs(45))
            .send()
            .await?;
        let st = r.status();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if !st.is_success() {
            anyhow::bail!("graphql HTTP {st}");
        }
        if let Some(e) = v.get("errors")
            && v.get("data").is_none_or(Value::is_null)
        {
            anyhow::bail!(
                "graphql errors: {}",
                e.to_string().chars().take(300).collect::<String>()
            );
        }
        if let Some(rem) = v
            .pointer("/data/rateLimit/remaining")
            .and_then(Value::as_i64)
            && rem < 500
        {
            warn!(remaining = rem, "github graphql budget low; slowing down");
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
        Ok(v)
    }

    async fn send(&self, facts: Vec<Fact>, live: bool) {
        if !facts.is_empty() {
            let _ = self.tx.send(Ingest { facts, live }).await;
        }
    }

    /// One GraphQL page, retried with a smaller page size (GitHub answers 502
    /// when a deep query takes more than ~10 s).
    async fn page(&self, query: &str, mut vars: Value, sizes: &[u32]) -> anyhow::Result<Value> {
        let mut last = None;
        for (i, n) in sizes.iter().enumerate() {
            vars["n"] = json!(n);
            match self.gql(query, vars.clone()).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    debug!(attempt = i, n, error = %e, "github page failed; retrying smaller");
                    last = Some(e);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
        Err(last.unwrap_or_else(|| anyhow::anyhow!("no attempt")))
    }

    /// All repos of every org, with 20 commits of default-branch history.
    /// A failing org is skipped (and retried at the next inventory).
    async fn inventory(&self) -> anyhow::Result<()> {
        let now = (self.clock)();
        let mut failed = Vec::new();
        for org in &self.orgs {
            let mut after: Option<String> = None;
            let mut metas = Vec::new();
            let mut complete = true;
            for _ in 0..60 {
                let v = match self
                    .page(
                        HIST_QUERY,
                        json!({"org": org, "hist": 20, "after": after}),
                        &[20, 10, 5],
                    )
                    .await
                {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(org, error = %e, "github: inventory page failed");
                        complete = false;
                        break;
                    }
                };
                let conn = v
                    .pointer("/data/organization/repositories")
                    .cloned()
                    .unwrap_or(Value::Null);
                let nodes = conn
                    .get("nodes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let (m, facts) = repo_page_facts(&nodes, false, now);
                metas.extend(m);
                self.send(facts, false).await;
                if conn
                    .pointer("/pageInfo/hasNextPage")
                    .and_then(Value::as_bool)
                    != Some(true)
                {
                    break;
                }
                after = conn
                    .pointer("/pageInfo/endCursor")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            info!(org, repos = metas.len(), complete, "github: inventory");
            if complete {
                self.send(
                    vec![Fact::Repos(RepoList {
                        source: format!("github:{org}"),
                        observed: now,
                        repos: metas,
                    })],
                    false,
                )
                .await;
            } else {
                failed.push(org.clone());
            }
        }
        if failed.is_empty() {
            Ok(())
        } else {
            anyhow::bail!("inventory incomplete for {}", failed.join(", "))
        }
    }

    async fn heads(&self, org: &str, n: u32, live: bool) -> anyhow::Result<()> {
        let v = self
            .page(
                HEADS_QUERY,
                json!({"org": org, "hist": 5, "after": null}),
                &[n, n / 2],
            )
            .await?;
        let nodes = v
            .pointer("/data/organization/repositories/nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let (_, facts) = repo_page_facts(&nodes, true, (self.clock)());
        self.send(facts, live).await;
        Ok(())
    }

    async fn prs(&self, q: &str, pages: usize, live: bool) -> anyhow::Result<usize> {
        let mut after: Option<String> = None;
        let mut n = 0;
        for _ in 0..pages {
            let v = self
                .page(PR_QUERY, json!({"q": q, "after": after}), &[30, 15])
                .await?;
            let now = (self.clock)();
            let conn = v.pointer("/data/search").cloned().unwrap_or(Value::Null);
            let nodes = conn
                .get("nodes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut facts = Vec::new();
            for node in &nodes {
                if let Some((f, extra)) = pr_fact(node, now) {
                    facts.push(Fact::Pr(f));
                    facts.extend(extra);
                    n += 1;
                }
            }
            self.send(facts, live).await;
            if conn
                .pointer("/pageInfo/hasNextPage")
                .and_then(Value::as_bool)
                != Some(true)
            {
                break;
            }
            after = conn
                .pointer("/pageInfo/endCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        Ok(n)
    }

    fn org_q(&self) -> String {
        self.orgs
            .iter()
            .map(|o| format!("org:{o}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub async fn run(self) {
        self.adapters.syncing(NAME);
        self.adapters.backfilling(NAME, true);
        let orgs = self.org_q();
        let open_q =
            format!("is:pr is:open archived:false -author:app/dependabot {orgs} sort:updated-desc");
        let bot_q =
            format!("is:pr is:open archived:false author:app/dependabot {orgs} sort:updated-desc");
        // Boot: heads and open human PRs first (a few calls: ready in ~1 min), then
        // the slow parts (inventory with main-line history, closed and bot PRs).
        let since = (self.clock)() - 24 * 3_600_000;
        let closed_q = |t: Ms| {
            format!(
                "is:pr is:closed archived:false {orgs} updated:>={} sort:updated-desc",
                rfc3339(t)
            )
        };
        for org in self.orgs.clone() {
            if let Err(e) = self.heads(&org, 40, false).await {
                warn!(org, error = %e, "github: heads backfill");
            }
        }
        if let Err(e) = self.prs(&open_q, 20, false).await {
            warn!(error = %e, "github: PR backfill");
        }
        // Ready once heads + open human PRs are in; the rest fills in after.
        self.adapters.ok(NAME, (self.clock)(), None);
        info!("github: synced");
        if let Err(e) = self.inventory().await {
            self.adapters.degraded(NAME, format!("inventory: {e}"));
        }
        for (q, pages) in [(closed_q(since), 10), (bot_q.clone(), 25)] {
            if let Err(e) = self.prs(&q, pages, false).await {
                warn!(error = %e, "github: PR backfill");
            }
        }
        self.adapters.backfilling(NAME, false);
        info!("github: backfill done");
        let mut tick: u64 = 0;
        let mut last_closed = (self.clock)() - 5 * 60_000;
        let mut t = tokio::time::interval(Duration::from_secs(15));
        t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            t.tick().await;
            tick += 1;
            let mut errs: Vec<String> = Vec::new();
            // Heads: Northwind-Labs every 45 s, the other orgs every 90 s.
            for (i, org) in self.orgs.iter().enumerate() {
                let every = if i == 0 { 3 } else { 6 };
                if tick % every == (i as u64) % every
                    && let Err(e) = self.heads(org, 25, true).await
                {
                    errs.push(format!("heads {org}: {e}"));
                }
            }
            // PRs: recent open + newly closed every 60 s.
            if tick.is_multiple_of(4) {
                if let Err(e) = self.prs(&open_q, 2, true).await {
                    errs.push(format!("prs: {e}"));
                }
                let now = (self.clock)();
                match self.prs(&closed_q(last_closed - 120_000), 2, true).await {
                    Ok(_) => last_closed = now,
                    Err(e) => errs.push(format!("closed prs: {e}")),
                }
            }
            if tick.is_multiple_of(40)
                && let Err(e) = self.prs(&open_q, 20, true).await
            {
                errs.push(format!("all prs: {e}"));
            }
            if tick % 120 == 60
                && let Err(e) = self.prs(&bot_q, 25, true).await
            {
                errs.push(format!("bot prs: {e}"));
            }
            if tick.is_multiple_of(240)
                && let Err(e) = self.inventory().await
            {
                errs.push(format!("inventory: {e}"));
            }
            if errs.is_empty() {
                self.adapters.ok(NAME, (self.clock)(), None);
            } else {
                debug!(?errs, "github poll errors");
                self.adapters.degraded(NAME, errs.join("; "));
            }
        }
    }
}

/// Repos that are public (kept verbatim by the fixture sanitizer).
pub fn public_repos(nodes: &[Value]) -> BTreeSet<String> {
    nodes
        .iter()
        .filter(|r| r.get("isPrivate").and_then(Value::as_bool) == Some(false))
        .filter_map(|r| s(r, "/nameWithOwner").map(str::to_string))
        .collect()
}
