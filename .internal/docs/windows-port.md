# Modeleaf Windows Port

## Product decision

Modeleaf for Windows is a read-only, keyboard-first PDF viewer. The first supported platform is Windows 11 x64. Windows 10 and ARM64 are deferred. The owner authorizes reuse and public distribution of the existing Modeleaf code, name, and icon; dependency licenses and release signing still require validation.

The initial implementation uses Tauri 2, vanilla TypeScript/Vite, and PDF.js, subject to a measured Phase 0 gate. Rust is limited to native file selection and opaque read-only PDF sessions. If one focused remediation cannot make this stack meet the resource, performance, offline-worker, and application-chrome accessibility gates, the fallback is C# WinUI 3 with PDFium.

## Evidence from the macOS repository

The implementation order is derived from `DS-argus/modeleaf` history rather than only its README:

- `7a81e361` (2026-07-22): initial native Vim-style PDF reader.
- `22e32f4c` through the July 25 pane series: pane coordination, focus, topology, rollback, and QA became a large independent subsystem.
- `7f444939` (2026-07-27): command palette.
- PRs #4–#7 (2026-07-28): recent-file state, fuzzy open overlay, and gate fixes.
- PRs #10–#11: palette navigation and generated keyboard help.
- PRs #13–#17: prefix-relative bindings and transactional config reload/write/reset.
- PRs #19–#23: link hints evolved pure core, provider, UI geometry, dispatch, then acceptance/read-only proof.
- PRs #24–#28: rotation, help, literal-case notation, and key-grammar corrections.
- `e7555985`, `e5b1869c`, and later release commits: behavior was stabilized before packaging.

The Windows sequence therefore keeps pure contracts ahead of adapters, but moves shortcut fidelity ahead of panes and configuration.

## Architecture decision record

### Decision

Use a pure TypeScript shortcut and reader-state core, a minimal DOM UI, PDF.js for PDF semantics, and a narrow Tauri/Rust read-only boundary. Select exactly one measured PDF transport before product renderer work.

### Drivers

1. Preserve Vim-style shortcut fidelity without later semantic churn.
2. Keep source PDFs immutable and bound renderer resource use.
3. Produce maintainable Windows artifacts for GitHub Releases, Scoop, and WinGet.

### Alternatives

- **WinUI 3 + PDFium:** retained as fallback. It has native controls but requires owned bindings, native binary distribution, lifetime/threading rules, and more PDF semantic-layer work.
- **Electron + PDF.js:** rejected because its footprint conflicts with a restrained viewer.
- **Swift on Windows:** rejected because AppKit/PDFKit are not portable and FFI complexity outweighs reuse.

### Consequences

WebView2 deployment, PDF worker bundling, canvas allocation, cancellation, and content accessibility are explicit owned risks. Phase 1 accessibility covers application chrome, focus, navigation, help, status, and page announcements only. PDF text and reading-order accessibility is deferred to the text-layer phase.

## Frozen shortcut contract

Phase 1 meanings are stable and later phases must not replace them.

| Keys | Action | Repeat |
|---|---|---:|
| `Ctrl+O` | Open PDF | No |
| `n` / `p` | Next / previous page, clamped | Yes |
| `g` | Start page-target prefix; after 800 ms open an empty page prompt | No |
| `gg` | First page | No |
| `g` + digits + `Enter` | Go to one-based page | Digits only |
| `G` | Last page | No |
| `?` | Toggle registry-generated shortcut help | No |
| `Esc` | Cancel prefix/prompt or close the top overlay | No |
| `Backspace` | Delete the last page-prompt digit | Yes |

Digits may arrive before or after the 800 ms prompt transition. The prompt accepts at most nine ASCII digits. Zero or a value beyond the page count returns `PAGE_TARGET_OUT_OF_RANGE` and leaves the prompt open. Empty commit returns `PAGE_TARGET_EMPTY`; a tenth digit returns `PAGE_TARGET_TOO_LONG`. `Esc` cancels a pending prefix or prompt without an invalid-sequence error. Invalid claimed continuation consumes the key once, cancels the prefix, and emits `KEY_SEQUENCE_INVALID` without dispatching another action. Held-key repeat cannot complete `gg`.

Dispatch uses layout-aware `KeyboardEvent.key`; `code` is diagnostic only. Printable case is significant. Registered Ctrl-letter commands normalize letter case. IME/composition, `Dead`, `Process`, `Unidentified`, keyCode 229, AltGr, Ctrl+Alt, editables, Windows-key chords, Alt chords, OS-reserved chords, and unregistered Ctrl chords remain native and cancel pending sequence state without being prevented. Only registered repeatable actions accept repeat events.

Phase 2 adds frozen scrolling, half-page movement, zoom, fit, and rotation commands. A change to a Phase 1 meaning requires a new decision and migration review.

## PDF transport and resource gate

Phase 0 compares these transports with identical fixtures and measurements:

1. Custom opaque URI with complete range/CSP/origin behavior.
2. `PDFDataRangeTransport` over typed Tauri invoke, preferred absent contrary evidence.
3. Whole-document transfer restricted to 64 MiB, selectable only with an explicit product restriction.

The starting limits are: 512 MiB document, 1 MiB normal and 4 MiB maximum range, four concurrent ranges, DPR 2, canvas dimension 32,768, 64 million canvas pixels, 256 MiB backing canvas, 25 million decoded-image pixels, one active render, one 128 MiB canvas cache entry, 768 MiB peak and 512 MiB steady process-tree private working set, and post-close growth no greater than both 64 MiB and 25%.

Measurements record exact fixture hashes, Windows/WebView2/tool versions, display scaling, timer endpoints, every sample, median/p95/max, process-tree memory, cancellation, and offline-worker behavior. The representative 20 MiB/100-page PDF must reach first visible page within 2 seconds p95; input-to-state must remain below 50 ms p95. Limits use checked arithmetic and stable typed failures. Oversized content must never disappear silently.

Evidence belongs in `.internal/docs/evidence/windows-port-phase0/`. No renderer placeholder is added before the transport gate produces evidence.

## Development sequence

1. **Foundation:** this document, pinned project scaffold, Windows CI, fixed action/binding registry, pure sequence engine, reader/page-target state, generated help model, DOM ownership adapter, tests, and a minimal shell.
2. **Read-only vertical slice:** opaque Rust sessions, winning transport, PDF.js lifecycle, allocation budgets, cancellation, first-page render, native open dialog, and source immutability proof.
3. **Shortcut completion:** scrolling, zoom, fit, and view-only rotation using already-frozen meanings.
4. **Viewer workflows:** search/text layer, links/link hints, command palette, requested tab/recent workflows, and PDF-content accessibility.
5. **TOML configuration:** strict validation and transactional reload/write/reset after Windows token behavior is stable.
6. **Pane splitting:** only after single-view focus, lifecycle, and render budgets are stable.
7. **Distribution:** signed NSIS and portable ZIP assets from one immutable GitHub Release; Scoop consumes the ZIP and WinGet consumes the exact signed NSIS asset.

## Current foundation acceptance

- The action registry is the single source for matching and help rows.
- Prefix timing and stale timer handling are deterministic under fake time.
- Native-owned key events are not prevented.
- Reader navigation clamps at document boundaries.
- The minimal shell demonstrates shortcut dispatch and registry-derived help without pretending to render a PDF.
- TOML and pane code are absent.
- Focused tests, TypeScript checking, and the production web build pass.

## Decision log

- 2026-07-31: shortcut-driven workflow ranked first; configuration and panes deferred.
- 2026-07-31: Windows 11 x64 selected as the initial platform.
- 2026-07-31: Phase 1 accessibility explicitly limited to application chrome and page/status announcements.
- 2026-07-31: owner confirmed authority to reuse and publicly distribute the Modeleaf code, name, and icon.
- 2026-07-31: Tauri/PDF.js selected conditionally behind the transport and resource gate.
