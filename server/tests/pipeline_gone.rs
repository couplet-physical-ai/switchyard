//! A pipeline Woodpecker deleted (a 404 for its detail) leaves the board: the store
//! drops it and live clients get a remove op for it.

use serde_json::{Value, json};
use switchyard::adapters::woodpecker::WpPipeline;
use switchyard::facts::*;
use switchyard::model::*;
use switchyard::store::{OpOut, Store, StoreConfig};
use switchyard::wire::WireState;

const NOW: Ms = 1_794_340_000_000;
const REPO: &str = "acme/api";

fn pending(n: u64) -> Fact {
    let raw: WpPipeline = serde_json::from_value(json!({
        "number": n, "event": "push", "status": "pending", "branch": "main",
        "commit": "2222222222222222222222222222222222222222", "created": NOW / 1000 - 60,
        "workflows": [{"id": 1, "name": "ci", "state": "pending"}]
    }))
    .unwrap();
    let m = switchyard::adapters::woodpecker::Mapper {
        public_url: "https://ci.example".into(),
        agents: Default::default(),
    };
    m.facts(REPO, 7, &raw).remove(0)
}

fn wire(ops: &[OpOut], w: &mut WireState) {
    for op in ops {
        let mut b = Vec::new();
        op.write_json(&mut b);
        let v: Value = serde_json::from_slice(&b).unwrap();
        w.apply_op(&v);
    }
}

#[test]
fn gone_removes_a_pending_pipeline_and_tells_clients() {
    let id = ids::wp_pipeline(REPO, 61);
    let mut s = Store::new(StoreConfig::default());
    let mut w = WireState::default();
    s.apply(pending(61), true);
    s.apply(pending(62), true);
    wire(&s.flush(NOW), &mut w);
    assert_eq!(s.pipeline(&id).map(|p| p.state), Some(CiState::Pending));
    assert!(w.get(Kind::Pipeline, &id).is_some());

    s.apply(Fact::PipelineGone { id: id.clone() }, true);
    let ops = s.flush(NOW + 1_000);
    assert!(
        ops.contains(&OpOut::Remove {
            kind: Kind::Pipeline,
            id: id.clone()
        }),
        "a remove op for the pipeline: {ops:?}"
    );
    wire(&ops, &mut w);
    assert!(s.pipeline(&id).is_none());
    assert!(!s.table(Kind::Pipeline).contains_key(&id));
    assert!(w.get(Kind::Pipeline, &id).is_none());
    // Its sibling is untouched.
    let other = ids::wp_pipeline(REPO, 62);
    assert!(s.pipeline(&other).is_some());
    assert!(w.get(Kind::Pipeline, &other).is_some());
    // Nothing comes back on later flushes.
    s.tick(NOW + 5_000);
    s.flush(NOW + 5_000);
    assert!(!s.table(Kind::Pipeline).contains_key(&id));
}

#[test]
fn gone_for_an_unknown_pipeline_is_a_no_op() {
    let mut s = Store::new(StoreConfig::default());
    s.apply(pending(62), true);
    s.flush(NOW);
    let before = s.table(Kind::Pipeline).clone();
    s.apply(
        Fact::PipelineGone {
            id: ids::wp_pipeline(REPO, 99),
        },
        true,
    );
    let ops = s.flush(NOW);
    assert!(
        !ops.iter().any(|o| matches!(o, OpOut::Remove { .. })),
        "{ops:?}"
    );
    assert_eq!(s.table(Kind::Pipeline), &before);
}
