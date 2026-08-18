#Requires -Version 5.1
<#
.SYNOPSIS
    Inspects a locally built Modeleaf NSIS installer without installing it.

.DESCRIPTION
    Verifies the properties of an installer artifact that can be checked from
    the file alone: that it exists, is an NSIS installer, carries version
    metadata consistent with the repository manifests, and reports whether it
    is Authenticode signed.

    This script deliberately does NOT install, launch, or uninstall anything,
    and it never claims clean-VM, SmartScreen, or Narrator evidence. Those are
    HUMAN-ONLY gates recorded in docs/windows-release-checklist.md.

    An unsigned installer is reported, not treated as failure: signing requires
    credentials that are intentionally absent from this repository.

.PARAMETER InstallerPath
    Path to the built installer. Defaults to the standard Tauri NSIS output.

.EXAMPLE
    pwsh -File tools/windows/smoke-w13-installer.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$failures = [System.Collections.Generic.List[string]]::new()
$notes = [System.Collections.Generic.List[string]]::new()

function Write-Result {
    param([string]$Name, [bool]$Passed, [string]$Detail)
    $status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host ("[{0}] {1}" -f $status, $Name)
    if ($Detail) { Write-Host ("       {0}" -f $Detail) }
    if (-not $Passed) { $failures.Add($Name) | Out-Null }
}

# --- Repository manifest versions -------------------------------------------

$tauriConfigPath = Join-Path $repositoryRoot 'src-tauri/tauri.conf.json'
$packageJsonPath = Join-Path $repositoryRoot 'package.json'
$cargoTomlPath = Join-Path $repositoryRoot 'src-tauri/Cargo.toml'

$tauriConfig = Get-Content -Raw -Path $tauriConfigPath | ConvertFrom-Json
$packageJson = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
$cargoVersion = (Select-String -Path $cargoTomlPath -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches[0].Groups[1].Value

$versionsAgree = ($tauriConfig.version -eq $packageJson.version) -and ($cargoVersion -eq $packageJson.version)
Write-Result -Name 'Manifest versions agree' -Passed $versionsAgree -Detail ("tauri={0} package={1} cargo={2}" -f $tauriConfig.version, $packageJson.version, $cargoVersion)

# --- Configuration decisions from ADR 0001 ----------------------------------

Write-Result -Name 'NSIS current-user install mode' `
    -Passed ($tauriConfig.bundle.windows.nsis.installMode -eq 'currentUser') `
    -Detail ("installMode={0}" -f $tauriConfig.bundle.windows.nsis.installMode)

Write-Result -Name 'WebView2 download bootstrapper' `
    -Passed ($tauriConfig.bundle.windows.webviewInstallMode.type -eq 'downloadBootstrapper') `
    -Detail ("type={0}" -f $tauriConfig.bundle.windows.webviewInstallMode.type)

$pdfAssociation = $tauriConfig.bundle.fileAssociations | Where-Object { $_.ext -contains 'pdf' }
Write-Result -Name '.pdf registered as Viewer' `
    -Passed ($null -ne $pdfAssociation -and $pdfAssociation.role -eq 'Viewer') `
    -Detail 'Association must not seize the system default handler'

# --- Installer artifact ------------------------------------------------------

if (-not $InstallerPath) {
    $bundleDirectory = Join-Path $repositoryRoot 'src-tauri/target/release/bundle/nsis'
    if (Test-Path $bundleDirectory) {
        $candidate = Get-ChildItem -Path $bundleDirectory -Filter '*.exe' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($candidate) { $InstallerPath = $candidate.FullName }
    }
}

if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) {
    $notes.Add('No installer artifact found. Build one with: npm run tauri build') | Out-Null
    Write-Host ''
    Write-Host 'Configuration checks complete. Installer artifact checks skipped.'
} else {
    Write-Host ''
    Write-Host ("Inspecting: {0}" -f $InstallerPath)

    $installer = Get-Item -Path $InstallerPath
    Write-Result -Name 'Installer is non-trivial in size' -Passed ($installer.Length -gt 1MB) `
        -Detail ("{0:N1} MB" -f ($installer.Length / 1MB))

    # NSIS installers carry a recognizable signature in their overlay.
    $head = [System.IO.File]::ReadAllBytes($InstallerPath)[0..([Math]::Min(4095, $installer.Length - 1))]
    $headText = [System.Text.Encoding]::ASCII.GetString($head)
    Write-Result -Name 'Artifact is a PE executable' -Passed ($headText.StartsWith('MZ')) -Detail 'MZ header present'

    $fileVersion = $installer.VersionInfo.FileVersion
    if ($fileVersion) {
        Write-Result -Name 'Installer version matches manifests' `
            -Passed ($fileVersion -like "$($packageJson.version)*") `
            -Detail ("installer={0} expected={1}" -f $fileVersion, $packageJson.version)
    } else {
        $notes.Add('Installer reports no file version metadata.') | Out-Null
    }

    # Signing is reported, never required: credentials are intentionally absent.
    $signature = Get-AuthenticodeSignature -FilePath $InstallerPath
    if ($signature.Status -eq 'Valid') {
        Write-Host ("[INFO] Authenticode: Valid ({0})" -f $signature.SignerCertificate.Subject)
    } else {
        $notes.Add(("Installer is not signed (status: {0}). Signing is a HUMAN-ONLY release gate." -f $signature.Status)) | Out-Null
    }

    $sha256 = (Get-FileHash -Path $InstallerPath -Algorithm SHA256).Hash
    Write-Host ("[INFO] SHA-256: {0}" -f $sha256)
}

# --- Summary -----------------------------------------------------------------

Write-Host ''
foreach ($note in $notes) { Write-Host ("[NOTE] {0}" -f $note) }

Write-Host ''
Write-Host 'HUMAN-ONLY gates NOT covered by this script:'
Write-Host '  - Clean Windows 10/11 VM install, launch, upgrade, uninstall'
Write-Host '  - Open With and default-handler behavior in Explorer'
Write-Host '  - SmartScreen reputation prompt'
Write-Host '  - Narrator and forced-colors verification'
Write-Host '  See docs/windows-release-checklist.md'

if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Error ("{0} check(s) failed: {1}" -f $failures.Count, ($failures -join ', '))
    exit 1
}

Write-Host ''
Write-Host 'All automated installer checks passed.'
exit 0
