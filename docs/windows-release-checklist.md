# Windows release checklist

**Status: NOT RELEASED.** `main` is release-ready but unreleased. No tag, no GitHub Release, no signed installer, and no published asset exists. Nothing in this repository has been distributed.

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

- [ ] Navigate the reader, tab strip, palette, help, and TOC with Narrator
- [ ] Confirm enabled TOC rows are announced as pressable buttons
- [ ] Confirm disabled TOC rows are announced as disabled
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

## Release execution — requires separate owner approval

Do not perform any of these without explicit approval, per `AGENTS.md` §12.

- [ ] All W00–W13 gates complete with retained evidence
- [ ] No parity row partial, blocked, or undocumented
- [ ] Owner approves release execution
- [ ] Tag created
- [ ] GitHub Release published with the signed installer

Until every box above is checked by a human, this product is unreleased.
