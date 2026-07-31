# Modeleaf for Windows

Keyboard-first, read-only PDF viewer for Windows 11 x64. This repository is in the shortcut-first foundation phase.

## Current scope

- Fixed Phase 1 Windows shortcut registry
- Deterministic Vim-style sequence and page-target engine
- Reader state and registry-generated help
- Minimal Tauri 2 application shell
- No PDF renderer until the documented transport/resource gate is measured

TOML configuration and pane splitting are intentionally deferred. See [`.internal/docs/windows-port.md`](.internal/docs/windows-port.md) for the evidence, decisions, phase order, and acceptance gates.

## Development

Prerequisites: Node.js, Rust MSVC toolchain, Visual Studio Build Tools with the C++ workload, and WebView2.

```powershell
npm install
npm test
npm run build
npm run tauri -- build --no-bundle
```
