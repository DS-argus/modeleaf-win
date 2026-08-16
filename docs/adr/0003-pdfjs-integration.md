# ADR 0003: Packaged PDF.js integration

- **Status:** Accepted
- **Date:** 2026-08-16
- **Baseline:** PDF.js `6.2.108`; Modeleaf v0.10.0 `0f7ff0b54c3674c48f6b555261f939397cfbfb88`
- **Authority:** `docs/windows-porting/implementation-phases.md`, W02; ADR 0002.

## Context

W02 had to prove the packaged worker and support assets, canvas/text/link geometry, long-document resource bounds, hostile capability suppression, embedded outlines, and the Windows system print path before product features could build on PDF.js.

## Decision

Modeleaf uses exact PDF.js `6.2.108` with only repository-bundled assets. `GlobalWorkerOptions.workerSrc`, CMaps, standard fonts, wasm, and ICC data resolve beneath `assets/pdfjs-6.2.108/`. Network fallback, eval, XFA, HWA, scripting, form editing, media, generic-viewer history, download, and PDF.js-owned print UI remain disabled.

PDF.js `PageViewport` in 6.2 exposes point conversion, not `convertToViewportRectangle`. Annotation rectangles are derived by converting both PDF endpoints and normalizing the resulting CSS rectangle. Text-layer CSS bounds are overwritten with the rotated viewport width and height after `TextLayer.render()`; this keeps canvas, text, and annotation layers on the same coordinate plane for every quarter turn.

The reader retains only the active page plus two raster pages on each side, subject to document edges and resource budgets. Planned pages are distinct from successfully published residents. Failed or cancelled materializations remain retryable. Scale or rotation changes clear stale CSS metrics; DPR-only backing changes retain CSS metrics. Every raster teardown uses one idempotent release primitive that zeros canvas width and height before releasing its reservation.

Embedded outlines use a bounded, cycle-detecting production probe. It resolves named/explicit destinations, page references, duplicate destinations, invalid rows, and out-of-page Y coordinates without trusting raw outline structure.

System printing uses a hidden production print surface. Pages render sequentially with annotations disabled, each canvas is encoded to a blob-backed image, and its backing dimensions are zeroed only after raw ownership settles. Active canvas, encoded blobs, decoded image backing, and retained reader rasters share the process-wide 256-MiB `canvas-bytes` reservation ceiling rather than independent print caps. Page retrieval, render, encoding, decode, and print invocation are registered as raw ownership with abort-aware 15-second stage waits; timed-out or cancelled raw work keeps the hidden surface, URLs, and reservations until its actual settlement. A controller-wide one-print slot remains held across candidate replacement until every raw settlement drains. Reader page, fit/scale, rotation, and document identity are not mutated.

## Evidence

Schema-valid W02 records reference the checksummed artifacts under `docs/evidence/w02/artifacts/`: `geometry.json`, `resources.json`, `capabilities.json`, `outline.json`, and `print.json`. Contract tests verify artifact hashes, fixture before/after hashes, bundled worker/CMap/font/wasm/ICC manifests, stale/cancelled render release, outline null/empty/cycle bounds, duplicate print rejection, print abort/error cleanup, and source invariance.

Packaged WebView2 evidence on the recorded reference workstation showed:

- `links.pdf` rendered canvas, selectable text, and four link overlays;
- a 16-case device-scale-factor/rotation matrix (`1`, `1.25`, `1.5`, `2` × `0°`, `90°`, `180°`, `270°`) with maximum canvas/text/content edge delta `0 CSS px`, and all link rectangles inside the page frame;
- `fixture-L-text-300.pdf` first visible page in approximately `319 ms`, five or fewer mounted canvases while navigating all 300 pages, one visible text layer, and no observed long task above 100 ms;
- `fixture-F-raster-12.pdf` range loading and three resident canvases at the first page;
- image-only output with an empty text layer and no OCR text;
- interactive output with no visible PDF form/media elements;
- malformed input isolated without replacing the healthy document;
- the frozen ten-row outline including duplicate, invalid, nested, and 679 pt edge destination clamped to the 676.3 pt page;
- the native Windows print UI exposing Print/Cancel and a three-page PDF document; Cancel removed the print surface and restored page 1, scale 1.25, rotation 0.

Device-scale-factor cases are WebView2 emulation on the recorded workstation, not claims about four separately configured clean VMs. Clean-machine installer/bootstrap evidence remains W13.

## Consequences

Geometry tests must use PDF.js 6 point conversion and assert layer bounds, not mocks of removed APIs. Raster release tests must observe zeroed backing dimensions as well as reservation accounting. Print and outline probes are retained production interfaces, not disposable demos. Later reader phases may add UI around these interfaces but may not widen PDF capabilities or reintroduce network asset loading.
