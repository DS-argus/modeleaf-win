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

## Candidate-bound manual evidence

[preview-worktree.ps1](../../tools/windows/preview-worktree.ps1) requires a named branch, installed worktree dependencies, and no running Modeleaf process, avoiding accidental single-instance routing into another binary. It uses `.internal/preview-target`, records source identity and executable SHA-256, and launches with a separate WebView2 profile. `-SkipBuild` validates its existing receipt; it is not permission to test stale output.

Record the receipt/executable identity, tested inputs and actions, observed results, and untested limitations in the task handoff/PR. Do not launch `src-tauri/target/debug/modeleaf.exe` directly as standalone evidence. Printing submission is not proof of physical output or a completed Save As file. Native dialogs, multiple windows, persistence failures, associations, and printing require the corresponding real native scenarios when affected.

## Documentation-only changes

Validate local links, documented commands, source-backed claims, ignore/tracking behavior, and `git diff --check`. Run relevant contract tests where guidance relies on their boundaries. A native rebuild/manual QA is unnecessary when only documentation changes; explicitly report those layers as NOT RUN. Never suppress warnings or label an unexecuted gate as passed.
