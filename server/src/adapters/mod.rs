//! Upstream adapters: one task per upstream, each sending fact batches to the
//! reducer. Upstream cost is independent of the number of clients.

pub mod apps;
pub mod cicd;
pub mod github;
pub mod woodpecker;

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::runtime::{Adapters, Clock, Ingest};

/// Upstream configuration (all from the environment; nothing secret is logged).
#[derive(Clone, Debug, Default)]
pub struct UpstreamCfg {
    pub woodpecker_url: String,
    pub woodpecker_public_url: String,
    pub woodpecker_token: Option<String>,
    pub github_token: Option<String>,
    pub github_api: String,
    /// GitHub web (deep links).
    pub github_web: String,
    pub cicd_url: String,
    pub cicd_token: Option<String>,
    pub catalog_url: String,
    pub backfill_hours: i64,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl UpstreamCfg {
    pub fn from_env() -> UpstreamCfg {
        UpstreamCfg {
            woodpecker_url: env("WOODPECKER_URL")
                .unwrap_or_else(|| "https://ci.dev.example.com".into()),
            woodpecker_public_url: env("WOODPECKER_PUBLIC_URL")
                .unwrap_or_else(|| "https://ci.dev.example.com".into()),
            woodpecker_token: env("WOODPECKER_TOKEN"),
            github_token: env("GITHUB_TOKEN").or_else(|| env("GITHUB_BOT_TOKEN")),
            github_api: env("GITHUB_API_URL").unwrap_or_else(|| "https://api.github.com".into()),
            github_web: env("GITHUB_WEB_URL").unwrap_or_else(|| "https://github.com".into()),
            cicd_url: env("CICD_URL").unwrap_or_else(|| "https://cicd.apps.example.com".into()),
            cicd_token: env("CICD_READ_TOKEN").or_else(|| env("SWITCHYARD_READ_TOKEN")),
            catalog_url: env("APPS_CATALOG_URL")
                .unwrap_or_else(|| "https://catalog.apps.example.com/api/apps".into()),
            backfill_hours: env("SWITCHYARD_BACKFILL_HOURS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(24),
        }
    }
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(concat!("switchyard-server/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(10))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .build()
        .expect("http client")
}

/// Start every configured adapter. An adapter without credentials registers
/// as disabled (readyz ignores it) instead of failing.
pub fn spawn_all(
    cfg: &UpstreamCfg,
    orgs: &[String],
    tx: mpsc::Sender<Ingest>,
    adapters: Arc<Adapters>,
    clock: Clock,
) {
    let http = http_client();
    match &cfg.github_token {
        Some(tok) => {
            adapters.register(
                github::NAME,
                true,
                Some("GraphQL polls: heads 45-90 s, PRs 60 s".into()),
            );
            let a = github::GithubAdapter {
                api: cfg.github_api.clone(),
                token: tok.clone(),
                orgs: orgs.to_vec(),
                http: http.clone(),
                tx: tx.clone(),
                adapters: adapters.clone(),
                clock: clock.clone(),
            };
            tokio::spawn(a.run());
        }
        None => adapters.register(github::NAME, false, Some("GITHUB_TOKEN unset".into())),
    }
    match &cfg.woodpecker_token {
        Some(tok) => {
            adapters.register(
                woodpecker::NAME,
                true,
                Some("SSE /api/stream/events + polls".into()),
            );
            let client = woodpecker::WpClient::new(
                cfg.woodpecker_url.clone(),
                cfg.woodpecker_public_url.clone(),
                tok.clone(),
                http.clone(),
                adapters.clone(),
            );
            let a = woodpecker::WpAdapter {
                client,
                tx: tx.clone(),
                logs_live: None,
                logs_back: None,
                adapters: adapters.clone(),
                clock: clock.clone(),
                backfill_ms: cfg.backfill_hours * 3_600_000,
            };
            tokio::spawn(a.run());
        }
        None => adapters.register(
            woodpecker::NAME,
            false,
            Some("WOODPECKER_TOKEN unset".into()),
        ),
    }
    adapters.register(
        apps::NAME,
        true,
        Some("apps catalog /api/apps every 20 s".into()),
    );
    tokio::spawn(apps::run(
        cfg.catalog_url.clone(),
        http.clone(),
        tx.clone(),
        adapters.clone(),
        clock.clone(),
    ));
    if cfg.cicd_token.is_some() || cfg.github_token.is_some() {
        adapters.register(
            cicd::NAME,
            true,
            Some("lanes + deploy verdicts every 30 s".into()),
        );
        let a = cicd::CicdAdapter {
            base: cfg.cicd_url.clone(),
            gh_token: cfg.github_token.clone(),
            read_token: cfg.cicd_token.clone(),
            http: http.clone(),
            tx: tx.clone(),
            adapters: adapters.clone(),
            clock: clock.clone(),
        };
        tokio::spawn(a.run());
    } else {
        adapters.register(
            cicd::NAME,
            false,
            Some("no GITHUB_TOKEN / CICD_READ_TOKEN".into()),
        );
    }
}
