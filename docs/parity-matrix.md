# Modeleaf Windows parity matrix

**Baseline:** Modeleaf v0.10.0, immutable commit [`0f7ff0b54c3674c48f6b555261f939397cfbfb88`](https://github.com/DS-argus/modeleaf/tree/0f7ff0b54c3674c48f6b555261f939397cfbfb88). Golden source links are indexed in [`windows-porting/source-index.md`](./windows-porting/source-index.md). This matrix reports observable Windows implementation evidence, not planned work.

## Status vocabulary

| Status | Meaning |
|---|---|
| `not-started` | No implementation evidence for the surface. |
| `partial` | Some implementation exists, but the complete golden acceptance contract is not evidenced. |
| `parity` | All golden behavior and evidence gates are demonstrated. |
| `intentional-delta` | The approved Windows behavior differs from macOS; ADR 0001 defines it. |
| `blocked` | A prerequisite measurement or platform gate prevents an implementation decision. |

No row is marked `parity` without fixture-backed, platform-appropriate evidence. `.internal/docs/windows-parity-ledger.md` is **historical v0.5.0 evidence only**, is not an authority, and cannot establish a status in this matrix.

## Feature-contract surfaces

| Feature-spec section | W phases | Status | Golden contract / source | Current Windows evidence | Windows delta | Next gate |
|---|---|---|---|---|---|---|
| 1. Product scope and read-only boundary | W01, W04, W06, W08 | `partial` | `feature-spec.md` §1; `PDFCapabilityPolicy.swift`; `ProductScopeTests.swift` | `src/pdf/PdfJsPolicy.ts`, `PdfReaderController.ts`, and `PdfContentController.ts` establish a constrained PDF.js reader surface. | External opener is `http`/`https` only (ADR 0001). | W06/W08 fixture evidence for Copy-only context menu, inert forms/media/scripts, and source-SHA invariance. |
| 2. Open files and recents | W04, W09, W11 | `partial` | `feature-spec.md` §2; `PDFOpenService.swift`; `RecentFilesStore.swift` | `src/platform/OpenRequestClient.ts`, `ShellOpenCoordinator.ts`, and `src-tauri` open/recent services exist. | Windows paths and shell ingress use the Rust/Tauri boundary. | W04 typed-outcome and durable transaction gates; W09 Explorer handoff; W11 recent-prune matrix. |
| 3. View modes, zoom, rotation, rendering | W02, W06 | `partial` | `feature-spec.md` §3; `ReaderPDFView.swift`; `PDFViewController.swift` | `src/pdf/PdfReaderController.ts`, `ContinuousPageWindow.ts`, `PdfContentController.ts`, and `ResourceBudget.ts` implement reader/rendering components. | None approved. | W02 packaged Range, worker, DPI/rotation geometry, virtualization evidence; W06 reader E2E. |
| 4. Action registry, key grammar, input routing | W03, W05 | `partial` | `feature-spec.md` §4; `ActionID.swift`; `ActionRegistry.swift`; `BuiltInDefaults.swift` | `src/core/Action.ts`, `defaultBindings.windows.ts`, `KeyToken.ts`, `KeySequenceEngine.ts`, and `src/platform/keyboardAdapter.ts` implement a narrower current action/input surface. | Ctrl/Alt/Shift grammar, `D` migration error, Ctrl defaults, Alt history, Alt+F4, and Ctrl+B prefix are ADR 0001 decisions. | W03 exact 61-action registry/default collision and fixed-binding tests; W05 IME/dead-key/AltGraph and accelerator routing evidence. |
| 5. Page navigation and app-owned history | W03, W06, W07 | `partial` | `feature-spec.md` §5; `NavigationHistory.swift`; PR #41 final viewport-landing rule | `src/core/ReaderState.ts`, `PageTarget.ts`, and reader controllers implement navigation primitives. | None approved. | W07 transaction tests proving 100-position cap, producer/exclusion matrix, and captured-landing semantics. |
| 6. Search | W06, W07 | `partial` | `feature-spec.md` §6; `ReaderSearchCoordinator.swift` | `src/ui/SearchPromptController.ts` and reader controllers provide a current search path. | None approved. | W07 rapid replacement, image-only/no-match, wrap, highlight, and history-epoch evidence. |
| 7. Links, hints, destination indicator | W06, W07, W08 | `partial` | `feature-spec.md` §7; `ReaderLink.swift`; `LinkHintMerge.swift`; `LinkDestinationIndicatorSettings.swift` | PDF annotation/content controller code and `src/platform/ShellOpenCoordinator.ts` provide partial link/open handling. | `http`/`https` opener allowlist is intentional. | W08 exact-duplicate-only fixtures, hint modal routing, all DPI/rotation geometry, and indicator persistence tests. |
| 8. Embedded-outline TOC | W06, W09, W10 | `not-started` | `feature-spec.md` §8; `ReaderOutline.swift`; `TOCWidgetView.swift`; PR #45 | No dedicated outline/TOC model or pane-local widget is present in `src/`. | None approved. | W10 real outline adapter, normalization/selectors, pane-local widget, and 399/400ms fake-clock gate. |
| 9. Tabs, panes, split duplicate | W03, W05, W09 | `partial` | `feature-spec.md` §9; `TabStore.swift`; `PaneCoordinator.swift`; `ReaderDuplicationSnapshot.swift` | `src/core/TabWorkspace.ts` and `main.ts` implement a tab workspace. | Independent same-process windows are intentional; pane cap remains four. | W09 binary split topology, verified-position duplication, 1–4 pane, and two-window isolation gates. |
| 10. Palette, help, prompts, overlay focus | W03, W05, W11 | `partial` | `feature-spec.md` §10; `CommandPaletteTests.swift`; `HelpOverlayIntegrationTests.swift`; `ux-spec.md` §§8–16 | `src/ui/CommandPaletteModel.ts`, `HelpModel.ts`, `SearchPromptController.ts`, and `main.ts` contain current overlays. | Native Windows titlebar remains outside overlay content. | W11 focus restoration, disabled-reason, IME, keyboard-only, Narrator, and minimum-size gates. |
| 11. Config load, reload, write, reset | W03, W04, W11 | `partial` | `feature-spec.md` §11; `ConfigValidator.swift`; `ConfigFileStore.swift`; `ConfigService.swift` | Windows binding/default data is in `src/core/defaultBindings.windows.ts`; Rust-side services are present under `src-tauri`. | `appConfigDir()/config.toml`; `D` is a migration error; Windows atomic replace/locking semantics apply. | W04 fault-injected read/write/reset/lock evidence and W11 generated-config synchronization. |
| 12. State, themes, indicator persistence | W03, W04, W08, W11 | `partial` | `feature-spec.md` §12; `Theme.swift`; `BuiltInThemes.swift`; `StateFileStore.swift` | `src/core/Theme.ts`, `src/ui/ThemePickerModel.ts`, and `main.ts` implement theme state/picker behavior. | State path and the three owned fields are fixed in ADR 0001; sessions/windows are never persisted. | W04 field-isolation/concurrent-merge evidence; W08 indicator persistence; W11 preview/rollback and seven-palette snapshot. |
| 13. Printing | W02, W12 | `not-started` | `feature-spec.md` §13; `PDFViewController.swift`; `testing-risks.md` print gate | No dedicated print service or production print evidence is present. | No fallback to an OS default viewer is permitted. | W02 prototype, then W12 system-dialog, cancellation, artifact cleanup, and source-hash gates. |
| 14. Windows, single instance, file association | W01, W04, W09, W13 | `partial` | `feature-spec.md` §14; `architecture.md` §4.1; Tauri sources in `source-index.md` | `src/platform/OpenRequestClient.ts`, `ShellOpenCoordinator.ts`, and `src-tauri` support the current native/open-request path. | Same-process multiwindow and current-window close are intentional (ADR 0001). | W09 second-launch routing and close-isolation; W13 packaged association/uninstall evidence. |
| 15. Update, installer, release | W11, W13 | `not-started` | `feature-spec.md` §15; `UpdateCheck.swift`; `UpdateBannerTests.swift` | No Windows release/installer/update implementation evidence is recorded in the product source. | Notify-only update; signed current-user NSIS x64 with WebView2 download bootstrapper (ADR 0001). | W13 Windows metadata comparison, signed clean-VM installer lifecycle, and update-notice tests. |

## Delivery-phase surfaces

| Phase | Status | Scope and current evidence | Gate before status can advance |
|---|---|---|---|
| W00 | `partial` | This matrix, ADR 0001, and immutable contract snapshots define the contract portion. | Fixture manifest/PDF evidence and contract validation must cover every frozen artifact. |
| W01 | `partial` | Current TypeScript shell and `src-tauri` tree provide implementation evidence. | Clean Windows shell/security/CI evidence, native titlebar, and single-instance lifecycle gate. |
| W02 | `blocked` | PDF reader/range components exist in `src/pdf/`, but no packaged measurement record is present. | Measure custom-protocol Range/CORS/worker, geometry, virtualization, and print prototype; select transport only in ADR 0002. |
| W03 | `partial` | Current core modules cover portions of actions, bindings, state, workspace, and themes. | Pure TS contracts must exactly cover all 61 actions, input/config/history/outline/pane/theme/update reducers. |
| W04 | `partial` | `src-tauri` and platform clients provide native service evidence. | Typed open outcomes, safe config/state transactions, locks, and field isolation. |
| W05 | `partial` | `main.ts` and UI models provide shell/action/overlay evidence. | Registry-derived menu routing, focus ownership, IME/accelerator, and two-window tests. |
| W06 | `partial` | PDF.js reader, continuous window, content controller, and resource budget are present. | Fixture-backed first-page-to-close reader loop and read-only/geometry/cleanup evidence. |
| W07 | `partial` | Navigation and search components exist, without the complete contract evidence. | App-owned captured-landing history and search epoch gates. |
| W08 | `partial` | Annotation/link and shell-open components exist, without complete hint/indicator behavior. | Exact-dedup, allowlist, indicator, and geometry gates. |
| W09 | `partial` | Tab workspace and native open-request code exist; panes and multiwindow parity are incomplete. | Four-pane topology, same-process two-window, and Explorer routing gates. |
| W10 | `not-started` | No dedicated embedded-outline projection or TOC UI evidence exists. | Complete pane-local TOC contract and fixture suite. |
| W11 | `partial` | Palette/help/theme/search UI models exist. | Recents/config/theme/indicator accessibility and persistence integration gates. |
| W12 | `not-started` | No production print service evidence exists. | System-print lifecycle and memory/cancellation gates. |
| W13 | `not-started` | No installer, signing, Windows update notice, or release-hardening evidence exists. | Signed packaged clean-VM and final parity evidence. |

## Immutable supersession closure

The W00 contract uses the final source over historic descriptions: exact-duplicate (not adjacent) link hint dedupe; PDF.js separate annotations remain separate hints; PR #43's final update policy supersedes older install-source guidance; captured viewport landing supersedes stale current-page jump logic; v0.10.0 has 61 (not 58) actions; post-release PR #48 preserves the literal 400ms behavior with fake-clock tests; and embedded outline TOC is allowed without generic bookmark/OCR/attachment functionality. These rules originate in [`windows-porting/pr-history.md`](./windows-porting/pr-history.md) and are reflected in the relevant rows above.

### Supersession audit mapping

Every row in the authoritative [`windows-porting/pr-history.md`](./windows-porting/pr-history.md) audit index is bound to a frozen W00 artifact and a downstream verification gate:

| macOS PR row | Frozen W00 contract or fixture | Downstream proof owner |
|---|---|---|
| #1–#2 | `manifest.json`: `links.pdf`; Feature §1/§7 rows | W08 click/hint allowlist and read-only tests |
| #3 | Product defaults update policy; Feature §15 row | W13 notify-only update tests |
| #4–#9 | Product defaults caps/persistence; Feature §2/§12 rows | W04 state/recent transactions and W11 Open overlay |
| #10–#12 | 61-action snapshot; Feature §4/§10 rows | W03 registry and W11 palette/help projection |
| #13–#17 | Product defaults config bounds/grammar; Feature §11 row | W03 validator and W04 Windows transaction tests |
| #18 | Historical evidence classification in this matrix | W04 isolated-state fault tests |
| #19–#23 | `links.pdf` and `link-duplicates.pdf`; exact-dedup sentinel | W08 hint merge, geometry, input, and SHA tests |
| #24 | Feature §3 row; pane-local/non-persisted state contract | W06 4-DPI × 4-rotation tests |
| #25–#28 | 61-action/fixed-binding/default snapshots; Feature §4/§10 rows | W03 input reducer and W05/W11 prompt/help tests |
| #29 | Root `docs/pr-history.md` authority pointer | Every downstream PR links its macOS contract rows |
| #30–#35 | History cap/defaults; Feature §5–§7 rows | W03 history reducer and W07/W08 producer matrix |
| #38 | Notify-only Windows delta ADR | W13 actionable update UI tests |
| #39 | Distribution decision in ADR 0001 | W13 release-auth and installer checks |
| #41 | 400ms prefix and vertical-continuous/Fit Width defaults | W03 fake-clock input tests and W06/W07 landing tests |
| #43 | Notify-only update supersession in ADR 0001 | W13 Windows metadata comparison tests |
| #45 | `outline.pdf` wrapper/depth/duplicate/invalid/edge sentinels | W10 pane-local embedded-outline tests |
| #48 | Deterministic generator and contract tests | Local sharded/full verification; no GitHub Actions dependency |
