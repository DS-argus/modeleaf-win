# Modeleaf for Windows

Keyboard-first, read-only PDF viewer for Windows 11 x64. The current code is a retained Windows prototype being re-baselined against the immutable Modeleaf v0.10.0 contract at `0f7ff0b54c3674c48f6b555261f939397cfbfb88`.

## Current scope
The bullets below describe the retained implementation baseline, not verified v0.10.0 parity. Track contract status in [`docs/parity-matrix.md`](docs/parity-matrix.md).

- Rust-owned single-file chooser for local fixed/removable volumes, with reparse and final-handle locality validation
- Exact-pinned, fully bundled PDF.js 5.7.284 renderer using opaque bounded range requests
- Candidate-first opening that preserves a healthy document on malformed, password, locality, timeout, render, or cleanup failures
- Registry-backed Phase 1 navigation plus `h`/`j`/`k`/`l` scrolling, `d`/`u` viewport scrolling, `w`/`F` fit modes, `=`/`-` zoom, and `[`/`]` view rotation
- Fit-page opening, fit-width reading, 10–800% custom zoom, anchor-preserving transforms, DPI-aware backing canvases, and bounded one-page virtualization
- Process-wide render/canvas reservations, stale-generation cancellation, and cancellation-before-release teardown
- Virtualized PDF.js text and annotation layers with trimmed case-insensitive literal search, native pointer selection/copy, internal destinations, and deterministic `f` link hints
- Rust-validated external `http`, `https`, and `mailto` activation without shell parsing; unsupported and unsafe PDF actions are rejected
- Keyboard range selection, reading-order remediation, OCR, and scanned-content remediation remain explicitly unavailable

TOML configuration and pane splitting are not implemented in the retained prototype. The immutable v0.10.0 contract, Windows deltas, phase order, and acceptance gates live in [`docs/windows-porting/`](docs/windows-porting/). Files under `.internal/docs/` describe historical v0.5.0 checkpoint evidence and are not parity authority.

## Development

Prerequisites: Node.js, Rust MSVC toolchain, Visual Studio Build Tools with the C++ workload, and WebView2.

```powershell
npm install
npm test
npm run build
npm run tauri -- build --no-bundle
```
## CP5 runtime guidance and limitations

Theme selection changes application chrome only; it does not filter PDF pixels. Accessibility support covers named application controls, keyboard focus, dialogs, status, and bounded live announcements, not full PDF-content accessibility, OCR, scanned-document remediation, reading-order remediation, or keyboard range selection. Diagnostics are local, bounded, redacted, and have no application network transport. The WebView2 runtime can independently contact Microsoft services according to Windows/WebView2 diagnostic policy. `Ctrl+Q` uses renderer-first cleanup with a bounded native fallback, and the retained CP5 evidence verifies clean process/job teardown.

Third-party review is tracked in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [direct dependency inventory](.internal/docs/dependency-licenses.txt). Run `node tools/legal/verify-third-party.mjs` after a production manifest, lockfile, copied PDF.js asset, or upstream theme attribution changes. This verifier is a local release gate for the reviewed inventory; it does not replace authoritative review of Rust crates and transitive dependencies.
