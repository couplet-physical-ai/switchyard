//! Fan-out: frames are encoded ONCE (bytes) and shared by every client through a
//! bounded broadcast channel. A ring of recent frames serves `?since=` resumes;
//! a lagging client gets `{"t":"reset"}` instead of an unbounded queue.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use bytes::Bytes;
use parking_lot::{Mutex, RwLock};
use tokio::sync::broadcast;

use crate::history::History;
use crate::model::Ms;
use crate::store::OpOut;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    Delta,
    Reset,
}

#[derive(Debug)]
pub struct Frame {
    pub kind: FrameKind,
    pub seq: u64,
    pub at: Ms,
    /// The complete frame JSON.
    pub json: Bytes,
    /// The inside of the ops array (zero-copy slice of `json`), for merging.
    pub ops: Bytes,
}

impl Frame {
    pub fn delta(seq: u64, at: Ms, ops_inner: &[u8]) -> Frame {
        let mut v = Vec::with_capacity(ops_inner.len() + 64);
        write!(v, "{{\"t\":\"delta\",\"seq\":{seq},\"at\":{at},\"ops\":[").ok();
        let start = v.len();
        v.extend_from_slice(ops_inner);
        let end = v.len();
        v.extend_from_slice(b"]}");
        let json = Bytes::from(v);
        let ops = json.slice(start..end);
        Frame {
            kind: FrameKind::Delta,
            seq,
            at,
            json,
            ops,
        }
    }

    pub fn reset(seq: u64, at: Ms) -> Frame {
        let json = Bytes::from(format!("{{\"t\":\"reset\",\"seq\":{seq},\"at\":{at}}}"));
        Frame {
            kind: FrameKind::Reset,
            seq,
            at,
            json,
            ops: Bytes::new(),
        }
    }

    /// Merge consecutive delta frames into one (seq/at of the last).
    pub fn merge(frames: &[Arc<Frame>]) -> Bytes {
        if frames.len() == 1 {
            return frames[0].json.clone();
        }
        let last = frames.last().expect("non-empty");
        let total: usize = frames.iter().map(|f| f.ops.len() + 1).sum();
        let mut v = Vec::with_capacity(total + 64);
        write!(
            v,
            "{{\"t\":\"delta\",\"seq\":{},\"at\":{},\"ops\":[",
            last.seq, last.at
        )
        .ok();
        let mut first = true;
        for f in frames {
            if f.ops.is_empty() {
                continue;
            }
            if !first {
                v.push(b',');
            }
            first = false;
            v.extend_from_slice(&f.ops);
        }
        v.extend_from_slice(b"]}");
        Bytes::from(v)
    }
}

pub fn heartbeat(seq: u64, at: Ms) -> Bytes {
    Bytes::from(format!("{{\"t\":\"hb\",\"seq\":{seq},\"at\":{at}}}"))
}

/// Largest message the server sends on a stream (clients default to a 1 MiB ceiling).
/// Bigger flushes become several frames; catch-up merges stop at this size.
pub const MAX_MESSAGE: usize = 512 * 1024;

/// Encode ops as the insides of JSON arrays, each at most [`MAX_MESSAGE`] bytes (one op
/// larger than that goes alone). Ops keep their order across chunks.
pub fn encode_ops_chunked(ops: &[OpOut]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut cur: Vec<u8> = Vec::with_capacity(ops.len().min(512) * 256);
    let mut one = Vec::new();
    for op in ops {
        one.clear();
        op.write_json(&mut one);
        if !cur.is_empty() && cur.len() + 1 + one.len() > MAX_MESSAGE - 128 {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(b',');
        }
        cur.extend_from_slice(&one);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Encode ops as the inside of a JSON array.
pub fn encode_ops(ops: &[OpOut]) -> Vec<u8> {
    let mut v = Vec::with_capacity(ops.len() * 256);
    for (i, op) in ops.iter().enumerate() {
        if i > 0 {
            v.push(b',');
        }
        op.write_json(&mut v);
    }
    v
}

#[derive(Debug)]
pub struct Snapshot {
    pub seq: u64,
    pub at: Ms,
    pub json: Bytes,
    pub gzip: Bytes,
}

impl Snapshot {
    pub fn new(seq: u64, at: Ms, json: Bytes) -> Snapshot {
        let gzip = gzip(&json);
        Snapshot {
            seq,
            at,
            json,
            gzip,
        }
    }
}

pub fn gzip(b: &[u8]) -> Bytes {
    let mut e = flate2::write::GzEncoder::new(
        Vec::with_capacity(b.len() / 6 + 64),
        flate2::Compression::new(5),
    );
    e.write_all(b).ok();
    Bytes::from(e.finish().unwrap_or_default())
}

pub struct Hub {
    pub tx: broadcast::Sender<Arc<Frame>>,
    ring: Mutex<VecDeque<Arc<Frame>>>,
    ring_cap: usize,
    snapshot: RwLock<Arc<Snapshot>>,
    seq: AtomicU64,
    pub epoch: String,
    pub history: History,
    pub clients: AtomicU64,
    pub frames_sent: AtomicU64,
    pub resets_sent: AtomicU64,
    /// Booting: frames go to clients but not into history (see [`Hub::begin_settle`]).
    settling: std::sync::atomic::AtomicBool,
}

impl Hub {
    pub fn new(epoch: String, channel_cap: usize, ring_cap: usize, history: History) -> Arc<Hub> {
        let (tx, _) = broadcast::channel(channel_cap);
        Arc::new(Hub {
            tx,
            ring: Mutex::new(VecDeque::with_capacity(ring_cap)),
            ring_cap,
            snapshot: RwLock::new(Arc::new(Snapshot::new(0, 0, Bytes::from_static(b"{}")))),
            seq: AtomicU64::new(0),
            epoch,
            history,
            clients: AtomicU64::new(0),
            frames_sent: AtomicU64::new(0),
            resets_sent: AtomicU64::new(0),
            settling: std::sync::atomic::AtomicBool::new(false),
        })
    }

    /// Start a boot: until [`Hub::end_settle`], frames and snapshots reach clients but
    /// not history, so the fleet filling up from empty (megabytes of backfill) never
    /// lands in `/history`.
    pub fn begin_settle(&self) {
        self.settling.store(true, Ordering::Release);
    }

    pub fn is_settling(&self) -> bool {
        self.settling.load(Ordering::Acquire)
    }

    /// End the boot with the settled fleet: history records one restart (a reset marker
    /// plus this snapshot, at the current seq), which `/history` sends as a delta holding
    /// only what changed across the restart. Live clients see nothing.
    pub fn end_settle(&self, s: Snapshot) {
        let s = Arc::new(s);
        self.history.append(&Arc::new(Frame::reset(s.seq, s.at)));
        self.history.checkpoint(&s);
        {
            let mut cur = self.snapshot.write();
            if s.seq >= cur.seq {
                *cur = s.clone();
            }
        }
        self.settling.store(false, Ordering::Release);
    }

    pub fn seq(&self) -> u64 {
        self.seq.load(Ordering::Acquire)
    }

    /// Continue numbering after a known seq (e.g. a restored state).
    pub fn set_seq(&self, seq: u64) {
        self.seq.store(seq, Ordering::Release);
    }

    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot.read().clone()
    }

    /// Replace the served snapshot (never with an older one).
    pub fn set_snapshot(&self, s: Snapshot) {
        let s = Arc::new(s);
        {
            let mut cur = self.snapshot.write();
            if cur.seq > s.seq || (cur.seq == s.seq && cur.at > s.at) {
                return;
            }
            *cur = s.clone();
        }
        if !self.is_settling() {
            self.history.checkpoint(&s);
        }
    }

    /// Replace the snapshot unconditionally (demo loops restart the timeline).
    pub fn force_snapshot(&self, s: Snapshot) {
        let s = Arc::new(s);
        *self.snapshot.write() = s.clone();
        if !self.is_settling() {
            self.history.checkpoint(&s);
        }
    }

    /// Publish one delta frame of already-encoded ops. Returns its seq.
    pub fn publish(&self, ops_inner: &[u8], at: Ms) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::AcqRel) + 1;
        let f = Arc::new(Frame::delta(seq, at, ops_inner));
        self.push(f);
        seq
    }

    /// Tell every client to refetch the snapshot (state discontinuity).
    pub fn publish_reset(&self, at: Ms) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::AcqRel) + 1;
        let f = Arc::new(Frame::reset(seq, at));
        self.push(f);
        seq
    }

    fn push(&self, f: Arc<Frame>) {
        if !self.is_settling() {
            self.history.append(&f);
        }
        {
            let mut r = self.ring.lock();
            if r.len() == self.ring_cap {
                r.pop_front();
            }
            r.push_back(f.clone());
        }
        let _ = self.tx.send(f);
    }

    /// Frames after `since` from the ring, or None when `since` is too old (or
    /// from another epoch) and the client must reset.
    pub fn since(&self, since: u64) -> Option<Vec<Arc<Frame>>> {
        let r = self.ring.lock();
        let cur = self.seq();
        if since > cur {
            return None;
        }
        if since == cur {
            return Some(Vec::new());
        }
        let first = r.front().map(|f| f.seq)?;
        if since + 1 < first {
            return None;
        }
        Some(r.iter().filter(|f| f.seq > since).cloned().collect())
    }
}
