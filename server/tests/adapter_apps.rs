//! Apps platform adapter: the apps catalog's `GET /api/apps` → facts.

mod common;

use common::*;
use switchyard::adapters::apps::*;
use switchyard::facts::*;
use switchyard::model::*;

const C_AT: Ms = 1_794_339_454_313; // the catalog's own `now`: 2026-11-10T19:37:34.313899Z

fn catalog() -> Catalog {
    typed("apps/catalog.json")
}

fn split(f: &[Fact]) -> (&AppList, Vec<&HealthFact>) {
    let Fact::Apps(a) = &f[0] else {
        panic!("first fact is the app list: {:?}", f[0])
    };
    let h = f[1..]
        .iter()
        .map(|x| match x {
            Fact::Health(h) => h,
            other => panic!("{other:?}"),
        })
        .collect();
    (a, h)
}

#[test]
fn catalog_payload_shape() {
    let c = catalog();
    assert_eq!(c.rows.len(), 7);
    assert!(c.error.as_ref().is_none_or(|e| e.is_null()));
    let raw = read("apps/catalog.json");
    // The adapter drops internal IPs and owner e-mails; the fixture has none either.
    assert!(!raw.contains("\"ip\""));
    assert_eq!(parse_time("2026-11-10T19:37:34.313899+00:00"), Some(C_AT));
}

#[test]
fn catalog_to_apps_and_health() {
    let f = facts_from_catalog(&catalog(), C_AT);
    assert_eq!(f.len(), 8, "one app list + one health per app");
    let (apps, health) = split(&f);
    assert_eq!(apps.observed, C_AT);
    let ids: Vec<&str> = apps.apps.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "borealis-web",
            "cirrus-hub",
            "delta-stock",
            "aurora-api",
            "meridian-shop",
            "harbor",
            "static-site-01"
        ]
    );
    let a = &apps.apps[3];
    assert_eq!(a.repo.as_deref(), Some("Northwind-Labs/aurora-api"));
    assert_eq!(a.url, "https://aurora-api.apps.example.internal/");
    assert_eq!(a.runtime.as_deref(), Some("lxc"));
    assert_eq!(a.team.as_deref(), Some("software"));
    assert_eq!(a.live_sha, None, "the catalog does not know the live sha");
    assert_eq!(
        a.deployed_at,
        parse_time("2026-11-09T20:15:20Z"),
        "last_deployed_at → ms"
    );
    assert_eq!(a.deployed_at, Some(1_794_255_320_000));
    let harbor = &apps.apps[5];
    assert_eq!(harbor.runtime.as_deref(), Some("external"));
    assert_eq!(harbor.repo.as_deref(), Some("Northwind-Labs/harbor-board"));
    assert_eq!(harbor.deployed_at, None);
    let st = &apps.apps[6];
    assert_eq!(st.repo, None);
    assert_eq!(st.runtime.as_deref(), Some("static"));

    assert_eq!(health.len(), 7);
    for (h, a) in health.iter().zip(&apps.apps) {
        assert_eq!(h.app, a.id);
        assert_eq!(h.health, Health::Up);
        assert_eq!(h.latency_ms, None);
        assert_eq!(h.live_sha, None);
        assert_eq!(h.note, None, "running or not a container");
    }
    // Fractional unix seconds → ms (truncated).
    assert_eq!(health[0].checked, 1_794_339_429_000);
    assert_eq!(health[1].checked, 1_794_339_429_003);
    assert_eq!(health[2].checked, 1_794_339_428_996);
}

fn row(name: &str, kind: &str, ct: Option<&str>, health: &str) -> CatalogRow {
    CatalogRow {
        name: name.into(),
        kind: kind.into(),
        ct_status: ct.map(str::to_string),
        url: format!("https://{name}.apps.example.internal/"),
        health: health.into(),
        ..Default::default()
    }
}

#[test]
fn health_mapping_and_stopped_containers() {
    let c = Catalog {
        rows: vec![
            row("stopped", "lxc", Some("stopped"), "up"),
            row("down", "lxc", Some("running"), "down"),
            row("slow", "lxc", Some("running"), "degraded"),
            row("odd", "lxc", Some("running"), ""),
            row("static-up", "static", Some(""), "up"),
            row("ext-unknown", "external", None, "unknown"),
            row("", "lxc", Some("running"), "up"),
        ],
        error: None,
    };
    let f = facts_from_catalog(&c, 42);
    let (apps, health) = split(&f);
    assert_eq!(apps.apps.len(), 6, "a nameless row is skipped");
    let got: Vec<(&str, Health, Option<&str>, Ms)> = health
        .iter()
        .map(|h| (h.app.as_str(), h.health, h.note.as_deref(), h.checked))
        .collect();
    assert_eq!(
        got,
        [
            ("stopped", Health::Down, Some("container stopped"), 42),
            ("down", Health::Down, None, 42),
            ("slow", Health::Degraded, None, 42),
            ("odd", Health::Unknown, None, 42),
            ("static-up", Health::Up, None, 42),
            ("ext-unknown", Health::Unknown, None, 42),
        ]
    );
    // Empty repo/team strings are absent, not empty.
    let mut r = row("x", "lxc", None, "up");
    r.repo = Some(String::new());
    r.team = Some(String::new());
    r.kind = String::new();
    r.last_deployed_at = Some("not a time".into());
    let f = facts_from_catalog(
        &Catalog {
            rows: vec![r],
            error: None,
        },
        1,
    );
    let (apps, _) = split(&f);
    assert_eq!(apps.apps[0].repo, None);
    assert_eq!(apps.apps[0].team, None);
    assert_eq!(apps.apps[0].runtime, None);
    assert_eq!(apps.apps[0].deployed_at, None);
}

#[test]
fn stale_catalog_still_parses() {
    let c: Catalog =
        serde_json::from_str(r#"{"rows":[],"error":{"detail":"stale snapshot"}}"#).unwrap();
    assert!(c.error.is_some());
    let f = facts_from_catalog(&c, 5);
    assert_eq!(f.len(), 1);
    let c: Catalog = serde_json::from_str("{}").unwrap();
    assert!(c.rows.is_empty());
}

#[test]
fn parse_time_variants() {
    for (s, want) in [
        ("2026-11-10T19:36:36Z", Some(1_794_339_396_000)),
        ("2026-11-10T19:36:36+00:00", Some(1_794_339_396_000)),
        ("  2026-11-10T19:36:36Z  ", Some(1_794_339_396_000)),
        ("2026-11-10 19:36:36", Some(1_794_339_396_000)),
        ("2026-11-10T19:36:36.5Z", Some(1_794_339_396_500)),
        ("2026-11-10T19:36:36.123456789Z", Some(1_794_339_396_123)),
        ("2026-11-10T19:02:00.816610+00:00", Some(1_794_337_320_816)),
        ("2026-11-10T14:06:36-05:30", Some(1_794_339_396_000)),
        ("2026-11-11T00:36:36+05", Some(1_794_339_396_000)),
        ("1970-01-01T00:00:00Z", Some(0)),
        ("1969-12-31T23:59:59Z", Some(-1000)),
        ("2024-02-29T12:00:00Z", Some(1_709_208_000_000)),
        ("2026-11-10", None),
        ("", None),
        ("garbage-garbage-garbage", None),
        ("2026-11-10T19:36:36+xx:00", None),
    ] {
        assert_eq!(parse_time(s), want, "{s:?}");
    }
}
