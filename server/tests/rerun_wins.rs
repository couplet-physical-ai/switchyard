//! A manual run of a commit reruns its push pipeline: the newer of the two decides the
//! commit's CI state and so its repo's main line. A passing manual rerun clears an older
//! failed push run (the repo is green, not red until that run ages out of the window).

use serde_json::Value;
use switchyard::facts::*;
use switchyard::model::*;
use switchyard::store::{Store, StoreConfig};

const NOW: Ms = 1_794_340_000_000;
const REPO: &str = "acme/api";
const SHA: &str = "1111111111111111111111111111111111111111";

/// A Roadrunner run as the Woodpecker adapter maps it: a `ci` workflow, a `deploy` one
/// when `deploy`, and the pipeline's deploy flag only on a push run.
fn run(n: u64, event: PipelineEvent, state: CiState, deploy: bool) -> Fact {
    let finished = NOW - 60_000 * (100 - n as i64);
    let wf = |name: &str| Workflow {
        name: name.into(),
        state,
        started: Some(finished - 25_000),
        finished: Some(finished),
        engine: None,
        steps: vec![],
        url: None,
    };
    let mut workflows = vec![wf("ci")];
    if deploy {
        workflows.push(wf("deploy"));
    }
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
        created: finished - 30_000,
        started: Some(finished - 25_000),
        finished: Some(finished),
        queue_pos: None,
        expected_ms: None,
        engine: None,
        title: Some("change".into()),
        author: Some("dev".into()),
        pr: None,
        deploy: deploy && event == PipelineEvent::Push,
        flaky: false,
        workflows,
        url: "https://ci.example/x".into(),
        links: Default::default(),
    })
}

fn store(facts: Vec<Fact>) -> Store {
    let mut s = Store::new(StoreConfig {
        orgs: vec!["acme".into()],
        ..Default::default()
    });
    for f in facts {
        s.apply(f, false);
    }
    s.flush(NOW);
    s
}

fn main_state(s: &Store) -> String {
    let r: Value = serde_json::from_str(&s.table(Kind::Repo)[REPO]).unwrap();
    r["main"]["state"].as_str().unwrap().to_string()
}

#[test]
fn a_passing_manual_rerun_clears_an_older_failed_push_run() {
    use CiState::*;
    use PipelineEvent::*;
    // net-control-plane on Nov 11: push #10 (ci + deploy) failed at deploy, the manual
    // run #11 of the same sha passed everything.
    let s = store(vec![
        run(10, Push, Failure, true),
        run(11, Manual, Success, true),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Success);
    assert_eq!(main_state(&s), "success");
    // edge-smoke 4d2fddb: push #6 failed at deploy, manual #7 too, manual #8 passed.
    let s = store(vec![
        run(6, Push, Failure, true),
        run(7, Manual, Failure, true),
        run(8, Manual, Success, true),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Success);
    assert_eq!(main_state(&s), "success");
    // Error (an infra blip) the same way.
    let s = store(vec![
        run(10, Push, Error, false),
        run(11, Manual, Success, false),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Success);
}

#[test]
fn the_newer_run_decides_either_way() {
    use CiState::*;
    use PipelineEvent::*;
    // A failing manual rerun turns a green push red.
    let s = store(vec![
        run(10, Push, Success, false),
        run(11, Manual, Failure, false),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Failure);
    assert_eq!(main_state(&s), "failure");
    // An older manual pass does not clear a newer failed push.
    let s = store(vec![
        run(10, Manual, Success, false),
        run(11, Push, Failure, false),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Failure);
    // Order of arrival does not matter, only the run number.
    let s = store(vec![
        run(11, Manual, Success, false),
        run(10, Push, Failure, false),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Success);
}

#[test]
fn other_events_and_deploy_runs_still_count_on_their_own() {
    use CiState::*;
    use PipelineEvent::*;
    // A pull request's failed run is its own line: a later push pass does not clear it.
    let s = store(vec![
        run(10, PullRequest, Failure, false),
        run(11, Push, Success, false),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Failure);
    // A manual CI-only pass does not clear a failed deploy run.
    let s = store(vec![
        run(10, Push, Failure, true),
        run(11, Manual, Success, false),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Failure);
}

fn status(context: &str, state: CiState, at: Ms) -> Fact {
    Fact::Status(StatusFact {
        repo: REPO.into(),
        sha: SHA.into(),
        context: context.into(),
        state,
        at,
        url: None,
    })
}

#[test]
fn without_its_pipelines_the_statuses_follow_the_same_rule() {
    use CiState::*;
    // edge-smoke 4d2fddb on Nov 12: its pipelines are older than the fetch window, so
    // only GitHub's statuses are left: push #6 failed at deploy, manual #8 passed.
    let s = store(vec![
        status("ci/woodpecker/push/ci", Success, NOW - 9_000),
        status("ci/woodpecker/push/deploy", Failure, NOW - 9_000),
        status("ci/woodpecker/manual/ci", Success, NOW - 5_000),
        status("ci/woodpecker/manual/deploy", Success, NOW - 5_000),
        status("ci/woodpecker/manual/setup", Success, NOW - 5_000),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Success);
    // viewer-updates b6fe4e3: the manual deploy failed too, the commit stays red.
    let s = store(vec![
        status("ci/woodpecker/manual/ci", Success, NOW - 5_000),
        status("ci/woodpecker/manual/deploy", Failure, NOW - 5_000),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Failure);
    // A newer failed push after a manual pass is red; other contexts still count.
    let s = store(vec![
        status("ci/woodpecker/manual/deploy", Success, NOW - 9_000),
        status("ci/woodpecker/push/deploy", Failure, NOW - 5_000),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Failure);
    let s = store(vec![
        status("ci/woodpecker/push/deploy", Failure, NOW - 9_000),
        status("ci/woodpecker/manual/deploy", Success, NOW - 5_000),
        status("ci/woodpecker/cron/renovate", Failure, NOW - 1_000),
    ]);
    assert_eq!(s.commit_ci(REPO, SHA), Failure);
}
