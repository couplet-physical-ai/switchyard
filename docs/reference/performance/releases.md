# Release soak numbers

This page separates values from the per-minute soak CSVs from statements in release notes. The supplied CSVs record RSS, a Hermes heap line, and cumulative canvas frames; they do not have CPU or FPS columns. The current soak procedure and gate are in [`packaging/RELEASING.md`](https://github.com/couplet-physical-ai/switchyard/blob/main/packaging/RELEASING.md).

## RSS

Ranges are min–max over the supplied CSV rows; start → end gives the first and last sample, not a slope estimate. Each supplied CSV contains 26 samples for minutes 0 through 25.

| Release | RSS (MB) | Evidence |
|---|---:|---|
| 0.1.3 | About 173, reported flat | No soak CSV. The app ended in Hermes OOM after about 18 minutes of live use. |
| 0.1.4 | About 173, reported flat | No soak CSV. The app ended in Hermes OOM after about 4 minutes; this release was rolled back. |
| 0.1.5 | 158–205; 205 → 182 | CSV minutes 0–25. |
| 0.1.6 | 149–189; 189 → 184 | CSV minutes 0–25. |
| 0.1.7 | 188–234; 234 → 229 | CSV minutes 0–25. |
| 0.1.8 | Pending | No final CSV supplied. |
| 0.1.9 | Pending | No final CSV supplied. |

## Hermes heap

The total is the first number after `heap:`: live plus external memory counted toward the cap. The CSV also records the separate live and external parts and the cap.

| Release | Total heap (MB) | Live (MB) | External (MB) | Cap |
|---|---:|---:|---:|---:|
| 0.1.3 | Not logged; 64 MiB default | Not logged | Not logged | 64 MiB |
| 0.1.4 | Not logged; 64 MiB default | Not logged | Not logged | 64 MiB |
| 0.1.5 | 9.6–17.5 | 2.2–9.5 | 7.4–8.0 | 512 MiB |
| 0.1.6 | 9.6–18.5 | 2.2–10.1 | 7.4–8.7 | 512 MiB |
| 0.1.7 | 9.6–19.3 | 2.2–10.9 | 7.4–8.6 | 512 MiB |
| 0.1.8 | Pending | Pending | Pending | Pending |
| 0.1.9 | Pending | Pending | Pending | Pending |

## Canvas frame counter

`frames` is cumulative since launch, not FPS. The 0.1.6 and 0.1.7 CSVs record a view for each sample; counts include activity across the cycle. The 0.1.5 export has no view column.

| Release | Counter in CSV | What can be concluded |
|---|---:|---|
| 0.1.3 | Not logged | No frame counter in the incident record. |
| 0.1.4 | Not logged | No frame counter in the incident record. |
| 0.1.5 | 0 → 0 | No frames appear in the supplied samples; the file does not identify which view was shown. |
| 0.1.6 | 0 → 2,270 | Frames occurred during the view-cycled soak; this is not an idle frame rate. |
| 0.1.7 | 0 → 3,779 | Frames occurred during the view-cycled soak; this is not an idle frame rate. |
| 0.1.8 | Pending | No final CSV supplied. |
| 0.1.9 | Pending | No final CSV supplied. |

## Release-note results not in the CSV

| Release | CPU / frame-rate note |
|---|---|
| 0.1.3–0.1.4 | No CPU or FPS result was supplied; the live sessions ended in OOM. |
| 0.1.5 | About 2–3% idle CPU per tab; Live and Factory draw nothing when no work moves. |
| 0.1.6 | About 1.3–2.1% idle CPU per tab; at 10×, Yard late frames fell from about 90% to about 8%. |
| 0.1.7 | Factory board reached 59.9 fps at 10× versus 42–56 fps before; paused views used about 0.1% CPU. |
| 0.1.8 | Release note reports idle Factory at about 1.2% and Yard at about 0.9%; final soak numbers are pending. |
| 0.1.9 | Final release-note and soak numbers are pending. |

<!-- PENDING: 0.1.8 / 0.1.9 final numbers -->

The supplied `soak-0.1.7.csv` and rerun are byte-identical. The release record says the final 0.1.7 gate used a fresh 45-minute soak after the earlier single-sample gate proved noisy; these 26-row exports are not that full gate record. The gate changed to use slopes, half-means, external-memory slope, a heap cap, process liveness, crash status, and Yard frames. A garbage-collected heap can move between roughly 15 and 19 MB without a leak, so two individual samples can fail or pass based on where collection falls.

No supplied soak CSV contains CPU or FPS columns. Approximate CPU and FPS statements above are release-note results, not calculations from the CSVs. For the measurement procedure, see [Performance](index.md); for the early crash details, see the [macOS OOM post-mortem](../../reports/incidents/2026-11-11-macos-oom.md).
