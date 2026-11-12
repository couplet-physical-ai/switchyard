//! Replay ring: every published frame, plus snapshot checkpoints, kept for
//! 24 h+ (on disk in live mode, in memory in demo mode). `/api/v1/history`
//! answers `{from, to, base, frames}` where `base` is the checkpoint at or
//! before `from` and `frames` are every frame after it up to `to`; a state
//! discontinuity (restart) appears as a `{"t":"snapshot",...}` entry.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use parking_lot::Mutex;

use crate::hub::{Frame, FrameKind, Snapshot};
use crate::model::Ms;
use crate::store::H;

pub const CHECKPOINT_EVERY_MS: Ms = 5 * 60_000;
pub const KEEP_MS: Ms = 25 * H;
pub const MAX_WINDOW_MS: Ms = 3 * H;

pub enum History {
    Off,
    Mem(MemHistory),
    Disk(DiskHistory),
}

pub struct HistoryOut {
    pub base: Bytes,
    pub base_seq: u64,
    pub base_at: Ms,
    /// Each item is one JSON value (a frame, or a `t:"snapshot"` rebase).
    pub frames: Vec<Bytes>,
}

impl HistoryOut {
    pub fn to_json(&self, from: Ms, to: Ms) -> Vec<u8> {
        let total: usize =
            self.frames.iter().map(|f| f.len() + 1).sum::<usize>() + self.base.len() + 128;
        let mut v = Vec::with_capacity(total);
        write!(v, "{{\"from\":{from},\"to\":{to},\"base\":").ok();
        v.extend_from_slice(&self.base);
        v.extend_from_slice(b",\"frames\":[");
        for (i, f) in self.frames.iter().enumerate() {
            if i > 0 {
                v.push(b',');
            }
            v.extend_from_slice(f);
        }
        v.extend_from_slice(b"]}");
        v
    }
}

fn snapshot_entry(s: &Snapshot) -> Bytes {
    let mut v = Vec::with_capacity(s.json.len() + 64);
    write!(
        v,
        "{{\"t\":\"snapshot\",\"seq\":{},\"at\":{},\"v\":",
        s.seq, s.at
    )
    .ok();
    v.extend_from_slice(&s.json);
    v.push(b'}');
    Bytes::from(v)
}

impl History {
    pub fn append(&self, f: &Arc<Frame>) {
        match self {
            History::Off => {}
            History::Mem(m) => m.append(f),
            History::Disk(d) => d.append(f),
        }
    }

    pub fn checkpoint(&self, s: &Arc<Snapshot>) {
        match self {
            History::Off => {}
            History::Mem(m) => m.checkpoint(s),
            History::Disk(d) => d.checkpoint(s),
        }
    }

    pub fn query(&self, from: Ms, to: Ms) -> Option<HistoryOut> {
        match self {
            History::Off => None,
            History::Mem(m) => m.query(from, to),
            History::Disk(d) => d.query(from, to),
        }
    }

    /// The fleet as last recorded (the last checkpoint plus every frame after it), when
    /// its newest entry is at most `max_age` old: what a warm boot serves while the
    /// store rebuilds. None without history or when it is older.
    pub fn last_state(&self, now: Ms, max_age: Ms, protocol: &str, epoch: &str) -> Option<Bytes> {
        let h = self.query(now, now)?;
        let newest = h
            .frames
            .iter()
            .filter_map(|f| parse_num(f, b"\"at\":"))
            .map(|a| a as Ms)
            .max()
            .unwrap_or(0)
            .max(h.base_at);
        if newest <= 0 || now - newest > max_age {
            return None;
        }
        Some(h.fold_to(now, true, protocol, epoch).1.base)
    }

    /// Last seq recorded (so a restart continues numbering).
    pub fn last_seq(&self) -> u64 {
        match self {
            History::Disk(d) => d.last_seq(),
            _ => 0,
        }
    }
}

// ---------------------------------------------------------------- memory

pub struct MemHistory {
    inner: Mutex<MemInner>,
    keep_ms: Ms,
}

struct MemInner {
    frames: VecDeque<Arc<Frame>>,
    checkpoints: VecDeque<Arc<Snapshot>>,
}

impl MemHistory {
    pub fn new(keep_ms: Ms) -> MemHistory {
        MemHistory {
            inner: Mutex::new(MemInner {
                frames: VecDeque::new(),
                checkpoints: VecDeque::new(),
            }),
            keep_ms,
        }
    }

    fn append(&self, f: &Arc<Frame>) {
        let mut g = self.inner.lock();
        g.frames.push_back(f.clone());
        let cut = f.at - self.keep_ms;
        while g.frames.front().is_some_and(|x| x.at < cut) {
            g.frames.pop_front();
        }
    }

    fn checkpoint(&self, s: &Arc<Snapshot>) {
        let mut g = self.inner.lock();
        let after_reset = g.frames.back().is_some_and(|f| f.kind == FrameKind::Reset);
        if !after_reset
            && g.checkpoints
                .back()
                .is_some_and(|c| s.at - c.at < CHECKPOINT_EVERY_MS)
        {
            return;
        }
        g.checkpoints.push_back(s.clone());
        let cut = s.at - self.keep_ms;
        while g.checkpoints.len() > 1 && g.checkpoints.front().is_some_and(|x| x.at < cut) {
            g.checkpoints.pop_front();
        }
    }

    fn query(&self, from: Ms, to: Ms) -> Option<HistoryOut> {
        let g = self.inner.lock();
        let base = g
            .checkpoints
            .iter()
            .rev()
            .find(|c| c.at <= from)
            .or_else(|| g.checkpoints.front())?
            .clone();
        let mut frames = Vec::new();
        for f in g.frames.iter() {
            if f.seq <= base.seq || f.at > to {
                continue;
            }
            if f.kind == FrameKind::Reset {
                // The snapshot published right after a reset carries the reset's seq.
                if let Some(c) = g.checkpoints.iter().find(|c| c.seq == f.seq) {
                    frames.push(snapshot_entry(c));
                }
                continue;
            }
            frames.push(f.json.clone());
        }
        Some(HistoryOut {
            base: base.json.clone(),
            base_seq: base.seq,
            base_at: base.at,
            frames,
        })
    }
}

// ---------------------------------------------------------------- disk

/// Layout: `<dir>/frames/<hour_start_ms>.jsonl` (one frame per line) and
/// `<dir>/ckpt/<at_ms>-<seq>.json.gz`. Files older than 25 h are deleted.
pub struct DiskHistory {
    dir: PathBuf,
    inner: Mutex<DiskInner>,
}

struct DiskInner {
    hour: Ms,
    writer: Option<BufWriter<fs::File>>,
    last_ckpt_at: Ms,
    last_was_reset: bool,
    last_seq: u64,
}

impl DiskHistory {
    pub fn open(dir: &Path) -> std::io::Result<DiskHistory> {
        fs::create_dir_all(dir.join("frames"))?;
        fs::create_dir_all(dir.join("ckpt"))?;
        let d = DiskHistory {
            dir: dir.to_path_buf(),
            inner: Mutex::new(DiskInner {
                hour: 0,
                writer: None,
                last_ckpt_at: 0,
                last_was_reset: false,
                last_seq: 0,
            }),
        };
        let last = d.scan_last_seq();
        d.inner.lock().last_seq = last;
        Ok(d)
    }

    fn scan_last_seq(&self) -> u64 {
        let mut files = list(&self.dir.join("frames"), ".jsonl");
        files.sort();
        let mut best = 0;
        if let Some((_, p)) = files.last()
            && let Ok(f) = fs::File::open(p)
        {
            for line in BufReader::new(f).lines().map_while(Result::ok) {
                if let Some(seq) = parse_seq(line.as_bytes()) {
                    best = best.max(seq);
                }
            }
        }
        for (_, p) in list(&self.dir.join("ckpt"), ".json.gz") {
            if let Some(seq) = p
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.trim_end_matches(".json.gz").split('-').nth(1))
                .and_then(|s| s.parse().ok())
            {
                best = best.max(seq);
            }
        }
        best
    }

    fn last_seq(&self) -> u64 {
        self.inner.lock().last_seq
    }

    fn append(&self, f: &Arc<Frame>) {
        let mut g = self.inner.lock();
        let hour = f.at - f.at.rem_euclid(H);
        if g.writer.is_none() || g.hour != hour {
            if let Some(w) = g.writer.as_mut() {
                w.flush().ok();
            }
            let path = self.dir.join("frames").join(format!("{hour}.jsonl"));
            g.writer = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok()
                .map(BufWriter::new);
            g.hour = hour;
            self.prune(f.at);
        }
        if let Some(w) = g.writer.as_mut() {
            w.write_all(&f.json).ok();
            w.write_all(b"\n").ok();
            // Frames are small and few per second: flush so a query sees them.
            w.flush().ok();
        }
        g.last_was_reset = f.kind == FrameKind::Reset;
        g.last_seq = g.last_seq.max(f.seq);
    }

    fn checkpoint(&self, s: &Arc<Snapshot>) {
        let mut g = self.inner.lock();
        if !g.last_was_reset && s.at - g.last_ckpt_at < CHECKPOINT_EVERY_MS {
            return;
        }
        g.last_ckpt_at = s.at;
        g.last_was_reset = false;
        let path = self
            .dir
            .join("ckpt")
            .join(format!("{}-{}.json.gz", s.at, s.seq));
        let tmp = path.with_extension("tmp");
        if fs::write(&tmp, &s.gzip).is_ok() {
            fs::rename(&tmp, &path).ok();
        }
    }

    fn prune(&self, now: Ms) {
        let cut = now - KEEP_MS;
        for sub in ["frames", "ckpt"] {
            for (at, p) in list(&self.dir.join(sub), "") {
                if at < cut - H {
                    fs::remove_file(p).ok();
                }
            }
        }
    }

    fn query(&self, from: Ms, to: Ms) -> Option<HistoryOut> {
        let mut ckpts = list(&self.dir.join("ckpt"), ".json.gz");
        ckpts.sort();
        let (base_at, base_path) = ckpts
            .iter()
            .rev()
            .find(|(at, _)| *at <= from)
            .or_else(|| ckpts.first())?
            .clone();
        let ck_seq = |p: &Path| -> u64 {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.trim_end_matches(".json.gz").split('-').nth(1))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0)
        };
        let base_seq = ck_seq(&base_path);
        let base = gunzip_file(&base_path)?;
        let mut files = list(&self.dir.join("frames"), ".jsonl");
        files.sort();
        let mut frames = Vec::new();
        for (hour, p) in files {
            if hour + H < base_at || hour > to {
                continue;
            }
            let Ok(f) = fs::File::open(&p) else { continue };
            for line in BufReader::new(f).split(b'\n').map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                let Some(seq) = parse_seq(&line) else {
                    continue;
                };
                let at = parse_num(&line, b"\"at\":").unwrap_or(0) as Ms;
                if seq <= base_seq || at > to {
                    continue;
                }
                if line.starts_with(b"{\"t\":\"reset\"") {
                    // The checkpoint written right after a reset carries the reset's seq.
                    if let Some((cat, cp)) = ckpts.iter().find(|(_, cp)| ck_seq(cp) == seq)
                        && let Some(b) = gunzip_file(cp)
                    {
                        let mut v = Vec::with_capacity(b.len() + 64);
                        write!(v, "{{\"t\":\"snapshot\",\"seq\":{seq},\"at\":{cat},\"v\":").ok();
                        v.extend_from_slice(&b);
                        v.push(b'}');
                        frames.push(Bytes::from(v));
                    }
                    continue;
                }
                frames.push(Bytes::from(line));
            }
        }
        Some(HistoryOut {
            base,
            base_seq,
            base_at,
            frames,
        })
    }
}

fn list(dir: &Path, suffix: &str) -> Vec<(Ms, PathBuf)> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.filter_map(Result::ok)
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            if !name.ends_with(suffix) || name.ends_with(".tmp") {
                return None;
            }
            let at: Ms = name.split(['.', '-']).next()?.parse().ok()?;
            Some((at, p))
        })
        .collect()
}

fn gunzip_file(p: &Path) -> Option<Bytes> {
    let f = fs::File::open(p).ok()?;
    let mut d = flate2::read::GzDecoder::new(f);
    let mut v = Vec::new();
    d.read_to_end(&mut v).ok()?;
    Some(Bytes::from(v))
}

fn parse_num(line: &[u8], key: &[u8]) -> Option<u64> {
    let i = line.windows(key.len()).position(|w| w == key)? + key.len();
    let digits: Vec<u8> = line[i..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .cloned()
        .collect();
    std::str::from_utf8(&digits).ok()?.parse().ok()
}

fn parse_seq(line: &[u8]) -> Option<u64> {
    parse_num(line, b"\"seq\":")
}

impl HistoryOut {
    /// Fold every entry before `at` (or at it, when `inclusive`) into the base, so the
    /// base is the fleet's state at `at` and only the later frames remain. A
    /// `t:"snapshot"` entry (server restart) replaces the state. Returns the effective
    /// start (`at`, or the oldest retained checkpoint when `at` is older).
    /// True when a server restart (`t:"snapshot"` entry) falls inside the window.
    pub fn has_restarts(&self) -> bool {
        self.frames
            .iter()
            .any(|f| f.starts_with(b"{\"t\":\"snapshot\""))
    }

    /// Replace each `t:"snapshot"` entry (a whole fleet, megabytes) by one `t:"delta"`
    /// carrying only what the restart changed against the replayed state. Needs a base.
    pub fn inline_restarts(self, patch: bool) -> HistoryOut {
        use crate::wire::{WireState, state_diff};
        use serde_json::Value;
        if !self.has_restarts() {
            return self;
        }
        let base: Value = serde_json::from_slice(&self.base).unwrap_or(Value::Null);
        let mut st = WireState::from_snapshot(&base);
        let mut frames = Vec::with_capacity(self.frames.len());
        for f in self.frames {
            let Ok(v) = serde_json::from_slice::<Value>(&f) else {
                continue;
            };
            if v.get("t").and_then(Value::as_str) == Some("snapshot") {
                let next = WireState::from_snapshot(v.get("v").unwrap_or(&Value::Null));
                let d = serde_json::json!({
                    "t": "delta",
                    "seq": v.get("seq").cloned().unwrap_or(Value::Null),
                    "at": v.get("at").cloned().unwrap_or(Value::Null),
                    "ops": state_diff(&st, &next, patch),
                });
                st = next;
                frames.push(Bytes::from(d.to_string()));
            } else {
                st.apply_frame(&v);
                frames.push(f);
            }
        }
        HistoryOut { frames, ..self }
    }

    /// No base (`null`) and only the entries strictly after `at`.
    pub fn after(self, at: Ms) -> HistoryOut {
        let frames = self
            .frames
            .into_iter()
            .filter(|f| parse_num(f, b"\"at\":").unwrap_or(0) as Ms > at)
            .collect();
        HistoryOut {
            base: Bytes::from_static(b"null"),
            base_seq: 0,
            base_at: at,
            frames,
        }
    }

    pub fn fold_to(self, at: Ms, inclusive: bool, protocol: &str, epoch: &str) -> (Ms, HistoryOut) {
        use crate::wire::WireState;
        use serde_json::Value;
        let start = at.max(self.base_at);
        let base: Value = serde_json::from_slice(&self.base).unwrap_or(Value::Null);
        let mut st = WireState::from_snapshot(&base);
        let mut rest = Vec::new();
        for f in self.frames {
            let (seq, fat) = (
                parse_seq(&f).unwrap_or(0),
                parse_num(&f, b"\"at\":").unwrap_or(0) as Ms,
            );
            let before = if inclusive { fat <= start } else { fat < start };
            if !before {
                rest.push(f);
                continue;
            }
            let Ok(v) = serde_json::from_slice::<Value>(&f) else {
                continue;
            };
            match v.get("t").and_then(Value::as_str) {
                Some("snapshot") => {
                    st = WireState::from_snapshot(v.get("v").unwrap_or(&Value::Null))
                }
                Some("delta") => {
                    st.apply_frame(&v);
                }
                _ => {}
            }
            st.seq = st.seq.max(seq);
        }
        st.at = start;
        let json = serde_json::to_vec(&st.to_snapshot(protocol, epoch)).unwrap_or_default();
        let out = HistoryOut {
            base: Bytes::from(json),
            base_seq: st.seq,
            base_at: start,
            frames: rest,
        };
        (start, out)
    }
}
