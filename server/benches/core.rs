//! Criterion benches for the server's budgets (BRIEF: snapshot p99 < 5 ms from memory,
//! delta fan-out to 1,000 clients, ≥ 20k events/s ingest). Numbers: server/docs/PERF.md.
//!
//! `cargo bench --bench core` (CI runs `-- --test`: every body once).

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use criterion::{BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use switchyard::facts::*;
use switchyard::history::History;
use switchyard::hub::{Frame, Hub, Snapshot, encode_ops, gzip};
use switchyard::model::*;
use switchyard::runtime::build_snapshot;
use switchyard::store::{Store, StoreConfig};

const NOW: Ms = 1_794_340_000_000;
const REPOS: usize = 400;

fn repo(i: usize) -> String {
    format!("org{}/repo-{i:03}", i % 5)
}

fn sha(i: usize) -> String {
    format!("{:040x}", i as u128 * 0x9e37_79b9_7f4a_7c15)
}

/// The k-th observation of pipeline `n`: a run advancing through 3 workflows x 6 steps,
/// like Woodpecker's event stream delivers it (a full pipeline per event).
fn pipeline(n: usize, k: usize) -> Fact {
    let r = repo(n % REPOS);
    let created = NOW - 3_600_000 + (n as i64 % 3_600) * 1_000;
    let done = k >= 18;
    let state = if done {
        if n.is_multiple_of(9) {
            CiState::Failure
        } else {
            CiState::Success
        }
    } else {
        CiState::Running
    };
    let workflows = (0..3)
        .map(|w| Workflow {
            name: ["ci", "build", "deploy"][w].into(),
            state: if k >= (w + 1) * 6 {
                CiState::Success
            } else if k >= w * 6 {
                CiState::Running
            } else {
                CiState::Pending
            },
            started: (k >= w * 6).then_some(created + w as i64 * 60_000),
            finished: (k >= (w + 1) * 6).then_some(created + (w as i64 + 1) * 60_000),
            engine: Some(format!("dagger-ci-15{}-1", n % 3)),
            steps: (0..6)
                .map(|s| {
                    let i = w * 6 + s;
                    Step {
                        name: format!("step-{s}"),
                        state: if k > i {
                            CiState::Success
                        } else if k == i {
                            CiState::Running
                        } else {
                            CiState::Pending
                        },
                        started: (k >= i).then_some(created + i as i64 * 10_000),
                        finished: (k > i).then_some(created + i as i64 * 10_000 + 9_000),
                        exit_code: (k > i).then_some(0),
                        cached: None,
                        cluster: None,
                    }
                })
                .collect(),
        })
        .collect();
    Fact::Pipeline(Pipeline {
        id: ids::wp_pipeline(&r, n as u64),
        lane: LaneKind::Roadrunner,
        repo: r,
        number: n as u64,
        sha: sha(n),
        branch: "main".into(),
        event: PipelineEvent::Push,
        state,
        created,
        started: Some(created + 2_000),
        finished: done.then_some(created + 200_000),
        queue_pos: None,
        expected_ms: None,
        engine: Some(format!("dagger-ci-15{}-1", n % 3)),
        title: Some(format!("change {n}")),
        author: Some(format!("dev-{}", n % 40)),
        pr: None,
        deploy: n.is_multiple_of(4),
        flaky: false,
        workflows,
        url: format!("https://ci.example/repos/{}/pipeline/{n}", n % REPOS),
    })
}

/// A fleet the size of Exowatt's (≈ 400 repos, 900 commits, 250 pipelines, 1,100 PRs,
/// 240 apps): the store the snapshot is built from.
fn fleet() -> Store {
    let mut s = Store::new(StoreConfig::default());
    s.apply(
        Fact::Repos(RepoList {
            source: "woodpecker".into(),
            observed: NOW,
            repos: (0..REPOS)
                .map(|i| RepoMeta {
                    id: repo(i),
                    default_branch: "main".into(),
                    woodpecker_id: Some(i as u64),
                    pushed_at: None,
                    archived: false,
                })
                .collect(),
        }),
        false,
    );
    s.apply(
        Fact::Apps(AppList {
            observed: NOW,
            apps: (0..240)
                .map(|i| AppMeta {
                    id: format!("app-{i}"),
                    repo: Some(repo(i)),
                    url: format!("https://app-{i}.example"),
                    runtime: Some("lxc".into()),
                    team: Some("software".into()),
                    live_sha: None,
                    deployed_at: None,
                })
                .collect(),
        }),
        false,
    );
    for n in 0..900 {
        s.apply(pipeline(n, if n < 650 { 18 } else { n % 18 }), false);
    }
    for n in 0..1_100 {
        let r = repo(n % REPOS);
        s.apply(
            Fact::Pr(PrFact {
                repo: r.clone(),
                number: n as u64,
                title: format!("pr {n}"),
                author: format!("dev-{}", n % 40),
                bot: n % 3 == 0,
                draft: false,
                state: PrState::Open,
                created: NOW - 86_400_000,
                updated: NOW - 3_600_000,
                head_sha: sha(10_000 + n),
                head: format!("topic/{n}"),
                base: "main".into(),
                merged_at: None,
                merge_sha: None,
                mergeable: Some(Mergeable::Mergeable),
                review: Some("review_required".into()),
                ai: None,
                checks: vec![Check {
                    name: "ci/woodpecker/pr/ci".into(),
                    state: CiState::Success,
                    required: true,
                }],
                url: format!("https://github.com/{r}/pull/{n}"),
                observed: NOW,
            }),
            false,
        );
    }
    s.flush(NOW);
    s
}

fn bench_ingest(c: &mut Criterion) {
    // 20 runs x 19 observations = 380 events per pass, flushed every 64 (the reducer
    // flushes on a 33 ms tick: ~660 events per flush at 20k/s).
    let events: Vec<Fact> = (0..20)
        .flat_map(|n| (0..19).map(move |k| pipeline(5_000 + n, k)))
        .collect();
    let mut g = c.benchmark_group("ingest");
    g.throughput(Throughput::Elements(events.len() as u64));
    g.bench_function("pipeline_events_flush64", |b| {
        b.iter_batched(
            fleet,
            |mut s| {
                for (i, f) in events.iter().enumerate() {
                    s.apply(f.clone(), true);
                    if i % 64 == 63 {
                        s.flush_with(NOW, false);
                    }
                }
                s.flush_with(NOW, false)
            },
            criterion::BatchSize::LargeInput,
        )
    });
    g.finish();
    // The Factory Floor (groups, clusters, flakes, trends) over the whole fleet: the
    // reducer runs this at most once a second.
    let mut g = c.benchmark_group("insights");
    g.bench_function("recompute_fleet", |b| {
        b.iter_batched(
            fleet,
            |mut s| {
                s.mark_insights();
                s.flush(NOW)
            },
            criterion::BatchSize::LargeInput,
        )
    });
    g.finish();
}

fn bench_snapshot(c: &mut Criterion) {
    let s = fleet();
    let json = build_snapshot(&s, 1, NOW, "bench");
    let mut g = c.benchmark_group("snapshot");
    g.throughput(Throughput::Bytes(json.len() as u64));
    // What GET /api/v1/snapshot does per request: clone the cached, pre-encoded Arc.
    let hub = Hub::new("bench".into(), 1024, 1024, History::Off);
    hub.set_snapshot(Snapshot::new(1, NOW, json.clone()));
    g.bench_function("serve_cached", |b| b.iter(|| hub.snapshot()));
    // The ≤ 1/s rebuild from the store's pre-serialized tables, and its gzip.
    g.bench_function("build_from_store", |b| {
        b.iter(|| build_snapshot(&s, 1, NOW, "bench"))
    });
    g.sample_size(20);
    g.bench_function("gzip", |b| b.iter(|| gzip(&json)));
    g.finish();
}

fn bench_fanout(c: &mut Criterion) {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    let mut g = c.benchmark_group("fanout");
    let ops = encode_ops(&[]);
    for clients in [100usize, 1_000] {
        g.throughput(Throughput::Elements(clients as u64));
        g.bench_with_input(
            BenchmarkId::new("publish_to_all_receivers", clients),
            &clients,
            |b, &n| {
                b.to_async(&rt).iter_custom(|iters| {
                    let ops = ops.clone();
                    async move {
                        let hub = Hub::new("bench".into(), 4096, 64, History::Off);
                        let mut handles = Vec::with_capacity(n);
                        let barrier = Arc::new(tokio::sync::Barrier::new(n + 1));
                        for _ in 0..n {
                            let mut rx = hub.tx.subscribe();
                            let bar = barrier.clone();
                            handles.push(tokio::spawn(async move {
                                bar.wait().await;
                                let mut got = 0u64;
                                let mut bytes = 0usize;
                                while got < iters {
                                    match rx.recv().await {
                                        Ok(f) => {
                                            bytes += f.json.len();
                                            got += 1;
                                        }
                                        Err(tokio::sync::broadcast::error::RecvError::Lagged(
                                            k,
                                        )) => got += k,
                                        Err(_) => break,
                                    }
                                }
                                bytes
                            }));
                        }
                        barrier.wait().await;
                        let t = std::time::Instant::now();
                        for i in 0..iters {
                            hub.publish(&ops, NOW + i as i64);
                            if i % 512 == 511 {
                                tokio::task::yield_now().await;
                            }
                        }
                        for h in handles {
                            let _ = h.await;
                        }
                        t.elapsed()
                    }
                })
            },
        );
    }
    g.finish();
    let _ = Frame::reset(0, 0);
    let _ = Bytes::new();
}

criterion_group! {
    name = benches;
    config = Criterion::default().measurement_time(Duration::from_secs(5)).warm_up_time(Duration::from_secs(1));
    targets = bench_ingest, bench_snapshot, bench_fanout
}
criterion_main!(benches);
