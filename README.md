# Switchyard

**Every commit, pipeline, PR, deploy and app in one living schematic.**

Switchyard is a live control room for a whole CI/CD fleet: commits travel the wires as packets
from push through the Roadrunner and GitHub Actions lanes, gates and deploys to the apps they
land on, with every repo's main line, every open PR and every app's health beside it. A native
macOS app and a web app, fed by one Rust server that keeps the fleet in memory and streams deltas.

[![Latest release](https://img.shields.io/github/v/release/couplet-physical-ai/switchyard?label=macOS&sort=semver)](https://github.com/couplet-physical-ai/switchyard/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

```sh
brew tap couplet-physical-ai/tap && brew trust couplet-physical-ai/tap && brew install --cask switchyard && open -a Switchyard
```

<!--
  Screenshot slots (files under packaging/screenshots/, 2880x1800 PNG, dark):
  yard-macos.png (hero), yard-web.png, mainlines.png, prs.png, journey.png.
  Uncomment the block below once the files are committed.

<p align="center">
  <img src="packaging/screenshots/yard-macos.png" alt="The Yard on macOS: commits as packets travelling from push through CI lanes and gates to deploys and app health" width="100%">
</p>

| Mainlines | PRs | Commit journey | Web |
|---|---|---|---|
| <img src="packaging/screenshots/mainlines.png" alt="Every repo's main branch as a line of commit dots" width="220"> | <img src="packaging/screenshots/prs.png" alt="Every open PR and the step it is stuck on" width="220"> | <img src="packaging/screenshots/journey.png" alt="One commit from push to deploy to health" width="220"> | <img src="packaging/screenshots/yard-web.png" alt="The Yard in a browser" width="220"> |
-->

## What's here

- `app/` — the client, built on [Exact](https://github.com/expo/exact) (web + macOS).
- `server/` — `switchyard-server`, a Rust service that ingests the CI/CD upstreams, keeps the
  fleet's live state in memory and streams deltas to every client.
- `contract/` — the wire contract between the two, with fixtures.

## Install

- **macOS** (Apple Silicon, macOS 14+): the one-liner above. Update with
  `brew update && brew upgrade --cask switchyard`.
- **Web**: <https://switchyard.apps.example.com> (Exowatt SSO).

Details, the dmg route and troubleshooting: [packaging/INSTALL.md](packaging/INSTALL.md).
Releasing: [packaging/RELEASING.md](packaging/RELEASING.md)
(`scripts/release.sh <version>`).

Status: under construction.

License: MIT.
