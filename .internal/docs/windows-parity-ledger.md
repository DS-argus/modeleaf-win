# Modeleaf Windows parity ledger

Upstream baseline: `DS-argus/modeleaf@d809e2e4d6aa5f257c91ff38b2cd4503e17405f0` (v0.5.0)

This ledger tracks behavior rather than AppKit/PDFKit structure. CP0–CP5 implementation is complete for the original brief. Retained evidence is under `.internal/evidence/checkpoints`; `build.json` binds the final staged source artifact and retained no-bundle executable. Installer, signing, registered association, Scoop, and WinGet remain explicitly outside this run.

| Contract | Checkpoint | Current status | Windows behavior / boundary |
|---|---:|---|---|
| Keyboard navigation | CP1–CP2 | Verified | Existing action IDs, prompt behavior, registry ownership, shortcut availability, repeat handling, and native-key exclusions remain covered by the current 260-test frontend suite. |
| Read-only PDF lifecycle | CP0–CP1 | Verified | Rust owns read-only local handles and opaque sessions; cancel/barrier/close ordering and retained-handle identity are covered by the current native suite. |
| View state | CP2 | Verified | Fresh documents open page 1 fit-page; fit-width remains continuous; rotation and reader state are tab-local. |
| Search and text copy | CP3 | Verified | Pointer text selection and exact Korean search are retained in the generation-33 CP3 checkpoint. OCR, scanned-content remediation, reading-order remediation, keyboard range selection, and full PDF-content accessibility remain unavailable. |
| Links and hints | CP3 | Verified | Internal destinations and allowlisted `http`, `https`, and `mailto` are supported under native authority; unsupported PDF actions fail closed. |
| Palette, help, tabs, and recents | CP1, CP4 | Verified | Palette/help derive from the typed registry. Reader/view/search state is tab-local, inactive heavy resources are bounded, and recents expose only opaque IDs and basenames. |
| Open routes | CP4 | Verified | Chooser, native drop, startup/CLI, second-instance, and manually selected Open With argv converge on the exactly-once native coordinator. Installed association is not claimed. |
| Themes | CP5 | Verified | Exactly six chrome themes support preview/commit/revert. Native persistence is bounded, atomic, JavaScript-safe-revision checked, conflict-safe, and recovery-tested. PDF pixels are not theme-filtered. |
| Accessibility | CP1, CP5 | Verified within stated scope | Named chrome, dialogs, tab semantics, focus restoration, status, finite generation-gated announcements, reduced motion, forced-color rules, and 200%-scale layout are covered by source/integration, hidden Chromium, and Windows UIA evidence. |
| Diagnostics | CP5 | Verified | Diagnostic DTOs and native JSONL storage are finite, redacted, bounded, local, and caller-path independent. The native host exposes no network transport. WebView2 itself may contact Microsoft services according to Windows/WebView2 diagnostic policy. |
| Quit | CP5 | Verified | `Ctrl+Q` performs renderer-first cleanup and native drain; a bounded three-second native fallback prevents startup/listener races. UIA, twenty lifecycle cycles, and zero-owned-job-remnant evidence are retained. |
| Filesystem scope | CP0+ | Verified | Only non-remote fixed/removable volumes are supported. UNC, mapped-network, and `DRIVE_REMOTE` input is rejected with copy-local guidance. |
| Config and panes | Deferred | Not in scope | No dormant model, advertised command, or compatibility alias. |
| Distribution | Later run | Not implemented or claimed | No installer, signing, registered association, Scoop, WinGet, or public release claim. |

## CP5 retained gates

- `browser-accessibility.json`, `browser-200pct.png`, and `theme-dialog-200pct.png`: hidden Chromium at device scale factor 2, required accessibility order/focus/status, six theme rows, reduced-motion computed behavior, and no viewport overflow. Chromium automation cannot emulate `forced-colors`; the forced-color branch is covered by focused source/integration tests.
- `lifecycle-final4/cp5-native-evidence.json`: twenty hidden launch/close cycles, exact owned Job Object membership, bounded working set/CPU/process count, native-host network checks, and zero remnants.
- `soak-final6/cp5-native-evidence.json`: thirty-minute bounded soak with the same source/EXE binding and cleanup proof.
- `desktop-final/cp5-native-evidence.json`: visible Windows UIA name/order capture and `Ctrl+Q` clean exit.
- `open-with-final.json`: manually selected Windows Open With route into the retained executable; no association mutation.
- Full gates: 260 frontend tests, full native tests, legal inventory verification, production frontend build, PowerShell parser/Pester contracts, and retained release-mode no-bundle EXE.

## Durable boundaries

Theme changes affect chrome only. Accessible output is bounded and path-redacted. Diagnostic records contain no PDF contents or caller-selected paths. WebView2 runtime traffic is platform-owned and governed by Windows/WebView2 policy rather than Modeleaf diagnostics. Any new intentional deviation requires an owner decision and a corresponding acceptance-test update.
