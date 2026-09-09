# ADR 0001: Windows platform deltas

- **Status:** Accepted
- **Date:** 2026-08-16
- **Baseline:** Modeleaf v0.10.0, `0f7ff0b54c3674c48f6b555261f939397cfbfb88`
- **Authority:** `docs/windows-porting/feature-spec.md`, `architecture.md`, `ux-spec.md`, `implementation-phases.md`, and the immutable sources indexed by `source-index.md`.

## Context

The Windows product preserves the v0.10.0 reader contract where platform behavior does not require a different implementation. The following deltas are intentional, bounded Windows decisions. They are not permission to add product surfaces.

## Decisions

### Same-process windows and current-window close

`app.new` creates an independent Tauri top-level window in the existing process. Each window owns its tabs, overlays, and history; process-wide Rust services are shared. `app.quit` remains the stable action ID, projects as **Close Window**, and closes only the invoking top-level window. `Alt+F4` has the same current-window behavior. The process exits when its final window closes. There is no `Exit All` action.

This replaces macOS's new-process implementation while preserving independent-window UX and prevents one window's close accelerator from destroying another window.

### No panes or split view

The Windows product does not port the macOS pane subsystem. Binary 1–4 pane topology, pane-owned tab stores, directional pane focus, dividers, unsplit, and verified-position split duplication are removed from scope by owner directive (2026-08-18). Tabs are owned by the window, and multiple documents are compared by opening independent windows with `app.new`.

This removes seven action IDs from the frozen v0.10.0 registry — `pane.splitRight`, `pane.splitDown`, `pane.focusLeft`, `pane.focusDown`, `pane.focusUp`, `pane.focusRight`, and `pane.unsplit` — reducing the contract from 61 to 54 actions, of which 50 are configurable. Their default bindings (prefix `|`, prefix `-`, prefix `o`, `Ctrl+H`, `Ctrl+J`, `Ctrl+K`, `Ctrl+L`) are released and not reassigned. The `panes: 4` cap is removed from the frozen product defaults.

Split duplication existed only as a pane-split operation and has no standalone action, so it is removed rather than re-homed. Reintroducing duplication on a tab or window action requires a separate owner decision. W10–W13 must not reintroduce pane actions, topology, UI, routing, persistence, tests, or release claims.

### Native Windows titlebar

The first release uses the native Windows titlebar and places the app tab strip below it. It does not port the transparent AppKit titlebar or traffic-light inset. This retains Windows caption controls, snap layouts, resize behavior, system menu integration, and Narrator semantics.

### Paths and durable state

Configuration is stored at `appConfigDir()/config.toml`; state is stored at `appLocalDataDir()/state.json`. These APIs already include the bundle identifier, so no extra product-name subdirectory is appended. State owns only `selected_theme`, `recent_files`, and `link_destination_indicator`; unknown top-level state fields are retained. Session, windows, tabs, page, zoom, rotation, history, and TOC UI state are never persisted.

Owner amendment, Issue #53 (2026-09-09): Recent rows expose a bounded `displayPath` containing the native-owned full file path for display only, alongside `displayName` and opaque `recentId`. This supersedes the filename-only recent projection, not the filesystem authority boundary: opening still accepts only the opaque ID, never a renderer path. Remove the Browse border but retain its keyboard focus indicator. Middle-truncate only the directory; keep the complete filename visible and reduce the row font size when necessary. Filename-only filtering, ordering, durable state, and open/clear transactions remain unchanged. Reader shortcuts `y`, `yy`, and `of` are deferred additions tracked in Issue #55, not implemented by this amendment.
### Windows key grammar and defaults

The key grammar uses `C=Ctrl`, `A=Alt`, and `S=Shift`; `Win` is not a configurable modifier. A macOS `D` modifier is a migration error, not a silent conversion to Ctrl. The default templates use Ctrl for Open/Close/Print/New, palette, and tab selection; `Alt+Left`/`Alt+Right` for app-owned history; `Alt+F4` for current-window close; and `<C-b>` as the command prefix. The four fixed prompt/search bindings remain non-configurable.

Owner amendment, Issue #53 (2026-09-09): default `document.open` is `Ctrl+Shift+O` (`<C-S-o>`), replacing `Ctrl+O` without a default alias. Explicit user keymap overrides remain authoritative; no user config/state migration is performed. History remains `Alt+Left`/`Alt+Right`. The Open chooser removes its Browse glyph and separates Browse from Recent with a theme-aware divider. Regular window tabs use equal 184px slots and 26px height, with filename ellipsis and accessible full names rather than filename-dependent widths.

### Opaque PDF transport remains pending W02 evidence

The target design is a Rust-owned read-only opaque document handle exposed through a Range-capable custom protocol. No production transport is selected by this ADR. W02 must measure packaged WebView2 Range/CORS/worker behavior, first-page latency, memory, and geometry. Only if the custom protocol fails those gates may W02 evaluate Tauri optimized binary response with a one-shot `ArrayBuffer`; JSON/base64 transport is prohibited. The resulting evidence and final selection belong in ADR 0002.

### External URL opener allowlist

The Rust opener parses URLs and permits only `http` and `https`. Other schemes are inert with a non-blocking diagnostic. TypeScript does not invoke raw shell commands.

### Updates

Update checking compares Windows release metadata after launch and fails silently for network or parsing errors. A newer version enables a status banner and `update.show`, which opens the Windows release/download page. Updates are notify-only: no updater install API, background installation, forced restart, or self-update is included.

### Distribution

The initial channel is an Authenticode-signed x64 NSIS installer in `currentUser` mode, with the WebView2 `downloadBootstrapper`. The installer registers `.pdf` association without forcing the default PDF application and removes only its own registration on uninstall. MSI, Store, arm64 distribution, and self-updating are outside this decision.

## Consequences

Windows-specific tests must prove same-process two-window isolation, current-window `Alt+F4`, path placement, Windows grammar migration errors, URL allowlisting, notify-only update behavior, and packaged installer behavior. W02 transport remains an explicit release dependency rather than an assumed implementation detail.

## Supersession notes

The immutable source overrides historic PR descriptions: link-hint deduplication is exact-duplicate only; viewport landing, not stale current-page state, determines meaningful jumps; TOC reads only embedded outlines; and Windows does not inherit macOS Homebrew update behavior. `.internal/docs/windows-parity-ledger.md` is historical v0.5.0 evidence only and is not a parity authority.
