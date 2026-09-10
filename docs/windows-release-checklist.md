# Windows release checklist

The owner authorized an **initial experimental Windows release** after accepting basic app use; see [Issue #64](https://github.com/DS-argus/modeleaf-win/issues/64). This explicitly permits initial distribution before full parity, signing, and native acceptance are complete. It does not certify those gates or waive the final owner review immediately before public conversion.

This checklist does not establish that a release happened. Treat a candidate as **unreleased** until its matching GitHub prerelease and verified assets exist. The [parity matrix](parity-matrix.md) remains the source of incomplete product acceptance.

## Automated preparation

[Windows Scoop preparation](../.github/workflows/windows-scoop.yml) runs frontend tests/build, copied-asset/license checks, the dependency audit, Rust formatting/lint/tests, and a separate standalone build on Windows. Its token is read-only; it never tags, publishes a release, or changes visibility.

Review artifacts are retained for seven days. While the repository is private, its PR and main artifacts remain private. After the separately approved public conversion, only main builds upload preparation artifacts; those CI downloads are then public, but are not signed or accepted releases. Public PR builds do not upload candidates. Rebuild and review again when an artifact expires; do not silently substitute another source or hash.

The packager can also run after a successful standalone build:

```powershell
$out = Join-Path $env:TEMP ("modeleaf-scoop-" + [guid]::NewGuid().ToString("N"))
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/windows/package-scoop.ps1 -ExecutablePath src-tauri/target/release/modeleaf.exe -OutputDirectory $out
```

It creates exactly four outputs: the executable/license-only ZIP, `modeleaf.json`, `SHA256SUMS`, and `package-receipt.json`. Existing output directories are rejected. PE header validation is only header validation: signature and native acceptance remain `not-verified`. The ZIP contains no source PDFs. Generated URLs are proposed locations, not availability evidence.

### Native dependency notices

The ZIP's `THIRD_PARTY_NOTICES.md` includes full source-bound native dependency notices, including Unicode-3.0, WebView2 MIT copyrights, DPI's libm attribution, and MPL-2.0 source-availability links. `legal:verify` rejects stale Cargo.lock bindings, changed license text, or a missing/modified appendix. This is a reproducible notice inventory, not legal certification.

After dependency changes, use **cargo-about 0.9.2**, review the output and source-bound clarifications in `tools/legal/about.toml`, then regenerate:

```powershell
cargo about generate --locked --fail --manifest-path src-tauri/Cargo.toml --config tools/legal/about.toml --format json --output-file .gjc/evidence/native-licenses.json
node tools/legal/runtime-notices.mjs --import .gjc/evidence/native-licenses.json --write
npm run legal:verify
```

Do not commit the raw cargo-about report: it contains local paths. The importer strips that metadata and rejects generic copyright placeholders. Commit only the normalized inventory and notice changes after review. No dependency was upgraded to add these notices.

## Reviewed tag publication

[Tag publication](../.github/workflows/publish-scoop.yml) promotes the exact bytes from a successful **main** preparation run; it does not rebuild at the tag or promote PR artifacts. The repository must already be public, and both owner-reviewed repository variables must be set:

- `MODELEAF_APPROVED_RELEASE_SHA`: the exact main commit, also targeted by the version tag.
- `MODELEAF_APPROVED_ZIP_SHA256`: the actual reviewed ZIP digest, not a value copied without checking its bytes.

The validator checks source/version/hash/byte count/checksum agreement, the four-file allowlist, and the narrow Scoop manifest contract. It rejects executable hooks, arbitrary targets, unknown fields, and fabricated signature/native status. Publication refuses existing releases, including drafts. It creates a draft, uploads and verifies all four assets, and only then exposes an experimental prerelease. Any upload failure leaves an unpublished draft for inspection; it is not overwritten automatically.

For a published `v0.1.0`, the supported installation command is:

```powershell
scoop install https://github.com/DS-argus/modeleaf-win/releases/download/v0.1.0/modeleaf.json
```

This is a versioned manifest URL, not a maintained bucket or an automatic-update channel. Windows 11 x64 and an installed Microsoft Edge WebView2 Runtime are required. The ZIP/Scoop path does not install WebView2, change PDF associations, or provide the separate NSIS installer.

### Initial experimental execution checklist

- [ ] Successful main CI contains the merged reader and publication implementation
- [ ] Review exact source, ZIP bytes/SHA-256, manifest, receipt, licenses, and limitations before artifact expiration
- [ ] Complete the repository-content/history privacy and redistribution review; acceptance of three historical local PDFs is not blanket licensing of other material
- [ ] Owner reviews the final receipt and explicitly approves public visibility immediately before conversion
- [ ] Set the two exact approval variables and create the matching version tag only after that review
- [ ] Verify all four published asset downloads and the manifest ZIP hash
- [ ] Record actual Scoop installation results separately from metadata/unit/CI checks

No visibility conversion, tag, or public release follows merely from committing this workflow. Never label a missing, expired, mismatched, failed, or unperformed check as success.

## Known initial limitations

Basic app use was accepted by the owner. Full native input/multiwindow scenarios, native DPI/text scaling, Narrator, clean-machine installation, and executable-signature validation remain unverified. Live configuration application, full-document printing, and update retrieval are incomplete; the reported Browse-pointer issue remains unresolved. TOC, keyboard link hints, and link-destination indicators are not included. The current build does not implement automatic updates.

## Further native and production acceptance — HUMAN-ONLY

These remain open work, not claimed prerequisites that the owner somehow performed by accepting basic use. Browser, unit, and CI results do not certify them.

### Authenticode and SmartScreen

- [ ] Deliberately authorize signing setup; no signing certificate or secret is configured by this release work
- [ ] Sign and verify the final executable/installer and timestamp countersignature
- [ ] Record the actual SmartScreen prompt after a browser download on clean Windows 11; signing does not guarantee established reputation

### Clean Windows installation

- [ ] On clean Windows 11 x64, verify truthful missing-WebView2 guidance for ZIP/Scoop and the separately tested NSIS bootstrapper
- [ ] Install through Scoop, launch from shim and Start menu, and open a fixture
- [ ] Check upgrade/uninstall behavior without losing settings or changing associations; no bucket update mechanism is claimed
- [ ] Separately verify NSIS current-user install, Open With registration without seizing defaults, upgrade, and uninstall

### Narrator, display, and packaged behavior

- [ ] Navigate reader, tabs, palette, help, and dialogs with Narrator and record announcements
- [ ] Verify forced colors, native DPI combinations, and 150%/200% text scaling
- [ ] Test 1-, 12-, and 300-page printing through Microsoft Print to PDF; verify counts/order and unchanged reader state after the printing defect is fixed
- [ ] Verify independent windows and exactly-once second-instance file ingress
- [ ] Confirm source PDF SHA-256 values remain unchanged after each scenario

### Production-complete criteria

- [ ] W00–W13 gates complete with retained evidence and no partial, blocked, or undocumented parity rows
- [ ] All applicable native, installer, legal, signing, and accessibility evidence retained
- [ ] Owner separately approves any production-ready claim, signing setup, installer publication, or change to the notify-only update boundary
