# Modeleaf Windows parity ledger

Upstream baseline: `DS-argus/modeleaf@d809e2e4d6aa5f257c91ff38b2cd4503e17405f0` (v0.5.0)

This ledger tracks behavior, not AppKit/PDFKit implementation structure. Windows acceptance is governed by the approved CP0–CP5 plan.

| Contract | Upstream evidence | Windows checkpoint | Acceptance / approved deviation |
|---|---|---:|---|
| Keyboard navigation | `ActionID.swift`, `ActionRegistry.swift`, built-in bindings | CP1–CP2 | Preserve existing Phase 1 IDs, timing, prompt behavior, help, and registry ownership. |
| Read-only PDF lifecycle | `ReaderSession.swift` teardown and document ownership | CP0–CP1 | Rust owns read-only local handles and opaque sessions; cancel/barrier/close order is mandatory. |
| View state | reader zoom, fit, rotation and navigation actions | CP2 | Fresh documents open page 1 fit-page; fit-width is continuous; rotation is view-only and tab-local. |
| Search | `ReaderSearchWorkflowTests`, including per-tab isolation | CP3 | Trimmed case-insensitive literal search; query/results/highlights restore per tab with bounded extraction. |
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
