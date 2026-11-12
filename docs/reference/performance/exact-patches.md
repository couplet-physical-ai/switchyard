# Exact patches

Switchyard applies a small ordered patch series to the pinned Exact checkout for native macOS builds. The patches change the working tree without moving Exact's pinned `HEAD`; the web build uses its own browser host and is unaffected by these native-only changes.

## Patch set

| Patch | Exact file and function | Why | Evidence |
|---|---|---|---|
| [`0001-heap-512m.patch`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/scripts/exact-patches/0001-heap-512m.patch) | `js/src/lib.rs`, `DEFAULT_MAX_HEAP` | Raise the native Hermes ceiling from 64 MiB to 512 MiB as a stopgap for a fatal OOM. | The cap is reproducibly changed at build time. It is not a leak fix or proof of a stable heap. |
| [`0002-recorder-no-per-frame-buffers.patch`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/scripts/exact-patches/0002-recorder-no-per-frame-buffers.patch) | `canvas/recorder.js`, `Writer` and `canvasSeam.draw` / base64 encoding | Reuse list and base64 buffers instead of allocating a growing writer, building base64 with repeated `+=`, and serializing a second JSON copy for each native draw. | 78 replies matched the unpatched seam byte-for-byte, including empty lists, 1–40,000 operations, sealed lists, text, and thrown draws. |
| [`0003-recorder-font-parse-kept.patch`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/scripts/exact-patches/0003-recorder-font-parse-kept.patch) | `canvas/recorder.js`, `parseFontKept`, `quoteFamily`, and the font setter | Keep bounded caches for font parsing and family quoting; return a fresh parsed-font copy because canvas state mutates it. | 300-trial font/fillText/caps/stretch/save/restore/getter fuzz: 0 differences; recorder bytes matched; no-JIT Yard info draw p50 fell 2.38→1.97 ms (-14%). |
| [`0004-recorder-roundrect-one-radius.patch`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/scripts/exact-patches/0004-recorder-roundrect-one-radius.patch) | `canvas/recorder.js`, `roundRect` and `roundRectOne` | For finite non-negative geometry and one numeric radius, emit the same ops without the usual path's roughly 70 arrays/objects per rectangle. Other radii and invalid/negative cases keep the original path. | 4,000-trial fuzz across transforms, singular matrices, unusual radii, negative sizes, and following path ops: 0 differences. Yard live allocation fell 68→53 KB per frame (-22%). |
| [`0005-mac-text-pass-touched-only.patch`](https://github.com/couplet-physical-ai/switchyard/blob/7a4c7fa/app/scripts/exact-patches/0005-mac-text-pass-touched-only.patch) | `host/apple/Sources/ExactKit/Mac/PresenterMac.swift`, `refreshVisibleText` and `batchApplied`; `TextViewportIndexMac.swift`, `BlockHostMac.swift`, and `NodeViewMac.swift` | For a safe words-only batch, refresh only the touched paragraphs. Keep the full pass for scroll, geometry, scale, capture, selection, or outstanding text work. | `TextTouchedMacTests` checks new words, unchanged paragraph surfaces, and full refresh after move/zoom/mount. The p6 mini profile found the full pass was 30% of Live's idle CPU; p7's mini before/after performance run is not recorded. |

Patch 0005 is present in the p7 patch commit `7a4c7fa`. The test evidence exists; do not present a measured CPU improvement for 0005 until the p7 mini A/B is recorded.

## Apply and reverse-check

[`app/scripts/patch-exact.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/scripts/patch-exact.sh) accepts an Exact checkout path and applies `app/scripts/exact-patches/*.patch` in filename order: 0001, 0002, 0003, 0004, then 0005 when that patch is in the checkout. It checks each patch in this order:

1. `git apply --reverse --check` succeeds: the patch is already applied, so skip it.
2. Otherwise, `git apply --check` must succeed before `git apply` changes the checkout.
3. If neither direction checks cleanly, exit with an error rather than silently skipping the patch.

The patch script is called by [`app/scripts/fetch-exact.sh`](https://github.com/couplet-physical-ai/switchyard/blob/main/app/scripts/fetch-exact.sh) after checkout and before Exact setup. Release build paths also call it after their Exact checkout. A custom checkout can be patched with:

```sh
app/scripts/patch-exact.sh <exact-checkout>
```

The Exact pin remains unchanged. The reverse check is only an idempotency test; it does not reverse an applied patch. Recreate a clean checkout from the pin when comparing against an unpatched build.

## Scope and limits

- 0001 protects against a too-small default heap; Hermes OOM remains fatal, so the 512 MiB value is headroom, not a budget.
- 0002 is a general native recorder allocation reduction. The isolated [legacy-floor probe](https://github.com/couplet-physical-ai/switchyard/commit/a8c81d8) still reported external-byte drift after 0002; that patch alone was not the cure for the old floor. macOS stopped mounting the legacy surfaces, and the later product pass retired them.
- 0003 and 0004 preserve emitted recorder bytes for their tested inputs. Their performance gains are specific to interpreter-style Yard drawing, not a promise that all app frames become faster.
- 0005 is macOS-host-only. Its fast path is guarded by geometry and text-pending invariants; it does not change the web host.

For the crash timeline and the distinction between the heap-cap stopgap and the old-floor recorder work, see the [OOM post-mortem](../../reports/incidents/2026-11-11-macos-oom.md). The complete evidence trail is in [`app/PERF.md`](https://github.com/couplet-physical-ai/switchyard/blob/df6e18a/app/PERF.md) and the [macOS pass record](mac-passes.md).
