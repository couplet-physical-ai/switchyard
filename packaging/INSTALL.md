# Install Switchyard on a Mac

Switchyard's macOS app runs on **Apple Silicon** Macs with **macOS 14 (Sonoma) or newer** and
connects to <https://switchyard.apps.example.com> (sign in with your Exowatt Google account).

## With Homebrew (recommended)

Paste this into Terminal:

```sh
brew tap couplet-physical-ai/tap && brew trust couplet-physical-ai/tap && brew install --cask switchyard && open -a Switchyard
```

What each part does:

1. `brew tap couplet-physical-ai/tap` adds the public tap
   ([couplet-physical-ai/homebrew-tap](https://github.com/couplet-physical-ai/homebrew-tap)).
   No GitHub token is needed.
2. `brew trust couplet-physical-ai/tap` tells Homebrew (7+) to load casks from this
   non-official tap; without it Homebrew refuses with *"Refusing to load cask … from untrusted
   tap"*. On an older Homebrew, where `brew trust` does not exist, skip it.
3. `brew install --cask switchyard` downloads the release zip, checks its sha256, installs
   `/Applications/Switchyard.app` and removes the download quarantine flag (the app is
   ad-hoc signed; there is no Apple Developer ID), so it opens without a Gatekeeper prompt.

Update: `brew update && brew upgrade --cask switchyard`. Remove: `brew uninstall --cask switchyard`
(add `--zap` to also remove its settings and caches).

## First run: connect the app

The app needs a **device token** (your own, revocable). Mint it in the browser, signed in
with your Exowatt Google account:

1. Open <https://switchyard.apps.example.com/connect> and click **Create device token**.
2. Click **Open in Switchyard**: the app opens on *Connect to this server?*; click **Connect**.
3. If the app does not come forward (an older build without the `switchyard://` link), click
   **Copy token** instead, then in Switchyard click **Connect…** (or the status at the top
   right), leave **Server** as `https://switchyard.apps.example.com`, paste the token into
   **Token**, and click **Connect**. The token is kept in the macOS Keychain.

The top-right status then reads `live · switchyard.apps.example.com`. No server handy?
**Watch the demo** runs a built-in simulated fleet.

## Without Homebrew

1. Download `Switchyard-<version>-arm64.dmg` from the
   [latest release](https://github.com/couplet-physical-ai/switchyard/releases/latest)
   (`SHA256SUMS` lists the checksums: `shasum -a 256 -c SHA256SUMS`).
2. Open it and drag **Switchyard** onto **Applications**.
3. Remove the quarantine flag once, then open it:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Switchyard.app && open -a Switchyard
   ```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Refusing to load cask couplet-physical-ai/tap/switchyard from untrusted tap` | `brew trust couplet-physical-ai/tap`, then install again |
| `Error: Cask 'switchyard' is unavailable` | `brew update`, or `brew untap couplet-physical-ai/tap && brew tap couplet-physical-ai/tap` |
| *"Switchyard" is damaged / can't be opened* | the quarantine flag is still set: `xattr -dr com.apple.quarantine /Applications/Switchyard.app` |
| `depends_on arch: :arm64` | Intel Macs are not supported; use the web app at https://switchyard.apps.example.com |
| The app shows *Connect Switchyard to a server* | mint a token at https://switchyard.apps.example.com/connect (see First run above) |
| The app opens but shows no data | check you can open https://switchyard.apps.example.com in a browser (Exowatt SSO; on the company network or VPN if required) |

Release notes and every build: <https://github.com/couplet-physical-ai/switchyard/releases>.
