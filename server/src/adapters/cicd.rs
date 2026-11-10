//! cicd console adapter: what only cicd knows (Postgres-derived), read with
//! cheap polls: lanes/modes + each repo's latest deploy verdict
//! (`/api/roadrunner/mode`, GitHub-token auth, PG-only, every 30 s), and with
//! the read token: the outage watcher (`/api/outage`) and Dagger engine
//! hosts (`/api/engines`).

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::warn;

use crate::adapters::apps::parse_time;
use crate::facts::*;
use crate::model::*;
use crate::runtime::{Adapters, Clock, Ingest};

pub const NAME: &str = "cicd";

#[derive(Deserialize, Debug, Clone, Default)]
pub struct ModeHead {
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub lane: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub failsafe_state: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct ModeRepo {
    pub repo: String,
    #[serde(default)]
    pub setting: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub why: Option<String>,
    #[serde(default)]
    pub fallback_cause: Option<String>,
    #[serde(default)]
    pub fallback_reason: Option<String>,
    #[serde(default)]
    pub held: bool,
    #[serde(default)]
    pub head: Option<ModeHead>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct ModeOut {
    #[serde(default)]
    pub fleet: Value,
    #[serde(default)]
    pub health: Value,
    #[serde(default)]
    pub failover: Value,
    #[serde(default)]
    pub repos: Vec<ModeRepo>,
}

pub fn lane_mode(setting: Option<&str>) -> LaneMode {
    match setting.unwrap_or("") {
        "roadrunner_first" => LaneMode::RoadrunnerFirst,
        "gha_first" => LaneMode::GhaFirst,
        "primary" => LaneMode::Primary,
        "ci" => LaneMode::Ci,
        "failsafe" => LaneMode::Failsafe,
        "ci_only" | "ci-only" => LaneMode::CiOnly,
        _ => LaneMode::None,
    }
}

pub fn facts_from_mode(m: &ModeOut, now: Ms) -> Vec<Fact> {
    let mut lanes = Vec::new();
    let mut out = Vec::new();
    for r in &m.repos {
        let on_gha = r.mode.as_deref() == Some("github-actions");
        let fallback = on_gha && r.setting.as_deref() == Some("roadrunner_first");
        let note = if fallback {
            r.fallback_reason
                .clone()
                .or_else(|| r.fallback_cause.clone().map(|c| format!("fallback: {c}")))
        } else {
            None
        }
        .or_else(|| r.why.clone());
        lanes.push(Lane {
            id: r.repo.clone(),
            mode: lane_mode(r.setting.as_deref()),
            fallback,
            held: r.held,
            note,
        });
        if let Some(h) = &r.head {
            let (Some(sha), Some(verdict)) = (h.sha.as_deref(), h.verdict.as_deref()) else {
                continue;
            };
            let at = h.at.as_deref().and_then(parse_time).unwrap_or(now);
            // `head.lane` says which lane shipped it (a repo on its GitHub Actions
            // fallback reports a plain `deployed`).
            let gha_via = if fallback {
                DeployVia::GhaFallback
            } else {
                DeployVia::Gha
            };
            let lane_via = match h.lane.as_deref() {
                Some("github-actions") => gha_via,
                _ => DeployVia::Roadrunner,
            };
            let (state, via) = match verdict {
                "deployed" => (DeployState::Success, lane_via),
                "deployed_gha" => (
                    DeployState::Success,
                    if fallback {
                        DeployVia::GhaFallback
                    } else {
                        DeployVia::Gha
                    },
                ),
                "deploying" => (DeployState::Running, lane_via),
                "failed" => (DeployState::Failure, lane_via),
                _ => continue,
            };
            out.push(Fact::Deploy(DeployFact {
                app: String::new(),
                repo: r.repo.clone(),
                sha: sha.to_string(),
                via,
                state,
                started: at,
                finished: (state != DeployState::Running).then_some(at),
                pipeline: None,
                url: None,
                source: "cicd".into(),
            }));
        }
    }
    let rr_down = m
        .health
        .pointer("/roadrunner/down")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let failover = m
        .failover
        .get("active")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let fleet_mode = m
        .fleet
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("roadrunner")
        .to_string();
    let since = m
        .health
        .pointer("/roadrunner/bad_since")
        .and_then(Value::as_str)
        .and_then(parse_time);
    let detail = m
        .health
        .pointer("/roadrunner/detail")
        .and_then(Value::as_str)
        .map(str::to_string);
    out.push(Fact::Watcher(WatcherFact {
        observed: now,
        watcher: Watcher {
            id: "outage".into(),
            tripped: failover || rr_down || fleet_mode != "roadrunner",
            since,
            gh_status: "unknown".into(),
            note: Some(format!(
                "fleet lane: {fleet_mode}{}",
                detail.map(|d| format!(" · {d}")).unwrap_or_default()
            )),
        },
    }));
    out.insert(
        0,
        Fact::Lanes(LaneList {
            observed: now,
            lanes,
        }),
    );
    out
}

pub struct CicdAdapter {
    pub base: String,
    /// A GitHub token (member of the RR orgs, read:org) for `/api/roadrunner/mode`.
    pub gh_token: Option<String>,
    /// cicd's SWITCHYARD_READ_TOKEN for the SSO-only GET routes.
    pub read_token: Option<String>,
    pub http: reqwest::Client,
    pub tx: mpsc::Sender<Ingest>,
    pub adapters: Arc<Adapters>,
    pub clock: Clock,
}

impl CicdAdapter {
    async fn get(&self, path: &str, token: &str) -> anyhow::Result<Value> {
        self.adapters.request(NAME, 1);
        let r = self
            .http
            .get(format!("{}{path}", self.base.trim_end_matches('/')))
            .bearer_auth(token)
            .timeout(Duration::from_secs(20))
            .send()
            .await?;
        if !r.status().is_success() {
            anyhow::bail!("GET {path}: HTTP {}", r.status());
        }
        Ok(r.json().await?)
    }

    pub async fn run(self) {
        let mut t = tokio::time::interval(Duration::from_secs(30));
        t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut first = true;
        loop {
            t.tick().await;
            let mut ok = false;
            // The read token first; the GitHub token also opens this route (and keeps
            // lanes flowing if cicd does not know the read token yet).
            let mut mode = None;
            for tok in [self.read_token.as_ref(), self.gh_token.as_ref()]
                .into_iter()
                .flatten()
            {
                match self.get("/api/roadrunner/mode", tok).await {
                    Ok(v) => {
                        mode = Some(Ok(v));
                        break;
                    }
                    Err(e) => mode = Some(Err(e)),
                }
            }
            if let Some(res) = mode {
                match res {
                    Ok(v) => match serde_json::from_value::<ModeOut>(v) {
                        Ok(m) => {
                            let facts = facts_from_mode(&m, (self.clock)());
                            let _ = self
                                .tx
                                .send(Ingest {
                                    facts,
                                    live: !first,
                                })
                                .await;
                            ok = true;
                        }
                        Err(e) => self.adapters.error(NAME, format!("mode parse: {e}")),
                    },
                    Err(e) => {
                        warn!(error = %e, "cicd mode poll failed");
                        self.adapters.error(NAME, format!("{e}"));
                    }
                }
            }
            if let Some(tok) = &self.read_token
                && let Ok(v) = self.get("/api/engines", tok).await
            {
                let facts = engines_from_cicd(&v, (self.clock)());
                let _ = self.tx.send(Ingest { facts, live: true }).await;
            }
            if ok {
                first = false;
                self.adapters.ok(NAME, (self.clock)(), None);
            }
        }
    }
}

/// Dagger engine hosts from cicd `/api/engines` (node-exporter backed).
pub fn engines_from_cicd(v: &Value, now: Ms) -> Vec<Fact> {
    let Some(list) = v.get("engines").and_then(Value::as_array) else {
        return Vec::new();
    };
    let engines = list
        .iter()
        .filter_map(|e| {
            let label = e.get("label").and_then(Value::as_str)?.to_string();
            let f = |k: &str| e.get(k).and_then(Value::as_f64).map(|x| x as f32);
            let agents: Vec<String> = e
                .get("agents")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.get("id").and_then(Value::as_u64))
                        .map(|id| format!("wp-agent-{id}"))
                        .collect()
                })
                .unwrap_or_default();
            Some(Engine {
                id: format!("dagger:{label}"),
                kind: EngineKind::Dagger,
                label: Some(label.clone()),
                platform: Some("linux/amd64".into()),
                host: Some(label),
                online: e.get("reachable").and_then(Value::as_bool).unwrap_or(false),
                slots: e.get("slots").and_then(Value::as_u64).unwrap_or(0) as u32,
                busy: e.get("running").and_then(Value::as_u64).unwrap_or(0) as u32,
                cpu: f("cpu_pct"),
                mem: f("mem_pct"),
                load: f("load1"),
                last_seen: Some(now),
                running: Vec::new(),
                agents,
            })
        })
        .collect();
    vec![Fact::Engines(EngineList {
        source: "cicd".into(),
        observed: now,
        engines,
    })]
}
