# Windows release checklist

**Status: NOT RELEASED.** This repository is not release-ready: the [parity matrix](parity-matrix.md) records incomplete acceptance gates. Private development builds and review artifacts do not establish a public release, a signed installer, or completed native validation.

This document records what a release requires. It never records that a release happened.

## What automated verification already covers

These run in the normal local gate and need no human:

| Item | Where |
| --- | --- |
| NSIS current-user, x64, download bootstrapper | `tests/contract/releaseContract.test.ts` |
| `.pdf` association registered as Viewer, and nothing else claimed | same |
| Version consistency across `tauri.conf.json`, `package.json`, `Cargo.toml` | same |
| No signing credentials or updater endpoint committed | same |
| No foreign-platform install phrasing in Windows-facing text | same |
| Update comparison for same / older / prerelease / malformed / offline | `tests/unit/ui/UpdateNoticeModel.test.ts` |
| Notify-only: no install, restart, or self-update affordance exists | same |

## Private Scoop preparation

The owner has authorized GitHub Actions. [Windows Scoop preparation](../.github/workflows/windows-scoop.yml) runs the automated gate and a separate standalone build on Windows. It has read-only repository permissions, no tag/release/visibility operations, and retains review artifacts for seven days **only while the repository is private**. Its workflow file uses JSON syntax, a YAML subset, so the complete structure can be checked without another parser dependency.

The packager can also run locally after a successful standalone build:

```powershell
$out = Join-Path $env:TEMP ("modeleaf-scoop-" + [guid]::NewGuid().ToString("N"))
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/windows/package-scoop.ps1 -ExecutablePath src-tauri/target/release/modeleaf.exe -OutputDirectory $out
```

It prepares an executable/license-only ZIP, `modeleaf.json`, `SHA256SUMS`, and a source-bound receipt. Existing output directories are rejected. Product versions must agree, source inputs remain unchanged, and PE header validation does **not** establish signature validity or native behavior. Generated download URLs are proposed release locations, not live downloads. No Scoop installation, data migration, file association, bucket update, signing setup or publication occurs here.

These artifacts are preparation evidence only. The latest reader may still be in an unmerged PR; the recorded source revision identifies what was actually built. The following native/legal/publication gates remain required.

## HUMAN-ONLY gates

Every item below requires a person. None can be satisfied by this repository's tests, and none may be reported as evidence unless a human actually performed it.

### 1. Authenticode signing — HUMAN-ONLY

Requires a code-signing certificate that is deliberately **not** present in this repository. `releaseContract.test.ts` asserts that no `certificateThumbprint`, `signCommand`, `digestAlgorithm`, or `timestampUrl` is configured, so an accidental commit of signing material fails the gate.

- [ ] Sign the installer and the executable with a valid certificate
- [ ] Verify the timestamp countersignature
- [ ] Confirm both artifacts report a valid signature in Windows properties

### 2. Clean Windows VM validation — HUMAN-ONLY

Requires a fresh Windows 10 and Windows 11 x64 VM with no prior Modeleaf install and no WebView2 runtime preinstalled.

- [ ] Install on a clean Windows 11 VM without elevation
- [ ] Confirm the WebView2 bootstrapper fetches and installs the runtime
- [ ] Launch and open a PDF
- [ ] Open With → Modeleaf on a `.pdf` from Explorer
- [ ] Confirm Modeleaf did **not** seize the system default PDF handler
- [ ] Upgrade-install over the existing version and confirm settings survive
- [ ] Uninstall, then confirm only Modeleaf's own registration was removed
- [ ] Repeat on Windows 10 x64

### 3. SmartScreen reputation — HUMAN-ONLY

Reputation accrues from download volume and signing history over time. Signing does not clear SmartScreen immediately, and §15 names assuming otherwise as a failure mode.

- [ ] Download the signed installer through a browser on a clean VM
- [ ] Record the exact SmartScreen prompt shown
- [ ] Record it as a known first-release condition rather than a defect

### 4. Narrator and accessibility — HUMAN-ONLY

The suite proves structural semantics: button roles, disabled states, `aria-current`, landmarks, and theme contrast ratios. It cannot prove what a screen reader announces.

- [ ] Navigate the reader, tab strip, palette, help, and dialogs with Narrator
- [ ] Confirm enabled controls are announced with the correct action and name
- [ ] Confirm disabled controls are announced as disabled
- [ ] Confirm the update banner is announced without interrupting reading
- [ ] Verify Windows high-contrast (forced-colors) rendering
- [ ] Verify 150% and 200% text scaling

### 5. Packaged behavior — HUMAN-ONLY

Browser and JSDOM coverage does not substitute for packaged WebView2 behavior.

- [ ] Print a 1-page, a 12-page, and a 300-page fixture through Microsoft Print to PDF; confirm page count and order
- [ ] Confirm reader state is unchanged after printing
- [ ] Open two windows; confirm tabs, history, and handles stay independent
- [ ] Launch a second instance with a file argument; confirm no second process and each path opens exactly once
- [ ] Confirm source PDF SHA-256 values are unchanged after every scenario

### 6. Scoop installation — HUMAN-ONLY

The private ZIP/manifest preparation checks do not perform a real Scoop installation or replace the existing NSIS gates.

- [ ] Confirm the approved release commit contains the latest reader changes, not an older main baseline
- [ ] Complete redistribution/license review for the executable and every bundled dependency
- [ ] Verify the executable signature inside the final ZIP and confirm the ZIP matches the published manifest SHA-256
- [ ] Install through Scoop on clean Windows 11 x64; verify WebView2 prerequisites and truthful missing-runtime guidance
- [ ] Launch from the shim and Start menu shortcut, open a fixture, then verify source hashes unchanged
- [ ] Exercise Scoop update and uninstall without losing application settings or modifying file associations
- [ ] Verify the final public download URL and bucket; generated candidate URLs alone are not availability evidence

## Release execution — requires separate owner approval

Do not perform any of these without explicit approval, per `AGENTS.md` §12.

- [ ] All W00–W13 gates complete with retained evidence
- [ ] No parity row partial, blocked, or undocumented
- [ ] Owner approves release execution
- [ ] Owner reviews the final repository contents/history and explicitly approves public visibility immediately before conversion
- [ ] Tag created
- [ ] GitHub Release published with the signed installer

Until every box above is checked by a human, this product is unreleased.
