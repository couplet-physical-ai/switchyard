//! GitHub adapter (GraphQL polling; one query covers many repos, cost ~1 point).
//!
//! * Boot + hourly: every non-archived repo per org with its default branch and
//!   the last 20 default-branch commits with their rollup state (the dot line
//!   of quiet repos), as `Repos` + `MainHist` facts.
//! * Every 45 s (the first configured org) / 90 s (others): the most recently pushed repos,
//!   their newest default-branch commits, and the HEAD's checks + statuses
//!   (GitHub Actions runs, `ci/failsafe-deploy`, everything not on Woodpecker).
//! * Every 60 s: the 50 most recently updated open PRs (non-dependabot) and the
//!   PRs closed/merged since the last sweep; every 10 min all open
//!   non-dependabot PRs; every 30 min the dependabot ones.
//!
//! Roadrunner pipelines come from Woodpecker's event stream, not from here.

use std::collections::{BTreeMap, BTreeSet, HashMap};
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
   history(first:$hist){nodes{id oid committedDate messageHeadline author{name user{login}} statusCheckRollup{state}}}
  }}}}}}}"#;

/// The rollup contexts of commits GitHub calls red (by node id), to read their own CI
/// ([`main_line_state`]). Fetching every history commit's contexts in the inventory made
/// its pages too slow for GitHub (502s, truncated orgs); red ones are a few dozen.
const RED_QUERY: &str = r#"query($ids:[ID!]!){
 rateLimit{cost remaining}
 nodes(ids:$ids){... on Commit{oid statusCheckRollup{state contexts(first:40){totalCount nodes{__typename
  ... on StatusContext{context state createdAt}
  ... on CheckRun{name status conclusion checkSuite{app{slug} workflowRun{event workflow{name}}}}}}}}}}"#;

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

/// A default-branch commit's own CI state from its rollup (`statusCheckRollup{state contexts}`),
/// the way the main line reads it: security scanning (CodeQL, Dependabot) is not delivery, a
/// pull request's runs describe the PR rather than the branch, and of a Roadrunner workflow's
/// push and manual statuses the newer counts (a manual rerun supersedes the push run). GitHub's
/// own `state` counts all of those, so a CodeQL "Analyze (actions)" failure read as a red main.
/// A truncated context list falls back to GitHub's state.
pub fn main_line_state(rollup: &Value) -> CiState {
    let nodes = rollup
        .pointer("/contexts/nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let total = rollup
        .pointer("/contexts/totalCount")
        .and_then(Value::as_u64)
        .unwrap_or(nodes.len() as u64);
    let github = s(rollup, "/state")
        .map(rollup_state)
        .unwrap_or(CiState::None);
    if nodes.is_empty() || total > nodes.len() as u64 {
        return github;
    }
    let mut states: Vec<CiState> = Vec::new();
    let mut wp: BTreeMap<&str, (Ms, CiState)> = BTreeMap::new();
    for c in nodes {
        if is_scanning(c) {
            continue;
        }
        match c.get("__typename").and_then(Value::as_str) {
            Some("StatusContext") => {
                let ctx = s(c, "/context").unwrap_or("");
                let st = rollup_state(s(c, "/state").unwrap_or(""));
                if ctx.starts_with("ci/woodpecker/pr/") {
                    continue;
                }
                let wf = ctx
                    .strip_prefix("ci/woodpecker/push/")
                    .or_else(|| ctx.strip_prefix("ci/woodpecker/manual/"));
                if let Some(wf) = wf {
                    let at = s(c, "/createdAt").and_then(parse_time).unwrap_or(0);
                    let e = wp.entry(wf).or_insert((at, st));
                    if at >= e.0 {
                        *e = (at, st);
                    }
                } else {
                    states.push(st);
                }
            }
            Some("CheckRun") => {
                let ev = s(c, "/checkSuite/workflowRun/event").unwrap_or("");
                if ev == "pull_request" || ev == "pull_request_target" {
                    continue;
                }
                states.push(check_state(
                    s(c, "/status").unwrap_or(""),
                    s(c, "/conclusion"),
                ));
            }
            _ => {}
        }
    }
    states.extend(wp.into_values().map(|(_, st)| st));
    combine_states(states)
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
                        canceled: false,
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
                    canceled: false,
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
            git_ref: None,
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
                url: Some(url.clone()),
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
                        state: c
                            .get("statusCheckRollup")
                            .filter(|r| !r.is_null())
                            .map(main_line_state)
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

/// The number (1-based) of a GitHub Actions job's failed step, from the REST job
/// (`GET /repos/{repo}/actions/jobs/{id}`): the first that failed or timed out.
pub fn failed_step_of(job: &Value) -> Option<u32> {
    job.get("steps")?
        .as_array()?
        .iter()
        .find(|s| {
            matches!(
                s.get("conclusion").and_then(Value::as_str),
                Some("failure" | "timed_out")
            )
        })?
        .get("number")?
        .as_u64()
        .map(|n| n as u32)
}

/// The deploy runs of one commit from REST `GET /repos/{repo}/actions/runs?head_sha={sha}`:
/// every deploy-named workflow run outside pull requests (push and manual alike), as deploy
/// facts. The newest decides the commit's GitHub Actions deploy (`deploy_version`).
pub fn deploy_runs_facts(repo: &str, sha: &str, runs: &Value) -> Vec<Fact> {
    let mut out = Vec::new();
    for r in runs
        .get("workflow_runs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = s(r, "/name").unwrap_or("");
        let event = s(r, "/event").unwrap_or("");
        if !name.to_ascii_lowercase().contains("deploy")
            || event.starts_with("pull_request")
            || s(r, "/head_sha") != Some(sha)
        {
            continue;
        }
        let Some(id) = r.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let completed = s(r, "/status") == Some("completed");
        let (state, canceled) = match (s(r, "/status").unwrap_or(""), s(r, "/conclusion")) {
            ("completed", Some("success")) => (DeployState::Success, false),
            ("completed", Some("failure" | "timed_out" | "startup_failure")) => {
                (DeployState::Failure, false)
            }
            ("completed", Some("cancelled" | "stale")) => (DeployState::Failure, true),
            ("completed", _) => continue,
            ("in_progress", _) => (DeployState::Running, false),
            _ => (DeployState::Pending, false),
        };
        let started = s(r, "/run_started_at")
            .or_else(|| s(r, "/created_at"))
            .and_then(parse_time)
            .unwrap_or(0);
        out.push(Fact::Deploy(DeployFact {
            app: String::new(),
            repo: repo.into(),
            sha: sha.into(),
            via: if event == "workflow_dispatch" || event == "repository_dispatch" {
                DeployVia::GhaFallback
            } else {
                DeployVia::Gha
            },
            state,
            started,
            finished: completed
                .then(|| s(r, "/updated_at").and_then(parse_time))
                .flatten(),
            pipeline: Some(ids::gha_pipeline(id)),
            url: s(r, "/html_url").map(str::to_string),
            source: "gha".into(),
            canceled,
        }));
    }
    out
}

/// A GitHub Actions run read directly (REST `GET /repos/{repo}/actions/runs/{id}`): the
/// last polled `p` with the run's current state; a finished run's unfinished jobs and steps
/// take its conclusion. `None` while the run is still going.
pub fn run_closed(p: &Pipeline, run: &Value) -> Option<Pipeline> {
    if s(run, "/status") != Some("completed") {
        return None;
    }
    let state = check_state(
        "COMPLETED",
        Some(&s(run, "/conclusion").unwrap_or("").to_ascii_uppercase()),
    );
    let end = s(run, "/updated_at").and_then(parse_time);
    let mut q = p.clone();
    q.state = state;
    q.finished = end.or(q.finished);
    for w in &mut q.workflows {
        if !w.state.is_done() {
            w.state = state;
            w.finished = q.finished;
        }
        for st in &mut w.steps {
            if !st.state.is_done() {
                st.state = if st.state == CiState::Running {
                    state
                } else {
                    CiState::Skipped
                };
                st.finished = q.finished;
            }
        }
    }
    Some(q)
}

/// A run no poll has reported for this long is read directly.
pub const STALE_RUN_MS: Ms = 3 * 60_000;
const STALE_RUN_READS: usize = 8;

/// Deploy rechecks per minute, and how often one commit is read again.
const RECHECKS: usize = 5;
const RECHECK_EVERY_MS: Ms = 5 * 60_000;

/// Failed-step lookups per batch of facts (the rest follow on the next poll).
const STEP_LOOKUPS: usize = 8;

pub struct GithubAdapter {
    pub api: String,
    pub token: String,
    pub orgs: Vec<String>,
    pub http: reqwest::Client,
    pub tx: mpsc::Sender<Ingest>,
    /// Failed jobs: their failed step (`None`: none failed, e.g. setup), by job id, so a
    /// failed job's `Step.url` opens on that step. A finished job never changes.
    pub failed_steps: parking_lot::Mutex<HashMap<u64, Option<u32>>>,
    /// Commits whose GitHub Actions deploy failed: (repo, sha) → (first seen, last checked).
    /// Their runs are read again (REST) until a deploy run of the same commit passes or a
    /// day goes by, because a manual redeploy (`workflow_dispatch`, e.g. "First Deploy App")
    /// is not in the commit's check rollup and would leave the failure standing.
    pub deploy_rechecks: parking_lot::Mutex<HashMap<(String, String), (Ms, Ms)>>,
    /// GitHub Actions runs last seen running or queued, by run id: (the run, when a poll
    /// last reported it). A run whose repo drops out of the heads poll (25 most recently
    /// pushed per org) before it finishes would stay "running" forever; one no poll has
    /// reported for [`STALE_RUN_MS`] is read directly (REST) and closed.
    pub active_runs: parking_lot::Mutex<HashMap<u64, (Pipeline, Ms)>>,
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

    /// The failed step of one job (REST, one call per failed job, cached).
    async fn failed_step(&self, repo: &str, job: u64) -> anyhow::Result<Option<u32>> {
        self.adapters.request(NAME, 1);
        let r = self
            .http
            .get(format!(
                "{}/repos/{repo}/actions/jobs/{job}",
                self.api.trim_end_matches('/')
            ))
            .bearer_auth(&self.token)
            .header("accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(20))
            .send()
            .await?;
        if r.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !r.status().is_success() {
            anyhow::bail!("job HTTP {}", r.status());
        }
        Ok(failed_step_of(&r.json::<Value>().await?))
    }

    /// Point each failed GitHub Actions job's `Step.url` at its failed step
    /// (`…/job/{id}#step:{n}:1`).
    pub async fn anchor_failed_steps(&self, facts: &mut [Fact]) {
        let mut budget = STEP_LOOKUPS;
        for f in facts.iter_mut() {
            let Fact::Pipeline(p) = f else { continue };
            if p.lane != LaneKind::Gha {
                continue;
            }
            for st in p.workflows.iter_mut().flat_map(|w| w.steps.iter_mut()) {
                if !matches!(st.state, CiState::Failure | CiState::Error) || st.finished.is_none() {
                    continue;
                }
                let Some(u) = st.url.clone() else { continue };
                let Some(job) = crate::links::gh_job_id(&u) else {
                    continue;
                };
                let known = self.failed_steps.lock().get(&job).copied();
                let n = match known {
                    Some(n) => n,
                    None if budget > 0 => {
                        budget -= 1;
                        match self.failed_step(&p.repo, job).await {
                            Ok(n) => {
                                let mut c = self.failed_steps.lock();
                                if c.len() >= 4096 {
                                    c.clear();
                                }
                                c.insert(job, n);
                                n
                            }
                            Err(e) => {
                                debug!(job, error = %e, "github job lookup failed");
                                None
                            }
                        }
                    }
                    None => None,
                };
                if let Some(n) = n {
                    st.url = Some(crate::links::gh_job_step(&u, n));
                }
            }
        }
    }

    async fn send(&self, mut facts: Vec<Fact>, live: bool) {
        self.anchor_failed_steps(&mut facts).await;
        {
            let now = (self.clock)();
            let mut ar = self.active_runs.lock();
            for f in &facts {
                if let Fact::Pipeline(p) = f
                    && p.lane == LaneKind::Gha
                {
                    if p.state.is_active() {
                        ar.insert(p.number, (p.clone(), now));
                    } else {
                        ar.remove(&p.number);
                    }
                }
            }
            drop(ar);
            let mut rc = self.deploy_rechecks.lock();
            for f in &facts {
                if let Fact::Deploy(d) = f
                    && d.source == "gha"
                    && d.state == DeployState::Failure
                    && !d.canceled
                    && d.started > now - 24 * 3_600_000
                {
                    rc.entry((d.repo.clone(), d.sha.clone()))
                        .or_insert((now, 0));
                }
            }
        }
        if !facts.is_empty() {
            let _ = self.tx.send(Ingest { facts, live }).await;
        }
    }

    /// Close GitHub Actions runs no poll has reported for [`STALE_RUN_MS`] (see
    /// [`GithubAdapter::active_runs`]): a finished one is published finished, a deleted one
    /// is dropped, one still going waits for the next read.
    async fn close_stale_runs(&self) -> anyhow::Result<()> {
        let now = (self.clock)();
        let due: Vec<(u64, Pipeline)> = {
            let mut ar = self.active_runs.lock();
            ar.retain(|_, (p, _)| now - p.created < 24 * 3_600_000);
            let mut v: Vec<(u64, Pipeline, Ms)> = ar
                .iter()
                .filter(|(_, (_, seen))| now - *seen >= STALE_RUN_MS)
                .map(|(id, (p, seen))| (*id, p.clone(), *seen))
                .collect();
            v.sort_by_key(|x| x.2);
            v.into_iter()
                .take(STALE_RUN_READS)
                .map(|(id, p, _)| (id, p))
                .collect()
        };
        let mut facts = Vec::new();
        for (id, p) in due {
            self.adapters.request(NAME, 1);
            let r = self
                .http
                .get(format!(
                    "{}/repos/{}/actions/runs/{id}",
                    self.api.trim_end_matches('/'),
                    p.repo
                ))
                .bearer_auth(&self.token)
                .header("accept", "application/vnd.github+json")
                .timeout(Duration::from_secs(20))
                .send()
                .await?;
            if r.status() == reqwest::StatusCode::NOT_FOUND {
                self.active_runs.lock().remove(&id);
                facts.push(Fact::PipelineGone { id: p.id.clone() });
                continue;
            }
            if !r.status().is_success() {
                anyhow::bail!("run HTTP {}", r.status());
            }
            match run_closed(&p, &r.json::<Value>().await?) {
                Some(q) => {
                    self.active_runs.lock().remove(&id);
                    facts.push(Fact::Pipeline(q));
                }
                None => {
                    if let Some(e) = self.active_runs.lock().get_mut(&id) {
                        e.1 = now;
                    }
                }
            }
        }
        if !facts.is_empty() {
            let _ = self.tx.send(Ingest { facts, live: true }).await;
        }
        Ok(())
    }

    /// Read the deploy runs of commits whose GitHub Actions deploy failed again (see
    /// [`GithubAdapter::deploy_rechecks`]); a passing one ends the recheck.
    async fn recheck_deploys(&self) -> anyhow::Result<()> {
        let now = (self.clock)();
        let due: Vec<(String, String)> = {
            let mut rc = self.deploy_rechecks.lock();
            rc.retain(|_, (first, _)| now - *first < 24 * 3_600_000);
            let mut v: Vec<(Ms, (String, String))> = rc
                .iter()
                .filter(|(_, (_, last))| now - *last >= RECHECK_EVERY_MS)
                .map(|(k, (_, last))| (*last, k.clone()))
                .collect();
            v.sort();
            v.into_iter().take(RECHECKS).map(|(_, k)| k).collect()
        };
        for (repo, sha) in due {
            self.adapters.request(NAME, 1);
            let r = self
                .http
                .get(format!(
                    "{}/repos/{repo}/actions/runs?head_sha={sha}&per_page=50",
                    self.api.trim_end_matches('/')
                ))
                .bearer_auth(&self.token)
                .header("accept", "application/vnd.github+json")
                .timeout(Duration::from_secs(20))
                .send()
                .await?;
            let ok = r.status().is_success();
            let gone = r.status() == reqwest::StatusCode::NOT_FOUND;
            let facts = if ok {
                deploy_runs_facts(&repo, &sha, &r.json::<Value>().await?)
            } else {
                Vec::new()
            };
            let passed = facts
                .iter()
                .any(|f| matches!(f, Fact::Deploy(d) if d.state == DeployState::Success));
            {
                let mut rc = self.deploy_rechecks.lock();
                if passed || gone {
                    rc.remove(&(repo.clone(), sha.clone()));
                } else if let Some(e) = rc.get_mut(&(repo.clone(), sha.clone())) {
                    e.1 = now;
                }
            }
            if !facts.is_empty() {
                let _ = self.tx.send(Ingest { facts, live: true }).await;
            }
        }
        Ok(())
    }

    /// The main-line dots GitHub calls red, read again from their own contexts
    /// ([`main_line_state`]): a CodeQL or Dependabot check, a pull request's run or a push
    /// run a manual rerun superseded is not the repo's main line failing. On any error the
    /// dot keeps GitHub's state.
    async fn refine_red_dots(&self, nodes: &[Value], facts: &mut [Fact]) {
        let mut ids: Vec<String> = Vec::new();
        for r in nodes {
            for c in r
                .pointer("/defaultBranchRef/target/history/nodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if matches!(s(c, "/statusCheckRollup/state"), Some("FAILURE" | "ERROR"))
                    && let Some(id) = s(c, "/id")
                {
                    ids.push(id.to_string());
                }
            }
        }
        let mut own: HashMap<String, CiState> = HashMap::new();
        for chunk in ids.chunks(25) {
            match self.gql(RED_QUERY, json!({ "ids": chunk })).await {
                Ok(v) => {
                    for n in v
                        .pointer("/data/nodes")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if let (Some(oid), Some(r)) = (s(n, "/oid"), n.get("statusCheckRollup")) {
                            own.insert(oid.to_string(), main_line_state(r));
                        }
                    }
                }
                Err(e) => debug!(error = %e, "github: red dots kept GitHub's state"),
            }
        }
        if own.is_empty() {
            return;
        }
        for f in facts.iter_mut() {
            if let Fact::MainHist(h) = f {
                for d in &mut h.dots {
                    if let Some(st) = own.get(&d.sha) {
                        d.state = *st;
                    }
                }
            }
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
                if conn.is_null() {
                    // A page GitHub answered without its data (partial errors): the org's
                    // list is not whole, so its repo list is not replaced.
                    warn!(org, "github: inventory page without data");
                    complete = false;
                    break;
                }
                let nodes = conn
                    .get("nodes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let (m, mut facts) = repo_page_facts(&nodes, false, now);
                self.refine_red_dots(&nodes, &mut facts).await;
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
            // Heads: the first org every 45 s, the other orgs every 90 s.
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
            if tick.is_multiple_of(4)
                && let Err(e) = self.recheck_deploys().await
            {
                errs.push(format!("deploy recheck: {e}"));
            }
            if tick.is_multiple_of(4)
                && let Err(e) = self.close_stale_runs().await
            {
                errs.push(format!("stale runs: {e}"));
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
