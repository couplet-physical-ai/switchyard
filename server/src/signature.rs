//! Failure signatures: a short, stable, readable "why did this step fail" key.
//!
//! When a CI step fails, [`extract`] reads its log (decoded by [`decode_wp_log`], cleaned by
//! [`clean_line`]) and picks the decisive line: the root cause a human would point at, not the
//! wrappers around it (`recipe failed`, `Error: exit code: 1`, Dagger span statuses). The line
//! is [`normalize`]d so the same cause gives the same text across repos and runs, and [`key`]
//! turns step + class + line into a grouping key and a short id, so failures cluster.
//!
//! Everything here is pure and allocation-light: a 3,000-line log takes well under 5 ms.

use std::borrow::Cow;

use base64::Engine as _;
use sha2::{Digest, Sha256};

/// The broad cause of a failed step.
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

/// The signature of one failed step.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Signature {
    pub class: FailClass,
    /// The decisive log line, normalized; `None` when the log gave no clear cause.
    pub line: Option<String>,
    pub exit_code: Option<i32>,
}

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct WpLine<'a> {
    #[serde(borrow, default)]
    data: Option<Cow<'a, str>>,
}

/// Decode a Woodpecker v3 log API body (`GET /api/repos/{id}/logs/{number}/{step_id}`: a JSON
/// array of {id, step_id, time, line, data (base64, may be null), type}) into text lines.
/// Use only the LAST `max_lines` lines (logs can be 500 KB).
pub fn decode_wp_log(body: &[u8], max_lines: usize) -> Vec<String> {
    if max_lines == 0 {
        return Vec::new();
    }
    let entries: Vec<WpLine<'_>> = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            // Not the JSON shape: treat the body as plain text.
            let text = String::from_utf8_lossy(body);
            let all: Vec<&str> = text.lines().collect();
            let from = all.len().saturating_sub(max_lines);
            return all[from..].iter().map(|s| s.to_string()).collect();
        }
    };
    let engine = base64::engine::general_purpose::STANDARD;
    let lenient = base64::engine::general_purpose::STANDARD_NO_PAD;
    let mut rev: Vec<String> = Vec::with_capacity(max_lines.min(entries.len()));
    'outer: for e in entries.iter().rev() {
        let Some(data) = e.data.as_deref() else {
            rev.push(String::new());
            if rev.len() >= max_lines {
                break;
            }
            continue;
        };
        let bytes = match engine.decode(data) {
            Ok(b) => b,
            Err(_) => match lenient.decode(data.trim_end_matches('=')) {
                Ok(b) => b,
                Err(_) => continue,
            },
        };
        let text = String::from_utf8_lossy(&bytes);
        let text = text.strip_suffix('\n').unwrap_or(&text);
        for part in text.rsplit('\n') {
            rev.push(part.to_string());
            if rev.len() >= max_lines {
                break 'outer;
            }
        }
    }
    rev.reverse();
    rev
}

// ---------------------------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------------------------

/// Strip ANSI escapes, \r progress overwrites, and Dagger TUI prefixes. Dagger lines look
/// like `73  : ┆ [19m54s] | error: ...`, `11  : Ci.rust ERROR [21m14s]`, or `┆ Container.withExec ERROR`.
/// Keep the payload after the last "| " of such a prefix.
pub fn clean_line(raw: &str) -> String {
    // Progress overwrites: what is visible is the text after the last carriage return.
    let raw = raw.trim_end_matches(['\r', '\n']);
    let raw = match raw.rfind('\r') {
        Some(p) => &raw[p + 1..],
        None => raw,
    };
    let s = strip_ansi(raw);
    let rest = strip_dagger_prefix(&s);
    rest.trim_end().to_string()
}

fn strip_ansi(s: &str) -> Cow<'_, str> {
    if !s
        .bytes()
        .any(|b| b == 0x1b || (b < 0x20 && b != b'\t') || b == 0x7f)
    {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            match it.peek().copied() {
                Some('[') => {
                    it.next();
                    // CSI: parameters until a final byte in 0x40..=0x7e.
                    for d in it.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    it.next();
                    // OSC: until BEL or ESC \.
                    while let Some(d) = it.next() {
                        if d == '\u{7}' {
                            break;
                        }
                        if d == '\u{1b}' {
                            if it.peek() == Some(&'\\') {
                                it.next();
                            }
                            break;
                        }
                    }
                }
                Some(_) => {
                    it.next();
                }
                None => {}
            }
        } else if c == '\t' {
            out.push(' ');
        } else if (c as u32) < 0x20 || c == '\u{7f}' {
            // other control characters: drop
        } else {
            out.push(c);
        }
    }
    Cow::Owned(out)
}

fn strip_dagger_prefix(s: &str) -> &str {
    let mut rest = s.trim_start();
    let mut dagger = false;
    // "73  : " — a span number padded to at least four columns, then ": ".
    let b = rest.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i > 0 && i <= 6 {
        let mut j = i;
        while j < b.len() && b[j] == b' ' {
            j += 1;
        }
        if j >= 4 && j < b.len() && b[j] == b':' && (j + 1 == b.len() || b[j + 1] == b' ') {
            rest = &rest[(j + 1).min(rest.len())..];
            dagger = true;
        }
    }
    // Nesting bars "┆ ".
    loop {
        let r = rest.trim_start();
        if let Some(r2) = r.strip_prefix('┆') {
            rest = r2;
            dagger = true;
        } else {
            break;
        }
    }
    if !dagger {
        return s;
    }
    rest = rest.trim_start();
    // Optional "[duration] | " or "| " before the payload.
    if rest.starts_with('[')
        && let Some(close) = rest.find(']')
        && close <= 16
    {
        let after = &rest[close + 1..];
        let after_t = after.trim_start();
        if let Some(p) = after_t.strip_prefix('|') {
            return p.strip_prefix(' ').unwrap_or(p);
        }
    }
    if let Some(p) = rest.strip_prefix('|') {
        return p.strip_prefix(' ').unwrap_or(p);
    }
    rest
}

// ---------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------

const MAX_LINE: usize = 160;

/// Mask volatile parts so the same cause gives the same text across repos and runs:
/// hex hashes/shas (≥7 hex chars) → `…`, numbers → `N` (but keep exit/status codes like
/// "exit code 101", HTTP 5xx/4xx codes, and error codes like E0308 / TS2345), durations,
/// timestamps, UUIDs, absolute paths shortened to their last two components
/// (`/usr/local/cargo/registry/src/x/y/z.rs` → `…/y/z.rs`), quoted identifiers kept, line:col
/// → `:N`, trace ids `[traceparent:…]` removed, whitespace collapsed, at most 160 chars.
pub fn normalize(line: &str) -> String {
    let s = strip_traceparent(line);
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    norm_into(&chars, &mut out, true);
    let out = collapse_line_col(&out);
    let out = out.trim();
    cap(out, MAX_LINE)
}

fn strip_traceparent(s: &str) -> Cow<'_, str> {
    if !s.contains("[traceparent:") {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find("[traceparent:") {
        out.push_str(&rest[..p]);
        match rest[p..].find(']') {
            Some(q) => rest = &rest[p + q + 1..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn cap(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    let trimmed = out.trim_end().len();
    out.truncate(trimmed);
    out.push('…');
    out
}

/// `:N:N` (line:col) → `:N`, repeatedly.
fn collapse_line_col(s: &str) -> String {
    let mut out = s.to_string();
    while out.contains(":N:N") {
        out = out.replace(":N:N", ":N");
    }
    out
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '+' | '@' | '~' | '%')
}

fn is_hex_run(run: &[char]) -> bool {
    run.len() >= 7
        && run.iter().all(|c| c.is_ascii_hexdigit())
        && run.iter().any(|c| c.is_ascii_digit())
        && run.iter().any(|c| c.is_ascii_alphabetic())
}

fn match_uuid(chars: &[char], i: usize) -> bool {
    if i + 36 > chars.len() {
        return false;
    }
    for (k, c) in chars[i..i + 36].iter().enumerate() {
        let dash = matches!(k, 8 | 13 | 18 | 23);
        if dash != (*c == '-') || (!dash && !c.is_ascii_hexdigit()) {
            return false;
        }
    }
    chars.get(i + 36).is_none_or(|c| !is_ident(*c))
}

/// `YYYY-MM-DD` with an optional time part. Returns the end index.
fn match_timestamp(chars: &[char], i: usize) -> Option<usize> {
    let d = |k: usize| chars.get(i + k).is_some_and(|c| c.is_ascii_digit());
    let ch = |k: usize, x: char| chars.get(i + k) == Some(&x);
    if !(d(0) && d(1) && d(2) && d(3) && ch(4, '-') && d(5) && d(6) && ch(7, '-') && d(8) && d(9)) {
        return None;
    }
    let mut j = i + 10;
    if matches!(chars.get(j), Some('T') | Some(' ') | Some('_'))
        && chars.get(j + 1).is_some_and(|c| c.is_ascii_digit())
        && chars.get(j + 2).is_some_and(|c| c.is_ascii_digit())
        && matches!(chars.get(j + 3), Some(':') | Some('_'))
    {
        j += 1;
        while j < chars.len()
            && (chars[j].is_ascii_digit() || matches!(chars[j], ':' | '_' | '.' | ','))
        {
            j += 1;
        }
        if chars.get(j) == Some(&'Z') {
            j += 1;
        } else if matches!(chars.get(j), Some('+') | Some('-'))
            && chars.get(j + 1).is_some_and(|c| c.is_ascii_digit())
        {
            j += 1;
            while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == ':') {
                j += 1;
            }
        }
    }
    Some(j)
}

fn is_duration(run: &[char]) -> bool {
    // (\d+(\.\d+)?(ms|us|µs|ns|s|m|h|d))+
    let mut k = 0;
    let mut groups = 0;
    while k < run.len() {
        let start = k;
        while k < run.len() && run[k].is_ascii_digit() {
            k += 1;
        }
        if k == start {
            return false;
        }
        let ustart = k;
        while k < run.len() && run[k].is_ascii_alphabetic() {
            k += 1;
        }
        let unit: String = run[ustart..k].iter().collect();
        if !matches!(
            unit.as_str(),
            "ms" | "us" | "ns" | "s" | "m" | "h" | "d" | "sec" | "min"
        ) {
            return false;
        }
        groups += 1;
    }
    groups > 0
}

/// An error code such as E0308, TS2345, SC2086, F401: 1–4 uppercase letters then digits.
fn is_error_code(run: &[char]) -> bool {
    let letters = run.iter().take_while(|c| c.is_ascii_uppercase()).count();
    (1..=4).contains(&letters)
        && run.len() > letters
        && run[letters..].iter().all(|c| c.is_ascii_digit())
        && run.len() - letters >= 2
}

fn keep_number(out: &str, digits: &[char], after: &[char]) -> bool {
    let tail: String = {
        let t = out.trim_end_matches([' ', ':', '=', '(', '[', '#']);
        let start = t.len().saturating_sub(24);
        let start = (start..=t.len())
            .find(|&p| t.is_char_boundary(p))
            .unwrap_or(t.len());
        t[start..].to_ascii_lowercase()
    };
    const KEEP_AFTER: &[&str] = &[
        "exit code",
        "exit status",
        "exit",
        "exitcode",
        "exit_code",
        "status code",
        "status",
        "code",
        "rc",
        "returncode",
        "signal",
        "errno",
        "http",
        "http/1.1",
        "http/1.0",
        "http/2",
    ];
    if KEEP_AFTER.iter().any(|k| tail.ends_with(k)) {
        return true;
    }
    if digits.len() == 3 && matches!(digits[0], '4' | '5') {
        // HTTP status followed by its reason phrase.
        let next: String = after
            .iter()
            .skip_while(|c| **c == ' ')
            .take_while(|c| c.is_ascii_alphabetic())
            .collect();
        if matches!(
            next.as_str(),
            "Bad"
                | "Not"
                | "Internal"
                | "Service"
                | "Gateway"
                | "Forbidden"
                | "Unauthorized"
                | "Too"
                | "Conflict"
                | "Unprocessable"
                | "Request"
                | "Method"
                | "Precondition"
                | "Payload"
        ) {
            return true;
        }
    }
    false
}

/// Shorten a path to its last two components. `body` has no leading scheme.
fn shorten_path(path: &[char], out: &mut String, url: bool) {
    let s: String = path.iter().collect();
    let trimmed = s.trim_end_matches('/');
    let comps: Vec<&str> = trimmed.split('/').filter(|c| !c.is_empty()).collect();
    let abs = s.starts_with('/');
    if comps.len() > 2 {
        if url {
            out.push('/');
        }
        out.push_str("…/");
        let tail = format!("{}/{}", comps[comps.len() - 2], comps[comps.len() - 1]);
        let tc: Vec<char> = tail.chars().collect();
        norm_into(&tc, out, false);
    } else {
        let tc: Vec<char> = s.chars().collect();
        if abs && comps.is_empty() {
            out.push_str(&s);
        } else {
            norm_into(&tc, out, false);
        }
    }
}

/// The normalizing scanner. With `paths` false, slashes are plain characters (used on the
/// already-shortened tail of a path).
fn norm_into(chars: &[char], out: &mut String, paths: bool) {
    let n = chars.len();
    let mut i = 0;
    while i < n {
        let c = chars[i];
        let prev = if i == 0 { None } else { Some(chars[i - 1]) };
        if c.is_whitespace() {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            i += 1;
            continue;
        }
        // Quoted identifiers are kept verbatim.
        if matches!(c, '`' | '\'' | '"') {
            let lim = (i + 66).min(n);
            if let Some(j) = (i + 1..lim).find(|&j| chars[j] == c) {
                let inner = &chars[i + 1..j];
                let plain = !inner.is_empty()
                    && inner.iter().any(|ch| ch.is_ascii_alphabetic())
                    && inner.iter().all(|ch| !ch.is_whitespace() && *ch != '/')
                    && !has_volatile_run(inner);
                if plain {
                    out.extend(&chars[i..=j]);
                    i = j + 1;
                    continue;
                }
            }
            out.push(c);
            i += 1;
            continue;
        }
        if paths {
            // URLs: scheme://host/path → scheme://host/…/a/b
            if c.is_ascii_alphabetic() && prev.is_none_or(|p| !is_ident(p)) {
                let mut j = i;
                while j < n && chars[j].is_ascii_alphabetic() {
                    j += 1;
                }
                if j + 2 < n && chars[j] == ':' && chars[j + 1] == '/' && chars[j + 2] == '/' {
                    out.extend(&chars[i..j + 3]);
                    let mut k = j + 3;
                    while k < n && chars[k] != '/' && is_url_char(chars[k]) {
                        out.push(chars[k]);
                        k += 1;
                    }
                    let pstart = k;
                    while k < n && is_url_char(chars[k]) && chars[k] != '?' && chars[k] != '#' {
                        k += 1;
                    }
                    if k > pstart {
                        let mut path = &chars[pstart..k];
                        // Trailing punctuation is not part of the path.
                        while let Some((last, rest)) = path.split_last() {
                            if matches!(last, '.' | ',' | ':' | ';') {
                                path = rest;
                            } else {
                                break;
                            }
                        }
                        let end = pstart + path.len();
                        shorten_path(path, out, true);
                        k = end;
                    }
                    // Drop a query string.
                    if k < n && chars[k] == '?' {
                        while k < n && is_url_char(chars[k]) {
                            k += 1;
                        }
                    }
                    i = k;
                    continue;
                }
            }
            // Absolute paths.
            if c == '/'
                && prev.is_none_or(|p| p.is_whitespace() || "([{=:'\"`<,".contains(p))
                && chars
                    .get(i + 1)
                    .is_some_and(|d| is_path_char(*d) && *d != '/')
            {
                let mut j = i;
                while j < n && is_path_char(chars[j]) {
                    j += 1;
                }
                let mut path = &chars[i..j];
                while let Some((last, rest)) = path.split_last() {
                    if matches!(last, '.' | ',') && !rest.is_empty() {
                        path = rest;
                    } else {
                        break;
                    }
                }
                let end = i + path.len();
                shorten_path(path, out, false);
                i = end;
                continue;
            }
        }
        if is_ident(c) && prev.is_none_or(|p| !is_ident(p)) {
            if let Some(end) = match_timestamp(chars, i) {
                out.push_str("<time>");
                i = end;
                continue;
            }
            if match_uuid(chars, i) {
                out.push('…');
                i += 36;
                continue;
            }
            let mut j = i;
            while j < n && is_ident(chars[j]) {
                j += 1;
            }
            let run = &chars[i..j];
            push_run(run, out, &chars[j..]);
            i = j;
            continue;
        }
        out.push(c);
        i += 1;
    }
}

fn is_url_char(c: char) -> bool {
    !c.is_whitespace()
        && !matches!(
            c,
            '"' | '\'' | '`' | '<' | '>' | ')' | '(' | ']' | '[' | '{' | '}' | ','
        )
}

fn has_volatile_run(inner: &[char]) -> bool {
    let mut k = 0;
    while k < inner.len() {
        if inner[k].is_ascii_alphanumeric() {
            let s = k;
            while k < inner.len() && inner[k].is_ascii_alphanumeric() {
                k += 1;
            }
            if is_hex_run(&inner[s..k]) {
                return true;
            }
        } else {
            k += 1;
        }
    }
    false
}

/// Mask one identifier-ish run `[A-Za-z0-9_]+`.
fn push_run(run: &[char], out: &mut String, after: &[char]) {
    // 0x-prefixed addresses.
    if run.len() > 2
        && run[0] == '0'
        && (run[1] == 'x' || run[1] == 'X')
        && run[2..].iter().all(|c| c.is_ascii_hexdigit())
    {
        out.push('…');
        return;
    }
    if is_hex_run(run) {
        out.push('…');
        return;
    }
    if run.iter().all(|c| c.is_ascii_digit()) {
        if keep_number(out, run, after) {
            out.extend(run);
        } else {
            out.push('N');
        }
        return;
    }
    if run[0].is_ascii_digit() {
        if is_duration(run) {
            out.push('N');
            return;
        }
        // Leading digits → N, the rest as an identifier (5MiB → NMiB).
        let d = run.iter().take_while(|c| c.is_ascii_digit()).count();
        out.push('N');
        push_alpha_run(&run[d..], out);
        return;
    }
    if is_error_code(run) {
        out.extend(run);
        return;
    }
    // vX.Y versions.
    if (run[0] == 'v' || run[0] == 'V')
        && run.len() > 1
        && run[1..].iter().all(|c| c.is_ascii_digit())
    {
        out.push(run[0]);
        out.push('N');
        return;
    }
    push_alpha_run(run, out);
}

/// An identifier starting with a letter: digits inside it are part of the name (sha256,
/// python3, x86_64) and are kept, except a separated trailing counter (`kee0` stays).
fn push_alpha_run(run: &[char], out: &mut String) {
    // A long digit tail glued to a name (`build202611091444`) is volatile.
    let digits_tail = run.iter().rev().take_while(|c| c.is_ascii_digit()).count();
    if digits_tail >= 6 {
        out.extend(&run[..run.len() - digits_tail]);
        out.push('N');
    } else {
        out.extend(run);
    }
}

// ---------------------------------------------------------------------------------------------
// Step names
// ---------------------------------------------------------------------------------------------

/// Fold numbered shards so they cluster: "test-web-3" → "test-web-#", "test_server_12" → "test_server_#",
/// "shard 2/4" → "shard #/#". Other names unchanged.
pub fn fold_step(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(name.len());
    let mut i = 0;
    while i < n {
        let c = chars[i];
        if c.is_ascii_digit() && (i == 0 || !chars[i - 1].is_ascii_alphanumeric()) {
            let mut j = i;
            while j < n && chars[j].is_ascii_digit() {
                j += 1;
            }
            // "2/4", "2 of 4"
            if j < n && chars[j] == '/' && chars.get(j + 1).is_some_and(|d| d.is_ascii_digit()) {
                let mut k = j + 1;
                while k < n && chars[k].is_ascii_digit() {
                    k += 1;
                }
                if k == n || !chars[k].is_ascii_alphanumeric() {
                    out.push_str("#/#");
                    i = k;
                    continue;
                }
            }
            // trailing "-3" / "_12" / " 3" counter after a non-digit word
            let sep = if i > 0 { Some(chars[i - 1]) } else { None };
            let before_sep = if i > 1 { Some(chars[i - 2]) } else { None };
            if j == n
                && j - i <= 3
                && matches!(sep, Some('-') | Some('_') | Some(' ') | Some('#'))
                && before_sep.is_some_and(|b| b.is_ascii_alphabetic())
            {
                out.push('#');
                i = j;
                continue;
            }
            out.extend(&chars[i..j]);
            i = j;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

// Tiers: a higher tier is a better root cause; on a tie the earliest line wins.
const T_COMPILE: u8 = 100;
const T_COMPILE_SUM: u8 = 95;
const T_OOM: u8 = 93;
const T_TEST: u8 = 92;
const T_TEST_MARK: u8 = 91;
const T_TEST_HEAD: u8 = 90;
const T_TEST_SUM: u8 = 88;
const T_ASSERT: u8 = 86;
const T_LINT_ITEM: u8 = 81;
const T_LINT: u8 = 80;
const T_AUTH: u8 = 65;
const T_DEPS: u8 = 60;
const T_SEC_LEAK: u8 = 52;
const T_SEC_VULN: u8 = 51;
const T_SEC: u8 = 50;
const T_DEPLOY: u8 = 40;
const T_ENGINE: u8 = 36;
const T_NETWORK: u8 = 35;
const T_INFRA: u8 = 33;
const T_TIMEOUT: u8 = 25;
const T_EXCEPTION: u8 = 14;
const T_GENERIC_HI: u8 = 12;
const T_DETAIL: u8 = 11;
const T_GENERIC: u8 = 10;
const T_GENERIC_LO: u8 = 9;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Hint {
    None,
    /// Display from this byte offset of the trimmed line.
    From(usize),
    /// pytest `FAILED x::y - reason`: cut at " - ".
    CutReason,
    /// Use the nearest preceding `could not compile` line as the text.
    PrevCompile,
}

#[derive(Clone, Copy, Debug)]
struct Hit {
    tier: u8,
    class: FailClass,
    hint: Hint,
}

fn hit(tier: u8, class: FailClass) -> Option<Hit> {
    Some(Hit {
        tier,
        class,
        hint: Hint::None,
    })
}

struct Ctx {
    build: bool,
    deploy: bool,
    dagger: bool,
}

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// The number immediately before ` word` in `lc`, at the first place that has one.
fn count_before(lc: &str, word: &str) -> Option<u64> {
    let mut from = 0;
    while let Some(p) = lc[from..].find(word) {
        let at = from + p;
        let head = lc[..at].trim_end();
        if head.len() < at {
            let digits: String = head
                .chars()
                .rev()
                .take_while(|c| c.is_ascii_digit())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if !digits.is_empty() {
                return digits.parse().ok();
            }
        }
        from = at + word.len();
    }
    None
}

fn nonzero_count(lc: &str, word: &str) -> bool {
    count_before(lc, word).is_some_and(|n| n > 0)
}

/// `path.ext:12:` somewhere before `at`.
fn has_loc_before(t: &str, at: usize) -> Option<&'static str> {
    let head = &t[..at];
    const EXTS: &[&str] = &[
        ".rs", ".go", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".m", ".mm", ".py", ".ts",
        ".tsx", ".js", ".jsx", ".mjs", ".java", ".kt", ".cs", ".zig", ".vue", ".svelte", ".sh",
    ];
    for ext in EXTS {
        let pat_len = ext.len();
        let mut from = 0;
        while let Some(p) = head[from..].find(ext) {
            let end = from + p + pat_len;
            let next = head.as_bytes().get(end).copied();
            if matches!(next, Some(b':') | Some(b'(')) {
                return Some(ext);
            }
            from = end;
        }
    }
    None
}

const B_OOM: u32 = 1;
const B_ERR: u32 = 1 << 1;
const B_FAIL: u32 = 1 << 2;
const B_LINT: u32 = 1 << 3;
const B_NET: u32 = 1 << 4;
const B_TIME: u32 = 1 << 5;
const B_AUTH: u32 = 1 << 6;
const B_DEPS: u32 = 1 << 7;
const B_SEC: u32 = 1 << 8;
const B_DEPLOY: u32 = 1 << 9;
const B_INFRA: u32 = 1 << 10;
const B_MISC: u32 = 1 << 11;

/// A cheap one-pass prefilter: which rule groups could match this line? Most log lines
/// (progress, compiling, passing tests) contain no trigger word and skip the rule chain;
/// the rest only run the groups their words point at.
fn trigger_mask(t: &str, lc: &str) -> u32 {
    let mut m = 0;
    if !t.is_ascii() {
        let first = t.chars().next().unwrap_or(' ');
        if matches!(first, '×' | '✗' | '✕' | '✘' | '✖') {
            m |= B_MISC;
        }
    }
    if lc.starts_with("! ") || lc.starts_with("e: ") || lc.starts_with("___") {
        m |= B_MISC;
    }
    if lc.starts_with("ld: ") {
        m |= B_ERR;
    }
    if lc.contains(".py:") {
        m |= B_LINT;
    }
    let b = lc.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !(b[i].is_ascii_alphanumeric() || b[i] == b'_') {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
            i += 1;
        }
        m |= word_bits(&lc[start..i]);
    }
    m
}

fn word_bits(w: &str) -> u32 {
    let bits = match w {
        "memory" | "heap" | "oomkilled" | "killed" | "sigkill" => B_OOM,
        "memoryerror" => B_OOM | B_ERR,
        "modulenotfounderror" | "importerror" => B_DEPS | B_ERR,
        "error" | "errors" | "err" | "fatal" | "panic" | "panicked" | "exception" | "assert"
        | "undefined" | "declared" | "imported" => B_ERR,
        "fail" | "failed" | "failure" | "failures" | "failing" | "problem" | "problems" => B_FAIL,
        "reformat" | "reformatted" | "clippy" | "diff" | "offense" | "offenses" | "style"
        | "rustfmt" => B_LINT,
        "timeout" | "timed" | "deadline" | "exceeded" => B_TIME,
        "refused" | "reset" | "unreachable" | "tls" | "ssl" | "certificate" | "x509"
        | "handshake" | "gateway" | "unavailable" | "mirror" | "mismatch" | "econnreset"
        | "econnrefused" | "etimedout" | "enotfound" | "eai_again" | "socket" | "getaddrinfo"
        | "host" | "eof" | "connection" | "service" | "resolution" | "502" | "503" | "504"
        | "spurious" | "fetch" | "access" => B_NET,
        "resolve" | "resolving" => B_NET | B_DEPS,
        "denied" | "publickey" | "username" | "password" | "authentication" | "verification" => {
            B_AUTH
        }
        "cannot" => B_DEPS | B_ERR,
        "could"
        | "unable"
        | "unsatisfiable"
        | "resolutionimpossible"
        | "eresolve"
        | "err_pnpm"
        | "module"
        | "matching"
        | "solution"
        | "satisfies"
        | "lock"
        | "lockfile"
        | "locate"
        | "distribution"
        | "conflicting"
        | "package"
        | "npm"
        | "select" => B_DEPS,
        "leaks" | "cve" | "ghsa" | "critical" | "gitleaks" | "total" => B_SEC,
        "deploy" | "deployment" | "rollout" | "unhealthy" | "health" | "healthcheck"
        | "provisioning" | "provision" => B_DEPLOY,
        "dagger" | "sock" | "manifest" | "toomanyrequests" | "unknown" | "space" | "buildkit"
        | "daemon" | "docker" | "rpc" | "mkdir" | "agent" | "runner" => B_INFRA,
        "conflict" | "successfully" => B_MISC,
        _ => 0,
    };
    if bits != 0 {
        return bits;
    }
    let wb = w.as_bytes();
    let code = |prefix: &[u8]| {
        wb.len() > prefix.len() + 1
            && wb.starts_with(prefix)
            && wb[prefix.len()..].iter().all(|c| c.is_ascii_digit())
    };
    if w.ends_with("error") || w.ends_with("exception") || code(b"ts") {
        B_ERR
    } else if w.starts_with("vulnerab") {
        B_SEC
    } else if code(b"sc") {
        B_LINT
    } else {
        0
    }
}

/// Lines that are never decisive.
fn is_noise(t: &str, lc: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "warning",
        "warn ",
        "warn:",
        "[warn",
        "[warning",
        "npm warn",
        "hint:",
        "note:",
        "help:",
        "= note",
        "= help",
        "compiling ",
        "checking ",
        "downloading ",
        "downloaded ",
        "running ",
        "+ ",
        "$ ",
        "> ",
        "info",
        "[info",
        "debug",
        "[debug",
        "withexec ",
        "-->",
        "|",
        "│",
        "┃",
        "├",
        "└",
        "┌",
        "╭",
        "╰",
        "#[",
        "fresh ",
        "updating ",
        "updated ",
        "installing ",
        "installed ",
        "building ",
        "built ",
        "resolved ",
        "prepared ",
        "audited ",
        "added ",
        "removed ",
        "changed ",
        "unpacking ",
        "pouring ",
        "==> ",
        "cloning into",
        "dep cache:",
    ];
    if PREFIXES.iter().any(|p| lc.starts_with(p)) {
        return true;
    }
    if (lc.contains(": warning:") || lc.contains(" warning: ") || lc.contains(": note:"))
        && !lc.contains(": error")
    {
        return true;
    }
    // Compiler source excerpts: "173 |     let x = ...".
    let digits = lc.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits > 0 && lc[digits..].trim_start().starts_with('|') {
        return true;
    }
    if lc.contains("level=info")
        || lc.contains("level=warn")
        || lc.contains("level=debug")
        || lc.contains("telemetry")
        || lc.contains("deprecat")
    {
        return true;
    }
    // A pytest/unittest progress line "test_x ... ok".
    if lc.ends_with("... ok") || lc.ends_with(" passed") && !lc.contains("failed") {
        return true;
    }
    let _ = t;
    false
}

/// Wrapper lines: they report that something failed, not why.
fn is_wrapper(t: &str, lc: &str) -> bool {
    if lc.starts_with("error: recipe `") && lc.contains("failed") {
        return true;
    }
    if lc.starts_with("error: exit code")
        || lc.starts_with("! exit code")
        || lc.starts_with("exit code")
        || lc.starts_with("exit status ")
        || lc.starts_with("error: process completed with exit code")
        || lc.starts_with("process completed with exit code")
        || lc.starts_with("error: process completed")
        || lc.starts_with("error command failed with exit code")
        || lc.starts_with("command failed with exit code")
        || lc.starts_with("error: script ")
        || lc.starts_with("error: build failed")
        || lc.contains("elifecycle")
        || lc == "stderr:"
        || lc == "stdout:"
        || lc == "caused by:"
    {
        return true;
    }
    if (lc.starts_with("make: ***") || lc.starts_with("make[")) && lc.contains("error") {
        return true;
    }
    if lc.contains("failed (rc=")
        || lc.contains(" failed: exit code") && lc.starts_with("error: exit")
    {
        return true;
    }
    for npm in ["npm error", "npm err!"] {
        if let Some(r) = lc.strip_prefix(npm) {
            let r = r.trim_start();
            if r.is_empty()
                || r.starts_with("code ")
                || r.starts_with("errno")
                || r.starts_with("a complete log")
                || r.starts_with("command ")
                || r.starts_with("path ")
                || r.starts_with("syscall")
                || r.starts_with("npm warn")
                || r.starts_with("log files")
                || r.starts_with("lifecycle")
                || r == "npm error"
                || r == "npm err!"
            {
                return true;
            }
        }
    }
    // Dagger span status: "Container.withExec ERROR [7.0s]", "parsing command line arguments ERROR".
    if t.ends_with(" ERROR") || (t.contains(" ERROR [") && t.trim_end().ends_with(']')) {
        return true;
    }
    false
}

fn find_ci(lc: &str, pat: &str) -> Option<usize> {
    lc.find(pat)
}

fn classify(t: &str, lc: &str, m: u32, ctx: &Ctx) -> Option<Hit> {
    // --- out-of-memory evidence (before wrappers: "npm error signal SIGKILL") ---
    if m & B_OOM != 0
        && (lc.contains("javascript heap out of memory")
            || lc.contains("oomkilled")
            || lc.contains("out of memory")
            || lc.contains("cannot allocate memory")
            || lc.contains("memoryerror")
            || lc == "killed"
            || lc.contains("signal=sigkill")
            || lc.contains("sigkill"))
    {
        if lc.contains("process didn't exit successfully") || lc.contains("could not compile") {
            return Some(Hit {
                tier: T_OOM,
                class: FailClass::Oom,
                hint: Hint::PrevCompile,
            });
        }
        if !lc.starts_with("warning") {
            return hit(T_OOM, FailClass::Oom);
        }
    }
    if is_noise(t, lc) || is_wrapper(t, lc) {
        return None;
    }

    // --- compiler errors ---
    if m & (B_ERR | B_FAIL) != 0 {
        if lc.starts_with("error[e") {
            return hit(T_COMPILE, FailClass::Compile);
        }
        if let Some(p) = find_ci(lc, "error ts")
            && lc.as_bytes().get(p + 8).is_some_and(|b| b.is_ascii_digit())
        {
            return hit(T_COMPILE, FailClass::Typecheck);
        }
        for pat in [": error:", ": fatal error:", " - error: "] {
            if let Some(p) = lc.find(pat)
                && let Some(ext) = has_loc_before(lc, p)
            {
                let class = match ext {
                    ".py" | ".ts" | ".tsx" | ".js" | ".jsx" | ".mjs" | ".vue" | ".svelte" => {
                        FailClass::Typecheck
                    }
                    ".sh" => FailClass::Lint,
                    _ => FailClass::Compile,
                };
                return hit(T_COMPILE, class);
            }
        }
        if lc.starts_with("syntaxerror") || lc.starts_with("indentationerror") {
            return hit(T_COMPILE, FailClass::Compile);
        }
        if (lc.contains(": undefined: ")
            || lc.contains("cannot use ")
            || lc.contains("declared and not used")
            || lc.contains("imported and not used"))
            && has_loc_before(lc, lc.len()).is_some()
        {
            return hit(T_COMPILE, FailClass::Compile);
        }
        if lc.starts_with("error: could not compile")
            || lc.starts_with("error: linking with")
            || lc.contains("undefined reference to")
            || lc.starts_with("ld: ")
            || lc.contains("linker command failed")
        {
            return hit(T_COMPILE_SUM, FailClass::Compile);
        }
    }
    // --- tests ---
    if m & (B_FAIL | B_ERR | B_MISC) != 0 {
        if t.starts_with("FAILED ") && t.contains("::") {
            return Some(Hit {
                tier: T_TEST,
                class: FailClass::Test,
                hint: Hint::CutReason,
            });
        }
        if (t.starts_with("FAIL ") || t.starts_with("FAIL\u{a0}"))
            && (t.contains('/') || t.contains(".test") || t.contains(".spec"))
        {
            return hit(T_TEST, FailClass::Test);
        }
        if (t.starts_with("FAIL: ") || t.starts_with("ERROR: "))
            && t.ends_with(')')
            && t.contains(" (")
        {
            // unittest: "FAIL: test_x (pkg.Class.test_x)"
            return hit(T_TEST, FailClass::Test);
        }
        if t.starts_with("___") && t.ends_with("___") {
            let inner = t.trim_matches('_').trim();
            if !inner.is_empty() && !inner.contains("summary") && !inner.contains("coverage") {
                return hit(T_TEST_HEAD, FailClass::Test);
            }
        }
        if lc.starts_with("--- fail:") {
            return hit(T_TEST, FailClass::Test);
        }
        if lc.starts_with("test ") && (lc.ends_with("... failed") || lc.ends_with(" ... fail")) {
            return hit(T_TEST, FailClass::Test);
        }
        if lc.contains("panicked at") {
            let tier = if lc.starts_with("thread '") {
                T_TEST
            } else {
                T_TEST_MARK
            };
            return hit(tier, FailClass::Test);
        }
        if lc.contains("problem") && (t.starts_with('✖') || lc.contains("problems (")) {
            // eslint summary "✖ 3 problems (3 errors, 0 warnings)"
            if nonzero_count(lc, "problem") {
                return hit(T_LINT, FailClass::Lint);
            }
            return None;
        }
        if t.starts_with('×') || t.starts_with('✗') || t.starts_with('✕') || t.starts_with('✘')
        {
            return hit(T_TEST_MARK, FailClass::Test);
        }
        if lc.starts_with("test result: failed")
            || lc.starts_with("error: test failed")
            || lc.starts_with("failed (failures=")
            || lc.starts_with("failed (errors=")
            || (lc.starts_with("test suites:") && nonzero_count(lc, "failed"))
            || (lc.starts_with("tests:") && nonzero_count(lc, "failed"))
            || nonzero_count(lc, "failing")
                && lc.trim_start_matches(|c: char| c.is_ascii_digit()).trim() == "failing"
        {
            return hit(T_TEST_SUM, FailClass::Test);
        }
        if nonzero_count(lc, "failed")
            && (lc.contains(" passed")
                || lc.starts_with('=')
                || lc.trim_start_matches(|c: char| c.is_ascii_digit()).trim() == "failed")
        {
            return hit(T_TEST_SUM, FailClass::Test);
        }
        if lc.starts_with("e ") && (lc.contains("assertionerror") || lc.contains("assert ")) {
            return hit(T_ASSERT, FailClass::Test);
        }
    }
    // --- lint ---
    if m & (B_LINT | B_ERR | B_FAIL) != 0 {
        if lc.starts_with("diff in ") {
            return hit(T_LINT, FailClass::Lint);
        }
        if lc.contains("would reformat")
            || lc.contains("would be reformatted")
            || lc.contains("code style issues")
            || lc.contains("clippy::")
            || lc.contains("rustfmt") && (lc.contains("fail") || lc.contains("diff"))
        {
            return hit(T_LINT, FailClass::Lint);
        }
        if is_eslint_item(lc) || is_ruff_item(t) {
            return hit(T_LINT_ITEM, FailClass::Lint);
        }
        if lc.starts_with("found ") && nonzero_count(lc, "error") {
            // ruff "Found 3 errors." / mypy "Found 2 errors in 1 file"
            let class = if lc.contains(" in ") && lc.contains("file") {
                FailClass::Typecheck
            } else {
                FailClass::Lint
            };
            return hit(T_LINT, class);
        }
        if nonzero_count(lc, "error") && lc.contains("informations") {
            // pyright summary
            return hit(T_LINT, FailClass::Typecheck);
        }
        if lc.contains("sc") && has_shellcheck_code(lc) {
            return hit(T_LINT, FailClass::Lint);
        }
        if nonzero_count(lc, "offense") {
            // rubocop "12 files inspected, 3 offenses detected"
            return hit(T_LINT - 2, FailClass::Lint);
        }
        if lc.len() < 160
            && !lc.contains("&&")
            && (lc.contains("lint failed")
                || lc.contains("linting failed")
                || lc.contains("lint error")
                || [
                    "ansible-lint",
                    "yamllint",
                    "hadolint",
                    "markdownlint",
                    "golangci-lint",
                    "stylelint",
                    "rubocop",
                    "flake8",
                    "pylint",
                    "shellcheck",
                ]
                .iter()
                .any(|tool| lc.starts_with(tool) || lc.contains(&format!("{tool}:")))
                    && (lc.contains("fail") || lc.contains("error") || lc.contains("violation")))
        {
            return hit(T_LINT - 2, FailClass::Lint);
        }
    }
    // --- auth to source hosts (root of many clone / git-dep failures) ---
    if m & B_AUTH != 0
        && (lc.contains("permission denied (publickey")
            || lc.contains("could not read username")
            || lc.contains("could not read password")
            || lc.contains("authentication failed")
            || lc.contains("host key verification failed"))
    {
        return hit(T_AUTH, FailClass::Infra);
    }
    // --- engine / runner: before network, their messages mention resets and EOFs ---
    if m & (B_INFRA | B_NET | B_TIME) != 0 {
        let engine_err = (lc.contains("dagger/query")
            || lc.contains("engine.sock")
            || lc.contains("dagger engine")
            || lc.contains("buildkit"))
            && [
                "eof",
                "refused",
                "reset",
                "dial ",
                "connect:",
                "no such file",
                "error",
                "failed",
                "lost",
            ]
            .iter()
            .any(|w| lc.contains(w));
        if engine_err
            || lc.contains("failed to connect to the docker api")
            || lc.contains("cannot connect to the docker daemon")
            || lc.contains("no space left on device")
            || lc.contains("rpc error: code =")
            || (lc.contains("context deadline exceeded") && ctx.dagger)
        {
            if lc.contains("cleanup failed") {
                return None;
            }
            return hit(T_ENGINE, FailClass::Infra);
        }
    }
    // --- network (checked before deps: "Could not resolve host") ---
    // An HTTP 4xx/5xx in a deploy step is the deploy failing (provisioning API, health URL).
    if m & B_DEPLOY != 0 && ctx.deploy && has_http_error(lc) {
        return hit(T_DEPLOY, FailClass::Deploy);
    }
    if m & (B_NET | B_TIME) != 0 {
        const NET: &[&str] = &[
            "could not resolve host",
            "temporary failure in name resolution",
            "name or service not known",
            "no such host",
            "getaddrinfo",
            "connection refused",
            "connection reset",
            "connection timed out",
            "network is unreachable",
            "no route to host",
            "tls handshake",
            "i/o timeout",
            "econnreset",
            "econnrefused",
            "etimedout",
            "enotfound",
            "eai_again",
            "socket hang up",
            "bad gateway",
            "service unavailable",
            "gateway timeout",
            "gateway time-out",
            "eof occurred in violation of protocol",
            "certificate verify failed",
            "x509: certificate",
            "ssl error",
            "mirror sync in progress",
            "hash sum mismatch",
            "failed to fetch http",
            "unable to access 'http",
            "spurious network error",
        ];
        for pat in NET {
            if let Some(p) = lc.find(pat) {
                if lc.starts_with("warning") {
                    return None;
                }
                let hint = if *pat == "could not resolve host" {
                    Hint::From(lc.find("could not resolve host:").unwrap_or(p))
                } else {
                    Hint::None
                };
                return Some(Hit {
                    tier: T_NETWORK,
                    class: FailClass::Network,
                    hint,
                });
            }
        }
        if (lc.contains(" 502") || lc.contains(" 503") || lc.contains(" 504"))
            && (lc.contains("http") || lc.contains("status"))
        {
            let class = if ctx.deploy {
                FailClass::Deploy
            } else {
                FailClass::Network
            };
            return hit(T_NETWORK, class);
        }
    }
    // --- deps ---
    if m & B_DEPS != 0 {
        if lc.starts_with("npm error") || lc.starts_with("npm err!") {
            return hit(T_DEPS, FailClass::Deps);
        }
        const DEPS: &[&str] = &[
            "err_pnpm",
            "could not resolve dependency",
            "could not resolve dependencies",
            "no matching version",
            "failed to select a version",
            "modulenotfounderror",
            "no module named",
            "no solution found when resolving",
            "unsatisfiable",
            "resolutionimpossible",
            "could not find a version that satisfies",
            "conflicting dependencies",
            "eresolve",
            "cannot find module",
            "unable to locate package",
            "lock file needs to be updated",
            "lockfile needs to be updated",
            "is not up to date with",
            "failed to resolve",
            "package not found",
            "no matching distribution",
            "could not find package",
            "unable to resolve dependency",
        ];
        if DEPS.iter().any(|p| lc.contains(p)) {
            return hit(T_DEPS, FailClass::Deps);
        }
        if lc.contains("could not resolve") && !lc.contains("host") {
            return hit(T_DEPS, FailClass::Deps);
        }
    }
    // --- security ---
    if m & B_SEC != 0 {
        if lc.contains("leaks found") && !lc.contains("no leaks found") {
            return hit(T_SEC_LEAK, FailClass::Security);
        }
        if (lc.contains("vulnerabilities found") || lc.contains("vulnerability found"))
            && !lc.contains("no known vulnerabilit")
            && !lc.contains("no vulnerabilit")
        {
            return hit(T_SEC_VULN, FailClass::Security);
        }
        if lc.starts_with("total:") && lc.contains("critical") && total_nonzero(lc) {
            return hit(T_SEC_VULN, FailClass::Security);
        }
        if lc.contains("gitleaks") && (lc.contains("fail") || lc.contains("leaks found")) {
            return hit(T_SEC, FailClass::Security);
        }
        if (lc.contains("cve-") || lc.contains("ghsa-"))
            && (lc.contains("critical") || lc.contains("high"))
        {
            return hit(T_SEC - 1, FailClass::Security);
        }
    }
    // --- deploy ---
    if m & (B_DEPLOY | B_NET) != 0 {
        const DEPLOY: &[&str] = &[
            "failsafe-deploy",
            "deploy failed",
            "deployment failed",
            "failed to deploy",
            "deploy error",
            "deployment error",
            "deploy: error",
            "rollout failed",
            "rollout status",
            "exceeded its progress deadline",
            "provisioning failed",
            "provisioning error",
            "provision failed",
            "health check failed",
            "healthcheck failed",
            "health check timed out",
            "failed health check",
            "unhealthy",
        ];
        if DEPLOY.iter().any(|p| lc.contains(p)) {
            return hit(T_DEPLOY, FailClass::Deploy);
        }
    }
    // --- infra ---
    if m & (B_INFRA | B_AUTH) != 0
        && (lc.contains("manifest unknown")
            || lc.contains("pull access denied")
            || lc.contains("toomanyrequests")
            || lc.contains("error response from daemon")
            || (lc.contains("unknown flag:") && ctx.dagger)
            || (lc.contains("permission denied") && lc.contains("mkdir"))
            || lc.contains("lost connection to agent")
            || lc.contains("runner system failure"))
    {
        return hit(T_INFRA, FailClass::Infra);
    }
    // --- timeout ---
    if m & B_TIME != 0
        && (lc.contains("timed out")
            || lc.contains("deadline exceeded")
            || lc.contains("time limit exceeded")
            || (lc.contains("timeout")
                && (lc.contains("error") || lc.contains("exceeded") || lc.contains("waiting"))))
    {
        return hit(T_TIMEOUT, FailClass::Timeout);
    }
    // --- generic ---
    let generic_class = |line_lc: &str| -> FailClass {
        if ctx.build || looks_build(line_lc) {
            FailClass::Build
        } else {
            FailClass::Exit
        }
    };
    if t.starts_with("CONFLICT (") || has_fail_token(t) {
        return hit(T_GENERIC_HI, FailClass::Exit);
    }
    if let Some(rest) = t.strip_prefix("! ") {
        let _ = rest;
        return hit(T_DETAIL, generic_class(lc));
    }
    if lc.starts_with("error:")
        || lc.starts_with("error ")
        || lc.starts_with("error[")
        || lc.starts_with("fatal:")
        || lc.starts_with("fatal ")
        || lc.starts_with("panic:")
        || t.starts_with("FATAL")
        || t.starts_with("E: ")
        || t.starts_with("[ERROR]")
        || t.starts_with("ERROR")
        || lc.starts_with("err!")
        || starts_with_ci(t, "exception")
        || (lc.contains("error:") && lc.len() < 200 && !lc.contains("0 error"))
    {
        let tier = if lc.contains("failed to solve") {
            T_GENERIC_LO
        } else {
            T_GENERIC
        };
        return hit(tier, generic_class(lc));
    }
    if t.starts_with("FAIL: ") || lc.contains("did not run successfully") {
        return hit(T_GENERIC_LO, generic_class(lc));
    }
    None
}

/// trivy "Total: 3 (UNKNOWN: 0, ...)": the count after "total:" must be non-zero.
fn total_nonzero(lc: &str) -> bool {
    let after = lc.trim_start_matches("total:").trim_start();
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().is_ok_and(|n| n > 0)
}

/// A gate verdict such as "freshness gate: FAIL — 3 problems": an uppercase FAIL/FAILED
/// word after a colon or dash, in the middle of a line.
fn has_fail_token(t: &str) -> bool {
    for pat in [
        ": FAIL",
        "- FAIL",
        "— FAIL",
        ": FAILED",
        "- FAILED",
        "— FAILED",
    ] {
        if let Some(p) = t.find(pat) {
            let after = t.as_bytes().get(p + pat.len()).copied();
            if after.is_none_or(|c| !c.is_ascii_alphanumeric()) {
                return true;
            }
        }
    }
    false
}

fn looks_build(lc: &str) -> bool {
    const B: &[&str] = &[
        "build",
        "docker",
        "dockerfile",
        "buildkit",
        "make:",
        "cargo ",
        "webpack",
        "vite",
        "esbuild",
        "rollup",
        "mkdocs",
        "gradle",
        "mvn ",
        "flatpak",
        "xcodebuild",
        "bundle ",
    ];
    B.iter().any(|b| lc.contains(b))
}

fn has_http_error(lc: &str) -> bool {
    let b = lc.as_bytes();
    for i in 0..b.len().saturating_sub(2) {
        if matches!(b[i], b'4' | b'5')
            && b[i + 1].is_ascii_digit()
            && b[i + 2].is_ascii_digit()
            && (i == 0 || !b[i - 1].is_ascii_alphanumeric() && b[i - 1] != b'.')
            && b.get(i + 3)
                .is_none_or(|c| !c.is_ascii_alphanumeric() && *c != b'.')
        {
            let head = &lc[..i];
            if head.ends_with("http ")
                || head.ends_with("status ")
                || head.ends_with("status: ")
                || head.ends_with("status=")
                || head.ends_with("code ")
                || head.ends_with("code: ")
                || head.ends_with("returned ")
            {
                return true;
            }
        }
    }
    false
}

/// eslint "  12:5  error  'x' is defined but never used  no-unused-vars"
fn is_eslint_item(lc: &str) -> bool {
    let mut it = lc.split_whitespace();
    let (Some(loc), Some(level)) = (it.next(), it.next()) else {
        return false;
    };
    let mut parts = loc.split(':');
    let ok = parts
        .next()
        .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && parts
            .next()
            .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none();
    ok && level == "error"
}

/// ruff/flake8 "src/x.py:1:1: F401 [*] `os` imported but unused"
fn is_ruff_item(t: &str) -> bool {
    let Some(p) = t.find(".py:") else {
        return false;
    };
    let rest = &t[p + 4..];
    let mut segs = rest.splitn(3, ':');
    let (Some(l), Some(c), Some(msg)) = (segs.next(), segs.next(), segs.next()) else {
        return false;
    };
    if !(l.bytes().all(|b| b.is_ascii_digit()) && c.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    let code = msg.split_whitespace().next().unwrap_or("");
    let chars: Vec<char> = code.chars().collect();
    is_error_code(&chars)
}

fn has_shellcheck_code(lc: &str) -> bool {
    let b = lc.as_bytes();
    let mut from = 0;
    while let Some(p) = lc[from..].find("sc") {
        let at = from + p;
        let digits = b[at + 2..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count();
        if digits == 4 && (at == 0 || !b[at - 1].is_ascii_alphanumeric()) {
            return true;
        }
        from = at + 2;
    }
    false
}

/// Exception line after a Python traceback: `pkg.SomeError: message` (unindented).
fn exception_hit(t: &str, ctx: &Ctx) -> Option<Hit> {
    let head = t.split([':', ' ']).next().unwrap_or("");
    if head.is_empty()
        || !head
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        return None;
    }
    let name = head.rsplit('.').next().unwrap_or(head);
    if !(name.ends_with("Error")
        || name.ends_with("Exception")
        || name.ends_with("Exit")
        || name.ends_with("Interrupt"))
    {
        return None;
    }
    let (tier, class) = match name {
        "ModuleNotFoundError" | "ImportError" => (T_DEPS, FailClass::Deps),
        "SyntaxError" | "IndentationError" | "TabError" => (T_COMPILE, FailClass::Compile),
        "MemoryError" => (T_OOM, FailClass::Oom),
        "AssertionError" => (T_ASSERT, FailClass::Test),
        n if n.contains("Timeout") => (T_TIMEOUT, FailClass::Timeout),
        n if n.contains("Connection") || n == "URLError" || n == "SSLError" => {
            (T_NETWORK, FailClass::Network)
        }
        _ => (
            T_EXCEPTION,
            if ctx.build {
                FailClass::Build
            } else {
                FailClass::Exit
            },
        ),
    };
    hit(tier, class)
}

fn class_from_name(name: &str) -> Option<FailClass> {
    let n = name.to_ascii_lowercase();
    let has = |k: &str| n.contains(k);
    if has("lint") || has("fmt") || has("format") || has("clippy") || has("ruff") || has("eslint") {
        Some(FailClass::Lint)
    } else if has("typecheck") || has("type-check") || has("tsc") || has("mypy") || has("pyright") {
        Some(FailClass::Typecheck)
    } else if has("test") {
        Some(FailClass::Test)
    } else if has("deploy") {
        Some(FailClass::Deploy)
    } else if has("security") || has("gitleaks") || has("trivy") || has("audit") {
        Some(FailClass::Security)
    } else if has("build") || has("docker") || has("image") {
        Some(FailClass::Build)
    } else {
        None
    }
}

/// The text shown for a chosen line, before normalization.
fn display_text(lines: &[String], idx: usize, hit: Hit) -> String {
    let t = lines[idx].trim();
    let mut s: &str = t;
    match hit.hint {
        Hint::From(p) => {
            s = &t[p.min(t.len())..];
            // Drop a dangling ")" left from "(... Could not resolve host: x)".
            let opens = s.matches('(').count();
            let closes = s.matches(')').count();
            if closes > opens {
                s = s.trim_end_matches(')');
            }
        }
        Hint::CutReason => {
            if let Some(p) = t.find(" - ") {
                s = &t[..p];
            }
        }
        Hint::PrevCompile => {
            let from = idx.saturating_sub(12);
            if let Some(prev) = lines[from..idx].iter().rev().find(|l| {
                l.trim_start()
                    .to_ascii_lowercase()
                    .starts_with("error: could not compile")
            }) {
                return strip_decor(prev.trim(), hit.class);
            }
        }
        Hint::None => {}
    }
    strip_decor(s, hit.class)
}

/// Remove tool decoration that only differs by where the line came from.
fn strip_decor(s: &str, class: FailClass) -> String {
    let mut s = s.trim();
    if s.starts_with("==") || s.starts_with("__") || s.starts_with("= ") {
        s = s.trim_matches(|c| c == '=' || c == '_' || c == ' ');
    }
    for p in ["Caused by: ", "caused by: ", "! "] {
        if let Some(r) = s.strip_prefix(p) {
            s = r.trim_start();
        }
    }
    // Leading clock times and zerolog levels: "11:12PM WRN leaks found: 1".
    loop {
        let first = s.split(' ').next().unwrap_or("");
        let is_time = first.len() >= 4
            && (first.matches(':').count() >= 2 || first.ends_with("AM") || first.ends_with("PM"))
            && first
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, ':' | '.' | 'A' | 'P' | 'M' | 'Z'));
        let is_level = matches!(first, "INF" | "WRN" | "DBG" | "TRC");
        if (is_time || is_level) && first.len() < s.len() {
            s = s[first.len()..].trim_start();
        } else {
            break;
        }
    }
    // "npm error npm error X" → "npm error X"; for a non-deps cause drop the prefix entirely.
    let mut npm = false;
    while let Some(r) = s
        .strip_prefix("npm error ")
        .or_else(|| s.strip_prefix("npm ERR! "))
    {
        s = r.trim_start();
        npm = true;
    }
    if npm && class == FailClass::Deps {
        format!("npm error {s}")
    } else {
        s.to_string()
    }
}

/// The signature of one failed step: class + decisive line from its log lines (already
/// decoded, any order of noise), else from the step name and exit code alone (log empty).
pub fn extract(workflow: &str, step: &str, exit_code: Option<i32>, log: &[String]) -> Signature {
    let names = format!("{} {}", step, workflow).to_ascii_lowercase();
    let lines: Vec<String> = log.iter().map(|l| clean_line(l)).collect();
    let dagger = lines.iter().any(|l| l.contains("dagger"));
    let ctx = Ctx {
        build: [
            "build", "image", "docker", "release", "flatpak", "package", "bundle",
        ]
        .iter()
        .any(|k| names.contains(k)),
        deploy: names.contains("deploy"),
        dagger,
    };

    let mut best: Option<(usize, Hit)> = None;
    let mut oom_at: Vec<usize> = Vec::new();
    let mut saw_clippy = false;
    let mut in_traceback = false;
    let mut tb_lines = 0usize;
    let mut lc = String::new();
    for (idx, line) in lines.iter().enumerate() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        lc.clear();
        lc.push_str(t);
        lc.make_ascii_lowercase();
        if !saw_clippy
            && lc.contains("clippy")
            && !lc.starts_with("+ ")
            && !lc.starts_with("withexec")
        {
            saw_clippy = true;
        }
        let mut h = None;
        if lc.starts_with("traceback (most recent call last)") {
            in_traceback = true;
            tb_lines = 0;
            continue;
        }
        if in_traceback {
            tb_lines += 1;
            let indented = line.starts_with(' ') || line.starts_with('\t');
            if indented || t.starts_with("File ") || t.starts_with('^') || t.starts_with('~') {
                continue;
            }
            // The first unindented exception line ends the traceback; other output that is
            // interleaved with the frames does not.
            h = exception_hit(t, &ctx);
            if h.is_some() || tb_lines > 400 {
                in_traceback = false;
            }
        }
        let mut m = trigger_mask(t, &lc);
        if ctx.deploy && has_http_error(&lc) {
            m |= B_DEPLOY;
        }
        if h.is_none() && m != 0 && !is_noise(t, &lc) {
            h = classify(t, &lc, m, &ctx);
        }
        if let Some(h) = h
            && h.class == FailClass::Oom
            && h.tier == T_OOM
        {
            oom_at.push(idx);
        }
        if let Some(h) = h
            && best.is_none_or(|(_, b)| h.tier > b.tier)
        {
            best = Some((idx, h));
        }
    }

    let Some((idx, mut h)) = best else {
        let class = if exit_code == Some(137) {
            FailClass::Oom
        } else {
            class_from_name(step)
                .or_else(|| class_from_name(workflow))
                .unwrap_or(FailClass::Exit)
        };
        return Signature {
            class,
            line: None,
            exit_code,
        };
    };

    // `could not compile` whose rustc was SIGKILLed: the compiler ran out of memory.
    if h.tier == T_COMPILE_SUM && oom_at.iter().any(|&k| k > idx && k <= idx + 12) {
        h.class = FailClass::Oom;
    }
    if h.tier <= T_GENERIC && saw_clippy && lines[idx].trim_start().starts_with("error:") {
        h.class = FailClass::Lint;
    }
    if h.tier <= T_EXCEPTION && exit_code == Some(137) {
        h.class = FailClass::Oom;
    }
    let text = display_text(&lines, idx, h);
    let line = normalize(&text);
    Signature {
        class: h.class,
        line: if line.is_empty() { None } else { Some(line) },
        exit_code,
    }
}

/// The readable grouping key and its id: key = "<folded step> · <class>[ · <line>]",
/// id = "f:" + first 12 hex chars of sha256(key).
pub fn key(step: &str, sig: &Signature) -> (String, String) {
    let mut k = format!("{} · {}", fold_step(step), sig.class.as_str());
    if let Some(line) = &sig.line {
        k.push_str(" · ");
        k.push_str(line);
    }
    let digest = Sha256::digest(k.as_bytes());
    let mut id = String::with_capacity(14);
    id.push_str("f:");
    for b in digest.iter().take(6) {
        id.push_str(&format!("{b:02x}"));
    }
    (k, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(|l| l.to_string()).collect()
    }

    fn sig(workflow: &str, step: &str, exit: Option<i32>, text: &str) -> Signature {
        extract(workflow, step, exit, &lines(text))
    }

    fn line_of(s: &Signature) -> &str {
        s.line.as_deref().unwrap_or("")
    }

    #[test]
    fn rust_root_cause_beats_wrappers() {
        let log = "\
   Compiling proc-macro-error-attr v1.0.4
   Compiling my-crate v0.1.0 (/src/crates/my-crate)
warning: unused variable: `y`
error[E0425]: cannot find value `x` in this scope
 --> src/main.rs:3:5
  |
3 |     x + 1
  |     ^ not found in this scope
error: could not compile `my-crate` (bin \"my-crate\") due to 1 previous error
error: recipe `test` failed on line 22 with exit code 101
error: recipe `ci` failed on line 8 with exit code 101
11  : Ci.rust ERROR [21m14s]
┆ Container.withExec ERROR
Error: exit code: 101 [traceparent:0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331]";
        let s = sig("ci", "rust", Some(101), log);
        assert_eq!(s.class, FailClass::Compile);
        assert_eq!(
            line_of(&s),
            "error[E0425]: cannot find value `x` in this scope"
        );
        assert_eq!(s.exit_code, Some(101));
    }

    #[test]
    fn could_not_compile_when_no_code() {
        let log = "error: could not compile `my-crate` (lib)\nerror: recipe `ci` failed on line 8 with exit code 101";
        let s = sig("ci", "rust", Some(101), log);
        assert_eq!(s.class, FailClass::Compile);
        assert_eq!(line_of(&s), "error: could not compile `my-crate` (lib)");
    }

    #[test]
    fn sigkilled_rustc_is_oom() {
        let log = "\
error: could not compile `big-crate` (lib)

Caused by:
  process didn't exit successfully: `/usr/local/rustup/toolchains/stable/bin/rustc --crate-name big_crate --edition=2021 src/lib.rs` (signal: 9, SIGKILL: kill)
warning: build failed, waiting for other jobs to finish...";
        let s = sig("ci", "rust", Some(101), log);
        assert_eq!(s.class, FailClass::Oom);
        assert_eq!(line_of(&s), "error: could not compile `big-crate` (lib)");
    }

    #[test]
    fn tsc_is_typecheck() {
        let log = "> tsc --noEmit\nsrc/app/view.ts(15,19): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\nnpm error code 2";
        let s = sig("ci", "web", Some(2), log);
        assert_eq!(s.class, FailClass::Typecheck);
        assert!(
            line_of(&s).starts_with("src/app/view.ts(N,N): error TS2345: Argument"),
            "{s:?}"
        );
    }

    #[test]
    fn go_and_python_compile_errors() {
        let go = "# my/pkg\n./main.go:12:9: cannot use x (variable of type int) as string value in return statement";
        let s = sig("ci", "go", Some(1), go);
        assert_eq!(s.class, FailClass::Compile);
        assert_eq!(
            line_of(&s),
            "./main.go:N: cannot use x (variable of type int) as string value in return statement"
        );

        let py = "Traceback (most recent call last):\n  File \"/src/app/foo.py\", line 3\n    def f(:\n          ^\nSyntaxError: invalid syntax";
        let s = sig("ci", "check", Some(1), py);
        assert_eq!(s.class, FailClass::Compile);
        assert_eq!(line_of(&s), "SyntaxError: invalid syntax");
    }

    #[test]
    fn pytest_failed_line_wins_over_summary() {
        let log = "\
tests/test_api.py ..F.                                     [100%]
=================================== FAILURES ===================================
E       AssertionError: assert 2 == 3
=========================== short test summary info ============================
FAILED tests/test_api.py::test_create_user - AssertionError: assert 2 == 3
FAILED tests/test_api.py::test_delete_user - KeyError: 'id'
========================= 2 failed, 41 passed in 3.21s =========================";
        let s = sig("ci", "test", Some(1), log);
        assert_eq!(s.class, FailClass::Test);
        assert_eq!(line_of(&s), "FAILED tests/test_api.py::test_create_user");
    }

    #[test]
    fn pytest_summary_alone() {
        let s = sig(
            "ci",
            "test",
            Some(1),
            "==== 2 failed, 41 passed, 1 skipped in 12.50s ====",
        );
        assert_eq!(s.class, FailClass::Test);
        assert_eq!(line_of(&s), "N failed, N passed, N skipped in N.N");
    }

    #[test]
    fn js_and_rust_test_failures() {
        let jest = " PASS  src/ok.test.ts\n FAIL  src/app/cart.test.ts\n  ● cart › adds items\nTest Suites: 1 failed, 3 passed, 4 total";
        let s = sig("ci", "test-web", Some(1), jest);
        assert_eq!(s.class, FailClass::Test);
        assert_eq!(line_of(&s), "FAIL src/app/cart.test.ts");

        let vitest = " ❯ src/app/cart.test.tsx (4 tests | 1 failed) 7650ms\n     × adds items to the cart 5084ms\n     ✓ removes items 117ms";
        let s = sig("ci", "test-web", Some(1), vitest);
        assert_eq!(s.class, FailClass::Test);
        assert_eq!(line_of(&s), "× adds items to the cart N");

        let rust = "running 2 tests\ntest tests::adds ... ok\ntest tests::subtracts ... FAILED\n\nthread 'tests::subtracts' panicked at src/lib.rs:41:9:\nassertion failed\ntest result: FAILED. 1 passed; 1 failed\nerror: test failed, to rerun pass `--lib`";
        let s = sig("ci", "test", Some(101), rust);
        assert_eq!(s.class, FailClass::Test);
        assert_eq!(line_of(&s), "test tests::subtracts ... FAILED");

        let unittest = "test_ok (pkg.T.test_ok) ... ok\nFAIL: test_parse (pkg.ParserTests.test_parse)\nAssertionError: 1 != 2\nFAILED (failures=1)";
        let s = sig("ci", "test", Some(1), unittest);
        assert_eq!(s.class, FailClass::Test);
        assert_eq!(line_of(&s), "FAIL: test_parse (pkg.ParserTests.test_parse)");
    }

    #[test]
    fn lint_tools() {
        let fmt = "Diff in /src/app/server/main.rs at line 12:\n-    let x=1;\n+    let x = 1;";
        let s = sig("ci", "check", Some(1), fmt);
        assert_eq!(s.class, FailClass::Lint);
        assert_eq!(line_of(&s), "Diff in …/server/main.rs at line N:");

        let clippy = "error: this `if` has identical blocks\n  --> src/lib.rs:10:5\n   = note: `-D clippy::if-same-then-else` implied by `-D warnings`";
        let s = sig("ci", "check", Some(101), clippy);
        assert_eq!(s.class, FailClass::Lint);
        assert_eq!(line_of(&s), "error: this `if` has identical blocks");

        let ruff = "Would reformat: src/app/foo.py\n1 file would be reformatted, 20 files already formatted";
        let s = sig("ci", "quality", Some(1), ruff);
        assert_eq!(s.class, FailClass::Lint);
        assert_eq!(line_of(&s), "Would reformat: src/app/foo.py");

        let eslint = "/src/app/web/index.ts\n  12:5  error  'x' is defined but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)";
        let s = sig("ci", "web", Some(1), eslint);
        assert_eq!(s.class, FailClass::Lint);
        assert_eq!(
            line_of(&s),
            "N:N error 'x' is defined but never used no-unused-vars"
        );
    }

    #[test]
    fn deps_failures() {
        let npm = "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree\nnpm ERR! A complete log of this run can be found in: /root/.npm/_logs/2026-01-02T03_04_05_678Z-debug-0.log";
        let s = sig("ci", "web", Some(1), npm);
        assert_eq!(s.class, FailClass::Deps);
        assert_eq!(
            line_of(&s),
            "npm error ERESOLVE unable to resolve dependency tree"
        );

        let py = "Traceback (most recent call last):\n  File \"/src/app/main.py\", line 1, in <module>\n    import requests\nModuleNotFoundError: No module named 'requests'";
        let s = sig("ci", "test", Some(1), py);
        assert_eq!(s.class, FailClass::Deps);
        assert_eq!(
            line_of(&s),
            "ModuleNotFoundError: No module named 'requests'"
        );

        let uv = "error: No solution found when resolving dependencies:\n  cause: Because my-app depends on foo>=2 and foo<2, we can conclude that your requirements are unsatisfiable.";
        let s = sig("ci", "quality", Some(1), uv);
        assert_eq!(s.class, FailClass::Deps);
        assert_eq!(
            line_of(&s),
            "error: No solution found when resolving dependencies:"
        );
    }

    #[test]
    fn security_failures() {
        let leaks = "secrets: gitleaks with the repo's .gitleaks.toml\n11:12PM INF scanned ~1234567 bytes (1.23 MB) in 321ms\n11:12PM WRN leaks found: 2";
        let s = sig("security", "security-scan", Some(1), leaks);
        assert_eq!(s.class, FailClass::Security);
        assert_eq!(line_of(&s), "leaks found: N");

        let trivy = "app:latest (alpine 3.20)\nTotal: 3 (UNKNOWN: 0, LOW: 0, MEDIUM: 1, HIGH: 1, CRITICAL: 1)";
        let s = sig("image", "scan", Some(1), trivy);
        assert_eq!(s.class, FailClass::Security);
        assert_eq!(
            line_of(&s),
            "Total: N (UNKNOWN: N, LOW: N, MEDIUM: N, HIGH: N, CRITICAL: N)"
        );
    }

    #[test]
    fn deploy_failures() {
        let s = sig(
            "deploy",
            "failsafe-deploy",
            Some(1),
            "rolling out my-app\nhealth check failed after 30 attempts",
        );
        assert_eq!(s.class, FailClass::Deploy);
        assert_eq!(line_of(&s), "health check failed after N attempts");

        let s = sig(
            "deploy",
            "deploy",
            Some(1),
            "POST /v1/apps/my-app/deploy\nprovisioning api returned status 503 Service Unavailable",
        );
        assert_eq!(s.class, FailClass::Deploy);
        assert_eq!(
            line_of(&s),
            "provisioning api returned status 503 Service Unavailable"
        );
    }

    #[test]
    fn network_failures() {
        let s = sig(
            "ci",
            "clone",
            Some(128),
            "+ git fetch origin\nfatal: unable to access 'https://github.com/my-org/my-repo.git/': Could not resolve host: github.com\nexit status 128",
        );
        assert_eq!(s.class, FailClass::Network);
        assert_eq!(line_of(&s), "Could not resolve host: github.com");

        let s = sig(
            "ci",
            "test",
            Some(1),
            "connecting to db\nError: connect ECONNREFUSED 127.0.0.1:5432",
        );
        assert_eq!(s.class, FailClass::Network);
        assert_eq!(line_of(&s), "Error: connect ECONNREFUSED N.N.N.N:N");
    }

    #[test]
    fn infra_failures() {
        let s = sig(
            "ci",
            "build",
            Some(1),
            "#5 exporting layers\nERROR: write /var/lib/docker/tmp/x: no space left on device",
        );
        assert_eq!(s.class, FailClass::Infra);
        assert_eq!(line_of(&s), "ERROR: write …/tmp/x: no space left on device");

        let s = sig(
            "ci",
            "test",
            Some(1),
            "Ci.pythonUv DONE [3m47s]\n\nError: Post \"http://dagger/query\": unexpected EOF",
        );
        assert_eq!(s.class, FailClass::Infra);

        let s = sig(
            "ci",
            "clone",
            Some(128),
            "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        );
        assert_eq!(s.class, FailClass::Infra);
        assert_eq!(
            line_of(&s),
            "git@github.com: Permission denied (publickey)."
        );
    }

    #[test]
    fn timeout_and_oom() {
        let s = sig(
            "ci",
            "e2e",
            Some(1),
            "waiting for server\nError: timed out after 600s waiting for http://localhost:3000",
        );
        assert_eq!(s.class, FailClass::Timeout);

        let s = sig(
            "ci",
            "web",
            Some(134),
            "<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\nAborted (core dumped)",
        );
        assert_eq!(s.class, FailClass::Oom);
        assert!(line_of(&s).contains("JavaScript heap out of memory"));

        let s = sig(
            "ci",
            "test",
            Some(137),
            "running tests\nError: exit code: 137",
        );
        assert_eq!(s.class, FailClass::Oom);
        assert_eq!(s.line, None);

        let s = sig("ci", "test", Some(137), "");
        assert_eq!(s.class, FailClass::Oom);
    }

    #[test]
    fn generic_errors() {
        let s = sig(
            "ci",
            "sync",
            Some(1),
            "Auto-merging build.sh\nCONFLICT (content): Merge conflict in build.sh\nerror: could not apply abc1234... tidy",
        );
        assert_eq!(s.class, FailClass::Exit);
        assert_eq!(
            line_of(&s),
            "CONFLICT (content): Merge conflict in build.sh"
        );

        let s = sig(
            "release",
            "flatpak",
            Some(1),
            "Finished release\nerror: Could not connect: No such file or directory",
        );
        assert_eq!(s.class, FailClass::Build);
        assert_eq!(
            line_of(&s),
            "error: Could not connect: No such file or directory"
        );

        let s = sig(
            "ci",
            "script",
            Some(1),
            "doing things\nfatal: not a git repository (or any of the parent directories): .git",
        );
        assert_eq!(s.class, FailClass::Exit);

        let tb = "Traceback (most recent call last):\n  File \"/src/app/run.py\", line 9, in <module>\n{'debug': True}\n    main()\nValueError: invalid literal for int() with base 10: 'abc'";
        let s = sig("ci", "check", Some(1), tb);
        assert_eq!(
            line_of(&s),
            "ValueError: invalid literal for int() with base N: 'abc'"
        );
    }

    #[test]
    fn noise_only_falls_back_to_name() {
        let log = "   Compiling proc-macro-error-attr v1.0.4\nwarning: unused import: `Path`\n0 errors, 0 warnings, 0 informations\n+ cargo test --error-format=json\nall good";
        let s = sig("ci", "lint", Some(1), log);
        assert_eq!(s.class, FailClass::Lint);
        assert_eq!(s.line, None);
    }

    #[test]
    fn empty_log_classes_from_names() {
        let c = |wf: &str, step: &str| extract(wf, step, Some(1), &[]).class;
        assert_eq!(c("ci", "lint"), FailClass::Lint);
        assert_eq!(c("ci", "cargo-fmt"), FailClass::Lint);
        assert_eq!(c("ci", "clippy"), FailClass::Lint);
        assert_eq!(c("ci", "test-web-3"), FailClass::Test);
        assert_eq!(c("ci", "typecheck"), FailClass::Typecheck);
        assert_eq!(c("ci", "mypy"), FailClass::Typecheck);
        assert_eq!(c("deploy", "failsafe-deploy"), FailClass::Deploy);
        assert_eq!(c("security", "scan"), FailClass::Security);
        assert_eq!(c("ci", "gitleaks"), FailClass::Security);
        assert_eq!(c("image", "docker"), FailClass::Build);
        assert_eq!(c("ci", "clone"), FailClass::Exit);
        let s = extract("ci", "clone", Some(128), &[]);
        assert_eq!(s.line, None);
        assert_eq!(s.exit_code, Some(128));
    }

    #[test]
    fn clean_dagger_prefixes_and_ansi() {
        assert_eq!(
            clean_line("73  : ┆ [19m54s] | error: could not compile `x`"),
            "error: could not compile `x`"
        );
        assert_eq!(
            clean_line("11  : Ci.rust ERROR [21m14s]"),
            "Ci.rust ERROR [21m14s]"
        );
        assert_eq!(
            clean_line("┆ Container.withExec ERROR"),
            "Container.withExec ERROR"
        );
        assert_eq!(clean_line("40  : ┆ ┆ name: \"PG_URL\""), "name: \"PG_URL\"");
        assert_eq!(clean_line("1   : [0.0s] | cloud url=x"), "cloud url=x");
        assert_eq!(clean_line("29  : ┆ [4m26s] | │  a | b  │"), "│  a | b  │");
        let ansi = "\u{1b}[95m73  : \u{1b}[0m\u{1b}[90;2m┆ \u{1b}[0m\u{1b}[90m[1m19s] \u{1b}[0m\u{1b}[90m|\u{1b}[0m \u{1b}[1;31merror\u{1b}[0m: boom";
        assert_eq!(clean_line(ansi), "error: boom");
        assert_eq!(
            clean_line("Downloading 10%\rDownloading 50%\rDone\r\n"),
            "Done"
        );
        assert_eq!(
            clean_line("404: not a dagger prefix"),
            "404: not a dagger prefix"
        );
        assert_eq!(
            clean_line("\u{1b}]8;;http://x\u{7}link\u{1b}]8;;\u{7} text"),
            "link text"
        );
    }

    #[test]
    fn normalize_masks_volatile_parts() {
        assert_eq!(
            normalize("error: recipe failed with exit code 101 after 3 tries"),
            "error: recipe failed with exit code 101 after N tries"
        );
        assert_eq!(
            normalize("error[E0308]: mismatched types"),
            "error[E0308]: mismatched types"
        );
        assert_eq!(
            normalize("x.ts(3,4): error TS2345: bad"),
            "x.ts(N,N): error TS2345: bad"
        );
        assert_eq!(
            normalize("at /usr/local/cargo/registry/src/x/y/z.rs:12:5"),
            "at …/y/z.rs:N"
        );
        assert_eq!(
            normalize("commit 0123456789abcdef0123456789abcdef01234567 bad"),
            "commit … bad"
        );
        assert_eq!(
            normalize("id 550e8400-e29b-41d4-a716-446655440000 gone"),
            "id … gone"
        );
        assert_eq!(
            normalize("at 2026-01-02T03:04:05.678Z it broke"),
            "at <time> it broke"
        );
        assert_eq!(normalize("took [19m54s] and 100ms"), "took [N] and N");
        assert_eq!(
            normalize("Error: boom [traceparent:0011223344556677-8899aabbccddeeff]"),
            "Error: boom"
        );
        assert_eq!(
            normalize("got HTTP 503 from upstream"),
            "got HTTP 503 from upstream"
        );
        assert_eq!(
            normalize("server said 502 Bad Gateway"),
            "server said 502 Bad Gateway"
        );
        assert_eq!(
            normalize("could not compile `my-crate2` (lib)"),
            "could not compile `my-crate2` (lib)"
        );
        assert_eq!(normalize("  lots   of\t space  "), "lots of space");
        assert_eq!(
            normalize("GET https://example.com/a/b/c/d.tar.gz?sig=123 failed"),
            "GET https://example.com/…/c/d.tar.gz failed"
        );
        assert_eq!(normalize("ptr 0x7fffdeadbeef freed"), "ptr … freed");
    }

    #[test]
    fn normalize_caps_at_160_chars() {
        let long = format!("error: {}", "word ".repeat(100));
        let n = normalize(&long);
        assert_eq!(n.chars().count(), 160);
        assert!(n.ends_with('…'));
        let short = normalize("error: short");
        assert_eq!(short, "error: short");
    }

    #[test]
    fn same_cause_same_key_across_runs() {
        let run = |sha: &str, n: u32, root: &str, dur: &str| {
            format!(
                "{dur} | Compiling my-crate v0.{n}.0 ({root}/crates/my-crate)\n\
                 error[E0599]: no method named `frob` found for struct `Thing` in the current scope\n  \
                 --> {root}/crates/my-crate/src/lib.rs:{n}:7\n\
                 error: could not compile `my-crate` (lib) due to {n} previous errors\n\
                 Error: exit code: 101 [traceparent:{sha}-{sha}]"
            )
        };
        let a = sig(
            "ci",
            "rust-2",
            Some(101),
            &run(
                "4bf92f3577b34da6a3ce929d0e0e4736",
                3,
                "/home/runner/work/a",
                "[1m09s]",
            ),
        );
        let b = sig(
            "ci",
            "rust-7",
            Some(101),
            &run(
                "0af7651916cd43dd8448eb211c80319c",
                12,
                "/srv/ci/b/c",
                "[19m54s]",
            ),
        );
        assert_eq!(key("rust-2", &a), key("rust-7", &b));

        let p1 = normalize(
            "panicked at /home/runner/work/x/src/a/b.rs:12:5 after 1.5s, sha abc1234, run 9921",
        );
        let p2 = normalize(
            "panicked at /srv/ci/y/z/src/a/b.rs:99:1 after 230.75s, sha 0a1b2c3d4e, run 3",
        );
        assert_eq!(p1, p2);
    }

    #[test]
    fn fold_step_shards() {
        assert_eq!(fold_step("test-web-3"), "test-web-#");
        assert_eq!(fold_step("test_server_12"), "test_server_#");
        assert_eq!(fold_step("shard 2/4"), "shard #/#");
        assert_eq!(fold_step("test (3/8)"), "test (#/#)");
        assert_eq!(fold_step("python-3.9"), "python-3.9");
        assert_eq!(fold_step("e2e"), "e2e");
        assert_eq!(fold_step("build"), "build");
    }

    #[test]
    fn key_format_and_id() {
        let s = Signature {
            class: FailClass::Test,
            line: Some("FAIL src/a.test.ts".into()),
            exit_code: Some(1),
        };
        let (k, id) = key("test-web-3", &s);
        assert_eq!(k, "test-web-# · test · FAIL src/a.test.ts");
        assert!(id.starts_with("f:"));
        assert_eq!(id.len(), 14);
        assert!(id[2..].bytes().all(|b| b.is_ascii_hexdigit()));
        let none = Signature {
            class: FailClass::Exit,
            line: None,
            exit_code: None,
        };
        assert_eq!(key("clone", &none).0, "clone · exit");
        assert_ne!(key("clone", &none).1, id);
    }

    #[test]
    fn class_names_round_trip() {
        let all = [
            FailClass::Compile,
            FailClass::Test,
            FailClass::Lint,
            FailClass::Typecheck,
            FailClass::Deps,
            FailClass::Build,
            FailClass::Deploy,
            FailClass::Security,
            FailClass::Oom,
            FailClass::Timeout,
            FailClass::Network,
            FailClass::Infra,
            FailClass::Exit,
        ];
        for c in all {
            let j = serde_json::to_string(&c).unwrap();
            assert_eq!(j, format!("\"{}\"", c.as_str()));
            assert_eq!(serde_json::from_str::<FailClass>(&j).unwrap(), c);
        }
    }

    #[test]
    fn decode_woodpecker_body() {
        use base64::Engine as _;
        let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        let body = serde_json::json!([
            {"id": 1, "step_id": 7, "time": 0, "line": 0, "data": b64("first\n"), "type": 0},
            {"id": 2, "step_id": 7, "time": 1, "line": 1, "data": null, "type": 0},
            {"id": 3, "step_id": 7, "time": 2, "line": 2, "data": b64("second"), "type": 0},
            {"id": 4, "step_id": 7, "time": 3, "line": 3, "data": b64("error: boom\n"), "type": 0},
        ]);
        let bytes = serde_json::to_vec(&body).unwrap();
        assert_eq!(
            decode_wp_log(&bytes, 100),
            vec!["first", "", "second", "error: boom"]
        );
        assert_eq!(decode_wp_log(&bytes, 2), vec!["second", "error: boom"]);
        assert!(decode_wp_log(&bytes, 0).is_empty());
        assert!(decode_wp_log(b"[]", 10).is_empty());
        assert_eq!(decode_wp_log(b"plain\ntext", 10), vec!["plain", "text"]);
    }

    #[test]
    fn three_thousand_lines_are_fast() {
        let mut text = String::new();
        for i in 0..3000 {
            match i % 6 {
                0 => text.push_str(&format!("\u{1b}[95m{i:<4}: \u{1b}[0m┆ [{i}s] |    Compiling dep-{i} v0.{i}.0\n")),
                1 => text.push_str(&format!("test tests::case_{i} ... ok\n")),
                2 => text.push_str(&format!("warning: unused variable `v{i}` could not be used in module\n")),
                3 => text.push_str(&format!("  /src/app/mod_{i}.py:{i}: DeprecationWarning: the connection timeout is deprecated\n")),
                4 => text.push_str(&format!("{i:<4}: ┆ withExec bash -c 'cargo test --locked && echo error {i}'\n")),
                _ => text.push_str(&format!("INFO request {i} served in {i}ms from host-{i} (service ok)\n")),
            }
        }
        text.push_str("error[E0425]: cannot find value `x` in this scope\nerror: could not compile `my-crate` (lib)\n");
        let log = lines(&text);
        assert_eq!(log.len(), 3002);
        let _warm = extract("ci", "rust", Some(101), &log);
        let start = std::time::Instant::now();
        let s = extract("ci", "rust", Some(101), &log);
        let took = start.elapsed();
        assert_eq!(s.class, FailClass::Compile);
        assert_eq!(
            line_of(&s),
            "error[E0425]: cannot find value `x` in this scope"
        );
        let budget = if cfg!(debug_assertions) { 250 } else { 5 };
        assert!(took.as_millis() < budget, "3,000 lines took {took:?}");
    }

    /// Local harness: `SIG_CORPUS=/tmp/sig-corpus cargo test --lib signature::tests::corpus -- --ignored --nocapture`.
    /// The corpus (`index.json` + raw log bodies) never lives in the repo.
    #[test]
    #[ignore]
    fn corpus() {
        let dir = std::env::var("SIG_CORPUS").unwrap_or_else(|_| "/tmp/sig-corpus".into());
        let Ok(index) = std::fs::read(format!("{dir}/index.json")) else {
            return;
        };
        let index: Vec<serde_json::Value> = serde_json::from_slice(&index).unwrap();
        let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
        for (i, e) in index.iter().enumerate() {
            let file = e["file"].as_str().unwrap();
            let body = std::fs::read(format!("{dir}/{file}")).unwrap();
            let log = decode_wp_log(&body, 3000);
            let step = e["step"].as_str().unwrap_or("");
            let wf = e["workflow"].as_str().unwrap_or("");
            let exit = e["exit_code"].as_i64().map(|x| x as i32);
            let t = std::time::Instant::now();
            let sig = extract(wf, step, exit, &log);
            let dt = t.elapsed();
            let (k, id) = key(step, &sig);
            println!(
                "{i:02} {:<28} {:>4?} {:>6}us {:<9} {}",
                format!("{}/{}", e["repo"].as_str().unwrap_or(""), step),
                exit.unwrap_or(-1),
                dt.as_micros(),
                sig.class.as_str(),
                sig.line.as_deref().unwrap_or("-")
            );
            *counts.entry(format!("{id} {k}")).or_default() += 1;
        }
        println!("--- {} distinct", counts.len());
        for (k, n) in &counts {
            println!("{n:>3}  {k}");
        }
    }
}
