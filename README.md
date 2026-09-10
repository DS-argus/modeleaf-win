<div align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Modeleaf app icon" width="160">
  <h1>Modeleaf for Windows</h1>
</div>

A keyboard-first, read-only PDF viewer for Windows 11 x64, based on [Modeleaf for macOS](https://github.com/DS-argus/modeleaf).

## Philosophy

- **Read-only.** No annotation editing, saving, or changes to the source PDF.
- **Keyboard-first.** Vim-style navigation with a command palette and shortcut help.
- **Focused on reading.** Local PDFs, tabs, and a minimal interface.

## Key features

- Continuous reading, page navigation, and Back/Forward history
- Text search, text selection and copying, and ordinary PDF link clicks
- Tabs and a recent-file picker
- Fit width/page, zoom, and rotation
- Command palette, shortcut help, and seven interface themes

## Availability

Requires **Windows 11 x64** and **Microsoft Edge WebView2 Runtime**.

Published builds appear in [Releases](https://github.com/DS-argus/modeleaf-win/releases). The initial Windows release is **experimental**, not parity-complete or native-certified.

After `v0.1.0` is published, install that exact version with Scoop:

```powershell
scoop install https://github.com/DS-argus/modeleaf-win/releases/download/v0.1.0/modeleaf.json
```

This is a versioned manifest URL, not an automatic-update bucket. Live configuration, full-document printing, and update retrieval remain incomplete. See the [verification and release checklist](docs/windows-release-checklist.md) and [parity matrix](docs/parity-matrix.md) for limitations.

## Keys (defaults)

| Action | Key |
| --- | --- |
| Scroll / large scroll | `h` `j` `k` `l` / `d` `u` |
| Previous / next page | `p` / `n` |
| First / last page | `gg` / `G` |
| Go to page | `g`, number, `Enter` |
| Back / forward | `Alt+Left` / `Alt+Right` |
| Search / next / previous result | `/` / `Enter` / `Shift+Enter` |
| Fit width / page | `w` / `F` |
| Zoom / rotate | `=` `-` / `[` `]` |
| Previous / next tab | `P` / `N` |
| Theme / palette / help | `T` / `:` / `?` |

## Build from source

Use the Node.js/npm versions specified in [package.json](package.json), the Rust MSVC toolchain, Visual Studio Build Tools with the C++ workload, and WebView2 Runtime.

```powershell
npm ci
npm test
npm run build
npm run tauri -- build --no-bundle
```

For development, run `npm run tauri -- dev`. See the [engineering guide](docs/windows-porting/agent-runbook.md) for contribution and verification requirements.

## Credits

Original app: [DS-argus/modeleaf](https://github.com/DS-argus/modeleaf). Built with Tauri, Rust, TypeScript, and PDF.js.

Dependency licenses and theme attributions: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
