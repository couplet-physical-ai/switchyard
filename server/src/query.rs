//! Read-side queries over the mirrored wire state: ⌘K search, commit
//! journeys and PR details. Pure functions (tested on fixtures).

use serde::Serialize;
use serde_json::{Value, json};

use crate::model::Kind;
use crate::wire::WireState;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Hit {
    pub kind: &'static str,
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub score: f32,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn n(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or(0)
}

fn is_hex(q: &str) -> bool {
    q.len() >= 4 && q.chars().all(|c| c.is_ascii_hexdigit())
}

/// Search repos, apps, PRs, commits and pipelines. `limit` ≤ 50.
pub fn search(w: &WireState, q: &str, limit: usize) -> Vec<Hit> {
    let q = q.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let toks: Vec<&str> = q.split_whitespace().collect();
    let mut hits: Vec<Hit> = Vec::new();
    let now = w.at;
    let score_text = |id: &str, title: &str| -> Option<f32> {
        let idl = id.to_lowercase();
        let tl = title.to_lowercase();
        if idl == q {
            return Some(100.0);
        }
        let name = idl.rsplit('/').next().unwrap_or(&idl);
        if name == q {
            return Some(95.0);
        }
        if name.starts_with(&q) || idl.starts_with(&q) {
            return Some(80.0 - (name.len() as f32 - q.len() as f32).max(0.0) * 0.5);
        }
        if toks.iter().all(|t| idl.contains(t) || tl.contains(t)) {
            let pos = idl.find(toks[0]).or_else(|| tl.find(toks[0])).unwrap_or(40) as f32;
            return Some(50.0 - pos.min(40.0) * 0.25);
        }
        None
    };
    let recency = |at: i64| -> f32 {
        if at <= 0 || now <= 0 {
            return 0.0;
        }
        let h = ((now - at).max(0) as f32) / 3_600_000.0;
        (10.0 - h).max(0.0) * 0.5
    };
    for (id, v) in w.iter(Kind::Repo) {
        if let Some(sc) = score_text(id, "") {
            let main = v.get("main").cloned().unwrap_or(Value::Null);
            hits.push(Hit {
                kind: "repo",
                id: id.clone(),
                title: id.clone(),
                subtitle: format!("main · {} · {}", s(&main, "state"), s(v, "lane")),
                score: sc + 6.0 + v.get("heat").and_then(Value::as_f64).unwrap_or(0.0) as f32 * 4.0,
            });
        }
    }
    for (id, v) in w.iter(Kind::App) {
        if let Some(sc) = score_text(id, s(v, "url")) {
            hits.push(Hit {
                kind: "app",
                id: id.clone(),
                title: id.clone(),
                subtitle: format!("{} · {}", s(v, "health"), s(v, "url")),
                score: sc + 5.0,
            });
        }
    }
    for (id, v) in w.iter(Kind::Pr) {
        let title = s(v, "title");
        let num = format!("#{}", n(v, "number"));
        let sc = if q == num || q == n(v, "number").to_string() {
            Some(70.0)
        } else {
            score_text(id, title)
        };
        if let Some(sc) = sc {
            hits.push(Hit {
                kind: "pr",
                id: id.clone(),
                title: title.to_string(),
                subtitle: format!("{} · {} · {}", id, s(v, "phase"), s(v, "author")),
                score: sc + 3.0 + recency(n(v, "updated")),
            });
        }
    }
    for (id, v) in w.iter(Kind::Commit) {
        let sha = s(v, "sha");
        let sc = if is_hex(&q) && sha.starts_with(&q) {
            Some(90.0)
        } else {
            score_text(id, s(v, "title")).map(|x| x * 0.8)
        };
        if let Some(sc) = sc {
            hits.push(Hit {
                kind: "commit",
                id: id.clone(),
                title: s(v, "title").to_string(),
                subtitle: format!(
                    "{} · {} · {}",
                    s(v, "repo"),
                    &sha[..sha.len().min(7)],
                    s(v, "stage")
                ),
                score: sc + 2.0 + recency(n(v, "at")),
            });
        }
    }
    for (id, v) in w.iter(Kind::Pipeline) {
        let label = format!("{} #{}", s(v, "repo"), n(v, "number"));
        if let Some(sc) = score_text(&label, s(v, "branch")) {
            hits.push(Hit {
                kind: "pipeline",
                id: id.clone(),
                title: label,
                subtitle: format!("{} · {} · {}", s(v, "state"), s(v, "event"), s(v, "branch")),
                score: sc * 0.7 + 1.0 + recency(n(v, "created")),
            });
        }
    }
    hits.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
    hits.truncate(limit.clamp(1, 50));
    hits
}

/// A commit's end-to-end journey. `extra_pipelines` lets the live server add
/// retained pipelines that are no longer in the visible window.
pub fn journey(
    w: &WireState,
    repo: &str,
    sha: &str,
    extra_pipelines: Vec<Value>,
    spans: Option<Value>,
) -> Option<Value> {
    let sha_full = resolve_sha(w, repo, sha).unwrap_or_else(|| sha.to_string());
    let cid = format!("{repo}@{sha_full}");
    let commit = w.get(Kind::Commit, &cid).cloned();
    let repo_v = w.get(Kind::Repo, repo).cloned();
    let mut pipelines: Vec<Value> = w
        .iter(Kind::Pipeline)
        .filter(|(_, p)| s(p, "repo") == repo && s(p, "sha") == sha_full)
        .map(|(_, p)| p.clone())
        .collect();
    for p in extra_pipelines {
        let id = s(&p, "id").to_string();
        if !pipelines.iter().any(|x| s(x, "id") == id) {
            pipelines.push(p);
        }
    }
    pipelines.sort_by_key(|p| (n(p, "created"), n(p, "number")));
    let prs: Vec<Value> = w
        .iter(Kind::Pr)
        .filter(|(_, p)| {
            s(p, "repo") == repo && (s(p, "head_sha") == sha_full || s(p, "merge_sha") == sha_full)
        })
        .map(|(_, p)| p.clone())
        .collect();
    let deploys: Vec<Value> = w
        .iter(Kind::Deploy)
        .filter(|(_, d)| s(d, "repo") == repo && s(d, "sha") == sha_full)
        .map(|(_, d)| d.clone())
        .collect();
    let app_id = repo_v
        .as_ref()
        .map(|r| s(r, "app").to_string())
        .filter(|a| !a.is_empty());
    let app = app_id.and_then(|a| w.get(Kind::App, &a).cloned());
    if commit.is_none() && pipelines.is_empty() && repo_v.is_none() {
        return None;
    }
    // Milestones, oldest first.
    let mut tl: Vec<(i64, String, String)> = Vec::new();
    if let Some(c) = &commit {
        tl.push((
            n(c, "at"),
            "push".into(),
            format!("pushed to {}", s(c, "branch")),
        ));
    }
    for p in &pipelines {
        let lbl = format!(
            "{} #{}",
            if s(p, "lane") == "gha" {
                "actions"
            } else {
                "roadrunner"
            },
            n(p, "number")
        );
        tl.push((n(p, "created"), "enqueue".into(), format!("{lbl} queued")));
        if let Some(st) = p.get("started").and_then(Value::as_i64) {
            tl.push((st, "start".into(), format!("{lbl} started")));
        }
        if let Some(f) = p.get("finished").and_then(Value::as_i64) {
            tl.push((f, "finish".into(), format!("{lbl} {}", s(p, "state"))));
        }
    }
    for pr in &prs {
        if let Some(m) = pr.get("merged_at").and_then(Value::as_i64) {
            tl.push((m, "merge".into(), format!("merged #{}", n(pr, "number"))));
        }
    }
    for d in &deploys {
        tl.push((
            n(d, "started"),
            "deploy".into(),
            format!("deploy to {} ({})", s(d, "app"), s(d, "via")),
        ));
        if let Some(f) = d.get("finished").and_then(Value::as_i64) {
            tl.push((f, "deployed".into(), format!("deploy {}", s(d, "state"))));
        }
    }
    if let Some(a) = &app
        && n(a, "checked") > 0
    {
        tl.push((
            n(a, "checked"),
            "health".into(),
            format!("{} is {}", s(a, "id"), s(a, "health")),
        ));
    }
    tl.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let timeline: Vec<Value> = tl
        .into_iter()
        .map(|(at, k, l)| json!({"at": at, "k": k, "label": l}))
        .collect();
    Some(json!({
        "id": cid,
        "repo": repo,
        "sha": sha_full,
        "commit": commit,
        "repo_state": repo_v,
        "pipelines": pipelines,
        "prs": prs,
        "deploys": deploys,
        "app": app,
        "spans": spans.unwrap_or(Value::Array(vec![])),
        "timeline": timeline,
    }))
}

/// Expand an abbreviated sha against what we know.
pub fn resolve_sha(w: &WireState, repo: &str, sha: &str) -> Option<String> {
    if sha.len() >= 40 {
        return Some(sha.to_string());
    }
    let prefix = format!("{repo}@{sha}");
    if let Some((id, _)) = w.iter(Kind::Commit).find(|(id, _)| id.starts_with(&prefix)) {
        return id.split_once('@').map(|(_, s)| s.to_string());
    }
    if let Some(r) = w.get(Kind::Repo, repo)
        && let Some(d) = r
            .get("main")
            .and_then(|m| m.get("recent"))
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|d| s(d, "sha").starts_with(sha)))
    {
        return Some(s(d, "sha").to_string());
    }
    w.iter(Kind::Pipeline)
        .find(|(_, p)| s(p, "repo") == repo && s(p, "sha").starts_with(sha))
        .map(|(_, p)| s(p, "sha").to_string())
}

pub fn pr_detail(w: &WireState, repo: &str, number: u64) -> Option<Value> {
    let id = format!("{repo}#{number}");
    let pr = w.get(Kind::Pr, &id)?.clone();
    let head = s(&pr, "head_sha").to_string();
    let commits: Vec<Value> = w
        .iter(Kind::Commit)
        .filter(|(_, c)| {
            s(c, "repo") == repo && c.get("pr").and_then(Value::as_u64) == Some(number)
        })
        .map(|(_, c)| c.clone())
        .collect();
    let mut pipelines: Vec<Value> = w
        .iter(Kind::Pipeline)
        .filter(|(_, p)| {
            s(p, "repo") == repo
                && (p.get("pr").and_then(Value::as_u64) == Some(number) || s(p, "sha") == head)
        })
        .map(|(_, p)| p.clone())
        .collect();
    pipelines.sort_by_key(|p| (n(p, "created"), n(p, "number")));
    let merge = s(&pr, "merge_sha").to_string();
    let deploys: Vec<Value> = w
        .iter(Kind::Deploy)
        .filter(|(_, d)| s(d, "repo") == repo && !merge.is_empty() && s(d, "sha") == merge)
        .map(|(_, d)| d.clone())
        .collect();
    Some(json!({
        "pr": pr,
        "repo_state": w.get(Kind::Repo, repo),
        "commits": commits,
        "pipelines": pipelines,
        "deploys": deploys,
    }))
}
