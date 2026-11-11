//! `GET /api/v1/pipeline/{id}/log`: step log tails from a fake Woodpecker + GitHub.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::extract::Path;
use axum::response::{IntoResponse, Redirect};
use axum::routing::get;
use base64::Engine;
use bytes::Bytes;
use parking_lot::RwLock;
use serde_json::{Value, json};
use switchyard::api::{AppState, router};
use switchyard::auth::{Auth, AuthMode};
use switchyard::history::{History, MemHistory};
use switchyard::hub::{Hub, Snapshot};
use switchyard::logs::Logs;
use switchyard::runtime::{Adapters, Clock};
use switchyard::wire::WireState;

const NOW: i64 = 1_794_300_000_000;

static HITS: AtomicUsize = AtomicUsize::new(0);

fn wp_entries(lines: &[String]) -> Value {
    let b64 = base64::engine::general_purpose::STANDARD;
    Value::Array(
        lines
            .iter()
            .enumerate()
            .map(|(i, l)| {
                json!({"id": i, "step_id": 100, "time": i, "line": i, "type": 0,
                                  "data": b64.encode(format!("{l}\n"))})
            })
            .collect(),
    )
}

async fn upstream() -> String {
    let app = Router::new()
        .route(
            "/api/repos/lookup/{owner}/{name}",
            get(|Path((o, n)): Path<(String, String)>| async move {
                HITS.fetch_add(1, Ordering::SeqCst);
                if format!("{o}/{n}") == "acme/api" {
                    axum::Json(json!({"id": 7, "full_name": "acme/api"})).into_response()
                } else {
                    axum::http::StatusCode::NOT_FOUND.into_response()
                }
            }),
        )
        .route(
            "/api/repos/7/pipelines/42",
            get(|| async {
                HITS.fetch_add(1, Ordering::SeqCst);
                axum::Json(
                    json!({"id": 1, "number": 42, "status": "failure", "workflows": [
                    {"id": 1, "name": "ci", "state": "failure", "children": [
                        {"id": 100, "name": "test", "state": "failure", "exit_code": 1},
                        {"id": 101, "name": "deploy", "state": "skipped"}]}]}),
                )
            }),
        )
        .route(
            "/api/repos/7/logs/42/100",
            get(|| async {
                HITS.fetch_add(1, Ordering::SeqCst);
                let mut lines: Vec<String> = (0..300)
                    .map(|i| format!("\u{1b}[32mok\u{1b}[0m {i}"))
                    .collect();
                // A fake token, spelled in parts (no secret-shaped literal in the tree).
                lines.push(format!(
                    "export GITHUB_TOKEN=gh{}_{}",
                    "p", "0123456789abcdefghijABCDEFGHIJ"
                ));
                lines.push("FAILED tests/test_api.py::test_login - AssertionError".into());
                lines.push("==== 1 failed, 300 passed in 2.31s ====".into());
                axum::Json(wp_entries(&lines))
            }),
        )
        .route(
            "/repos/acme/web/actions/runs/555/jobs",
            get(|| async {
                HITS.fetch_add(1, Ordering::SeqCst);
                axum::Json(json!({"total_count": 1, "jobs": [{"id": 9, "name": "build"}]}))
            }),
        )
        .route(
            "/repos/acme/web/actions/jobs/9/logs",
            get(|| async { Redirect::to("/blob/9") }),
        )
        .route(
            "/blob/9",
            get(|| async {
                format!(
                    "2026-11-11T12:00:00.1234567Z ##[group]Run cargo test\n\
                     2026-11-11T12:00:01.0000000Z curl -H 'Authorization: Bearer {}'\n\
                     2026-11-11T12:00:02.0000000Z error[E0308]: mismatched types\n\
                     2026-11-11T12:00:03.0000000Z ##[error]Process completed with exit code 101.\n",
                    ["abcdefgh", "ijklmnop"].concat()
                )
            }),
        );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://{addr}")
}

async fn serve(up: &str) -> String {
    let auth = Auth::new(AuthMode::Open, "x-auth-request-email", vec![], None);
    let hub = Hub::new("e".into(), 64, 64, History::Mem(MemHistory::new(3_600_000)));
    hub.set_snapshot(Snapshot::new(
        1,
        NOW,
        Bytes::from_static(br#"{"protocol":"0.5","epoch":"e","seq":1,"at":1794300000000}"#),
    ));
    let mut w = WireState::default();
    for v in [
        json!({"id": "wp:acme/api:42", "repo": "acme/api", "number": 42, "state": "failure",
               "workflows": [{"name": "ci", "state": "failure", "steps": [
                   {"name": "test", "state": "failure"}, {"name": "deploy", "state": "pending"}]}]}),
        json!({"id": "gha:555", "repo": "acme/web", "number": 3, "state": "failure",
               "workflows": [{"name": "CI", "state": "failure", "steps": [{"name": "build", "state": "failure"}]}]}),
    ] {
        w.apply_op(&json!({"op": "upsert", "kind": "pipeline", "id": v["id"], "v": v}));
    }
    let clock: Clock = Arc::new(|| NOW);
    let st = Arc::new(AppState {
        hub,
        mirror: Arc::new(RwLock::new(w)),
        store: None,
        adapters: Arc::new(Adapters::default()),
        auth: Arc::new(auth),
        traces: None,
        logs: Some(Arc::new(Logs::new(
            Some((up.to_string(), "wp-token".into())),
            Some((up.to_string(), "gh-token".into())),
            reqwest::Client::new(),
        ))),
        clock,
        mode: "test",
        version: "0".into(),
        git_sha: "0".into(),
        orgs: vec![],
        static_dir: None,
        public_url: "http://127.0.0.1".into(),
    });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, router(st)).await.unwrap() });
    format!("http://{addr}")
}

async fn get_json(url: &str) -> (u16, Value) {
    let r = reqwest::get(url).await.unwrap();
    let st = r.status().as_u16();
    (st, r.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
async fn step_log_tails() {
    let up = upstream().await;
    let base = serve(&up).await;
    let (_, meta) = get_json(&format!("{base}/api/v1/meta")).await;
    assert_eq!(meta["caps"], json!(["pipeline_log"]));

    // A Woodpecker step: the tail, cleaned and redacted.
    let u = format!("{base}/api/v1/pipeline/wp:acme%2Fapi:42/log?step=test&tail=5");
    let (st, v) = get_json(&u).await;
    assert_eq!(st, 200, "{v}");
    assert_eq!(v["id"], "wp:acme/api:42");
    assert_eq!(v["step"], "test");
    assert_eq!(v["workflow"], "ci");
    assert_eq!(v["state"], "failure");
    assert_eq!(v["truncated"], true);
    assert_eq!(v["fetched"], NOW);
    assert_eq!(
        v["lines"],
        json!([
            "ok 298",
            "ok 299",
            "export GITHUB_TOKEN=[redacted]",
            "FAILED tests/test_api.py::test_login - AssertionError",
            "==== 1 failed, 300 passed in 2.31s ===="
        ])
    );
    // The decisive line (the one the step's failure cluster is read from), raw.
    assert_eq!(v["decisive"], 3);
    assert!(v.get("first").is_none());
    // Outside the tail: absent.
    let (_, one) = get_json(&format!(
        "{base}/api/v1/pipeline/wp:acme%2Fapi:42/log?step=test&tail=1"
    ))
    .await;
    assert_eq!(
        one["lines"],
        json!(["==== 1 failed, 300 passed in 2.31s ===="])
    );
    assert!(one.get("decisive").is_none(), "{one}");
    assert_eq!(
        v["bytes"].as_u64().unwrap() as usize,
        v["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap().len() + 1)
            .sum::<usize>()
    );
    let body = v.to_string();
    assert!(!body.contains("ghp_"), "{body}");
    // Cached: a second read does not go upstream.
    let before = HITS.load(Ordering::SeqCst);
    let (_, again) = get_json(&u).await;
    assert_eq!(again, v);
    assert_eq!(HITS.load(Ordering::SeqCst), before);
    // The default tail is 200; the cap 500.
    let (_, d) = get_json(&format!(
        "{base}/api/v1/pipeline/wp:acme%2Fapi:42/log?step=test"
    ))
    .await;
    assert_eq!(d["lines"].as_array().unwrap().len(), 200);
    let (_, m) = get_json(&format!(
        "{base}/api/v1/pipeline/wp:acme%2Fapi:42/log?step=test&tail=9999"
    ))
    .await;
    assert_eq!(m["lines"].as_array().unwrap().len(), 303);
    assert_eq!(m["decisive"], 301);
    assert_eq!(m["truncated"], false);

    // Around the decisive line: ±40 lines, the decisive one at its index.
    let (_, ar) = get_json(&format!(
        "{base}/api/v1/pipeline/wp:acme%2Fapi:42/log?step=test&around=decisive"
    ))
    .await;
    assert_eq!(ar["around"], "decisive");
    let ls = ar["lines"].as_array().unwrap();
    let d = ar["decisive"].as_u64().unwrap() as usize;
    assert_eq!(
        ls[d],
        "FAILED tests/test_api.py::test_login - AssertionError"
    );
    assert_eq!(d, 40, "40 lines before it");
    assert_eq!(ls.len(), 40 + 1 + 1, "and the one line after it");
    assert_eq!(ls[0], "ok 261");
    assert_eq!(ar["after"], 0);
    assert_eq!(ar["truncated"], true, "the log goes on before the window");
    // A GitHub Actions job: the same (its window is the whole short log).
    let (_, ok) = get_json(&format!(
        "{base}/api/v1/pipeline/gha:555/log?step=build&around=decisive"
    ))
    .await;
    assert_eq!(ok["around"], "decisive");
    assert_eq!(ok["decisive"], 2);

    // Not started: an empty tail, no upstream read.
    let before = HITS.load(Ordering::SeqCst);
    let (st, p) = get_json(&format!(
        "{base}/api/v1/pipeline/wp:acme%2Fapi:42/log?step=deploy&workflow=ci"
    ))
    .await;
    assert_eq!(st, 200);
    assert_eq!(p["lines"], json!([]));
    assert_eq!(p["state"], "pending");
    assert_eq!(HITS.load(Ordering::SeqCst), before);

    // A GitHub Actions job (a Step of a gha: pipeline): its log, timestamps stripped.
    let (st, g) = get_json(&format!("{base}/api/v1/pipeline/gha:555/log?step=build")).await;
    assert_eq!(st, 200, "{g}");
    assert_eq!(g["workflow"], "CI");
    assert_eq!(
        g["lines"],
        json!([
            "##[group]Run cargo test",
            "curl -H 'Authorization: [redacted]",
            "error[E0308]: mismatched types",
            "##[error]Process completed with exit code 101."
        ])
    );
    assert_eq!(
        g["decisive"], 2,
        "the compiler error, not the runner's exit line"
    );

    // Unknown pipeline / step / missing step: 404 / 404 / 400.
    for (path, want) in [
        ("/api/v1/pipeline/wp:acme%2Fapi:9/log?step=test", 404),
        ("/api/v1/pipeline/wp:acme%2Fapi:42/log?step=nope", 404),
        (
            "/api/v1/pipeline/wp:acme%2Fapi:42/log?step=test&workflow=other",
            404,
        ),
        ("/api/v1/pipeline/wp:acme%2Fapi:42/log", 400),
    ] {
        let (st, _) = get_json(&format!("{base}{path}")).await;
        assert_eq!(st, want, "{path}");
    }
}
