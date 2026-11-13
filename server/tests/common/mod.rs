//! Shared helpers for the adapter + golden tests: the sanitized upstream
//! fixtures under `tests/upstream/` (real payload shapes, stand-in names).
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use switchyard::adapters::woodpecker::{Mapper, WpAgent, WpEvent};
use switchyard::model::Ms;

/// Public URL the Woodpecker mapper links pipelines to.
pub const WP_URL: &str = "https://ci.dev.example.com";

pub fn path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(rel)
}

pub fn read(rel: &str) -> String {
    std::fs::read_to_string(path(&format!("upstream/{rel}")))
        .unwrap_or_else(|e| panic!("tests/upstream/{rel}: {e}"))
}

pub fn json(rel: &str) -> Value {
    serde_json::from_str(&read(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

pub fn typed<T: serde::de::DeserializeOwned>(rel: &str) -> T {
    serde_json::from_str(&read(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// Split an SSE body exactly like the adapter's stream loop: events end at a
/// blank line; `data:` lines are concatenated; comments/pings carry no data.
pub fn sse_events(body: &str) -> Vec<WpEvent> {
    let mut out = Vec::new();
    for ev in body.split("\n\n") {
        let mut data = String::new();
        for line in ev.lines() {
            if let Some(d) = line
                .strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
            {
                data.push_str(d);
            }
        }
        if data.is_empty() {
            continue;
        }
        out.push(serde_json::from_str(&data).expect("woodpecker event json"));
    }
    out
}

pub fn wp_events() -> Vec<WpEvent> {
    sse_events(&read("woodpecker/events.sse"))
}

pub fn wp_agents() -> Vec<WpAgent> {
    typed("woodpecker/agents.json")
}

pub fn wp_mapper() -> Mapper {
    Mapper {
        public_url: format!("{WP_URL}/"),
        agents: wp_agents()
            .iter()
            .map(|a| (a.id, a.name.clone()))
            .collect::<BTreeMap<u64, String>>(),
    }
}

/// Unix seconds (Woodpecker) → ms.
pub fn s(secs: i64) -> Ms {
    secs * 1000
}
