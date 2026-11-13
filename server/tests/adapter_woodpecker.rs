//! Woodpecker adapter: recorded (sanitized) upstream payloads → facts.

mod common;

use std::collections::BTreeMap;

use common::*;
use switchyard::adapters::apps::parse_time;
use switchyard::adapters::woodpecker::*;
use switchyard::facts::*;
use switchyard::model::*;

fn pipeline(facts: &[Fact]) -> &Pipeline {
    match &facts[0] {
        Fact::Pipeline(p) => p,
        f => panic!("first fact is not a pipeline: {f:?}"),
    }
}

fn deploys(facts: &[Fact]) -> Vec<&DeployFact> {
    facts
        .iter()
        .filter_map(|f| match f {
            Fact::Deploy(d) => Some(d),
            _ => None,
        })
        .collect()
}

fn wf<'a>(p: &'a Pipeline, name: &str) -> &'a Workflow {
    p.workflows
        .iter()
        .find(|w| w.name == name)
        .unwrap_or_else(|| panic!("workflow {name}"))
}

fn step<'a>(w: &'a Workflow, name: &str) -> &'a Step {
    w.steps
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("step {name}"))
}

#[test]
fn sse_body_parses_every_data_message() {
    let evs = wp_events();
    assert_eq!(evs.len(), 4, "the `: ping` comment carries no event");
    let keys: Vec<(String, u64, String)> = evs
        .iter()
        .map(|e| {
            (
                e.repo.full_name.clone(),
                e.pipeline.number,
                e.pipeline.status.clone(),
            )
        })
        .collect();
    assert_eq!(
        keys,
        vec![
            ("Northwind-Labs/aurora-api".into(), 28, "created".into()),
            ("Northwind-Labs/aurora-api".into(), 28, "running".into()),
            ("Northwind-EMS/ember-api".into(), 53, "running".into()),
            ("Northwind-EMS/ember-api".into(), 53, "success".into()),
        ]
    );
    assert_eq!(evs[0].repo.id, 64);
    assert!(evs[0].repo.active && evs[0].repo.private);
    assert_eq!(evs[0].repo.default_branch, "main");
}

#[test]
fn sse_push_created_maps_to_pending_pipeline_and_pending_deploy() {
    let e = &wp_events()[0];
    let facts = wp_mapper().facts(&e.repo.full_name, e.repo.id, &e.pipeline);
    assert_eq!(facts.len(), 2, "pipeline + one deploy workflow");
    let p = pipeline(&facts);
    assert_eq!(p.id, "wp:Northwind-Labs/aurora-api:28");
    assert_eq!(p.id, ids::wp_pipeline("Northwind-Labs/aurora-api", 28));
    assert_eq!(p.lane, LaneKind::Roadrunner);
    assert_eq!(p.repo, "Northwind-Labs/aurora-api");
    assert_eq!(p.number, 28);
    assert_eq!(p.sha, "cba1fed1817599ede1b917712f1ac8d2e629e690");
    assert_eq!(p.branch, "main");
    assert_eq!(p.event, PipelineEvent::Push);
    assert_eq!(p.state, CiState::Pending, "`created` is pending");
    // Unix seconds → ms; 0 means "not yet".
    assert_eq!(p.created, 1_794_339_609_000);
    assert_eq!(p.started, None);
    assert_eq!(p.finished, None);
    assert_eq!(p.engine, None, "no workflow has an agent yet");
    // Empty title → first line of the commit message.
    assert_eq!(p.title.as_deref(), Some("feat: neutral change 1"));
    assert_eq!(p.author.as_deref(), Some("dev-01"));
    assert_eq!(p.pr, None);
    assert!(p.deploy);
    assert_eq!(p.queue_pos, None);
    assert_eq!(
        p.url,
        "https://ci.dev.example.internal/repos/64/pipeline/28"
    );
    let names: Vec<&str> = p.workflows.iter().map(|w| w.name.as_str()).collect();
    assert_eq!(names, ["ci", "deploy", "docs"]);
    for w in &p.workflows {
        assert_eq!(w.state, CiState::Pending);
        assert_eq!(w.engine, None);
        for s in &w.steps {
            assert_eq!(s.state, CiState::Pending);
            assert_eq!(s.exit_code, None, "not finished → no exit code");
            assert_eq!((s.started, s.finished), (None, None));
            assert_eq!(s.cached, None);
        }
    }
    assert_eq!(
        wf(p, "deploy")
            .steps
            .iter()
            .map(|s| s.name.as_str())
            .collect::<Vec<_>>(),
        ["clone", "failsafe-deploy"]
    );
    let d = deploys(&facts);
    assert_eq!(d.len(), 1);
    let d = d[0];
    assert_eq!(d.app, "", "resolved from the apps list later");
    assert_eq!(d.repo, "Northwind-Labs/aurora-api");
    assert_eq!(d.sha, p.sha);
    assert_eq!(d.via, DeployVia::Roadrunner);
    assert_eq!(d.state, DeployState::Pending);
    assert_eq!(d.started, p.created, "unstarted deploy → pipeline created");
    assert_eq!(d.finished, None);
    assert_eq!(d.pipeline.as_deref(), Some(p.id.as_str()));
    assert_eq!(d.url.as_deref(), Some(p.url.as_str()));
    assert_eq!(d.source, "wp");
}

#[test]
fn sse_push_running_maps_steps_engines_and_times() {
    let e = &wp_events()[1];
    let facts = wp_mapper().facts(&e.repo.full_name, e.repo.id, &e.pipeline);
    let p = pipeline(&facts);
    assert_eq!(p.state, CiState::Running);
    assert_eq!(p.started, Some(1_794_339_617_000));
    assert_eq!(p.finished, None);
    // The running workflow's agent, by name.
    assert_eq!(p.engine.as_deref(), Some("dagger-ci-101-2"));
    let ci = wf(p, "ci");
    assert_eq!(ci.state, CiState::Running);
    assert_eq!(ci.engine.as_deref(), Some("dagger-ci-101-2"));
    assert_eq!(ci.started, Some(1_794_339_617_000));
    let clone = step(ci, "clone");
    assert_eq!(clone.state, CiState::Success);
    assert_eq!(clone.exit_code, Some(0));
    assert_eq!(
        (clone.started, clone.finished),
        (Some(1_794_339_620_000), Some(1_794_339_623_000))
    );
    let backend = step(ci, "backend");
    assert_eq!(backend.state, CiState::Running);
    assert_eq!(backend.exit_code, None, "running step has no exit code");
    assert_eq!(backend.started, Some(1_794_339_623_000));
    let docs = wf(p, "docs");
    assert_eq!(docs.state, CiState::Success);
    assert_eq!(docs.engine.as_deref(), Some("dagger-ci-102-1"));
    assert_eq!(docs.finished, Some(1_794_339_629_000));
    assert_eq!(wf(p, "deploy").state, CiState::Pending);
    let d = deploys(&facts);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].state, DeployState::Pending);
}

#[test]
fn sse_pull_request_running_then_success() {
    let evs = wp_events();
    let m = wp_mapper();
    let run = m.facts(&evs[2].repo.full_name, evs[2].repo.id, &evs[2].pipeline);
    let ok = m.facts(&evs[3].repo.full_name, evs[3].repo.id, &evs[3].pipeline);
    assert_eq!(run.len(), 1, "no deploy workflow, no deploy fact");
    assert_eq!(ok.len(), 1);
    let (a, b) = (pipeline(&run), pipeline(&ok));
    for p in [a, b] {
        assert_eq!(p.id, "wp:Northwind-EMS/ember-api:53");
        assert_eq!(p.event, PipelineEvent::PullRequest);
        assert_eq!(p.pr, Some(102), "from refs/pull/102/merge");
        assert_eq!(p.branch, "feature/change-1", "PR head from the refspec");
        assert_eq!(p.sha, "aad98fd9b169395a00cd2260d34490c1d1c0e6cb");
        assert_eq!(p.title.as_deref(), Some("feat: neutral change 2"));
        assert!(!p.deploy);
        assert_eq!(
            p.url,
            "https://ci.dev.example.internal/repos/38/pipeline/53"
        );
        assert_eq!(p.created, s(1_794_339_459));
        assert_eq!(p.started, Some(s(1_794_339_467)));
    }
    assert_eq!(a.state, CiState::Running);
    assert_eq!(a.finished, None);
    assert_eq!(a.engine.as_deref(), Some("dagger-ci-102-1"));
    assert_eq!(b.state, CiState::Success);
    assert_eq!(b.finished, Some(s(1_794_339_604)));
    assert_eq!(wf(b, "ci").state, CiState::Success);
    assert_eq!(wf(b, "security").engine.as_deref(), Some("dagger-ci-102-2"));
    // The later observation orders after the earlier one.
    assert!(pipeline_version(b) > pipeline_version(a));
}

#[test]
fn pipeline_detail_running_push() {
    let p: WpPipeline = typed("woodpecker/pipeline_full.json");
    let facts = wp_mapper().facts("Northwind-EMS/ember-api", 38, &p);
    assert_eq!(facts.len(), 1);
    let p = pipeline(&facts);
    assert_eq!(p.id, "wp:Northwind-EMS/ember-api:54");
    assert_eq!(p.event, PipelineEvent::Push);
    assert_eq!(p.state, CiState::Running);
    assert_eq!(p.branch, "main");
    assert_eq!(p.engine.as_deref(), Some("dagger-ci-102-2"));
    let ci = wf(p, "ci");
    assert_eq!(step(ci, "clone").exit_code, Some(0));
    assert_eq!(step(ci, "tests").state, CiState::Running);
    assert_eq!(step(ci, "tests").exit_code, None);
    assert_eq!(step(ci, "db-migrations").state, CiState::Success);
    assert_eq!(step(ci, "db-migrations").finished, Some(s(1_794_339_657)));
}

#[test]
fn pipeline_detail_dependabot_pr_failure() {
    let raw: WpPipeline = typed("woodpecker/pipeline_full_failure.json");
    let facts = wp_mapper().facts("Northwind-Labs/lumen-report", 47, &raw);
    assert_eq!(facts.len(), 1);
    let p = pipeline(&facts);
    assert_eq!(p.id, "wp:Northwind-Labs/lumen-report:112");
    assert_eq!(p.state, CiState::Failure);
    assert_eq!(p.event, PipelineEvent::PullRequest);
    assert_eq!(p.pr, Some(21));
    assert_eq!(p.branch, "dependabot/npm_and_yarn/example-lib-2");
    assert_eq!(p.author.as_deref(), Some("dependabot[bot]"));
    assert_eq!(
        p.title.as_deref(),
        Some("deps: bump example-lib from 1.0.4 to 1.0.5")
    );
    assert_eq!(p.finished, Some(s(1_794_339_128)));
    let ci = wf(p, "ci");
    assert_eq!(ci.state, CiState::Failure);
    assert_eq!(ci.engine.as_deref(), Some("dagger-ci-101-1"));
    let fe = step(ci, "frontend");
    assert_eq!(fe.state, CiState::Failure);
    assert_eq!(fe.exit_code, Some(1));
    assert_eq!(step(ci, "backend").exit_code, Some(0));
    assert_eq!(wf(p, "security").state, CiState::Success);
    // No running workflow: the first workflow with an agent.
    assert_eq!(p.engine.as_deref(), Some("dagger-ci-101-1"));
}

#[test]
fn pipeline_detail_error_without_workflows() {
    let raw: WpPipeline = typed("woodpecker/pipeline_full_error.json");
    assert!(raw.workflows.is_none());
    let facts = wp_mapper().facts("Northwind-EMS/kestrel-deploy", 207, &raw);
    assert_eq!(facts.len(), 1, "no workflows → no deploy fact");
    let p = pipeline(&facts);
    assert_eq!(p.state, CiState::Error);
    assert!(p.state.is_done() && p.state.is_red());
    assert!(p.workflows.is_empty());
    assert!(!p.deploy);
    assert_eq!(p.engine, None);
    assert_eq!(p.created, s(1_794_338_965));
    assert_eq!(p.started, Some(s(1_794_338_965)));
    assert_eq!(p.finished, Some(s(1_794_338_965)));
    assert_eq!(p.title.as_deref(), Some("feat: neutral change 5"));
}

#[test]
fn feed_rows_map_without_workflows() {
    let m = wp_mapper();
    let rows: Vec<WpPipeline> = typed("woodpecker/user_feed_latest.json");
    assert_eq!(rows.len(), 7);
    let mut got: BTreeMap<String, (CiState, PipelineEvent, Option<u64>)> = BTreeMap::new();
    for r in &rows {
        assert!(
            r.repo_id > 0 && !r.full_name.is_empty(),
            "feed rows carry the repo"
        );
        let f = m.facts(&r.full_name, r.repo_id, r);
        assert_eq!(f.len(), 1, "list rows have no workflows → no deploy");
        let p = pipeline(&f);
        assert!(p.workflows.is_empty());
        assert!(!p.deploy);
        assert_eq!(
            p.url,
            format!("{WP_URL}/repos/{}/pipeline/{}", r.repo_id, r.number)
        );
        got.insert(p.id.clone(), (p.state, p.event, p.pr));
    }
    assert_eq!(
        got["wp:Northwind-Labs/aurora-api:27"],
        (CiState::Success, PipelineEvent::Cron, None)
    );
    assert_eq!(
        got["wp:Northwind-Labs/glacier-tracker:714"],
        (CiState::Failure, PipelineEvent::Cron, None)
    );
    assert_eq!(
        got["wp:Northwind-Labs/delta-stock:149"],
        (CiState::Success, PipelineEvent::PullRequest, Some(380))
    );
    assert_eq!(
        got["wp:Northwind-EMS/ember-api:53"],
        (CiState::Running, PipelineEvent::PullRequest, Some(102))
    );
    // A cron row has no author and no title or message.
    let cron = rows.iter().find(|r| r.number == 714).unwrap();
    let p = m.facts(&cron.full_name, cron.repo_id, cron);
    assert_eq!(pipeline(&p).author, None);
    assert_eq!(pipeline(&p).title, None);

    let rows: Vec<WpPipeline> = typed("woodpecker/user_feed.json");
    let meta = rows.iter().find(|r| r.number == 110).unwrap();
    let p = m.facts(&meta.full_name, meta.repo_id, meta);
    let p = pipeline(&p);
    assert_eq!(
        p.event,
        PipelineEvent::PullRequest,
        "pull_request_metadata is a PR event"
    );
    assert_eq!(p.state, CiState::Error);
    assert_eq!(p.pr, Some(125));
}

#[test]
fn active_repos_page() {
    let repos: Vec<WpRepo> = typed("woodpecker/repos_active_p1.json");
    assert_eq!(repos.len(), 4);
    assert!(repos.iter().all(|r| r.active));
    let r = repos.iter().find(|r| r.id == 38).unwrap();
    assert_eq!(r.full_name, "Northwind-EMS/ember-api");
    assert_eq!(r.default_branch, "main");
    assert!(r.private);
    let fork = repos.iter().find(|r| r.id == 370).unwrap();
    assert_eq!(fork.default_branch, "fork");
    assert!(!fork.private);
}

fn repo_names() -> BTreeMap<u64, String> {
    typed::<Vec<WpRepo>>("woodpecker/repos_active_p1.json")
        .into_iter()
        .map(|r| (r.id, r.full_name))
        .collect()
}

/// The queue snapshot was recorded at about this instant.
const Q_AT: Ms = 1_794_339_490_000;

#[test]
fn queue_counts_items_and_oldest_wait() {
    let q: WpQueueInfo = typed("woodpecker/queue_info.json");
    assert!(!q.paused);
    let f = queue_fact(&q, &repo_names(), Q_AT);
    assert_eq!(f.observed, Q_AT);
    let q2 = &f.queue;
    assert_eq!(q2.id, "roadrunner");
    assert_eq!(q2.pending, 1);
    assert_eq!(q2.running, 5, "workflows");
    assert_eq!(q2.pipelines_running, 4, "two workflows of one pipeline");
    assert_eq!(q2.waiting, 0);
    assert!(!q2.paused);
    // The pending task's repo is not in the map: its label names it.
    assert_eq!(q2.items, vec!["wp:Northwind-Labs/ion-tap:6".to_string()]);
    assert_eq!(q2.oldest_wait_ms, Q_AT - s(1_794_273_629));

    // An empty queue waits 0, whatever the clock says.
    let empty = queue_fact(&WpQueueInfo::default(), &BTreeMap::new(), Q_AT);
    assert_eq!(empty.queue.pending, 0);
    assert_eq!(empty.queue.oldest_wait_ms, 0);
    assert!(empty.queue.items.is_empty());
}

#[test]
fn queue_items_dedup_and_cap() {
    let mut q = WpQueueInfo::default();
    let mut tasks = Vec::new();
    for n in 0..60u64 {
        for _ in 0..2 {
            tasks.push(WpTask {
                repo_id: 9,
                pipeline_number: n,
                created: 100 + n as i64,
                ..Default::default()
            });
        }
    }
    q.pending = Some(tasks);
    let repos = BTreeMap::from([(9, "o/r".to_string())]);
    let f = queue_fact(&q, &repos, 1_000_000);
    assert_eq!(f.queue.pending, 120);
    assert_eq!(
        f.queue.items.len(),
        50,
        "capped at 50, deduped per pipeline"
    );
    assert_eq!(f.queue.items[0], "wp:o/r:0");
    assert_eq!(f.queue.items[49], "wp:o/r:49");
    assert_eq!(f.queue.oldest_wait_ms, 1_000_000 - 100_000);
}

#[test]
fn engines_slots_busy_and_online() {
    let q: WpQueueInfo = typed("woodpecker/queue_info.json");
    let agents = wp_agents();
    assert_eq!(agents.len(), 5);
    let e = engines_fact(&agents, &q, &repo_names(), Q_AT);
    assert_eq!(e.source, "woodpecker");
    assert_eq!(e.observed, Q_AT);
    let by: BTreeMap<&str, &Engine> = e.engines.iter().map(|x| (x.id.as_str(), x)).collect();
    assert_eq!(
        by.keys().copied().collect::<Vec<_>>(),
        [
            "wp-agent-1",
            "wp-agent-2",
            "wp-agent-3",
            "wp-agent-37",
            "wp-agent-4"
        ]
    );
    let a1 = by["wp-agent-1"];
    assert_eq!(a1.kind, EngineKind::WpAgent);
    assert_eq!(a1.label.as_deref(), Some("dagger-ci-101-1"));
    assert_eq!(a1.host.as_deref(), Some("VM 101"));
    assert_eq!(a1.platform.as_deref(), Some("linux/amd64"));
    assert_eq!(a1.slots, 3);
    assert_eq!(a1.busy, 1);
    assert_eq!(
        a1.running,
        vec!["wp:Northwind-EMS/kestrel-deploy:74".to_string()]
    );
    assert!(a1.online);
    // last_contact floored to 30 s, in ms.
    assert_eq!(a1.last_seen, Some(s(1_794_339_480)));
    let a2 = by["wp-agent-2"];
    assert_eq!(a2.busy, 2);
    assert_eq!(
        a2.running,
        vec![
            "wp:Northwind-EMS/polaris-ui:85".to_string(),
            "wp:Northwind-Labs/delta-stock:149".to_string()
        ]
    );
    // repo 38 resolves through the repo map, the others through labels.
    assert_eq!(
        by["wp-agent-3"].running,
        vec!["wp:Northwind-EMS/ember-api:53".to_string()]
    );
    assert_eq!(by["wp-agent-3"].host.as_deref(), Some("VM 102"));
    let mac = by["wp-agent-37"];
    assert_eq!(mac.host.as_deref(), Some("Mac mini"));
    assert_eq!(mac.platform.as_deref(), Some("darwin/arm64"));
    assert_eq!(mac.slots, 1);
    assert_eq!(mac.busy, 0);
    assert!(!mac.online, "last contact a day ago");
    // 90 s without contact → offline.
    let late = engines_fact(&agents, &q, &repo_names(), s(1_794_339_488) + 90_000);
    assert!(late.engines.iter().all(|x| !x.online));
}

#[test]
fn engines_no_schedule_is_offline_and_negative_capacity_is_zero() {
    let a = WpAgent {
        id: 9,
        name: "dagger-ci-x-1".into(),
        capacity: -1,
        last_contact: 1000,
        no_schedule: true,
        ..Default::default()
    };
    let e = engines_fact(&[a], &WpQueueInfo::default(), &BTreeMap::new(), 1_000_500);
    let e = &e.engines[0];
    assert!(!e.online);
    assert_eq!(e.slots, 0);
    assert_eq!(e.host, None, "non-numeric VM id");
    assert_eq!(e.platform, None);
}

#[test]
fn agent_token_is_never_kept() {
    let raw = r#"[{"id":1,"name":"a","token":"s3cr3t-agent-token","capacity":1}]"#;
    let a: Vec<WpAgent> = serde_json::from_str(raw).unwrap();
    assert!(!format!("{a:?}").contains("s3cr3t"));
    // And the committed fixture has none.
    assert!(!read("woodpecker/agents.json").contains("\"token\""));
}

#[test]
fn state_and_event_tables() {
    use CiState::*;
    for (s, want) in [
        ("success", Success),
        ("failure", Failure),
        ("error", Error),
        ("running", Running),
        ("pending", Pending),
        ("created", Pending),
        ("blocked", Blocked),
        ("killed", Canceled),
        ("declined", Canceled),
        ("canceled", Canceled),
        ("skipped", Skipped),
        ("", None),
        ("whatever", None),
    ] {
        assert_eq!(map_state(s), want, "{s}");
    }
    for (e, want) in [
        ("push", PipelineEvent::Push),
        ("pull_request", PipelineEvent::PullRequest),
        ("pull_request_closed", PipelineEvent::PullRequest),
        ("pull_request_metadata", PipelineEvent::PullRequest),
        ("tag", PipelineEvent::Tag),
        ("release", PipelineEvent::Tag),
        ("cron", PipelineEvent::Cron),
        ("manual", PipelineEvent::Manual),
        ("deployment", PipelineEvent::Deployment),
        ("unknown", PipelineEvent::Push),
    ] {
        assert_eq!(map_event(e), want, "{e}");
    }
}

#[test]
fn killed_deploy_workflow_is_cancelled_and_skipped_is_none() {
    let mut p: WpPipeline = wp_events()[1].pipeline.clone();
    p.status = "killed".into();
    p.finished = 1_794_339_700;
    let wfs = p.workflows.as_mut().unwrap();
    for w in wfs.iter_mut() {
        if w.name == "deploy" {
            w.state = "killed".into();
            w.started = 1_794_339_650;
            w.finished = 1_794_339_700;
        }
    }
    let m = wp_mapper();
    let f = m.facts("Northwind-Labs/aurora-api", 64, &p);
    assert_eq!(pipeline(&f).state, CiState::Canceled);
    let d = deploys(&f);
    // Killed (superseded or cancelled): it ends the run's report, and is no failed deploy.
    assert!(d[0].canceled, "a killed deploy is cancelled, not failed");
    assert_eq!(d[0].started, s(1_794_339_650));
    assert_eq!(d[0].finished, Some(s(1_794_339_700)));

    for w in p.workflows.as_mut().unwrap().iter_mut() {
        if w.name == "deploy" {
            w.state = "skipped".into();
        }
    }
    let f = m.facts("Northwind-Labs/aurora-api", 64, &p);
    assert!(
        deploys(&f).is_empty(),
        "a skipped deploy workflow deployed nothing"
    );
    assert!(
        pipeline(&f).deploy,
        "the pipeline still has a deploy workflow"
    );

    // A deploy workflow on a PR pipeline is not a deploy.
    p.event = "pull_request".into();
    p.git_ref = "refs/pull/7/merge".into();
    for w in p.workflows.as_mut().unwrap().iter_mut() {
        if w.name == "deploy" {
            w.state = "success".into();
        }
    }
    let f = m.facts("Northwind-Labs/aurora-api", 64, &p);
    assert!(deploys(&f).is_empty());
    assert!(!pipeline(&f).deploy);
    assert_eq!(pipeline(&f).pr, Some(7));
    assert_eq!(
        pipeline(&f).branch,
        "main",
        "no refspec → the pipeline branch"
    );
}

#[test]
fn helpers() {
    assert_eq!(pr_number("refs/pull/193/merge"), Some(193));
    assert_eq!(pr_number("refs/pull/7/head"), Some(7));
    assert_eq!(pr_number("refs/heads/main"), None);
    assert_eq!(pr_number("refs/pull/x/merge"), None);
    assert_eq!(agent_host("dagger-ci-153-1").as_deref(), Some("VM 153"));
    assert_eq!(agent_host("rr-mac-mini-2").as_deref(), Some("Mac mini"));
    assert_eq!(agent_host("dagger-ci-abc-1"), None);
    assert_eq!(agent_host("laptop"), None);
    let m = wp_mapper();
    assert_eq!(m.agent(0), None);
    assert_eq!(m.agent(37).as_deref(), Some("rr-mac-mini-1"));
    assert_eq!(m.agent(99).as_deref(), Some("agent 99"));
}

#[test]
fn rfc3339_formats_and_round_trips() {
    assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
    assert_eq!(rfc3339(1_794_339_396_000), "2026-11-10T19:36:36Z");
    assert_eq!(
        rfc3339(1_794_339_396_999),
        "2026-11-10T19:36:36Z",
        "ms truncate"
    );
    assert_eq!(rfc3339(-1000), "1969-12-31T23:59:59Z");
    assert_eq!(
        rfc3339(-1),
        "1969-12-31T23:59:59Z",
        "floor, not toward zero"
    );
    assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00Z");
    assert_eq!(rfc3339(1_709_164_800_000), "2024-02-29T00:00:00Z");
    assert_eq!(rfc3339(4_102_444_799_000), "2099-12-31T23:59:59Z");
    for t in [
        0,
        1_794_339_609_000,
        951_782_400_000,
        1_709_251_199_000,
        -86_400_000,
    ] {
        assert_eq!(parse_time(&rfc3339(t)), Some(t), "{t}");
    }
}

#[test]
fn deep_links_open_roadrunner_on_the_step() {
    // ember-api #53: repo 38; workflow `ci` (pid 1) has clone (pid 3), tests (4), …
    let e = &wp_events()[2];
    let facts = wp_mapper().facts(&e.repo.full_name, e.repo.id, &e.pipeline);
    let p = pipeline(&facts);
    let ci = wf(p, "ci");
    assert_eq!(
        step(ci, "tests").url.as_deref(),
        Some("https://ci.dev.example.internal/repos/38/pipeline/53/4")
    );
    assert_eq!(
        ci.url.as_deref(),
        Some("https://ci.dev.example.internal/repos/38/pipeline/53/3"),
        "a workflow opens on its first step"
    );
    assert_eq!(p.git_ref, None, "only tag runs carry a ref");
    // A tag run: the tag, and the branch as Woodpecker reports it.
    let mut tag = e.pipeline.clone();
    tag.event = "tag".into();
    tag.git_ref = "refs/tags/v1.4.0".into();
    let facts = wp_mapper().facts(&e.repo.full_name, e.repo.id, &tag);
    let t = pipeline(&facts);
    assert_eq!(t.event, PipelineEvent::Tag);
    assert_eq!(t.git_ref.as_deref(), Some("v1.4.0"));
    assert_eq!(t.branch, e.pipeline.branch);
}

#[test]
fn engines_link_to_their_machine_page() {
    let agents: Vec<WpAgent> = serde_json::from_value(serde_json::json!([
        {"id": 1, "name": "dagger-ci-153-1", "capacity": 3, "last_contact": 1},
        {"id": 3, "name": "dagger-ci-154-1", "capacity": 3, "last_contact": 1},
        {"id": 9, "name": "rr-mac-mini-1", "capacity": 1, "last_contact": 1}
    ]))
    .unwrap();
    let q: WpQueueInfo = serde_json::from_value(serde_json::json!({})).unwrap();
    let l = engines_fact(&agents, &q, &BTreeMap::new(), 2_000);
    let url = |id: &str| {
        l.engines
            .iter()
            .find(|e| e.id == id)
            .and_then(|e| e.url.clone())
            .unwrap()
    };
    // The console's engine page shows VM 153 (its engine and the agents on it).
    assert_eq!(
        url("wp-agent-1"),
        "https://cicd.apps.example.internal/engine"
    );
    assert_eq!(
        url("wp-agent-3"),
        "https://ci.dev.example.internal/admin/agents"
    );
    assert_eq!(
        url("wp-agent-9"),
        "https://ci.dev.example.internal/admin/agents"
    );
}

#[test]
fn created_without_workflows_is_not_a_pipeline_yet() {
    let m = wp_mapper();
    // Woodpecker stores every webhook's pipeline as `created` before reading its config,
    // and deletes it unpublished when no workflow matches: a feed row, a list row and a
    // detail of one in that window.
    for raw in [
        serde_json::json!({"number": 61, "status": "created", "event": "pull_request_closed",
                           "repo_id": 7, "full_name": "acme/api", "created": 1_794_339_609}),
        serde_json::json!({"number": 61, "status": "created", "event": "push", "workflows": null}),
        serde_json::json!({"number": 61, "status": "created", "event": "push", "workflows": []}),
    ] {
        let p: WpPipeline = serde_json::from_value(raw).unwrap();
        assert!(pre_config(&p));
        assert!(m.facts("acme/api", 7, &p).is_empty(), "{p:?}");
    }
    // Published with its workflows it is pending, as before.
    let e = &wp_events()[0];
    assert_eq!(e.pipeline.status, "created");
    assert!(!pre_config(&e.pipeline));
    let f = m.facts(&e.repo.full_name, e.repo.id, &e.pipeline);
    assert_eq!(pipeline(&f).state, CiState::Pending);
    // Other states without workflows still map (an `error` never got that far).
    let err: WpPipeline = typed("woodpecker/pipeline_full_error.json");
    assert!(!pre_config(&err));
    let pend: WpPipeline =
        serde_json::from_value(serde_json::json!({"number": 3, "status": "pending"})).unwrap();
    assert!(!pre_config(&pend));
    assert_eq!(
        pipeline(&m.facts("acme/api", 7, &pend)).state,
        CiState::Pending
    );
}

/// A fake Woodpecker: #1 exists, #2 was deleted (404), #3 fails (500).
async fn fake_woodpecker() -> String {
    use axum::Router;
    use axum::extract::Path;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::get;
    let app = Router::new().route(
        "/api/repos/7/pipelines/{n}",
        get(|Path(n): Path<u64>| async move {
            match n {
                1 => axum::Json(serde_json::json!({"number": 1, "status": "running"}))
                    .into_response(),
                2 => StatusCode::NOT_FOUND.into_response(),
                _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn pipeline_detail_tells_deleted_from_failing() {
    let base = fake_woodpecker().await;
    let c = WpClient::new(
        base,
        WP_URL.into(),
        "t".into(),
        reqwest::Client::new(),
        std::sync::Arc::new(switchyard::runtime::Adapters::default()),
    );
    let p = c.pipeline(7, 1).await.unwrap().expect("exists");
    assert_eq!((p.number, p.status.as_str()), (1, "running"));
    assert!(c.pipeline(7, 2).await.unwrap().is_none(), "404 → gone");
    assert!(c.pipeline(7, 3).await.is_err(), "500 is not gone");
    // Plain `get` still fails on a 404.
    let e = c
        .get::<WpPipeline>("/api/repos/7/pipelines/2")
        .await
        .unwrap_err();
    assert!(e.to_string().contains("HTTP 404"), "{e}");
}

#[test]
fn a_repo_the_stream_was_not_subscribed_to_reopens_it() {
    use std::collections::BTreeSet;
    use switchyard::adapters::woodpecker::needs_resubscribe;
    let streamed: BTreeSet<u64> = [1, 2, 3].into();
    assert!(!needs_resubscribe(&streamed, [1, 3]));
    // kit-atom activated after the stream connected: its runs never came over it.
    assert!(needs_resubscribe(&streamed, [2, 421]));
    // Not connected yet: the connect subscribes to everything.
    assert!(!needs_resubscribe(&BTreeSet::new(), [421]));
}
