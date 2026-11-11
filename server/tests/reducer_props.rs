//! Property tests for the store: any arrival order of the same facts (with
//! duplicates, with flushes interleaved anywhere) yields the same state, and
//! incremental flushes equal a full recompute.

use std::collections::BTreeMap;
use std::sync::Arc;

use proptest::prelude::*;
use switchyard::facts::*;
use switchyard::model::*;
use switchyard::store::{Store, StoreConfig};

const NOW: Ms = 1_794_340_000_000;
const REPOS: [&str; 3] = ["acme/api", "acme/web", "other/tool"];
const SHAS: [&str; 5] = [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "cccccccccccccccccccccccccccccccccccccccc",
    "dddddddddddddddddddddddddddddddddddddddd",
    "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

fn ci() -> impl Strategy<Value = CiState> {
    prop_oneof![
        Just(CiState::Success),
        Just(CiState::Failure),
        Just(CiState::Running),
        Just(CiState::Pending),
        Just(CiState::Canceled),
        Just(CiState::Error),
        Just(CiState::Skipped),
    ]
}

fn t() -> impl Strategy<Value = Ms> {
    (0i64..20).prop_map(|m| NOW - 3_600_000 + m * 60_000)
}

fn repo() -> impl Strategy<Value = String> {
    (0usize..REPOS.len()).prop_map(|i| REPOS[i].to_string())
}
fn sha() -> impl Strategy<Value = String> {
    (0usize..SHAS.len()).prop_map(|i| SHAS[i].to_string())
}

fn pipeline() -> impl Strategy<Value = Fact> {
    (
        repo(),
        sha(),
        1u64..4,
        ci(),
        t(),
        0i64..30,
        any::<bool>(),
        any::<bool>(),
        0u8..3,
        ci(),
    )
        .prop_map(
            |(repo, sha, number, state, created, dur, pr, deploy, steps, step_state)| {
                let started = if state.rank() >= 2 {
                    Some(created + 5_000)
                } else {
                    None
                };
                let finished = if state.is_done() {
                    Some(created + 5_000 + dur * 10_000)
                } else {
                    None
                };
                let event = if pr {
                    PipelineEvent::PullRequest
                } else {
                    PipelineEvent::Push
                };
                Fact::Pipeline(Pipeline {
                    id: ids::wp_pipeline(&repo, number),
                    lane: LaneKind::Roadrunner,
                    repo: repo.clone(),
                    number,
                    sha,
                    branch: if pr { "feature".into() } else { "main".into() },
                    event,
                    state,
                    created,
                    started,
                    finished,
                    queue_pos: None,
                    expected_ms: None,
                    engine: started.map(|_| "dagger-ci-153-1".to_string()),
                    title: Some(format!("change {number}")),
                    author: Some(if number == 2 {
                        "renovate[bot]".into()
                    } else {
                        "dev".into()
                    }),
                    pr: pr.then_some(number + 10),
                    deploy: deploy && !pr,
                    flaky: false,
                    workflows: (0..steps)
                        .map(|i| Workflow {
                            name: if deploy && i == 1 {
                                "deploy".into()
                            } else {
                                format!("wf{i}")
                            },
                            state,
                            started,
                            finished,
                            engine: None,
                            steps: vec![Step {
                                name: "s".into(),
                                state: step_state,
                                started,
                                finished,
                                exit_code: None,
                                cached: None,
                                cluster: None,
                                url: None,
                            }],
                        })
                        .collect(),
                    url: "https://ci.example/x".into(),
                    links: Default::default(),
                })
            },
        )
}

fn commit() -> impl Strategy<Value = Fact> {
    (
        repo(),
        sha(),
        prop_oneof![Just("main"), Just("feature"), Just("master")],
        t(),
        0u8..3,
    )
        .prop_map(|(repo, sha, branch, at, prio)| {
            Fact::Commit(CommitFact {
                repo,
                sha: sha.clone(),
                branch: branch.into(),
                title: format!("title {}", &sha[..3]),
                author: "dev".into(),
                bot: false,
                at,
                prio,
            })
        })
}

fn pr() -> impl Strategy<Value = Fact> {
    (
        repo(),
        11u64..14,
        sha(),
        prop::option::of(sha()),
        0u8..3,
        t(),
        t(),
        any::<bool>(),
        0u8..3,
        ci(),
    )
        .prop_map(
            |(repo, number, head, merge, st, created, observed, draft, rv, check)| {
                let state = match st {
                    0 => PrState::Open,
                    1 => PrState::Merged,
                    _ => PrState::Closed,
                };
                Fact::Pr(PrFact {
                    repo,
                    number,
                    title: format!("pr {number}"),
                    author: "dev".into(),
                    bot: false,
                    draft,
                    state,
                    created,
                    updated: created.max(observed),
                    head_sha: head,
                    head: "feature".into(),
                    base: "main".into(),
                    merged_at: (state == PrState::Merged).then_some(observed),
                    merge_sha: if state == PrState::Merged {
                        merge
                    } else {
                        None
                    },
                    mergeable: Some(if rv == 2 {
                        Mergeable::Conflicting
                    } else {
                        Mergeable::Mergeable
                    }),
                    review: Some(
                        ["approved", "review_required", "changes_requested"][rv as usize].into(),
                    ),
                    ai: None,
                    checks: vec![Check {
                        name: "ci/woodpecker/pr/ci".into(),
                        state: check,
                        required: true,
                    }],
                    url: "https://github.com/x/y/pull/1".into(),
                    observed,
                })
            },
        )
}

fn status() -> impl Strategy<Value = Fact> {
    (
        repo(),
        sha(),
        prop_oneof![
            Just("ci/failsafe-deploy"),
            Just("ci/woodpecker/push/ci"),
            Just("build")
        ],
        ci(),
        t(),
    )
        .prop_map(|(repo, sha, context, state, at)| {
            Fact::Status(StatusFact {
                repo,
                sha,
                context: context.into(),
                state,
                at,
                url: None,
            })
        })
}

fn deploy() -> impl Strategy<Value = Fact> {
    (
        repo(),
        sha(),
        0u8..4,
        prop_oneof![Just("wp"), Just("status"), Just("gha"), Just("cicd")],
        t(),
    )
        .prop_map(|(repo, sha, st, source, started)| {
            let state = [
                DeployState::Pending,
                DeployState::Running,
                DeployState::Success,
                DeployState::Failure,
            ][st as usize];
            Fact::Deploy(DeployFact {
                app: String::new(),
                repo,
                sha,
                via: if source == "gha" {
                    DeployVia::Gha
                } else {
                    DeployVia::Roadrunner
                },
                state,
                started,
                finished: (st >= 2).then_some(started + 60_000),
                pipeline: None,
                url: None,
                source: source.into(),
            })
        })
}

fn misc() -> impl Strategy<Value = Fact> {
    prop_oneof![
        (t(), any::<bool>()).prop_map(|(observed, two)| Fact::Repos(RepoList {
            source: if two {
                "github:acme".into()
            } else {
                "woodpecker".into()
            },
            observed,
            repos: REPOS
                .iter()
                .take(if two { 2 } else { 3 })
                .map(|r| RepoMeta {
                    id: r.to_string(),
                    default_branch: if two && *r == "acme/web" {
                        "master".into()
                    } else {
                        "main".into()
                    },
                    woodpecker_id: (!two).then_some(7),
                    pushed_at: None,
                    archived: false,
                })
                .collect(),
        })),
        (t(), any::<bool>()).prop_map(|(observed, with_web)| Fact::Apps(AppList {
            observed,
            apps: [("api", "acme/api"), ("web", "acme/web")]
                .iter()
                .filter(|(a, _)| with_web || *a == "api")
                .map(|(a, r)| AppMeta {
                    id: a.to_string(),
                    repo: Some(r.to_string()),
                    url: format!("https://{a}.example"),
                    runtime: None,
                    // Teams move repos between groups (and back to their org).
                    team: match (*a, with_web) {
                        ("api", true) => Some("Platform-Team".into()),
                        ("api", false) => Some("unknown-team".into()),
                        _ => Some("software".into()),
                    },
                    live_sha: None,
                    deployed_at: None,
                    status_url: None,
                    logs_url: None,
                })
                .collect(),
        })),
        (t(), 0u8..3).prop_map(|(checked, h)| Fact::Health(HealthFact {
            app: "api".into(),
            health: [Health::Up, Health::Down, Health::Degraded][h as usize],
            latency_ms: None,
            checked,
            live_sha: None,
            note: None,
        })),
        (t(), 0u8..3, any::<bool>()).prop_map(|(observed, m, fb)| Fact::Lanes(LaneList {
            observed,
            lanes: vec![Lane {
                id: "acme/api".into(),
                mode: [
                    LaneMode::RoadrunnerFirst,
                    LaneMode::GhaFirst,
                    LaneMode::Primary
                ][m as usize],
                fallback: fb,
                held: false,
                note: None,
            }],
        })),
        (t(), 0u32..3).prop_map(|(observed, pending)| Fact::Queue(QueueFact {
            observed,
            queue: Queue {
                id: "roadrunner".into(),
                pending,
                running: 1,
                waiting: 0,
                pipelines_running: 1,
                paused: false,
                oldest_wait_ms: 0,
                items: (1..=pending as u64)
                    .map(|n| ids::wp_pipeline("acme/api", n))
                    .collect(),
                url: None,
            },
        })),
        (t(), 0u32..3).prop_map(|(observed, busy)| Fact::Engines(EngineList {
            source: "woodpecker".into(),
            observed,
            engines: vec![Engine {
                id: "wp-agent-1".into(),
                kind: EngineKind::WpAgent,
                label: None,
                platform: None,
                host: None,
                online: true,
                slots: 3,
                busy,
                cpu: None,
                mem: None,
                load: None,
                last_seen: Some(observed),
                running: vec![],
                agents: vec![],
                url: None,
            }],
        })),
        (t(), any::<bool>()).prop_map(|(observed, tripped)| Fact::Watcher(WatcherFact {
            observed,
            watcher: Watcher {
                id: "outage".into(),
                tripped,
                since: None,
                gh_status: "ok".into(),
                note: None
            },
        })),
        (repo(), t()).prop_map(|(repo, observed)| Fact::MainHist(MainHist {
            repo,
            observed,
            dots: SHAS[..3]
                .iter()
                .enumerate()
                .map(|(i, s)| Dot {
                    sha: s.to_string(),
                    at: NOW - 30 * 3_600_000 + i as i64 * 60_000,
                    state: if i == 1 {
                        CiState::Failure
                    } else {
                        CiState::Success
                    },
                    author: "old".into(),
                    bot: false,
                    title: "old".into(),
                    deployed: false,
                    culprit: false,
                })
                .collect(),
        })),
    ]
}

/// A failure signature read from a failed step's log (may name a run that is not
/// failed, or not known yet: order must not matter).
fn step_error() -> impl Strategy<Value = Fact> {
    (repo(), 1u64..4, 0u8..3, 0u8..3, 0i64..5).prop_map(|(repo, number, wf, line, obs)| {
        Fact::StepError(StepErrorFact {
            pipeline: ids::wp_pipeline(&repo, number),
            workflow: if wf == 2 {
                "deploy".into()
            } else {
                format!("wf{wf}")
            },
            step: "s".into(),
            class: if line == 0 {
                FailClass::Test
            } else {
                FailClass::Compile
            },
            line: (line > 0).then(|| format!("error: could not compile `crate-{line}`")),
            exit_code: Some(1),
            observed: NOW - 1_000_000 + obs * 1_000,
        })
    })
}

fn fact() -> impl Strategy<Value = Fact> {
    prop_oneof![3 => pipeline(), 2 => commit(), 2 => pr(), 2 => status(), 2 => deploy(), 2 => misc(), 1 => step_error()]
}

fn tables(s: &Store) -> BTreeMap<&'static str, BTreeMap<String, Arc<str>>> {
    Kind::ALL
        .iter()
        .map(|k| (k.as_str(), s.table(*k).clone()))
        .collect()
}

type Tables = BTreeMap<&'static str, BTreeMap<String, Arc<str>>>;

fn diff(a: &Tables, b: &Tables) -> String {
    let mut out = String::new();
    for (k, ta) in a {
        let tb = &b[k];
        for (id, va) in ta {
            match tb.get(id) {
                None => out.push_str(&format!("\n- only left {k} {id}: {va}")),
                Some(vb) if vb != va => {
                    out.push_str(&format!("\n- {k} {id}\n   left : {va}\n   right: {vb}"))
                }
                _ => {}
            }
        }
        for (id, vb) in tb {
            if !ta.contains_key(id) {
                out.push_str(&format!("\n- only right {k} {id}: {vb}"));
            }
        }
    }
    out
}

fn run(facts: &[Fact], flush_every: usize) -> Store {
    let mut s = Store::new(StoreConfig {
        orgs: vec!["acme".into()],
        ..Default::default()
    });
    for (i, f) in facts.iter().enumerate() {
        s.apply(f.clone(), true);
        if flush_every > 0 && i % flush_every == 0 {
            s.flush(NOW);
        }
    }
    s.flush(NOW);
    s
}

fn shuffle<T: Clone>(v: &[T], seed: u64) -> Vec<T> {
    // Deterministic Fisher-Yates driven by an LCG (the seed comes from proptest).
    let mut out = v.to_vec();
    let mut x = seed | 1;
    for i in (1..out.len()).rev() {
        x = x
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let j = (x >> 33) as usize % (i + 1);
        out.swap(i, j);
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(400), .. ProptestConfig::default() })]

    #[test]
    fn any_order_same_state(facts in prop::collection::vec(fact(), 1..40), seed in any::<u64>(), every in 0usize..6) {
        let a = run(&facts, 0);
        let shuffled = shuffle(&facts, seed);
        let b = run(&shuffled, every);
        let (ta, tb) = (tables(&a), tables(&b));
        prop_assert!(ta == tb, "{}", diff(&ta, &tb));
    }

    #[test]
    fn duplicates_are_idempotent(facts in prop::collection::vec(fact(), 1..30), seed in any::<u64>()) {
        let a = run(&facts, 0);
        let mut doubled = facts.clone();
        doubled.extend(shuffle(&facts, seed));
        let b = run(&doubled, 3);
        let (ta, tb) = (tables(&a), tables(&b));
        prop_assert!(ta == tb, "{}", diff(&ta, &tb));
    }

    #[test]
    fn incremental_equals_full_recompute(facts in prop::collection::vec(fact(), 1..40), every in 1usize..5) {
        let mut s = run(&facts, every);
        let before = tables(&s);
        s.mark_all();
        let ops = s.flush(NOW);
        let changed: Vec<_> = ops.iter().filter(|o| !matches!(o, switchyard::store::OpOut::Event(_))).collect();
        prop_assert!(changed.is_empty(), "full recompute changed {:?}", changed);
        prop_assert_eq!(before, tables(&s));
    }

    #[test]
    fn ops_replay_to_the_same_tables(facts in prop::collection::vec(fact(), 1..40), every in 1usize..5) {
        // The emitted ops, encoded as on the wire (upsert / patch / dot / remove) and
        // applied to an empty client view, reproduce the server's tables exactly.
        let mut s = Store::new(StoreConfig { orgs: vec!["acme".into()], ..Default::default() });
        let mut view = switchyard::wire::WireState::default();
        let apply = |ops: Vec<switchyard::store::OpOut>, view: &mut switchyard::wire::WireState| {
            let inner = switchyard::hub::encode_ops(&ops);
            let arr: serde_json::Value =
                serde_json::from_slice(&[b"[".as_slice(), &inner, b"]"].concat()).unwrap();
            for op in arr.as_array().unwrap() {
                view.apply_op(op);
            }
        };
        for (i, f) in facts.iter().enumerate() {
            s.apply(f.clone(), true);
            if i % every == 0 {
                apply(s.flush(NOW), &mut view);
            }
        }
        apply(s.flush(NOW), &mut view);
        for k in Kind::ALL {
            let got: BTreeMap<String, serde_json::Value> =
                view.iter(k).map(|(id, v)| (id.clone(), v.clone())).collect();
            let want: BTreeMap<String, serde_json::Value> = s
                .table(k)
                .iter()
                .map(|(id, j)| (id.clone(), serde_json::from_str(j).unwrap()))
                .collect();
            prop_assert_eq!(got, want, "{}", k.as_str());
        }
    }
}

/// Progress rings: a running pipeline expects the median duration of its repo's recent
/// successful runs of the same kind; the repo carries the median of its push runs; a run
/// finishing re-derives the running sibling's expectation.
#[test]
fn expected_durations() {
    let p = |n: u64, state: CiState, dur_s: Option<i64>, event: PipelineEvent| {
        let started = NOW - 3_600_000 + n as i64 * 60_000;
        Fact::Pipeline(Pipeline {
            id: ids::wp_pipeline("acme/api", n),
            lane: LaneKind::Roadrunner,
            repo: "acme/api".into(),
            number: n,
            sha: SHAS[(n % 5) as usize].into(),
            branch: "main".into(),
            event,
            state,
            created: started,
            started: Some(started),
            finished: dur_s.map(|d| started + d * 1000),
            queue_pos: None,
            expected_ms: None,
            engine: None,
            title: None,
            author: None,
            pr: None,
            deploy: false,
            flaky: false,
            workflows: vec![],
            url: String::new(),
            links: Default::default(),
        })
    };
    // Flush; if `id` was re-sent (upsert or patch), its current value.
    let upsert = |s: &mut Store, id: &str| -> Option<serde_json::Value> {
        let sent = s.flush(NOW).into_iter().any(|o| match o {
            switchyard::store::OpOut::Upsert {
                kind: Kind::Pipeline,
                id: i,
                ..
            }
            | switchyard::store::OpOut::Patch {
                kind: Kind::Pipeline,
                id: i,
                ..
            } => i == id,
            _ => false,
        });
        sent.then(|| serde_json::from_str(&s.table(Kind::Pipeline)[id]).unwrap())
    };
    let fresh = |facts: &[Fact]| {
        let mut s = Store::new(StoreConfig {
            orgs: vec!["acme".into()],
            ..Default::default()
        });
        for f in facts {
            s.apply(f.clone(), true);
        }
        s
    };
    let mut facts = vec![
        p(1, CiState::Success, Some(60), PipelineEvent::Push),
        p(2, CiState::Success, Some(120), PipelineEvent::Push),
        p(3, CiState::Failure, Some(5), PipelineEvent::Push), // failures don't count
        p(4, CiState::Success, Some(900), PipelineEvent::PullRequest), // other kind
        p(9, CiState::Running, None, PipelineEvent::Push),
    ];
    let mut s = fresh(&facts);
    let id9 = ids::wp_pipeline("acme/api", 9);
    let v = upsert(&mut s, &id9).unwrap();
    assert_eq!(v["expected_ms"], 120_000, "median of [60 s, 120 s] (upper)");
    // A third successful push run lands: the running one re-derives (incrementally).
    s.apply(p(5, CiState::Success, Some(90), PipelineEvent::Push), true);
    let v = upsert(&mut s, &id9).expect("the running sibling is re-sent");
    assert_eq!(v["expected_ms"], 90_000);
    // Finished runs carry no expectation.
    facts.push(p(9, CiState::Success, Some(100), PipelineEvent::Push));
    let mut s = fresh(&facts);
    let v = upsert(&mut s, &id9).unwrap();
    assert!(v.get("expected_ms").is_none());
}
