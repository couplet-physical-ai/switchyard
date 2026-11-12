//! A client that resumes after a server restart starts over from the snapshot: its world
//! is the old process's, which the new one never diffed against, so a pipeline the new
//! process does not have would otherwise stay on its board for good.

use switchyard::history::{History, MemHistory};
use switchyard::hub::Hub;

fn hub() -> std::sync::Arc<Hub> {
    Hub::new("e".into(), 64, 64, History::Mem(MemHistory::new(3_600_000)))
}

#[test]
fn a_resume_from_before_the_restart_is_a_reset() {
    let h = hub();
    // Restarted after seq 900 (the restored history's last frame).
    h.set_seq(900);
    // A client that saw frame 900 (or older) from the old process: reset.
    assert!(h.since(900).is_none(), "the old process's last frame");
    assert!(h.since(850).is_none());
    // Frames of this process resume normally.
    let a = h.publish_reset(1);
    assert_eq!(a, 901);
    let b = h.publish(br#"{"op":"event","v":{}}"#, 2);
    assert_eq!(
        h.since(901)
            .unwrap()
            .iter()
            .map(|f| f.seq)
            .collect::<Vec<_>>(),
        vec![b]
    );
    assert!(h.since(b).unwrap().is_empty(), "up to date");
    assert!(h.since(900).is_none(), "still: from before this process");
}

#[test]
fn a_fresh_server_resumes_as_before() {
    // No restored history (demo, first boot): nothing changes.
    let h = hub();
    let s1 = h.publish(br#"{"op":"event","v":{}}"#, 1);
    assert_eq!(h.since(0).unwrap().len(), 1);
    assert!(h.since(s1).unwrap().is_empty());
}
