//! GitHub adapter: GraphQL pages (in the adapter's own query shape, with the
//! recorded values) → facts.

mod common;

use common::*;
use serde_json::{Value, json};
use switchyard::adapters::apps::parse_time;
use switchyard::adapters::github::*;
use switchyard::facts::*;
use switchyard::model::*;

/// The heads page was recorded at about this instant.
const H_AT: Ms = 1_794_339_690_000; // 2026-11-10T19:41:30Z
/// The PR page was recorded at about this instant.
const P_AT: Ms = 1_794_339_540_000; // 2026-11-10T19:39:00Z

fn t(s: &str) -> Ms {
    parse_time(s).unwrap_or_else(|| panic!("time {s}"))
}

fn head_nodes() -> Vec<Value> {
    json("github/heads_page.json")["data"]["organization"]["repositories"]["nodes"]
        .as_array()
        .expect("nodes")
        .clone()
}

fn pr_nodes() -> Vec<Value> {
    json("github/open_prs_page.json")["data"]["search"]["nodes"]
        .as_array()
        .expect("nodes")
        .clone()
}

fn pr_node(repo: &str, number: u64) -> Value {
    pr_nodes()
        .into_iter()
        .find(|n| n["repository"]["nameWithOwner"] == repo && n["number"] == number)
        .unwrap_or_else(|| panic!("{repo}#{number}"))
}

fn commits<'a>(f: &'a [Fact], repo: &str) -> Vec<&'a CommitFact> {
    f.iter()
        .filter_map(|x| match x {
            Fact::Commit(c) if c.repo == repo => Some(c),
            _ => None,
        })
        .collect()
}
fn statuses<'a>(f: &'a [Fact], repo: &str) -> Vec<&'a StatusFact> {
    f.iter()
        .filter_map(|x| match x {
            Fact::Status(c) if c.repo == repo => Some(c),
            _ => None,
        })
        .collect()
}
fn pipelines<'a>(f: &'a [Fact], repo: &str) -> Vec<&'a Pipeline> {
    f.iter()
        .filter_map(|x| match x {
            Fact::Pipeline(c) if c.repo == repo => Some(c),
            _ => None,
        })
        .collect()
}
fn deploys<'a>(f: &'a [Fact], repo: &str) -> Vec<&'a DeployFact> {
    f.iter()
        .filter_map(|x| match x {
            Fact::Deploy(c) if c.repo == repo => Some(c),
            _ => None,
        })
        .collect()
}

#[test]
fn heads_page_repo_metas() {
    let (metas, _) = repo_page_facts(&head_nodes(), true, H_AT);
    let ids: Vec<&str> = metas.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "Northwind-Labs/aurora-api",
            "Northwind-Labs/borealis-web",
            "Northwind-Labs/cirrus-hub",
            "Northwind-Labs/delta-stock",
            "Northwind-Labs/meridian-shop",
            "Northwind-Labs/kestrel-status"
        ]
    );
    for m in &metas {
        assert_eq!(m.default_branch, "main");
        assert_eq!(m.woodpecker_id, None);
        assert!(!m.archived);
    }
    assert_eq!(metas[0].pushed_at, Some(t("2026-11-10T19:40:07Z")));
    // Same metas without heads.
    let (m2, _) = repo_page_facts(&head_nodes(), false, H_AT);
    assert_eq!(metas, m2);
    // Public repo detection for the fixture sanitizer.
    let public = public_repos(&head_nodes());
    assert_eq!(
        public.into_iter().collect::<Vec<_>>(),
        ["Northwind-Labs/kestrel-status"]
    );
}

#[test]
fn heads_commits_of_the_last_day() {
    let (_, f) = repo_page_facts(&head_nodes(), true, H_AT);
    let a = commits(&f, "Northwind-Labs/aurora-api");
    assert_eq!(a.len(), 2);
    assert_eq!(a[0].sha, "cba1fed1817599ede1b917712f1ac8d2e629e690");
    assert_eq!(a[0].branch, "main");
    assert_eq!(a[0].title, "feat: neutral change 1");
    assert_eq!(a[0].author, "dev-01", "the GitHub login beats the git name");
    assert!(!a[0].bot);
    assert_eq!(a[0].at, t("2026-11-10T19:40:05Z"));
    assert_eq!(a[0].prio, 2, "GitHub describes a commit best");
    assert_eq!(commits(&f, "Northwind-Labs/cirrus-hub").len(), 3);
    // A week-old head is outside the 24 h window.
    assert!(commits(&f, "Northwind-Labs/kestrel-status").is_empty());
    // A node without a login falls back to the git author name.
    let mut n = head_nodes()[3].clone();
    n["defaultBranchRef"]["target"]["history"]["nodes"][0]["author"]["user"] = Value::Null;
    let (_, f) = repo_page_facts(&[n], true, H_AT);
    assert_eq!(
        commits(&f, "Northwind-Labs/delta-stock")[0].author,
        "Dev Person"
    );
}

#[test]
fn heads_contexts_codeql_filtered_actions_grouped() {
    let (_, f) = repo_page_facts(&head_nodes(), true, H_AT);
    // aurora-api: CodeQL (2 jobs) dropped; Security Scan → one GHA pipeline.
    let p = pipelines(&f, "Northwind-Labs/aurora-api");
    assert_eq!(p.len(), 1);
    let p = p[0];
    assert_eq!(p.id, "gha:42871000001");
    assert_eq!(p.lane, LaneKind::Gha);
    assert_eq!(p.number, 42_871_000_001);
    assert_eq!(p.sha, "cba1fed1817599ede1b917712f1ac8d2e629e690");
    assert_eq!(p.branch, "main");
    assert_eq!(p.event, PipelineEvent::Push);
    assert_eq!(p.state, CiState::Success);
    assert_eq!(p.title.as_deref(), Some("Security Scan"));
    assert_eq!(p.created, t("2026-11-10T19:40:09Z"));
    assert_eq!(p.started, Some(t("2026-11-10T19:40:11Z")));
    assert_eq!(p.finished, Some(t("2026-11-10T19:40:18Z")));
    assert!(!p.deploy);
    assert_eq!(p.pr, None);
    assert_eq!(
        p.url,
        "https://github.com/Northwind-Labs/aurora-api/actions/runs/42871000001"
    );
    assert_eq!(p.workflows.len(), 1);
    assert_eq!(p.workflows[0].name, "Security Scan");
    assert_eq!(p.workflows[0].steps.len(), 1);
    assert_eq!(p.workflows[0].steps[0].name, "scan / gitleaks");
    assert_eq!(p.workflows[0].steps[0].exit_code, None);
    let st = statuses(&f, "Northwind-Labs/aurora-api");
    let ctx: Vec<(&str, CiState)> = st.iter().map(|s| (s.context.as_str(), s.state)).collect();
    assert_eq!(
        ctx,
        [
            ("ci/woodpecker/push/deploy", CiState::Pending),
            ("ci/woodpecker/push/ci", CiState::Success),
            ("ci/woodpecker/push/docs", CiState::Success)
        ]
    );
    assert_eq!(st[0].at, t("2026-11-10T19:41:25Z"));
    assert_eq!(
        st[0].url.as_deref(),
        Some("https://ci.dev.example.com/repos/64/pipeline/28/3")
    );
    assert!(deploys(&f, "Northwind-Labs/aurora-api").is_empty());

    // delta-stock: CodeQL only → no CI signal at all.
    assert!(statuses(&f, "Northwind-Labs/delta-stock").is_empty());
    assert!(pipelines(&f, "Northwind-Labs/delta-stock").is_empty());
}

#[test]
fn heads_failsafe_status_is_a_roadrunner_deploy() {
    let (_, f) = repo_page_facts(&head_nodes(), true, H_AT);
    let d = deploys(&f, "Northwind-Labs/borealis-web");
    assert_eq!(d.len(), 1);
    let d = d[0];
    assert_eq!(d.sha, "be13021ca83449d513f82b9ab0708be58e876780");
    assert_eq!(d.via, DeployVia::Roadrunner);
    assert_eq!(d.state, DeployState::Success);
    assert_eq!(d.started, t("2026-11-10T19:36:45Z"));
    assert_eq!(d.finished, Some(d.started));
    assert_eq!(d.source, "status");
    assert_eq!(d.app, "");
    assert_eq!(d.pipeline, None);
    assert_eq!(
        d.url.as_deref(),
        Some("https://ci.dev.example.com/repos/30/pipeline/23")
    );
    // The failsafe status is also a status.
    assert!(
        statuses(&f, "Northwind-Labs/borealis-web")
            .iter()
            .any(|s| s.context == "ci/failsafe-deploy" && s.state == CiState::Success)
    );
}

#[test]
fn heads_actions_run_with_four_jobs() {
    let (_, f) = repo_page_facts(&head_nodes(), true, H_AT);
    let p = pipelines(&f, "Northwind-Labs/cirrus-hub");
    assert_eq!(p.len(), 1);
    let p = p[0];
    assert_eq!(p.id, "gha:42846645351");
    assert_eq!(p.title.as_deref(), Some("Tests"));
    assert_eq!(p.state, CiState::Success);
    assert_eq!(p.created, t("2026-11-10T15:39:34Z"));
    assert_eq!(p.started, Some(t("2026-11-10T15:39:41Z")), "earliest job");
    assert_eq!(p.finished, Some(t("2026-11-10T15:43:53Z")), "latest job");
    let steps: Vec<&str> = p.workflows[0]
        .steps
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(
        steps,
        [
            "Verus (cirrus-core, --no-cheating)",
            "Zero-Python guard",
            "Frontend",
            "Rust (fmt, clippy, build, lib tests, e2e)"
        ]
    );
    assert!(
        p.workflows[0]
            .steps
            .iter()
            .all(|s| s.state == CiState::Success && s.started.is_some() && s.finished.is_some())
    );
    assert_eq!(
        p.url,
        "https://github.com/Northwind-Labs/cirrus-hub/actions/runs/42846645351"
    );
    let d = deploys(&f, "Northwind-Labs/cirrus-hub");
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].source, "status");
}

#[test]
fn heads_actions_deploy_workflow_failure() {
    let (_, f) = repo_page_facts(&head_nodes(), true, H_AT);
    let p = pipelines(&f, "Northwind-Labs/meridian-shop");
    assert_eq!(p.len(), 1, "the dependabot check is not delivery");
    let p = p[0];
    assert_eq!(p.id, "gha:42860000031");
    assert!(p.deploy);
    assert_eq!(p.state, CiState::Failure, "deploy ok, verify failed");
    let d = deploys(&f, "Northwind-Labs/meridian-shop");
    assert_eq!(d.len(), 1);
    let d = d[0];
    assert_eq!(d.via, DeployVia::Gha);
    assert_eq!(d.state, DeployState::Failure);
    assert_eq!(d.source, "gha");
    assert_eq!(d.started, t("2026-11-10T16:50:30Z"));
    assert_eq!(d.finished, Some(t("2026-11-10T16:51:44Z")));
    assert_eq!(d.pipeline.as_deref(), Some("gha:42860000031"));
    assert_eq!(d.url.as_deref(), Some(p.url.as_str()));
    assert!(statuses(&f, "Northwind-Labs/meridian-shop").is_empty());
    // The deploy fact precedes its pipeline in the batch.
    let i_d = f
        .iter()
        .position(|x| matches!(x, Fact::Deploy(d) if d.source == "gha"));
    let i_p = f
        .iter()
        .position(|x| matches!(x, Fact::Pipeline(p) if p.id == "gha:42860000031"));
    assert!(i_d < i_p);
}

#[test]
fn hist_page_main_dots() {
    let (_, f) = repo_page_facts(&head_nodes(), false, H_AT);
    assert_eq!(f.len(), 6, "one MainHist per repo, nothing else");
    let hist: Vec<&MainHist> = f
        .iter()
        .map(|x| match x {
            Fact::MainHist(h) => h,
            other => panic!("{other:?}"),
        })
        .collect();
    let c = hist
        .iter()
        .find(|h| h.repo == "Northwind-Labs/cirrus-hub")
        .unwrap();
    assert_eq!(c.observed, H_AT);
    let dots: Vec<(&str, CiState)> = c.dots.iter().map(|d| (&d.sha[..7], d.state)).collect();
    assert_eq!(
        dots,
        [
            ("8d9a14d", CiState::Failure),
            ("f26d808", CiState::Failure),
            ("f917c19", CiState::Success)
        ],
        "oldest first"
    );
    assert!(c.dots.iter().all(|d| !d.deployed && !d.culprit));
    let k = hist
        .iter()
        .find(|h| h.repo == "Northwind-Labs/kestrel-status")
        .unwrap();
    assert_eq!(k.dots.len(), 1, "history is not windowed");
    assert_eq!(k.dots[0].state, CiState::None, "no rollup");
    assert!(k.dots[0].bot);
    assert_eq!(k.dots[0].author, "dependabot[bot]");
    let a = hist
        .iter()
        .find(|h| h.repo == "Northwind-Labs/aurora-api")
        .unwrap();
    assert_eq!(a.dots[1].state, CiState::Pending);
    assert_eq!(a.dots[1].title, "feat: neutral change 1");
}

#[test]
fn nodes_without_default_branch_or_name_are_skipped() {
    let nodes = vec![
        json!({"nameWithOwner": "o/empty", "defaultBranchRef": null}),
        json!({"defaultBranchRef": {"name": "main"}}),
    ];
    let (m, f) = repo_page_facts(&nodes, true, H_AT);
    assert!(m.is_empty() && f.is_empty());
}

fn run(id: u64, event: Option<&str>, wf: &str) -> Value {
    let mut r =
        json!({"databaseId": id, "createdAt": "2026-11-10T10:00:00Z", "workflow": {"name": wf}});
    if let Some(e) = event {
        r["event"] = json!(e);
    }
    r
}

fn job(name: &str, status: &str, concl: Option<&str>, run: Value) -> Value {
    json!({"__typename": "CheckRun", "name": name, "status": status, "conclusion": concl,
           "startedAt": "2026-11-10T10:00:05Z",
           "completedAt": if status == "COMPLETED" { json!("2026-11-10T10:01:00Z") } else { Value::Null },
           "detailsUrl": format!("https://github.com/o/r/actions/runs/{}/job/1", run["databaseId"]),
           "checkSuite": {"app": {"slug": "github-actions"}, "workflowRun": run}})
}

#[test]
fn manual_deploy_run_is_the_gha_fallback() {
    let ctx = vec![job(
        "deploy",
        "IN_PROGRESS",
        None,
        run(7, Some("workflow_dispatch"), "Deploy App"),
    )];
    let f = contexts_to_facts("o/r", "abc", "main", None, &ctx, H_AT);
    assert_eq!(f.len(), 2);
    let Fact::Deploy(d) = &f[0] else {
        panic!("{f:?}")
    };
    assert_eq!(d.via, DeployVia::GhaFallback);
    assert_eq!(d.state, DeployState::Running);
    assert_eq!(d.finished, None);
    assert_eq!(d.started, t("2026-11-10T10:00:05Z"));
    let Fact::Pipeline(p) = &f[1] else {
        panic!("{f:?}")
    };
    assert_eq!(p.event, PipelineEvent::Manual);
    assert_eq!(p.state, CiState::Running);
    assert_eq!(p.finished, None, "not done → no finish time");
    assert_eq!(p.url, "https://github.com/o/r/actions/runs/7");

    // Queued deploy → pending; cancelled deploy → no deploy fact.
    let q = vec![job(
        "deploy",
        "QUEUED",
        None,
        run(8, Some("push"), "deploy"),
    )];
    let f = contexts_to_facts("o/r", "abc", "main", None, &q, H_AT);
    assert!(
        matches!(&f[0], Fact::Deploy(d) if d.state == DeployState::Pending && d.via == DeployVia::Gha)
    );
    let c = vec![job(
        "deploy",
        "COMPLETED",
        Some("CANCELLED"),
        run(9, Some("push"), "Deploy"),
    )];
    let f = contexts_to_facts("o/r", "abc", "main", None, &c, H_AT);
    assert_eq!(f.len(), 1);
    assert!(matches!(&f[0], Fact::Pipeline(p) if p.state == CiState::Canceled));
}

#[test]
fn pr_deploy_workflow_is_not_a_deploy() {
    let ctx = vec![job(
        "deploy",
        "COMPLETED",
        Some("SKIPPED"),
        run(5, Some("pull_request"), "CDK Deploy"),
    )];
    let f = contexts_to_facts("o/r", "abc", "feature", Some(3), &ctx, H_AT);
    assert_eq!(f.len(), 1);
    let Fact::Pipeline(p) = &f[0] else { panic!() };
    assert_eq!(p.event, PipelineEvent::PullRequest);
    assert_eq!(p.pr, Some(3));
    assert_eq!(p.state, CiState::Skipped);
}

/// A PR-triggered run of a deploy-named workflow (e.g. "CDK Deploy", whose
/// deploy job is skipped on PRs) does not deploy, so its pipeline should not
/// say `deploy: true`. Woodpecker PR pipelines already say false.
#[test]
fn pr_deploy_workflow_pipeline_is_not_flagged_deploy() {
    let n = pr_node("Northwind-EMS/quartz-infra", 642);
    let (_, extra) = pr_fact(&n, P_AT).unwrap();
    let p = extra
        .iter()
        .find_map(|x| match x {
            Fact::Pipeline(p) => Some(p),
            _ => None,
        })
        .unwrap();
    assert_eq!(p.title.as_deref(), Some("CDK Deploy"));
    assert_eq!(p.event, PipelineEvent::PullRequest);
    assert!(!p.deploy);
}

#[test]
fn run_events_map() {
    for (ev, pr, want) in [
        (Some("schedule"), None, PipelineEvent::Cron),
        (Some("release"), None, PipelineEvent::Tag),
        (Some("repository_dispatch"), None, PipelineEvent::Manual),
        (Some("deployment"), None, PipelineEvent::Deployment),
        (
            Some("pull_request_target"),
            None,
            PipelineEvent::PullRequest,
        ),
        (Some("push"), Some(4), PipelineEvent::PullRequest),
        (None, Some(4), PipelineEvent::PullRequest),
        (None, None, PipelineEvent::Push),
        (Some("dynamic"), None, PipelineEvent::Push),
    ] {
        let ctx = vec![job("t", "COMPLETED", Some("SUCCESS"), run(1, ev, "Tests"))];
        let f = contexts_to_facts("o/r", "abc", "main", pr, &ctx, H_AT);
        let Fact::Pipeline(p) = &f[0] else { panic!() };
        assert_eq!(p.event, want, "{ev:?} pr={pr:?}");
    }
}

#[test]
fn bare_check_runs_and_statuses() {
    let ctx = vec![
        // A check run outside Actions (no workflow run) is a status.
        json!({"__typename": "CheckRun", "name": "Vercel", "status": "COMPLETED", "conclusion": "FAILURE",
               "startedAt": "2026-11-10T10:00:00Z", "completedAt": "2026-11-10T10:02:00Z",
               "detailsUrl": "https://example.com/x", "checkSuite": {"app": {"slug": "vercel"}}}),
        json!({"__typename": "CheckRun", "name": "slow", "status": "IN_PROGRESS",
               "startedAt": "2026-11-10T10:00:00Z", "checkSuite": {"app": {"slug": "other"}}}),
        json!({"__typename": "StatusContext", "context": "ci/failsafe-deploy", "state": "PENDING", "createdAt": "2026-11-10T10:03:00Z"}),
        json!({"__typename": "StatusContext", "context": "legacy", "state": "ERROR"}),
        // Security scanning is not delivery, whatever its shape.
        json!({"__typename": "StatusContext", "context": "CodeQL", "state": "FAILURE"}),
        job(
            "x",
            "COMPLETED",
            Some("FAILURE"),
            run(2, Some("push"), "Dependabot Updates"),
        ),
        job(
            "y",
            "COMPLETED",
            Some("FAILURE"),
            run(3, Some("push"), "Automatic Dependency Submission"),
        ),
        json!({"__typename": "CheckRun", "name": "z", "status": "COMPLETED", "conclusion": "FAILURE",
               "checkSuite": {"app": {"slug": "github-advanced-security"}}}),
        json!({"__typename": "Unknown"}),
    ];
    let f = contexts_to_facts("o/r", "abc", "main", None, &ctx, H_AT);
    let st = statuses(&f, "o/r");
    let got: Vec<(&str, CiState, Ms)> = st
        .iter()
        .map(|s| (s.context.as_str(), s.state, s.at))
        .collect();
    assert_eq!(
        got,
        [
            ("Vercel", CiState::Failure, t("2026-11-10T10:02:00Z")),
            ("slow", CiState::Running, t("2026-11-10T10:00:00Z")),
            (
                "ci/failsafe-deploy",
                CiState::Pending,
                t("2026-11-10T10:03:00Z")
            ),
            ("legacy", CiState::Error, H_AT),
        ]
    );
    assert_eq!(st[0].url.as_deref(), Some("https://example.com/x"));
    let d = deploys(&f, "o/r");
    assert_eq!(d.len(), 1);
    assert_eq!(
        d[0].state,
        DeployState::Running,
        "pending failsafe → running"
    );
    assert_eq!(d[0].finished, None);
    assert!(pipelines(&f, "o/r").is_empty());

    let err = vec![
        json!({"__typename": "StatusContext", "context": "ci/failsafe-deploy", "state": "ERROR", "createdAt": "2026-11-10T10:03:00Z"}),
    ];
    let f = contexts_to_facts("o/r", "abc", "main", None, &err, H_AT);
    let d = deploys(&f, "o/r");
    assert_eq!(d[0].state, DeployState::Failure);
    assert_eq!(d[0].finished, Some(t("2026-11-10T10:03:00Z")));
}

#[test]
fn run_url_fallbacks() {
    let mut j = job(
        "t",
        "COMPLETED",
        Some("SUCCESS"),
        run(11, Some("push"), "T"),
    );
    j["detailsUrl"] = Value::Null;
    let f = contexts_to_facts("o/r", "abc", "main", None, &[j], H_AT);
    assert!(
        matches!(&f[0], Fact::Pipeline(p) if p.url == "https://github.com/o/r/actions/runs/11")
    );
    let mut j = job(
        "t",
        "COMPLETED",
        Some("SUCCESS"),
        run(12, Some("push"), "T"),
    );
    j["detailsUrl"] = json!("https://github.com/o/r/runs/99");
    let f = contexts_to_facts("o/r", "abc", "main", None, &[j], H_AT);
    assert!(matches!(&f[0], Fact::Pipeline(p) if p.url == "https://github.com/o/r/runs/99"));
    // No created/started anywhere → now.
    let r = json!({"databaseId": 13, "workflow": {"name": "T"}});
    let mut j = job("t", "QUEUED", None, r);
    j["startedAt"] = Value::Null;
    let f = contexts_to_facts("o/r", "abc", "main", None, &[j], H_AT);
    assert!(matches!(&f[0], Fact::Pipeline(p) if p.created == H_AT && p.started.is_none()));
}

#[test]
fn rollup_and_check_state_tables() {
    use CiState as C;
    for (s, want) in [
        ("SUCCESS", C::Success),
        ("FAILURE", C::Failure),
        ("ERROR", C::Error),
        ("PENDING", C::Pending),
        ("EXPECTED", C::Pending),
        ("", C::None),
        ("weird", C::None),
    ] {
        assert_eq!(rollup_state(s), want, "{s}");
    }
    for (st, c, want) in [
        ("COMPLETED", Some("SUCCESS"), C::Success),
        ("COMPLETED", Some("FAILURE"), C::Failure),
        ("COMPLETED", Some("TIMED_OUT"), C::Failure),
        ("COMPLETED", Some("STARTUP_FAILURE"), C::Failure),
        ("COMPLETED", Some("CANCELLED"), C::Canceled),
        ("COMPLETED", Some("STALE"), C::Canceled),
        ("COMPLETED", Some("SKIPPED"), C::Skipped),
        ("COMPLETED", Some("NEUTRAL"), C::Skipped),
        ("COMPLETED", Some("ACTION_REQUIRED"), C::Blocked),
        ("COMPLETED", None, C::None),
        ("IN_PROGRESS", None, C::Running),
        ("QUEUED", None, C::Pending),
        ("PENDING", None, C::Pending),
        ("WAITING", None, C::Pending),
        ("REQUESTED", None, C::Pending),
        ("", None, C::None),
    ] {
        assert_eq!(check_state(st, c), want, "{st} {c:?}");
    }
}

// ------------------------------------------------------------------ PRs

#[test]
fn pr_page_maps_every_node() {
    let nodes = pr_nodes();
    assert_eq!(nodes.len(), 8);
    let facts: Vec<PrFact> = nodes
        .iter()
        .map(|n| pr_fact(n, P_AT).expect("pr").0)
        .collect();
    for f in &facts {
        assert_eq!(f.state, PrState::Open);
        assert_eq!(f.observed, P_AT);
        assert!(!f.draft);
        assert_eq!(f.merged_at, None);
        assert_eq!(f.merge_sha, None);
        assert_eq!(f.review, None);
        assert_eq!(f.ai, None);
        assert_eq!(
            f.url,
            format!("https://github.com/{}/pull/{}", f.repo, f.number)
        );
        // CodeQL never shows up as a check.
        assert!(
            f.checks
                .iter()
                .all(|c| !c.name.contains("CodeQL") && !c.name.contains("Analyze"))
        );
    }
    let bots: Vec<u64> = facts.iter().filter(|f| f.bot).map(|f| f.number).collect();
    assert_eq!(bots, [143, 100]);
    let conflicting: Vec<u64> = facts
        .iter()
        .filter(|f| f.mergeable == Some(Mergeable::Conflicting))
        .map(|f| f.number)
        .collect();
    assert_eq!(conflicting, [267]);
}

#[test]
fn pr_human_with_pending_woodpecker() {
    let (f, extra) = pr_fact(&pr_node("Northwind-EMS/ember-api", 102), P_AT).unwrap();
    assert_eq!(f.repo, "Northwind-EMS/ember-api");
    assert_eq!(f.number, 102);
    assert_eq!(f.title, "feat: neutral change 2");
    assert_eq!(f.author, "dev-02");
    assert!(!f.bot);
    assert_eq!(f.head_sha, "aad98fd9b169395a00cd2260d34490c1d1c0e6cb");
    assert_eq!(f.head, "feature/change-1");
    assert_eq!(f.base, "main");
    assert_eq!(f.created, t("2026-11-10T19:37:36Z"));
    assert_eq!(f.updated, t("2026-11-10T19:37:36Z"));
    assert_eq!(f.mergeable, Some(Mergeable::Mergeable));
    let checks: Vec<(&str, CiState, bool)> = f
        .checks
        .iter()
        .map(|c| (c.name.as_str(), c.state, c.required))
        .collect();
    assert_eq!(
        checks,
        [
            ("ci/woodpecker/pr/ci", CiState::Pending, true),
            ("ci/woodpecker/pr/security", CiState::Success, true)
        ]
    );
    // Open PR: the head's contexts become facts too (statuses on the head sha).
    let st: Vec<&StatusFact> = extra
        .iter()
        .filter_map(|x| match x {
            Fact::Status(s) => Some(s),
            _ => None,
        })
        .collect();
    assert_eq!(st.len(), 2);
    assert!(st.iter().all(|s| s.sha == f.head_sha && s.repo == f.repo));
    assert_eq!(extra.len(), 2, "CodeQL runs make no pipeline");
}

#[test]
fn pr_actions_checks_are_named_workflow_slash_job() {
    let (f, extra) = pr_fact(&pr_node("Northwind-Labs/ridge-code", 305), P_AT).unwrap();
    assert_eq!(f.base, "northwind/main");
    let names: Vec<&str> = f.checks.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "DMG Check / Build unsigned arm64 DMG",
            "Desktop macOS Preview / Build preview JS bundle",
            "DMG Check / Build unsigned arm64 DMG",
            "ci/woodpecker/pr/pr-check",
            "ci/woodpecker/pr/ci"
        ]
    );
    let req: Vec<bool> = f.checks.iter().map(|c| c.required).collect();
    assert_eq!(req, [false, false, false, true, true]);
    // Three runs → three PR pipelines on the head, tagged with the PR.
    let ps: Vec<&Pipeline> = extra
        .iter()
        .filter_map(|x| match x {
            Fact::Pipeline(p) => Some(p),
            _ => None,
        })
        .collect();
    assert_eq!(ps.len(), 3);
    for p in &ps {
        assert_eq!(p.event, PipelineEvent::PullRequest);
        assert_eq!(p.pr, Some(305));
        assert_eq!(p.branch, "feature/change-6");
        assert_eq!(p.sha, f.head_sha);
        assert!(!p.deploy);
    }
    let ids: Vec<&str> = ps.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        ids,
        ["gha:42875219269", "gha:42882258502", "gha:42882258547"]
    );
}

#[test]
fn pr_bots_and_failures() {
    let (f, _) = pr_fact(&pr_node("Northwind-Labs/tundra-lab", 143), P_AT).unwrap();
    assert!(f.bot);
    assert_eq!(f.author, "dependabot");
    let checks: Vec<(&str, CiState)> = f
        .checks
        .iter()
        .map(|c| (c.name.as_str(), c.state))
        .collect();
    assert_eq!(
        checks,
        [
            ("ci/woodpecker/pr/security", CiState::Failure),
            ("ci/woodpecker/pr/ci", CiState::Success)
        ]
    );
    // Without __typename, the login decides.
    let mut n = pr_node("Northwind-Labs/tundra-lab", 143);
    n["author"] = json!({"login": "renovate[bot]"});
    assert!(pr_fact(&n, P_AT).unwrap().0.bot);
    n["author"] = json!({"login": "dependabot"});
    assert!(pr_fact(&n, P_AT).unwrap().0.bot);
    n["author"] = json!({"__typename": "User", "login": "dev-07"});
    assert!(!pr_fact(&n, P_AT).unwrap().0.bot);
    // A deleted account.
    n["author"] = Value::Null;
    let (f, _) = pr_fact(&n, P_AT).unwrap();
    assert_eq!(f.author, "ghost");
    assert!(!f.bot);
}

#[test]
fn pr_merged_closed_review_and_mergeable_variants() {
    let mut n = pr_node("Northwind-EMS/ember-api", 100);
    n["state"] = json!("MERGED");
    n["mergedAt"] = json!("2026-11-10T18:00:00Z");
    n["mergeCommit"] = json!({"oid": "deadbeef"});
    n["reviewDecision"] = json!("APPROVED");
    n["isDraft"] = json!(false);
    let (f, extra) = pr_fact(&n, P_AT).unwrap();
    assert_eq!(f.state, PrState::Merged);
    assert_eq!(f.merged_at, Some(t("2026-11-10T18:00:00Z")));
    assert_eq!(f.merge_sha.as_deref(), Some("deadbeef"));
    assert_eq!(f.review.as_deref(), Some("approved"));
    assert!(extra.is_empty(), "a merged PR's head is history");
    n["state"] = json!("CLOSED");
    assert_eq!(pr_fact(&n, P_AT).unwrap().0.state, PrState::Closed);
    n["reviewDecision"] = json!("CHANGES_REQUESTED");
    n["mergeable"] = json!("UNKNOWN");
    n["isDraft"] = json!(true);
    let (f, _) = pr_fact(&n, P_AT).unwrap();
    assert_eq!(f.review.as_deref(), Some("changes_requested"));
    assert_eq!(f.mergeable, Some(Mergeable::Unknown));
    assert!(f.draft);
    n["mergeable"] = Value::Null;
    n["reviewDecision"] = json!("REVIEW_REQUIRED");
    let (f, _) = pr_fact(&n, P_AT).unwrap();
    assert_eq!(f.mergeable, None);
    assert_eq!(f.review.as_deref(), Some("review_required"));
    // Unparseable nodes (search can return issues) are skipped.
    assert!(pr_fact(&json!({"number": 1}), P_AT).is_none());
    assert!(pr_fact(&json!({"repository": {"nameWithOwner": "o/r"}}), P_AT).is_none());
    // No head sha → no head facts.
    let mut n = pr_node("Northwind-EMS/ember-api", 102);
    n["headRefOid"] = Value::Null;
    assert!(pr_fact(&n, P_AT).unwrap().1.is_empty());
}

#[test]
fn a_failed_job_opens_on_its_failed_step() {
    use switchyard::adapters::github::failed_step_of;
    let job = serde_json::json!({"id": 22, "steps": [
        {"name": "Set up job", "number": 1, "conclusion": "success"},
        {"name": "Build", "number": 2, "conclusion": "success"},
        {"name": "Test", "number": 3, "conclusion": "failure"},
        {"name": "Upload", "number": 4, "conclusion": "skipped"}
    ]});
    assert_eq!(failed_step_of(&job), Some(3));
    let timeout = serde_json::json!({"steps": [{"number": 5, "conclusion": "timed_out"}]});
    assert_eq!(failed_step_of(&timeout), Some(5));
    let none = serde_json::json!({"steps": [{"number": 1, "conclusion": "success"}]});
    assert_eq!(failed_step_of(&none), None);
    assert_eq!(failed_step_of(&serde_json::json!({})), None);
}
