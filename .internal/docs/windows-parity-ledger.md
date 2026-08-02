# Modeleaf Windows parity ledger

Upstream baseline: `DS-argus/modeleaf@d809e2e4d6aa5f257c91ff38b2cd4503e17405f0` (v0.5.0)

This ledger tracks behavior, not AppKit/PDFKit implementation structure. Windows acceptance is governed by the approved CP0–CP5 plan.

| Contract | Upstream evidence | Windows checkpoint | Acceptance / approved deviation |
|---|---|---:|---|
| Keyboard navigation | `ActionID.swift`, `ActionRegistry.swift`, built-in bindings | CP1–CP2 | Preserve existing Phase 1 IDs, timing, prompt behavior, help, and registry ownership. |
| Read-only PDF lifecycle | `ReaderSession.swift` teardown and document ownership | CP0–CP1 | Rust owns read-only local handles and opaque sessions; cancel/barrier/close order is mandatory. |
| View state | reader zoom, fit, rotation and navigation actions | CP2 | Fresh documents open page 1 fit-page; fit-width is continuous; rotation is view-only and tab-local. |
| Search | `ReaderSearchWorkflowTests`, including per-tab isolation | CP3–CP4 | CP3 ships bounded trimmed case-insensitive literal search. The current single-tab shell clears search on replacement; CP4 tab restoration is not wired here. |
| Text copy | PDFKit text selection | CP3 | Pointer selection and native copy are supported. Keyboard range selection, reading-order remediation and OCR are deferred. |
| Links and hints | annotation link actions and wrapped-link hint behavior | CP3 | Internal destinations and allowlisted `http`, `https`, `mailto`; wrapped geometry produces one stable hint. Other PDF actions are rejected. |
| Action palette/help | action registry and palette/help PRs | CP1, CP4 | Matching, dispatch, enabled state, palette and help derive from one typed registry; no advertised no-op. |
| Tabs | ordered tabs and tab-local reader state | CP4 | Reader/view/search state remains tab-local; inactive heavy resources are evicted under global limits. |
| Recent files | recent-file PR series | CP4 | At most 15 fuzzy results; renderer sees opaque recent IDs and basenames, never persisted source paths. |
| Open routes | native open, new-window and app lifecycle actions | CP4 | Native chooser/drop, CLI, startup, second-instance and manually browsed Open With argv use one exactly-once Rust coordinator. Installed association is deferred. |
| Themes | six theme defaults and persistence behavior | CP5 | Six chrome themes with preview/commit/revert and atomic separate persistence. PDF page pixels are not theme-filtered. |
| Quit | app quit action/default binding | CP5 | `Ctrl+Q` drains sessions, reservations and windows; bounded state write; clean exit. |
| Accessibility | native app chrome plus PDFKit-provided document semantics | CP1, CP5 | Chrome, focus, status and page announcements are required. Full PDF content accessibility is not claimed. |
| Filesystem scope | macOS local URL behavior | CP0+ | Windows supports non-remote fixed/removable volumes only. UNC, mapped network and `DRIVE_REMOTE` inputs are rejected with copy-local guidance. |
| Config and panes | upstream configuration and pane modules | Deferred | No dormant model, no advertised command and no compatibility alias in this run. |
| Distribution | upstream macOS release assets | Later run | Registered association, signed installer, Scoop and WinGet begin only after the reader is basically usable. |

Any new intentional deviation requires an owner decision and a corresponding acceptance-test update.

## CP1 implementation record

- The native chooser opens exactly one local `.pdf`, resolves supported reparse metadata without following it, accepts targets proven fixed/removable, rejects UNC/remote/unprovable targets before invoking the PDF opener, revalidates the final handle, and returns only an opaque session ID, generation, byte length, and basename.
- PDF.js uses bundled worker, CMap, font, WASM, and ICC assets through the narrow packaged self-origin CSP. Renderer requests are bounded opaque byte ranges; no path, URL, whole-file payload, or network fallback enters the WebView.
- A candidate document replaces the current document only after metadata and page 1 render successfully. Failed replacement, malformed input, timeout, password exhaustion, and locality rejection preserve the healthy canvas.
- Page rendering is generation-checked, process-reserved, canvas-byte-reserved, and cancellation-aware. A cancelled render retains its process slot until its own promise settles, and stale cleanup cannot cancel a successor. Candidate plus healthy canvases must fit the aggregate process cap.
- `Ctrl+O`, `n`, `p`, `g` + digits + `Enter`, `gg`, `G`, `?`, `Escape`, and prompt `Backspace` remain registry-backed and operate against the real reader lifecycle.
- Password input is modal, disables login/autofill semantics, clears after each attempt, and stops after five incorrect attempts. Cancellation preserves the healthy document. Error/status strings expose neither local paths nor native details.
- CP1 verification covers the opaque native boundary, cancellation-barrier teardown, exact range delivery, resource and deadline limits, candidate commit behavior, password handling, Korean fixtures, generated adversarial fixtures, production web build, Rust tests/checks, and a no-bundle Windows x64 release executable.
- Native desktop interaction may also be replayed with `tools/windows/smoke-cp1.ps1`; the automated browser contract uses the same production controller and bundled PDF.js assets while Rust tests independently prove the native boundary.

## CP2 implementation record

- The typed action registry owns the complete reading loop: 48 CSS-pixel directional scrolling, 0.8-viewport large scrolling, fit-width, fit-page, ×/÷1.10 custom zoom, and quarter-turn view rotation.
- Fresh documents settle to fit-page. Fit and rotation transforms preserve the visible page anchor; page changes reset to the page origin. Browser scrolling supplies hard edge clamping, so repeated pan commands cannot expose space beyond the rendered page.
- PDF canvases use CSS geometry independently from device-pixel backing dimensions. DPR changes at 100%, 125%, 150%, and 200% rerender the current page while keeping CSS geometry stable and reserving the full backing allocation.
- Only the committed canvas and an active successor may coexist. Render slots remain owned until their task settles, stale generations cannot replace the current canvas, and resource denial retains the prior healthy view.
- CP2 verification covers all committed Korean PDFs, rapid page/rotation replacement, fit transitions, exact scroll deltas and clamps, zoom bounds, DPR transforms, help-state generation, source immutability, lifecycle regression, and the retained no-bundle Windows x64 executable.

## CP3 implementation record

- One virtualized content layer follows the committed canvas and generation. PDF.js text remains pointer-selectable, while search traverses every page subject to 2 MiB UTF-8 per page, 64 MiB UTF-8 per document, 10,000 results, and a 30-second deadline.
- `/` performs trimmed case-insensitive literal search and `Enter`/`Shift+Enter` cycle results. Search uses one entry-to-finish deadline, releases deferred cleanup ownership before retry, and unmount owns teardown and quarantine. The current single-tab shell cancels extraction and releases highlights on replacement; it has no tab-state restoration claim. Textless documents report that OCR is unavailable.
- Adjacent wrapped annotation rectangles sharing one destination are merged into one reading-order hint; non-adjacent occurrences remain separate. `f` exposes deterministic labels; internal destinations require a PDF.js Name-shaped mode and strict operand validation, while resolution timeout is reported separately from unsupported destinations. External registration treats prepare as outcome-unknown until abort and quarantines failed abort cleanup until unmount. Frontend activation promises remain owned through registry replacement and teardown; monotonically increasing operation sequences and unique operation identifiers let native reject stale operations and retry idempotently. Dispatch expiry reports definitely not opened; ShellExecute timeout remains permanently outcome unknown. Rust admits only structurally valid `http`, `https`, and `mailto` targets to a bounded process-owned STA dispatcher; its worker invokes `ShellExecuteExW` with the validated target as `lpFile`, no parameters, and without retaining the PDF source.
- Keyboard range selection, reading-order remediation, OCR, and scanned-content remediation remain unavailable and are not advertised.
- External-link registry publication and activation use one absolute foreground deadline per lifecycle turn. A timed-out native registry operation is quarantined until its raw operation settles and its matching abort succeeds; failed abort cleanup remains retryable at unmount. The healthy overlay remains live while successor publication fails closed.
- Bounded external-launch reporting never releases the raw activation promise. Registry replacement and unmount retain that raw ownership through actual settlement; a bounded unmount rejection leaves its quarantine and lifecycle state intact for a later teardown attempt. After a new overlay is durable, finalization failure keeps the matching native registry live, quarantines future publication, and defers cleanup to unmount/session close.
- Registry turns check the absolute deadline before invoking each native action and supervise late ownership immediately. Search deadline checks run through synchronous text append, folding, result construction, range/highlight construction, and immediately before publication, so the 30-second budget spans entry to finish.

- Teardown closes a mounted epoch synchronously; later click activation and registry staging are rejected. Registry cleanup is retained per revision until its matching raw operation settles and abort succeeds.
