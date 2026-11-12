# Install and update

The macOS app runs on Apple Silicon with macOS 14 or newer. You can install it with Homebrew or from a disk image, then connect it to the web service with a device token. The web app is available at [switchyard.apps.example.com](https://switchyard.apps.example.com) and uses single sign-on.

## Install with Homebrew

Run the one-line command from the repository README:

```sh
brew tap couplet-physical-ai/tap && brew trust couplet-physical-ai/tap && brew install --cask switchyard && open -a Switchyard
```

The tap is [couplet-physical-ai/homebrew-tap](https://github.com/couplet-physical-ai/homebrew-tap). Homebrew 7 and newer require the trust step for a non-official tap; if your older Homebrew does not have `brew trust`, omit that step. The cask downloads the release archive, checks its SHA-256, and installs the app.

## Install from a disk image

1. Download the `Switchyard-<version>-arm64.dmg` asset and `SHA256SUMS` from the [latest GitHub release](https://github.com/couplet-physical-ai/switchyard/releases/latest). Verify the listed checksums with `shasum -a 256 -c SHA256SUMS`.
2. Open the disk image and drag Switchyard to Applications.
3. Remove the quarantine flag and launch the app:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Switchyard.app && open -a Switchyard
   ```

The app is ad-hoc signed because the project does not have an Apple Developer ID. Homebrew removes quarantine during installation; the disk-image route needs the command above once.

## Connect on first launch

The app needs a read-only device token to access a server that requires authentication.

1. Open [switchyard.apps.example.com/connect](https://switchyard.apps.example.com/connect) and sign in through single sign-on.
2. Create a device token, then choose **Open in Switchyard**. macOS opens a `switchyard://connect` link.
3. Review the server and confirm the connection in the app. The token is saved locally only after you confirm.

If the link does not open the app, use **Copy token** on the connect page. In Switchyard, choose **Connect…**, set the server to `https://switchyard.apps.example.com`, paste the token into the token field, and connect. The token field is an input; never put the token in a URL, shell command, or support message.

To use the web app, open [switchyard.apps.example.com](https://switchyard.apps.example.com) and sign in. The browser uses the signed-in session rather than a separate device-token setup.

## Where the token is stored

The browser stores its token in that origin's `localStorage`. The macOS app stores the token in `~/Library/Application Support/com.exowatt.switchyard/token`, with file mode `0600` and a private parent directory. The app reads the saved token once asynchronously during startup; the window does not wait for the read to finish.

For native test or managed launches, `SWITCHYARD_TOKEN_FILE` can name a token file. The file must have mode `0600`; its contents must stay local and must not be placed in a command line or log. The hook reads it once and follows the same connection validation as a `switchyard://connect` link.

Builds from 0.1.2 and earlier stored the token in macOS Keychain. The first launch of a newer build may ask once to read that legacy item and migrate it to the file. Current builds use the file afterward, so this is not an update-by-update prompt.

## Update or uninstall

The macOS app checks for updates and presents an **Update** action. It downloads and verifies the new bundle, then waits for you to choose **Relaunch to update**; it does not relaunch on its own. Homebrew marks the cask as auto-updating, so force a cask upgrade with:

```sh
brew upgrade --cask --greedy switchyard
```

To remove a Homebrew installation:

```sh
brew uninstall --cask switchyard
```

Add `--zap` if you also want Homebrew to remove the app's settings and caches.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Homebrew refuses the tap as untrusted | Run `brew trust couplet-physical-ai/tap`, then install again. On older Homebrew, skip the trust command if it is unavailable. |
| The cask is unavailable | Run `brew update`; if needed, remove and re-add the tap, then install again. |
| macOS says the app is damaged or cannot be opened | On a disk-image install, remove the quarantine flag with the command above. |
| The Mac does not meet the supported architecture | The native app requires Apple Silicon; use the web app instead. |
| The app asks to connect or shows no data | Confirm the server URL, complete SSO on the web connect page, and create a device token for the native app. |
| An older app shows no window during an update | Check for a pending Keychain migration prompt from a build that predates the token file. Approve the expected read once to migrate the token. |

See the [release guide](releasing.md) for release notes, supported update feeds, and the macOS release process.
