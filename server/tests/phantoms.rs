//! What Live and the Yard showed that was not so (Felipe, Nov 12): a deploy that a manual
//! rerun had fixed still "failed", a killed deploy read as failed, a CodeQL check turned
//! main lines red, a repo without CI "waited" for a run, a finished GitHub Actions run
//! stayed "running". Each case on the shapes the adapters really produce.

use serde_json::{Value, json};
use switchyard::adapters::github::{
    deploy_runs_facts, main_line_state, repo_page_facts, run_closed,
};
use switchyard::adapters::woodpecker::{Mapper, WpPipeline};
use switchyard::facts::*;
use switchyard::model::*;
use switchyard::store::{Store, StoreConfig};

const NOW: Ms = 1_794_340_000_000;
const REPO: &str = "acme/api";
const SHA: &str = "4d2fddbd901248b3566e4324733f9e19f9172d51";

fn store(facts: Vec<Fact>) -> Store {
    let mut s = Store::new(StoreConfig {
        orgs: vec!["acme".into()],
    });
    for f in facts {
        s.apply(f, false);
    }
    s.flush(NOW);
    s
}

fn repos(wid: Option<u64>) -> Fact {
    Fact::Repos(RepoList {
        source: "github:acme".into(),
        observed: NOW - 60_000,
        repos: vec![RepoMeta {
            id: REPO.into(),
            default_branch: "main".into(),
            woodpecker_id: wid,
            pushed_at: None,
            archived: false,
        }],
    })
}

fn get(s: &Store, k: Kind, id: &str) -> Option<Value> {
    s.table(k).get(id).map(|j| serde_json::from_str(j).unwrap())
}

fn mapper() -> Mapper {
    Mapper {
        public_url: "https://ci.example".into(),
        agents: Default::default(),
    }
}

/// A Roadrunner run of SHA as Woodpecker reports it: `ci` passed, `deploy` as given.
fn wp(n: u64, event: &str, deploy: &str, at: Ms) -> Vec<Fact> {
    let t = at / 1000;
    let status = match deploy {
        "success" => "success",
        "running" => "running",
        "killed" => "killed",
        _ => "failure",
    };
    let raw: WpPipeline = serde_json::from_value(json!({
        "number": n, "event": event, "status": status, "branch": "main", "commit": SHA,
        "created": t - 60, "started": t - 50, "finished": if deploy == "running" { 0 } else { t },
        "workflows": [
            {"id": 1, "name": "ci", "state": "success", "started": t - 50, "finished": t - 30},
            {"id": 2, "name": "deploy", "state": deploy, "started": t - 30,
             "finished": if deploy == "running" { 0 } else { t }}
        ]
    }))
    .unwrap();
    mapper().facts(REPO, 7, &raw)
}

#[test]
fn a_manual_redeploy_that_passes_supersedes_the_failed_push_deploy() {
    // edge-smoke 4d2fddb: push #6 failed at deploy, manual #7 failed too, manual #8 passed.
    let mut f = vec![repos(Some(7))];
    f.extend(wp(6, "push", "failure", NOW - 30 * 60_000));
    f.extend(wp(7, "manual", "failure", NOW - 25 * 60_000));
    f.extend(wp(8, "manual", "success", NOW - 20 * 60_000));
    let s = store(f);
    let d = s.combined_deploy(REPO, SHA).expect("the commit's deploy");
    assert_eq!(d.state, DeployState::Success);
    let c = get(&s, Kind::Commit, &format!("{REPO}@{SHA}")).unwrap();
    assert_eq!(c["stage"], "deployed");
    assert_eq!(s.commit_ci(REPO, SHA), CiState::Success);
}

#[test]
fn a_killed_deploy_is_no_failed_deploy() {
    // infra-management #464: deploy-otel killed when #465 (a newer push) started.
    let mut f = vec![repos(Some(7))];
    f.extend(wp(464, "push", "running", NOW - 10 * 60_000));
    let s = store(f.clone());
    assert_eq!(
        s.combined_deploy(REPO, SHA).unwrap().state,
        DeployState::Running
    );
    f.extend(wp(464, "push", "killed", NOW - 9 * 60_000));
    let s = store(f);
    assert!(
        s.combined_deploy(REPO, SHA).is_none(),
        "killed: neither deployed nor failed, and no longer running"
    );
    assert!(get(&s, Kind::Deploy, &format!("{REPO}@{SHA}")).is_none());
}

#[test]
fn a_killed_redeploy_does_not_undo_a_passed_one() {
    let mut f = vec![repos(Some(7))];
    f.extend(wp(8, "manual", "success", NOW - 20 * 60_000));
    f.extend(wp(9, "manual", "killed", NOW - 10 * 60_000));
    let s = store(f);
    assert_eq!(
        s.combined_deploy(REPO, SHA).unwrap().state,
        DeployState::Success
    );
}

#[test]
fn a_github_redeploy_by_hand_supersedes_the_failed_deploy_run() {
    // PixelView 9c8f667: "Deploy App" (push) failed; "First Deploy App" (workflow_dispatch)
    // passed a minute later. The dispatch run is not in the commit's check rollup: the
    // recheck reads the commit's runs over REST.
    let failed = Fact::Deploy(DeployFact {
        app: String::new(),
        repo: REPO.into(),
        sha: SHA.into(),
        via: DeployVia::Gha,
        state: DeployState::Failure,
        started: NOW - 120_000,
        finished: Some(NOW - 100_000),
        pipeline: Some(ids::gha_pipeline(43254065544)),
        url: None,
        source: "gha".into(),
        canceled: false,
    });
    let runs = json!({"total_count": 4, "workflow_runs": [
        {"id": 43254077990u64, "name": "First Deploy App", "event": "workflow_dispatch",
         "status": "completed", "conclusion": "success", "head_sha": SHA,
         "created_at": "2026-11-12T16:01:17Z", "run_started_at": "2026-11-12T16:01:17Z",
         "updated_at": "2026-11-12T16:03:40Z", "html_url": "https://github.com/acme/api/actions/runs/43254077990"},
        {"id": 43254065544u64, "name": "Deploy App", "event": "push",
         "status": "completed", "conclusion": "failure", "head_sha": SHA,
         "created_at": "2026-11-12T16:01:05Z", "run_started_at": "2026-11-12T16:01:05Z",
         "updated_at": "2026-11-12T16:01:16Z"},
        {"id": 1u64, "name": "Deploy App", "event": "pull_request",
         "status": "completed", "conclusion": "success", "head_sha": SHA,
         "created_at": "2026-11-12T16:00:00Z"},
        {"id": 2u64, "name": "ci", "event": "push",
         "status": "completed", "conclusion": "success", "head_sha": SHA,
         "created_at": "2026-11-12T16:01:05Z"}
    ]});
    let got = deploy_runs_facts(REPO, SHA, &runs);
    assert_eq!(
        got.len(),
        2,
        "the two deploy runs outside pull requests: {got:?}"
    );
    let Fact::Deploy(d) = &got[0] else { panic!() };
    assert_eq!(
        (d.state, d.via, d.source.as_str()),
        (DeployState::Success, DeployVia::GhaFallback, "gha")
    );
    let mut f = vec![repos(None), failed];
    f.extend(got);
    let s = store(f);
    assert_eq!(
        s.combined_deploy(REPO, SHA).unwrap().state,
        DeployState::Success
    );
}

fn status(ctx: &str, state: &str, at: &str) -> Value {
    json!({"__typename": "StatusContext", "context": ctx, "state": state, "createdAt": at})
}

fn check(name: &str, conclusion: &str, wf: &str, event: &str) -> Value {
    json!({"__typename": "CheckRun", "name": name, "status": "COMPLETED", "conclusion": conclusion,
           "checkSuite": {"app": {"slug": "github-actions"},
                          "workflowRun": {"event": event, "workflow": {"name": wf}}}})
}

fn rollup(state: &str, nodes: Vec<Value>) -> Value {
    json!({"state": state, "contexts": {"totalCount": nodes.len(), "nodes": nodes}})
}

#[test]
fn the_main_line_reads_the_repos_own_ci() {
    use CiState::*;
    // PhiMech 4fdd654: CodeQL's "Analyze (actions)" failed, the repo's CI passed.
    let r = rollup(
        "FAILURE",
        vec![
            check("Analyze (actions)", "FAILURE", "CodeQL", "dynamic"),
            check("Analyze (python)", "SUCCESS", "CodeQL", "dynamic"),
            status("ci/woodpecker/push/ci", "SUCCESS", "2026-11-09T22:29:08Z"),
        ],
    );
    assert_eq!(main_line_state(&r), Success);
    // Octatracker-Controller: CodeQL only, no CI of its own: no state, not red.
    let r = rollup(
        "FAILURE",
        vec![check("Analyze (c-cpp)", "FAILURE", "CodeQL", "dynamic")],
    );
    assert_eq!(main_line_state(&r), None);
    // Dependabot's update jobs are not the repo's CI either.
    let r = rollup(
        "FAILURE",
        vec![
            check("Dependabot", "FAILURE", "Dependabot Updates", "dynamic"),
            status("ci/woodpecker/push/ci", "SUCCESS", "2026-11-09T22:29:08Z"),
        ],
    );
    assert_eq!(main_line_state(&r), Success);
    // net-control-plane 4d121d7: the push deploy failed, the manual rerun passed.
    let r = rollup(
        "FAILURE",
        vec![
            status("ci/woodpecker/push/ci", "SUCCESS", "2026-11-11T04:57:25Z"),
            status(
                "ci/woodpecker/push/deploy",
                "FAILURE",
                "2026-11-11T04:57:31Z",
            ),
            status("ci/woodpecker/manual/ci", "SUCCESS", "2026-11-11T05:01:18Z"),
            status(
                "ci/woodpecker/manual/deploy",
                "SUCCESS",
                "2026-11-11T05:01:37Z",
            ),
        ],
    );
    assert_eq!(main_line_state(&r), Success);
    // kit 94e0fab: only its pull request's security run failed (the PR's, not main's).
    let r = rollup(
        "FAILURE",
        vec![
            status(
                "ci/woodpecker/pr/security",
                "FAILURE",
                "2026-11-12T10:00:00Z",
            ),
            status("ci/woodpecker/pr/ci", "SUCCESS", "2026-11-12T10:00:00Z"),
            check("test", "SUCCESS", "ci", "pull_request"),
        ],
    );
    assert_eq!(main_line_state(&r), None);
    // The repo's own failures stay red: a failed push deploy, a failed GHA workflow.
    let r = rollup(
        "FAILURE",
        vec![
            status("ci/woodpecker/push/ci", "SUCCESS", "2026-11-12T10:00:00Z"),
            status(
                "ci/woodpecker/push/deploy",
                "FAILURE",
                "2026-11-12T10:01:00Z",
            ),
        ],
    );
    assert_eq!(main_line_state(&r), Failure);
    let r = rollup(
        "FAILURE",
        vec![check("Build mkdocs site", "FAILURE", "docs", "push")],
    );
    assert_eq!(main_line_state(&r), Failure);
    // A list GitHub cut short: its own state.
    let r = json!({"state": "FAILURE", "contexts": {"totalCount": 50,
                   "nodes": [check("Analyze (actions)", "FAILURE", "CodeQL", "dynamic")]}});
    assert_eq!(main_line_state(&r), Failure);
}

#[test]
fn a_codeql_failure_does_not_turn_a_quiet_main_line_red() {
    // The inventory's history (commits older than a day): the dots come from the rollup.
    let node = json!({
        "nameWithOwner": REPO, "pushedAt": "2026-11-09T22:30:00Z", "isPrivate": false,
        "defaultBranchRef": {"name": "main", "target": {"history": {"nodes": [
            {"oid": SHA, "committedDate": "2026-11-09T22:27:00Z", "messageHeadline": "x",
             "author": {"name": "Dev", "user": {"login": "dev"}},
             "statusCheckRollup": rollup("FAILURE", vec![
                 check("Analyze (actions)", "FAILURE", "CodeQL", "dynamic"),
                 status("ci/woodpecker/push/ci", "SUCCESS", "2026-11-09T22:29:08Z")])},
            {"oid": "1111111111111111111111111111111111111111",
             "committedDate": "2026-11-09T20:00:00Z", "messageHeadline": "y",
             "author": {"name": "Dev", "user": {"login": "dev"}},
             "statusCheckRollup": rollup("FAILURE", vec![
                 check("Analyze (actions)", "FAILURE", "CodeQL", "dynamic")])}
        ]}}}
    });
    let (metas, facts) = repo_page_facts(&[node], false, NOW);
    let mut f = vec![Fact::Repos(RepoList {
        source: "github:acme".into(),
        observed: NOW,
        repos: metas,
    })];
    f.extend(facts);
    let s = store(f);
    let r = get(&s, Kind::Repo, REPO).unwrap();
    assert_eq!(r["main"]["state"], "success", "{}", r["main"]);
    assert!(r["main"].get("culprit").is_none());
}

#[test]
fn a_pull_requests_runs_do_not_color_the_main_line() {
    // A fast-forward merge lands the PR's head on main with its PR pipeline.
    let pr = |n: u64, state: CiState, event: PipelineEvent| {
        Fact::Pipeline(Pipeline {
            id: ids::wp_pipeline(REPO, n),
            lane: LaneKind::Roadrunner,
            repo: REPO.into(),
            number: n,
            sha: SHA.into(),
            branch: "main".into(),
            git_ref: None,
            event,
            state,
            created: NOW - 600_000,
            started: Some(NOW - 590_000),
            finished: Some(NOW - 500_000),
            queue_pos: None,
            expected_ms: None,
            engine: None,
            title: Some("x".into()),
            author: Some("dev".into()),
            pr: (event == PipelineEvent::PullRequest).then_some(5),
            deploy: false,
            flaky: false,
            workflows: vec![],
            url: "https://ci.example/x".into(),
            links: Default::default(),
        })
    };
    let commit = Fact::Commit(CommitFact {
        repo: REPO.into(),
        sha: SHA.into(),
        branch: "main".into(),
        title: "merge".into(),
        author: "dev".into(),
        bot: false,
        at: NOW - 600_000,
        prio: 2,
    });
    let s = store(vec![
        repos(Some(7)),
        commit.clone(),
        pr(1, CiState::Failure, PipelineEvent::PullRequest),
    ]);
    assert_eq!(
        s.commit_ci(REPO, SHA),
        CiState::Failure,
        "the commit itself"
    );
    assert_eq!(s.main_commit_ci(REPO, SHA), CiState::None, "not main's");
    let r = get(&s, Kind::Repo, REPO).unwrap();
    assert_ne!(r["main"]["state"], "failure");
    let s = store(vec![
        repos(Some(7)),
        commit,
        pr(1, CiState::Failure, PipelineEvent::PullRequest),
        pr(2, CiState::Success, PipelineEvent::Push),
    ]);
    assert_eq!(
        get(&s, Kind::Repo, REPO).unwrap()["main"]["state"],
        "success"
    );
}

fn commit(author: &str, at: Ms) -> Fact {
    Fact::Commit(CommitFact {
        repo: REPO.into(),
        sha: SHA.into(),
        branch: "main".into(),
        title: "switchyard 0.1.7".into(),
        author: author.into(),
        bot: author.contains("[bot]"),
        at,
        prio: 2,
    })
}

#[test]
fn a_push_no_ci_will_build_does_not_wait() {
    let id = format!("{REPO}@{SHA}");
    // homebrew-tap 051283d: no Roadrunner, a github-actions[bot] push (GITHUB_TOKEN pushes
    // start no workflow): done at once, never "waiting for CI".
    let s = store(vec![
        repos(None),
        commit("github-actions[bot]", NOW - 60_000),
    ]);
    assert_eq!(get(&s, Kind::Commit, &id).unwrap()["stage"], "done");
    // A repo that never ran CI: done as well.
    let s = store(vec![repos(None), commit("dev", NOW - 60_000)]);
    assert_eq!(get(&s, Kind::Commit, &id).unwrap()["stage"], "done");
    // A Roadrunner repo builds every push, a bot's too: it waits.
    let s = store(vec![
        repos(Some(7)),
        commit("github-actions[bot]", NOW - 60_000),
    ]);
    assert_eq!(get(&s, Kind::Commit, &id).unwrap()["stage"], "pushed");
}

#[test]
fn a_github_run_no_poll_reports_any_more_is_closed_from_rest() {
    let p = Pipeline {
        id: ids::gha_pipeline(43271871039),
        lane: LaneKind::Gha,
        repo: REPO.into(),
        number: 43271871039,
        sha: SHA.into(),
        branch: "main".into(),
        git_ref: None,
        event: PipelineEvent::Push,
        state: CiState::Running,
        created: NOW - 600_000,
        started: Some(NOW - 590_000),
        finished: None,
        queue_pos: None,
        expected_ms: None,
        engine: None,
        title: Some("ci".into()),
        author: None,
        pr: None,
        deploy: false,
        flaky: false,
        workflows: vec![Workflow {
            name: "ci".into(),
            state: CiState::Running,
            started: Some(NOW - 590_000),
            finished: None,
            engine: None,
            steps: vec![Step {
                name: "test".into(),
                state: CiState::Running,
                started: Some(NOW - 590_000),
                finished: None,
                exit_code: None,
                cached: None,
                cluster: None,
                url: None,
            }],
            url: None,
        }],
        url: "https://github.com/acme/api/actions/runs/43271871039".into(),
        links: Default::default(),
    };
    assert!(run_closed(&p, &json!({"status": "in_progress"})).is_none());
    let q = run_closed(
        &p,
        &json!({"status": "completed", "conclusion": "success",
                "updated_at": "2026-11-12T17:47:00Z"}),
    )
    .unwrap();
    assert_eq!(q.state, CiState::Success);
    assert!(q.finished.is_some());
    assert_eq!(q.workflows[0].state, CiState::Success);
    assert_eq!(q.workflows[0].steps[0].state, CiState::Success);
    // The closed run replaces the running one in the store.
    let s = store(vec![Fact::Pipeline(p.clone()), Fact::Pipeline(q)]);
    let v = get(&s, Kind::Pipeline, &p.id).unwrap();
    assert_eq!(v["state"], "success");
}

#[test]
fn a_github_deploy_run_that_failed_is_no_red_main_once_the_commit_deployed() {
    // PixelView 9c8f667: the push's "Deploy App" run failed (a GHA pipeline, deploy-named),
    // "First Deploy App" (workflow_dispatch) deployed the commit a minute later.
    let run = |n: u64, title: &str, state: CiState| {
        Fact::Pipeline(Pipeline {
            id: ids::gha_pipeline(n),
            lane: LaneKind::Gha,
            repo: REPO.into(),
            number: n,
            sha: SHA.into(),
            branch: "main".into(),
            git_ref: None,
            event: PipelineEvent::Push,
            state,
            created: NOW - 600_000,
            started: Some(NOW - 590_000),
            finished: Some(NOW - 500_000),
            queue_pos: None,
            expected_ms: None,
            engine: None,
            title: Some(title.into()),
            author: None,
            pr: None,
            deploy: title.to_ascii_lowercase().contains("deploy"),
            flaky: false,
            workflows: vec![],
            url: "https://github.com/acme/api/actions/runs/1".into(),
            links: Default::default(),
        })
    };
    let deploy = |n: u64, state: DeployState, at: Ms| {
        Fact::Deploy(DeployFact {
            app: String::new(),
            repo: REPO.into(),
            sha: SHA.into(),
            via: DeployVia::Gha,
            state,
            started: at,
            finished: Some(at + 10_000),
            pipeline: Some(ids::gha_pipeline(n)),
            url: None,
            source: "gha".into(),
            canceled: false,
        })
    };
    let base = vec![
        repos(None),
        commit("dev", NOW - 600_000),
        run(1, "ci", CiState::Success),
        run(2, "Deploy App", CiState::Failure),
        deploy(2, DeployState::Failure, NOW - 590_000),
    ];
    let s = store(base.clone());
    assert_eq!(
        get(&s, Kind::Repo, REPO).unwrap()["main"]["state"],
        "failure"
    );
    let mut f = base;
    f.push(deploy(3, DeployState::Success, NOW - 400_000));
    let s = store(f);
    assert_eq!(
        s.combined_deploy(REPO, SHA).unwrap().state,
        DeployState::Success
    );
    assert_eq!(
        get(&s, Kind::Repo, REPO).unwrap()["main"]["state"],
        "success"
    );
    // The commit itself still lists the failed run (its own CI view is unchanged).
    assert_eq!(s.commit_ci(REPO, SHA), CiState::Failure);
}
