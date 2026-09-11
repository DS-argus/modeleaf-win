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

After the experimental release and its [Scoop bucket](https://github.com/DS-argus/scoop-bucket) are published, install with PowerShell:

```powershell
scoop bucket add modeleaf https://github.com/DS-argus/scoop-bucket
scoop install modeleaf/modeleaf

# Update an installed version after a new release reaches the bucket
scoop update
scoop update modeleaf
```

Scoop updates are user-invoked and become available after the bucket manifest is updated. The app does not update itself. Live configuration, full-document printing, and in-app update retrieval remain incomplete. See the [verification and release checklist](docs/windows-release-checklist.md) and [parity matrix](docs/parity-matrix.md) for limitations.

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
