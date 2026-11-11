//! Apps platform adapter: the apps catalog's `GET /api/apps` (one cheap,
//! unauthenticated call, memoized server-side, health debounced by the
//! catalog's own prober) every 20 s. Switchyard never re-probes 200+ apps
//! itself. Internal IPs and owner e-mails in the payload are dropped here.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::mpsc;
use tracing::warn;

use crate::facts::*;
use crate::model::*;
use crate::runtime::{Adapters, Clock, Ingest};

pub const NAME: &str = "apps";

#[derive(Deserialize, Debug, Clone, Default)]
pub struct CatalogRow {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub ct_status: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub health: String,
    #[serde(default)]
    pub last_checked: Option<f64>,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub last_deployed_at: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct Catalog {
    #[serde(default)]
    pub rows: Vec<CatalogRow>,
    #[serde(default)]
    pub error: Option<serde_json::Value>,
}

/// Parse `2026-11-10T19:36:36Z` / `…+00:00` / fractional seconds to unix ms.
pub fn parse_time(s: &str) -> Option<Ms> {
    let s = s.trim();
    if s.len() < 19 {
        return None;
    }
    let num = |a: usize, b: usize| -> Option<i64> { s.get(a..b)?.parse().ok() };
    let (y, mo, d, h, mi, se) = (
        num(0, 4)?,
        num(5, 7)?,
        num(8, 10)?,
        num(11, 13)?,
        num(14, 16)?,
        num(17, 19)?,
    );
    let mut frac_ms = 0i64;
    let mut rest = &s[19..];
    if let Some(r) = rest.strip_prefix('.') {
        let digits: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
        let mut f = digits.clone();
        f.truncate(3);
        while f.len() < 3 {
            f.push('0');
        }
        frac_ms = f.parse().unwrap_or(0);
        rest = &r[digits.len()..];
    }
    let mut off_s = 0i64;
    if let Some(sign) = rest.chars().next()
        && (sign == '+' || sign == '-')
    {
        let oh: i64 = rest.get(1..3)?.parse().ok()?;
        let om: i64 = rest.get(4..6).and_then(|x| x.parse().ok()).unwrap_or(0);
        off_s = (oh * 3600 + om * 60) * if sign == '-' { -1 } else { 1 };
    }
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + h * 3600 + mi * 60 + se - off_s) * 1000 + frac_ms)
}

pub fn facts_from_catalog(c: &Catalog, now: Ms) -> Vec<Fact> {
    let mut apps = Vec::new();
    let mut health = Vec::new();
    for r in &c.rows {
        if r.name.is_empty() {
            continue;
        }
        apps.push(AppMeta {
            id: r.name.clone(),
            repo: r.repo.clone().filter(|x| !x.is_empty()),
            url: r.url.clone(),
            runtime: (!r.kind.is_empty()).then(|| r.kind.clone()),
            team: r.team.clone().filter(|x| !x.is_empty()),
            live_sha: None,
            deployed_at: r.last_deployed_at.as_deref().and_then(parse_time),
        });
        let stopped = r.ct_status.as_deref().is_some_and(|s| s != "running") && r.kind == "lxc";
        let h = match (r.health.as_str(), stopped) {
            (_, true) => Health::Down,
            ("up", _) => Health::Up,
            ("down", _) => Health::Down,
            ("degraded", _) => Health::Degraded,
            _ => Health::Unknown,
        };
        health.push(Fact::Health(HealthFact {
            app: r.name.clone(),
            health: h,
            latency_ms: None,
            checked: r.last_checked.map(|t| (t * 1000.0) as Ms).unwrap_or(now),
            live_sha: None,
            note: stopped.then(|| "container stopped".to_string()),
        }));
    }
    let mut out = vec![Fact::Apps(AppList {
        observed: now,
        apps,
    })];
    out.extend(health);
    out
}

/// What to do with one catalog response.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Fresh: ingest, adapter ok.
    Fresh,
    /// The catalog lost its upstream and serves its last-known-good rows: ingest
    /// (the rows are real, a little old), adapter degraded.
    Stale,
    /// No rows: never real (the catalog lost its upstream with nothing cached, or a
    /// glitch). Ingesting it would remove every app (and every team group): keep the
    /// last list.
    Empty,
}

pub fn verdict(c: &Catalog) -> Verdict {
    if c.rows.iter().all(|r| r.name.is_empty()) {
        Verdict::Empty
    } else if c.error.as_ref().is_some_and(|e| !e.is_null()) {
        Verdict::Stale
    } else {
        Verdict::Fresh
    }
}

/// The catalog's own words for a stale / failed response (generic text, no hosts).
fn catalog_error(c: &Catalog) -> String {
    match c.error.as_ref() {
        Some(serde_json::Value::String(s)) => format!("catalog: {s}"),
        _ => "catalog reports a stale snapshot".into(),
    }
}

pub async fn run(
    url: String,
    http: reqwest::Client,
    tx: mpsc::Sender<Ingest>,
    adapters: Arc<Adapters>,
    clock: Clock,
) {
    let mut t = tokio::time::interval(Duration::from_secs(20));
    t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut first = true;
    loop {
        t.tick().await;
        adapters.request(NAME, 1);
        let r = async {
            let r = http
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await?;
            if !r.status().is_success() {
                anyhow::bail!("HTTP {}", r.status());
            }
            Ok::<Catalog, anyhow::Error>(r.json().await?)
        }
        .await;
        match r {
            Ok(c) => {
                let now = clock();
                let v = verdict(&c);
                if v == Verdict::Empty {
                    adapters.error(
                        NAME,
                        format!("{} (no apps; kept the last list)", catalog_error(&c)),
                    );
                    continue;
                }
                let facts = facts_from_catalog(&c, now);
                let _ = tx
                    .send(Ingest {
                        facts,
                        live: !first,
                    })
                    .await;
                first = false;
                if v == Verdict::Stale {
                    adapters.degraded(NAME, catalog_error(&c));
                } else {
                    adapters.ok(NAME, now, None);
                }
            }
            Err(e) => {
                warn!(error = %e, "apps catalog poll failed");
                adapters.error(NAME, format!("{e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_catalog_is_never_ingested() {
        let row = |n: &str| -> CatalogRow {
            serde_json::from_value(
                serde_json::json!({"name": n, "kind": "lxc", "url": "https://x", "health": "up"}),
            )
            .unwrap()
        };
        let c = |rows: Vec<CatalogRow>, e: serde_json::Value| Catalog {
            rows,
            error: Some(e),
        };
        assert_eq!(
            verdict(&c(vec![row("a")], serde_json::Value::Null)),
            Verdict::Fresh
        );
        let stale = c(
            vec![row("a")],
            "Provisioning API unavailable — serving last-known-good data".into(),
        );
        assert_eq!(verdict(&stale), Verdict::Stale);
        assert!(catalog_error(&stale).starts_with("catalog: Provisioning API unavailable"));
        assert_eq!(
            verdict(&c(
                vec![],
                "Provisioning API unavailable — try again shortly.".into()
            )),
            Verdict::Empty
        );
        assert_eq!(
            verdict(&c(vec![], serde_json::Value::Null)),
            Verdict::Empty,
            "even without an error"
        );
        assert_eq!(
            verdict(&c(vec![row("")], serde_json::Value::Null)),
            Verdict::Empty
        );
    }

    #[test]
    fn parses_times() {
        assert_eq!(parse_time("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_time("2026-11-10T19:36:36Z"), Some(1_794_339_396_000));
        assert_eq!(
            parse_time("2026-11-10T19:36:36.5+00:00"),
            Some(1_794_339_396_500)
        );
        assert_eq!(
            parse_time("2026-11-10T20:36:36+01:00"),
            Some(1_794_339_396_000)
        );
        assert_eq!(parse_time("nope"), None);
    }
}
