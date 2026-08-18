# Modeleaf Windows parity matrix

**Baseline:** Modeleaf v0.10.0, immutable commit [`0f7ff0b54c3674c48f6b555261f939397cfbfb88`](https://github.com/DS-argus/modeleaf/tree/0f7ff0b54c3674c48f6b555261f939397cfbfb88). Golden source links are indexed in [`windows-porting/source-index.md`](./windows-porting/source-index.md). This matrix reports observable Windows implementation evidence, not planned work.

**Last audited:** 2026-08-18 against `origin/main`, PRs #3-#29 merged.

## Status vocabulary

| Status | Meaning |
|---|---|
| `not-started` | No implementation evidence for the surface. |
| `partial` | Some implementation exists, but the complete golden acceptance contract is not evidenced. |
| `parity` | All golden behavior and evidence gates are demonstrated. |
| `intentional-delta` | The approved Windows behavior differs from macOS; ADR 0001 defines it. |
| `blocked` | A prerequisite measurement or platform gate prevents an implementation decision. |

No row is marked `parity` without fixture-backed, platform-appropriate evidence. `.internal/docs/windows-parity-ledger.md` is **historical v0.5.0 evidence only**, is not an authority, and cannot establish a status in this matrix.

A feature row cannot be `parity` while any phase it depends on is unfinished. Several rows below therefore stay `partial` even though their delivered phases passed, because a later phase still owns part of the surface.

## Feature-contract surfaces

| Feature-spec section | W phases | Status | Golden contract / source | Current Windows evidence | Windows delta | Next gate |
|---|---|---|---|---|---|---|
| 1. Product scope and read-only boundary | W01, W04, W06, W08 | `parity` | `feature-spec.md` §1; `PDFCapabilityPolicy.swift`; `ProductScopeTests.swift` | `src/pdf/PdfJsPolicy.ts` disables forms/scripts/media; `tests/unit/pdf/PdfJsPolicy.test.ts` and `tests/unit/ui/CopyContextMenu.test.ts` cover 11 cases; `tests/contract/goldenFixtures.test.ts` proves source PDFs are byte-identical. Merged in PRs #4, #10, #14, #18. | External opener is `http`/`https` only (ADR 0001). | Re-verify read-only invariants whenever the PDF.js pin changes. |
| 2. Open files and recents | W04, W09, W11 | `partial` | `feature-spec.md` §2; `PDFOpenService.swift`; `RecentFilesStore.swift` | `src/domain/recent/RecentFiles.ts`, `src/platform/OpenRequestClient.ts`, `src/platform/ShellOpenCoordinator.ts`, and `src-tauri` open/recent services; 18 tests including `tests/contract/w04NativeServicesContract.test.ts`. Shell routing target-awareness fixed in PR #25. | Windows paths and shell ingress use the Rust/Tauri boundary. | W11 unified Open/Recent picker UI and recent-prune matrix. |
| 3. View modes, zoom, rotation, rendering | W02, W06 | `parity` | `feature-spec.md` §3; `ReaderPDFView.swift`; `PDFViewController.swift` | `src/pdf/PdfReaderController.ts`, `ContinuousPageWindow.ts`, `PdfContentController.ts`, `ResourceBudget.ts`; 19 geometry/virtualization tests; `docs/evidence/w02/records/geometry.json` and `resource.json` both `pass` on the reference workstation. Merged in PRs #6, #14. | None approved. | Re-measure geometry evidence if the DPI or rotation pipeline changes. |
| 4. Action registry, key grammar, input routing | W03, W05 | `parity` | `feature-spec.md` §4; `ActionID.swift`; `ActionRegistry.swift`; `BuiltInDefaults.swift` | `src/domain/actions/ActionRegistry.ts`, `DefaultBindings.ts`, `src/domain/input/KeyGrammar.ts`, `KeySequenceTrie.ts`, `src/platform/RootKeyboardRouter.ts`; 34 tests; frozen 54-action snapshot in `tests/contract/snapshots/action-ids.json`. Merged in PRs #8, #12. | Ctrl/Alt/Shift grammar, `D` migration error, Ctrl defaults, Alt history, Alt+F4, and `Ctrl+B` prefix are ADR 0001 decisions. The seven pane actions are removed (ADR 0001), so the Windows contract is 54 actions, not the macOS 61. | Re-freeze snapshots on any registry change. |
| 5. Page navigation and app-owned history | W03, W06, W07 | `parity` | `feature-spec.md` §5; `NavigationHistory.swift`; PR #41 final viewport-landing rule | `src/domain/navigation/NavigationHistory.ts`, `src/core/ReaderState.ts`, `PageTarget.ts`; 7 history tests proving the 100-position cap, producer/exclusion matrix, and captured-landing semantics. Merged in PRs #8, #14, #16. | None approved. | Re-verify landing capture if the viewport anchor model changes. |
| 6. Search | W06, W07 | `parity` | `feature-spec.md` §6; `ReaderSearchCoordinator.swift` | `src/ui/SearchPromptController.ts` plus reader search in `PdfContentController.ts`; wrap, no-match, image-only, and epoch behavior covered by `tests/integration/pdfContentController.test.ts`. Merged in PRs #14, #16. | None approved. | Re-verify epoch semantics if search moves off the content controller. |
| 7. Links, hints, destination indicator | W06, W07, W08 | `partial` | `feature-spec.md` §7; `ReaderLink.swift`; `LinkHintMerge.swift`; `LinkDestinationIndicatorSettings.swift` | `src/domain/links/LinkHints.ts` and `IndicatorSettings.ts` (9 tests); annotation/link handling in `PdfContentController.ts`; `src/platform/ShellOpenCoordinator.ts` enforces the opener allowlist. Merged in PRs #18, #20, #22. | `http`/`https` opener allowlist is intentional. | W11 must wire `indicator.picker`; the five-style picker UI does not exist yet. |
| 8. Embedded-outline TOC | W06, W09, W10 | `parity` | `feature-spec.md` §8; `ReaderOutline.swift`; `TOCWidgetView.swift`; PR #45 | `src/pdf/PdfOutlineAdapter.ts` resolves destinations to page space with the finite/sentinel/8pt policy (22 tests); `src/domain/outlines/OutlineModel.ts` and `OutlineSelector.ts` normalize rows and buffer selectors (14 tests); `src/ui/reader/TocController.ts`, `TocWidgetModel.ts`, and `TocWidgetView.ts` deliver the floating active-tab widget (51 tests) with fake-clock 399/400ms proof and a seven-theme contrast gate. `toc.toggle`, `toc.scrollDown`, and `toc.scrollUp` are wired in `src/main.ts`. | `intentional-delta`: the TOC is owned by the active tab/window, not a pane (ADR 0001). | Re-verify outline geometry if the destination pipeline changes. |
| 9. Tabs and window duplication | W03, W05, W09 | `partial` | `feature-spec.md` §9; `TabStore.swift`; `PaneCoordinator.swift`; `ReaderDuplicationSnapshot.swift` | `src/core/TabWorkspace.ts` and `src/domain/tabs/TabStore.ts` (13 tests) implement a window-scoped tab workspace; `src/ui/shell/ShellProjection.ts` projects window → tabs. Merged in PRs #8, #12, #24, #25. | `intentional-delta`: panes, split topology, and split duplication are removed by owner directive (ADR 0001). Independent same-process windows replace side-by-side panes. | Packaged two-window isolation and Explorer/second-instance scenario on real Windows; not satisfied by JSDOM coverage. |
| 10. Palette, help, prompts, overlay focus | W03, W05, W11 | `partial` | `feature-spec.md` §10; `CommandPaletteTests.swift`; `HelpOverlayIntegrationTests.swift`; `ux-spec.md` §§8–16 | `src/ui/CommandPaletteModel.ts`, `HelpModel.ts`, `SearchPromptController.ts`, `src/ui/overlays/OverlayOwner.ts`; 19 tests covering overlay ownership and key routing. Merged in PRs #8, #12. | Native Windows titlebar remains outside overlay content. | W11 focus restoration, disabled-reason surfacing, IME, keyboard-only, Narrator, and minimum-size gates. |
| 11. Config load, reload, write, reset | W03, W04, W11 | `partial` | `feature-spec.md` §11; `ConfigValidator.swift`; `ConfigFileStore.swift`; `ConfigService.swift` | `src/domain/config/ConfigValidator.ts`, `ConfigFile.ts`, and `default-config.toml`; 10 tests; Rust transactions in `src-tauri/src/commands/config.rs`. Merged in PRs #8, #10. | `appConfigDir()/config.toml`; `D` is a migration error; Windows atomic replace/locking semantics apply. | W11 must wire `config.reload` and add the diagnostics/write/reset UI. |
| 12. State, themes, indicator persistence | W03, W04, W08, W11 | `partial` | `feature-spec.md` §12; `Theme.swift`; `BuiltInThemes.swift`; `StateFileStore.swift` | `src/domain/theme/Theme.ts` (seven palettes) and `src/ui/ThemePickerModel.ts`; 11 tests; `src-tauri/src/commands/state.rs` and `theme_state.rs` own durable merges. Merged in PRs #8, #10, #18. | State path and the three owned fields are fixed in ADR 0001; sessions/windows are never persisted. | W11 preview/rollback, indicator picker persistence, and the seven-palette contrast snapshot. |
| 13. Printing | W02, W12 | `partial` | `feature-spec.md` §13; `PDFViewController.swift`; `testing-risks.md` print gate | **Feasibility prototype only.** `src/pdf/PdfPrintPrototype.ts` is wired to `document.print` through `PdfReaderController.printCurrent`; 5 tests; `docs/evidence/w02/records/print.json` is `pass`. This is W02 evidence, **not** a production service. | No fallback to an OS default viewer is permitted. | W12 must replace the prototype with a document-scoped, memory-bounded service with progress, cancellation, cleanup, and 1/12/300-page fixture evidence. |
| 14. Windows, single instance, file association | W01, W04, W09, W13 | `partial` | `feature-spec.md` §14; `architecture.md` §4.1; Tauri sources in `source-index.md` | `src-tauri/src/lib.rs` implements same-process windows, current-window close, single-instance ingress, and target-aware shell routing (`select_shell_open_label`, 4 tests, PR #25); `tests/contract/w01ShellContract.test.ts` guards the shell contract. | Same-process multiwindow and current-window close are intentional (ADR 0001). | W13 packaged `.pdf` association, uninstall ownership, and clean-VM evidence. |
| 15. Update, installer, release | W11, W13 | `partial` | `feature-spec.md` §15; `UpdateCheck.swift`; `UpdateBannerTests.swift` | Pure domain only: `src/domain/update/SemanticVersion.ts` with 4 comparison tests. **No installer, update banner, or release tooling exists, and `update.show` is unwired.** | Notify-only update; signed current-user NSIS x64 with WebView2 download bootstrapper (ADR 0001). | W13 Windows metadata comparison, installer lifecycle, and update-notice tests. |

## Delivery-phase surfaces

Phase status reports whether that phase's own gate was run and merged. It does not assert that every downstream feature depending on the phase is finished.

| Phase | Status | Scope and current evidence | Gate before status can advance |
|---|---|---|---|
| W00 | `parity` | Contract freeze merged in PR #3: parity matrix, ADR 0001, action/theme/default snapshots, deterministic fixtures, and `manifest.json`. `tests/contract/goldenSnapshots.test.ts` and `goldenFixtures.test.ts` enforce them. | Re-freeze on any contract change; snapshot fingerprint must be recomputed. |
| W01 | `parity` | Secure Tauri shell, 1040×760/480×360 metrics, same-process multiwindow skeleton, single-instance registration, narrow capabilities. Merged in PR #4; guarded by `tests/contract/w01ShellContract.test.ts`. | Re-verify on any Tauri or capability change. |
| W02 | `parity` | Six machine-captured evidence records at `docs/evidence/w02/records/` — capability, geometry, outline, print, resource, transport — all `"result": "pass"`, bound to commit `d119104` with source and binary SHA-256 on Windows 11 / WebView2 151.0.4129.86. Merged in PR #6; `tests/contract/w02EvidenceContract.test.ts` validates record shape. | Re-measure if transport, worker, or DPI pipeline changes. |
| W03 | `parity` | Pure TypeScript core merged in PR #8, reduced to the 54-action contract in PR #24: registry, key grammar, config validation, history, outline, tabs, theme, and update reducers, all DOM/Tauri/PDF.js-free (`tests/contract/domainPurity.test.ts`). | Re-verify purity and snapshots on any domain change. |
| W04 | `parity` | Typed native services merged in PR #10: read-only document handles, unified open outcomes, config/state transactions preserving unknown fields, recent semantics, concurrency and fault injection. Guarded by `tests/contract/w04NativeServicesContract.test.ts`. | Re-verify on any durable-I/O change. |
| W05 | `parity` | Windows shell and routing merged in PR #12: registry-projected menu/palette/help/status, root keyboard routing, overlay-owner reducer, seven-theme tokens, current-window close. Guarded by `w05ShellContract.test.ts` and `w05ShellRouting.test.ts`. | Re-verify on any routing or overlay change. |
| W06 | `parity` | Single-reader presentation subsystem merged in PR #14: continuous virtualization, Fit Width default, layered canvas/text/annotation, render cancellation, anchor restore, leak-free teardown. Guarded by `w06PackagedSmokeContract.test.ts`. | Re-verify on any rendering-lifetime change. |
| W07 | `parity` | Search and app-owned navigation history merged in PR #16: latest-generation literal search, transient highlights, wrap semantics, canonical page-space landing capture, 100-position Back/Forward, search-epoch semantics. | Re-verify on any history-producer change. |
| W08 | `parity` | Links, hints, and destination indicator merged in PRs #18, #20, #22: visible annotation links only, `http`/`https` allowlist, exact-duplicate-only dedup, deterministic lowercase labels, indicator settings and persistence. | Re-verify on any link-activation change. |
| W09 | `partial` | Panes and split duplication removed in PR #24 (61 → 54 actions, ADR 0001); target-aware second-instance routing fixed in PR #25. Window-scoped tab store, same-process windows, current-window close, and drag/drop routing are implemented. | Packaged Windows two-window isolation, second-launch single-process, and Explorer/Open With scenarios per `testing-risks.md`. JSDOM coverage does not satisfy this. |
| W10 | `parity` | Active-tab embedded-outline TOC merged: adapter destination policy including the previously unimplemented sentinel-to-center rule, floating widget with fixed geometry, J/K single-row scrolling, silent 400ms numeric buffer, verified-landing history integration, lifecycle cancellation, accessibility semantics, and seven-theme contrast. | Re-verify on any outline or destination pipeline change. |
| W11 | `partial` | Palette, help, theme, search, and overlay models exist from W03/W05. `config.reload`, `indicator.picker`, and `update.show` remain unwired in `src/main.ts`. | Open/Recent picker, config diagnostics UI, indicator picker, forced-colors, text-scale, and 480×360 gates. |
| W12 | `not-started` | Only the W02 feasibility prototype (`PdfPrintPrototype.ts`) exists; it is wired to `document.print` but is not a production service. | System-print lifecycle, memory bounding, progress/cancel/error, artifact cleanup, and 1/12/300-page fixtures. |
| W13 | `not-started` | Only pure `SemanticVersion.ts` comparison logic exists. No installer configuration, update UI, or release tooling. | NSIS packaging, WebView2 bootstrapper, `.pdf` association, notify-only update UI, and the human-only clean-VM checklist. |

## Action-count reconciliation

The macOS v0.10.0 baseline freezes **61** action identifiers. The Windows product ships **54**: the seven `pane.*` actions (`pane.splitRight`, `pane.splitDown`, `pane.focusLeft`, `pane.focusDown`, `pane.focusUp`, `pane.focusRight`, `pane.unsplit`) are removed by the owner directive of 2026-08-18 and recorded as an approved Windows delta in ADR 0001. Of the 54, **50 are configurable** and 4 are fixed prompt/search bindings. `tests/contract/snapshots/action-ids.json` is the authority for the Windows contract; `pr-history.md` rows describing 61 actions describe the macOS baseline and remain accurate as history.

## Immutable supersession closure

The W00 contract uses the final source over historic descriptions: exact-duplicate (not adjacent) link hint dedupe; PDF.js separate annotations remain separate hints; PR #43's final update policy supersedes older install-source guidance; captured viewport landing supersedes stale current-page jump logic; the macOS baseline has 61 (not 58) actions, from which Windows removes 7 per ADR 0001; post-release PR #48 preserves the literal 400ms behavior with fake-clock tests; and embedded outline TOC is allowed without generic bookmark/OCR/attachment functionality. These rules originate in [`windows-porting/pr-history.md`](./windows-porting/pr-history.md) and are reflected in the relevant rows above.

### Supersession audit mapping

Every row in the authoritative [`windows-porting/pr-history.md`](./windows-porting/pr-history.md) audit index is bound to a frozen W00 artifact and a downstream verification gate:

| macOS PR row | Frozen W00 contract or fixture | Downstream proof owner |
|---|---|---|
| #1–#2 | `manifest.json`: `links.pdf`; Feature §1/§7 rows | W08 click/hint allowlist and read-only tests |
| #3 | Product defaults update policy; Feature §15 row | W13 notify-only update tests |
| #4–#9 | Product defaults caps/persistence; Feature §2/§12 rows | W04 state/recent transactions and W11 Open overlay |
| #10–#12 | Action snapshot; Feature §4/§10 rows | W03 registry and W11 palette/help projection |
| #13–#17 | Product defaults config bounds/grammar; Feature §11 row | W03 validator and W04 Windows transaction tests |
| #18 | Historical evidence classification in this matrix | W04 isolated-state fault tests |
| #19–#23 | `links.pdf` and `link-duplicates.pdf`; exact-dedup sentinel | W08 hint merge, geometry, input, and SHA tests |
| #24 | Feature §3 row; tab-local/non-persisted state contract | W06 4-DPI × 4-rotation tests |
| #25–#28 | 54-action/fixed-binding/default snapshots; Feature §4/§10 rows | W03 input reducer and W05/W11 prompt/help tests |
| #29 | Root `docs/pr-history.md` authority pointer | Every downstream PR links its macOS contract rows |
| #30–#35 | History cap/defaults; Feature §5–§7 rows | W03 history reducer and W07/W08 producer matrix |
| #38 | Notify-only Windows delta ADR | W13 actionable update UI tests |
| #39 | Distribution decision in ADR 0001 | W13 release-auth and installer checks |
| #41 | 400ms prefix and vertical-continuous/Fit Width defaults | W03 fake-clock input tests and W06/W07 landing tests |
| #43 | Notify-only update supersession in ADR 0001 | W13 Windows metadata comparison tests |
| #45 | `outline.pdf` wrapper/depth/duplicate/invalid/edge sentinels | W10 active-tab embedded-outline tests |
| #48 | Deterministic generator and contract tests | Local sharded/full verification; no GitHub Actions dependency |
