//! "Since your last visit" (`GET /api/v1/changes?since=`): a 24 h ledger of what
//! happened, kept from the stream itself (the events and the failed steps of finished
//! runs), so it works the same live and in `--demo`, and is rebuilt from `/history` at
//! boot.

use std::collections::{BTreeMap, VecDeque};

use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::model::*;
use crate::wire::WireState;

pub const KEEP_MS: Ms = 25 * 3_600_000;

#[derive(Clone, Debug)]
struct MainEv {
    repo: String,
    to: CiState,
    from: CiState,
    culprit: Option<String>,
    at: Ms,
}

#[derive(Clone, Debug)]
struct Finish {
    repo: String,
    failed: bool,
    at: Ms,
}

#[derive(Default)]
struct Inner {
    /// Since when the ledger has seen everything (boot − replayed history).
    covered_from: Ms,
    mains: VecDeque<MainEv>,
    finishes: VecDeque<Finish>,
    deploys: VecDeque<(String, String, DeployState, Ms)>,
    health: VecDeque<(String, Health, Health, Ms)>,
    /// (repo, at) of merged PRs.
    merges: VecDeque<(String, Ms)>,
    /// PR id → (created, repo), for PRs seen with `created` inside the window.
    opened: BTreeMap<String, (Ms, String)>,
    /// (pipeline, workflow/step) → (finished, cluster, repo).
    failures: BTreeMap<(String, String), (Ms, String, String)>,
}

#[derive(Default)]
pub struct Ledger {
    inner: Mutex<Inner>,
}

fn red(s: CiState) -> bool {
    matches!(s, CiState::Failure | CiState::Error)
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

impl Ledger {
    pub fn new(covered_from: Ms) -> Ledger {
        Ledger {
            inner: Mutex::new(Inner {
                covered_from,
                ..Default::default()
            }),
        }
    }

    pub fn set_covered_from(&self, t: Ms) {
        let mut g = self.inner.lock();
        g.covered_from = g.covered_from.min(t);
    }

    /// Record one frame (already applied to `view`, the client view after it).
    pub fn observe(&self, frame: &Value, view: &WireState) {
        let Some(ops) = frame.get("ops").and_then(Value::as_array) else {
            return;
        };
        let at = frame.get("at").and_then(Value::as_i64).unwrap_or(0);
        let mut g = self.inner.lock();
        for op in ops {
            match op.get("op").and_then(Value::as_str) {
                Some("event") => {
                    let Some(e) = op
                        .get("e")
                        .and_then(|e| serde_json::from_value::<Event>(e.clone()).ok())
                    else {
                        continue;
                    };
                    match e {
                        Event::Main {
                            repo,
                            from,
                            to,
                            culprit,
                            at,
                        } => g.mains.push_back(MainEv {
                            repo,
                            from,
                            to,
                            culprit,
                            at,
                        }),
                        Event::Finish {
                            pipeline,
                            state,
                            at,
                            ..
                        } => {
                            let repo = view
                                .get(Kind::Pipeline, &pipeline)
                                .map(|p| s(p, "repo").to_string())
                                .unwrap_or_default();
                            g.finishes.push_back(Finish {
                                repo,
                                failed: red(state),
                                at,
                            });
                        }
                        Event::Deploy {
                            app,
                            sha,
                            state,
                            at,
                            ..
                        } => g.deploys.push_back((app, sha, state, at)),
                        Event::Health { app, from, to, at } => {
                            g.health.push_back((app, from, to, at))
                        }
                        Event::Merge { repo, at, .. } => g.merges.push_back((repo, at)),
                        _ => {}
                    }
                }
                Some("upsert") | Some("patch") if s(op, "kind") == "pr" => {
                    let id = s(op, "id");
                    if let Some(p) = view.get(Kind::Pr, id)
                        && let Some(c) = p.get("created").and_then(Value::as_i64)
                        && c >= at - KEEP_MS
                    {
                        g.opened
                            .insert(id.to_string(), (c, s(p, "repo").to_string()));
                    }
                }
                Some("upsert") | Some("patch") if s(op, "kind") == "pipeline" => {
                    let id = s(op, "id");
                    let Some(p) = view.get(Kind::Pipeline, id) else {
                        continue;
                    };
                    if !matches!(s(p, "state"), "failure" | "error") {
                        continue;
                    }
                    let Some(fin) = p.get("finished").and_then(Value::as_i64) else {
                        continue;
                    };
                    for w in p
                        .get("workflows")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        for st in w
                            .get("steps")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                        {
                            if let Some(c) = st.get("cluster").and_then(Value::as_str) {
                                g.failures.insert(
                                    (
                                        id.to_string(),
                                        format!("{}/{}", s(w, "name"), s(st, "name")),
                                    ),
                                    (fin, c.to_string(), s(p, "repo").to_string()),
                                );
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        let cut = at - KEEP_MS;
        while g.mains.front().is_some_and(|x| x.at < cut) {
            g.mains.pop_front();
        }
        while g.finishes.front().is_some_and(|x| x.at < cut) {
            g.finishes.pop_front();
        }
        while g.deploys.front().is_some_and(|x| x.3 < cut) {
            g.deploys.pop_front();
        }
        while g.health.front().is_some_and(|x| x.3 < cut) {
            g.health.pop_front();
        }
        while g.merges.front().is_some_and(|x| x.1 < cut) {
            g.merges.pop_front();
        }
        if g.opened.values().any(|x| x.0 < cut) {
            g.opened.retain(|_, x| x.0 >= cut);
        }
        g.failures.retain(|_, v| v.0 >= cut);
    }

    /// `Changes` for (since, until] against the current client view.
    pub fn changes(&self, since: Ms, until: Ms, view: &WireState) -> Value {
        let g = self.inner.lock();
        let complete = since >= g.covered_from;
        let since = since.max(until - 24 * 3_600_000);
        let inw = |t: Ms| t > since && t <= until;
        let group = |repo: &str| -> Value {
            view.get(Kind::Repo, repo)
                .and_then(|r| r.get("group").cloned())
                .unwrap_or(Value::Null)
        };
        let is_red_now = |repo: &str| {
            view.get(Kind::Repo, repo)
                .and_then(|r| r.pointer("/main/state"))
                .and_then(Value::as_str)
                .is_some_and(|x| x == "failure" || x == "error")
        };
        // Latest cluster a repo failed with in the window (for "what broke it").
        let mut repo_cluster: BTreeMap<&str, (Ms, &str)> = BTreeMap::new();
        let mut clusters: BTreeMap<&str, u32> = BTreeMap::new();
        for (at, c, repo) in g.failures.values() {
            if !inw(*at) {
                continue;
            }
            *clusters.entry(c.as_str()).or_default() += 1;
            let e = repo_cluster
                .entry(repo.as_str())
                .or_insert((*at, c.as_str()));
            if *at > e.0 {
                *e = (*at, c.as_str());
            }
        }
        // Main transitions: the newest per repo in the window decides.
        let mut last_main: BTreeMap<&str, &MainEv> = BTreeMap::new();
        let mut red_start: BTreeMap<&str, Ms> = BTreeMap::new();
        let mut recovered = Vec::new();
        for m in g.mains.iter().filter(|m| m.at <= until) {
            if red(m.to) && !red(m.from) {
                red_start.insert(m.repo.as_str(), m.at);
            }
            if inw(m.at) {
                last_main.insert(m.repo.as_str(), m);
                if red(m.from) && !red(m.to) {
                    let mut o = json!({"repo": m.repo, "at": m.at});
                    if let Some(gr) = group(&m.repo).as_str() {
                        o["group"] = gr.into();
                    }
                    if let Some(t0) = red_start.get(m.repo.as_str()) {
                        o["red_ms"] = (m.at - t0).into();
                    }
                    recovered.push(o);
                }
            }
        }
        let mut reds: Vec<Value> = last_main
            .values()
            .filter(|m| red(m.to) && is_red_now(&m.repo))
            .map(|m| {
                let mut o = json!({"repo": m.repo, "at": m.at});
                if let Some(gr) = group(&m.repo).as_str() {
                    o["group"] = gr.into();
                }
                if let Some(c) = &m.culprit {
                    o["culprit"] = c.clone().into();
                }
                if let Some((_, c)) = repo_cluster.get(m.repo.as_str()) {
                    o["cluster"] = (*c).into();
                }
                o
            })
            .collect();
        reds.sort_by_key(|o| std::cmp::Reverse(o["at"].as_i64().unwrap_or(0)));
        recovered.sort_by_key(|o| std::cmp::Reverse(o["at"].as_i64().unwrap_or(0)));
        let red_repos: std::collections::BTreeSet<&str> =
            reds.iter().filter_map(|o| o["repo"].as_str()).collect();
        let mut still: Vec<Value> = view
            .iter(Kind::Repo)
            .filter(|(id, r)| {
                is_red_now(id)
                    && !red_repos.contains(id.as_str())
                    && r.pointer("/main/since").and_then(Value::as_i64).unwrap_or(0) <= since
            })
            .map(|(id, r)| {
                let mut o = json!({"repo": id, "since": r.pointer("/main/since").cloned().unwrap_or(Value::Null)});
                if let Some(gr) = r.get("group").and_then(Value::as_str) {
                    o["group"] = gr.into();
                }
                o
            })
            .collect();
        still.sort_by_key(|o| o["since"].as_i64().unwrap_or(0));
        let new_cluster = |c: &str| {
            view.get(Kind::Cluster, c)
                .and_then(|x| x.get("first_seen"))
                .and_then(Value::as_i64)
                .is_some_and(|f| f > since)
        };
        let mut cl: Vec<(u32, &str)> = clusters.iter().map(|(c, n)| (*n, *c)).collect();
        cl.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
        let clusters_new = cl.iter().filter(|(_, c)| new_cluster(c)).count();
        let cl: Vec<Value> = cl
            .iter()
            .take(20)
            .map(|(n, c)| json!({"id": c, "count": n, "new": new_cluster(c)}))
            .collect();
        let mut deploys: Vec<Value> = g
            .deploys
            .iter()
            .filter(|d| inw(d.3))
            .map(|(app, sha, st, at)| json!({"app": app, "sha": sha, "state": st, "at": at}))
            .collect();
        let deploys_n = deploys.len();
        let deploys_failed = g
            .deploys
            .iter()
            .filter(|d| inw(d.3) && d.2 == DeployState::Failure)
            .count();
        deploys.sort_by_key(|o| std::cmp::Reverse(o["at"].as_i64().unwrap_or(0)));
        deploys.truncate(50);
        let apps: Vec<Value> = g
            .health
            .iter()
            .filter(|h| inw(h.3))
            .map(|(app, from, to, at)| json!({"app": app, "from": from, "to": to, "at": at}))
            .collect();
        let apps_down = g
            .health
            .iter()
            .filter(|h| inw(h.3) && h.2 == Health::Down)
            .count();
        let apps_recovered = g
            .health
            .iter()
            .filter(|h| {
                inw(h.3) && h.2 == Health::Up && matches!(h.1, Health::Down | Health::Degraded)
            })
            .count();
        let fins: Vec<&Finish> = g.finishes.iter().filter(|f| inw(f.at)).collect();
        let failed = fins.iter().filter(|f| f.failed).count();
        // Per group: failed runs, reds, and PRs opened / merged / stuck.
        #[derive(Default)]
        struct G {
            failed: u32,
            red: u32,
            opened: u32,
            merged: u32,
            stuck: u32,
        }
        let group_or_org = |repo: &str| -> String {
            group(repo)
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("org:{}", repo.split('/').next().unwrap_or(repo)))
        };
        let mut groups: BTreeMap<String, G> = BTreeMap::new();
        for f in fins.iter().filter(|f| f.failed) {
            if let Some(gr) = group(&f.repo).as_str() {
                groups.entry(gr.to_string()).or_default().failed += 1;
            }
        }
        for o in &reds {
            if let Some(gr) = o["group"].as_str() {
                groups.entry(gr.to_string()).or_default().red += 1;
            }
        }
        // Opened: PRs created in the window (seen on the stream, or still open in the view).
        let mut opened: BTreeMap<&str, &str> = BTreeMap::new();
        for (id, (c, repo)) in &g.opened {
            if inw(*c) {
                opened.insert(id.as_str(), repo.as_str());
            }
        }
        for (id, p) in view.iter(Kind::Pr) {
            if p.get("created").and_then(Value::as_i64).is_some_and(inw) {
                opened.insert(id.as_str(), s(p, "repo"));
            }
        }
        for repo in opened.values() {
            groups.entry(group_or_org(repo)).or_default().opened += 1;
        }
        let merged: Vec<&str> = g
            .merges
            .iter()
            .filter(|m| inw(m.1))
            .map(|m| m.0.as_str())
            .collect();
        for repo in &merged {
            groups.entry(group_or_org(repo)).or_default().merged += 1;
        }
        // Stuck: open, not a draft, no activity for 3 days (`stale_ms`), as of now.
        let (mut stuck, mut stuck_bot) = (0usize, 0usize);
        for (_, p) in view.iter(Kind::Pr) {
            let open = !matches!(s(p, "phase"), "merged" | "closed" | "deployed" | "draft");
            if !open || p.get("stale_ms").is_none() {
                continue;
            }
            if p.get("bot").and_then(Value::as_bool) == Some(true) {
                stuck_bot += 1;
            } else {
                stuck += 1;
                groups.entry(group_or_org(s(p, "repo"))).or_default().stuck += 1;
            }
        }
        let mut gl: Vec<(String, G)> = groups.into_iter().collect();
        gl.sort_by(|a, b| {
            (b.1.red, b.1.failed, b.1.stuck)
                .cmp(&(a.1.red, a.1.failed, a.1.stuck))
                .then(a.0.cmp(&b.0))
        });
        let flakes = view
            .iter(Kind::Flake)
            .filter(|(_, f)| f.get("last_at").and_then(Value::as_i64).is_some_and(inw))
            .count();
        json!({
            "since": since,
            "until": until,
            "complete": complete,
            "counts": {
                "red": reds.len(), "recovered": recovered.len(), "still_red": still.len(),
                "pipelines": fins.len(), "failed": failed, "deploys": deploys_n,
                "deploys_failed": deploys_failed, "clusters_new": clusters_new, "flakes": flakes,
                "prs_opened": opened.len(), "prs_merged": merged.len(),
                "prs_stuck": stuck, "prs_stuck_bot": stuck_bot,
                "apps_down": apps_down, "apps_recovered": apps_recovered,
            },
            "red": reds,
            "recovered": recovered,
            "still_red": still,
            "clusters": cl,
            "deploys": deploys,
            "apps": apps,
            "groups": gl.into_iter().map(|(id, x)| json!({"id": id, "failed": x.failed, "red": x.red,
                "prs": {"opened": x.opened, "merged": x.merged, "stuck": x.stuck}})).collect::<Vec<_>>(),
        })
    }
}

/// `Insights`: the Factory Floor tables of a client view, sorted for display.
pub fn insights(view: &WireState, at: Ms) -> Value {
    let all = |k: Kind| -> Vec<Value> { view.iter(k).map(|(_, v)| v.clone()).collect() };
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
    let mut groups = all(Kind::Group);
    groups.sort_by_key(|g| (s(g, "name").to_lowercase(), s(g, "id").to_string()));
    let mut clusters = all(Kind::Cluster);
    clusters.sort_by(|a, b| {
        (n(b, "open") > 0, n(b, "count_1h"), n(b, "count"))
            .cmp(&(n(a, "open") > 0, n(a, "count_1h"), n(a, "count")))
            .then(s(a, "id").cmp(s(b, "id")))
    });
    let mut flakes = all(Kind::Flake);
    flakes.sort_by(|a, b| {
        n(b, "flips_24h")
            .cmp(&n(a, "flips_24h"))
            .then(s(a, "id").cmp(s(b, "id")))
    });
    let names: BTreeMap<String, String> = view
        .iter(Kind::Group)
        .map(|(id, g)| (id.clone(), s(g, "name").to_string()))
        .collect();
    let mut trends = all(Kind::Trend);
    trends.sort_by(|a, b| {
        let key = |t: &Value| {
            let id = s(t, "id");
            (
                id != "fleet",
                names
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| id.to_string())
                    .to_lowercase(),
            )
        };
        key(a).cmp(&key(b))
    });
    json!({"at": at, "groups": groups, "clusters": clusters, "flakes": flakes, "trends": trends})
}
