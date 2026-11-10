//! Dagger span waterfalls for commit journeys, read from the cicd console's
//! `/api/traces` (Tempo behind it). Cached per commit; one upstream call per
//! journey request at most, never per streaming client.

use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rustc_hash::FxHashMap;
use serde_json::Value;

pub struct Traces {
    pub cicd_url: String,
    token: Option<String>,
    http: reqwest::Client,
    cache: Mutex<FxHashMap<String, (Instant, Option<Value>)>>,
}

const TTL: Duration = Duration::from_secs(60);

impl Traces {
    pub fn new(cicd_url: String, token: Option<String>, http: reqwest::Client) -> Traces {
        Traces {
            cicd_url,
            token,
            http,
            cache: Mutex::new(FxHashMap::default()),
        }
    }

    /// The Dagger calls of one commit's pipelines (empty when cicd has none, is
    /// unreachable, or has no read token). One search per commit per minute at most:
    /// cicd fans it out to Tempo, which parallel reads have crashed before.
    pub async fn spans_for(&self, repo: &str, sha: &str, _pipelines: &[Value]) -> Option<Value> {
        let key = format!("{repo}@{sha}");
        if let Some((t, v)) = self.cache.lock().get(&key)
            && t.elapsed() < TTL
        {
            return v.clone();
        }
        let token = self.token.as_ref()?;
        let url = format!("{}/api/traces", self.cicd_url.trim_end_matches('/'));
        let r = self
            .http
            .get(&url)
            .query(&[("repo", repo), ("sha", sha), ("limit", "50")])
            .bearer_auth(token)
            .timeout(Duration::from_secs(8))
            .send()
            .await
            .ok()?;
        let v: Option<Value> = if r.status().is_success() {
            r.json::<Value>()
                .await
                .ok()
                .map(|v| Value::Array(spans_from_search(&v)))
        } else {
            None
        };
        self.cache.lock().insert(key, (Instant::now(), v.clone()));
        v
    }
}

/// cicd `/api/traces` search → contract `Span`s (one per Dagger call), oldest first.
pub fn spans_from_search(v: &Value) -> Vec<Value> {
    let mut out: Vec<(i64, Value)> = v
        .get("traces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let id = t.get("trace_id")?.as_str()?;
            let start = t
                .get("start")
                .and_then(Value::as_str)
                .and_then(crate::adapters::apps::parse_time)?;
            let root = t.get("root_name").and_then(Value::as_str).unwrap_or("");
            let (name, call) = split_call(root);
            let mut m = serde_json::Map::new();
            m.insert("id".into(), Value::from(id));
            m.insert("name".into(), Value::from(name));
            if !call.is_empty() {
                m.insert("call".into(), Value::from(call));
            }
            if let Some(n) = t
                .get("pipeline")
                .and_then(Value::as_str)
                .and_then(|p| p.parse::<u64>().ok())
            {
                m.insert("pipeline".into(), Value::from(n));
            }
            m.insert("start".into(), Value::from(start));
            m.insert(
                "ms".into(),
                Value::from(
                    t.get("duration_ms")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        .round() as i64,
                ),
            );
            if let Some(n) = t.get("span_count").and_then(Value::as_u64) {
                m.insert("spans".into(), Value::from(n));
            }
            Some((start, Value::Object(m)))
        })
        .collect();
    out.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1["id"].as_str().cmp(&b.1["id"].as_str()))
    });
    out.into_iter().map(|(_, v)| v).collect()
}

/// `npm --src=/srv/… --dir=frontend --scripts=build,test --npm-registry=https://…` →
/// (`npm`, `--dir=frontend --scripts=build,test`): the function and the arguments a
/// person reads, without workspace paths, cache/registry plumbing or key references.
fn split_call(root: &str) -> (String, String) {
    const PLUMBING: [&str; 10] = [
        "--src=",
        "--dep-cache",
        "--npm-registry=",
        "--registry",
        "--provisioning-api-key=",
        "--github-app-key=",
        "--pipeline-url=",
        "--lock-held=",
        "--test-workers=",
        "--password",
    ];
    let mut it = root.split_whitespace();
    let name = it.next().unwrap_or("").to_string();
    let call: Vec<&str> = it
        .filter(|a| !PLUMBING.iter().any(|p| a.starts_with(p)))
        .filter(|a| !a.contains("://") && !a.contains("env://") && !a.contains("file://"))
        .collect();
    let mut call = call.join(" ");
    if call.len() > 200 {
        let mut cut = 200;
        while !call.is_char_boundary(cut) {
            cut -= 1;
        }
        call.truncate(cut);
        call.push('…');
    }
    (name, call)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn search_to_spans() {
        let v = json!({"upstream": {}, "traces": [
            {"trace_id": "b", "root_name": "npm --src=/srv/w/ws --repo=cicd --dir=frontend --node=22 --scripts=build,test --npm-registry=https://npm.example/ --dep-cache=reg.example/cache --dep-cache-password=file:///etc/x --test-workers=2",
             "service": "dagger-woodpecker", "pipeline": "211", "start": "2026-11-10T21:28:51.421329Z", "duration_ms": 37467.0, "span_count": 15},
            {"trace_id": "a", "root_name": "failsafe --repo=Northwind-Labs/cicd --sha=1ebf --github-app-key=env://K --pipeline-url=https://ci.example/repos/61/pipeline/211 provisioning --src=/srv/w",
             "pipeline": "211", "start": "2026-11-10T21:29:35.186113Z", "duration_ms": 130316.4},
            {"trace_id": "c", "root_name": "x"}
        ]});
        let s = spans_from_search(&v);
        assert_eq!(s.len(), 2, "a trace without a start is skipped");
        assert_eq!(s[0]["id"], "b");
        assert_eq!(s[0]["name"], "npm");
        assert_eq!(
            s[0]["call"],
            "--repo=cicd --dir=frontend --node=22 --scripts=build,test"
        );
        assert_eq!(s[0]["pipeline"], 211);
        assert_eq!(s[0]["start"], 1_794_346_131_421i64);
        assert_eq!(s[0]["ms"], 37_467);
        assert_eq!(s[0]["spans"], 15);
        assert_eq!(s[1]["name"], "failsafe");
        assert_eq!(
            s[1]["call"],
            "--repo=Northwind-Labs/cicd --sha=1ebf provisioning"
        );
        assert_eq!(s[1]["ms"], 130_316);
        assert!(s[1].get("spans").is_none());
    }
}
