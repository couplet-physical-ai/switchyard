//! The Factory Floor (contract 0.5): groups, failure clusters, flakes and trends.
//!
//! Computed together from the whole fleet (they aggregate across repos), as pure
//! functions of the registers, the hourly rollups and `now`, then diffed into their
//! tables like every other entity. Clusters, flakes and groups are recomputed when a
//! run finishes, a failure signature arrives, the apps change or time passes (`tick`);
//! trends at most once per 5-minute bucket.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use rustc_hash::FxHashMap;

use super::{H, OpOut, Store, delta_ops, to_json};
use crate::facts::*;
use crate::model::*;
use crate::signature::{self, Signature};

/// Hourly rollups are kept this long (7 d of baselines + a day of slack).
pub const ROLLUP_KEEP_MS: Ms = 8 * 24 * H;
/// Clusters and flakes cover failures of the last 24 h.
pub const WINDOW_MS: Ms = 24 * H;
/// Trends are recomputed at most once per bucket.
pub const TREND_EVERY_MS: Ms = 5 * 60_000;
/// A closed hour is rolled up once it is this old (late finishes settled).
pub const ROLLUP_AFTER_MS: Ms = H + 10 * 60_000;
const HOURS_7D: usize = 168;

type Table = BTreeMap<String, Arc<str>>;

/// Normalized team slug of an apps-catalog team ("Software-Team" → "software"); None
/// for missing / placeholder teams.
pub fn team_slug(t: &str) -> Option<String> {
    let mut s: String = t
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c == ' ' || c == '_' { '-' } else { c })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-');
    let s = s.strip_suffix("-team").unwrap_or(s);
    if matches!(
        s,
        "" | "unknown" | "none" | "n-a" | "na" | "tbd" | "other" | "team"
    ) {
        return None;
    }
    Some(s.to_string())
}

/// Display name of a team slug: sentence case, short words upper-cased
/// ("power-systems" → "Power systems", "npi-scm" → "NPI SCM", "hr" → "HR").
pub fn group_name(slug: &str) -> String {
    slug.split('-')
        .filter(|w| !w.is_empty())
        .enumerate()
        .map(|(i, w)| {
            if w.len() <= 3 && !matches!(w, "and" | "of" | "the" | "ops") {
                w.to_ascii_uppercase()
            } else if i == 0 {
                let mut c = w.chars();
                c.next()
                    .map(|f| f.to_ascii_uppercase().to_string() + c.as_str())
                    .unwrap_or_default()
            } else {
                w.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn hour_of(t: Ms) -> Ms {
    t - t.rem_euclid(H)
}

fn bucket(ms: Ms) -> u16 {
    if ms < 1000 {
        0
    } else {
        ((ms as f64 / 1000.0).ln() / 1.1f64.ln()).floor() as u16 + 1
    }
}

fn bucket_value(b: u16) -> f64 {
    if b == 0 {
        500.0
    } else {
        1000.0 * 1.1f64.powf(b as f64 - 1.0) * 1.1f64.sqrt()
    }
}

fn hist_add(h: &mut Hist, ms: Ms) {
    *h.entry(bucket(ms.max(0))).or_default() += 1;
}

fn hist_merge(into: &mut Hist, from: &Hist) {
    for (b, n) in from {
        *into.entry(*b).or_default() += n;
    }
}

fn hist_median(h: &Hist) -> Option<f64> {
    let total: u32 = h.values().sum();
    if total == 0 {
        return None;
    }
    let mid = total.div_ceil(2);
    let mut seen = 0;
    for (b, n) in h {
        seen += n;
        if seen >= mid {
            return Some(bucket_value(*b));
        }
    }
    None
}

fn median_f(mut v: Vec<Ms>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    let n = v.len();
    Some(if n % 2 == 1 {
        v[n / 2] as f64
    } else {
        (v[n / 2 - 1] + v[n / 2]) as f64 / 2.0
    })
}

fn round_ms(v: Option<f64>) -> Option<f64> {
    v.map(|x| (x / 1000.0).round() * 1000.0)
}

fn round2(v: Option<f64>) -> Option<f64> {
    v.map(|x| (x * 100.0).round() / 100.0)
}

fn is_fail(s: CiState) -> bool {
    matches!(s, CiState::Failure | CiState::Error)
}

/// The metric's value in one window: what it measures and how it rounds.
#[derive(Clone, Copy, PartialEq)]
enum M {
    Intake,
    Run,
    Pass,
    Pipelines,
    Deploys,
    PrAge,
    Red,
}

impl M {
    fn round(self, v: Option<f64>) -> Option<f64> {
        match self {
            M::Intake | M::Run => round_ms(v),
            M::PrAge => v.map(|x| (x / 3_600_000.0).round() * 3_600_000.0),
            M::Red => v.map(|x| (x * 10.0).round() / 10.0),
            _ => round2(v),
        }
    }
    /// Direction of h1 against the baseline, and whether it is the bad one.
    fn dir(self, h1: Option<f64>, base: Option<f64>) -> (i8, bool) {
        let (Some(a), Some(b)) = (h1, base) else {
            return (0, false);
        };
        let d = a - b;
        // A move must be both relative (15 %) and big enough to matter in absolute terms.
        let moved = match self {
            M::Pass => d.abs() > 0.05,
            M::Red => d.abs() >= 1.0_f64.max(0.15 * b),
            M::Intake | M::Run => d.abs() > (0.15 * b).max(5_000.0),
            M::PrAge => d.abs() > (0.15 * b).max(3_600_000.0),
            M::Pipelines | M::Deploys => d.abs() > (0.15 * b).max(2.0),
        };
        if !moved {
            return (0, false);
        }
        let dir = if d > 0.0 { 1 } else { -1 };
        let bad = match self {
            M::Intake | M::Run | M::PrAge | M::Red => dir > 0,
            M::Pass => dir < 0,
            M::Pipelines | M::Deploys => false,
        };
        (dir, bad)
    }
}

/// One failed step, as clusters and flakes see it.
struct Failure {
    cid: String,
    repo: String,
    sha: String,
    wf: String,
    step: String,
    pipeline: String,
    at: Ms,
}

/// The live (fact-backed) numbers of one group in one window.
#[derive(Default)]
struct Live {
    intake: Vec<Ms>,
    run: Vec<Ms>,
    success: u32,
    failed: u32,
    finished: u32,
    deploys: u32,
}

impl Store {
    pub(super) fn rebuild_repo_team(&mut self) {
        let mut votes: BTreeMap<String, BTreeMap<String, u32>> = BTreeMap::new();
        for a in self.app_list.iter().flat_map(|l| l.apps.iter()) {
            if let (Some(r), Some(t)) = (&a.repo, a.team.as_deref().and_then(team_slug)) {
                *votes.entry(r.clone()).or_default().entry(t).or_default() += 1;
            }
        }
        // Display names: the catalog's spelling when it is an acronym ("HR", "SEIT").
        let mut names: BTreeMap<String, String> = BTreeMap::new();
        for a in self.app_list.iter().flat_map(|l| l.apps.iter()) {
            if let Some(raw) = a.team.as_deref()
                && let Some(t) = team_slug(raw)
            {
                let raw = raw.trim();
                let raw = raw
                    .strip_suffix("-team")
                    .or(raw.strip_suffix("-Team"))
                    .unwrap_or(raw);
                if raw.len() >= 2 && raw.chars().all(|c| c.is_ascii_uppercase()) {
                    names.insert(t, raw.to_string());
                }
            }
        }
        self.team_names = names;
        let mut m = FxHashMap::default();
        for (r, v) in votes {
            // Most apps wins; ties go to the smallest slug (deterministic).
            if let Some((t, _)) = v
                .into_iter()
                .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
            {
                m.insert(r, t);
            }
        }
        // Repos whose team changed re-derive their `group`.
        let changed: Vec<String> = m
            .iter()
            .filter(|(r, t)| self.repo_team.get(*r) != Some(*t))
            .map(|(r, _)| r.clone())
            .chain(
                self.repo_team
                    .keys()
                    .filter(|r| !m.contains_key(*r))
                    .cloned(),
            )
            .collect();
        self.repo_team = m;
        for r in changed {
            self.mark(Kind::Repo, &r);
        }
    }

    /// `team:<slug>` from the apps catalog, else `org:<owner>`.
    pub fn group_of(&self, repo: &str) -> String {
        match self.repo_team.get(repo) {
            Some(t) => format!("team:{t}"),
            None => format!("org:{}", repo.split('/').next().unwrap_or(repo)),
        }
    }

    /// A failed step's signature: from its log when read, else from its name + exit code.
    /// The repo's own name and app ids in the line are masked, so the same cause in
    /// different repos ("Container not found for app 'x'") is one cluster.
    fn failure_sig(&self, pipeline: &str, wf: &str, s: &Step) -> (String, String, Signature) {
        let sig = match self.step_errors.get(&step_key(pipeline, wf, &s.name)) {
            Some(e) => Signature {
                class: e.class,
                line: e.line.as_ref().map(|l| self.mask_own_names(pipeline, l)),
                exit_code: e.exit_code.or(s.exit_code),
            },
            None => signature::extract(wf, &s.name, s.exit_code, &[]),
        };
        let (k, id) = signature::key(&s.name, &sig);
        (k, id, sig)
    }

    fn mask_own_names(&self, pipeline: &str, line: &str) -> String {
        let Some(p) = self.pipelines.get(pipeline) else {
            return line.to_string();
        };
        let mut names: Vec<String> = self
            .app_list
            .iter()
            .flat_map(|l| l.apps.iter())
            .filter(|a| a.repo.as_deref() == Some(p.repo.as_str()))
            .map(|a| a.id.clone())
            .collect();
        names.push(p.repo.split('/').nth(1).unwrap_or("").to_string());
        names.retain(|n| n.len() >= 3);
        // Longest first, case-insensitively, whole quoted or word-bounded tokens only.
        names.sort_by_key(|n| std::cmp::Reverse(n.len()));
        let mut out = line.to_string();
        for n in names {
            for q in ['\'', '"', '`'] {
                let pat = format!("{q}{n}{q}");
                let low = out.to_ascii_lowercase();
                if let Some(i) = low.find(&pat.to_ascii_lowercase()) {
                    out.replace_range(i..i + pat.len(), &format!("{q}…{q}"));
                }
            }
        }
        out
    }

    /// `Step.cluster` on failed steps and `Pipeline.flaky`.
    pub(super) fn mark_failures(&self, p: &mut Pipeline) {
        let failed = is_fail(p.state) && p.state.is_done();
        let pid = p.id.clone();
        let mut all_passed = failed;
        let mut any = false;
        for w in p.workflows.iter_mut() {
            for s in w.steps.iter_mut() {
                if !is_fail(s.state) {
                    continue;
                }
                any = true;
                s.cluster = Some(self.failure_sig(&pid, &w.name, s).1);
                if all_passed {
                    let at = s.finished.or(p.finished).unwrap_or(p.created);
                    all_passed = self.passed_elsewhere(&p.repo, &p.sha, &pid, &w.name, &s.name, at);
                }
            }
        }
        p.flaky = failed && any && all_passed;
    }

    fn passed_elsewhere(
        &self,
        repo: &str,
        sha: &str,
        pid: &str,
        wf: &str,
        step: &str,
        at: Ms,
    ) -> bool {
        let Some(sibs) = self.idx.sha_pipelines.get(&super::sha_key(repo, sha)) else {
            return false;
        };
        sibs.iter().filter(|x| *x != pid).any(|x| {
            self.pipelines.get(x).is_some_and(|o| {
                o.workflows.iter().filter(|w| w.name == wf).any(|w| {
                    w.steps.iter().any(|s| {
                        s.name == step
                            && s.state == CiState::Success
                            && (s.finished.or(o.finished).unwrap_or(o.created) - at).abs()
                                <= FLAKE_MS
                    })
                })
            })
        })
    }

    pub(super) fn trends_due(&self, now: Ms) -> bool {
        now > 0 && now - now.rem_euclid(TREND_EVERY_MS) != self.trends_at
    }

    /// The current hour's gauges (overwritten on each tick: the hour ends with its last value).
    pub(super) fn sample_gauges(&mut self, now: Ms) {
        if now <= 0 {
            return;
        }
        let g = self.gauges_now(now);
        self.gauges.insert(hour_of(now), g);
    }

    /// Per group (and "fleet"): median open non-bot PR age and repos with a red main.
    fn gauges_now(&self, now: Ms) -> BTreeMap<String, (Option<Ms>, u32)> {
        let mut ages: BTreeMap<String, Vec<Ms>> = BTreeMap::new();
        for p in self.prs_t.values() {
            let open = !matches!(
                p.phase,
                PrPhase::Merged | PrPhase::Closed | PrPhase::Deployed
            );
            if open && !p.bot {
                let a = (now - p.created).max(0);
                ages.entry(self.group_of(&p.repo)).or_default().push(a);
                ages.entry("fleet".into()).or_default().push(a);
            }
        }
        let mut red: BTreeMap<String, u32> = BTreeMap::new();
        for r in self.repos_t.values() {
            let g = self.group_of(&r.id);
            red.entry(g.clone()).or_default();
            red.entry("fleet".into()).or_default();
            if is_fail(r.main.state) {
                *red.entry(g).or_default() += 1;
                *red.entry("fleet".into()).or_default() += 1;
            }
        }
        let mut out = BTreeMap::new();
        for k in ages
            .keys()
            .chain(red.keys())
            .cloned()
            .collect::<BTreeSet<_>>()
        {
            let age = ages
                .get(&k)
                .and_then(|v| median_f(v.clone()))
                .map(|x| x as Ms);
            out.insert(k.clone(), (age, red.get(&k).copied().unwrap_or(0)));
        }
        out
    }

    /// Recompute when something they read changed (or a new 5-minute bucket began):
    /// a pure function of the registers and `now`, so any arrival order converges.
    pub(super) fn flush_insights(&mut self, now: Ms, ops: &mut Vec<OpOut>) {
        if self.insights_dirty {
            self.insights_dirty = false;
            let (groups, clusters, flakes) = self.compute_floor(now);
            if groups != self.tables[Kind::Group.index()] {
                self.trends_dirty = true; // trends exist per group
            }
            self.sync_table(Kind::Group, groups, ops);
            self.sync_table(Kind::Cluster, clusters, ops);
            self.sync_table(Kind::Flake, flakes, ops);
        }
        if self.trends_dirty || self.trends_due(now) {
            self.trends_dirty = false;
            self.trends_at = now - now.rem_euclid(TREND_EVERY_MS);
            let t = self.compute_trends(now);
            self.sync_table(Kind::Trend, t, ops);
        }
    }

    fn sync_table(&mut self, k: Kind, new: BTreeMap<String, Arc<str>>, ops: &mut Vec<OpOut>) {
        let old = std::mem::take(&mut self.tables[k.index()]);
        for id in old.keys() {
            if !new.contains_key(id) {
                ops.push(OpOut::Remove {
                    kind: k,
                    id: id.clone(),
                });
            }
        }
        for (id, j) in &new {
            match old.get(id) {
                Some(cur) if **cur == **j => {}
                Some(cur) => delta_ops(k, id.clone(), cur, j.clone(), ops),
                None => ops.push(OpOut::Upsert {
                    kind: k,
                    id: id.clone(),
                    json: j.clone(),
                }),
            }
        }
        self.tables[k.index()] = new;
    }

    /// Failed steps of runs finished in the window, plus each step's latest outcome per
    /// (repo, branch) and every outcome per (repo, step, sha).
    #[allow(clippy::type_complexity)]
    fn scan_runs(
        &self,
        lo: Ms,
    ) -> (
        Vec<Failure>,
        BTreeMap<(String, String, String, String), (Ms, String, Option<String>)>,
        BTreeMap<(String, String, String), BTreeMap<String, Vec<(Ms, bool)>>>,
        BTreeMap<String, (String, Signature)>,
    ) {
        let mut fails = Vec::new();
        let mut latest: BTreeMap<(String, String, String, String), (Ms, String, Option<String>)> =
            BTreeMap::new();
        let mut outcomes: BTreeMap<(String, String, String), BTreeMap<String, Vec<(Ms, bool)>>> =
            BTreeMap::new();
        let mut sigs: BTreeMap<String, (String, Signature)> = BTreeMap::new();
        for p in self.pipelines.values() {
            if !p.state.is_done() || p.state == CiState::Canceled {
                continue;
            }
            let t = p.finished.unwrap_or(p.created);
            if t < lo {
                continue;
            }
            for w in &p.workflows {
                for s in &w.steps {
                    let ok = s.state == CiState::Success;
                    let bad = is_fail(s.state);
                    if !ok && !bad {
                        continue;
                    }
                    let at = s.finished.unwrap_or(t);
                    let cid = bad.then(|| {
                        let (k, id, sig) = self.failure_sig(&p.id, &w.name, s);
                        sigs.entry(id.clone()).or_insert((k, sig));
                        id
                    });
                    let lk = (
                        p.repo.clone(),
                        p.branch.clone(),
                        w.name.clone(),
                        s.name.clone(),
                    );
                    let cand = (at, p.id.clone(), cid.clone());
                    match latest.get(&lk) {
                        Some(cur) if (cur.0, &cur.1) >= (cand.0, &cand.1) => {}
                        _ => {
                            latest.insert(lk, cand);
                        }
                    }
                    outcomes
                        .entry((p.repo.clone(), w.name.clone(), s.name.clone()))
                        .or_default()
                        .entry(p.sha.clone())
                        .or_default()
                        .push((at, ok));
                    if let Some(cid) = cid {
                        fails.push(Failure {
                            cid,
                            repo: p.repo.clone(),
                            sha: p.sha.clone(),
                            wf: w.name.clone(),
                            step: s.name.clone(),
                            pipeline: p.id.clone(),
                            at,
                        });
                    }
                }
            }
        }
        (fails, latest, outcomes, sigs)
    }

    fn compute_floor(&self, now: Ms) -> (Table, Table, Table) {
        // ---- groups ----
        let mut groups: BTreeMap<String, Group> = BTreeMap::new();
        let entry = |groups: &mut BTreeMap<String, Group>, gid: &str| {
            if !groups.contains_key(gid) {
                let (kind, name) = match gid.split_once(':') {
                    Some(("team", t)) => (
                        GroupKind::Team,
                        self.team_names
                            .get(t)
                            .cloned()
                            .unwrap_or_else(|| group_name(t)),
                    ),
                    Some((_, o)) => (GroupKind::Org, o.to_string()),
                    None => (GroupKind::Org, gid.to_string()),
                };
                groups.insert(
                    gid.to_string(),
                    Group {
                        id: gid.to_string(),
                        name,
                        kind,
                        repos: 0,
                        apps: 0,
                        red: 0,
                    },
                );
            }
        };
        for r in self.repos_t.values() {
            let gid = self.group_of(&r.id);
            entry(&mut groups, &gid);
            let g = groups.get_mut(&gid).expect("group");
            g.repos += 1;
            if is_fail(r.main.state) {
                g.red += 1;
            }
        }
        for a in self.app_list.iter().flat_map(|l| l.apps.iter()) {
            let gid = match (&a.repo, a.team.as_deref().and_then(team_slug)) {
                (Some(r), _) => self.group_of(r),
                (None, Some(t)) => format!("team:{t}"),
                (None, None) => continue,
            };
            entry(&mut groups, &gid);
            groups.get_mut(&gid).expect("group").apps += 1;
        }
        let groups_t: BTreeMap<String, Arc<str>> = groups
            .iter()
            .map(|(k, g)| (k.clone(), to_json(g)))
            .collect();

        // ---- clusters + flakes ----
        let (fails, latest, outcomes, sigs) = self.scan_runs(now - WINDOW_MS);
        // (repo, wf, step, sha) → flipped (failed and passed within FLAKE_MS).
        let mut flipped: BTreeSet<(String, String, String, String)> = BTreeSet::new();
        let mut flakes: BTreeMap<String, Flake> = BTreeMap::new();
        for ((repo, wf, step), by_sha) in &outcomes {
            let mut shas: Vec<(Ms, String)> = Vec::new();
            let mut failures = 0u32;
            for (sha, evs) in by_sha {
                failures += evs.iter().filter(|e| !e.1).count() as u32;
                let mut flip_at: Option<Ms> = None;
                for (tf, okf) in evs {
                    if *okf {
                        continue;
                    }
                    for (tp, okp) in evs {
                        if *okp && (tf - tp).abs() <= FLAKE_MS {
                            flip_at = Some(flip_at.unwrap_or(0).max(*tf).max(*tp));
                        }
                    }
                }
                if let Some(t) = flip_at {
                    shas.push((t, sha.clone()));
                    flipped.insert((repo.clone(), wf.clone(), step.clone(), sha.clone()));
                }
            }
            if shas.is_empty() {
                continue;
            }
            shas.sort_by(|a, b| b.cmp(a));
            let id = format!("{repo}|{wf}/{step}");
            flakes.insert(
                id.clone(),
                Flake {
                    id,
                    repo: repo.clone(),
                    workflow: wf.clone(),
                    step: step.clone(),
                    flips_24h: shas.len() as u32,
                    failures_24h: failures,
                    last_at: shas[0].0,
                    shas: shas.iter().take(5).map(|x| x.1.clone()).collect(),
                },
            );
        }
        // Open: repos where a (branch, step)'s latest run failed with this cluster.
        let mut open: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for ((repo, _, _, _), (_, _, cid)) in &latest {
            if let Some(c) = cid {
                open.entry(c.clone()).or_default().insert(repo.clone());
            }
        }
        // First sightings from the rollups (7 d).
        let mut seen: BTreeMap<&str, Ms> = BTreeMap::new();
        for r in self.rollups.values() {
            for (cid, s) in &r.clusters {
                let e = seen.entry(cid.as_str()).or_insert(s.first);
                *e = (*e).min(s.first);
            }
        }
        struct Acc {
            count: u32,
            count_1h: u32,
            repos: BTreeMap<String, Ms>,
            groups: BTreeSet<String>,
            first: Ms,
            last: (Ms, String),
            examples: BTreeSet<(Ms, String)>,
            flaky: u32,
            exit: (Ms, String, Option<i32>),
        }
        let mut acc: BTreeMap<String, Acc> = BTreeMap::new();
        for f in &fails {
            let a = acc.entry(f.cid.clone()).or_insert_with(|| Acc {
                count: 0,
                count_1h: 0,
                repos: BTreeMap::new(),
                groups: BTreeSet::new(),
                first: Ms::MAX,
                last: (Ms::MIN, String::new()),
                examples: BTreeSet::new(),
                flaky: 0,
                exit: (Ms::MIN, String::new(), None),
            });
            a.count += 1;
            if f.at >= now - H {
                a.count_1h += 1;
            }
            let r = a.repos.entry(f.repo.clone()).or_insert(f.at);
            *r = (*r).max(f.at);
            a.groups.insert(self.group_of(&f.repo));
            a.first = a.first.min(f.at);
            if (f.at, &f.pipeline) > (a.last.0, &a.last.1) {
                a.last = (f.at, f.pipeline.clone());
            }
            a.examples.insert((f.at, f.pipeline.clone()));
            if a.examples.len() > 5 {
                let lo = a.examples.iter().next().cloned().expect("non-empty");
                a.examples.remove(&lo);
            }
            if flipped.contains(&(f.repo.clone(), f.wf.clone(), f.step.clone(), f.sha.clone())) {
                a.flaky += 1;
            }
            if (f.at, &f.pipeline) > (a.exit.0, &a.exit.1) {
                let code = self
                    .pipelines
                    .get(&f.pipeline)
                    .and_then(|p| p.workflows.iter().find(|w| w.name == f.wf))
                    .and_then(|w| w.steps.iter().find(|s| s.name == f.step))
                    .and_then(|s| s.exit_code);
                a.exit = (f.at, f.pipeline.clone(), code);
            }
        }
        let mut clusters_t = BTreeMap::new();
        for (cid, a) in acc {
            let Some((key, sig)) = sigs.get(&cid) else {
                continue;
            };
            let mut repos: Vec<(Ms, String)> =
                a.repos.iter().map(|(r, t)| (*t, r.clone())).collect();
            repos.sort_by(|x, y| y.0.cmp(&x.0).then(x.1.cmp(&y.1)));
            let first = seen
                .get(cid.as_str())
                .map_or(a.first, |s| (*s).min(a.first));
            let c = Cluster {
                id: cid.clone(),
                signature: key.clone(),
                step: signature::fold_step(key.split(" · ").next().unwrap_or("")),
                class: sig.class,
                line: sig.line.clone(),
                exit_code: a.exit.2.or(sig.exit_code),
                count: a.count,
                count_1h: a.count_1h,
                repo_count: repos.len() as u32,
                repos: repos.into_iter().take(12).map(|x| x.1).collect(),
                groups: a.groups.into_iter().collect(),
                first_seen: first,
                last_seen: a.last.0,
                examples: a.examples.iter().rev().map(|x| x.1.clone()).collect(),
                open: open.get(&cid).map_or(0, |s| s.len() as u32),
                flaky: a.flaky,
            };
            clusters_t.insert(cid, to_json(&c));
        }
        let flakes_t = flakes
            .iter()
            .map(|(k, f)| (k.clone(), to_json(f)))
            .collect();
        (groups_t, clusters_t, flakes_t)
    }

    /// Pipelines finished in [lo, hi) and successful deploys finished in it, by group.
    fn live(&self, lo: Ms, hi: Ms) -> BTreeMap<String, Live> {
        let mut out: BTreeMap<String, Live> = BTreeMap::new();
        for p in self.pipelines.values() {
            if !p.state.is_done() || p.state == CiState::Canceled {
                continue;
            }
            let t = p.finished.unwrap_or(p.created);
            if t < lo || t >= hi {
                continue;
            }
            for g in [self.group_of(&p.repo), "fleet".to_string()] {
                let l = out.entry(g).or_default();
                l.finished += 1;
                if let Some(s) = p.started {
                    l.intake.push((s - p.created).max(0));
                }
                if p.state == CiState::Success {
                    l.success += 1;
                    if let (Some(s), Some(f)) = (p.started, p.finished) {
                        l.run.push((f - s).max(0));
                    }
                } else if is_fail(p.state) {
                    l.failed += 1;
                }
            }
        }
        for d in self.deploys_t.values() {
            let Some(f) = d.finished else { continue };
            if d.state != DeployState::Success || f < lo || f >= hi {
                continue;
            }
            for g in [self.group_of(&d.repo), "fleet".to_string()] {
                out.entry(g).or_default().deploys += 1;
            }
        }
        out
    }

    /// Rollups of every hour in [lo, hi) from the registers, in one pass.
    fn rollups_from_facts(&self, lo: Ms, hi: Ms, with_clusters: bool) -> BTreeMap<Ms, RollupFact> {
        let mut by_hour: BTreeMap<Ms, BTreeMap<String, Live>> = BTreeMap::new();
        for p in self.pipelines.values() {
            if !p.state.is_done() || p.state == CiState::Canceled {
                continue;
            }
            let t = p.finished.unwrap_or(p.created);
            if t < lo || t >= hi {
                continue;
            }
            let hm = by_hour.entry(hour_of(t)).or_default();
            for g in [self.group_of(&p.repo), "fleet".to_string()] {
                let l = hm.entry(g).or_default();
                l.finished += 1;
                if let Some(s) = p.started {
                    l.intake.push((s - p.created).max(0));
                }
                if p.state == CiState::Success {
                    l.success += 1;
                    if let (Some(s), Some(f)) = (p.started, p.finished) {
                        l.run.push((f - s).max(0));
                    }
                } else if is_fail(p.state) {
                    l.failed += 1;
                }
            }
        }
        for d in self.deploys_t.values() {
            let Some(f) = d.finished else { continue };
            if d.state != DeployState::Success || f < lo || f >= hi {
                continue;
            }
            let hm = by_hour.entry(hour_of(f)).or_default();
            for g in [self.group_of(&d.repo), "fleet".to_string()] {
                hm.entry(g).or_default().deploys += 1;
            }
        }
        let mut out = BTreeMap::new();
        let mut h = hour_of(lo);
        while h < hi {
            let lives = by_hour.remove(&h).unwrap_or_default();
            out.insert(h, self.rollup_of(h, lives));
            h += H;
        }
        if with_clusters {
            let (fails, ..) = self.scan_runs(lo);
            for f in fails.iter().filter(|f| f.at < hi) {
                if let Some(r) = out.get_mut(&hour_of(f.at)) {
                    let e = r
                        .clusters
                        .entry(f.cid.clone())
                        .or_insert(ClusterSeen { n: 0, first: f.at });
                    e.n += 1;
                    e.first = e.first.min(f.at);
                }
            }
        }
        out
    }

    fn rollup_of(&self, hour: Ms, lives: BTreeMap<String, Live>) -> RollupFact {
        let mut r = RollupFact {
            hour,
            ..Default::default()
        };
        for (g, l) in lives {
            let mut a = Agg {
                finished: l.finished,
                success: l.success,
                failed: l.failed,
                deploys: l.deploys,
                ..Default::default()
            };
            for v in &l.intake {
                hist_add(&mut a.intake, *v);
            }
            for v in &l.run {
                hist_add(&mut a.run, *v);
            }
            if g == "fleet" {
                r.fleet = a;
            } else {
                r.groups.insert(g, a);
            }
        }
        if let Some(gs) = self.gauges.get(&hour) {
            for (g, (age, red)) in gs {
                let a = if g == "fleet" {
                    &mut r.fleet
                } else {
                    r.groups.entry(g.clone()).or_default()
                };
                a.pr_age_ms = *age;
                a.red = Some(*red);
            }
        }
        r
    }

    /// Closed hours after `after` that are old enough to roll up and still inside the
    /// retained window (the runtime persists them and feeds them back as facts).
    pub fn closed_rollups(&self, after: Ms, now: Ms) -> Vec<RollupFact> {
        let first = hour_of(now - 24 * H).max(after + H);
        let last = hour_of(now - ROLLUP_AFTER_MS) + H; // exclusive
        if first >= last {
            return Vec::new();
        }
        self.rollups_from_facts(first, last, true)
            .into_values()
            .filter(|r| !self.rollups.contains_key(&r.hour))
            .collect()
    }

    /// Trends as of the start of the current 5-minute bucket: windows move once per
    /// bucket (not on every tick), so clients get at most one update per 5 minutes plus
    /// late data.
    fn compute_trends(&self, now: Ms) -> BTreeMap<String, Arc<str>> {
        let now = now - now.rem_euclid(TREND_EVERY_MS);
        let cur = hour_of(now);
        let h1 = self.live(now - H, now + 1);
        let h24 = self.live(now - 24 * H, now + 1);
        // The last 168 hours (oldest first): a persisted rollup where there is one, else
        // the registers for hours inside the retained window.
        let live_lo = hour_of(now - 24 * H);
        let mut from_facts = self.rollups_from_facts(live_lo, cur + H, false);
        let hours: Vec<(Ms, Option<RollupFact>)> = (0..HOURS_7D as i64)
            .rev()
            .map(|i| {
                let h = cur - i * H;
                let r = match self.rollups.get(&h) {
                    Some(r) => Some(r.clone()),
                    None if h >= live_lo => from_facts.remove(&h),
                    None => None,
                };
                (h, r)
            })
            .collect();
        let hours_7d = hours.iter().filter(|(_, r)| r.is_some()).count() as u32;
        let gauges_now = self.gauges_now(now);
        let mut ids: BTreeSet<String> = self.tables[Kind::Group.index()].keys().cloned().collect();
        ids.insert("fleet".into());
        let mut out = BTreeMap::new();
        for id in ids {
            let agg = |r: &RollupFact| -> Option<Agg> {
                if id == "fleet" {
                    Some(r.fleet.clone())
                } else {
                    r.groups.get(&id).cloned()
                }
            };
            let per_hour: Vec<Option<Agg>> = hours
                .iter()
                .map(|(_, r)| r.as_ref().map(|r| agg(r).unwrap_or_default()))
                .collect();
            let empty = Live::default();
            let l1 = h1.get(&id).unwrap_or(&empty);
            let l24 = h24.get(&id).unwrap_or(&empty);
            let (age_now, red_now) = gauges_now.get(&id).cloned().unwrap_or((None, 0));
            let spark_of = |f: &dyn Fn(&Agg) -> Option<f64>| -> Vec<Option<f64>> {
                // The last 24 full hours (the running hour is h1).
                per_hour[HOURS_7D - 25..HOURS_7D - 1]
                    .iter()
                    .map(|a| a.as_ref().and_then(f))
                    .collect()
            };
            let all = |f: &dyn Fn(&Agg) -> Option<f64>| -> Vec<f64> {
                per_hour.iter().flatten().filter_map(f).collect()
            };
            let mean = |v: Vec<f64>| -> Option<f64> {
                (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64)
            };
            let sum_hist = |pick: &dyn Fn(&Agg) -> &Hist| -> Option<f64> {
                let mut h = Hist::new();
                for a in per_hour.iter().flatten() {
                    hist_merge(&mut h, pick(a));
                }
                hist_median(&h)
            };
            let pass = |s: u32, f: u32| (s + f > 0).then(|| s as f64 / (s + f) as f64);
            let hrs = hours_7d.max(1) as f64;
            let metric = |m: M,
                          h1: Option<f64>,
                          h24: Option<f64>,
                          d7: Option<f64>,
                          spark: Vec<Option<f64>>| {
                let (h1, h24, d7) = (m.round(h1), m.round(h24), m.round(d7));
                let base = if hours_7d > 25 && d7.is_some() {
                    d7
                } else {
                    h24
                };
                // Too few runs in the last hour to call a direction for per-run metrics.
                let (dir, bad) = if matches!(m, M::Intake | M::Run | M::Pass) && l1.finished < 5 {
                    (0, false)
                } else {
                    m.dir(h1, base)
                };
                Metric {
                    h1,
                    h24,
                    d7,
                    dir,
                    bad,
                    spark: spark.into_iter().map(|v| m.round(v)).collect(),
                }
            };
            // Gauges: the current hour's sample is the live value.
            let gauge = |pick: &dyn Fn(&Agg) -> Option<f64>,
                         live: Option<f64>|
             -> (Vec<Option<f64>>, Vec<f64>) {
                let sp = spark_of(pick);
                let mut v = all(pick);
                if per_hour
                    .last()
                    .and_then(|a| a.as_ref())
                    .and_then(pick)
                    .is_none()
                    && let Some(x) = live
                {
                    v.push(x);
                }
                (sp, v)
            };
            let (age_sp, age_all) = gauge(
                &|a| a.pr_age_ms.map(|x| x as f64),
                age_now.map(|x| x as f64),
            );
            let age_24: Vec<f64> = age_sp.iter().flatten().copied().collect();
            let (red_sp, red_all) = gauge(&|a| a.red.map(|x| x as f64), Some(red_now as f64));
            let red_24: Vec<f64> = red_sp.iter().flatten().copied().collect();
            let t = Trend {
                id: id.clone(),
                at: now - now.rem_euclid(TREND_EVERY_MS),
                intake_ms: metric(
                    M::Intake,
                    median_f(l1.intake.clone()),
                    median_f(l24.intake.clone()),
                    sum_hist(&|a| &a.intake),
                    spark_of(&|a| hist_median(&a.intake)),
                ),
                run_ms: metric(
                    M::Run,
                    median_f(l1.run.clone()),
                    median_f(l24.run.clone()),
                    sum_hist(&|a| &a.run),
                    spark_of(&|a| hist_median(&a.run)),
                ),
                pass_rate: metric(
                    M::Pass,
                    pass(l1.success, l1.failed),
                    pass(l24.success, l24.failed),
                    {
                        let (s, f) = per_hour
                            .iter()
                            .flatten()
                            .fold((0, 0), |(s, f), a| (s + a.success, f + a.failed));
                        pass(s, f)
                    },
                    spark_of(&|a| pass(a.success, a.failed)),
                ),
                pipelines: metric(
                    M::Pipelines,
                    Some(l1.finished as f64),
                    Some(l24.finished as f64 / 24.0),
                    Some(
                        per_hour
                            .iter()
                            .flatten()
                            .map(|a| a.finished as f64)
                            .sum::<f64>()
                            / hrs,
                    ),
                    spark_of(&|a| Some(a.finished as f64)),
                ),
                deploys: metric(
                    M::Deploys,
                    Some(l1.deploys as f64),
                    Some(l24.deploys as f64 / 24.0),
                    Some(
                        per_hour
                            .iter()
                            .flatten()
                            .map(|a| a.deploys as f64)
                            .sum::<f64>()
                            / hrs,
                    ),
                    spark_of(&|a| Some(a.deploys as f64)),
                ),
                pr_age_ms: metric(
                    M::PrAge,
                    age_now.map(|x| x as f64),
                    mean(age_24),
                    mean(age_all),
                    age_sp,
                ),
                red: metric(
                    M::Red,
                    Some(red_now as f64),
                    mean(red_24),
                    mean(red_all),
                    red_sp,
                ),
                hours_7d,
            };
            out.insert(id, to_json(&t));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teams_normalize() {
        assert_eq!(team_slug("Software-Team").as_deref(), Some("software"));
        assert_eq!(team_slug("software").as_deref(), Some("software"));
        assert_eq!(team_slug("Power Systems").as_deref(), Some("power-systems"));
        assert_eq!(team_slug("unknown-team"), None);
        assert_eq!(team_slug(" "), None);
        assert_eq!(group_name("power-systems"), "Power systems");
        assert_eq!(group_name("npi-scm"), "NPI SCM");
        assert_eq!(group_name("hr"), "HR");
        assert_eq!(group_name("field-operations"), "Field operations");
    }

    #[test]
    fn histogram_median_is_close() {
        let mut h = Hist::new();
        let v: Vec<Ms> = (1..=101).map(|i| i * 3_000).collect();
        for x in &v {
            hist_add(&mut h, *x);
        }
        let m = hist_median(&h).unwrap();
        let exact = median_f(v).unwrap();
        assert!((m - exact).abs() / exact < 0.06, "{m} vs {exact}");
        assert_eq!(hist_median(&Hist::new()), None);
    }

    #[test]
    fn directions() {
        assert_eq!(M::Run.dir(Some(130_000.0), Some(100_000.0)), (1, true));
        assert_eq!(M::Run.dir(Some(110_000.0), Some(100_000.0)), (0, false));
        assert_eq!(
            M::Intake.dir(Some(4_000.0), Some(5_000.0)),
            (0, false),
            "1 s is noise"
        );
        assert_eq!(M::Pass.dir(Some(0.80), Some(0.90)), (-1, true));
        assert_eq!(M::Pass.dir(Some(0.86), Some(0.90)), (0, false));
        assert_eq!(M::Pipelines.dir(Some(5.0), Some(10.0)), (-1, false));
        assert_eq!(
            M::Pipelines.dir(Some(3.0), Some(1.5)),
            (0, false),
            "below 2/h"
        );
        assert_eq!(M::Red.dir(Some(3.0), Some(2.0)), (1, true));
        assert_eq!(M::Red.dir(Some(2.4), Some(2.0)), (0, false));
        assert_eq!(M::Run.dir(None, Some(1.0)), (0, false));
    }
}
