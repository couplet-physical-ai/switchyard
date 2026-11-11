//! A failed GitHub Actions job's `Step.url` opens on its failed step: one REST read
//! per failed job (cached), never for passing or running jobs.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::extract::Path;
use axum::response::IntoResponse;
use axum::routing::get;
use serde_json::json;
use switchyard::adapters::github::GithubAdapter;
use switchyard::facts::Fact;
use switchyard::model::*;
use switchyard::runtime::Adapters;

static HITS: AtomicUsize = AtomicUsize::new(0);

async fn upstream() -> String {
    let app = Router::new().route(
        "/repos/{o}/{r}/actions/jobs/{id}",
        get(|Path((_, _, id)): Path<(String, String, u64)>| async move {
            HITS.fetch_add(1, Ordering::SeqCst);
            match id {
                22 => axum::Json(json!({"id": 22, "steps": [
                    {"name": "Set up job", "number": 1, "conclusion": "success"},
                    {"name": "Test", "number": 3, "conclusion": "failure"}]}))
                .into_response(),
                _ => axum::http::StatusCode::NOT_FOUND.into_response(),
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://{a}")
}

fn job(name: &str, state: CiState, id: u64) -> Step {
    Step {
        name: name.into(),
        state,
        started: Some(1),
        finished: (state != CiState::Running).then_some(2),
        exit_code: None,
        cached: None,
        cluster: None,
        url: Some(format!(
            "https://github.com/acme/api/actions/runs/9/job/{id}"
        )),
    }
}

fn run() -> Fact {
    Fact::Pipeline(Pipeline {
        id: "gha:9".into(),
        lane: LaneKind::Gha,
        repo: "acme/api".into(),
        number: 9,
        sha: "abc".into(),
        branch: "main".into(),
        git_ref: None,
        event: PipelineEvent::Push,
        state: CiState::Failure,
        created: 1,
        started: Some(1),
        finished: Some(2),
        queue_pos: None,
        expected_ms: None,
        engine: None,
        title: None,
        author: None,
        pr: None,
        deploy: false,
        flaky: false,
        workflows: vec![Workflow {
            name: "ci".into(),
            state: CiState::Failure,
            started: Some(1),
            finished: Some(2),
            engine: None,
            steps: vec![
                job("test", CiState::Failure, 22),
                job("lint", CiState::Success, 23),
                job("e2e", CiState::Running, 24),
                job("setup-only", CiState::Failure, 25),
            ],
            url: None,
        }],
        url: "https://github.com/acme/api/actions/runs/9".into(),
        links: Default::default(),
    })
}

fn urls(f: &[Fact]) -> Vec<String> {
    let Fact::Pipeline(p) = &f[0] else { panic!() };
    p.workflows[0]
        .steps
        .iter()
        .map(|s| s.url.clone().unwrap())
        .collect()
}

#[tokio::test]
async fn failed_jobs_open_on_their_failed_step() {
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let a = GithubAdapter {
        api: upstream().await,
        token: "t".into(),
        orgs: vec![],
        http: reqwest::Client::new(),
        tx,
        failed_steps: Default::default(),
        adapters: Arc::new(Adapters::default()),
        clock: Arc::new(|| 0),
    };
    let mut f = vec![run()];
    a.anchor_failed_steps(&mut f).await;
    let u = urls(&f);
    assert_eq!(
        u[0],
        "https://github.com/acme/api/actions/runs/9/job/22#step:3:1"
    );
    assert_eq!(
        u[1], "https://github.com/acme/api/actions/runs/9/job/23",
        "passed"
    );
    assert_eq!(
        u[2], "https://github.com/acme/api/actions/runs/9/job/24",
        "running"
    );
    assert_eq!(
        u[3], "https://github.com/acme/api/actions/runs/9/job/25",
        "unknown"
    );
    assert_eq!(HITS.load(Ordering::SeqCst), 2, "one read per failed job");
    // The next poll: cached, no reads.
    let mut f = vec![run()];
    a.anchor_failed_steps(&mut f).await;
    assert_eq!(urls(&f)[0], u[0]);
    assert_eq!(HITS.load(Ordering::SeqCst), 2);
}
