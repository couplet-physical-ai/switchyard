# Switchyard — agent notes

## CI/CD

CI runs on **GitHub Actions**, GitHub-hosted runners only (`.github/workflows/`); this repo
does not deploy anything. Check runs with `gh run list`, `gh run watch`, `gh run view --log-failed`.

Workflows (path-filtered, so a client-only change never rebuilds the server):

| File | Runs when | What |
|---|---|---|
| `server.yml` | `server/**`, `contract/**` | `cargo fmt --check`, `clippy -D warnings`, `cargo test`, criterion smoke (`cargo bench -- --test`) |
| `client.yml` | `app/**`, `contract/**` | Exact web build + the app's `*.test.contract` suites on the web host (headless Chromium, Linux) + the mock server's selftest |
| `contract.yml` | `contract/**`, `scripts/ci/**` | `scripts/ci/validate_fixtures.py`: fixtures match `contract/CONTRACT.md` |
| `release-lint.yml` | `.github/**`, `scripts/release*` | `scripts/ci/check_release_shell.py` |
| `security.yml` | every PR and push to main | `scripts/check-no-internal.sh`, gitleaks (`.gitleaks.toml`), osv-scanner (report-only) |
| `dco.yml` | every PR | the required `DCO` check: every commit signed off (`git commit -s`) |

The macOS release does not run on GitHub Actions: `scripts/release.sh <version>` tags the commit and runs
`scripts/release/release-mac-mini.sh`, which builds on the release Mac, signs with the Developer ID,
notarizes and staples, publishes the GitHub release and bumps the cask in
[`couplet-physical-ai/homebrew-tap`](https://github.com/couplet-physical-ai/homebrew-tap); details in
`packaging/RELEASING.md`.

## Public repo

This repository is public. Never commit secrets, tokens, internal hostnames, private IPs,
private org or repo names, or people's emails. Everything site-specific is runtime
configuration: the server reads it from the environment (`server/.env.example` lists every key
with neutral placeholders), the macOS release from its environment (`packaging/RELEASING.md`), and the
real values live with the private deployment. Tests, fixtures and docs use synthetic names
(`Northwind-*` orgs, `*.example.com` hosts). Before pushing, run `scripts/check-no-internal.sh`
and `gitleaks dir . -c .gitleaks.toml`.
