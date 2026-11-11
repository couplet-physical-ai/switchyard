//! Fixture recording and sanitizing.
//!
//! `--record DIR --record-minutes N`: once every adapter has synced (plus a
//! settle period), write the live snapshot to `DIR/snapshot.json` and every
//! following frame to `DIR/hour.jsonl` for N minutes.
//!
//! `sanitize`: make a recording safe for a PUBLIC repo. Private repo names,
//! commit/PR titles of private repos, people's logins and e-mails, internal
//! hosts and IPs are replaced by deterministic stand-ins (the same input
//! always maps to the same output, so the recording stays consistent); bots,
//! public repos, public hostnames and every number/state/time are kept.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::sync::broadcast;
use tracing::info;

use crate::hub::Hub;
use crate::model::Kind;
use crate::runtime::Adapters;
use crate::wire::{WireState, diff, dots_between, kind_of};

pub async fn record(
    hub: Arc<Hub>,
    adapters: Arc<Adapters>,
    dir: std::path::PathBuf,
    minutes: u64,
    settle_s: u64,
) -> Result<()> {
    std::fs::create_dir_all(&dir)?;
    while !adapters.ready() {
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    info!(settle_s, "recorder: adapters ready, settling");
    tokio::time::sleep(Duration::from_secs(settle_s)).await;
    let mut rx = hub.tx.subscribe();
    let want = hub.seq();
    let snap = loop {
        let s = hub.snapshot();
        if s.seq >= want {
            break s;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    std::fs::write(dir.join("snapshot.json"), &snap.json)?;
    info!(
        seq = snap.seq,
        bytes = snap.json.len(),
        "recorder: snapshot written; recording frames"
    );
    let mut out = std::io::BufWriter::new(std::fs::File::create(dir.join("hour.jsonl"))?);
    let end = tokio::time::Instant::now() + Duration::from_secs(minutes * 60);
    let mut n = 0u64;
    loop {
        let r = tokio::select! {
            r = rx.recv() => r,
            _ = tokio::time::sleep_until(end) => break,
        };
        match r {
            Ok(f) => {
                if f.seq <= snap.seq {
                    continue;
                }
                out.write_all(&f.json)?;
                out.write_all(b"\n")?;
                n += 1;
                if n.is_multiple_of(200) {
                    out.flush()?;
                }
            }
            Err(broadcast::error::RecvError::Lagged(k)) => {
                anyhow::bail!("recorder lagged by {k} frames")
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
    out.flush()?;
    info!(frames = n, "recorder: done");
    Ok(())
}

// ---------------------------------------------------------------- sanitizer

const ADJ: &[&str] = &[
    "amber", "brisk", "cobalt", "dusky", "ember", "fallow", "gilded", "hollow", "ivory", "jade",
    "keen", "lunar", "mellow", "north", "opal", "pale", "quiet", "russet", "solar", "tidal",
    "umber", "vivid", "west", "young", "zinc", "azure", "bold", "crisp", "deep", "early", "frost",
    "grand",
];
const NOUN: &[&str] = &[
    "anvil", "beacon", "cinder", "delta", "engine", "falcon", "garnet", "harbor", "island",
    "junction", "kestrel", "lantern", "meadow", "nebula", "orbit", "prism", "quarry", "relay",
    "summit", "turbine", "union", "vector", "willow", "yard", "zenith", "arc", "basin", "canyon",
    "dynamo", "ember", "forge", "grove",
];
const VERBS: &[&str] = &[
    "tighten", "speed up", "simplify", "harden", "rework", "clean up", "add", "fix", "document",
    "cache", "split", "retry", "validate", "stream", "batch", "pin",
];
const THINGS: &[&str] = &[
    "the deploy step",
    "flaky integration tests",
    "the settings page",
    "API pagination",
    "the build cache",
    "error handling in the poller",
    "the release notes",
    "auth token refresh",
    "dashboard queries",
    "the CSV export",
    "health checks",
    "log formatting",
    "the onboarding flow",
    "schema migrations",
    "rate limiting",
    "the search index",
];

fn h(s: &str) -> u64 {
    // FNV-1a: stable across runs and platforms.
    let mut x: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        x ^= *b as u64;
        x = x.wrapping_mul(0x100000001b3);
    }
    x
}

fn pick<'a>(list: &'a [&'a str], seed: u64) -> &'a str {
    list[(seed % list.len() as u64) as usize]
}

pub struct Sanitizer {
    /// Repos that are public: names and titles are kept.
    pub public_repos: BTreeSet<String>,
    /// Logins kept as-is (bots, product identities).
    pub keep_logins: BTreeSet<String>,
    repo_map: BTreeMap<String, String>,
    login_map: BTreeMap<String, String>,
    app_map: BTreeMap<String, String>,
    /// The recording's state as recorded, and as published (for patch / dot ops).
    raw: WireState,
    clean: WireState,
}

fn is_bot_login(l: &str) -> bool {
    let l = l.to_ascii_lowercase();
    l.ends_with("[bot]")
        || l.ends_with("-bot")
        || l.contains("renovate")
        || l.contains("dependabot")
        || l.contains("autofix")
        || l == "github-actions"
        || l.starts_with("app/")
}

impl Sanitizer {
    pub fn new(public_repos: BTreeSet<String>) -> Sanitizer {
        Sanitizer {
            public_repos,
            keep_logins: BTreeSet::new(),
            repo_map: BTreeMap::new(),
            login_map: BTreeMap::new(),
            app_map: BTreeMap::new(),
            raw: WireState::default(),
            clean: WireState::default(),
        }
    }

    fn is_public(&self, repo: &str) -> bool {
        self.public_repos.contains(repo)
    }

    /// Map every repo of a snapshot up front, so names can be scrubbed from free text.
    pub fn prime(&mut self, snap: &Value) {
        let mut ids: Vec<String> = Vec::new();
        for f in ["repos", "lanes"] {
            for v in snap.get(f).and_then(Value::as_array).into_iter().flatten() {
                if let Some(id) = v.get("id").and_then(Value::as_str) {
                    ids.push(id.to_string());
                }
            }
        }
        for v in snap
            .get("apps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(r) = v.get("repo").and_then(Value::as_str) {
                ids.push(r.to_string());
            }
        }
        ids.sort();
        ids.dedup();
        for id in ids {
            self.repo(&id);
        }
    }

    /// Replace private repo names (case-insensitive) inside a name or label.
    pub fn scrub_names(&self, s: &str) -> String {
        let mut out = s.to_string();
        let mut pairs: Vec<(String, String)> = self
            .repo_map
            .iter()
            .filter_map(|(k, v)| {
                let a = k.split('/').nth(1)?.to_string();
                let b = v.split('/').nth(1)?.to_string();
                (a.len() >= 4).then_some((a, b))
            })
            .collect();
        // Longest first, so `project-sim-bench` wins over `project-sim`.
        pairs.sort_by_key(|p| std::cmp::Reverse(p.0.len()));
        for (a, b) in pairs {
            let low = out.to_ascii_lowercase();
            let al = a.to_ascii_lowercase();
            if let Some(i) = low.find(&al) {
                out = format!("{}{}{}", &out[..i], b, &out[i + a.len()..]);
            }
        }
        out
    }

    pub fn repo(&mut self, repo: &str) -> String {
        if self.is_public(repo) || !repo.contains('/') {
            return repo.to_string();
        }
        if let Some(r) = self.repo_map.get(repo) {
            return r.clone();
        }
        let (org, _) = repo.split_once('/').unwrap_or(("", repo));
        let mut seed = h(repo);
        let mut name;
        loop {
            name = format!("{}-{}", pick(ADJ, seed), pick(NOUN, seed >> 17));
            let full = format!("{org}/{name}");
            if !self.repo_map.values().any(|v| *v == full) {
                break;
            }
            seed = seed.wrapping_mul(31).wrapping_add(7);
        }
        let out = format!("{org}/{name}");
        self.repo_map.insert(repo.to_string(), out.clone());
        out
    }

    pub fn login(&mut self, l: &str) -> String {
        if l.is_empty() || self.keep_logins.contains(l) {
            return l.to_string();
        }
        let low = l.to_ascii_lowercase();
        let well_known = [
            "renovate",
            "dependabot",
            "autofix",
            "github-actions",
            "woodpecker",
            "copilot",
            "claude",
        ];
        if is_bot_login(l) && well_known.iter().any(|w| low.contains(w)) {
            return l.to_string();
        }
        if is_bot_login(l) || low.contains("bot") {
            if let Some(x) = self.login_map.get(l) {
                return x.clone();
            }
            let n = self
                .login_map
                .values()
                .filter(|v| v.starts_with("release-bot"))
                .count()
                + 1;
            let x = format!("release-bot-{n}");
            self.login_map.insert(l.to_string(), x.clone());
            return x;
        }
        if let Some(x) = self.login_map.get(l) {
            return x.clone();
        }
        let n = self.login_map.len() + 1;
        let x = format!("dev-{n:02}");
        self.login_map.insert(l.to_string(), x.clone());
        x
    }

    /// App ids mirror repo names; keep them consistent with the repo mapping.
    pub fn app(&mut self, app: &str, repo: Option<&str>) -> String {
        if let Some(x) = self.app_map.get(app) {
            return x.clone();
        }
        let x = match repo {
            Some(r) if self.is_public(r) => app.to_string(),
            Some(r) => {
                let mapped = self.repo(r);
                mapped.split('/').nth(1).unwrap_or(app).to_ascii_lowercase()
            }
            None => {
                let seed = h(app);
                format!("{}-{}", pick(ADJ, seed >> 3), pick(NOUN, seed >> 23))
            }
        };
        // Several apps can share one repo: keep stand-in ids unique.
        let mut out = x.clone();
        let mut n = 2;
        while self.app_map.values().any(|v| *v == out) {
            out = format!("{x}-{n}");
            n += 1;
        }
        self.app_map.insert(app.to_string(), out.clone());
        out
    }

    pub fn title(&mut self, title: &str, repo: &str) -> String {
        if self.is_public(repo) || title.is_empty() {
            return title.to_string();
        }
        // Keep a conventional-commit prefix and a trailing (#123); replace the words.
        let seed = h(title);
        let prefix = title
            .split_once(':')
            .filter(|(p, _)| {
                p.len() <= 24
                    && p.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "()-_!/.".contains(c))
            })
            .map(|(p, _)| format!("{}: ", self.scrub_names(p)))
            .unwrap_or_default();
        let pr = title
            .rfind("(#")
            .and_then(|i| {
                title[i..]
                    .find(')')
                    .map(|j| title[i..i + j + 1].to_string())
            })
            .map(|x| format!(" {x}"))
            .unwrap_or_default();
        format!(
            "{prefix}{} {}{pr}",
            pick(VERBS, seed),
            pick(THINGS, seed >> 11)
        )
    }

    fn scrub_text(&mut self, s: &str) -> String {
        // Replace private repo names that appear inside free text / URLs.
        let mut out = s.to_string();
        let names: Vec<String> = self.repo_map.keys().cloned().collect();
        for r in names {
            if out.contains(&r) {
                let m = self.repo_map[&r].clone();
                out = out.replace(&r, &m);
            }
        }
        if out.contains(".lab.example.com")
            || out.contains("192.168.")
            || out.contains("10.0.")
            || out.contains('@') && out.contains(".com") && !out.contains("://")
        {
            return String::new();
        }
        out
    }

    /// Sanitize one entity value of `kind` in place.
    pub fn entity(&mut self, kind: &str, v: &mut Value) {
        let repo_of = |v: &Value| v.get("repo").and_then(Value::as_str).map(str::to_string);
        match kind {
            "repo" => {
                let id = v
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let new = self.repo(&id);
                let (org, name) = new.split_once('/').unwrap_or(("", &new));
                v["id"] = Value::from(new.clone());
                v["org"] = Value::from(org);
                v["name"] = Value::from(name);
                if let Some(a) = v.get("app").and_then(Value::as_str).map(str::to_string) {
                    v["app"] = Value::from(self.app(&a, Some(&id)));
                }
                if let Some(links) = v.get_mut("links") {
                    links["github"] = Value::from(format!("https://github.com/{new}"));
                }
                if let Some(n) = v
                    .get("lane_note")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    match generic_note(&n) {
                        g if g.is_empty() => {
                            v.as_object_mut().map(|o| o.remove("lane_note"));
                        }
                        g => v["lane_note"] = Value::from(g),
                    }
                }
                let public = self.is_public(&id);
                if let Some(dots) = v.pointer_mut("/main/recent").and_then(Value::as_array_mut) {
                    for d in dots {
                        if let Some(a) = d.get("author").and_then(Value::as_str).map(str::to_string)
                        {
                            d["author"] = Value::from(self.login(&a));
                        }
                        if !public
                            && let Some(t) =
                                d.get("title").and_then(Value::as_str).map(str::to_string)
                        {
                            d["title"] = Value::from(self.title(&t, &id));
                        }
                    }
                }
            }
            "commit" | "pipeline" | "pr" | "deploy" => {
                let repo = repo_of(v).unwrap_or_default();
                let new_repo = self.repo(&repo);
                v["repo"] = Value::from(new_repo.clone());
                if let Some(id) = v.get("id").and_then(Value::as_str).map(str::to_string) {
                    v["id"] = Value::from(id.replace(&repo, &new_repo));
                }
                {
                    let k = "author";
                    if let Some(a) = v.get(k).and_then(Value::as_str).map(str::to_string) {
                        v[k] = Value::from(self.login(&a));
                    }
                }
                if let Some(t) = v.get("title").and_then(Value::as_str).map(str::to_string) {
                    v["title"] = Value::from(self.title(&t, &repo));
                }
                if kind == "deploy"
                    && let Some(a) = v.get("app").and_then(Value::as_str).map(str::to_string)
                {
                    v["app"] = Value::from(self.app(&a, Some(&repo)));
                }
                if let Some(p) = v
                    .get("pipeline")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    v["pipeline"] = Value::from(p.replace(&repo, &new_repo));
                }
                if let Some(ps) = v.get_mut("pipelines").and_then(Value::as_array_mut) {
                    for p in ps {
                        if let Some(s) = p.as_str() {
                            *p = Value::from(s.replace(&repo, &new_repo));
                        }
                    }
                }
                if let Some(d) = v.get_mut("deploy")
                    && let Some(id) = d.get("id").and_then(Value::as_str).map(str::to_string)
                {
                    d["id"] = Value::from(id.replace(&repo, &new_repo));
                }
                if kind == "pr" {
                    if !self.is_public(&repo) {
                        let head = v
                            .get("head")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if !head.is_empty() {
                            v["head"] = Value::from(format!("topic/{:x}", h(&head) & 0xffffff));
                        }
                        // A base other than a conventional long-lived branch is a name too
                        // (`someone/project-x`).
                        let base = v
                            .get("base")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if !base.is_empty() && !LONG_LIVED.contains(&base.as_str()) {
                            v["base"] = Value::from(format!("topic/{:x}", h(&base) & 0xffffff));
                        }
                    }
                    if let Some(url) = v.get("url").and_then(Value::as_str).map(str::to_string) {
                        v["url"] = Value::from(url.replace(&repo, &new_repo));
                    }
                    if let Some(r) = v
                        .pointer("/review/human")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                    {
                        v["review"]["human"] = Value::from(r);
                    }
                } else if (kind == "commit" || kind == "pipeline")
                    && !self.is_public(&repo)
                    && let Some(b) = v.get("branch").and_then(Value::as_str).map(str::to_string)
                    && !["main", "master", "dev", "develop"].contains(&b.as_str())
                    && !b.starts_with("pull/")
                {
                    v["branch"] = Value::from(format!("topic/{:x}", h(&b) & 0xffffff));
                }
                if let Some(u) = v.get("url").and_then(Value::as_str).map(str::to_string) {
                    v["url"] = Value::from(self.scrub_text(&u.replace(&repo, &new_repo)));
                }
                if !self.is_public(&repo) {
                    if let Some(wfs) = v.get_mut("workflows").and_then(Value::as_array_mut) {
                        for w in wfs.iter_mut() {
                            if let Some(n) =
                                w.get("name").and_then(Value::as_str).map(str::to_string)
                            {
                                w["name"] = Value::from(self.scrub_names(&n));
                            }
                            if let Some(steps) = w.get_mut("steps").and_then(Value::as_array_mut) {
                                for st in steps.iter_mut() {
                                    if let Some(n) =
                                        st.get("name").and_then(Value::as_str).map(str::to_string)
                                    {
                                        st["name"] = Value::from(self.scrub_names(&n));
                                    }
                                }
                            }
                        }
                    }
                    if let Some(b) = v
                        .get("blocked_by")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                    {
                        v["blocked_by"] = Value::from(self.scrub_names(&b));
                    }
                    if let Some(cs) = v.get_mut("checks").and_then(Value::as_array_mut) {
                        for c in cs.iter_mut() {
                            if let Some(n) =
                                c.get("name").and_then(Value::as_str).map(str::to_string)
                            {
                                c["name"] = Value::from(self.scrub_names(&n));
                            }
                        }
                    }
                }
            }
            "app" => {
                let id = v
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let repo = repo_of(v);
                let new_id = self.app(&id, repo.as_deref());
                v["id"] = Value::from(new_id.clone());
                if let Some(r) = &repo {
                    v["repo"] = Value::from(self.repo(r));
                }
                if let Some(u) = v.get("url").and_then(Value::as_str) {
                    if u.contains(".apps.example.com") {
                        v["url"] = Value::from(format!("https://{new_id}.apps.example.com/"));
                    } else if !u.is_empty() {
                        v["url"] = Value::from(format!("https://{new_id}.example.com/"));
                    }
                }
                if let Some(id) = v
                    .pointer("/last_deploy/id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    let nid = self.rekey("deploy", &id);
                    v["last_deploy"]["id"] = Value::from(nid);
                }
                if let Some(n) = v.get("note").and_then(Value::as_str).map(str::to_string) {
                    v["note"] = Value::from(self.scrub_text(&n));
                }
            }
            "lane" => {
                let id = v
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                v["id"] = Value::from(self.repo(&id));
                if let Some(n) = v.get("note").and_then(Value::as_str).map(str::to_string) {
                    // Notes are free text written by people: keep only generic ones.
                    match generic_note(&n) {
                        g if g.is_empty() => {
                            v.as_object_mut().map(|o| o.remove("note"));
                        }
                        g => v["note"] = Value::from(g),
                    }
                }
            }
            "queue" => {
                if let Some(items) = v.get_mut("items").and_then(Value::as_array_mut) {
                    for it in items.iter_mut() {
                        if let Some(s) = it.as_str().map(str::to_string) {
                            *it = Value::from(self.pipeline_id(&s));
                        }
                    }
                }
            }
            "engine" => {
                if let Some(items) = v.get_mut("running").and_then(Value::as_array_mut) {
                    for it in items.iter_mut() {
                        if let Some(s) = it.as_str().map(str::to_string) {
                            *it = Value::from(self.pipeline_id(&s));
                        }
                    }
                }
            }
            "org" | "watcher" | "stats" => {
                if let Some(n) = v.get("note").and_then(Value::as_str).map(str::to_string) {
                    v["note"] = Value::from(self.scrub_text(&n));
                }
            }
            "cluster" => {
                // A log line from a private repo may name private things: its words are
                // replaced like a private title (the id is a hash and stays, so
                // Step.cluster still joins).
                let repos: Vec<String> = v
                    .get("repos")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                for k in ["line", "signature"] {
                    if let Some(t) = v.get(k).and_then(Value::as_str).map(neutral_text) {
                        v[k] = Value::from(t);
                    }
                }
                if let Some(private) = repos.iter().find(|r| !self.is_public(r)).cloned()
                    && let Some(line) = v.get("line").and_then(Value::as_str).map(str::to_string)
                {
                    let mut stand_in = self.title(&line, &private);
                    let cut = (0..=stand_in.len().min(160))
                        .rev()
                        .find(|i| stand_in.is_char_boundary(*i))
                        .unwrap_or(0);
                    stand_in.truncate(cut);
                    let step = v
                        .get("step")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let class = v
                        .get("class")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    v["signature"] = Value::from(format!("{step} · {class} · {stand_in}"));
                    v["line"] = Value::from(stand_in);
                }
                v["repos"] = Value::from(repos.iter().map(|r| self.repo(r)).collect::<Vec<_>>());
                if let Some(items) = v.get_mut("examples").and_then(Value::as_array_mut) {
                    for it in items.iter_mut() {
                        if let Some(s) = it.as_str().map(str::to_string) {
                            *it = Value::from(self.pipeline_id(&s));
                        }
                    }
                }
            }
            "flake" => {
                if let Some(r) = repo_of(v) {
                    let new = self.repo(&r);
                    v["repo"] = Value::from(new.clone());
                    if let Some(id) = v.get("id").and_then(Value::as_str).map(str::to_string)
                        && let Some((_, rest)) = id.split_once('|')
                    {
                        v["id"] = Value::from(format!("{new}|{rest}"));
                    }
                }
            }
            _ => {}
        }
        self.links(kind, v);
    }

    /// Deep links (contract 0.5: `links` objects, `Step.url`, `Engine.url`,
    /// `Queue.url`): private repo names become their stand-ins and hosts go neutral; an
    /// app's catalog links (status, logs) name the app and internal dashboards and are
    /// dropped; a deploy's app link follows the app's stand-in.
    fn links(&mut self, kind: &str, v: &mut Value) {
        if let Some(l) = v.get_mut("links").and_then(Value::as_object_mut) {
            if kind == "app" {
                l.remove("status");
                l.remove("logs");
            }
            let keys: Vec<String> = l.keys().cloned().collect();
            for k in keys {
                if kind == "deploy" && k == "app" {
                    continue;
                }
                if let Some(s) = l.get(&k).and_then(Value::as_str).map(str::to_string) {
                    let clean = self.link(&s);
                    l.insert(k, Value::from(clean));
                }
            }
        }
        if kind == "deploy"
            && let Some(u) = v
                .pointer("/links/app")
                .and_then(Value::as_str)
                .map(str::to_string)
        {
            let app = v
                .get("app")
                .and_then(Value::as_str)
                .unwrap_or("app")
                .to_string();
            v["links"]["app"] = Value::from(if u.contains(".apps.example.com") {
                format!("https://{app}.apps.example.com/")
            } else {
                format!("https://{app}.example.com/")
            });
        }
        if matches!(kind, "engine" | "queue")
            && let Some(u) = v.get("url").and_then(Value::as_str).map(str::to_string)
        {
            v["url"] = Value::from(self.link(&u));
        }
        if kind == "pipeline" {
            let mut urls: Vec<(usize, usize, String)> = Vec::new();
            for (wi, w) in v
                .get("workflows")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                for (si, st) in w
                    .get("steps")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    if let Some(u) = st.get("url").and_then(Value::as_str) {
                        urls.push((wi, si, u.to_string()));
                    }
                }
            }
            for (wi, si, u) in urls {
                let clean = self.link(&u);
                v["workflows"][wi]["steps"][si]["url"] = Value::from(clean);
            }
        }
    }

    /// One link: private repo names replaced, hosts neutral.
    fn link(&mut self, s: &str) -> String {
        let mut out = s.to_string();
        let names: Vec<(String, String)> = self
            .repo_map
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect();
        for (from, to) in names {
            if out.contains(&from) {
                out = out.replace(&from, &to);
            }
        }
        neutral_hosts(&out)
    }

    fn pipeline_id(&mut self, id: &str) -> String {
        // wp:<owner/name>:<n>
        if let Some(rest) = id.strip_prefix("wp:")
            && let Some((repo, n)) = rest.rsplit_once(':')
        {
            return format!("wp:{}:{n}", self.repo(repo));
        }
        id.to_string()
    }

    /// Re-key an entity id after its value was sanitized.
    fn rekey(&mut self, kind: &str, id: &str) -> String {
        match kind {
            "repo" | "lane" => self.repo(id),
            "commit" | "deploy" => match id.split_once('@') {
                Some((r, s)) => format!("{}@{s}", self.repo(r)),
                None => id.to_string(),
            },
            "pr" => match id.split_once('#') {
                Some((r, n)) => format!("{}#{n}", self.repo(r)),
                None => id.to_string(),
            },
            "pipeline" => self.pipeline_id(id),
            "flake" => match id.split_once('|') {
                Some((r, rest)) => format!("{}|{rest}", self.repo(r)),
                None => id.to_string(),
            },
            "app" => self
                .app_map
                .get(id)
                .cloned()
                .unwrap_or_else(|| id.to_string()),
            _ => id.to_string(),
        }
    }

    pub fn event(&mut self, e: &mut Value) {
        if let Some(r) = e.get("repo").and_then(Value::as_str).map(str::to_string) {
            if let Some(t) = e.get("title").and_then(Value::as_str).map(str::to_string) {
                e["title"] = Value::from(self.title(&t, &r));
            }
            e["repo"] = Value::from(self.repo(&r));
        }
        if let Some(a) = e.get("author").and_then(Value::as_str).map(str::to_string) {
            e["author"] = Value::from(self.login(&a));
        }
        if let Some(p) = e
            .get("pipeline")
            .and_then(Value::as_str)
            .map(str::to_string)
        {
            e["pipeline"] = Value::from(self.pipeline_id(&p));
        }
        for k in ["workflow", "step"] {
            if let Some(n) = e.get(k).and_then(Value::as_str).map(str::to_string) {
                e[k] = Value::from(self.scrub_names(&n));
            }
        }
        if let Some(b) = e.get("branch").and_then(Value::as_str).map(str::to_string) {
            let repo = e
                .get("repo")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !self.repo_map.values().any(|v| *v == repo) {
                // public repo: keep
            } else if !["main", "master", "dev", "develop"].contains(&b.as_str()) {
                e["branch"] = Value::from(format!("topic/{:x}", h(&b) & 0xffffff));
            }
        }
        if let Some(a) = e.get("app").and_then(Value::as_str).map(str::to_string) {
            e["app"] = Value::from(
                self.app_map
                    .get(&a)
                    .cloned()
                    .unwrap_or_else(|| self.app(&a, None)),
            );
        }
    }

    pub fn snapshot(&mut self, snap: &mut Value) {
        // Apps first so app ids follow their repos; then every kind (a new kind can never
        // pass through unsanitized).
        let mut order: Vec<(&str, &str)> = vec![("apps", "app")];
        for k in Kind::ALL {
            if k != Kind::App {
                order.push((k.snapshot_field(), k.as_str()));
            }
        }
        for (field, kind) in order {
            match snap.get_mut(field) {
                Some(Value::Array(a)) => {
                    for v in a.iter_mut() {
                        self.entity(kind, v);
                    }
                    // Stand-in ids sort differently: keep the contract's id order.
                    a.sort_by(|x, y| {
                        let id = |v: &Value| {
                            v.get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string()
                        };
                        id(x).cmp(&id(y))
                    });
                }
                Some(v @ Value::Object(_)) => self.entity(kind, v),
                _ => {}
            }
        }
    }

    /// Sanitize one frame. Patch and dot ops carry partial entities, so every changed
    /// entity is rebuilt whole from the recorded state, sanitized like an upsert, and
    /// re-encoded against the published state (upsert, patch, or dots + patch).
    pub fn frame(&mut self, f: &mut Value) {
        let Some(ops) = f.get_mut("ops").and_then(Value::as_array_mut) else {
            return;
        };
        let mut out = Vec::with_capacity(ops.len());
        for mut op in ops.drain(..) {
            let kind_s = match op.get("op").and_then(Value::as_str) {
                Some("dot") => "repo".to_string(),
                _ => op
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            };
            let id = op
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match op.get("op").and_then(Value::as_str) {
                Some("event") => {
                    if let Some(e) = op.get_mut("e") {
                        self.event(e);
                    }
                    out.push(op);
                }
                Some("remove") => {
                    self.raw.apply_op(&op);
                    op["id"] = Value::from(self.rekey(&kind_s, &id));
                    self.clean.apply_op(&op);
                    out.push(op);
                }
                Some(t @ ("upsert" | "patch" | "dot")) => {
                    let t = t.to_string();
                    let Some(kind) = kind_of(&kind_s) else {
                        continue;
                    };
                    self.raw.apply_op(&op);
                    let Some(mut v) = self.raw.get(kind, &id).cloned() else {
                        continue; // a patch for an entity the recording never had
                    };
                    self.entity(&kind_s, &mut v);
                    let cid = self.rekey(&kind_s, &id);
                    let prev = self.clean.get(kind, &cid).cloned();
                    let enc = match prev {
                        Some(p) if t != "upsert" => reencode(&kind_s, &cid, &p, &v),
                        _ => vec![json!({"op": "upsert", "kind": kind_s, "id": cid, "v": v})],
                    };
                    for o in enc {
                        self.clean.apply_op(&o);
                        out.push(o);
                    }
                }
                _ => out.push(op),
            }
        }
        *ops = out;
    }

    /// Seed the recorded and published states (call with the raw and the sanitized snapshot).
    pub fn seed(&mut self, raw: &Value, clean: &Value) {
        self.raw = WireState::from_snapshot(raw);
        self.clean = WireState::from_snapshot(clean);
    }
}

/// `prev` → `next` as patch / dot ops (the same rule as the server's).
fn reencode(kind: &str, id: &str, prev: &Value, next: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let (mut p, mut n) = (prev.clone(), next.clone());
    if kind == "repo" {
        let take = |v: &mut Value| {
            v.get_mut("main")
                .and_then(Value::as_object_mut)
                .and_then(|m| m.remove("recent"))
        };
        if let (Some(Value::Array(pr)), Some(Value::Array(nr))) = (take(&mut p), take(&mut n)) {
            match dots_between(&pr, &nr) {
                Some(dots) => {
                    for d in dots {
                        out.push(json!({"op": "dot", "id": id, "v": d}));
                    }
                }
                None => {
                    p["main"]["recent"] = Value::Array(pr);
                    n["main"]["recent"] = Value::Array(nr);
                }
            }
        }
    }
    if let Some(d) = diff(&p, &n) {
        out.push(json!({"op": "patch", "kind": kind, "id": id, "v": d}));
    }
    out
}

fn generic_note(n: &str) -> String {
    let l = n.to_ascii_lowercase();
    // Machine-written verdicts (cicd's deploy watcher) carry only a short sha.
    let machine = |p: &str| {
        n.starts_with(p)
            && n.len() < 80
            && n.chars()
                .all(|c| c.is_ascii_alphanumeric() || " .-".contains(c))
    };
    if machine("no Roadrunner deploy for ") || machine("Roadrunner deploy of ") {
        n.to_string()
    } else if l.starts_with("set to") || l.starts_with("set by") {
        "set by hand".into()
    } else if l.contains("roadrunner-first") || l.contains("roadrunner first") {
        "Roadrunner-first: Roadrunner deploys every push; GitHub Actions is the automatic fallback"
            .into()
    } else if l.contains("fallback") {
        "fallback: GitHub Actions is deploying".into()
    } else if l.contains("github actions") {
        "GitHub Actions owns deploys".into()
    } else {
        String::new()
    }
}

/// Sanitize a recording directory into `out` (snapshot.json + hour.jsonl).
pub fn sanitize_dir(
    input: &Path,
    out: &Path,
    public_repos: BTreeSet<String>,
) -> Result<(usize, usize)> {
    let mut s = Sanitizer::new(public_repos);
    let mut snap: Value = serde_json::from_slice(
        &std::fs::read(input.join("snapshot.json")).context("snapshot.json")?,
    )?;
    s.prime(&snap);
    let raw = snap.clone();
    s.snapshot(&mut snap);
    s.seed(&raw, &snap);
    std::fs::create_dir_all(out)?;
    let snap_bytes = neutral_hosts(&serde_json::to_string(&snap)?).into_bytes();
    check_clean(&snap_bytes).context("snapshot still contains something internal")?;
    std::fs::write(out.join("snapshot.json"), &snap_bytes)?;
    let text = std::fs::read_to_string(input.join("hour.jsonl")).context("hour.jsonl")?;
    let mut w = std::io::BufWriter::new(std::fs::File::create(out.join("hour.jsonl"))?);
    let mut n = 0;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut f: Value = serde_json::from_str(line)?;
        s.frame(&mut f);
        let b = neutral_hosts(&serde_json::to_string(&f)?).into_bytes();
        check_clean(&b).with_context(|| format!("frame {n} still contains something internal"))?;
        w.write_all(&b)?;
        w.write_all(b"\n")?;
        n += 1;
    }
    w.flush()?;
    Ok((snap_bytes.len(), n))
}

/// Branch names that say nothing about anyone (kept as-is in private repos).
const LONG_LIVED: [&str; 8] = [
    "main",
    "master",
    "develop",
    "dev",
    "staging",
    "production",
    "release",
    "trunk",
];

/// Internal-only hosts (`<x>.dev.example.com`, `<x>.example.com`) in URLs become
/// `<x>.example.com`, so links keep their shape without naming internal machines.
pub fn neutral_hosts(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        rest = &rest[i + 3..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
            .unwrap_or(rest.len());
        let host = &rest[..end];
        let internal = [
            ".dev.example.com",
            ".lab.example.com",
            ".example.com",
        ]
        .iter()
        .find_map(|suf| host.strip_suffix(suf));
        match internal {
            Some(first) => {
                out.push_str(first.split('.').next().unwrap_or("internal"));
                out.push_str(".example.com");
            }
            None => out.push_str(host),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

/// [`neutral_hosts`] for free text (log lines): also internal host names without a scheme.
pub fn neutral_text(s: &str) -> String {
    let mut out = neutral_hosts(s);
    for suf in [
        ".lab.example.com",
        ".example.com",
        ".dev.example.com",
    ] {
        while let Some(i) = out.find(suf) {
            let start = out[..i]
                .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
                .map_or(0, |j| j + 1);
            let first = out[start..i].split('.').next().unwrap_or("").to_string();
            let first = if first.is_empty() {
                "internal".to_string()
            } else {
                first
            };
            out.replace_range(start..i + suf.len(), &format!("{first}.example.com"));
        }
    }
    // E-mail addresses (test parameters, owners) become a neutral one.
    let mut from = 0;
    while let Some(k) = out[from..].find('@').map(|k| k + from) {
        let word = |c: char| c.is_ascii_alphanumeric() || "._%+-".contains(c);
        let start = out[..k].rfind(|c: char| !word(c)).map_or(0, |j| j + 1);
        let end = out[k + 1..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
            .map_or(out.len(), |j| k + 1 + j);
        let domain = out[k + 1..end].trim_end_matches('.');
        if start < k && domain.contains('.') {
            let end = k + 1 + domain.len();
            out.replace_range(start..end, "user@example.com");
            from = start + "user@example.com".len();
        } else {
            from = k + 1;
        }
    }
    out
}

/// Refuse anything that looks internal: lab hosts, private IPs, e-mails.
pub fn check_clean(b: &[u8]) -> Result<()> {
    let s = String::from_utf8_lossy(b);
    for bad in [
        ".lab.example.com",
        ".dev.example.com",
        "192.168.",
        "@example.com",
        "users.noreply.github.com",
    ] {
        if s.contains(bad) {
            anyhow::bail!("found {bad:?}");
        }
    }
    let re_10 = s.match_indices("\"10.").count() + s.match_indices("//10.").count();
    if re_10 > 0 {
        anyhow::bail!("found a 10.x address");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_hosts_become_neutral() {
        assert_eq!(
            neutral_hosts(
                r#"{"url":"https://ci.dev.example.com/repos/1/pipeline/84","b":"https://ci.dev.example.com"}"#
            ),
            r#"{"url":"https://ci.example.com/repos/1/pipeline/84","b":"https://ci.example.com"}"#
        );
        // Built at runtime so the internal host never appears verbatim in the source.
        let lab = format!("https://x.{}.example.com:8000/a", "lab");
        assert_eq!(neutral_hosts(&lab), "https://x.example.com:8000/a");
        for keep in [
            "https://github.com/a/b",
            "https://switchyard.apps.example.com/",
            "plain text",
        ] {
            assert_eq!(neutral_hosts(keep), keep);
        }
        assert!(check_clean(b"https://ci.dev.example.com/x").is_err());
        let plain = format!(
            "POST http://prov-api.{}.example.com:8000/api failed",
            "lab"
        );
        assert_eq!(
            neutral_text(&plain),
            "POST http://prov-api.example.com:8000/api failed"
        );
        let bare = format!("dial prov-api.{}.example.com:8000: refused", "lab");
        assert_eq!(
            neutral_text(&bare),
            "dial prov-api.example.com:8000: refused"
        );
        assert!(check_clean(neutral_text(&bare).as_bytes()).is_ok());
        assert_eq!(
            neutral_text("FAILED t.py::test_x[owner@example.com] and a@b.io. @here"),
            "FAILED t.py::test_x[user@example.com] and user@example.com. @here"
        );
        assert!(check_clean(neutral_hosts("https://ci.dev.example.com/x").as_bytes()).is_ok());
    }

    #[test]
    fn clusters_and_flakes_hide_private_repos_and_lines() {
        let mut s = Sanitizer::new(["acme/open".to_string()].into_iter().collect());
        let mut c = serde_json::json!({
            "id": "f:0123456789ab", "step": "rust", "class": "compile",
            "line": "error: could not compile `secret-billing-engine` (lib)",
            "signature": "rust · compile · error: could not compile `secret-billing-engine` (lib)",
            "repos": ["acme/secret-billing", "acme/open"],
            "examples": ["wp:acme/secret-billing:7"]
        });
        s.entity("cluster", &mut c);
        let txt = c.to_string();
        assert!(!txt.contains("secret"), "{txt}");
        assert_eq!(c["id"], "f:0123456789ab", "the id joins Step.cluster");
        assert!(c["line"].as_str().unwrap().starts_with("error: "));
        assert_eq!(c["repos"][1], "acme/open");
        let line = c["line"].as_str().unwrap().to_string();
        assert!(c["signature"].as_str().unwrap().ends_with(&line));
        // Public-only clusters keep their line.
        let mut p = serde_json::json!({"id": "f:1", "step": "lint", "class": "lint",
            "line": "error: unused import", "repos": ["acme/open"], "examples": []});
        s.entity("cluster", &mut p);
        assert_eq!(p["line"], "error: unused import");
        let mut f =
            serde_json::json!({"id": "acme/secret-billing|ci/test", "repo": "acme/secret-billing"});
        s.entity("flake", &mut f);
        assert!(!f.to_string().contains("secret"));
        assert_eq!(f["id"], format!("{}|ci/test", f["repo"].as_str().unwrap()));
        assert_eq!(
            s.rekey("flake", "acme/secret-billing|ci/test"),
            f["id"].as_str().unwrap()
        );
    }

    #[test]
    fn deep_links_hide_private_repos_apps_and_hosts() {
        let mut s = Sanitizer::new(["acme/open".to_string()].into_iter().collect());
        let gh = "https://github.com/acme/secret-billing";
        let mut p = serde_json::json!({
            "id": "wp:acme/secret-billing:7", "repo": "acme/secret-billing", "sha": "abc",
            "title": "secret billing change", "url": "https://ci.dev.example.com/repos/9/pipeline/7",
            "links": {"cicd": "https://cicd.apps.example.com/pipelines/9/7",
                      "woodpecker": "https://ci.dev.example.com/repos/9/pipeline/7",
                      "commit": format!("{gh}/commit/abc"), "branch": format!("{gh}/tree/main")},
            "workflows": [{"name": "ci", "steps": [
                {"name": "a", "url": "https://cicd.apps.example.com/pipelines/9/7?tab=steps&step=3"},
                {"name": "b", "url": format!("{gh}/actions/runs/1/job/2")}]}]
        });
        s.entity("pipeline", &mut p);
        let txt = p.to_string();
        assert!(!txt.contains("secret"), "{txt}");
        // (Whole frames go through `neutral_hosts` when written; links are neutral already.)
        assert!(!p["links"].to_string().contains("dev.example.com"), "{txt}");
        assert!(
            p["links"]["commit"]
                .as_str()
                .unwrap()
                .ends_with("/commit/abc")
        );
        let mut a = serde_json::json!({"id": "billing", "repo": "acme/secret-billing",
            "url": "https://billing.apps.example.com/", "health": "up", "checked": 0,
            "links": {"status": "https://grafana.dev.example.com/d/x/?var-app=billing",
                      "logs": format!("{gh}/actions/workflows/app-logs.yml"), "repo": gh}});
        s.entity("app", &mut a);
        assert!(a["links"].get("status").is_none() && a["links"].get("logs").is_none());
        assert!(!a.to_string().contains("secret"), "{a}");
        let mut d = serde_json::json!({"id": "acme/secret-billing@abc", "app": "billing",
            "repo": "acme/secret-billing", "sha": "abc", "via": "roadrunner", "state": "success",
            "started": 0, "links": {"app": "https://billing.apps.example.com/",
                                    "commit": format!("{gh}/commit/abc")}});
        s.entity("deploy", &mut d);
        assert_eq!(
            d["links"]["app"],
            format!("https://{}.apps.example.com/", d["app"].as_str().unwrap())
        );
        assert!(
            !d.to_string().contains("secret") && !d.to_string().contains("billing."),
            "{d}"
        );
        let mut e = serde_json::json!({"id": "wp-agent-1", "url": "https://ci.dev.example.com/admin/agents"});
        s.entity("engine", &mut e);
        assert_eq!(e["url"], "https://ci.example.com/admin/agents");
    }
}
