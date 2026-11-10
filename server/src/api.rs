//! HTTP surface: snapshot, WebSocket/SSE stream, history, journeys, PRs,
//! search, meta, health, and the web client's static build.

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tower_http::compression::CompressionLayer;

use crate::auth::{self, Auth};
use crate::hub::{Frame, FrameKind, Hub, heartbeat};
use crate::model::{Kind, Ms, PROTOCOL};
use crate::query;
use crate::runtime::{Adapters, Clock};
use crate::store::Store;
use crate::traces::Traces;
use crate::wire::WireState;

pub const MIN_FRAME_INTERVAL: Duration = Duration::from_millis(33);
pub const HEARTBEAT: Duration = Duration::from_secs(5);
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

pub struct AppState {
    pub hub: Arc<Hub>,
    pub mirror: Arc<RwLock<WireState>>,
    pub store: Option<Arc<RwLock<Store>>>,
    pub adapters: Arc<Adapters>,
    pub auth: Arc<Auth>,
    pub traces: Option<Arc<Traces>>,
    pub clock: Clock,
    pub mode: &'static str,
    pub version: String,
    pub git_sha: String,
    pub orgs: Vec<String>,
    pub static_dir: Option<PathBuf>,
    pub public_url: String,
}

pub fn router(st: Arc<AppState>) -> Router {
    let v1 = Router::new()
        .route("/snapshot", get(snapshot))
        .route("/stream", get(stream_ws))
        .route("/stream/sse", get(stream_sse))
        .route("/history", get(history))
        .route("/commit/{owner}/{name}/{sha}", get(commit))
        .route("/pr/{owner}/{name}/{number}", get(pr))
        .route("/search", get(search))
        .route("/meta", get(meta))
        .route("/whoami", get(auth::whoami))
        .route("/tokens", get(auth::list_tokens))
        .route("/tokens/{id}", axum::routing::delete(auth::revoke_token))
        .layer(middleware::from_fn_with_state(st.clone(), auth::require));
    let tstream = Router::new()
        .route("/tstream", get(stream_ws))
        .route("/tstream/sse", get(stream_sse))
        .layer(middleware::from_fn_with_state(
            st.clone(),
            auth::require_query_token,
        ));
    let r = Router::new()
        .route("/api/healthz", get(healthz))
        .route("/api/readyz", get(readyz))
        .route("/connect", get(auth::connect_page))
        .route("/api/connect/mint", axum::routing::post(auth::mint))
        .nest("/api/v1", v1.merge(tstream))
        .route("/api", get(api_not_found))
        .route("/api/{*rest}", get(api_not_found));
    let r = match &st.static_dir {
        Some(dir) => r
            .fallback(web_file)
            .layer(axum::Extension(WebDir(dir.clone()))),
        None => r.fallback(get(root)),
    };
    let open = st.auth.mode == crate::auth::AuthMode::Open;
    let r = r.layer(CompressionLayer::new().gzip(true).br(false));
    // A local/demo server is read by dev clients on other origins.
    let r = if open {
        r.layer(tower_http::cors::CorsLayer::permissive())
    } else {
        r
    };
    r.with_state(st)
}

#[cfg(test)]
mod web_tests {
    use super::hashed_asset;

    #[test]
    fn hashed_assets() {
        for h in [
            "canvas2d-Lmh-ovnK.js",
            "fragment-4yz_we-b.js",
            "storage-environment-Cl6q2ZQ_.js",
            "symbol-roles-B-ExGlrT.js",
        ] {
            assert!(hashed_asset(h), "{h}");
        }
        for n in [
            "app.js",
            "app.plan",
            "shell.html",
            "index.html",
            "style.css",
            "routes.json",
            "manifest.json",
            "ts-stream.js",
        ] {
            assert!(!hashed_asset(n), "{n}");
        }
    }
}

async fn api_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({"error": "not_found"})),
    )
        .into_response()
}

#[derive(Clone)]
struct WebDir(PathBuf);

/// True for content-hashed build outputs (`canvas2d-Lmh-ovnK.js`: a `-` then an 8-char
/// base64url hash before the extension): safe to cache forever.
fn hashed_asset(name: &str) -> bool {
    let stem = name
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(name)
        .as_bytes();
    stem.len() > 9
        && stem[stem.len() - 9] == b'-'
        && stem[stem.len() - 8..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
        && stem[stem.len() - 8..]
            .iter()
            .any(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
}

/// The web client: the file when it exists, else the SPA shell (`shell.html`, or
/// `index.html`) with 200. Hashed assets are immutable; everything else revalidates.
async fn web_file(
    axum::Extension(WebDir(dir)): axum::Extension<WebDir>,
    uri: axum::http::Uri,
) -> Response {
    let rel = uri.path().trim_start_matches('/');
    let safe = !rel
        .split('/')
        .any(|seg| seg == ".." || seg.starts_with('.') && !seg.is_empty());
    let mut path = dir.join(if rel.is_empty() { "index.html" } else { rel });
    if !safe || !path.is_file() {
        path = ["shell.html", "index.html"]
            .iter()
            .map(|f| dir.join(f))
            .find(|p| p.is_file())
            .unwrap_or(dir.join("index.html"));
    }
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let mut r = Response::new(Body::from(bytes));
    let h = r.headers_mut();
    if let Ok(v) = HeaderValue::from_str(mime.as_ref()) {
        h.insert(header::CONTENT_TYPE, v);
    }
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if hashed_asset(name) {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    r
}

async fn root(State(st): State<Arc<AppState>>) -> Response {
    let body = json!({
        "name": "switchyard-server",
        "mode": st.mode,
        "protocol": PROTOCOL,
        "endpoints": ["/api/v1/snapshot", "/api/v1/stream", "/api/v1/stream/sse", "/api/v1/history",
                      "/api/v1/commit/{owner}/{name}/{sha}", "/api/v1/pr/{owner}/{name}/{number}",
                      "/api/v1/search?q=", "/api/v1/meta", "/api/healthz", "/api/readyz", "/connect"],
    });
    (StatusCode::OK, axum::Json(body)).into_response()
}

async fn healthz() -> Response {
    (StatusCode::OK, axum::Json(json!({"ok": true}))).into_response()
}

async fn readyz(State(st): State<Arc<AppState>>) -> Response {
    let ready = st.adapters.ready();
    let body = json!({"ready": ready, "mode": st.mode, "seq": st.hub.seq(), "adapters": st.adapters.list()});
    let code = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (code, axum::Json(body)).into_response()
}

async fn meta(State(st): State<Arc<AppState>>) -> Response {
    let counts = st
        .store
        .as_ref()
        .map(|s| serde_json::to_value(s.read().counts()).unwrap_or(Value::Null));
    let snap = st.hub.snapshot();
    let body = json!({
        "protocol": PROTOCOL,
        "version": st.version,
        "git_sha": st.git_sha,
        "mode": st.mode,
        "epoch": st.hub.epoch,
        "seq": st.hub.seq(),
        "snapshot": {"seq": snap.seq, "at": snap.at, "bytes": snap.json.len(), "gzip_bytes": snap.gzip.len()},
        "clients": st.hub.clients.load(Ordering::Relaxed),
        "frames_sent": st.hub.frames_sent.load(Ordering::Relaxed),
        "resets_sent": st.hub.resets_sent.load(Ordering::Relaxed),
        "adapters": st.adapters.list(),
        "orgs": st.orgs,
        "counts": counts,
        "process": process_stats(),
        "now": (st.clock)(),
    });
    (StatusCode::OK, axum::Json(body)).into_response()
}

/// Resident memory of this process (Linux `/proc/self/status`; `null` elsewhere).
fn process_stats() -> Value {
    let Ok(st) = std::fs::read_to_string("/proc/self/status") else {
        return Value::Null;
    };
    let kb = |k: &str| {
        st.lines()
            .find(|l| l.starts_with(k))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|n| n.parse::<u64>().ok())
            .map(|n| n * 1024)
    };
    json!({"rss_bytes": kb("VmRSS:"), "peak_rss_bytes": kb("VmHWM:"), "threads": kb("Threads:").map(|n| n / 1024)})
}

/// `GET /api/v1/snapshot?at=<ms>`: the fleet as it was at `at` (within the replay ring).
async fn snapshot_at(st: Arc<AppState>, at: Ms) -> Response {
    let now = (st.clock)();
    if at > now || at < now - crate::history::KEEP_MS {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "bad_time", "message": "need a time within the last 24 h"})),
        )
            .into_response();
    }
    let hub = st.hub.clone();
    let out = tokio::task::spawn_blocking(move || {
        hub.history
            .query(at, at)
            .map(|h| h.fold_to(at, true, PROTOCOL, &hub.epoch).1)
    })
    .await
    .ok()
    .flatten();
    match out {
        Some(h) => {
            let mut r = Response::new(Body::from(h.base));
            r.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            r
        }
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "no_history"})),
        )
            .into_response(),
    }
}

fn accepts_gzip(h: &HeaderMap) -> bool {
    h.get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| v.split(',').any(|e| e.trim().starts_with("gzip")))
}

/// Snapshot straight from the pre-encoded cache (no serialization per request).
#[derive(Deserialize)]
struct SnapshotQ {
    at: Option<Ms>,
}

async fn snapshot(
    State(st): State<Arc<AppState>>,
    Query(q): Query<SnapshotQ>,
    headers: HeaderMap,
) -> Response {
    if let Some(at) = q.at {
        return snapshot_at(st, at).await;
    }
    let s = st.hub.snapshot();
    let etag = format!("\"{}-{}\"", st.hub.epoch, s.seq);
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    let (body, gz) = if accepts_gzip(&headers) {
        (s.gzip.clone(), true)
    } else {
        (s.json.clone(), false)
    };
    let mut r = Response::new(Body::from(body));
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-switchyard-seq", HeaderValue::from(s.seq));
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(header::ETAG, v);
    }
    if gz {
        h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        h.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    r
}

#[derive(Deserialize)]
pub struct StreamQ {
    since: Option<u64>,
}

async fn stream_ws(
    State(st): State<Arc<AppState>>,
    Query(q): Query<StreamQ>,
    ws: WebSocketUpgrade,
) -> Response {
    // Clients only read: small buffers keep 1,000 sockets cheap (tungstenite's
    // defaults are 128 KiB each way per connection). Frames are flushed whole.
    ws.read_buffer_size(4 * 1024)
        .write_buffer_size(0)
        .max_message_size(64 * 1024)
        .on_upgrade(move |socket| ws_client(socket, st, q.since))
}

/// Where a client's bytes go.
enum Sink {
    Ws(futures::stream::SplitSink<WebSocket, Message>),
    Sse(mpsc::Sender<Result<SseEvent, Infallible>>),
}

impl Sink {
    async fn send(&mut self, b: Bytes) -> bool {
        let fut = async {
            match self {
                Sink::Ws(s) => {
                    let text = match axum::extract::ws::Utf8Bytes::try_from(b) {
                        Ok(t) => t,
                        Err(_) => return false,
                    };
                    s.send(Message::Text(text)).await.is_ok()
                }
                Sink::Sse(tx) => {
                    let data = String::from_utf8_lossy(&b).into_owned();
                    tx.send(Ok(SseEvent::default().data(data))).await.is_ok()
                }
            }
        };
        tokio::time::timeout(SEND_TIMEOUT, fut)
            .await
            .unwrap_or(false)
    }
}

async fn ws_client(socket: WebSocket, st: Arc<AppState>, since: Option<u64>) {
    let (sink, mut stream) = socket.split();
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        while let Some(Ok(m)) = stream.next().await {
            if matches!(m, Message::Close(_)) {
                break;
            }
        }
        let _ = close_tx.send(());
    });
    pump(Sink::Ws(sink), st, since, close_rx).await;
}

async fn stream_sse(State(st): State<Arc<AppState>>, Query(q): Query<StreamQ>) -> Response {
    let (tx, rx) = mpsc::channel::<Result<SseEvent, Infallible>>(64);
    let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        // The pump ends when the HTTP body (the receiver) is dropped and a
        // send (frame or 5 s heartbeat) fails.
        let _keep = close_tx;
        pump(Sink::Sse(tx), st, q.since, close_rx).await;
    });
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let mut r = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    r.headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    r
}

/// One client's loop: resume from the ring, then forward shared frames,
/// merging whatever queued up so a client never gets more than ~30 msgs/s.
/// A client that falls behind the bounded channel gets a reset.
async fn pump(
    mut sink: Sink,
    st: Arc<AppState>,
    since: Option<u64>,
    mut closed: tokio::sync::oneshot::Receiver<()>,
) {
    let hub = st.hub.clone();
    hub.clients.fetch_add(1, Ordering::Relaxed);
    let mut rx = hub.tx.subscribe();
    let mut last = hub.seq();
    let mut ok = true;
    if let Some(s) = since {
        match hub.since(s) {
            Some(frames) => {
                last = s;
                ok = send_batch(&mut sink, &hub, &frames, &mut last).await;
            }
            None => {
                hub.resets_sent.fetch_add(1, Ordering::Relaxed);
                ok = sink.send(Frame::reset(hub.seq(), (st.clock)()).json).await;
                last = hub.seq();
            }
        }
    }
    let mut hb = tokio::time::interval(HEARTBEAT);
    hb.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    hb.reset();
    let mut next_send = tokio::time::Instant::now();
    while ok {
        tokio::select! {
            _ = &mut closed => break,
            _ = hb.tick() => {
                ok = sink.send(heartbeat(hub.seq(), (st.clock)())).await;
            }
            r = rx.recv() => {
                match r {
                    Ok(f) => {
                        // Coalesce: wait out the per-client minimum interval, then
                        // take everything that queued meanwhile.
                        tokio::time::sleep_until(next_send).await;
                        let mut batch = vec![f];
                        let mut lagged = false;
                        loop {
                            match rx.try_recv() {
                                Ok(f) => batch.push(f),
                                Err(broadcast::error::TryRecvError::Lagged(_)) => { lagged = true; break; }
                                Err(_) => break,
                            }
                            if batch.len() >= 512 { break; }
                        }
                        if lagged {
                            hub.resets_sent.fetch_add(1, Ordering::Relaxed);
                            ok = sink.send(Frame::reset(hub.seq(), (st.clock)()).json).await;
                            last = hub.seq();
                        } else {
                            ok = send_batch(&mut sink, &hub, &batch, &mut last).await;
                        }
                        next_send = tokio::time::Instant::now() + MIN_FRAME_INTERVAL;
                        hb.reset();
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        hub.resets_sent.fetch_add(1, Ordering::Relaxed);
                        ok = sink.send(Frame::reset(hub.seq(), (st.clock)()).json).await;
                        last = hub.seq();
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    hub.clients.fetch_sub(1, Ordering::Relaxed);
}

/// Send frames newer than `last`: consecutive deltas merge into one message of at most
/// [`MAX_MESSAGE`](crate::hub::MAX_MESSAGE) bytes (a long catch-up is several messages),
/// resets go through as-is.
async fn send_batch(sink: &mut Sink, hub: &Hub, frames: &[Arc<Frame>], last: &mut u64) -> bool {
    let fresh: Vec<Arc<Frame>> = frames.iter().filter(|f| f.seq > *last).cloned().collect();
    let mut i = 0;
    while i < fresh.len() {
        if fresh[i].kind == FrameKind::Reset {
            if !sink.send(fresh[i].json.clone()).await {
                return false;
            }
            hub.resets_sent.fetch_add(1, Ordering::Relaxed);
            *last = fresh[i].seq;
            i += 1;
            continue;
        }
        let mut j = i;
        let mut size = 64;
        while j < fresh.len() && fresh[j].kind == FrameKind::Delta {
            let n = fresh[j].ops.len() + 1;
            if j > i && size + n > crate::hub::MAX_MESSAGE {
                break;
            }
            size += n;
            j += 1;
        }
        let bytes = Frame::merge(&fresh[i..j]);
        if !sink.send(bytes).await {
            return false;
        }
        hub.frames_sent.fetch_add(1, Ordering::Relaxed);
        *last = fresh[j - 1].seq;
        i = j;
    }
    true
}

#[derive(Deserialize)]
struct HistoryQ {
    from: Option<Ms>,
    to: Option<Ms>,
    /// `base=0`: no base snapshot (`base: null`), only the entries after `from` (a client
    /// that already holds the state at `from`, e.g. its live state, saves the big base).
    base: Option<u8>,
}

async fn history(State(st): State<Arc<AppState>>, Query(q): Query<HistoryQ>) -> Response {
    let now = (st.clock)();
    let to = q.to.unwrap_or(now).min(now);
    let from = q.from.unwrap_or(to - 3_600_000);
    if from >= to || to - from > crate::history::MAX_WINDOW_MS {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(
                json!({"error": "bad_window", "message": "need from < to and a window ≤ 3 h"}),
            ),
        )
            .into_response();
    }
    let hub = st.hub.clone();
    let out = tokio::task::spawn_blocking(move || {
        let h = hub.history.query(from, to)?;
        if q.base == Some(0) {
            return Some((from, h.after(from)));
        }
        Some(h.fold_to(from, false, PROTOCOL, &hub.epoch))
    })
    .await
    .ok()
    .flatten();
    match out {
        Some((from, h)) => {
            let mut r = Response::new(Body::from(h.to_json(from, to)));
            r.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            r
        }
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "no_history"})),
        )
            .into_response(),
    }
}

async fn commit(
    State(st): State<Arc<AppState>>,
    Path((owner, name, sha)): Path<(String, String, String)>,
) -> Response {
    let repo = format!("{owner}/{name}");
    let full = query::resolve_sha(&st.mirror.read(), &repo, &sha).unwrap_or(sha.clone());
    let extra: Vec<Value> = st
        .store
        .as_ref()
        .map(|s| {
            s.read()
                .pipelines_for(&repo, &full)
                .into_iter()
                .filter_map(|p| serde_json::to_value(p).ok())
                .collect()
        })
        .unwrap_or_default();
    let spans = match &st.traces {
        Some(t) => t.spans_for(&repo, &full, &extra).await,
        None => None,
    };
    let j = query::journey(&st.mirror.read(), &repo, &full, extra, spans);
    match j {
        Some(v) => (StatusCode::OK, axum::Json(v)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "unknown_commit"})),
        )
            .into_response(),
    }
}

async fn pr(
    State(st): State<Arc<AppState>>,
    Path((owner, name, number)): Path<(String, String, u64)>,
) -> Response {
    let repo = format!("{owner}/{name}");
    match query::pr_detail(&st.mirror.read(), &repo, number) {
        Some(v) => (StatusCode::OK, axum::Json(v)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": "unknown_pr"})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct SearchQ {
    q: Option<String>,
    limit: Option<usize>,
}

async fn search(State(st): State<Arc<AppState>>, Query(q): Query<SearchQ>) -> Response {
    let hits = query::search(
        &st.mirror.read(),
        q.q.as_deref().unwrap_or(""),
        q.limit.unwrap_or(25),
    );
    (
        StatusCode::OK,
        axum::Json(json!({"q": q.q, "results": hits})),
    )
        .into_response()
}

/// Keep `mirror` equal to snapshot + frames (resyncs from the snapshot on lag/reset).
pub async fn run_mirror(hub: Arc<Hub>, mirror: Arc<RwLock<WireState>>) {
    let mut rx = hub.tx.subscribe();
    let resync = |hub: &Hub, mirror: &RwLock<WireState>| {
        let s = hub.snapshot();
        if let Ok(v) = serde_json::from_slice::<Value>(&s.json) {
            *mirror.write() = WireState::from_snapshot(&v);
        }
    };
    resync(&hub, &mirror);
    loop {
        match rx.recv().await {
            Ok(f) => {
                if f.kind == FrameKind::Reset {
                    // The snapshot for a reset is published right after it.
                    for _ in 0..200 {
                        if hub.snapshot().seq >= f.seq {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    resync(&hub, &mirror);
                    continue;
                }
                if f.seq <= mirror.read().seq {
                    continue;
                }
                if let Ok(v) = serde_json::from_slice::<Value>(&f.json) {
                    mirror.write().apply_frame(&v);
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => resync(&hub, &mirror),
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

pub fn kind_list() -> Vec<&'static str> {
    Kind::ALL.iter().map(|k| k.as_str()).collect()
}
