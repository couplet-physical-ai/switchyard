//! Thin live end-to-end check against a deployed server.
//!
//! ```sh
//! SY_TOKEN=$(cat ~/.config/switchyard/e2e-token) \
//!   cargo run --release --example e2e -- https://switchyard.apps.example.com [SHA] [TIMEOUT_S]
//! ```
//! 1. `/api/healthz` answers, 2. `/api/readyz` is ready with every enabled adapter `ok`,
//! 3. `/api/v1/snapshot` is a real fleet (repos, apps, pipelines), 4. the WebSocket stream
//!    delivers deltas; with SHA (a commit pushed right after this starts), the time from start
//!    until the first frame that mentions it (a Woodpecker `enqueue`/`push`, a pipeline or
//!    commit upsert). Exit code 0 = all good.

#![allow(clippy::result_large_err)]

use std::time::{Duration, Instant};

use futures::StreamExt;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

fn fail(msg: String) -> ! {
    eprintln!("FAIL: {msg}");
    std::process::exit(1)
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let base = args
        .get(1)
        .cloned()
        .unwrap_or_else(|| "https://switchyard.apps.example.com".into());
    let base = base.trim_end_matches('/').to_string();
    let sha = args.get(2).filter(|s| !s.is_empty() && *s != "-").cloned();
    let timeout_s: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(60);
    let token = std::env::var("SY_TOKEN").unwrap_or_default();
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let get = |path: &str| {
        let mut r = http.get(format!("{base}{path}"));
        if !token.is_empty() {
            r = r.bearer_auth(&token);
        }
        r.send()
    };
    let start = Instant::now();

    let h = get("/api/healthz")
        .await
        .unwrap_or_else(|e| fail(format!("healthz: {e}")));
    if !h.status().is_success() {
        fail(format!("healthz HTTP {}", h.status()));
    }
    println!("healthz      200");

    let r = get("/api/readyz")
        .await
        .unwrap_or_else(|e| fail(format!("readyz: {e}")));
    let st = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    let adapters: Vec<String> = v["adapters"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| {
            format!(
                "{}={}",
                a["name"].as_str().unwrap_or("?"),
                a["state"].as_str().unwrap_or("?")
            )
        })
        .collect();
    println!(
        "readyz       {} ready={} mode={} [{}]",
        st.as_u16(),
        v["ready"],
        v["mode"],
        adapters.join(" ")
    );
    let bad: Vec<&String> = adapters
        .iter()
        .filter(|a| !a.ends_with("=ok") && !a.ends_with("=disabled"))
        .collect();
    if !st.is_success() || v["ready"] != true || !bad.is_empty() {
        fail(format!("not ready: {bad:?}"));
    }

    let t = Instant::now();
    let r = get("/api/v1/snapshot")
        .await
        .unwrap_or_else(|e| fail(format!("snapshot: {e}")));
    if !r.status().is_success() {
        fail(format!("snapshot HTTP {}", r.status()));
    }
    let s: Value = r
        .json()
        .await
        .unwrap_or_else(|e| fail(format!("snapshot json: {e}")));
    let n = |k: &str| s[k].as_array().map(Vec::len).unwrap_or(0);
    println!(
        "snapshot     {} ms  seq {}  repos {} commits {} pipelines {} prs {} deploys {} apps {} engines {} lanes {}",
        t.elapsed().as_millis(),
        s["seq"],
        n("repos"),
        n("commits"),
        n("pipelines"),
        n("prs"),
        n("deploys"),
        n("apps"),
        n("engines"),
        n("lanes")
    );
    if n("repos") < 100 || n("apps") < 100 || n("engines") == 0 {
        fail("snapshot does not look like the real fleet".into());
    }
    let seq = s["seq"].as_u64().unwrap_or(0);

    // Factory Floor (0.5): every repo in a group, and the queries answer.
    if s["protocol"].as_str().is_some_and(|p| p >= "0.5") {
        let ungrouped = s["repos"]
            .as_array()
            .map(|a| a.iter().filter(|r| r["group"].as_str().is_none()).count())
            .unwrap_or(0);
        let i: serde_json::Value = get("/api/v1/insights")
            .await
            .unwrap_or_else(|e| fail(format!("insights: {e}")))
            .json()
            .await
            .unwrap_or_else(|e| fail(format!("insights json: {e}")));
        let since = s["at"].as_i64().unwrap_or(0) - 3_600_000;
        let c: serde_json::Value = get(&format!("/api/v1/changes?since={since}"))
            .await
            .unwrap_or_else(|e| fail(format!("changes: {e}")))
            .json()
            .await
            .unwrap_or_else(|e| fail(format!("changes json: {e}")));
        let m = |v: &serde_json::Value, k: &str| v[k].as_array().map(Vec::len).unwrap_or(0);
        println!(
            "floor        groups {} clusters {} flakes {} trends {}  changes(1h) {}",
            m(&i, "groups"),
            m(&i, "clusters"),
            m(&i, "flakes"),
            m(&i, "trends"),
            c["counts"]
        );
        // Per-app and per-engine history for the first of each.
        let enc = |x: &str| {
            x.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        };
        for (what, path) in [
            (
                "app",
                s["apps"][0]["id"]
                    .as_str()
                    .map(|a| format!("/api/v1/app/{}", enc(a))),
            ),
            (
                "engine",
                s["engines"][0]["id"]
                    .as_str()
                    .map(|e| format!("/api/v1/engine/{}/history", enc(e))),
            ),
        ] {
            let Some(path) = path else { continue };
            let r = get(&path)
                .await
                .unwrap_or_else(|e| fail(format!("{what}: {e}")));
            if !r.status().is_success() {
                fail(format!("{path}: HTTP {}", r.status()));
            }
            let v: serde_json::Value = r.json().await.unwrap_or_default();
            println!(
                "{what:12} {path}  deploys {} health {} busy {}",
                m(&v, "deploys"),
                m(&v, "health"),
                m(&v, "busy")
            );
        }
        if ungrouped > 0 || m(&i, "groups") == 0 || m(&i, "trends") == 0 || c["counts"].is_null() {
            fail(format!(
                "factory floor incomplete ({ungrouped} repos without a group)"
            ));
        }
    }

    let ws_url = format!(
        "{}/api/v1/stream?since={seq}",
        base.replacen("http", "ws", 1)
    );
    let mut req = ws_url.into_client_request().unwrap();
    if !token.is_empty() {
        req.headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
    }
    let (ws, _) = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(req),
    )
    .await
    .unwrap_or_else(|_| fail("ws connect timeout".into()))
    .unwrap_or_else(|e| fail(format!("ws connect: {e}")));
    println!("stream       connected (since {seq})");
    let (_, mut rx) = ws.split();
    let deadline = Instant::now() + Duration::from_secs(timeout_s);
    let (mut deltas, mut first_delta) = (0u64, None);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        let Ok(Some(Ok(msg))) = tokio::time::timeout(left, rx.next()).await else {
            break;
        };
        let Message::Text(txt) = msg else { continue };
        let f: Value = serde_json::from_str(txt.as_str()).unwrap_or(Value::Null);
        if f["t"] == "delta" {
            deltas += 1;
            first_delta.get_or_insert_with(|| start.elapsed());
        }
        match &sha {
            Some(sha) if txt.contains(sha.as_str()) => {
                let kinds: Vec<String> = f["ops"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|o| o.to_string().contains(sha.as_str()))
                    .map(|o| {
                        if o["op"] == "event" {
                            format!("event:{}", o["e"]["k"].as_str().unwrap_or("?"))
                        } else {
                            format!(
                                "{}:{}",
                                o["op"].as_str().unwrap_or("?"),
                                o["kind"].as_str().unwrap_or("?")
                            )
                        }
                    })
                    .collect();
                println!(
                    "live delta   {sha:.7} seen {:.1} s after start (frame seq {}, {})",
                    start.elapsed().as_secs_f64(),
                    f["seq"],
                    kinds.join(" ")
                );
                println!("OK");
                return;
            }
            None if deltas >= 3 => {
                println!(
                    "live deltas  {deltas} (first after {:.1} s)",
                    first_delta.unwrap().as_secs_f64()
                );
                println!("OK");
                return;
            }
            _ => {}
        }
    }
    match sha {
        Some(sha) => fail(format!(
            "no frame mentioned {sha} within {timeout_s} s ({deltas} deltas)"
        )),
        None => fail(format!("only {deltas} deltas within {timeout_s} s")),
    }
}
