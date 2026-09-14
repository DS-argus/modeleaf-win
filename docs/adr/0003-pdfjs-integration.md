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

System printing uses the owner-approved BASIC path implemented for [Issue #83](https://github.com/DS-argus/modeleaf-win/issues/83). PDF.js remains the 300-DPI page-raster producer, while native GDI is the consumer. `window.print()`, the hidden print DOM/iframe, PNG/blob/image-URL staging, and image, URL, or arbitrary-DOM printing are removed. There is no external-viewer or alternate-consumer runtime fallback.

### Issue #83 — owner-authorized native consumer (2026-09-14)

Rust validates the active window/document owner, acquires an opaque PDF-session lease, and owns an opaque print job. Admission is limited to one process-wide job and one raw page command. Its STA worker opens HWND-owned classic `PrintDlgW` before the renderer loads or renders any page. `PD_ENABLEPRINTHOOK` solely captures the actual dialog HWND during `WM_INITDIALOG` and clears it on destruction so cancellation can target the owned dialog; it adds no controls and does not replace Windows default processing. All pages is the default; the classic dialog supports one contiguous page range and printer-managed copies/collation. A document over `65,535` pages is rejected instead of truncating the dialog range.

After dialog acceptance, PDF.js renders only the selected pages, sequentially, with print intent, intrinsic PDF rotation, and an opaque white background. Each raw transfer is a 32-byte header followed by opaque BGRA32 pixels; GDI acknowledges one page before the producer proceeds. The producer obtains the `getImageData()` copy while its canvas exists, zeros the canvas backing before allocating the binary payload, and therefore owns at most two page-sized controlled buffers at once. It reserves `2 × RGBA bytes + 32` against the existing `256 MiB` renderer budget and caps native page input at `64 MiB`. These counters constrain controlled producer buffers, not printer-driver, WebView2, or process RSS.

GDI aspect-fits each source page into the printable bounds of the paper selected in the standard dialog. Source aspect and intrinsic rotation are preserved, but original mixed physical paper sizes are not: the recorded Microsoft Print to PDF job used A4 media boxes of `595.32001 × 841.92004` points. Reader page, zoom, and reader-applied rotation do not change these output semantics.

The retained inline progress/cancel control coexists with existing status diagnostics. It reports opening, preparation, submission, `Submitted to printer`, cancellation, and failure; submitted means the native job was submitted, not that physical output succeeded. Plain `Escape` cancels only while the control owns focus; modified keys and IME/composition input are not intercepted.

Cancellation, close, and reload retain ownership of raw PDF.js and native operations until actual settlement. Native release is refused until the worker has joined and the session lease has dropped, and `AbortDoc` cleanup accepts only a positive result. Reader state and source bytes remain unchanged across terminal outcomes.
Replacement-load invalidation marks old native sessions permanently ineligible for new print leases, cancels any acquired lease, and then abandons the manager slot. Admission rechecks that cancellation under the same manager lock used for publication/abandonment. Initial page loads are distinguished from replacements so argv-admitted sessions remain printable; no unbounded renderer-epoch map is retained.

System-brokered `PrintDlgEx` and unhooked `PrintDlgW` experiments failed the required dialog-visibility/cancellation gate and were replaced during implementation; they are not runtime fallbacks.

#### Historical rejected-DOM baseline

The rejected browser-only DOM consumer remains a historical comparison. On Edge `153.0.4234.32`, text-300 service-entry-to-`window.print()` callback measurements were `11988.5 / 8583.2 / 7724.1 ms`, with PNG encoding taking `7737.1 / 7071.4 / 5968.9 ms`; a second run measured `7458.0 / 5846.3 / 5743.6 ms`. Only pages 277–300 reached each callback and 23 of those 24 images reported ready. Thus the historical preparation range was about `5.7–12.0 s`, dominated by PNG work. It printed nothing and is neither a native baseline nor Ctrl+P-to-dialog evidence.

Current tools replace the removed baseline runner:

- `node tools/qa/run-print-candidate.mjs` measures the real-browser PDF.js candidate without opening a native dialog or printing;
- `node tools/qa/run-native-print.mjs <fixture> <cancel|print|save-cancel|reopen> cdp` explicitly drives the production registry and real Windows dialog/GDI/Microsoft Print to PDF path with trusted WebView2 CDP key delivery; there is no automatic input fallback;
- `node tools/qa/verify-print-output.mjs <fixture> .internal/evidence/issue-83/native/<run>/output.pdf` separately decodes and pixel-verifies the actual native output in a browser.

#### Current evidence and limits

Actual Microsoft Print to PDF outputs for blank-1 and raster-12 were created by the native dialog/GDI path and separately verified by pixel-template output checkers. The actual text-300 output is `49,609,522` bytes with SHA-256 `2de9e27e1b65690196023479e6d896aa1f93feb870dbc56cc6f829f1ea16341a`; browser decoding matched all 300 pages to their unique digit pixel templates in order. This is actual native output plus browser verification, not browser-originated printing. No physical printer was tested.

Actual raster-12 and text-300 runs preserved a nondefault page, zoom, and 90° reader rotation. Native Save As cancellation and same-document cancel/reopen passed on the current build. Existing fixture source SHAs remained unchanged; no existing source fixture was modified, and `print-mixed-rotation-4.pdf` is the new fixture. Its actual output passed all four page and intrinsic-orientation pixel-template checks.

After integration with current `origin/main`, the full frontend suite passed `1000` tests without unhandled errors; build, Rust formatting, all-target clippy and `179` top-level Rust tests plus two nested helper invocations passed. The rebased QA build repeated blank/mixed output verification and native Save As cancel/cancel-reopen. Bulk 12/300-page artifacts precede final lifecycle fencing and upstream integration; their page-payload path is unchanged. The text-300 debug run took about `455 s` overall, so the native design must not be described as faster in total.

In the CDP-driven runs, UIA observed the actual dialog about `0.9–1.1 s` after browser-delivered Ctrl+P, with roughly `1 s` of UIA probing overhead; this is not a precise latency measurement. Native job admission around `10–12 ms` is likewise not dialog-display timing. The attempted OS foreground-key injection tool refused activation, so current native runs prove explicit trusted WebView2 CDP delivery through the production registry followed by the real Windows dialog, GDI, and Microsoft Print to PDF—not OS foreground-keyboard behavior.

The QA application identifier prevents attaching to another worktree's running app. This is reference-workstation debug evidence, not a clean VM or installer run. OS foreground keyboard/focus, native DPI, Narrator and independent driver/spooler memory limits remain unclaimed; process-tree samples and all four output-fixture checks are recorded. W12 therefore remains `partial`, and this is not release-readiness evidence.

The durable evidence summary is [`docs/evidence/issue83-print.json`](../evidence/issue83-print.json). Raw output PDFs and machine paths remain outside Git under `.internal/evidence/issue-83/`; no user PDF is copied.

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
- historical W02 evidence showed the native Windows print UI exposing Print/Cancel for a three-page PDF; Cancel removed its print surface and restored page 1, scale 1.25, rotation 0. It does not certify the Issue #83 native consumer.

Device-scale-factor cases are WebView2 emulation on the recorded workstation, not claims about four separately configured clean VMs. Clean-machine installer/bootstrap evidence remains W13.

## Consequences

Geometry tests must use PDF.js 6 point conversion and assert layer bounds, not mocks of removed APIs. Raster release tests must observe zeroed backing dimensions as well as reservation accounting. The Issue #83 native print contract supersedes the removed DOM probe; the bounded outline probe remains a retained production interface, not a disposable demo. Later reader phases may add UI around these interfaces but may not widen PDF capabilities or reintroduce network asset loading.
