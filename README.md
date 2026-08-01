# Modeleaf for Windows

Keyboard-first, read-only PDF viewer for Windows 11 x64. The current checkpoint is a usable local-PDF reader with a Rust-owned file/session boundary.

## Current scope

- Rust-owned single-file chooser for local fixed/removable volumes, with reparse and final-handle locality validation
- Exact-pinned, fully bundled PDF.js 5.7.284 renderer using opaque bounded range requests
- Candidate-first opening that preserves a healthy document on malformed, password, locality, timeout, render, or cleanup failures
- Registry-backed `Ctrl+O`, `n`, `p`, `g` + digits + `Enter`, `gg`, `G`, `?`, `Escape`, and prompt `Backspace`
- Process-wide render/canvas reservations and cancellation-before-release teardown

TOML configuration and pane splitting are intentionally deferred. See [`.internal/docs/windows-port.md`](.internal/docs/windows-port.md) for the evidence, decisions, phase order, and acceptance gates.

## Development

Prerequisites: Node.js, Rust MSVC toolchain, Visual Studio Build Tools with the C++ workload, and WebView2.

```powershell
npm install
npm test
npm run build
npm run tauri -- build --no-bundle
```
