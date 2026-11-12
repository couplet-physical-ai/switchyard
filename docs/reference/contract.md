# Wire contract

The wire contract defines how the server gives clients a complete fleet snapshot and the ordered changes that follow it. The current protocol is version 0.6; [`contract/CONTRACT.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/contract/CONTRACT.md) is the canonical specification.

## Snapshot and delta stream

A snapshot is the server's complete current state: protocol version, sequence and time, plus arrays of fleet entities. A client loads the snapshot once, then applies newer delta frames in sequence. A delta contains operations such as upsert, patch, remove, dot update, or a transient event. Heartbeats carry the current sequence without changing state; a reset tells the client to fetch a fresh snapshot.

Protocol 0.6 defines these entity kinds: `org`, `repo`, `commit`, `pipeline`, `pr`, `deploy`, `app`, `engine`, `queue`, `lane`, `watcher`, `stats`, `group`, `cluster`, `flake`, and `trend`. The complete field shapes, event types, transports, compatibility rules, and history semantics are in the canonical contract below.

## Fixtures and validation

[`contract/fixtures/snapshot.json`](https://github.com/couplet-physical-ai/switchyard/blob/main/contract/fixtures/snapshot.json) is a representative snapshot. [`contract/fixtures/hour.jsonl`](https://github.com/couplet-physical-ai/switchyard/blob/main/contract/fixtures/hour.jsonl) contains recorded frames used by the mock server and replay tests. The standard-library validator checks fixture shapes, kinds, timestamps, sequence order, and that replaying the frames yields the expected state:

```sh
python3 scripts/ci/validate_fixtures.py contract
```

If the wire shape changes, update the canonical contract and fixtures together, then keep this orientation aligned with protocol version 0.6.

## Canonical contract

The following content is included from the source of truth; it is not duplicated here.

--8<-- "contract/CONTRACT.md"
