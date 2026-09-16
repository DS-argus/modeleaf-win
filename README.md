<div align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="Modeleaf app icon" width="160">
  <h1>Modeleaf for Windows</h1>
</div>

A keyboard-first, read-only PDF viewer for Windows 11 x64.

## Philosophy

- **Read-only.** No annotation editing, saving, or changes to the source PDF.
- **Keyboard-first.** Vim-style navigation with a command palette and shortcut help.
- **Focused on reading.** Local PDFs, tabs, and a minimal interface.

## Key features

- Continuous reading, page navigation, and Back/Forward history
- Text search, text selection/copying, and ordinary PDF link clicks
- Tabs, a recent-file picker, folder-path display, and PDF-path copying
- Fit width/page, Actual Size, zoom, and rotation
- Native system printing with progress and cancellation, preserving page coverage
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

Scoop updates are user-invoked and become available after the bucket manifest is updated. The app does not update itself. Printing uses the native system dialog with bounded, complete raster-page preparation; `Submitted to printer` confirms submission, not physical output or a completed Save As file. `of` (reveal the current PDF in Explorer) is not included yet.

## Keys (defaults)

| Action | Key |
| --- | --- |
| Scroll / large scroll | `h` `j` `k` `l` / `d` `u` |
| Previous / next page | `p` / `n` |
| Show folder / copy PDF path | `y` / `yy` |
| First / last page | `gg` / `G` |
| Go to page | `g`, number, `Enter` |
| Actual Size | `0` |
| Back / forward | `Alt+Left` / `Alt+Right` |
| Search / next / previous result | `/` / `Enter` / `Shift+Enter` |
| Fit width / page | `w` / `F` |
| Zoom / rotate | `=` `-` / `[` `]` |
| Previous / next tab | `P` / `N` |
| Theme / palette / help | `T` / `:` / `?` |

New PDFs open in **continuous reading** at the first page's Fit Page-derived scale, without selecting Fit Page mode. Scrolling keeps that scale; resizing or rotating refits the same reference page. Press `F` to explicitly fit the current page and show Fit Page mode.

Precision-trackpad scrolling and pinch gestures are not currently supported.
Use **Ctrl+wheel** to zoom around the pointer in 10% multiplicative steps (10–800%). Small wheel movements accumulate; normal wheel input scrolls. Over page margins, zoom preserves the nearest page edge. Use `h`/`l` or the left/right arrows to scroll horizontally when zoomed in. `0` selects PDF.js scale 1, not a calibrated physical paper size.

## Build from source

Use the Node.js/npm versions specified in [package.json](package.json), the Rust MSVC toolchain, Visual Studio Build Tools with the C++ workload, and WebView2 Runtime.

```powershell
npm ci
npm test
npm run build
npm run tauri -- build --no-bundle
```

For development, run `npm run tauri -- dev`. Follow `AGENTS.md` for engineering and verification requirements.

## Credits

Original app: [DS-argus/modeleaf](https://github.com/DS-argus/modeleaf). Built with Tauri, Rust, TypeScript, and PDF.js.

Dependency licenses and theme attributions: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
