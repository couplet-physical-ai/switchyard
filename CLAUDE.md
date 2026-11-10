# Switchyard — agent notes

## CI/CD

This repo runs its CI on **Roadrunner** (Exowatt's Woodpecker + Dagger CI, `.woodpecker/`); it does not deploy from there. Check builds with `gh rr status`, `gh rr watch`, `gh rr logs`, `gh rr rerun` (install: `gh extension install Northwind-Labs/gh-ci && gh alias set rr roadrunner --clobber`) — `gh run` only sees GitHub Actions. Console: https://cicd.apps.example.com.

Pipelines (path-filtered, so a client-only change never rebuilds the server):

| File | Runs when | What |
|---|---|---|
| `.woodpecker/server.yaml` | `server/**`, `contract/**` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, criterion smoke (`cargo bench -- --test`) |
| `.woodpecker/client.yaml` | `app/**`, `contract/**` | Exact web build + the app's `*.test.contract` suites on the web host (headless Chromium, Linux) |
| `.woodpecker/contract.yaml` | `contract/**`, `scripts/ci/**` | `scripts/ci/validate_fixtures.py`: fixtures match `contract/CONTRACT.md` |
| `.woodpecker/security.yaml` | every PR and push to main | gitleaks (`.gitleaks.toml`: default rules + internal IPs / lab hostnames) and osv-scanner |

macOS releases are the exception: they build on **GitHub Actions** macOS runners
(`.github/workflows/release.yml`, tag `v*`), publish a GitHub release and bump the cask in
[`couplet-physical-ai/homebrew-tap`](https://github.com/couplet-physical-ai/homebrew-tap).
Check those with `gh run list -w release.yml`. One command cuts a release: `scripts/release.sh <version>`; details in `packaging/RELEASING.md`.

## Public repo

This repository is public. Never commit secrets, tokens, internal IPs (`192.168.*`, `10.*`),
`*.lab.example.com` hostnames or people's emails; internal endpoints come from env at
deploy time. Run `gitleaks dir . -c .gitleaks.toml` before pushing.
