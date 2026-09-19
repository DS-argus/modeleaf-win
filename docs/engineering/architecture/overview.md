# Windows architecture and ownership

Modeleaf is a Tauri 2 Windows PDF reader with a TypeScript/Vite renderer in WebView2 and PDF.js behind reader adapters. This is a current boundary map, not a macOS parity plan or a complete module inventory. Product behavior remains documented in [README](../../../README.md); repository-wide constraints live in [AGENTS.md](../../../AGENTS.md).

## Dependency and authority boundaries

- **Pure domain:** `src/domain` owns deterministic actions, input grammar, configuration validation, navigation, tabs, recents, themes, and version comparison. It must not depend on application/UI/platform/PDF adapters, DOM, Tauri, or PDF.js. [domainPurity.test.ts](../../../tests/contract/domainPurity.test.ts) enforces that direction.
- **Renderer composition:** [src/main.ts](../../../src/main.ts) composes the shell, workspace, overlays, input routing, open coordination, and per-tab presentation. `src/application` coordinates workflows; `src/platform` contains native command/event adapters. Browser state does not grant filesystem authority.
- **Per-tab presentation:** [PdfTabSession](../../../src/pdf/PdfTabSession.ts) composes reader state, reader/content controllers, activation, history, suspension, and disposal. PDF.js is contained in reader adapters rather than exposed as its generic viewer/editor UI. Inactive tabs can release heavy resources without becoming durable sessions.
- **Native authority:** [src-tauri/src/lib.rs](../../../src-tauri/src/lib.rs) wires Tauri commands, the `modeleaf-pdf` protocol, native services, and window lifecycle. [PdfSessionManager](../../../src-tauri/src/pdf_session.rs) retains the actual read-only file handles and admits bounded reads. Renderer-visible paths/labels are presentation data, not permission to access arbitrary files.

## Opening and cleanup

Native startup/second-instance argv, drag/drop, and picker selection enter the open-request coordinator. Renderer adoption is serialized: reuse or stage a tab, adopt/render, then commit successful presentation; failure rolls back. Successful adoption precedes recent-file recording, and Rust derives the trusted recent identity from the retained session handle.

Protected-document challenges stay inside the candidate's PDF.js loading lifetime. The reader owns challenge generations, cancellation, and bounded loading time; time spent waiting for password input does not consume the metadata deadline. The shell owns the modal prompt and rejects new open ingress rather than replaying it after dismissal. Passwords are ephemeral renderer-to-PDF.js callback values, never native DTOs or durable state. Cancellation rolls back the staged tab and restores the prior focus; window close cancels the challenge before draining sessions.

Native PDF access is scoped by window owner, owner generation, session identifier, and document generation. Preserve those checks and renderer stale-result guards when changing async code. A tab/window switch or close must not let late work mutate a new owner's presentation.

Normal native session closure is cancellation-barrier gated: drain reads, printing, and external-link work before removing the session. Window/application teardown is deadline-bounded and can defer unsettled cleanup; do not equate a timeout or a submitted print job with successful completion. Tests and the owning implementation, not a simplified diagram, define detailed transitions.

## PDF link hints

`PdfContentController` supplies bounded, immutable snapshots of actionable annotation occurrences intersecting the reader viewport. Selection retains opaque identity and snapshot authority; `PdfTabSession` forwards selection through existing guarded navigation or the committed native external-link registry. No text URL inference, synthetic clicks, or alternate shell-launch path is used.

The shell owns transient hint labels and an anchored safe-text URL confirmation. Its root input route gives hint characters priority over reader bindings without overriding password, editable, IME, print, or overlay ownership. Viewport and owner changes invalidate selection; external launch requires a fresh non-repeat Enter and cannot be retracted once dispatched. Only successful hint-initiated internal navigation with an explicit PDF coordinate receives a transient transformed marker. Ordinary clicks, page-only targets, and unrelated history/navigation do not acquire new confirmation or marker behavior. No hint, popup, or indicator fields are persisted.

## Persistence

Rust initializes config, state, and diagnostic services in app-local storage. Config is `config.toml`; the active writer-owned `state.json` fields are **selected_theme** and **recent_files**. Reader pages, zoom, rotation, viewport/history, windows, tabs, and sessions are not persisted.

The [native state store](../../../src-tauri/src/commands/state.rs) uses the shared persistence lock/atomic-write helpers and merges its fields while preserving unknown top-level siblings. Unknown data is not active feature authority. See [persistenceContract.test.ts](../../../tests/contract/persistenceContract.test.ts) and native persistence tests before widening state ownership. Theme commits and recent updates must surface native failures rather than reporting a durable success prematurely.

## Generated inputs and durable sources

- [package-lock.json](../../../package-lock.json) and [Cargo.lock](../../../src-tauri/Cargo.lock) lock dependencies; use the toolchain pins rather than inferring versions from minimum-version declarations.
- [sync-assets.mjs](../../../tools/pdfjs/sync-assets.mjs) reconstructs the versioned `public/assets/pdfjs-*` runtime files and hash manifest from the exact installed PDF.js package. `assets:sync` runs before dev/build/Tauri commands. Do not hand-edit copied runtime assets; dependency changes must reconcile the adapter, asset policy, inventory, and notices.
- [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md) and [runtime-license-inventory.json](../../../tools/legal/runtime-license-inventory.json) are checked by `npm run legal:verify`.
- Fixture expectations live in [fixtures/manifest.json](../../../fixtures/manifest.json) and contract tests. Keep golden inputs and snapshots coordinated with actual approved behavior; generated stress-fixture PDFs and evidence have explicit ignore rules.
- `docs/BACKLOG.md`, `docs/handoff/`, and `docs/reference/` are ignored local context, not portable sources of current product requirements. Do not revive retired features based on those documents.

See [verification](../verification.md) for the local gate, CI differences, and native/manual evidence. No separate conventions manual, ADR index, or nested agent guide is needed merely to mirror this structure.
