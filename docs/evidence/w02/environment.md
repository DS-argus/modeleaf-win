# W02 reference environment

## Recorded workstation facts

| Field | Recorded value |
|---|---|
| Machine identity | `reference-workstation-2026-08-16` |
| Operating system | Windows 11 Enterprise |
| Windows version string | `Microsoft Windows NT 10.0.26200.0` |
| Architecture | x64 |
| CPU | Intel(R) Core(TM) Ultra 5 125H |
| RAM | 31.51 GiB (`33838469120` bytes) |
| GPU | Intel(R) Arc(TM) Graphics |
| Node | 24.19.0 |
| npm | 11.17.0 |
| Rust | 1.97.1 |
| PDF.js | 6.2.108 |
| WebView2 Runtime | 151.0.4129.86 |
| App package version | 0.1.0 |

These are observed reference-workstation facts and packaged-debug-app results only. They do not assert a clean VM/install or a portable performance baseline; clean-machine installer, WebView2 bootstrap, upgrade, and uninstall validation remains exclusively W13.

## Evidence-record requirements

Every W02 hard-gate record uses schema version `modeleaf.w02.evidence.v1` from `evidence-record.schema.json`. The discriminated record details require the transport negative cases, the 16-case geometry matrix, bounded resource metrics, hostile capability suppression, outline edge cases, and print cleanup outcomes. Every record carries full machine facts, fixture SHA-256/bytes, before/after source hashes, exact commit/dirty/build-profile provenance, source-tree and packaged-binary SHA-256, and checksummed `artifacts/*.json` references.

Artifact paths are confined to `docs/evidence/w02/artifacts/` by schema and contract checks. Credentials, user-profile paths, filesystem source paths, and fixture paths are prohibited evidence fields.

`sourceTreeSha256` is SHA-256 over the lexically sorted relative path, NUL, file bytes, NUL sequence for every file under `src/` and `src-tauri/src/`, followed by `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, and the generated PDF.js asset manifest. `binarySha256` hashes the exact `src-tauri/target/debug/modeleaf.exe` used for the recorded packaged smokes.

## Gate classification

### Structural hard gates

These determine feasibility and are not performance claims:

- packaged custom-protocol `HEAD`, full `GET`, single-range `GET`, and invalid/multi-range behavior;
- PDF.js worker and bundled-asset loading with no network fallback;
- geometry at DPI 100/125/150/200 and rotation 0/90/180/270 with maximum error no greater than 1 CSS px;
- virtualization: no more than visible pages plus two pages of overscan above and below, cancelled unmounted render tasks, and released canvas backing stores;
- read-only open/interactive behavior with source SHA-256 before and after;
- outline handling for null/empty/nested/duplicate/invalid/edge destinations;
- hidden all-page print prototype, normal cancel/error cleanup, restored reader state, and source SHA-256 before and after.

### Provisional reference-machine performance observations

The following are provisional measurements on this recorded workstation, not CI-wide absolute gates: `fixture-S-text-10.pdf` cold first visible page at or below 1.5 seconds; `fixture-L-text-300.pdf` cold first visible page at or below 2.5 seconds; no page-count-linear working-set growth during a 60-second 300-page scroll; working-set decline from peak after 10 seconds idle; and no recurring input-dispatch long task over 100 ms. Future regression comparisons use the same recorded machine/image baseline rather than treating these numbers as portable limits.

## Deferred installation evidence

Clean-VM, install, uninstall, file-association, and packaged bootstrapper evidence are deferred to W13. This document makes no clean-VM or install-success claim.

## Observed feasibility results

The packaged debug application used the production custom protocol and bundled PDF.js worker on this reference workstation. The source fixtures matched their frozen manifest SHA-256 values after the run.

| Gate | Observation |
|---|---|
| Large-file transport | `fixture-F-raster-12.pdf` used preflight `204`, a bounded 1 MiB probe, then explicit `206` ranges; no `416` occurred after admitting PDF.js-coalesced ranges up to the 4 MiB absolute cap. |
| Small-file transport | `text-3-page.pdf` and `links.pdf` used bounded full `200` responses. |
| Packaged worker | `http://tauri.localhost/assets/pdfjs-6.2.108/build/pdf.worker.min.mjs`; no external network resource was observed. |
| Geometry | 16 WebView2 device-scale-factor/rotation cases; maximum canvas/text/content edge delta `0 CSS px`; four link overlays remained inside the page frame. |
| Text-10 cold/warm first visible | `274.2669 ms` / `276.8193 ms` (provisional threshold `1500 ms`). |
| Text-300 cold/warm first visible | `319.3479 ms` / `263.0734 ms` (provisional threshold `2500 ms`). |
| Long navigation | Page 1 through page 300 in `74813.8623 ms`; maximum five mounted canvases; one active RenderTask by the production resource counter; one visible text layer; no long task over `100 ms`. |
| Working set | Eight-process tree: start `586665984` bytes, peak `681803776`, monitor end `611065856`, later post-peak `611889152`; memory declined from peak. |
| Outline | Ten frozen rows; duplicate and invalid rows classified; `679 pt` edge destination clamped to approximately `676.3 pt`. |
| Print | Native Windows Print/Cancel UI reported a three-page PDF; UI Automation Cancel removed the hidden surface and retained page 1, scale 1.25, rotation 0. |

The scale matrix used WebView2 `deviceScaleFactor` emulation (`1`, `1.25`, `1.5`, `2`) on this workstation. It is not evidence from four separately configured machines. Raw sanitized reports are under `docs/evidence/w02/artifacts/`.
