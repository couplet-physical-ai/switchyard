# Install Switchyard on a Mac

Switchyard's macOS app runs on **Apple Silicon** Macs with **macOS 14 (Sonoma) or newer** and
connects to your team's Switchyard server (sign in with your organization's single sign-on).
This guide writes that server as `https://switchyard.example.com`; use your own. The full
documentation, including this guide, is in [`docs/`](../docs/index.md).

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

Update: the app updates itself (**Update** in the app, fed by the release's `latest.json`); the
cask is marked `auto_updates`, so plain `brew upgrade` leaves it alone and
`brew upgrade --cask --greedy switchyard` forces it. Remove: `brew uninstall --cask switchyard`
(add `--zap` to also remove its settings and caches).

## Already have the early test build (v0.0.3)?

v0.0.3 has no in-app updater, so move it to the current release with Homebrew once; from then
on the app updates itself:

```sh
brew update && brew upgrade --cask --greedy switchyard && open -a Switchyard
```

If that says it is already up to date, or anything looks off, reinstall:

```sh
brew uninstall --cask switchyard; brew update && brew install --cask switchyard && open -a Switchyard
```

Check the installed version with
`defaults read /Applications/Switchyard.app/Contents/Info CFBundleShortVersionString`.
(`brew info` keeps showing the version brew installed; the app's own updates don't change it.)

## First run: connect the app

The app needs a **device token** (your own, revocable). On first launch it offers
**Sign in on the web…** (opens the page below), **Use a token…** and **Watch the demo**. In the
browser, signed in with your organization account:

1. Open `https://switchyard.example.com/connect` (or click **Sign in on the web…**) and
   click **Create device token**.
2. Click **Open in Switchyard**. macOS opens the app (a `switchyard://connect` link) on
   *Connect to this server?*.
3. Click **Connect**. The token is saved only now, after you confirm, in a private file
   (`~/Library/Application Support/com.exowatt.switchyard/token`, mode `0600`).

The top-right status then reads `live · <your server>`.

**Fallback** (the link does nothing, e.g. the browser blocks it): on the same page click
**Copy token**; in Switchyard click **Connect…** (or the status at the top right), leave
**Server** as your server's address, paste the token into **Token**, and click
**Connect**.

**Updating from 0.1.2 or earlier: one Keychain prompt.** Those versions kept the token in the
macOS Keychain. The first launch of a newer version may ask once to read that item
(*"Switchyard wants to use your confidential information stored in "com.exowatt.switchyard" in
your keychain"*) and moves the token to the file; later updates never ask. Enter your Mac login
password and click **Always Allow**. Clicking **Deny** leaves the app unconnected: connect again
as above.

No server handy? **Watch the demo** runs a built-in simulated fleet. To revoke a device token: in the
browser (signed in), `GET /api/v1/tokens` lists yours and `DELETE /api/v1/tokens/{id}` revokes one.

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
| `depends_on arch: :arm64` | Intel Macs are not supported; use the web app on your server |
| The app shows *Connect Switchyard to a server* | mint a token at `/connect` on your server (see First run above) |
| An app at 0.1.2 or earlier shows no window | a Keychain prompt is waiting, maybe behind other windows (check the Dock or press ⌘-Tab): answer it with your login password and **Always Allow**, then update to the current release |
| The app opens but shows no data | check you can open your server in a browser (single sign-on; on the company network or VPN if required) |

Release notes and every build: <https://github.com/couplet-physical-ai/switchyard/releases>.
