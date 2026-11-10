//! WebSocket fan-out load test: N real clients on `/api/v1/stream`, each applying the
//! frames it receives, measuring delivery lag (receipt − frame `at`) and loss.
//!
//! ```sh
//! cargo run --release -- --demo --speed 10 --listen 127.0.0.1:8080 &
//! cargo run --release --example wsload -- ws://127.0.0.1:8080/api/v1/stream 1000 60
//! ```
//! Args: URL, clients (default 1000), seconds (default 30). Optional env `SY_TOKEN` → Bearer.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[derive(Default)]
struct Totals {
    frames: AtomicU64,
    deltas: AtomicU64,
    resets: AtomicU64,
    bytes: AtomicU64,
    gaps: AtomicU64,
    connected: AtomicU64,
    failed: AtomicU64,
}

fn pct(v: &mut [i64], p: f64) -> i64 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let url = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "ws://127.0.0.1:8080/api/v1/stream".into());
    let n: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1000);
    let secs: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let token = std::env::var("SY_TOKEN").ok();
    let totals = Arc::new(Totals::default());
    let lags: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::with_capacity(1 << 20)));
    let connect_ms: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::with_capacity(n)));
    let deadline = Instant::now() + Duration::from_secs(secs);
    let start = Instant::now();
    let mut handles = Vec::with_capacity(n);
    for i in 0..n {
        let (url, token, totals, lags, connect_ms) = (
            url.clone(),
            token.clone(),
            totals.clone(),
            lags.clone(),
            connect_ms.clone(),
        );
        handles.push(tokio::spawn(async move {
            // Stagger connects a little (a real fleet of clients does not connect in one tick).
            tokio::time::sleep(Duration::from_millis((i as u64 * 2) % 2000)).await;
            let mut req = url.into_client_request().unwrap();
            if let Some(t) = &token {
                req.headers_mut()
                    .insert("authorization", format!("Bearer {t}").parse().unwrap());
            }
            let t0 = Instant::now();
            let ws = match tokio::time::timeout(
                Duration::from_secs(20),
                tokio_tungstenite::connect_async(req),
            )
            .await
            {
                Ok(Ok((ws, _))) => ws,
                _ => {
                    totals.failed.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };
            connect_ms
                .lock()
                .await
                .push(t0.elapsed().as_millis() as i64);
            totals.connected.fetch_add(1, Ordering::Relaxed);
            let (_, mut rx) = ws.split();
            let mut last_seq = 0u64;
            let mut local: Vec<i64> = Vec::new();
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                let msg = match tokio::time::timeout(left, rx.next()).await {
                    Ok(Some(Ok(m))) => m,
                    _ => break,
                };
                let Message::Text(txt) = msg else { continue };
                let at_recv = now_ms();
                totals.frames.fetch_add(1, Ordering::Relaxed);
                totals.bytes.fetch_add(txt.len() as u64, Ordering::Relaxed);
                let v: serde_json::Value = match serde_json::from_str(txt.as_str()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let seq = v["seq"].as_u64().unwrap_or(0);
                match v["t"].as_str() {
                    Some("delta") => {
                        totals.deltas.fetch_add(1, Ordering::Relaxed);
                        if last_seq != 0 && seq > last_seq + 1 {
                            totals.gaps.fetch_add(1, Ordering::Relaxed);
                        }
                        if let Some(at) = v["at"].as_i64() {
                            local.push(at_recv - at);
                        }
                    }
                    Some("reset") => {
                        totals.resets.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => {}
                }
                last_seq = last_seq.max(seq);
            }
            lags.lock().await.extend(local);
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    let el = start.elapsed().as_secs_f64();
    let mut l = lags.lock().await.clone();
    let mut c = connect_ms.lock().await.clone();
    let t = &totals;
    println!(
        "clients {n} connected {} failed {} | {:.0} s | frames {} ({:.0}/s total, {:.1}/s/client) deltas {} resets {} merged-gaps {} | {:.1} MB",
        t.connected.load(Ordering::Relaxed),
        t.failed.load(Ordering::Relaxed),
        el,
        t.frames.load(Ordering::Relaxed),
        t.frames.load(Ordering::Relaxed) as f64 / el,
        t.frames.load(Ordering::Relaxed) as f64 / el / n as f64,
        t.deltas.load(Ordering::Relaxed),
        t.resets.load(Ordering::Relaxed),
        t.gaps.load(Ordering::Relaxed),
        t.bytes.load(Ordering::Relaxed) as f64 / 1e6,
    );
    println!(
        "delivery lag ms (receipt − frame.at): p50 {} p90 {} p99 {} max {} | connect ms p50 {} p99 {}",
        pct(&mut l, 0.5),
        pct(&mut l, 0.9),
        pct(&mut l, 0.99),
        l.iter().max().copied().unwrap_or(0),
        pct(&mut c, 0.5),
        pct(&mut c, 0.99),
    );
}
