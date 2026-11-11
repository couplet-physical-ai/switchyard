//! Failure signatures (STUB: replaced by the real classifier).

use sha2::{Digest, Sha256};

#[derive(
    serde::Serialize, serde::Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum FailClass {
    Compile,
    Test,
    Lint,
    Typecheck,
    Deps,
    Build,
    Deploy,
    Security,
    Oom,
    Timeout,
    Network,
    Infra,
    Exit,
}

impl FailClass {
    pub fn as_str(self) -> &'static str {
        match self {
            FailClass::Compile => "compile",
            FailClass::Test => "test",
            FailClass::Lint => "lint",
            FailClass::Typecheck => "typecheck",
            FailClass::Deps => "deps",
            FailClass::Build => "build",
            FailClass::Deploy => "deploy",
            FailClass::Security => "security",
            FailClass::Oom => "oom",
            FailClass::Timeout => "timeout",
            FailClass::Network => "network",
            FailClass::Infra => "infra",
            FailClass::Exit => "exit",
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Signature {
    pub class: FailClass,
    pub line: Option<String>,
    pub exit_code: Option<i32>,
}

pub fn decode_wp_log(body: &[u8], max_lines: usize) -> Vec<String> {
    use base64::Engine;
    let Ok(v) = serde_json::from_slice::<Vec<serde_json::Value>>(body) else {
        return Vec::new();
    };
    let start = v.len().saturating_sub(max_lines);
    v[start..]
        .iter()
        .filter_map(|l| l.get("data").and_then(|d| d.as_str()))
        .filter_map(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
        .map(|b| String::from_utf8_lossy(&b).trim_end().to_string())
        .collect()
}

pub fn clean_line(raw: &str) -> String {
    raw.to_string()
}

pub fn normalize(line: &str) -> String {
    line.chars().take(160).collect()
}

pub fn fold_step(name: &str) -> String {
    let t = name.trim_end_matches(|c: char| c.is_ascii_digit());
    if t.len() < name.len() && (t.ends_with('-') || t.ends_with('_')) {
        format!("{t}#")
    } else {
        name.to_string()
    }
}

pub fn extract(workflow: &str, step: &str, exit_code: Option<i32>, _log: &[String]) -> Signature {
    let n = format!("{workflow} {step}").to_ascii_lowercase();
    let class = if exit_code == Some(137) {
        FailClass::Oom
    } else if n.contains("deploy") {
        FailClass::Deploy
    } else if n.contains("lint") || n.contains("fmt") || n.contains("clippy") {
        FailClass::Lint
    } else if n.contains("test") {
        FailClass::Test
    } else if n.contains("security") || n.contains("gitleaks") {
        FailClass::Security
    } else if n.contains("build") {
        FailClass::Build
    } else {
        FailClass::Exit
    };
    Signature {
        class,
        line: None,
        exit_code,
    }
}

pub fn key(step: &str, sig: &Signature) -> (String, String) {
    let mut k = format!("{} · {}", fold_step(step), sig.class.as_str());
    if let Some(l) = &sig.line {
        k.push_str(" · ");
        k.push_str(l);
    }
    let h = Sha256::digest(k.as_bytes());
    let id: String = h.iter().take(6).map(|b| format!("{b:02x}")).collect();
    (k, format!("f:{id}"))
}
