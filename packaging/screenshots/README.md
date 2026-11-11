# Screenshots

Images the top-level README's hero uses. Dark appearance, a 1440x900 window (the Mac mini's
display is 1x, so macOS shots are 1440x900; web shots can be 2880x1800 with `EXACT_SCALE=2`), real data from https://switchyard.apps.example.com
or the built-in demo fleet; nothing internal in frame (no private hostnames or IPs).

| File | What |
|---|---|
| `factory-macos.png` | hero: the Factory (default tab), on macOS |
| `factory-journey.png` | a lens: one pipeline's journey across the floor, drawer open |
| `yard-macos.png` | the Yard, LIVE, on macOS |
| `yard-web.png` | the Yard in a browser |
| `mainlines.png` | Mainlines: every repo's default branch as commit dots, a culprit labelled |
| `prs.png` | PRs: the step-chip tracks, one stuck PR highlighted |
| `journey.png` | one commit's journey: push → pipeline → steps → deploy → health |

How they are made (Exact's agent renders the app's own drawing; no screen-recording permission):

```sh
cd app && bun exact.mjs agent macos --size 1440x900 --storage shots --reset-storage \
  "clock data" "tap setup-demo" "clock data" "clock +6000" \
  "tap tab-yard" "clock data" "clock +4000" "screenshot ../packaging/screenshots/yard-macos.png" \
  "tap tab-factory" "clock data" "clock +5000 real" "screenshot ../packaging/screenshots/factory-macos.png" \
  "tap factory-live" "clock +3000 real" "screenshot ../packaging/screenshots/factory-journey.png" \
  "tap tab-mainlines" "clock settle" "screenshot ../packaging/screenshots/mainlines.png" \
  "tap tab-prs" "clock settle" "screenshot ../packaging/screenshots/prs.png"
```

The Factory draws on a display link: it needs `clock +N real` (a plain `clock +N` leaves the
floor empty) and the demo loaded before the tab is shown. `tap factory-live` clicks the floor's
centre (the intake, so a pipeline lens); `tap factory-live drag dx dy` pans the floor first to
bring another target under the centre.
