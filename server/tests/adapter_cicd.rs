//! cicd console adapter: `/api/roadrunner/mode` (recorded) and `/api/engines`
//! (hand-written from the documented shape; the route is SSO-only and was
//! not recorded) → facts.

mod common;

use common::*;
use serde_json::{Value, json};
use switchyard::adapters::apps::parse_time;
use switchyard::adapters::cicd::*;
use switchyard::facts::*;
use switchyard::model::*;

const M_AT: Ms = 1_794_339_540_000; // 2026-11-10T19:39:00Z

fn t(s: &str) -> Ms {
    parse_time(s).unwrap_or_else(|| panic!("time {s}"))
}

fn mode() -> ModeOut {
    typed("cicd/roadrunner_mode.json")
}

fn lanes(f: &[Fact]) -> &LaneList {
    match &f[0] {
        Fact::Lanes(l) => l,
        other => panic!("first fact is the lane list: {other:?}"),
    }
}

fn watcher(f: &[Fact]) -> &Watcher {
    match f.last() {
        Some(Fact::Watcher(w)) => &w.watcher,
        other => panic!("last fact is the watcher: {other:?}"),
    }
}

fn deploys(f: &[Fact]) -> Vec<&DeployFact> {
    f.iter()
        .filter_map(|x| match x {
            Fact::Deploy(d) => Some(d),
            _ => None,
        })
        .collect()
}

#[test]
fn mode_lanes() {
    let f = facts_from_mode(&mode(), M_AT);
    let l = lanes(&f);
    assert_eq!(l.observed, M_AT);
    let got: Vec<(&str, LaneMode, bool, bool)> = l
        .lanes
        .iter()
        .map(|x| (x.id.as_str(), x.mode, x.fallback, x.held))
        .collect();
    use LaneMode::*;
    assert_eq!(
        got,
        [
            ("Northwind-Labs/nimbus-predict", RoadrunnerFirst, true, true),
            ("Northwind-Labs/cirrus-hub", RoadrunnerFirst, false, false),
            ("Northwind-Labs/aurora-api", RoadrunnerFirst, false, false),
            ("Northwind-Labs/harbor-board", GhaFirst, false, false),
            ("Northwind-Labs/borealis-web", RoadrunnerFirst, false, false),
            ("Northwind-Labs/summit-gale", RoadrunnerFirst, false, false),
            ("Northwind-Labs/delta-stock", RoadrunnerFirst, false, false),
            (
                "Northwind-Labs/glacier-tracker",
                RoadrunnerFirst,
                true,
                true
            ),
            ("Northwind-Labs/meridian-shop", RoadrunnerFirst, true, false),
        ]
    );
    let note = |id: &str| {
        l.lanes
            .iter()
            .find(|x| x.id == id)
            .and_then(|x| x.note.clone())
            .unwrap()
    };
    // On a fallback: the fallback reason; otherwise the lane's why.
    assert_eq!(
        note("Northwind-Labs/meridian-shop"),
        "Roadrunner deploy of ad1474a failed"
    );
    assert_eq!(
        note("Northwind-Labs/nimbus-predict"),
        "no Roadrunner deploy for 33b2dd3 after 10 min"
    );
    assert!(note("Northwind-Labs/cirrus-hub").starts_with("Roadrunner-first: Roadrunner deploys"));
    assert!(note("Northwind-Labs/harbor-board").starts_with("set to GitHub Actions-first"));
}

#[test]
fn mode_head_verdicts_become_deploys() {
    let f = facts_from_mode(&mode(), M_AT);
    assert_eq!(
        f.len(),
        1 + 6 + 1,
        "lanes + 6 verdicts with a deploy + watcher"
    );
    let d = deploys(&f);
    let got: Vec<(&str, &str, DeployState, DeployVia)> = d
        .iter()
        .map(|x| (x.repo.as_str(), &x.sha[..7], x.state, x.via))
        .collect();
    use DeployState::*;
    use DeployVia::*;
    assert_eq!(
        got,
        [
            // deployed_gha on its GitHub Actions fallback.
            (
                "Northwind-Labs/nimbus-predict",
                "c29040c",
                Success,
                GhaFallback
            ),
            ("Northwind-Labs/cirrus-hub", "f917c19", Success, Roadrunner),
            // deployed_gha while on the Roadrunner lane.
            ("Northwind-Labs/aurora-api", "eed5b2a", Success, Gha),
            (
                "Northwind-Labs/harbor-board",
                "0d5c96b",
                Success,
                Roadrunner
            ),
            (
                "Northwind-Labs/borealis-web",
                "be13021",
                Success,
                Roadrunner
            ),
            // `deployed` by the GitHub Actions lane while on its fallback.
            (
                "Northwind-Labs/glacier-tracker",
                "56abd48",
                Success,
                GhaFallback
            ),
        ],
        "skipped / waiting / missing are not deploys"
    );
    for x in &d {
        assert_eq!(x.source, "cicd");
        assert_eq!(x.app, "");
        assert_eq!(x.pipeline, None);
        assert_eq!(x.url, None);
        assert_eq!(x.finished, Some(x.started), "a verdict is one instant");
    }
    let a = d
        .iter()
        .find(|x| x.repo == "Northwind-Labs/aurora-api")
        .unwrap();
    assert_eq!(a.sha, "eed5b2a3b817f288f79cd4a0c9b015e008e6b452");
    assert_eq!(a.started, t("2026-11-09T20:28:47.184979+00:00"));
    assert_eq!(a.started, 1_794_256_127_184);
}

/// cicd says where the head was deployed (`head.lane`). glacier-tracker is on
/// its GitHub Actions fallback and its head verdict is `deployed` with
/// `lane: github-actions` ("56abd48 deployed", not "deployed by Roadrunner"),
/// yet the adapter reports it as a Roadrunner deploy: `head.lane` is ignored.
#[test]
fn deployed_on_the_gha_lane_is_not_a_roadrunner_deploy() {
    let f = facts_from_mode(&mode(), M_AT);
    let d = deploys(&f);
    let g = d
        .iter()
        .find(|x| x.repo == "Northwind-Labs/glacier-tracker")
        .unwrap();
    assert_eq!(g.state, DeployState::Success);
    assert_eq!(g.via, DeployVia::GhaFallback);
}

#[test]
fn mode_watcher_healthy_fleet() {
    let f = facts_from_mode(&mode(), M_AT);
    let w = watcher(&f);
    assert_eq!(w.id, "outage");
    assert!(!w.tripped);
    assert_eq!(w.since, None);
    assert_eq!(w.gh_status, "unknown");
    assert_eq!(
        w.note.as_deref(),
        Some("fleet lane: roadrunner · 4 of 4 agents online; 2 of 2 Dagger engines up")
    );
    let Some(Fact::Watcher(wf)) = f.last() else {
        panic!()
    };
    assert_eq!(wf.observed, M_AT);
}

fn mode_json() -> Value {
    json("cicd/roadrunner_mode.json")
}

#[test]
fn mode_watcher_trips() {
    // Roadrunner down since a time.
    let mut m = mode_json();
    m["health"]["roadrunner"]["down"] = json!(true);
    m["health"]["roadrunner"]["bad_since"] = json!("2026-11-10T19:30:00Z");
    m["health"]["roadrunner"]["detail"] = json!("0 of 4 agents online");
    let m: ModeOut = serde_json::from_value(m).unwrap();
    let f = facts_from_mode(&m, M_AT);
    let w = watcher(&f);
    assert!(w.tripped);
    assert_eq!(w.since, Some(t("2026-11-10T19:30:00Z")));
    assert_eq!(
        w.note.as_deref(),
        Some("fleet lane: roadrunner · 0 of 4 agents online")
    );
    // Failover active.
    let mut m = mode_json();
    m["failover"]["active"] = json!(true);
    let f = facts_from_mode(&serde_json::from_value(m).unwrap(), M_AT);
    assert!(watcher(&f).tripped);
    // The fleet switched to GitHub Actions.
    let mut m = mode_json();
    m["fleet"]["mode"] = json!("gha");
    m["health"]["roadrunner"]["detail"] = Value::Null;
    let f = facts_from_mode(&serde_json::from_value(m).unwrap(), M_AT);
    assert!(watcher(&f).tripped);
    assert_eq!(watcher(&f).note.as_deref(), Some("fleet lane: gha"));
    // An empty payload: nothing tripped, default fleet lane.
    let f = facts_from_mode(&ModeOut::default(), M_AT);
    assert_eq!(f.len(), 2);
    assert!(lanes(&f).lanes.is_empty());
    assert!(!watcher(&f).tripped);
    assert_eq!(watcher(&f).note.as_deref(), Some("fleet lane: roadrunner"));
}

#[test]
fn mode_hand_verdicts() {
    let head = |verdict: &str, sha: Option<&str>, at: Option<&str>| ModeHead {
        at: at.map(str::to_string),
        sha: sha.map(str::to_string),
        lane: Some("roadrunner".into()),
        detail: None,
        verdict: Some(verdict.into()),
        failsafe_state: None,
    };
    let repo = |name: &str, setting: &str, mode: &str, h: ModeHead| ModeRepo {
        repo: name.into(),
        setting: Some(setting.into()),
        mode: Some(mode.into()),
        head: Some(h),
        ..Default::default()
    };
    let m = ModeOut {
        repos: vec![
            repo(
                "o/deploying",
                "roadrunner_first",
                "roadrunner",
                head("deploying", Some("aaa"), Some("2026-11-10T19:00:00Z")),
            ),
            repo(
                "o/failed",
                "primary",
                "roadrunner",
                head("failed", Some("bbb"), None),
            ),
            repo("o/nosha", "ci", "roadrunner", head("deployed", None, None)),
            repo(
                "o/blocked",
                "failsafe",
                "roadrunner",
                head("blocked_ci", Some("ccc"), None),
            ),
            ModeRepo {
                repo: "o/cause".into(),
                setting: Some("roadrunner_first".into()),
                mode: Some("github-actions".into()),
                fallback_cause: Some("outage".into()),
                why: Some("why text".into()),
                ..Default::default()
            },
            ModeRepo {
                repo: "o/plain".into(),
                setting: Some("ci-only".into()),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let f = facts_from_mode(&m, M_AT);
    let d = deploys(&f);
    assert_eq!(d.len(), 2);
    assert_eq!(d[0].repo, "o/deploying");
    assert_eq!(d[0].state, DeployState::Running);
    assert_eq!(d[0].finished, None, "still running");
    assert_eq!(d[0].started, t("2026-11-10T19:00:00Z"));
    assert_eq!(d[1].repo, "o/failed");
    assert_eq!(d[1].state, DeployState::Failure);
    assert_eq!(d[1].via, DeployVia::Roadrunner);
    assert_eq!(d[1].started, M_AT, "no time → observed now");
    let l = &lanes(&f).lanes;
    assert_eq!(l.len(), 6, "every repo has a lane, deploy or not");
    let cause = l.iter().find(|x| x.id == "o/cause").unwrap();
    assert!(cause.fallback);
    assert_eq!(cause.note.as_deref(), Some("fallback: outage"));
    assert_eq!(l[1].mode, LaneMode::Primary);
    assert_eq!(l[2].mode, LaneMode::Ci);
    assert_eq!(l[3].mode, LaneMode::Failsafe);
    assert_eq!(l.last().unwrap().mode, LaneMode::CiOnly);
    assert_eq!(l.last().unwrap().note, None);
}

#[test]
fn lane_mode_table() {
    for (s, want) in [
        (Some("roadrunner_first"), LaneMode::RoadrunnerFirst),
        (Some("gha_first"), LaneMode::GhaFirst),
        (Some("primary"), LaneMode::Primary),
        (Some("ci"), LaneMode::Ci),
        (Some("failsafe"), LaneMode::Failsafe),
        (Some("ci_only"), LaneMode::CiOnly),
        (Some("ci-only"), LaneMode::CiOnly),
        (Some("none"), LaneMode::None),
        (None, LaneMode::None),
    ] {
        assert_eq!(lane_mode(s), want, "{s:?}");
    }
}

#[test]
fn cicd_engines() {
    let v = json("cicd/engines.json");
    let f = engines_from_cicd(&v, M_AT);
    assert_eq!(f.len(), 1);
    let Fact::Engines(l) = &f[0] else { panic!() };
    assert_eq!(l.source, "cicd");
    assert_eq!(l.observed, M_AT);
    assert_eq!(l.engines.len(), 2, "an engine without a label is skipped");
    let e = &l.engines[0];
    assert_eq!(e.id, "dagger:engine-101");
    assert_eq!(e.kind, EngineKind::Dagger);
    assert_eq!(e.label.as_deref(), Some("engine-101"));
    assert_eq!(
        e.host.as_deref(),
        Some("engine-101"),
        "label, never the address"
    );
    assert_eq!(e.platform.as_deref(), Some("linux/amd64"));
    assert!(e.online);
    assert_eq!((e.slots, e.busy), (6, 3));
    assert_eq!(e.cpu, Some(41.5));
    assert_eq!(e.mem, Some(62.0));
    assert_eq!(e.load, Some(5.25));
    assert_eq!(e.last_seen, Some(M_AT));
    assert!(e.running.is_empty());
    assert_eq!(e.agents, ["wp-agent-1", "wp-agent-2"]);
    let e2 = &l.engines[1];
    assert!(!e2.online);
    assert_eq!((e2.slots, e2.busy), (6, 0));
    assert_eq!((e2.cpu, e2.mem, e2.load), (None, None, None));
    assert!(e2.agents.is_empty());
    // Not an engines payload → no facts (the list keeps its last value).
    assert!(engines_from_cicd(&json!({"detail": "Authentication required"}), M_AT).is_empty());
}
