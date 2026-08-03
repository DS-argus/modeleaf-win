# Modeleaf Windows Port

## Product decision

Modeleaf for Windows is a read-only, keyboard-first PDF viewer. The first supported platform is Windows 11 x64; Windows 10 and ARM64 are deferred. The owner authorizes reuse and public distribution of the existing Modeleaf code, name, and icon. Dependency-license review and release distribution work remain separate, incomplete work.

The implementation uses Tauri 2, vanilla TypeScript/Vite, and PDF.js, subject to the measured Phase 0 transport and resource gate. Rust owns native file selection and opaque read-only PDF sessions. If focused remediation cannot meet the resource, performance, offline-worker, and application-chrome accessibility gates, the fallback is C# WinUI 3 with PDFium.

## Architecture decision record

Use a pure TypeScript shortcut and reader-state core, a minimal DOM UI, PDF.js for PDF semantics, and a narrow Tauri/Rust read-only boundary. Select exactly one measured PDF transport before product renderer work.

The drivers are shortcut fidelity, immutable source PDFs with bounded renderer resources, and an accessible local reader. WebView2 deployment, PDF worker bundling, canvas allocation, cancellation, and content accessibility remain explicit owned risks.

- **WinUI 3 + PDFium:** retained as the fallback; it requires owned bindings, native binary distribution, lifetime/threading rules, and more PDF semantic-layer work.
- **Electron + PDF.js:** rejected because its footprint conflicts with a restrained viewer.
- **Swift on Windows:** rejected because AppKit/PDFKit are not portable and FFI complexity outweighs reuse.

## WebView2 runtime guidance

The Windows shell uses the system WebView2 runtime supplied to Tauri. A missing, damaged, or out-of-date runtime can prevent the application from displaying its UI.

1. Install or repair the **Microsoft Edge WebView2 Evergreen Runtime** using the Microsoft-provided Evergreen installer appropriate to the device.
2. Close Modeleaf before repairing or reinstalling the runtime, then reopen the application.
3. If the problem remains, update Windows and Microsoft Edge, then repeat the Evergreen Runtime repair. Collect the exact user-visible failure and Windows/WebView2 version for support; do not include PDF paths, document contents, or diagnostics files in the report.

This is runtime guidance only. It does not assert that a Modeleaf installer bundles WebView2 or that any installer, signing, Scoop, or WinGet distribution exists.

## Accessibility and display behavior

CP5 implementation and acceptance are retained in `.internal/evidence/checkpoints/cp5`: full frontend/native/legal/build gates, headless 200%-scale browser evidence, Windows UIA/Ctrl+Q evidence, twenty lifecycle cycles, bounded resource samples, and the thirty-minute soak. Unsupported PDF-content accessibility remains explicitly out of scope.

- Application chrome exposes named controls, tab semantics, dialogs, focus restoration, status output, and finite live announcements for committed page/zoom, tab, search, link-hint, palette, theme, status, and safe error events. Generation-gated announcements discard stale document output and coalesce page/zoom changes.
- Accessible text is redacted and bounded. A document display name is reduced to a safe basename before it reaches accessible DOM; arbitrary paths, URLs, and native error detail are not announced.
- Forced-colors and reduced-motion rules are covered by source/integration gates; hidden Chromium at device scale factor 2 verifies the 200%-scale chrome geometry, focusability, accessible ordering, and absence of viewport overflow. WebView2 UIA evidence verifies required named chrome and ordering on Windows.
- PDF text remains pointer-selectable where PDF.js supplies a text layer. Modeleaf does not provide OCR, scanned-document remediation, reading-order remediation, or keyboard range selection. It does not claim full PDF-content accessibility.

## Themes and persistence recovery

Modeleaf defines exactly these six chrome themes: Tokyo Night (`tokyo-night`), Gruvbox Dark (`gruvbox-dark`), Solarized Dark (`solarized-dark`), Dracula (`dracula`), Everforest (`everforest`), and Catppuccin Latte (`catppuccin-latte`). Theme selection affects application chrome only; PDF page pixels are not theme-filtered.

Theme changes use preview, commit, and revert semantics. Native state is a separate bounded file with a schema version and a monotonically increasing revision. A commit requires the current base revision and persists before the new state is exposed. Missing, invalid, oversized, unreadable, or interrupted state recovers to Tokyo Night at revision zero; invalid bytes are quarantined when possible and interrupted temporary files are removed. Recovery exposes only a finite recovery signal, not filesystem details.

## Local diagnostics and quit

Diagnostics are native-owned, local-only JSON Lines. Modeleaf diagnostics have no application network transport; the WebView2 runtime may independently contact Microsoft services under Windows/WebView2 diagnostic policy. The renderer can submit only a finite diagnostic DTO: fixed event/outcome/tag/storage-class enums plus bounded numeric fields, version strings, and fixed-format identifiers. It cannot choose a log path or submit arbitrary message, map, path, or value fields. The local log limits each event to 1 KiB, each file to 8 KiB, and retains at most three log files.

`Ctrl+Q` is the quit action. It stops new work, drains owned PDF sessions and resource reservations, closes owned windows, completes bounded persistence, and exits. CP5 retained evidence covers a visible UIA `Ctrl+Q` journey plus twenty clean hidden lifecycle cycles; a three-second native fallback records failure and drains if the renderer cannot finish.

## Frozen shortcut contract

Phase 1 meanings are stable and later phases must not replace them.

| Keys | Action | Repeat |
|---|---|---:|
| `Ctrl+O` | Open PDF | No |
| `Ctrl+Q` | Quit after owned cleanup | No |
| `n` / `p` | Next / previous page, clamped | Yes |
| `g` | Start page-target prefix; after 800 ms open an empty page prompt | No |
| `gg` | First page | No |
| `g` + digits + `Enter` | Go to one-based page | Digits only |
| `G` | Last page | No |
| `?` | Toggle registry-generated shortcut help | No |
| `Esc` | Cancel prefix/prompt or close the top overlay | No |
| `Backspace` | Delete the last page-prompt digit | Yes |

Dispatch uses layout-aware `KeyboardEvent.key`; `code` is diagnostic only. Printable case is significant. Registered Ctrl-letter commands normalize letter case. IME/composition, `Dead`, `Process`, `Unidentified`, keyCode 229, AltGr, Ctrl+Alt, editables, Windows-key chords, Alt chords, OS-reserved chords, and unregistered Ctrl chords remain native and cancel pending sequence state without being prevented. Only registered repeatable actions accept repeat events.

## PDF transport and resource gate

Phase 0 compares a custom opaque URI, `PDFDataRangeTransport` over typed Tauri invoke, and a whole-document transfer restricted to 64 MiB. Measurements record fixture hashes, Windows/WebView2/tool versions, display scaling, timer endpoints, samples, process-tree memory, cancellation, and offline-worker behavior. Evidence belongs in `.internal/docs/evidence/windows-port-phase0/`.

## Current scope boundary

Configuration and panes remain deferred. Release distribution is not documented as complete: there is no current claim for an installer, signing, file association, Scoop, WinGet, or release artifact. The direct-dependency inventory is `.internal/docs/dependency-licenses.txt`; it is constrained to the current manifests and deliberately does not claim unverified license metadata.
