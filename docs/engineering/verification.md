# Verification

## Environment and canonical gate

Run commands from the assigned worktree root. Use Node/npm pins in [package.json](../../package.json), locked dependencies via `npm ci`, and the Windows MSVC Rust toolchain in [rust-toolchain.toml](../../rust-toolchain.toml). The Cargo manifest's `rust-version` is a minimum, not the development pin. Native builds require Visual Studio C++ Build Tools and WebView2 as described in [README](../../README.md).

**Canonical local gate: `npm run gate:w01`.** Its maintained definition in package.json combines legal/copied-asset verification, production dependency audit, Vitest, TypeScript/Vite build, Rust formatting, Clippy with denied warnings, Rust tests, and a standalone Tauri debug build. Use it before delivery of product/infrastructure changes. It does not certify native interactions, installation, physical printing, or release publication. Serialize native builds; do not build in another worktree.

## Select the evidence layer

| Layer | Entry point | What it proves / limits |
| --- | --- | --- |
| Focused TypeScript tests | `npm test -- tests/contract/domainPurity.test.ts tests/contract/persistenceContract.test.ts` | Example boundary checks; select unit/integration/contract files relevant to the actual change. Vitest defaults to Node; DOM simulations are not WebView2 certification. |
| Full TypeScript suite | `npm test` | Unit, integration, contract, fixture, and packaging tests selected by [vitest.config.ts](../../vitest.config.ts). Not native end-to-end QA. |
| Focused native tests | `cargo test --locked --manifest-path src-tauri/Cargo.toml --test cp4_recent` | Example Rust integration target; choose the affected target/test filter. Does not replace interactive shell validation. |
| Frontend build | `npm run build` | Synchronizes PDF.js assets, type-checks without emitting TS, and builds Vite output. Does not prove a native application starts. |
| Shell visual matrix | `npm run qa:shell` | Headless Edge renderer checks and comparison evidence, not native app QA. Required by preparation CI and relevant to shell/style changes. Requires Edge (override `SHELL_QA_EDGE`) and Git history containing the baseline used by the runner. |
| Native debug build | `npm run tauri:build-debug` | Tauri debug `--no-bundle` build with bundled frontend and `CI=true`. Build success is not observed runtime behavior. |
| Manual native candidate | `npm run preview:worktree` | Builds and launches an isolated standalone debug candidate; observe the requested scenario in WebView2. Not installer/release certification. |
| Standalone release build | `npm run tauri -- build --no-bundle` | Release executable build. No publication or evidence of installed behavior. |

Test edge values, failure paths, read-only invariants, ownership, cancellation, and stale-result handling rather than only happy paths. Fixture contracts are available through `npm run fixtures:verify-golden`; Korean external-fixture checks have a separate `npm run fixtures:verify-korean` entry point. Inspect the relevant fixture manifest and runner prerequisites before using specialized harnesses.

## CI is not identical to the local gate

[Windows Scoop preparation](../../.github/workflows/windows-scoop.yml) runs legal/security checks, frontend tests/build, `qa:shell`, and Rust formatting/lint/tests on Windows. It uses locked Cargo operations, bounded test concurrency, and isolated target directories. Only main builds the standalone release candidate, rejects modified tracked build inputs, and prepares review ZIP/Scoop artifacts. The local gate instead ends with a debug build and does not include `qa:shell`.

The [publication workflow](../../.github/workflows/publish-scoop.yml) consumes exact reviewed preparation artifacts under explicit source/ZIP approval; it does not rebuild them. Release/source/ZIP/manifest and public-byte validation remain distinct from unit tests. See the maintained validators in [tools/releases](../../tools/releases) and [packaging script](../../tools/windows/package-scoop.ps1); do not invoke publication, signing, tags, or bucket promotion without owner authorization.

### Protected Scoop promotion setup and recovery

Publication links directly to a dependent `promote` job, not a `release` event (a release created with `GITHUB_TOKEN` does not start another ordinary event workflow). Only approved public `DS-argus/modeleaf-win` tag pushes qualify. Promotion checks out the publication-validated source SHA, downloads the exact reviewed preparation artifact, and calls `prepareScoopBucket` to verify all four actual public downloads without bucket credentials. The retained `scoop-public-verification-<run>-<attempt>` artifact binds source, ZIP and release-manifest hashes; its manifest is evidence, not a replacement for the maintained bucket's hooks. The write step changes only version, 64bit URL and verified ZIP hash in `bucket/modeleaf.json`.

Owner setup (not performed by automation or tests):

- Create a fine-grained PAT owned by an identity with access to **only `DS-argus/scoop-bucket`**, with repository **Contents: read/write**, **Pull requests: read/write**, and required Metadata read. No Actions, Workflows, Administration, organization permissions, classic broad `repo` token, or source-repository write access is needed. Use an expiry and rotate through the owner's secret-management process.
- Store it in the source repository Actions secret **`MODELEAF_SCOOP_BUCKET_TOKEN`**. The default source `GITHUB_TOKEN` cannot perform cross-repository writes. Missing/expired/denied credentials block the bucket job explicitly; they do not roll back or replace the published release.
- Keep source release tags/workflow changes owner-controlled, reviewed, and protected; approval of source/ZIP remains the existing publication prerequisite. Keep bucket `main` protected with required human review and no credential bypass. Do not enable auto-merge. No repository settings, secrets or protections are provisioned by this change.
- Restrict pushes to bucket `modeleaf/*` branches to the promotion identity, disallow force-push/deletion, and reserve owner intervention for explicit recovery. The tool fetches the resulting PR and rechecks both refs after create/update before confirming success; later external changes still require human review of the current head/diff against the receipt.

The fixed job concurrency group `scoop-bucket-modeleaf` serializes this repository's promotions across tags. GitHub concurrency can replace older pending jobs and does not guarantee ordering: rerun a superseded run when necessary. Manual/external bucket writers are outside that lock. The tool pins reads to commit SHAs, rechecks refs, atomically creates a complete `modeleaf/v<version>` branch, never force-pushes/updates an existing branch, and refuses downgrade or same-version conflicting bytes. Main already at the exact target or newer is a successful no-op. Recheck the PR against current main immediately before manual merge; automation cannot lock independent writers through human review.

Retries reuse a matching open PR (refreshing its evidence body) or recover an identical branch left after failed PR creation. Closed/unmerged PRs are not reopened; merged PRs are a no-op only when main already contains the target or newer. Unrelated branch changes, changed hooks, ambiguous PR history, lost branches or stale refs fail closed for owner reconciliation. No automated branch deletion or destructive recovery is provided. Rerun the failed promotion job after resolving setup/transient failures while the reviewed artifact is retained; rerunning all jobs verifies an already-published release without replacing its bytes. An existing draft or missing/expired reviewed artifact needs owner investigation, not republishing or rebuilding under the same approval.

Release publication and bucket-PR outcomes are reported separately in the job summary. A failed API request may have reached GitHub: inspect remote state or retry safely rather than claiming no remote mutation. Public downloads failing validation never reach the write step. Live publication, bucket mutation and credential provisioning are not part of deterministic verification:

```powershell
npm test -- tests/unit/tools/scoopRelease.test.ts tests/unit/tools/scoopBucket.test.ts tests/unit/tools/scoopPromotion.test.ts tests/contract/scoopPublication.test.ts tests/contract/scoopWorkflow.test.ts
```

These tests use synthetic bytes and mocked GitHub APIs; they do not certify live credentials, branch protections, GitHub-hosted execution, or installed/native behavior.

## Headless reader zoom regression

Run `node tools/qa/run-reader-zoom.mjs` from the assigned worktree with dependencies and pinned PDF.js assets available. This uses an isolated headless Edge profile, real PDF.js, and mocked native authority; it does not build Tauri or inject desktop input. Set `READER_QA_SOURCE_HASH` to the tested commit/working-tree identity and retain the evidence under `.internal/evidence/reader-zoom/`.

The matrix covers the production Ctrl-wheel binding and scroll scheduler, pointer anchors, continuous/Fit Page, large and mixed-size fixtures, bounded wheel versus keyboard-equivalent session actions, bursts/reversal, DPR 1/1.25/1.5/2, dirty/evicted/resized tab restoration, overlapping metadata, tab close/reactivation, unchanged fixture hashes and empty reservations after disposal. It must assert `w`, `-`, and `=` with real session/controller ownership gates rather than mocking synchronization success. Resource-pressure and failed-compensation cases also remain covered by controller/session tests independently of the 25–400% user limits. This is not full shell keyboard routing, physical-device testing, packaged WebView2 or native/manual certification.

The same runner includes fit geometry on mixed/same-size PDFs at 800×600 CSS pixels, DPR 1/1.25/1.5, and normal/120ms-delayed real PDF.js completion. It also checks narrow-to-wide fixed-reference Fit Page edge landings, fit-to-custom intent composition and visual progress during repeated keyboard input, and a deterministic generated 40-page mixed-geometry PDF. Lazy-layout checks retain scale and the visible PDF point during overscan discovery. Set `READER_QA_FIT_ONLY=all`, `fit-width`, `fit-page`, `edge`, `keyboard`, or `geometry` to isolate cases; omit it for the complete matrix. Generated bytes and their hash stay with local evidence, not the source PDF corpus. Failure evidence records the first divergent geometry and settlement samples. These are headless checks, not proof that the affected internal environment passed.

## Browse history presentation

Run the focused unit/integration files `RecentPathPresentation.test.ts`, `RecentChooserRenderer.test.ts`, `TauriCommands.test.ts`, `openChooserInput.test.ts` and `openChooserPresentation.test.ts`. `READER_QA_FIT_ONLY=history node tools/qa/run-reader-zoom.mjs` exercises real browser layout with synthetic long local/UNC entries, mapped display aliases, repeated Ctrl+j/k-style events, retained nodes, fixed 13px text, narrow/resized windows and forced colors. It asserts actual text bounds as well as no horizontal scrollbar, so clipping alone cannot pass. This uses synthetic keyboard/alias data, not native drive-query or private-share proof.

With exclusive native ownership, run `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib recent_display_aliases::tests` and the combined gate. The alias tests use bounded injected mappings; actual connected-drive display remains a same-user native acceptance case. The native query must not change mappings, credentials, persisted recents or opaque-ID opening authority. A final combined standalone EXE needs its own source/hash receipt; earlier candidate evidence is not transferable to later Browse/diagnostic changes.
## Candidate-bound manual evidence

[preview-worktree.ps1](../../tools/windows/preview-worktree.ps1) requires a named branch, installed worktree dependencies, and no running Modeleaf process, avoiding accidental single-instance routing into another binary. It uses `.internal/preview-target`, records source identity and executable SHA-256, and launches with a separate WebView2 profile. `-SkipBuild` validates its existing receipt; it is not permission to test stale output.

For a final optimized internal-test executable, use `npm run preview:worktree -- -Release -Pdf fixtures/pdf/print-mixed-rotation-4.pdf`. This builds and launches the Release profile through the same source/hash and single-instance checks; `-Release -SkipBuild` rejects a debug or stale receipt. The native zoom runner accepts either explicitly recorded profile. Other specialized runners retain their documented debug-profile requirements. A local optimized build does not authorize signing or public release.
Record the receipt/executable identity, tested inputs and actions, observed results, and untested limitations in the task handoff/PR. Do not launch `src-tauri/target/debug/modeleaf.exe` directly as standalone evidence. Printing submission is not proof of physical output or a completed Save As file. Native dialogs, multiple windows, persistence failures, associations, and printing require the corresponding real native scenarios when affected.

## Native zoom and tab regression

With exclusive build/preview ownership, launch the assigned candidate with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` and `npm run preview:worktree -- -Pdf fixtures/pdf/print-mixed-rotation-4.pdf`. Then run `node tools/qa/run-reader-zoom-native.mjs <ProcessId-from-preview>`.

The runner verifies the executable receipt and selected debug/release profile, uses bundled WebView2 CDP keyboard/wheel/tab input through the real shell, opens the L300 public fixture through native second-instance forwarding, checks `w`, `-`, `=`, `F`, 25–400% bounds and repeated tab activation, and records transient failures and resource settlement. It also checks mixed-size Fit Page next/reverse landings, passive Fit Width stability, final client-box scale, and committed badge/raster consistency during an unawaited keyboard burst. Debugger access captures existing owners; it does not replace renderer/native implementations. It leaves the app open for owner review and writes evidence under `.internal/evidence/reader-zoom-native/`. This is native/CDP evidence, not physical human input or release certification.
## Native reader repeat regression

Run in the assigned worktree with exclusive native build and desktop-input ownership:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
npm run preview:worktree -- -Pdf fixtures/pdf/print-mixed-rotation-4.pdf
node tools/qa/run-reader-repeat.mjs <ProcessId-from-preview> fixtures/pdf/print-mixed-rotation-4.pdf
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
```

The runner binds the preview receipt/executable and source-PDF hashes, uses a bounded debugger attachment for read-only owner snapshots, and injects native Windows burst and held key-down/repeat sequences. It asserts trusted repeat events, page/boundary landings, Fit Page versus continuous/custom scrolling, unchanged active tab, transient failure status, and bounded settled raster/text/annotation resources. Evidence and a WebView screenshot stay under `.internal/evidence/reader-repeat/`. Do not type or change foreground windows during the run; foreground loss fails rather than sending input to another application. Close the owned preview before another native build.

This is standalone bundled-frontend WebView2 debug evidence, not a headless simulation, physical human keyboard test, installed-release test, or release certification. Fractional desktop scaling and mixed-size pages are important: integer CSSOM scroll extents can differ from the browser-applied physical-pixel grid. Preserve the half-point PDF/history contract; verify the bounded browser-applied landing instead of widening canonical tolerance.

## Native empty-screen opening regression

With exclusive native build/desktop-input ownership, launch `npm run preview:worktree` without a PDF and with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`, then run `node tools/qa/run-empty-open.mjs <ProcessId-from-preview>`. The runner validates the current source/executable receipt, uses trusted CDP pointer input on the banner label, shortcut badge and padding, exercises Enter/Space/Ctrl+Shift+O, checks File menu availability, cancels an owned native picker, and reopens `fixtures/pdf/links.pdf` through the banner's recent chooser after last-document close. It records evidence under `.internal/evidence/empty-open/` and leaves the owned preview running; close it before releasing resources. The fixture becomes a normal recent entry. This is standalone WebView2 debug evidence, not physical input or installed-release certification.

## Native protected-PDF regression

With exclusive native build ownership and no running Modeleaf process:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
npm run preview:worktree -- -Pdf fixtures/pdf/locked.pdf
node tools/qa/run-password-prompt.mjs <ProcessId-from-preview>
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
```

The runner checks the current preview source/executable receipt, exercises correct and repeated incorrect attempts, modal input/action blocking, native second-instance rejection, cancellation restoration, and pending-password WM_CLOSE. It records sanitized focus/accessibility checks and cleared-input screenshots under `.internal/evidence/password-prompt/`, checks source fixture hashes and non-persistence of a unique incorrect input, and closes the owned preview. Never include password values or raw password accessibility values in evidence. This is bundled-frontend WebView2 debug QA with CDP-injected input, not human keyboard, screen-reader narration, or installed-release certification.

## Native PDF link-hint regression

With exclusive native build ownership and no running Modeleaf process:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333'
npm run preview:worktree -- -Pdf fixtures/pdf/links.pdf
node tools/qa/run-link-hints.mjs <ProcessId-from-preview>
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
```

The runner validates the preview source/executable receipt and fixture hashes, exercises annotation-only labels, duplicate occurrences, URL selection/repeated Enter/Escape, viewport cancellation, internal landing coordinates and indicator expiration, and retained `F` behavior. Evidence stays under `.internal/evidence/link-hints/`; the runner closes the owned preview. It checks the CDP `autoRepeat` event before sending repeated Enter to an external confirmation. It deliberately does not confirm a valid external URL with non-repeat Enter, so successful OS/browser launch remains unverified by this runner. Native registry authorization is covered separately by the Rust gate tests. This is bundled WebView2 debug QA with CDP-injected input, not physical human input, installed-release certification, or an accessibility narration test.

## Network PDF verification

Automated path-policy, injected I/O, and local-file tests are not SMB evidence. Run the native suites `cp0_native`, `cp1_open_boundary`, `cp4_open_request`, `cp4_recent`, and `cp5_lifecycle`, plus the session and native-I/O unit tests and the canonical gate. Verify fixture SHA-256 before and after reading.

Real-network QA requires an owner-provided accessible UNC PDF, an existing mapped-drive equivalent, and disposable test data for interrupted access, permission-denied, removed/changed files, and reconnect scenarios. Do not map drives, change credentials/ACLs/firewalls, or alter production documents. Keep server names and credentials out of public evidence. Launch only with `npm run preview:worktree` and record its source/executable receipt. Exercise chooser, argv/Open With, drop, recent reopen, bounded paging, cancel/close/window exit, stale completion, and unaffected local/password/link/print flows. Report absent resources as BLOCKED; never substitute local or mocked passes for real-network/native QA.

## Network PDF diagnostic investigation

`tests/fixtures/pdfDiagnosticStages.json` supplies shared Rust/TS regression vectors, not a generated product schema. Focused checks are `npm test -- tests/unit/core/DiagnosticEvent.test.ts tests/contract/networkPdfBoundary.test.ts`, native `cargo test --locked --manifest-path src-tauri/Cargo.toml --test cp5_diagnostics`, and the `pdf_session::tests`/`diagnostics::pdf_failure_tests` library tests. Native checks/builds still require exclusive resource ownership. Source assertions and injected native errors do not prove actual SMB behavior.

Use only an approved same-user resource and an identified `preview:worktree` candidate for mapped-drive versus equivalent UNC, successful-folder and local-copy controls. Test one anonymized case at a time; retain source hashes locally. Collect only finite stage, tag, outcome and optional numeric OS code from the native local diagnostic log. Do not share paths, account/server/share names, document names/contents, capability tokens or credentials. Record timeout/cancellation and physical settlement separately; the diagnostic queue can drop evidence, and a missing event does not identify a phase or prove success. Native admission and file-operation observations are distinct from policy and renderer evidence. A root cause or network correction requires actual permitted case evidence, not a successful mock or local fixture.

Renderer follow-up regressions: `npm test -- tests/unit/core/PdfFailureDiagnostic.test.ts tests/unit/platform/PdfFailureDiagnostics.test.ts tests/integration/pdfReaderController.test.ts tests/integration/recentsFailureReporting.test.ts`. Native `cp5_diagnostics` includes renderer/native provenance, finite HTTP status validation, queue drop/disconnection and write-failure health. Inspect `PDF_RENDER`/`rendererCode` for renderer failures and `PDF_SESSION`/`stage` for native observations; successful opens/closes create neither. A visible `[PDF_*]` code remains useful when log delivery is unavailable; `diagnostic queued` does not acknowledge persistence. Hover the status for its complete bounded diagnostic if it is ellipsized.

An internal test delivery may be the standalone optimized EXE, with full local path, source commit and SHA-256 reported separately; ZIP packaging is not required. Keep source/build/QA receipts locally, validate the exact executable through `preview:worktree -- -Release`, and distinguish simulated/injected failure cases from actual mapped-share evidence. Do not terminate an existing user process merely to launch a preview.

The earlier18efb345 diagnostic candidate reproduced an outer four-permit rejection with same-file waiters; that is historical defect evidence, not corrected-code acceptance. Corrected native checks (exclusive ownership required) include `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib pdf_session`, `--lib pdf_protocol`, `--lib native_io`, and `--test cp5_diagnostics`. Verify bounded waiting rather than immediate saturation failure: process4/session2 selected, process32/session8 queued, per-retained-handle serialization, shared metadata fairness, genuine queue-full503, HEAD/OPTIONS and invalid/stale requests independent of worker pressure. Cancellation must revoke pending work but retain executing/completion ownership until real settlement; cleanup must include outstanding assembly credits.

## Exact logical assembly regression

Focused renderer checks include `tests/unit/pdf/PdfRangeAssembly.test.ts`, `tests/unit/platform/PdfAssemblyClient.test.ts`, `tests/integration/pdfReaderController.test.ts` and `tests/contract/networkPdfBoundary.test.ts`. Use real pinned PDF.js loading/range readers for the valid RGB image requiring a logical reply larger than4MiB; a recording listener alone cannot certify its exact-begin/one-buffer contract. Exercise adjacent/overlapping demand, EOF, previous progress observers, reentrant wakeup, cancel-before-grant, lost acknowledgements, no progress until destruction, failed cleanup and late completion.

The owner-approved additional assembly budget is512MiB per response and512MiB APP-wide, with one active assembly/document. Native owner-separated tests must show shared admission across windows, current/peak bounds, FIFO progress, cancel watermarks and exact trusted destruction. Numeric `pdf_assembly_stats` is reservation accounting, not RSS. A public progress event is only a wake signal; prove actual buffer detachment before transfer release, or successful PDF.js destruction before conservative release. Do not release because a caller aborted or `onDataRange` returned.

Final acceptance needs the exact optimized executable naturally opening/rendering the unchanged public20MB/100-page fixture in a fresh owned process with no injected range requests, plus the real large-image logical reply. Add controlled slow/saturated/cancelled and multi-owner cases, source hashes and zero settled reservation checks. The selected renderer smoke matrix and earlier diagnostic EXEs cannot substitute for these tests. Report owner V confirmation separately; do not access private shares or terminate an existing user app to obtain evidence.
## Documentation-only changes

Validate local links, documented commands, source-backed claims, ignore/tracking behavior, and `git diff --check`. Run relevant contract tests where guidance relies on their boundaries. A native rebuild/manual QA is unnecessary when only documentation changes; explicitly report those layers as NOT RUN. Never suppress warnings or label an unexecuted gate as passed.
