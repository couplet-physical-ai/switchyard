//! Deep links: every URL a client opens is built here, from configured bases, so the
//! client never hardcodes a host. Bases come from the environment (`GITHUB_WEB_URL`,
//! `WOODPECKER_PUBLIC_URL`, `CICD_URL`, `CICD_ENGINE_HOST`) and are reported in
//! `meta.links`.

use std::sync::OnceLock;

use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Bases {
    /// GitHub web (`https://github.com`).
    pub github: String,
    /// The Woodpecker web UI.
    pub woodpecker: String,
    /// Roadrunner (= the Woodpecker web UI; the name clients show).
    pub roadrunner: String,
    /// The Roadrunner console (cicd).
    pub cicd: String,
    /// The machine the console's `/engine` page shows (`Engine.host`).
    #[serde(skip)]
    pub engine_host: String,
}

impl Default for Bases {
    fn default() -> Bases {
        Bases {
            github: "https://github.com".into(),
            woodpecker: "https://ci.dev.example.com".into(),
            roadrunner: "https://ci.dev.example.com".into(),
            cicd: "https://cicd.apps.example.com".into(),
            engine_host: "VM 153".into(),
        }
    }
}

static BASES: OnceLock<Bases> = OnceLock::new();

/// Set the bases once, at boot (later calls are ignored).
pub fn set(b: Bases) {
    let trim = |s: String| s.trim_end_matches('/').to_string();
    let woodpecker = trim(b.woodpecker);
    let _ = BASES.set(Bases {
        github: trim(b.github),
        roadrunner: woodpecker.clone(),
        woodpecker,
        cicd: trim(b.cicd),
        engine_host: b.engine_host,
    });
}

pub fn bases() -> &'static Bases {
    BASES.get_or_init(Bases::default)
}

/// Percent-encode one URL path segment (or a git ref, keeping `/`).
fn enc(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------- GitHub

pub fn gh_repo(repo: &str) -> String {
    format!("{}/{repo}", bases().github)
}

pub fn gh_commit(repo: &str, sha: &str) -> String {
    format!("{}/{repo}/commit/{sha}", bases().github)
}

pub fn gh_branch(repo: &str, branch: &str) -> String {
    format!("{}/{repo}/tree/{}", bases().github, enc(branch, true))
}

pub fn gh_release(repo: &str, tag: &str) -> String {
    format!("{}/{repo}/releases/tag/{}", bases().github, enc(tag, true))
}

pub fn gh_pr(repo: &str, number: u64) -> String {
    format!("{}/{repo}/pull/{number}", bases().github)
}

pub fn gh_pr_checks(repo: &str, number: u64) -> String {
    format!("{}/checks", gh_pr(repo, number))
}

pub fn gh_run(repo: &str, run: u64) -> String {
    format!("{}/{repo}/actions/runs/{run}", bases().github)
}

/// The id of a GitHub Actions job page (`…/actions/runs/{run}/job/{id}`).
pub fn gh_job_id(url: &str) -> Option<u64> {
    let i = url.find("/job/")? + "/job/".len();
    url[i..]
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

/// A job page opened on one of its steps (1-based, GitHub's numbering).
pub fn gh_job_step(job_url: &str, step: u32) -> String {
    let base = job_url.split('#').next().unwrap_or(job_url);
    format!("{base}#step:{step}:1")
}

// ---------------------------------------------------------------- Roadrunner

/// The Roadrunner console's page for one run.
pub fn rr_run(repo_id: u64, number: u64) -> String {
    format!("{}/pipelines/{repo_id}/{number}", bases().cicd)
}

pub fn rr_repo(repo_id: u64) -> String {
    format!("{}/repos/{repo_id}", bases().cicd)
}

/// A machine's page: the console's engine page for the machine it shows (its Dagger
/// engine and the agents on it), else Woodpecker's agents (it has no page per agent).
pub fn engine_page(host: Option<&str>) -> String {
    if host.is_some_and(|h| !h.is_empty() && h == bases().engine_host) {
        format!("{}/engine", bases().cicd)
    } else {
        wp_agents()
    }
}

/// GitHub Actions runner scale sets.
pub fn rr_runners() -> String {
    format!("{}/runners", bases().cicd)
}

pub fn wp_run(repo_id: u64, number: u64) -> String {
    format!("{}/repos/{repo_id}/pipeline/{number}", bases().woodpecker)
}

/// Roadrunner's page for one step (its log): Woodpecker selects a step by its `pid`.
pub fn wp_step(repo_id: u64, number: u64, pid: u64) -> String {
    format!("{}/{pid}", wp_run(repo_id, number))
}

pub fn wp_repo(repo_id: u64) -> String {
    format!("{}/repos/{repo_id}", bases().woodpecker)
}

pub fn wp_agents() -> String {
    format!("{}/admin/agents", bases().woodpecker)
}

pub fn wp_queue() -> String {
    format!("{}/admin/queue", bases().woodpecker)
}

/// The tag of a git ref (`refs/tags/v1.2` → `v1.2`).
pub fn tag_of(git_ref: &str) -> Option<&str> {
    git_ref.strip_prefix("refs/tags/").filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(
            gh_commit("acme/api", "abc"),
            "https://github.com/acme/api/commit/abc"
        );
        assert_eq!(
            gh_branch("acme/api", "feat/x y#1"),
            "https://github.com/acme/api/tree/feat/x%20y%231"
        );
        assert_eq!(
            gh_release("acme/api", "v1.2.0"),
            "https://github.com/acme/api/releases/tag/v1.2.0"
        );
        assert_eq!(
            gh_pr_checks("acme/api", 7),
            "https://github.com/acme/api/pull/7/checks"
        );
        assert_eq!(
            wp_step(413, 135, 4),
            "https://ci.dev.example.com/repos/413/pipeline/135/4"
        );
        let job = "https://github.com/acme/api/actions/runs/1/job/22";
        assert_eq!(gh_job_id(job), Some(22));
        assert_eq!(gh_job_id(&gh_job_step(job, 3)), Some(22));
        assert_eq!(gh_job_step(job, 3), format!("{job}#step:3:1"));
        assert_eq!(
            gh_job_step(&gh_job_step(job, 3), 4),
            format!("{job}#step:4:1")
        );
        assert_eq!(
            gh_job_id("https://github.com/acme/api/actions/runs/1"),
            None
        );
        assert_eq!(
            engine_page(Some("VM 153")),
            "https://cicd.apps.example.com/engine"
        );
        assert_eq!(
            engine_page(Some("VM 154")),
            "https://ci.dev.example.com/admin/agents"
        );
        assert_eq!(engine_page(None), "https://ci.dev.example.com/admin/agents");
        assert_eq!(tag_of("refs/tags/v1"), Some("v1"));
        assert_eq!(tag_of("refs/heads/main"), None);
    }
}
