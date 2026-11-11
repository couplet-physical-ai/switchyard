//! The Factory Floor (contract 0.5): groups, failure clusters, flakes and trends on a
//! small hand-built fleet, with exact expectations.

use serde_json::Value;
use switchyard::facts::*;
use switchyard::model::*;
use switchyard::store::{Store, StoreConfig};

const H: Ms = 3_600_000;
const NOW: Ms = 1_794_340_000_000 - 1_794_340_000_000 % H + 30 * 60_000; // hh:30

#[allow(clippy::too_many_arguments)]
fn run(
    repo: &str,
    n: u64,
    sha: &str,
    branch: &str,
    state: CiState,
    finished: Ms,
    dur: Ms,
    steps: &[(&str, &str, CiState, Option<i32>)],
) -> Fact {
    let created = finished - dur - 5_000;
    Fact::Pipeline(Pipeline {
        id: ids::wp_pipeline(repo, n),
        lane: LaneKind::Roadrunner,
        repo: repo.into(),
        number: n,
        sha: sha.into(),
        branch: branch.into(),
        event: PipelineEvent::Push,
        state,
        created,
        started: Some(created + 5_000),
        finished: Some(finished),
        queue_pos: None,
        expected_ms: None,
        engine: None,
        title: Some(format!("change {n}")),
        author: Some("dev".into()),
        pr: None,
        deploy: false,
        flaky: false,
        workflows: {
            let mut wfs: Vec<Workflow> = Vec::new();
            for (wf, st, s, code) in steps {
                if wfs.last().is_none_or(|w| w.name != *wf) {
                    wfs.push(Workflow {
                        name: wf.to_string(),
                        state,
                        started: Some(created + 5_000),
                        finished: Some(finished),
                        engine: None,
                        steps: vec![],
                    });
                }
                wfs.last_mut().unwrap().steps.push(Step {
                    name: st.to_string(),
                    state: *s,
                    started: Some(created + 5_000),
                    finished: Some(finished),
                    exit_code: *code,
                    cached: None,
                    cluster: None,
                });
            }
            wfs
        },
        url: "https://ci.example/x".into(),
    })
}

fn err(repo: &str, n: u64, wf: &str, step: &str, line: &str) -> Fact {
    Fact::StepError(StepErrorFact {
        pipeline: ids::wp_pipeline(repo, n),
        workflow: wf.into(),
        step: step.into(),
        class: FailClass::Compile,
        line: Some(line.into()),
        exit_code: Some(101),
        observed: NOW,
    })
}

fn apps() -> Fact {
    let app = |id: &str, repo: &str, team: &str| AppMeta {
        id: id.into(),
        repo: Some(repo.into()),
        url: format!("https://{id}.example"),
        runtime: None,
        team: Some(team.into()),
        live_sha: None,
        deployed_at: None,
    };
    Fact::Apps(AppList {
        observed: NOW - H,
        apps: vec![
            app("api", "acme/api", "Software-Team"),
            app("web", "acme/web", "software"),
            app("grid", "volt/grid", "Power Systems"),
            app("misc", "acme/tool", "unknown-team"),
        ],
    })
}

fn store(facts: Vec<Fact>) -> Store {
    let mut s = Store::new(StoreConfig {
        orgs: vec!["acme".into(), "volt".into()],
        ..Default::default()
    });
    for f in facts {
        s.apply(f, false);
    }
    s.flush(NOW);
    s
}

fn get(s: &Store, k: Kind, id: &str) -> Value {
    serde_json::from_str(
        s.table(k)
            .get(id)
            .unwrap_or_else(|| panic!("{} {id} missing: {:?}", k.as_str(), s.table(k).keys())),
    )
    .unwrap()
}

const SHA1: &str = "1111111111111111111111111111111111111111";
const SHA2: &str = "2222222222222222222222222222222222222222";
const SHA3: &str = "3333333333333333333333333333333333333333";

fn floor() -> Store {
    let ok = CiState::Success;
    let bad = CiState::Failure;
    store(vec![
        apps(),
        // acme/api: rust compile fails on main 20 min ago, still failing.
        run(
            "acme/api",
            1,
            SHA1,
            "main",
            bad,
            NOW - 20 * 60_000,
            60_000,
            &[("ci", "rust", bad, Some(101))],
        ),
        err(
            "acme/api",
            1,
            "ci",
            "rust",
            "error: could not compile `my-crate` (lib)",
        ),
        // volt/grid: the same failure 3 h ago, then fixed on main.
        run(
            "volt/grid",
            4,
            SHA2,
            "main",
            bad,
            NOW - 3 * H,
            60_000,
            &[("ci", "rust", bad, Some(101))],
        ),
        err(
            "volt/grid",
            4,
            "ci",
            "rust",
            "error: could not compile `my-crate` (lib)",
        ),
        run(
            "volt/grid",
            5,
            SHA3,
            "main",
            ok,
            NOW - 2 * H,
            60_000,
            &[("ci", "rust", ok, Some(0))],
        ),
        // acme/web: test shard 3 fails, then the rerun of the same sha passes (a flake).
        run(
            "acme/web",
            7,
            SHA1,
            "main",
            bad,
            NOW - 40 * 60_000,
            120_000,
            &[("ci", "test-web-3", bad, Some(1))],
        ),
        run(
            "acme/web",
            8,
            SHA1,
            "main",
            ok,
            NOW - 10 * 60_000,
            120_000,
            &[("ci", "test-web-3", ok, Some(0))],
        ),
        // acme/tool: lint fails (no log read: name + exit only).
        run(
            "acme/tool",
            2,
            SHA2,
            "main",
            bad,
            NOW - 5 * H,
            30_000,
            &[("ci", "lint", bad, Some(1))],
        ),
    ])
}

#[test]
fn groups_come_from_app_teams_else_the_org() {
    let s = floor();
    let g = get(&s, Kind::Group, "team:software");
    assert_eq!(g["name"], "Software");
    assert_eq!(g["kind"], "team");
    assert_eq!(
        g["repos"], 2,
        "acme/api (Software-Team) + acme/web (software)"
    );
    assert_eq!(g["apps"], 2);
    assert_eq!(
        get(&s, Kind::Group, "team:power-systems")["name"],
        "Power systems"
    );
    // An unknown team falls back to the org.
    let org = get(&s, Kind::Group, "org:acme");
    assert_eq!(org["kind"], "org");
    assert_eq!(org["apps"], 1);
    let r: Value = serde_json::from_str(&s.table(Kind::Repo)["acme/tool"]).unwrap();
    assert_eq!(r["group"], "org:acme");
    let r: Value = serde_json::from_str(&s.table(Kind::Repo)["acme/api"]).unwrap();
    assert_eq!(r["group"], "team:software");
}

#[test]
fn same_cause_across_repos_is_one_cluster() {
    let s = floor();
    let clusters: Vec<Value> = s
        .table(Kind::Cluster)
        .values()
        .map(|j| serde_json::from_str(j).unwrap())
        .collect();
    let rust: Vec<&Value> = clusters.iter().filter(|c| c["step"] == "rust").collect();
    assert_eq!(rust.len(), 1, "{clusters:#?}");
    let c = rust[0];
    assert_eq!(c["class"], "compile");
    assert_eq!(c["line"], "error: could not compile `my-crate` (lib)");
    assert_eq!(c["count"], 2);
    assert_eq!(c["count_1h"], 1);
    assert_eq!(
        c["repos"],
        serde_json::json!(["acme/api", "volt/grid"]),
        "most recent first"
    );
    assert_eq!(c["repo_count"], 2);
    assert_eq!(
        c["groups"],
        serde_json::json!(["team:power-systems", "team:software"])
    );
    assert_eq!(c["open"], 1, "volt/grid recovered, acme/api did not");
    assert_eq!(c["exit_code"], 101);
    assert_eq!(c["first_seen"], NOW - 3 * H);
    assert_eq!(c["last_seen"], NOW - 20 * 60_000);
    assert_eq!(
        c["examples"],
        serde_json::json!(["wp:acme/api:1", "wp:volt/grid:4"])
    );
    assert!(
        c["signature"]
            .as_str()
            .unwrap()
            .starts_with("rust · compile · ")
    );
    // Shards fold; a step without a log clusters on name + exit.
    let shard = clusters
        .iter()
        .find(|c| c["step"] == "test-web-#")
        .expect("shard cluster");
    assert_eq!(shard["flaky"], 1);
    assert_eq!(shard["open"], 0, "the rerun passed");
    let lint = clusters
        .iter()
        .find(|c| c["step"] == "lint")
        .expect("lint cluster");
    assert_eq!(lint["class"], "lint");
    assert!(lint.get("line").is_none());
    // The visible failed run links its step to the cluster.
    let p = get(&s, Kind::Pipeline, "wp:acme/api:1");
    assert_eq!(p["workflows"][0]["steps"][0]["cluster"], c["id"]);
}

#[test]
fn a_rerun_that_passes_is_a_flake() {
    let s = floor();
    let f = get(&s, Kind::Flake, "acme/web|ci/test-web-3");
    assert_eq!(f["flips_24h"], 1);
    assert_eq!(f["failures_24h"], 1);
    assert_eq!(f["shas"], serde_json::json!([SHA1]));
    assert_eq!(get(&s, Kind::Pipeline, "wp:acme/web:7")["flaky"], true);
    assert!(
        get(&s, Kind::Pipeline, "wp:acme/api:1")
            .get("flaky")
            .is_none()
    );
    assert_eq!(
        s.table(Kind::Flake).len(),
        1,
        "a fix on another sha is not a flake"
    );
}

#[test]
fn trends_compare_the_last_hour_with_the_baselines() {
    let ok = CiState::Success;
    let mut facts = vec![apps()];
    // 24 h of steady 60 s builds, then the last hour at 180 s.
    let mut n = 1;
    for h in 1..24 {
        facts.push(run(
            "acme/api",
            n,
            SHA1,
            "main",
            ok,
            NOW - h * H - 60_000,
            60_000,
            &[("ci", "rust", ok, Some(0))],
        ));
        n += 1;
    }
    for m in [5, 15, 25, 35, 45, 55] {
        facts.push(run(
            "acme/api",
            n,
            SHA2,
            "main",
            ok,
            NOW - m * 60_000,
            180_000,
            &[("ci", "rust", ok, Some(0))],
        ));
        n += 1;
    }
    // A week-old rollup (beyond the registers) feeds d7.
    let mut old = RollupFact {
        hour: NOW - NOW % H - 5 * 24 * H,
        ..Default::default()
    };
    old.fleet.finished = 10;
    old.fleet.success = 5;
    old.fleet.failed = 5;
    facts.push(Fact::Rollup(old));
    let s = store(facts);
    let t = get(&s, Kind::Trend, "fleet");
    assert_eq!(t["run_ms"]["h1"], 180_000.0);
    assert_eq!(t["run_ms"]["h24"], 60_000.0);
    assert_eq!(t["run_ms"]["dir"], 1);
    assert_eq!(t["run_ms"]["bad"], true);
    assert_eq!(t["pipelines"]["h1"], 6.0);
    assert_eq!(t["pipelines"]["dir"], 1);
    assert!(
        t["pipelines"].get("bad").is_none(),
        "more throughput is never bad"
    );
    assert_eq!(t["pass_rate"]["h1"], 1.0);
    // d7 = 29 successes + the old hour's 5/10: (29 + 5) / (29 + 10).
    assert_eq!(t["pass_rate"]["d7"], 0.87);
    assert_eq!(t["hours_7d"], 26, "25 live hours + the rollup");
    assert_eq!(t["run_ms"]["spark"].as_array().unwrap().len(), 24);
    assert_eq!(t["at"], NOW - NOW % (5 * 60_000));
    // Per group too.
    let g = get(&s, Kind::Trend, "team:software");
    assert_eq!(g["run_ms"]["h1"], 180_000.0);
    // No data = absent, never null.
    assert!(t["intake_ms"].get("h1").is_some());
    let empty = get(&s, Kind::Trend, "team:power-systems");
    assert!(empty["run_ms"].get("h1").is_none());
}

#[test]
fn rollups_persist_what_the_trends_saw() {
    let s = floor();
    // Hours closed ≥ 70 min ago inside the window, none of them twice.
    let rs = s.closed_rollups(0, NOW);
    assert!(!rs.is_empty());
    assert!(
        rs.iter()
            .all(|r| r.hour + H + 10 * 60_000 <= NOW && r.hour >= NOW - 25 * H)
    );
    let three_h = rs
        .iter()
        .find(|r| r.hour == NOW - NOW % H - 3 * H)
        .expect("the hour of volt/grid #4");
    assert_eq!(three_h.fleet.failed, 1);
    assert_eq!(three_h.groups["team:power-systems"].failed, 1);
    assert_eq!(three_h.clusters.values().map(|c| c.n).sum::<u32>(), 1);
    // Feeding them back changes no trend: rollups and registers agree.
    let before = s.table(Kind::Trend).clone();
    let mut s2 = floor();
    for r in rs {
        s2.apply(Fact::Rollup(r), false);
    }
    s2.flush(NOW);
    assert_eq!(&before, s2.table(Kind::Trend));
    // After the latest written hour: only newer hours.
    let later = s.closed_rollups(NOW - NOW % H - 2 * H, NOW);
    assert!(later.iter().all(|r| r.hour > NOW - NOW % H - 2 * H));
}
