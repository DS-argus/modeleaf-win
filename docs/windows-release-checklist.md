# Windows release checklist

The owner authorized an **initial experimental Windows release** after accepting basic app use; see [Issue #64](https://github.com/DS-argus/modeleaf-win/issues/64). This explicitly permits initial distribution before full parity, signing, and native acceptance are complete. It does not certify those gates or waive the final owner review immediately before public conversion.

This checklist does not establish that a release happened. Treat a candidate as **unreleased** until its matching GitHub prerelease and verified assets exist. The [parity matrix](parity-matrix.md) remains the source of incomplete product acceptance.

## Pre-publication history cleanup

Issue #68 removes unused personal reference captures and obsolete planning files from the publishable Git ancestry. Original historical measurement records are preserved: [history-rewrite.json](evidence/history-rewrite.json) maps the W02 source commit to its filtered equivalent, and the original source-tree SHA-256 is still recomputed and required to match. Original archive/PR commit identifiers remain historical provenance, not promises of public object availability. The external macOS baseline is unchanged.

A history rewrite invalidates every previous source-bound release candidate. Use a newly verified main build, not an old ZIP receipt. Do not merge old local branches back into rewritten main: they can restore removed objects. Private backups and local user work are not public release inputs. Deleting main history or remote branches does not erase GitHub's hidden PR refs or caches; confirm server-side removal separately before claiming complete erasure or approving public visibility.
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

After the release and the matching bucket manifest are published, the supported installation and update commands are:

```powershell
scoop bucket add modeleaf https://github.com/DS-argus/scoop-bucket
scoop install modeleaf/modeleaf

scoop update
scoop update modeleaf
```

The dedicated bucket is maintained at `DS-argus/scoop-bucket`, with its current reviewed manifest at `bucket/modeleaf.json`. `scoop update` refreshes bucket metadata; `scoop update modeleaf` applies the available version only when invoked by the user. This does not add an in-app automatic updater. Windows 11 x64 and an installed Microsoft Edge WebView2 Runtime are required. The ZIP/Scoop path does not install WebView2, change PDF associations, or provide the separate NSIS installer.

### Verified bucket promotion

Keep both repositories private until final owner approval. An empty private bucket is preparation, not evidence that installation works. After the actual release is public, generate its manifest from the reviewed four-file candidate and verified public downloads:

```powershell
node tools/releases/prepare-scoop-bucket.mjs --artifacts <reviewed-artifact-directory> --tag <vSemVer> --source-commit <approved-40-hex-SHA> --zip-sha256 <approved-64-hex-SHA256> --output <new-staging-directory>
```

The helper refuses unpublished/draft releases, unexpected assets, source/hash disagreement, download corruption and existing output directories. It writes only `bucket/modeleaf.json` into the new staging directory after every public asset matches the reviewed bytes. It never changes Git, visibility, releases, or credentials.

Create/select a bucket Issue and dedicated branch/worktree; copy the generated file into `bucket/modeleaf.json`, review the exact URL/version/hash diff, and merge a focused PR. Repeat after each release. No cross-repository token or unchecked latest-release scraper is required. Never promote a prerelease merely because it exists: it must be the explicitly reviewed source and ZIP. The bucket may lag release publication until this step succeeds; report failures rather than claiming installation is available.

### Initial experimental execution checklist

- [ ] Successful main CI contains the merged reader and publication implementation
- [ ] Review exact source, ZIP bytes/SHA-256, manifest, receipt, licenses, and limitations before artifact expiration
- [ ] Complete the repository-content/history privacy and redistribution review; acceptance of three historical local PDFs is not blanket licensing of other material
- [ ] Owner reviews the final receipt and explicitly approves public visibility immediately before conversion
- [ ] Set the two exact approval variables and create the matching version tag only after that review
- [ ] Verify all four published asset downloads and the manifest ZIP hash
- [ ] Verify public release assets with the bucket helper, review and merge `bucket/modeleaf.json` in the dedicated bucket
- [ ] Confirm both repositories are public only under the owner's approval and the documented bucket install command resolves
- [ ] Record actual Scoop installation results separately from metadata/unit/CI checks

No visibility conversion, tag, or public release follows merely from committing this workflow. Never label a missing, expired, mismatched, failed, or unperformed check as success.

## Known initial limitations

Basic app use was accepted by the owner. Full native input/multiwindow scenarios, native DPI/text scaling, Narrator, clean-machine installation, and executable-signature validation remain unverified beyond the specific recorded checks. Live configuration application and update retrieval are incomplete. Basic native full-document printing has Issue #83 reference-workstation fixture evidence, but remains excluded from the recorded 0.1.2 release and its release qualification is incomplete. The keyboard-triggered Browse-pointer issue is addressed by the app-scoped HideCursorWhileTyping policy (PR #72). TOC, keyboard link hints, and link-destination indicators are not included. The current build does not implement automatic updates.

## Further native and production acceptance — HUMAN-ONLY

These remain open work, not claimed prerequisites that the owner somehow performed by accepting basic use. Browser, unit, and CI results do not certify them.

### Authenticode and SmartScreen

- [ ] Deliberately authorize signing setup; no signing certificate or secret is configured by this release work
- [ ] Sign and verify the final executable/installer and timestamp countersignature
- [ ] Record the actual SmartScreen prompt after a browser download on clean Windows 11; signing does not guarantee established reputation

### Clean Windows installation

- [ ] On clean Windows 11 x64, verify truthful missing-WebView2 guidance for ZIP/Scoop and the separately tested NSIS bootstrapper
- [ ] Install through Scoop, launch from shim and Start menu, and open a fixture
- [ ] Check upgrade/uninstall behavior without losing settings or changing associations; check the published bucket manifest version before upgrading
- [ ] Separately verify NSIS current-user install, Open With registration without seizing defaults, upgrade, and uninstall

### Narrator, display, and packaged behavior

- [ ] Navigate reader, tabs, palette, help, and dialogs with Narrator and record announcements
- [ ] Verify forced colors, native DPI combinations, and 150%/200% text scaling
- [ ] On the packaged release candidate in clean Windows, deliver Ctrl+P through the OS foreground keyboard path and test owned-dialog focus/cancel plus 1-, 12-, 300-page and mixed-rotation Microsoft Print to PDF output; verify count/order, selected-paper fit and intrinsic rotation, unchanged reader state/source SHA, and record `submitted` separately from physical success. [Issue #83](https://github.com/DS-argus/modeleaf-win/issues/83) reference-workstation CDP/debug evidence does not satisfy this gate.
- [ ] Verify independent windows and exactly-once second-instance file ingress
- [ ] Confirm source PDF SHA-256 values remain unchanged after each scenario

### Production-complete criteria

- [ ] W00–W13 gates complete with retained evidence and no partial, blocked, or undocumented parity rows
- [ ] All applicable native, installer, legal, signing, and accessibility evidence retained
- [ ] Owner separately approves any production-ready claim, signing setup, installer publication, or change to the notify-only update boundary
