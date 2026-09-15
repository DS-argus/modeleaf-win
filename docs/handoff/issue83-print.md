# Issue #83 print implementation handoff

## Branch and PR

- Branch: `fix/print-latency-page-coverage`
- PR: https://github.com/DS-argus/modeleaf-win/pull/86
- Rebased base: `ff8a0d4` (`main`)
- Do not merge, tag, sign, publish, or release without owner review.

## Delivered changes

1. `43a9476` replaces the hidden DOM/PNG `window.print()` path with an HWND-owned native `PrintDlgW`/GDI consumer. PDF.js produces acknowledged, sequential 300-DPI BGRA pages with bounded producer ownership. The native job/session lease owns cancellation, terminal settlement, page order/range validation, and worker cleanup.
2. `4350fcc` keeps the one active native print job visible across tab switches and sends Cancel to the printing tab rather than the currently selected tab.
3. `ddd9b3a` stops tab presentation suspension from cancelling an accepted print. Explicit Cancel, closing the printing tab/window, reload, and application shutdown still cancel it.
4. `62d405d` keeps the footer on monotonic `Preparing N of total pages…` updates and reserves `Submitted to printer` for the terminal native submission outcome.
5. `e957367` redraws the window-owned footer when progress arrives from an inactive printing tab.
6. `edda2be` waits for both recent-state loading and `ShellOpenCoordinator` readiness before exposing recent selections, preventing first recent-open from racing the native open-request client setup.

## Verification

- Before the current-main rebase: full frontend suite, production build, Rust format/clippy/tests, and diff check passed; details and Microsoft Print to PDF evidence are in `docs/evidence/issue83-print.json`.
- Native output evidence covers committed 1-, 12-, 300-page and mixed-size/intrinsic-rotation fixtures. Raw outputs stay under `.internal/evidence/issue-83/` and are not committed.

- After the `ff8a0d4` rebase: `npm test -- --maxWorkers=1 --minWorkers=1` passed 1,003 tests in 91 files; `npm run build`, `cargo fmt --check --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --jobs 1 -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml --jobs 1`, and `git diff --check` passed.
## Known boundaries

- `Submitted to printer` means `EndDoc` submission succeeded; it does not prove physical output or a user-visible Save As file completion.
- Printer-selected paper receives aspect-fit source content. Mixed source media boxes do not produce mixed physical output media.
- CDP-delivered Ctrl+P is not OS foreground keyboard/focus proof.
- Native DPI/text scaling, Narrator, physical printers, clean-VM/installer validation, and independent driver/spooler resource bounds remain unverified.
- The print path is raster-based at 300 DPI. It fixes all-page coverage and bounded ownership but is not a vector-print implementation.
