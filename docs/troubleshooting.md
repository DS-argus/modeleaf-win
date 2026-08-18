# Modeleaf troubleshooting

Modeleaf is a read-only PDF reader. It never modifies the PDFs you open, so nothing here can corrupt a source file.

## Installation

### The installer asks to download something before it finishes

Modeleaf renders PDFs with the Microsoft Edge WebView2 runtime. If your machine does not already have it, the installer fetches it once. This needs a working internet connection for that step only; Modeleaf itself works offline afterwards.

### The installer did not ask for administrator permission

That is intended. Modeleaf installs for the current user only, so it needs no elevation and writes nothing machine-wide.

### Windows warned about an unrecognized app

New signed applications have not yet built SmartScreen reputation. Reputation accrues over time from download history; it is not something a signature clears immediately.

## Opening PDFs

### Double-clicking a PDF does not open Modeleaf

Modeleaf registers as a PDF viewer but deliberately does not take over the system default. To change it, right-click the file, choose **Open with → Choose another app**, select Modeleaf, and tick **Always use this app**.

### A file will not open

| Symptom | Cause |
| --- | --- |
| "Document too large" | The file exceeds the reader's size limit |
| "File is unreadable" | Windows denied read access, or the file is locked by another program |
| "Not a valid PDF" | The file is corrupt or is not a PDF |
| "Remote path rejected" | The file is on a network path the reader will not open directly. Copy it locally first |

Nothing is written back to the file in any of these cases.

## Configuration

Your configuration lives at `%APPDATA%\com.dsargus.modeleaf\config.toml`.

### A configuration change did nothing

Press the reload binding. If the file has an error, Modeleaf reports the specific problem and **keeps your previous working settings**. It never silently falls back to defaults, so a typo cannot lose your keymap.

### An error mentions the `D` modifier

`D` is the macOS Command key and has no Windows equivalent. Modeleaf will not silently convert it to `Ctrl`, because that would collide with `Ctrl+O` and the history shortcuts. Choose an explicit Windows binding instead.

### Restore the defaults

Use the reset action. Modeleaf writes a backup before replacing anything, and the write-default action never overwrites an existing file.

## Reading

### The table of contents is empty

Modeleaf shows only a table of contents that is already embedded in the PDF. It never guesses one from headings or text, so a PDF without an embedded outline shows "No table of contents".

### A table of contents entry is greyed out

That entry points somewhere invalid — a missing page, or coordinates outside the page. It stays visible so the document structure is intact, but it cannot be selected.

### Printing seems slow on a large document

Every page is prepared individually so that all pages print, not just the ones currently on screen. Progress is reported while this runs, and cancelling stops it immediately and cleans up.

## Updates

Modeleaf only *tells* you an update exists. It never installs one, never restarts itself, and never runs anything in the background. When a newer version is available, the banner opens the release page in your browser and you choose what to do.

If update checking fails — no network, unreachable server, unexpected response — Modeleaf stays silent rather than interrupting your reading with an error you cannot act on.

## Data

Modeleaf stores exactly three things at `%LOCALAPPDATA%\com.dsargus.modeleaf\state.json`:

1. Your selected theme
2. Your recent files list
3. Your link-destination indicator preference

It does not store windows, sessions, tabs, page positions, zoom, rotation, history, or table-of-contents state. Every reading session starts clean by design.
