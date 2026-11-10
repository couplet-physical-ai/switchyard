//! Golden snapshots: the sanitized upstream fixtures, through the adapters,
//! into the store; the snapshot and one incremental flush are compared with
//! `tests/golden/{snapshot,delta}.json`. Regenerate with `UPDATE_GOLDEN=1`.

mod common;

use std::collections::BTreeMap;

use common::*;
use serde_json::Value;
use switchyard::adapters::{apps, cicd, github, woodpecker};
use switchyard::facts::*;
use switchyard::model::*;
use switchyard::runtime::build_snapshot;
use switchyard::store::{OpOut, Store, StoreConfig};

/// The store's clock for the golden: 2026-11-10T19:42:00Z, just after the
/// last recorded observation.
const NOW: Ms = 1_794_339_720_000;
/// When each upstream payload was recorded.
const Q_AT: Ms = 1_794_339_490_000; // woodpecker queue + agents
const H_AT: Ms = 1_794_339_690_000; // github heads
const P_AT: Ms = 1_794_339_540_000; // github PRs
const M_AT: Ms = 1_794_339_540_000; // cicd mode + engines
const C_AT: Ms = 1_794_339_454_313; // apps catalog

fn t(s: &str) -> Ms {
    apps::parse_time(s).unwrap()
}

fn store() -> Store {
    Store::new(StoreConfig {
        orgs: vec!["Northwind-Labs".into(), "Northwind-EMS".into()],
        ..StoreConfig::default()
    })
}

fn wp_repo_names() -> BTreeMap<u64, String> {
    typed::<Vec<woodpecker::WpRepo>>("woodpecker/repos_active_p1.json")
        .into_iter()
        .map(|r| (r.id, r.full_name))
        .collect()
}

/// The live event that finishes `wp:Northwind-EMS/ember-api:53` (running → success).
fn final_event() -> Vec<Fact> {
    let e = &wp_events()[3];
    assert_eq!(e.pipeline.status, "success");
    wp_mapper().facts(&e.repo.full_name, e.repo.id, &e.pipeline)
}

/// Every fact of the fleet, except the final event.
fn baseline_facts() -> Vec<Fact> {
    let mut out: Vec<Fact> = Vec::new();
    let m = wp_mapper();
    // ---- woodpecker
    let repos: Vec<woodpecker::WpRepo> = typed("woodpecker/repos_active_p1.json");
    out.push(Fact::Repos(RepoList {
        source: "woodpecker".into(),
        observed: Q_AT,
        repos: repos
            .iter()
            .map(|r| RepoMeta {
                id: r.full_name.clone(),
                default_branch: r.default_branch.clone(),
                woodpecker_id: Some(r.id),
                pushed_at: None,
                archived: false,
            })
            .collect(),
    }));
    for f in [
        "woodpecker/user_feed_latest.json",
        "woodpecker/user_feed.json",
    ] {
        for p in typed::<Vec<woodpecker::WpPipeline>>(f) {
            out.extend(m.facts(&p.full_name, p.repo_id, &p));
        }
    }
    for (f, repo, id) in [
        ("woodpecker/pipeline_full.json", "Northwind-EMS/ember-api", 38),
        (
            "woodpecker/pipeline_full_failure.json",
            "Northwind-Labs/lumen-report",
            47,
        ),
        (
            "woodpecker/pipeline_full_error.json",
            "Northwind-EMS/kestrel-deploy",
            207,
        ),
    ] {
        out.extend(m.facts(repo, id, &typed(f)));
    }
    for e in &wp_events()[..3] {
        out.extend(m.facts(&e.repo.full_name, e.repo.id, &e.pipeline));
    }
    let q: woodpecker::WpQueueInfo = typed("woodpecker/queue_info.json");
    let names = wp_repo_names();
    out.push(Fact::Queue(woodpecker::queue_fact(&q, &names, Q_AT)));
    out.push(Fact::Engines(woodpecker::engines_fact(
        &wp_agents(),
        &q,
        &names,
        Q_AT,
    )));
    // ---- github
    let heads = json("github/heads_page.json")["data"]["organization"]["repositories"]["nodes"]
        .as_array()
        .unwrap()
        .clone();
    let (metas, f) = github::repo_page_facts(&heads, false, H_AT);
    out.extend(f);
    out.push(Fact::Repos(RepoList {
        source: "github:Northwind-Labs".into(),
        observed: H_AT,
        repos: metas,
    }));
    out.extend(github::repo_page_facts(&heads, true, H_AT).1);
    for n in json("github/open_prs_page.json")["data"]["search"]["nodes"]
        .as_array()
        .unwrap()
    {
        let (pr, extra) = github::pr_fact(n, P_AT).unwrap();
        out.push(Fact::Pr(pr));
        out.extend(extra);
    }
    // ---- cicd
    out.extend(cicd::facts_from_mode(
        &typed("cicd/roadrunner_mode.json"),
        M_AT,
    ));
    out.extend(cicd::engines_from_cicd(&json("cicd/engines.json"), M_AT));
    // ---- apps
    out.extend(apps::facts_from_catalog(&typed("apps/catalog.json"), C_AT));
    // ---- hand-made: closed/merged PRs and a probe with a live sha.
    out.extend(hand_made());
    out
}

fn pr(repo: &str, number: u64, head_sha: &str, head: &str) -> PrFact {
    PrFact {
        repo: repo.into(),
        number,
        title: format!("feat: hand-made change {number}"),
        author: "dev-04".into(),
        bot: false,
        draft: false,
        state: PrState::Open,
        created: t("2026-11-10T12:00:00Z"),
        updated: t("2026-11-10T19:00:00Z"),
        head_sha: head_sha.into(),
        head: head.into(),
        base: "main".into(),
        merged_at: None,
        merge_sha: None,
        mergeable: Some(Mergeable::Mergeable),
        review: None,
        ai: None,
        checks: Vec::new(),
        url: format!("https://github.com/{repo}/pull/{number}"),
        observed: P_AT,
    }
}

fn hand_made() -> Vec<Fact> {
    // Merged into the deployed head of borealis-web → deployed.
    let mut a = pr(
        "Northwind-Labs/borealis-web",
        41,
        "41a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
        "feature/change-41",
    );
    a.state = PrState::Merged;
    a.merged_at = Some(t("2026-11-10T19:34:59Z"));
    a.merge_sha = Some("be13021ca83449d513f82b9ab0708be58e876780".into());
    a.updated = t("2026-11-10T19:35:00Z");
    a.review = Some("approved".into());
    // Merged into a commit that never deployed → merged.
    let mut b = pr(
        "Northwind-Labs/cirrus-hub",
        12,
        "12b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
        "feature/change-12",
    );
    b.state = PrState::Merged;
    b.merged_at = Some(t("2026-11-09T23:39:25Z"));
    b.merge_sha = Some("f26d808471def73facfbe91b983f7185dca62555".into());
    b.updated = t("2026-11-09T23:39:26Z");
    // Closed without merging.
    let mut c = pr(
        "Northwind-Labs/delta-stock",
        377,
        "377c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c",
        "feature/change-377",
    );
    c.state = PrState::Closed;
    // Open: draft, changes requested, stale review-required.
    let mut d = pr(
        "Northwind-Labs/aurora-api",
        30,
        "30d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
        "feature/change-30",
    );
    d.draft = true;
    let mut e = pr(
        "Northwind-Labs/aurora-api",
        31,
        "31e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5",
        "feature/change-31",
    );
    e.review = Some("changes_requested".into());
    e.checks = vec![Check {
        name: "ci/woodpecker/pr/ci".into(),
        state: CiState::Success,
        required: true,
    }];
    let mut f = pr(
        "Northwind-Labs/cirrus-hub",
        9,
        "09f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6",
        "feature/change-9",
    );
    f.review = Some("review_required".into());
    f.updated = t("2026-11-06T10:00:00Z");
    f.created = t("2026-11-05T10:00:00Z");
    // A probe that knows the live sha (short form).
    let h = HealthFact {
        app: "delta-stock".into(),
        health: Health::Degraded,
        latency_ms: Some(840),
        checked: NOW - 5_000,
        live_sha: Some("be9ecc4".into()),
        note: Some("slow /healthz".into()),
    };
    vec![
        Fact::Pr(a),
        Fact::Pr(b),
        Fact::Pr(c),
        Fact::Pr(d),
        Fact::Pr(e),
        Fact::Pr(f),
        Fact::Health(h),
    ]
}

fn all_facts() -> Vec<Fact> {
    let mut f = baseline_facts();
    f.extend(final_event());
    f
}

fn build(facts: Vec<Fact>) -> Store {
    let mut s = store();
    for f in facts {
        s.apply(f, false);
    }
    s.flush(NOW);
    s
}

fn snapshot(s: &Store) -> Value {
    serde_json::from_slice(&build_snapshot(s, 1, NOW, "golden")).expect("snapshot json")
}

fn ops_json(ops: &[OpOut]) -> Value {
    let mut b = b"[".to_vec();
    for (i, o) in ops.iter().enumerate() {
        if i > 0 {
            b.push(b',');
        }
        o.write_json(&mut b);
    }
    b.push(b']');
    serde_json::from_slice(&b).expect("ops json")
}

fn golden(name: &str, v: &Value) {
    let path = path(&format!("golden/{name}"));
    let text = serde_json::to_string_pretty(v).unwrap() + "\n";
    if std::env::var("UPDATE_GOLDEN").is_ok_and(|x| x == "1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}; run with UPDATE_GOLDEN=1 to create it",
            path.display()
        )
    });
    if want != text {
        let got = std::env::temp_dir().join(format!("switchyard-golden-{name}"));
        std::fs::write(&got, &text).ok();
        panic!(
            "{} differs from the golden (actual written to {}); \
             review and rerun with UPDATE_GOLDEN=1 if the change is intended",
            path.display(),
            got.display()
        );
    }
}

#[test]
fn snapshot_golden() {
    let s = build(all_facts());
    let v = snapshot(&s);
    assert_eq!(v["protocol"], PROTOCOL);
    assert_eq!(v["seq"], 1);
    assert_eq!(v["at"], NOW);
    golden("snapshot.json", &v);
}

#[test]
fn delta_golden_pipeline_finishes() {
    let mut s = build(baseline_facts());
    let before = snapshot(&s);
    assert_eq!(
        entity(&before, "pipelines", "wp:Northwind-EMS/ember-api:53")["state"],
        "running"
    );
    for f in final_event() {
        s.apply(f, true);
    }
    let ops = s.flush(NOW);
    let v = ops_json(&ops);
    golden("delta.json", &v);
    // What the one transition must say, whatever else changed with it.
    let upserts: Vec<(String, String)> = v
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["op"] == "upsert")
        .map(|o| {
            (
                o["kind"].as_str().unwrap().into(),
                o["id"].as_str().unwrap().into(),
            )
        })
        .collect();
    let has = |k: &str, id: &str| upserts.iter().any(|(a, b)| a == k && b == id);
    assert!(has("pipeline", "wp:Northwind-EMS/ember-api:53"));
    assert!(has(
        "commit",
        "Northwind-EMS/ember-api@aad98fd9b169395a00cd2260d34490c1d1c0e6cb"
    ));
    assert!(has("pr", "Northwind-EMS/ember-api#102"));
    assert!(has("stats", "fleet"));
    let events: Vec<&Value> = v
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["op"] == "event")
        .map(|o| &o["e"])
        .collect();
    assert!(events.iter().any(|e| e["k"] == "finish"
        && e["pipeline"] == "wp:Northwind-EMS/ember-api:53"
        && e["state"] == "success"
        && e["at"] == 1_794_339_604_000i64));
    assert!(
        events
            .iter()
            .all(|e| e["k"] != "enqueue" && e["k"] != "start"),
        "the pipeline was already known and running"
    );
    // Incremental equals full: baseline + delta = the full snapshot.
    let full = snapshot(&build(all_facts()));
    let mut after = snapshot(&s);
    after["seq"] = full["seq"].clone();
    assert_eq!(after, full);
}

#[test]
fn order_independent_and_incremental_equals_full() {
    let fwd = snapshot(&build(all_facts()));
    let mut rev = all_facts();
    rev.reverse();
    assert_eq!(snapshot(&build(rev)), fwd, "arrival order does not matter");
    // Interleave: odd facts first.
    let all = all_facts();
    let (a, b): (Vec<_>, Vec<_>) = all.into_iter().enumerate().partition(|(i, _)| i % 2 == 1);
    let mut s = store();
    for (_, f) in a {
        s.apply(f, false);
    }
    s.flush(NOW);
    for (_, f) in b {
        s.apply(f, true);
    }
    s.flush(NOW);
    assert_eq!(snapshot(&s), fwd);
    // A full recompute changes nothing.
    s.mark_all();
    let ops: Vec<OpOut> = s
        .flush(NOW)
        .into_iter()
        .filter(|o| !matches!(o, OpOut::Event(_)))
        .collect();
    assert!(ops.is_empty(), "{ops:?}");
}

fn entity<'a>(snap: &'a Value, field: &str, id: &str) -> &'a Value {
    snap[field]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == id)
        .unwrap_or_else(|| panic!("{field} {id}"))
}

#[test]
fn derived_values() {
    let v = snapshot(&build(all_facts()));
    // ---- ids
    for d in v["deploys"].as_array().unwrap() {
        assert_eq!(
            d["id"].as_str().unwrap(),
            format!(
                "{}@{}",
                d["repo"].as_str().unwrap(),
                d["sha"].as_str().unwrap()
            )
        );
    }
    for c in v["commits"].as_array().unwrap() {
        assert_eq!(
            c["id"].as_str().unwrap(),
            format!(
                "{}@{}",
                c["repo"].as_str().unwrap(),
                c["sha"].as_str().unwrap()
            )
        );
    }
    // ---- aurora-api: CI running on the new head, the previous head deployed.
    let r = entity(&v, "repos", "Northwind-Labs/aurora-api");
    assert_eq!(
        r["main"]["head"],
        "cba1fed1817599ede1b917712f1ac8d2e629e690"
    );
    assert_eq!(r["main"]["state"], "success", "newest decided commit");
    let dots: Vec<(&str, &str, bool)> = r["main"]["recent"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            (
                &d["sha"].as_str().unwrap()[..7],
                d["state"].as_str().unwrap(),
                d["deployed"].as_bool().unwrap_or(false),
            )
        })
        .collect();
    assert_eq!(
        dots,
        [("eed5b2a", "success", true), ("cba1fed", "running", false)]
    );
    assert_eq!(r["app"], "aurora-api");
    assert_eq!(r["lane"], "roadrunner_first");
    assert_eq!(r["open_prs"], 2);
    assert_eq!(
        r["links"]["woodpecker"],
        Value::Null,
        "repo 64 is not on the recorded page"
    );
    let a = entity(&v, "apps", "aurora-api");
    assert_eq!(a["live_sha"], "eed5b2a3b817f288f79cd4a0c9b015e008e6b452");
    assert_eq!(a["main_sha"], "cba1fed1817599ede1b917712f1ac8d2e629e690");
    assert_eq!(a["behind"], 1);
    let d = entity(
        &v,
        "deploys",
        "Northwind-Labs/aurora-api@eed5b2a3b817f288f79cd4a0c9b015e008e6b452",
    );
    assert_eq!(d["state"], "success");
    assert_eq!(d["via"], "gha");
    assert_eq!(d["app"], "aurora-api");
    let c = entity(
        &v,
        "commits",
        "Northwind-Labs/aurora-api@cba1fed1817599ede1b917712f1ac8d2e629e690",
    );
    assert_eq!(c["ci"], "running");
    assert_eq!(c["branch"], "main");
    assert_eq!(
        c["pipelines"],
        serde_json::json!(["gha:42871000001", "wp:Northwind-Labs/aurora-api:28"])
    );

    // ---- borealis-web: deployed by Roadrunner, the merged PR is deployed.
    let r = entity(&v, "repos", "Northwind-Labs/borealis-web");
    assert_eq!(r["main"]["state"], "success");
    let c = entity(
        &v,
        "commits",
        "Northwind-Labs/borealis-web@be13021ca83449d513f82b9ab0708be58e876780",
    );
    assert_eq!(c["stage"], "deployed");
    assert_eq!(
        c["deploy"]["id"],
        "Northwind-Labs/borealis-web@be13021ca83449d513f82b9ab0708be58e876780"
    );
    assert_eq!(
        entity(&v, "prs", "Northwind-Labs/borealis-web#41")["phase"],
        "deployed"
    );
    let a = entity(&v, "apps", "borealis-web");
    assert_eq!(a["live_sha"], "be13021ca83449d513f82b9ab0708be58e876780");
    assert_eq!(a["behind"], 0);
    let d = entity(
        &v,
        "deploys",
        "Northwind-Labs/borealis-web@be13021ca83449d513f82b9ab0708be58e876780",
    );
    assert_eq!(d["via"], "roadrunner");
    assert_eq!(d["started"], t("2026-11-10T19:36:45Z"), "earliest report");
    assert_eq!(
        d["finished"],
        t("2026-11-10T19:37:12.178783Z"),
        "latest report"
    );

    // ---- kestrel-deploy: an erroring push on main; its commit is the culprit.
    let r = entity(&v, "repos", "Northwind-EMS/kestrel-deploy");
    assert_eq!(r["main"]["state"], "error");
    assert_eq!(
        r["main"]["culprit"],
        "be83166efbf554f6fc5af32ebcb4f359bff0a4f1"
    );
    assert_eq!(
        r["links"]["woodpecker"],
        Value::Null,
        "repo 207 is not on the recorded page"
    );
    let c = entity(
        &v,
        "commits",
        "Northwind-EMS/kestrel-deploy@be83166efbf554f6fc5af32ebcb4f359bff0a4f1",
    );
    assert_eq!(c["stage"], "failed");
    assert_eq!(c["ci"], "error");
    assert_eq!(
        entity(&v, "prs", "Northwind-EMS/kestrel-deploy#267")["phase"],
        "conflict"
    );

    // ---- ember-api: on the woodpecker repo page; PR pipeline done.
    let r = entity(&v, "repos", "Northwind-EMS/ember-api");
    assert_eq!(
        r["links"]["woodpecker"],
        "https://ci.dev.example.com/repos/38"
    );
    assert_eq!(
        r["links"]["cicd"],
        "https://cicd.apps.example.com/pipelines/38"
    );
    let c = entity(
        &v,
        "commits",
        "Northwind-EMS/ember-api@aad98fd9b169395a00cd2260d34490c1d1c0e6cb",
    );
    assert_eq!(c["ci"], "success");
    assert_eq!(c["pr"], 102);
    assert_eq!(c["stage"], "gating");
    assert_eq!(c["branch"], "feature/change-1");
    assert_eq!(
        entity(&v, "prs", "Northwind-EMS/ember-api#100")["phase"],
        "mergeable"
    );
    assert_eq!(entity(&v, "prs", "Northwind-EMS/ember-api#100")["bot"], true);

    // ---- meridian-shop: GHA deploy failed on its fallback lane.
    let d = entity(
        &v,
        "deploys",
        "Northwind-Labs/meridian-shop@a988b12d5807cc1250dae2eae8b63ed942a3c59c",
    );
    assert_eq!(d["state"], "failure");
    assert_eq!(d["via"], "gha");
    assert_eq!(d["pipeline"], "gha:42860000031");
    let r = entity(&v, "repos", "Northwind-Labs/meridian-shop");
    assert_eq!(r["lane"], "roadrunner_first");
    assert_eq!(r["lane_note"], "Roadrunner deploy of ad1474a failed");

    // ---- cirrus-hub: merged PR into a never-deployed commit; stale PR.
    assert_eq!(
        entity(&v, "prs", "Northwind-Labs/cirrus-hub#12")["phase"],
        "merged"
    );
    let p = entity(&v, "prs", "Northwind-Labs/cirrus-hub#9");
    assert_eq!(p["phase"], "review");
    assert_eq!(p["blocked_by"], "review required");
    assert_eq!(p["stale_ms"], 105 * 3_600_000i64, "idle hours, floored");
    let r = entity(&v, "repos", "Northwind-Labs/cirrus-hub");
    assert_eq!(r["main"]["state"], "success");
    let a = entity(&v, "apps", "cirrus-hub");
    assert_eq!(a["live_sha"], "f917c191816f60e33bd397e5c528f3ed7b1f8c9f");
    assert_eq!(a["behind"], 0);

    // ---- delta-stock: a probe reports a short live sha; health degraded.
    let a = entity(&v, "apps", "delta-stock");
    assert_eq!(a["health"], "degraded");
    assert_eq!(a["live_sha"], "be9ecc4");
    assert_eq!(a["behind"], 0, "short sha matches the head by prefix");
    assert_eq!(a["latency_ms"], 840);
    assert_eq!(
        entity(&v, "prs", "Northwind-Labs/delta-stock#377")["phase"],
        "closed"
    );
    let r = entity(&v, "repos", "Northwind-Labs/delta-stock");
    assert_eq!(
        r["main"]["state"], "success",
        "the rollup dot keeps its state"
    );

    // ---- open PRs: draft / changes requested.
    assert_eq!(
        entity(&v, "prs", "Northwind-Labs/aurora-api#30")["phase"],
        "draft"
    );
    let p = entity(&v, "prs", "Northwind-Labs/aurora-api#31");
    assert_eq!(p["phase"], "changes_requested");
    assert_eq!(p["review"]["human"], "changes_requested");
    let p = entity(&v, "prs", "Northwind-Labs/tundra-lab#143");
    assert_eq!(p["phase"], "checks");
    assert_eq!(p["blocked_by"], "failing: ci/woodpecker/pr/security");

    // ---- singletons and fleet
    assert_eq!(v["watcher"]["tripped"], false);
    let q = entity(&v, "queues", "roadrunner");
    assert_eq!(q["pending"], 1);
    assert_eq!(q["items"], serde_json::json!(["wp:Northwind-Labs/ion-tap:6"]));
    let engines: Vec<&str> = v["engines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        engines,
        [
            "dagger:engine-101",
            "dagger:engine-102",
            "wp-agent-1",
            "wp-agent-2",
            "wp-agent-3",
            "wp-agent-37",
            "wp-agent-4"
        ]
    );
    let orgs: Vec<(&str, u64)> = v["orgs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| (o["id"].as_str().unwrap(), o["repos"].as_u64().unwrap()))
        .collect();
    assert!(orgs.iter().any(|(o, _)| *o == "Northwind-Labs"));
    assert!(orgs.iter().any(|(o, _)| *o == "Northwind-EMS"));
}

/// The commit of a just-created pipeline whose CI has not finished must not
/// read "deploying" because its deploy workflow exists in a pending state.
#[test]
fn pending_deploy_workflow_does_not_mean_deploying() {
    let v = snapshot(&build(all_facts()));
    let c = entity(
        &v,
        "commits",
        "Northwind-Labs/aurora-api@cba1fed1817599ede1b917712f1ac8d2e629e690",
    );
    assert_eq!(c["ci"], "running");
    assert_eq!(c["stage"], "building");
}

/// After the Woodpecker pipeline that IS the `ci/woodpecker/pr/ci` check
/// finishes green, the PR should not stay in `checks` on GitHub's stale
/// pending rollup: the commit already says success for the same sha.
#[test]
fn pr_ci_prefers_finished_woodpecker_over_stale_rollup() {
    let v = snapshot(&build(all_facts()));
    let c = entity(
        &v,
        "commits",
        "Northwind-EMS/ember-api@aad98fd9b169395a00cd2260d34490c1d1c0e6cb",
    );
    assert_eq!(c["ci"], "success");
    let p = entity(&v, "prs", "Northwind-EMS/ember-api#102");
    assert_eq!(p["ci"], c["ci"], "same head sha, same CI");
    assert_eq!(p["phase"], "mergeable");
}

/// `deploys_24h` counts deploys, not reports: one deploy of borealis-web
/// at be13021 is reported by the failsafe status AND the cicd verdict.
#[test]
fn deploys_24h_counts_each_deploy_once() {
    let v = snapshot(&build(all_facts()));
    let day = NOW - 24 * 3_600_000;
    let n = v["deploys"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["started"].as_i64().unwrap() >= day)
        .count();
    assert_eq!(v["stats"]["deploys_24h"].as_u64().unwrap() as usize, n);
}

/// A rerun must not move a commit in time: `kestrel-deploy` main has been red
/// since be83166's first pipeline (#71, created 19:27:04); #73 is a rerun
/// (`parent: 71`). The commit's `at` is the max over its pipelines' creation
/// times, so the dot and `main.since` jump to the rerun.
#[test]
fn rerun_does_not_move_the_commit() {
    let v = snapshot(&build(all_facts()));
    let r = entity(&v, "repos", "Northwind-EMS/kestrel-deploy");
    assert_eq!(
        r["main"]["culprit"],
        "be83166efbf554f6fc5af32ebcb4f359bff0a4f1"
    );
    assert_eq!(r["main"]["since"], 1_794_338_824_000i64);
    let c = entity(
        &v,
        "commits",
        "Northwind-EMS/kestrel-deploy@be83166efbf554f6fc5af32ebcb4f359bff0a4f1",
    );
    assert_eq!(c["at"], 1_794_338_824_000i64);
}

/// lumen-report's b39afbc is known only through Woodpecker PR pipeline #112
/// (`refs/pull/21/merge`, head `dependabot/npm_and_yarn/example-lib-2`): the
/// commit should name PR 21 and its head branch, not `pr: null` / `pull/21`.
#[test]
fn woodpecker_pr_commit_knows_its_pr() {
    let v = snapshot(&build(all_facts()));
    let c = entity(
        &v,
        "commits",
        "Northwind-Labs/lumen-report@b39afbc8843cf36efcc96716e1e96844add1e791",
    );
    assert_eq!(c["pr"], 21);
    assert_eq!(c["branch"], "dependabot/npm_and_yarn/example-lib-2");
}
