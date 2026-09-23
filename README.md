<div align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Modeleaf app icon" width="160">
  <h1>Modeleaf for Windows</h1>
</div>

A keyboard-first, read-only PDF reader for **Windows 11 x64**. Built with Tauri, Rust, TypeScript, and PDF.js.

## Features

- Local and Windows network PDFs, including password-protected documents
- Continuous reading, tabs, recent files, and navigation history
- Text search, selection/copying, and **Vimium-style PDF link hints**
- Fit width/page, zoom, rotation, and native printing
- Command palette, shortcut help, and seven themes

Source PDFs are never modified, and passwords are never saved.

## Install

Requires [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

```powershell
scoop bucket add modeleaf https://github.com/DS-argus/scoop-bucket
scoop install modeleaf/modeleaf
```

Or download a build from [Releases](https://github.com/DS-argus/modeleaf-win/releases).

To update:

```powershell
scoop update
scoop update modeleaf
```

The app does not update itself. See release notes for known limitations.

## Keyboard shortcuts

| Action                          | Key                           |
| ------------------------------- | ----------------------------- |
| Open PDF                        | `Ctrl+Shift+O`                |
| Scroll / large scroll           | `h` `j` `k` `l` / `d` `u`     |
| Previous / next page            | `p` / `n`                     |
| First / last page               | `gg` / `G`                    |
| Go to page                      | `g`, number, `Enter`          |
| Back / forward                  | `Ctrl+O` / `Ctrl+I`           |
| Search / next / previous result | `/` / `Enter` / `Shift+Enter` |
| Follow a PDF link               | `f`, then its label           |
| Fit width / page                | `w` / `F`                     |
| Zoom / Actual Size              | `=` `-` / `0`                 |
| Rotate                          | `[` / `]`                     |
| Previous / next tab             | `P` / `N`                     |
| Show folder / copy PDF path     | `y` / `yy`                    |
| Theme / palette / help          | `T` / `:` / `?`               |

## Development

Use the pinned [Node/npm](package.json) and [Rust](rust-toolchain.toml) versions, Visual Studio C++ Build Tools, and WebView2.

```powershell
npm ci
npm run tauri -- dev
```

## Credits

Based on [Modeleaf for macOS](https://github.com/DS-argus/modeleaf).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency licenses and theme attributions.
