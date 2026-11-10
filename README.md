# Switchyard

A live, animated control room for an organisation's whole delivery pipeline: every
commit, every PR, every CI lane and step, every deploy and every app's health, as one
native macOS app and one web app.

- `app/` — the client, built on [Exact](https://github.com/expo/exact) (web + macOS).
- `server/` — `switchyard-server`, a Rust service that ingests the CI/CD upstreams, keeps the
  fleet's live state in memory and streams deltas to every client.
- `contract/` — the wire contract between the two, with fixtures.

## Install (macOS, Apple Silicon)

```sh
brew tap couplet-physical-ai/tap && brew trust couplet-physical-ai/tap && brew install --cask switchyard && open -a Switchyard
```

Web: <https://switchyard.apps.example.com>. Details, the dmg route and troubleshooting:
[packaging/INSTALL.md](packaging/INSTALL.md). Releasing: [packaging/RELEASING.md](packaging/RELEASING.md)
(`scripts/release.sh <version>`).

Status: under construction.

License: MIT.
