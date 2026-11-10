//! The HTTP surface through the real router: who may read what (the platform-mode auth
//! paths, including the edge-exempt `/api/v1/tstream?token=`), and how the web client
//! is served (SPA fallback, cache rules, JSON 404 under /api).

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use bytes::Bytes;
use parking_lot::RwLock;
use switchyard::api::{AppState, router};
use switchyard::auth::{Auth, AuthMode};
use switchyard::history::{History, MemHistory};
use switchyard::hub::{Hub, Snapshot};
use switchyard::runtime::{Adapters, Clock};
use switchyard::wire::WireState;

const NOW: i64 = 1_794_300_000_000;

struct Server {
    base: String,
    token: String,
    _dir: tempfile::TempDir,
}

async fn serve(mode: AuthMode, web: Option<&Path>) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let mut auth = Auth::new(
        mode,
        "x-auth-request-email",
        vec!["example.com".into()],
        None,
    );
    // Header-only identities stand in for the edge (no Google token to verify here).
    auth.trust_headers_without_jwt = true;
    auth.service_tokens = vec![("e2e".into(), switchyard::auth::sha256_hex("sys_monitor"))];
    let (token, _) = auth.mint("a@example.com", "test mac", NOW);
    let hub = Hub::new("e".into(), 64, 64, History::Mem(MemHistory::new(3_600_000)));
    hub.set_snapshot(Snapshot::new(
        1,
        NOW,
        Bytes::from_static(br#"{"protocol":"0.3","epoch":"e","seq":1,"at":1794300000000}"#),
    ));
    let clock: Clock = Arc::new(|| NOW);
    let st = Arc::new(AppState {
        hub,
        mirror: Arc::new(RwLock::new(WireState::default())),
        store: None,
        adapters: Arc::new(Adapters::default()),
        auth: Arc::new(auth),
        traces: None,
        clock,
        mode: "test",
        version: "0".into(),
        git_sha: "0".into(),
        orgs: vec![],
        static_dir: web.map(Path::to_path_buf),
        public_url: "http://127.0.0.1".into(),
    });
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, router(st)).await.unwrap() });
    Server {
        base: format!("http://{addr}"),
        token,
        _dir: dir,
    }
}

async fn status(url: &str, headers: &[(&str, &str)]) -> u16 {
    let mut r = reqwest::Client::new().get(url);
    for (k, v) in headers {
        r = r.header(*k, *v);
    }
    r.send().await.unwrap().status().as_u16()
}

#[tokio::test]
async fn platform_mode_who_may_read() {
    let s = serve(AuthMode::Platform, None).await;
    let snap = format!("{}/api/v1/snapshot", s.base);
    let bearer = format!("Bearer {}", s.token);
    assert_eq!(status(&snap, &[]).await, 401, "anonymous");
    assert_eq!(
        status(&snap, &[("x-auth-request-email", "a@example.com")]).await,
        200,
        "edge identity"
    );
    assert_eq!(
        status(&snap, &[("x-auth-request-email", "a@evil.example")]).await,
        401,
        "foreign domain"
    );
    assert_eq!(
        status(&snap, &[("authorization", &bearer)]).await,
        200,
        "device token"
    );
    assert_eq!(
        status(&snap, &[("authorization", "Bearer sys_monitor")]).await,
        200,
        "service token"
    );
    assert_eq!(
        status(&snap, &[("authorization", "Bearer syd_forged")]).await,
        401,
        "unknown token"
    );
    assert_eq!(
        status(&format!("{snap}?token={}", s.token), &[]).await,
        200,
        "?token= on a gated path"
    );
}

#[tokio::test]
async fn tstream_accepts_only_a_device_token_in_the_query() {
    let s = serve(AuthMode::Platform, None).await;
    let sse = format!("{}/api/v1/tstream/sse", s.base);
    let bearer = format!("Bearer {}", s.token);
    // This path is exempt from the platform edge: nothing but ?token=syd_… may pass.
    assert_eq!(status(&sse, &[]).await, 401);
    assert_eq!(
        status(&sse, &[("x-auth-request-email", "a@example.com")]).await,
        401,
        "edge headers are not trusted here"
    );
    assert_eq!(
        status(&sse, &[("authorization", &bearer)]).await,
        401,
        "headers are not read here"
    );
    assert_eq!(
        status(&format!("{sse}?token=sys_forged"), &[]).await,
        401,
        "unknown service token"
    );
    assert_eq!(
        status(&format!("{sse}?token=eyJhbGciOi.x.y"), &[]).await,
        401,
        "no Google tokens here"
    );
    assert_eq!(status(&format!("{sse}?token=syd_forged"), &[]).await, 401);
    // A read-only service token works too (monitors, the e2e check, a test app).
    let mut r = reqwest::get(format!("{sse}?token=sys_monitor"))
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200, "service token");
    drop(r.chunk().await);
    // A valid device token opens the stream (SSE: 200 and a first event).
    let mut r = reqwest::get(format!("{sse}?token={}", s.token))
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), r.chunk())
        .await
        .unwrap()
        .unwrap();
    assert!(first.is_some_and(|c| !c.is_empty()));
    // Only the two stream routes live under tstream: nothing else answers with data.
    for p in [
        "/api/v1/tstreamx",
        "/api/v1/tstream/snapshot",
        "/api/v1/tstream/history",
    ] {
        let c = status(&format!("{}{p}?token={}", s.base, s.token), &[]).await;
        assert!(c == 404 || c == 401, "{p}: {c}");
    }
}

#[tokio::test]
async fn web_client_is_served_as_an_spa() {
    let web = tempfile::tempdir().unwrap();
    std::fs::write(
        web.path().join("shell.html"),
        "<!doctype html><title>shell</title>",
    )
    .unwrap();
    std::fs::write(
        web.path().join("index.html"),
        "<!doctype html><title>shell</title>",
    )
    .unwrap();
    std::fs::write(web.path().join("app.js"), "1").unwrap();
    std::fs::write(web.path().join("canvas2d-Lmh-ovnK.js"), "2").unwrap();
    std::fs::write(web.path().join(".exact-build.json"), "{}").unwrap();
    let s = serve(AuthMode::Open, Some(web.path())).await;
    let get = |p: &str| reqwest::get(format!("{}{p}", s.base));
    for (path, code, ctype, cache) in [
        ("/", 200, "text/html", "no-cache"),
        ("/commit/a/b/c", 200, "text/html", "no-cache"),
        ("/app.js", 200, "text/javascript", "no-cache"),
        (
            "/canvas2d-Lmh-ovnK.js",
            200,
            "text/javascript",
            "public, max-age=31536000, immutable",
        ),
        ("/.exact-build.json", 200, "text/html", "no-cache"),
    ] {
        let r = get(path).await.unwrap();
        assert_eq!(r.status().as_u16(), code, "{path}");
        let h = |k: &str| {
            r.headers()
                .get(k)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string()
        };
        assert!(
            h("content-type").starts_with(ctype),
            "{path}: {}",
            h("content-type")
        );
        assert_eq!(h("cache-control"), cache, "{path}");
        if path.starts_with("/.") {
            assert!(
                r.text().await.unwrap().contains("shell"),
                "dotfiles are never served"
            );
        }
    }
    let r = get("/api/nope").await.unwrap();
    assert_eq!(r.status().as_u16(), 404);
    assert!(
        r.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/json")
    );
    // Open mode (demo/local): any origin may read.
    let r = reqwest::Client::new()
        .get(format!("{}/api/v1/snapshot", s.base))
        .header("origin", "http://localhost:5173")
        .send()
        .await
        .unwrap();
    assert_eq!(r.headers()["access-control-allow-origin"], "*");
}
