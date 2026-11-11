//! `GET /api/v1/pipeline/{id}/log?step=&workflow=&tail=`: the tail of one step's log,
//! read on demand from Woodpecker (`wp:` pipelines: the step's own log) or GitHub
//! Actions (`gha:` pipelines: a Step is a job; the job's log). Bounded (≤ 500 lines,
//! ≤ 64 KB, lines cut at 400 chars), secrets redacted, cached (10 s while the step
//! runs, 10 min once it is done), at most 4 upstream reads at a time.

use std::collections::HashMap;
use std::time::Duration;

use futures::StreamExt;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::model::{CiState, Ms};

pub const TAIL_DEFAULT: usize = 200;
/// `around=decisive`: lines on each side of the decisive line.
pub const AROUND: usize = 40;
pub const TAIL_MAX: usize = 500;
const LINE_MAX: usize = 400;
const BYTES_MAX: usize = 64 * 1024;
/// Upstream bodies larger than this are not read (a log this big is not tailed here).
const BODY_MAX: usize = 32 * 1024 * 1024;
const TTL_LIVE: Ms = 10_000;
const TTL_DONE: Ms = 600_000;
const CACHE_MAX: usize = 256;

#[derive(Debug)]
pub enum LogError {
    /// Unknown upstream pipeline / step (404).
    NotFound(String),
    /// The upstream failed (502).
    Upstream(String),
}

impl std::fmt::Display for LogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogError::NotFound(m) | LogError::Upstream(m) => f.write_str(m),
        }
    }
}

/// Where a step's log lives.
#[derive(Clone, Debug)]
pub struct StepRef {
    pub pipeline: String,
    pub repo: String,
    pub workflow: String,
    pub step: String,
    pub state: CiState,
}

/// (pipeline, workflow, step, tail, around)
type Key = (String, String, String, usize, bool);

pub struct Logs {
    wp: Option<(String, String)>,
    gh: Option<(String, String)>,
    http: reqwest::Client,
    cache: Mutex<HashMap<Key, (Ms, Value)>>,
    wp_repo_ids: Mutex<HashMap<String, u64>>,
    sem: tokio::sync::Semaphore,
}

#[derive(Deserialize)]
struct WpRepoId {
    id: u64,
}

#[derive(Deserialize)]
struct GhJobs {
    #[serde(default)]
    jobs: Vec<GhJob>,
}

#[derive(Deserialize)]
struct GhJob {
    id: u64,
    #[serde(default)]
    name: String,
}

impl Logs {
    /// `wp` = (Woodpecker base URL, token); `gh` = (GitHub API base URL, token).
    pub fn new(
        wp: Option<(String, String)>,
        gh: Option<(String, String)>,
        http: reqwest::Client,
    ) -> Logs {
        let trim = |(u, t): (String, String)| (u.trim_end_matches('/').to_string(), t);
        Logs {
            wp: wp.map(trim),
            gh: gh.map(trim),
            http,
            cache: Mutex::new(HashMap::new()),
            wp_repo_ids: Mutex::new(HashMap::new()),
            sem: tokio::sync::Semaphore::new(4),
        }
    }

    /// The source a pipeline's logs come from is configured.
    pub fn serves(&self, pipeline: &str) -> bool {
        (pipeline.starts_with("wp:") && self.wp.is_some())
            || (pipeline.starts_with("gha:") && self.gh.is_some())
    }

    /// `PipelineLog` for one step: the last `tail` lines, or with `around` (failed steps
    /// with a decisive line) the ±[`AROUND`] lines around the decisive line.
    pub async fn tail(
        &self,
        s: &StepRef,
        tail: usize,
        around: bool,
        now: Ms,
    ) -> Result<Value, LogError> {
        let tail = tail.clamp(1, TAIL_MAX);
        let key = (
            s.pipeline.clone(),
            s.workflow.clone(),
            s.step.clone(),
            tail,
            around,
        );
        let hit = self.cached(&key, now);
        if let Some(v) = hit {
            return Ok(v);
        }
        let _permit = self
            .sem
            .acquire()
            .await
            .map_err(|_| LogError::Upstream("closed".into()))?;
        // Another request may have filled it while this one waited.
        let hit = self.cached(&key, now);
        if let Some(v) = hit {
            return Ok(v);
        }
        // The same window the failure signatures read, so the decisive line is the one
        // the step's cluster came from.
        let window = crate::adapters::woodpecker::LOG_LINES;
        let (raw, state, exit) = if s.pipeline.starts_with("wp:") {
            self.wp_lines(s, window).await?
        } else if s.pipeline.starts_with("gha:") {
            let (l, st) = self.gh_lines(s, window).await?;
            (l, st, None)
        } else {
            return Err(LogError::NotFound("no logs for this pipeline".into()));
        };
        let state = state.unwrap_or(s.state);
        let decisive = matches!(state, CiState::Failure | CiState::Error)
            .then(|| crate::signature::extract_at(&s.workflow, &s.step, exit, &raw).1)
            .flatten();
        let mut v = match decisive.filter(|_| around) {
            Some(d) => around_of(raw, d),
            None => tail_of(raw, tail, decisive),
        };
        v["id"] = s.pipeline.clone().into();
        v["step"] = s.step.clone().into();
        if !s.workflow.is_empty() {
            v["workflow"] = s.workflow.clone().into();
        }
        v["state"] = serde_json::to_value(state).unwrap_or(Value::Null);
        v["fetched"] = now.into();
        let ttl = if state.is_done() { TTL_DONE } else { TTL_LIVE };
        let mut c = self.cache.lock();
        if c.len() >= CACHE_MAX {
            c.retain(|_, (exp, _)| *exp > now);
            if c.len() >= CACHE_MAX {
                c.clear();
            }
        }
        c.insert(key, (now + ttl, v.clone()));
        Ok(v)
    }

    fn cached(&self, key: &Key, now: Ms) -> Option<Value> {
        let c = self.cache.lock();
        c.get(key)
            .filter(|(exp, _)| *exp > now)
            .map(|(_, v)| v.clone())
    }

    async fn get(
        &self,
        url: &str,
        token: &str,
        github: bool,
    ) -> Result<(reqwest::StatusCode, Vec<u8>), LogError> {
        let mut rq = self
            .http
            .get(url)
            .bearer_auth(token)
            .timeout(Duration::from_secs(30));
        if github {
            rq = rq
                .header("accept", "application/vnd.github+json")
                .header("x-github-api-version", "2022-11-28");
        }
        let r = rq
            .send()
            .await
            .map_err(|e| LogError::Upstream(format!("upstream: {}", e.without_url())))?;
        let st = r.status();
        let mut body = Vec::new();
        let mut stream = r.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|e| LogError::Upstream(format!("upstream: {}", e.without_url())))?;
            body.extend_from_slice(&chunk);
            if body.len() > BODY_MAX {
                return Err(LogError::Upstream("log too large to tail here".into()));
            }
        }
        Ok((st, body))
    }

    async fn wp_lines(
        &self,
        s: &StepRef,
        max: usize,
    ) -> Result<(Vec<String>, Option<CiState>, Option<i32>), LogError> {
        let (base, token) = self.wp.clone().expect("wp configured");
        let number: u64 = s
            .pipeline
            .rsplit(':')
            .next()
            .and_then(|n| n.parse().ok())
            .ok_or_else(|| LogError::NotFound("bad pipeline id".into()))?;
        let known = self.wp_repo_ids.lock().get(&s.repo).copied();
        let rid = match known {
            Some(id) => id,
            None => {
                let (st, b) = self
                    .get(
                        &format!("{base}/api/repos/lookup/{}", s.repo),
                        &token,
                        false,
                    )
                    .await?;
                if !st.is_success() {
                    return Err(not_found_or(st, "unknown repo"));
                }
                let id = serde_json::from_slice::<WpRepoId>(&b)
                    .map_err(|_| LogError::Upstream("bad repo answer".into()))?
                    .id;
                self.wp_repo_ids.lock().insert(s.repo.clone(), id);
                id
            }
        };
        let (st, b) = self
            .get(
                &format!("{base}/api/repos/{rid}/pipelines/{number}"),
                &token,
                false,
            )
            .await?;
        if !st.is_success() {
            return Err(not_found_or(st, "unknown pipeline"));
        }
        let p: crate::adapters::woodpecker::WpPipeline = serde_json::from_slice(&b)
            .map_err(|_| LogError::Upstream("bad pipeline answer".into()))?;
        let step = p
            .workflows
            .iter()
            .flatten()
            .filter(|w| s.workflow.is_empty() || w.name == s.workflow)
            .flat_map(|w| w.children.iter().flatten())
            .find(|c| c.name == s.step)
            .ok_or_else(|| LogError::NotFound("unknown step".into()))?;
        let state = crate::adapters::woodpecker::map_state(&step.state);
        let exit = Some(step.exit_code);
        if step.id == 0 || !started(state) {
            return Ok((Vec::new(), Some(state), exit));
        }
        let (st, b) = self
            .get(
                &format!("{base}/api/repos/{rid}/logs/{number}/{}", step.id),
                &token,
                false,
            )
            .await?;
        if st == reqwest::StatusCode::NOT_FOUND {
            return Ok((Vec::new(), Some(state), exit));
        }
        if !st.is_success() {
            return Err(LogError::Upstream(format!("log: HTTP {st}")));
        }
        Ok((crate::signature::decode_wp_log(&b, max), Some(state), exit))
    }

    async fn gh_lines(
        &self,
        s: &StepRef,
        max: usize,
    ) -> Result<(Vec<String>, Option<CiState>), LogError> {
        let (api, token) = self.gh.clone().expect("gh configured");
        let run = s
            .pipeline
            .strip_prefix("gha:")
            .ok_or_else(|| LogError::NotFound("bad pipeline id".into()))?;
        if !started(s.state) {
            return Ok((Vec::new(), None));
        }
        let mut job = None;
        for page in 1..=5 {
            let (st, b) = self
                .get(
                    &format!(
                        "{api}/repos/{}/actions/runs/{run}/jobs?filter=latest&per_page=100&page={page}",
                        s.repo
                    ),
                    &token,
                    true,
                )
                .await?;
            if !st.is_success() {
                return Err(not_found_or(st, "unknown run"));
            }
            let jobs: GhJobs = serde_json::from_slice(&b)
                .map_err(|_| LogError::Upstream("bad jobs answer".into()))?;
            let n = jobs.jobs.len();
            job = jobs.jobs.into_iter().find(|j| j.name == s.step);
            if job.is_some() || n < 100 {
                break;
            }
        }
        let job = job.ok_or_else(|| LogError::NotFound("unknown step".into()))?;
        // A 302 to the log text (reqwest follows it; the redirect drops the token).
        let (st, b) = self
            .get(
                &format!("{api}/repos/{}/actions/jobs/{}/logs", s.repo, job.id),
                &token,
                true,
            )
            .await?;
        if st == reqwest::StatusCode::NOT_FOUND {
            // A running job's log is not published until it ends.
            return Ok((Vec::new(), None));
        }
        if !st.is_success() {
            return Err(LogError::Upstream(format!("log: HTTP {st}")));
        }
        let text = String::from_utf8_lossy(&b);
        let all: Vec<&str> = text.lines().collect();
        let from = all.len().saturating_sub(max);
        Ok((
            all[from..]
                .iter()
                .map(|l| strip_gh_time(l).to_string())
                .collect(),
            None,
        ))
    }
}

/// The last `tail` lines (and the decisive line's index when inside them).
fn tail_of(mut raw: Vec<String>, tail: usize, decisive: Option<usize>) -> Value {
    // Keep the tail (+1: a line before it says the log goes on).
    let drop = raw.len().saturating_sub(tail + 1);
    raw.drain(..drop);
    let mut v = shape(raw, tail);
    if let Some(d) = decisive
        .and_then(|d| d.checked_sub(drop))
        .and_then(|d| d.checked_sub(v["first"].as_u64().unwrap_or(0) as usize))
        && d < v["lines"].as_array().map_or(0, Vec::len)
    {
        v["decisive"] = d.into();
    }
    if let Some(o) = v.as_object_mut() {
        o.remove("first");
    }
    v
}

/// The ±[`AROUND`] lines around the decisive line `d` of `raw` (the read window).
fn around_of(raw: Vec<String>, d: usize) -> Value {
    let lo = d.saturating_sub(AROUND);
    let hi = (d + AROUND + 1).min(raw.len());
    let n = raw.len();
    // The read window is the log's last lines: at its cap, the log may go on before it.
    let before = lo > 0 || n >= crate::adapters::woodpecker::LOG_LINES;
    let lines: Vec<String> = raw.into_iter().skip(lo).take(hi - lo).collect();
    let len = lines.len();
    let mut v = shape(lines, len);
    let first = v["first"].as_u64().unwrap_or(0) as usize;
    if let Some(o) = v.as_object_mut() {
        o.remove("first");
    }
    v["truncated"] = (before || hi < n || v["truncated"] == true || first > 0).into();
    if let Some(k) = (d - lo).checked_sub(first) {
        v["decisive"] = k.into();
    }
    v["around"] = "decisive".into();
    v["after"] = (n - hi).into();
    v
}

fn started(s: CiState) -> bool {
    !matches!(s, CiState::Pending | CiState::Blocked | CiState::Skipped)
}

fn not_found_or(st: reqwest::StatusCode, what: &str) -> LogError {
    if st == reqwest::StatusCode::NOT_FOUND {
        LogError::NotFound(what.into())
    } else {
        LogError::Upstream(format!("{what}: HTTP {st}"))
    }
}

/// GitHub prefixes every line with `2026-11-11T12:00:00.1234567Z `.
fn strip_gh_time(l: &str) -> &str {
    let b = l.as_bytes();
    if b.len() > 28
        && b[4] == b'-'
        && b[10] == b'T'
        && let Some(sp) = l[..36.min(l.len())].find("Z ")
    {
        return &l[sp + 2..];
    }
    l
}

/// Clean, redact and bound raw tail lines (`raw` may hold one more line than `tail`,
/// which says the log goes on before them). `first`: the index in `raw` of the first
/// line kept.
pub fn shape(raw: Vec<String>, tail: usize) -> Value {
    let mut truncated = raw.len() > tail;
    let from = raw.len().saturating_sub(tail);
    let mut pem = false;
    let mut lines: Vec<String> = Vec::with_capacity(raw.len() - from);
    for l in &raw[from..] {
        let l = clean(l);
        let (l, in_pem) = redact_line(&l, pem);
        pem = in_pem;
        let (l, cut) = cut(&l);
        truncated |= cut;
        lines.push(l);
    }
    // ≤ 64 KB: keep the newest lines.
    let mut bytes = 0usize;
    let mut keep = lines.len();
    for (i, l) in lines.iter().enumerate().rev() {
        if bytes + l.len() + 1 > BYTES_MAX {
            break;
        }
        bytes += l.len() + 1;
        keep = i;
    }
    if keep > 0 {
        truncated = true;
        lines.drain(..keep);
    }
    json!({"lines": lines, "truncated": truncated, "bytes": bytes, "first": from + keep})
}

fn clean(l: &str) -> String {
    let l = l.trim_end_matches(['\r', '\n']);
    let l = match l.rfind('\r') {
        Some(p) => &l[p + 1..],
        None => l,
    };
    crate::signature::strip_ansi(l).trim_end().to_string()
}

fn cut(l: &str) -> (String, bool) {
    if l.chars().count() <= LINE_MAX {
        return (l.to_string(), false);
    }
    let end = l
        .char_indices()
        .nth(LINE_MAX)
        .map(|(i, _)| i)
        .unwrap_or(l.len());
    (format!("{}…", &l[..end]), true)
}

// ---------------------------------------------------------------------------- redaction

const R: &str = "[redacted]";

/// Key names whose value is a secret (`key=v`, `key: v`, `"key": "v"`, `--key v`).
const SECRET_KEYS: &[&str] = &[
    "token",
    "secret",
    "passw",
    "pwd",
    "apikey",
    "api_key",
    "api-key",
    "accesskey",
    "access_key",
    "access-key",
    "privatekey",
    "private_key",
    "private-key",
    "credential",
    "auth_key",
    "client_key",
    "session_key",
    "dsn",
    "database_url",
    "connection_string",
];

/// Key names that are secrets only as a whole (`sig=` of a signed URL).
const SECRET_KEYS_EXACT: &[&str] = &[
    "sig",
    "signature",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
];

/// Token prefixes (gitleaks-style), with the least length of what follows.
const PREFIXES: &[(&str, usize)] = &[
    ("github_pat_", 20),
    ("ghp_", 20),
    ("gho_", 20),
    ("ghu_", 20),
    ("ghs_", 20),
    ("ghr_", 20),
    ("glpat-", 16),
    ("xoxb-", 10),
    ("xoxp-", 10),
    ("xoxa-", 10),
    ("xoxr-", 10),
    ("xoxe-", 10),
    ("xapp-", 10),
    ("sk-ant-", 16),
    ("sk-proj-", 16),
    ("sk_live_", 16),
    ("sk_test_", 16),
    ("rk_live_", 16),
    ("sk-", 20),
    ("AKIA", 16),
    ("ASIA", 16),
    ("AIza", 30),
    ("ya29.", 20),
    ("syd_", 16),
    ("sys_", 16),
    ("hg_", 16),
    ("npm_", 30),
    ("pypi-", 30),
    ("dop_v1_", 30),
    ("shpat_", 20),
    ("SG.", 30),
    ("hvs.", 20),
    ("op_", 30),
];

fn tok_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '=')
}

/// Redact one line. `pem`: inside a private key block (all of it is redacted).
pub fn redact_line(l: &str, pem: bool) -> (String, bool) {
    if l.contains("-----BEGIN") && l.contains("PRIVATE KEY") {
        return (R.into(), !l.contains("-----END"));
    }
    if pem {
        return (
            R.into(),
            !(l.contains("-----END") && l.contains("PRIVATE KEY")),
        );
    }
    let mut s = redact_headers(l);
    s = redact_url_creds(&s);
    s = redact_keys(&s);
    s = redact_tokens(&s);
    (s, false)
}

/// `Authorization: …` (all of it) and `Bearer x` / `token x` / `Basic x`.
fn redact_headers(l: &str) -> String {
    let low = l.to_ascii_lowercase();
    if let Some(i) = low.find("authorization") {
        let rest = &l[i + "authorization".len()..];
        let skip = rest
            .find(|c: char| !matches!(c, '"' | '\'' | ':' | '=' | ' '))
            .unwrap_or(rest.len());
        if skip > 0 && skip < rest.len() && rest[..skip].contains([':', '=']) {
            return format!("{}{}{R}", &l[..i + "authorization".len()], &rest[..skip]);
        }
    }
    let mut out = String::with_capacity(l.len());
    let mut rest = l;
    loop {
        let low = rest.to_ascii_lowercase();
        let hit = ["bearer ", "basic "]
            .iter()
            .filter_map(|k| low.find(k).map(|i| (i, k.len())))
            .filter(|(i, _)| *i == 0 || !rest.as_bytes()[i - 1].is_ascii_alphanumeric())
            .min();
        let Some((i, n)) = hit else {
            out.push_str(rest);
            return out;
        };
        let after = &rest[i + n..];
        let end = after.find(|c: char| !tok_char(c)).unwrap_or(after.len());
        out.push_str(&rest[..i + n]);
        if end >= 8 {
            out.push_str(R);
        } else {
            out.push_str(&after[..end]);
        }
        rest = &after[end..];
    }
}

/// `scheme://user:pass@host` and `scheme://<long token>@host`.
fn redact_url_creds(l: &str) -> String {
    let mut out = String::with_capacity(l.len());
    let mut rest = l;
    while let Some(i) = rest.find("://") {
        out.push_str(&rest[..i + 3]);
        let after = &rest[i + 3..];
        let host_end = after
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '"' | '\'' | '>' | ')'))
            .unwrap_or(after.len());
        let auth = &after[..host_end];
        match auth.rfind('@') {
            Some(at) if auth[..at].contains(':') || at >= 20 => {
                out.push_str(R);
                rest = &after[at..];
            }
            _ => rest = after,
        }
    }
    out.push_str(rest);
    out
}

/// The value after a secret-looking key.
fn redact_keys(l: &str) -> String {
    let b = l.as_bytes();
    let mut out = String::with_capacity(l.len());
    let mut last = 0;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        // A separator after a key: `=`, `:` (not `://`), or a space after `--key`.
        let sep = c == b'=' || (c == b':' && !l[i..].starts_with("://"));
        if !sep {
            i += 1;
            continue;
        }
        // The key before it (skipping a closing quote).
        let mut k_end = i;
        while k_end > 0 && matches!(b[k_end - 1], b'"' | b'\'' | b' ') {
            k_end -= 1;
        }
        let mut k_start = k_end;
        while k_start > 0
            && (b[k_start - 1].is_ascii_alphanumeric()
                || matches!(b[k_start - 1], b'_' | b'-' | b'.'))
        {
            k_start -= 1;
        }
        let key = l[k_start..k_end].to_ascii_lowercase();
        // `PWD` / `OLDPWD` are the shell's working directories.
        let secret = !key.is_empty()
            && !matches!(key.as_str(), "pwd" | "oldpwd")
            && (SECRET_KEYS.iter().any(|k| key.contains(k))
                || SECRET_KEYS_EXACT.contains(&key.as_str()));
        if !secret {
            i += 1;
            continue;
        }
        // The value: skip spaces and an opening quote, up to the closing quote / space.
        let mut v = i + 1;
        while v < b.len() && b[v] == b' ' {
            v += 1;
        }
        let quote = if v < b.len() && matches!(b[v], b'"' | b'\'') {
            v += 1;
            Some(b[v - 1])
        } else {
            None
        };
        let mut e = v;
        while e < b.len() {
            let ch = b[e];
            let stop = match quote {
                Some(q) => ch == q,
                None => {
                    ch == b' '
                        || ch == b','
                        || ch == b';'
                        || ch == b'&'
                        || ch == b'"'
                        || ch == b'\''
                        || ch == b')'
                        || ch == b'}'
                }
            };
            if stop {
                break;
            }
            e += 1;
        }
        // Not a value: empty, a placeholder, or a word like `true` / `null`.
        let val = &l[v..e];
        // Also not a value: a variable reference (`$X`, `${{ … }}`, `%X%`), a list /
        // object of names (`[…]`), another key (`x:`), punctuation.
        let trivial = val.is_empty()
            || val.starts_with("***")
            || val.starts_with(R)
            || val.starts_with(['$', '%', '[', '{', '(', '<'])
            || val.ends_with(':')
            || val.chars().all(|c| !c.is_ascii_alphanumeric())
            // A secret reference (`file:///…`, `env://X`, `op://…`), not its value.
            || ["file:", "env:", "cmd:", "op://", "vault://"]
                .iter()
                .any(|p| val.starts_with(p))
            // A GraphQL type (`Secret!`, `String!`: Dagger's call traces).
            || (val.ends_with('!')
                && val.starts_with(|c: char| c.is_ascii_uppercase())
                && val[..val.len() - 1].chars().all(|c| c.is_ascii_alphabetic()))
            || matches!(
                val.to_ascii_lowercase().as_str(),
                "true"
                    | "false"
                    | "null"
                    | "none"
                    | "nil"
                    | "yes"
                    | "no"
                    | "required"
                    | "missing"
                    | "unset"
                    | "set"
                    | "inherit"
            )
            || val.chars().all(|c| c.is_ascii_digit());
        if !trivial {
            out.push_str(&l[last..v]);
            out.push_str(R);
            last = e;
        }
        i = e.max(i + 1);
    }
    out.push_str(&l[last..]);
    out
}

/// Known token shapes anywhere, JWTs, and long high-entropy strings.
fn redact_tokens(l: &str) -> String {
    let mut out = String::with_capacity(l.len());
    let mut last = 0;
    let mut it = l.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if !tok_char(c) {
            continue;
        }
        // A maximal token run starting at i.
        let mut end = i + c.len_utf8();
        while let Some(&(j, d)) = it.peek() {
            if !tok_char(d) {
                break;
            }
            end = j + d.len_utf8();
            it.next();
        }
        let t = &l[i..end];
        if secret_token(t) {
            out.push_str(&l[last..i]);
            out.push_str(R);
            last = end;
        } else if let Some(p) = prefixed_inside(t) {
            // A token glued to text before it (`x=ghp_…` handled above; `(ghp_…`).
            out.push_str(&l[last..i + p]);
            out.push_str(R);
            last = end;
        }
    }
    out.push_str(&l[last..]);
    out
}

fn prefix_hit(t: &str) -> bool {
    PREFIXES.iter().any(|(p, n)| {
        t.starts_with(p)
            && t.len() >= p.len() + n
            && t[p.len()..]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    })
}

/// A prefixed token starting inside a token run after `/`, `=`, `.` (`url/ghp_…`).
fn prefixed_inside(t: &str) -> Option<usize> {
    t.char_indices()
        .filter(|(_, c)| matches!(c, '/' | '=' | '+'))
        .map(|(i, _)| i + 1)
        .find(|&i| i < t.len() && prefix_hit(&t[i..]))
}

fn secret_token(t: &str) -> bool {
    let t = t.trim_matches(|c: char| matches!(c, '.' | '-' | '/' | '='));
    if prefix_hit(t) {
        return true;
    }
    // A JWT: three base64url parts, the first a JSON header.
    if t.starts_with("eyJ") && t.matches('.').count() == 2 && t.len() >= 30 {
        return true;
    }
    // Long high-entropy strings, piece by piece (`KEY=<sha>`, paths and URLs are pieces).
    t.split(['=', '/', ':']).any(high_entropy)
}

fn high_entropy(t: &str) -> bool {
    let t = t.trim_matches(|c: char| matches!(c, '.' | '-' | '+'));
    if t.len() < 32 || t.contains("..") {
        return false;
    }
    let (mut up, mut lo, mut dg) = (false, false, false);
    for b in t.bytes() {
        up |= b.is_ascii_uppercase();
        lo |= b.is_ascii_lowercase();
        dg |= b.is_ascii_digit();
    }
    // Hex digests (shas, image digests) and words stay.
    if !(up && lo && dg) {
        return false;
    }
    // Paths and identifiers are words: low entropy per character.
    entropy(t) >= 4.3
}

fn entropy(t: &str) -> f64 {
    let mut n = [0u32; 256];
    for b in t.bytes() {
        n[b as usize] += 1;
    }
    let len = t.len() as f64;
    n.iter()
        .filter(|&&c| c > 0)
        .map(|&c| {
            let p = c as f64 / len;
            -p * p.log2()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(l: &str) -> String {
        redact_line(l, false).0
    }

    /// Fake secrets are spelled with placeholders, so the public tree carries no literal
    /// secret-shaped strings (gitleaks): `<ghp>` a GitHub token, `<bearer>`, `<v>` a value.
    fn fill(s: &str) -> String {
        s.replace(
            "<ghp>",
            &format!("gh{}_{}", "p", "0123456789abcdefghijABCDEFGHIJ"),
        )
        .replace("<bearer>", &["abcdefgh", "ijklmnop"].concat())
        .replace("<v>", &["abc123", "def456"].concat())
    }

    #[test]
    fn secrets_are_redacted() {
        let cases = [
            (
                "Authorization: Bearer <bearer>",
                "Authorization: [redacted]",
            ),
            (
                "curl -H 'authorization: token <ghp>'",
                "curl -H 'authorization: [redacted]",
            ),
            (
                "using Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl",
                "using Bearer [redacted]",
            ),
            ("GITHUB_TOKEN=<ghp>", "GITHUB_TOKEN=[redacted]"),
            (
                "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                "export AWS_SECRET_ACCESS_KEY=[redacted]",
            ),
            ("password: hunter2", "password: [redacted]"),
            ("MYSQL_PWD=hunter2 mysql", "MYSQL_PWD=[redacted] mysql"),
            (
                r#"{"api_key": "<v>", "user": "x"}"#,
                r#"{"api_key": "[redacted]", "user": "x"}"#,
            ),
            (
                "--token=s3cr3tvalue --verbose",
                "--token=[redacted] --verbose",
            ),
            (
                "git clone https://x-access-token:ghs_abcdefghij0123456789ABCD@github.com/o/r",
                "git clone https://[redacted]@github.com/o/r",
            ),
            (
                "postgres://app:pa55word@db.internal:5432/app",
                "postgres://[redacted]@db.internal:5432/app",
            ),
            ("key AKIAIOSFODNN7EXAMPLE used", "key [redacted] used"),
            ("slack xoxb-1234567890-abcdefghij", "slack [redacted]"),
            (
                "found sk-ant-api03-abcdefghijklmnopqrstuv in env",
                "found [redacted] in env",
            ),
            (
                "device syd_0123456789abcdefABCDEF ok",
                "device [redacted] ok",
            ),
            (
                "blob 9fK2LmQ8xZ4vT7pR1sW3yB6nH0jD5gC8aE2uI4oP ok",
                "blob [redacted] ok",
            ),
            (
                "GET https://x.blob.example/a?sv=2021&sig=AbC%2Fdef123&se=1",
                "GET https://x.blob.example/a?sv=2021&sig=[redacted]&se=1",
            ),
            (
                "X-Marketplace-Token: mkt_<v>",
                "X-Marketplace-Token: [redacted]",
            ),
        ];
        for (inp, want) in cases {
            assert_eq!(r(&fill(inp)), want, "{inp}");
        }
    }

    #[test]
    fn ordinary_lines_stay() {
        for l in [
            "error[E0308]: mismatched types",
            "FAILED tests/test_api.py::test_login - AssertionError: 401 != 200",
            "commit 3f1c2a9e8b7d6c5f4a3b2c1d0e9f8a7b6c5d4e3f",
            "image sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
            "src/components/Factory3D/LaneRenderer2.tsx:12:5 - error TS2339",
            "Token count: 1234",
            "tokens: 1234",
            "password: required",
            "npm error code ERESOLVE",
            "https://github.com/couplet-physical-ai/switchyard/actions/runs/123",
            "Step 3/7 : RUN cargo build --release",
            "ok: [host] => {\"changed\": false}",
            // Seen in real CI logs (Dagger, ci-dagger, GitHub):
            "┆ env: [\"CI_REPO=acme/api\", \"CI_COMMIT_SHA=5c6feaf83dc7bf034099731a0c808aef68258178\"]",
            "┆ secretEnv: [\"AWS_ML_ACCESS_KEY_ID\", \"AWS_ML_SECRET_ACCESS_KEY\"]",
            "┆ secrets: [xxh3:9da7642c0cd8f35d, xxh3:e9daa888dab36333]",
            "┆ withEnvVariable CI_DAGGER_NONCE=be3ebd13848aa20d",
            "┆ ┆ secret: Address.secret: Secret!",
            "┆ depCachePassword: Address.secret: Secret!",
            "at Routes (file:///src/frontend/node_modules/react-router/dist/development/chunk-OB3PAWPO.mjs:7195:3)",
            "if [ -z \"${MARKETPLACE_SERVICE_TOKEN:-}\" ]; then",
            "-H \"X-Marketplace-Token: $MARKETPLACE_SERVICE_TOKEN\" \\",
            "Add 'secrets: inherit' to the caller workflow",
            "token: ${{ secrets.GITHUB_TOKEN }}",
            "9   : Address.secret: Secret!",
            "┆ Secret.plaintext: String!",
            "--dep-cache-password=file:///etc/ci/dep-cache",
            "starting GOROOT= GOPATH=/go GOPROXY= PWD=/src/app go list -e",
        ] {
            assert_eq!(r(l), l, "{l}");
        }
    }

    #[test]
    fn private_keys_are_redacted_whole() {
        let pem = ["OPENSSH", "PRIVATE", "KEY-----"].join(" ");
        let lines = [
            format!("-----BEGIN {pem}"),
            "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ".to_string(),
            "QyNTUxOQAAACDx".to_string(),
            format!("-----END {pem}"),
            "after".to_string(),
        ];
        let v = shape(lines.to_vec(), 200);
        assert_eq!(v["lines"], json!([R, R, R, R, "after"]));
    }

    #[test]
    fn tails_are_bounded() {
        let raw: Vec<String> = (0..=200).map(|i| format!("line {i}")).collect();
        let v = shape(raw, 200);
        assert_eq!(v["lines"].as_array().unwrap().len(), 200);
        assert_eq!(v["lines"][0], "line 1");
        assert_eq!(v["truncated"], true);
        let v = shape(vec!["\x1b[31mred\x1b[0m".into(), "a\rb\rdone".into()], 200);
        assert_eq!(v["lines"], json!(["red", "done"]));
        assert_eq!(v["truncated"], false);
        let long = "x".repeat(1000);
        let v = shape(vec![long], 10);
        let l = v["lines"][0].as_str().unwrap();
        assert_eq!(l.chars().count(), LINE_MAX + 1);
        assert!(l.ends_with('…'));
        assert_eq!(v["truncated"], true);
        // 500 lines of 400 chars = 200 KB: cut to ≤ 64 KB, newest kept.
        let raw: Vec<String> = (0..500)
            .map(|i| format!("{i:04} {}", "y".repeat(395)))
            .collect();
        let v = shape(raw, 500);
        let ls = v["lines"].as_array().unwrap();
        assert!(v["bytes"].as_u64().unwrap() <= BYTES_MAX as u64);
        assert!(ls.last().unwrap().as_str().unwrap().starts_with("0499"));
        assert!(ls.len() < 500);
        assert_eq!(v["truncated"], true);
    }

    #[test]
    fn github_timestamps_are_stripped() {
        assert_eq!(
            strip_gh_time("2026-11-11T12:00:00.1234567Z ##[error]boom"),
            "##[error]boom"
        );
        assert_eq!(strip_gh_time("plain"), "plain");
    }
}
