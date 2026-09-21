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

Tab-switch failures retain the failed transition phase and an exact allowlisted internal error tag in the existing status message. A failed prior-tab recovery retains its own tag without replacing the first target-activation failure. Unknown/native/PDF.js messages are classified as `UNKNOWN`; raw messages, causes, stacks, paths, document text, passwords and URLs are neither logged nor persisted by this seam. This distinguishes failure boundaries for internal reproduction; it does not establish a native tab defect or attribute one to remote-desktop latency.

## Windows network PDF I/O

Ordinary UNC shares and existing mapped network drives use the same native read-only retained-handle boundary as local PDFs. Direct device/verbatim input remains rejected; only a validated final handle may supply a normalized UNC identity. A fixed/removable input must not acquire network authority through a reparse redirection. Neither HTTP PDF loading nor full-document local staging is an alternate path.

Native blocking work is admitted before scheduling: at most eight open operations, four protocol reads, two retained-handle metadata operations, and eight control operations. Permits belong to the actual worker, not its awaiting caller. Saturation fails explicitly; timing out or abandoning a renderer request does not free a blocked Windows operation's slot. Existing renderer range/loading deadlines remain in force.
A single native handle-disposal worker has an eight-item bounded queue. Pending disposal still consumes the eight-session handle quota; owner/global settled checks include it. Close tombstones and successful rejection retries are published only after physical handle disposal, never merely after removing a session from the active map.

Open reservations capture the native owner generation before dispatch, do not hold coordinator locks during filesystem work, and are invalidated on owner loss. Late completion cannot publish into a replacement owner. Recents load lexically without probing shares; reopen snapshots a native-owned path before releasing the store lock and doing network I/O. Only positively proven local absence may prune a recent entry. Remote failure or uncertain absence retains it.

Range reads compare retained length and modification time before and after exact-length I/O; this detects observable changes, not an immutable snapshot against a concurrent writer. Window destruction invalidates authority without waiting. Immediate unsettled cleanup is logged as `DEFERRED`, not a timeout or success. Normal application quit gives cleanup its bounded drain deadline and reports remaining work before process exit; process termination is not reported as cancellation or physical settlement of a blocked call.

## Bounded zoom presentation

The reader controller admits actual DPR backing bytes for required visible pages before selecting up to two optional overscan pages on each side. It reduces only overscan under pressure and accounts for replacement peak bytes; process and per-canvas limits remain authoritative. Measured page metadata is reused by the admitted render, and resident/overlay authority remains transaction-owned through compensation.

Pointer zoom can use a committed resident point without first rebuilding an inadmissible old window, including the single-page Fit Page topology. Failed pointer settlement restores the prior transform/topology. Keyboard presentation owns settlement through compensation: passive scroll synchronization cannot supersede it, and activation restoration uses the internal owner-guarded path rather than the public navigation guard. Blocked passive work is not evidence of render failure. Cancellation and newer explicit owner/navigation/viewport intent fence compensation. `ZoomPolicy` supplies the shared 25–400% bounds for keyboard, wheel, fitting and PDF destinations; those bounds do not replace resource admission.
Passive Fit Width and continuous-fit page selection update active/visible pages without refitting from scrollbar-induced client-size changes. Explicit fit, rotation and outer viewport resize remain presentation owners. Fit Page checks final single-page client geometry under the same lease; a browser-reachable edge clamp is accepted only after synchronous endpoint, layout and orthogonal-position checks, not by widening canonical tolerances.
Keyboard view input has one active render and one constant-size ordered zoom summary. Relative repeats do not cancel that active render; pending steps derive from its committed transform, including an unresolved fit. Clamp/reversal order is preserved. The shell badge, accessibility and Fit Page scroll routing read committed presentation, not pending intent. Cancellation restores matching committed view fields and fences pending work; errors retain their owning failure path.

Viewport materialization places frames using a read-only projection of staged page metrics. Resident authority succeeds before the authoritative metric batch is published. Each owned layout update preserves a positively visible PDF anchor; raw input fences stale work and rollback does not restore an old anchor over newer input. Canonical destination restoration owns its own anchor, so its materialization explicitly opts out of passive visible-anchor restoration. Final success requires actual visible raster coverage within existing admission/overscan limits.
Passive scroll work arriving during presentation ownership is coalesced and replayed once the owner settles, using the live host geometry. Its awaiting caller receives the replay result or failure; document replacement, deactivation and close invalidate the deferred request. This preserves the latest user scroll without letting it cancel the owning render.
## PDF link hints

`PdfContentController` supplies bounded, immutable snapshots of actionable annotation occurrences intersecting the reader viewport. Selection retains opaque identity and snapshot authority; `PdfTabSession` forwards selection through existing guarded navigation or the committed native external-link registry. No text URL inference, synthetic clicks, or alternate shell-launch path is used.

The shell owns transient hint labels and an anchored safe-text URL confirmation. Its root input route gives hint characters priority over reader bindings without overriding password, editable, IME, print, or overlay ownership. Viewport and owner changes invalidate selection; external launch requires a fresh non-repeat Enter and cannot be retracted once dispatched. Only successful hint-initiated internal navigation with an explicit PDF coordinate receives a transient transformed marker. Ordinary clicks, page-only targets, and unrelated history/navigation do not acquire new confirmation or marker behavior. No hint, popup, or indicator fields are persisted.

## Persistence

Rust initializes config, state, and diagnostic services in app-local storage. Config is `config.toml`; the active writer-owned `state.json` fields are **selected_theme** and **recent_files**. Reader pages, zoom, rotation, viewport/history, windows, tabs, and sessions are not persisted.

The [native state store](../../../src-tauri/src/commands/state.rs) uses the shared persistence lock/atomic-write helpers and merges its fields while preserving unknown top-level siblings. Unknown data is not active feature authority. See [persistenceContract.test.ts](../../../tests/contract/persistenceContract.test.ts) and native persistence tests before widening state ownership. Theme commits and recent updates must surface native failures rather than reporting a durable success prematurely.

## Native PDF failure observations

`PdfSessionManager` captures finite operation stages and optional actual `io::Error::raw_os_error()` values before open/range error erasure. The existing public errors, protocol statuses/bodies and reader wording are unchanged. Snapshot validation compares retained length and modified time, not full file identity. An observed read failure remains evidence even when owner invalidation makes the final caller result `SESSION_CLOSING`.

The existing local diagnostic DTO admits `stage` only for `PDF_SESSION`: OS-operation stages require `FAILURE`/`IO_FAILURE`; non-file/header validation stages require `REJECTED`/`VALIDATION_REJECTED`; snapshot mismatch stages require `FAILURE`/`CONFLICT`. Only OS-operation stages may carry signed i32 `osCode`; absence does not mean code zero. Renderer `record_diagnostic` ingress rejects both native-only fields. No new timeout or cancellation semantics are introduced.

A scope-bound observation queues at most one failure after PDF admission/file/state locks are released. One dedicated worker drains a 32-entry nonblocking queue to the existing bounded local log (1 KiB/event, 8 KiB/file, three files). There is no success-per-range logging, network telemetry, private path/content field, or session-capability correlation. Worker creation failure, queue saturation/disconnection, sink errors and process exit can lose evidence; diagnostics are best effort, never a persistence acknowledgment or replacement PDF failure. Missing log entries are not proof of successful I/O.

### Renderer failure evidence

Displayed PDF failures also carry a finite `PDF_*` code. Explicit large-document transport distinguishes fetch, HTTP status, headers, body and exact length; small-document PDF.js URL loading retains structured HTTP status when PDF.js provides it. Load, metadata, first render and later presentation boundaries report separately. Original raw exceptions, URLs, source paths and document content never enter diagnostic DTOs. Rollback carries only a validated safe message/code suffix; delayed diagnostic responses cannot replace a newer status or disposed reader.

The narrow `report_pdf_failure` command accepts only `{code,httpStatus?}`. HTTP codes require a 100–599 status; other codes prohibit it. Native composition creates `PDF_RENDER` events with `rendererCode`/`httpStatus`, never native `stage`/`osCode`. Cancellation is `CANCELLED`/`NONE`, timeout is `FAILURE`/`TIMEOUT`, other renderer evidence is `FAILURE`/`REDACTED`. Generic `record_diagnostic` rejects these new fields as well as native-only fields. Rust and TS share regression vectors, not generated schemas.

Renderer reports share the 32-entry worker queue with native observations; at most four renderer invokes are outstanding. Receipts distinguish `QUEUED`, `DROPPED` and `UNAVAILABLE`, worker running/stopped/unavailable, and process-local drop/write-failure counters saturating at 1,000,000. These are snapshots: queued is **not persisted**, counters may change after the reply, and unavailable startup cannot reconstruct lost events. Neither diagnostics nor receipts alter PDF deadlines, retries, teardown or ownership. The visible code survives IPC/logging failure and is retained in the status tooltip when space is constrained. Normal PDF success is intentionally not logged.

## Generated inputs and durable sources

- [package-lock.json](../../../package-lock.json) and [Cargo.lock](../../../src-tauri/Cargo.lock) lock dependencies; use the toolchain pins rather than inferring versions from minimum-version declarations.
- [sync-assets.mjs](../../../tools/pdfjs/sync-assets.mjs) reconstructs the versioned `public/assets/pdfjs-*` runtime files and hash manifest from the exact installed PDF.js package. `assets:sync` runs before dev/build/Tauri commands. Do not hand-edit copied runtime assets; dependency changes must reconcile the adapter, asset policy, inventory, and notices.
- [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md) and [runtime-license-inventory.json](../../../tools/legal/runtime-license-inventory.json) are checked by `npm run legal:verify`.
- Fixture expectations live in [fixtures/manifest.json](../../../fixtures/manifest.json) and contract tests. Keep golden inputs and snapshots coordinated with actual approved behavior; generated stress-fixture PDFs and evidence have explicit ignore rules.
- `docs/BACKLOG.md`, `docs/handoff/`, and `docs/reference/` are ignored local context, not portable sources of current product requirements. Do not revive retired features based on those documents.

See [verification](../verification.md) for the local gate, CI differences, and native/manual evidence. No separate conventions manual, ADR index, or nested agent guide is needed merely to mirror this structure.
