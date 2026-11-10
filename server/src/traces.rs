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

    /// Spans for one commit's pipelines (empty when cicd has none or is unreachable).
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
            .query(&[("repo", repo), ("sha", sha)])
            .bearer_auth(token)
            .timeout(Duration::from_secs(8))
            .send()
            .await
            .ok()?;
        let v: Option<Value> = if r.status().is_success() {
            r.json().await.ok()
        } else {
            None
        };
        self.cache.lock().insert(key, (Instant::now(), v.clone()));
        v
    }
}
