#Requires -Version 5.1
<#
.SYNOPSIS
    Prepares a private, reviewable Modeleaf ZIP and Scoop manifest.

.DESCRIPTION
    Validates an existing Windows x64 GUI PE header, checks repository version
    and license metadata, and creates a curated ZIP plus review metadata. This
    script does not sign, install, launch, upload, tag, or publish anything.

.PARAMETER ExecutablePath
    Existing Modeleaf executable to copy into the package as modeleaf.exe.

.PARAMETER OutputDirectory
    New directory that will receive the four package artifacts.

.PARAMETER RepositoryRoot
    Repository containing the manifests and notices. Defaults to ../.. from
    this script.

.PARAMETER RepositorySlug
    GitHub owner/repository used only to construct manifest URLs.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ExecutablePath,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputDirectory,

    [ValidateNotNullOrEmpty()]
    [string]$RepositoryRoot,

    [ValidateNotNullOrEmpty()]
    [string]$RepositorySlug = 'DS-argus/modeleaf-win'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

if (-not $PSBoundParameters.ContainsKey('RepositoryRoot')) {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw 'Cannot resolve the script directory; provide RepositoryRoot explicitly.'
    }
    $RepositoryRoot = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::Combine($PSScriptRoot, '..', '..')
    )
}

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        $fullPath = [System.IO.Path]::GetFullPath($Path)
    } catch {
        throw "Invalid filesystem path: $Path"
    }

    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $pathRoot.Length) {
        $separators = [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )
        $fullPath = $fullPath.TrimEnd($separators)
    }
    return $fullPath
}

function Resolve-RequiredFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label,
        [switch]$AllowEmpty
    )

    $fullPath = Get-NormalizedFullPath -Path $Path
    if (-not [System.IO.File]::Exists($fullPath)) {
        throw "$Label is missing or is not a file."
    }
    if (-not $AllowEmpty -and ([System.IO.FileInfo]::new($fullPath)).Length -eq 0) {
        throw "$Label must not be empty."
    }
    return $fullPath
}

function Read-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    try {
        return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    } catch {
        throw "$Label is not valid JSON."
    }
}

function Get-RequiredJsonString {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Property,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $jsonProperty = $Object.PSObject.Properties[$Property]
    if ($null -eq $jsonProperty -or $jsonProperty.Value -isnot [string] -or
        [string]::IsNullOrWhiteSpace([string]$jsonProperty.Value)) {
        throw "$Label must contain a non-empty string property '$Property'."
    }
    return [string]$jsonProperty.Value
}

function Get-CargoPackageString {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Property
    )

    $inPackageSection = $false
    $foundValue = $null
    $propertyPattern = '^\s*' + [regex]::Escape($Property) + '\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$'

    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -match '^\s*\[([^\]]+)\]\s*(?:#.*)?$') {
            $inPackageSection = ($Matches[1] -ceq 'package')
            continue
        }
        if (-not $inPackageSection) {
            continue
        }
        $propertyMatch = [regex]::Match($line, $propertyPattern)
        if (-not $propertyMatch.Success) {
            continue
        }
        if ($null -ne $foundValue) {
            throw "src-tauri/Cargo.toml has duplicate [package] $Property values."
        }
        $foundValue = $propertyMatch.Groups[1].Value
    }

    if ($null -eq $foundValue -or [string]::IsNullOrWhiteSpace($foundValue)) {
        throw "src-tauri/Cargo.toml is missing [package] $Property."
    }
    return [string]$foundValue
}

function Assert-SafeVersion {
    param([Parameter(Mandatory = $true)][string]$Version)

    $numericIdentifier = '(?:0|[1-9][0-9]*)'
    $nonNumericIdentifier = '(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
    $preReleaseIdentifier = "(?:$numericIdentifier|$nonNumericIdentifier)"
    $buildIdentifier = '[0-9A-Za-z-]+'
    $pattern = "\A$numericIdentifier\.$numericIdentifier\.$numericIdentifier(?:-$preReleaseIdentifier(?:\.$preReleaseIdentifier)*)?(?:\+$buildIdentifier(?:\.$buildIdentifier)*)?\z"

    if ($Version.Length -gt 128 -or $Version -cne $Version.Trim() -or $Version -cnotmatch $pattern) {
        throw "package.json version is not a safe semantic version."
    }
}

function Assert-SafeRepositorySlug {
    param([Parameter(Mandatory = $true)][string]$Slug)

    $owner = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?'
    $repository = '[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?'
    if ($Slug.Length -gt 140 -or $Slug -cne $Slug.Trim() -or
        $Slug -cnotmatch "\A$owner/$repository\z") {
        throw "RepositorySlug must be a safe GitHub owner/repository slug."
    }
}

function Get-SourceCommit {
    param([Parameter(Mandatory = $true)][string]$Root)

    $git = Get-Command -Name 'git' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $git) {
        throw 'git is required to read the source commit.'
    }

    $gitPath = $git.Source
    try {
        $gitOutput = @(& $gitPath -C $Root rev-parse HEAD 2>&1)
        $gitExitCode = $LASTEXITCODE
    } catch {
        throw 'git -C <RepositoryRoot> rev-parse HEAD failed.'
    }
    if ($gitExitCode -ne 0) {
        throw 'git -C <RepositoryRoot> rev-parse HEAD failed.'
    }

    $commitLines = @(
        $gitOutput |
            ForEach-Object { $_.ToString().Trim() } |
            Where-Object { $_ -match '\A[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?\z' }
    )
    if ($commitLines.Count -ne 1) {
        throw 'git returned an invalid source commit.'
    }
    return $commitLines[0].ToLowerInvariant()
}

function Assert-X64GuiPeHeader {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $reader = $null
    try {
        $reader = [System.IO.BinaryReader]::new($stream)
        $length = $stream.Length
        if ($length -lt 64) {
            throw 'Executable has a truncated DOS header.'
        }

        if ($reader.ReadByte() -ne 0x4D -or $reader.ReadByte() -ne 0x5A) {
            throw 'Executable does not have an MZ header.'
        }

        $stream.Position = 0x3C
        [uint32]$peOffset = $reader.ReadUInt32()
        if ($peOffset -lt 0x40 -or ([int64]$peOffset + 24) -gt $length) {
            throw 'Executable has an out-of-bounds PE header offset.'
        }

        $stream.Position = [int64]$peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw 'Executable does not have a valid PE signature.'
        }

        [uint16]$machine = $reader.ReadUInt16()
        if ($machine -ne 0x8664) {
            throw 'Executable PE architecture must be x64 (AMD64).'
        }

        $stream.Position = [int64]$peOffset + 20
        [uint16]$optionalHeaderSize = $reader.ReadUInt16()
        [uint16]$characteristics = $reader.ReadUInt16()
        if (($characteristics -band 0x0002) -eq 0 -or ($characteristics -band 0x2000) -ne 0) {
            throw 'Executable PE characteristics must describe an executable image, not a DLL.'
        }

        [int64]$optionalHeaderOffset = [int64]$peOffset + 24
        if ($optionalHeaderSize -lt 70 -or ($optionalHeaderOffset + $optionalHeaderSize) -gt $length) {
            throw 'Executable has a truncated or out-of-bounds optional header.'
        }

        $stream.Position = $optionalHeaderOffset
        if ($reader.ReadUInt16() -ne 0x020B) {
            throw 'Executable must use the PE32+ optional header for x64.'
        }

        $stream.Position = $optionalHeaderOffset + 68
        [uint16]$subsystem = $reader.ReadUInt16()
        if ($subsystem -ne 2) {
            throw 'Executable PE subsystem must be Windows GUI.'
        }
    } finally {
        if ($null -ne $reader) {
            $reader.Dispose()
        } else {
            $stream.Dispose()
        }
    }
}

function Copy-PackageFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$PayloadRoot,
        [Parameter(Mandatory = $true)][string]$RelativeDestination
    )

    $destination = [System.IO.Path]::Combine($PayloadRoot, $RelativeDestination)
    $destinationDirectory = [System.IO.Path]::GetDirectoryName($destination)
    if (-not [System.IO.Directory]::Exists($destinationDirectory)) {
        $null = [System.IO.Directory]::CreateDirectory($destinationDirectory)
    }
    [System.IO.File]::Copy($Source, $destination, $false)
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha256.ComputeHash($stream)
        return ([System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant())
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Write-Utf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    [System.IO.File]::WriteAllText($Path, $Content, $script:utf8NoBom)
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 10
    Write-Utf8File -Path $Path -Content ($json + [Environment]::NewLine)
}

Assert-SafeRepositorySlug -Slug $RepositorySlug

$executableFullPath = Resolve-RequiredFile -Path $ExecutablePath -Label 'ExecutablePath' -AllowEmpty
$repositoryFullPath = Get-NormalizedFullPath -Path $RepositoryRoot
if (-not [System.IO.Directory]::Exists($repositoryFullPath)) {
    throw 'RepositoryRoot is missing or is not a directory.'
}

$outputFullPath = Get-NormalizedFullPath -Path $OutputDirectory
if (Test-Path -LiteralPath $outputFullPath) {
    throw 'OutputDirectory already exists; refusing to overwrite it.'
}
$outputParent = [System.IO.Path]::GetDirectoryName($outputFullPath)
if ([string]::IsNullOrWhiteSpace($outputParent) -or -not [System.IO.Directory]::Exists($outputParent)) {
    throw 'OutputDirectory parent must already exist.'
}

$stagingDirectory = [System.IO.Path]::Combine(
    $outputParent,
    ('.modeleaf-scoop-staging-' + [guid]::NewGuid().ToString('N'))
)
while (Test-Path -LiteralPath $stagingDirectory) {
    $stagingDirectory = [System.IO.Path]::Combine(
        $outputParent,
        ('.modeleaf-scoop-staging-' + [guid]::NewGuid().ToString('N'))
    )
}
$null = [System.IO.Directory]::CreateDirectory($stagingDirectory)
$ownsStagingDirectory = $true

try {
    Assert-X64GuiPeHeader -Path $executableFullPath

    $packageJsonPath = Resolve-RequiredFile `
        -Path ([System.IO.Path]::Combine($repositoryFullPath, 'package.json')) `
        -Label 'package.json'
    $tauriConfigPath = Resolve-RequiredFile `
        -Path ([System.IO.Path]::Combine($repositoryFullPath, 'src-tauri', 'tauri.conf.json')) `
        -Label 'src-tauri/tauri.conf.json'
    $cargoTomlPath = Resolve-RequiredFile `
        -Path ([System.IO.Path]::Combine($repositoryFullPath, 'src-tauri', 'Cargo.toml')) `
        -Label 'src-tauri/Cargo.toml'
    $licensePath = Resolve-RequiredFile `
        -Path ([System.IO.Path]::Combine($repositoryFullPath, 'LICENSE')) `
        -Label 'LICENSE'
    $thirdPartyNoticesPath = Resolve-RequiredFile `
        -Path ([System.IO.Path]::Combine($repositoryFullPath, 'THIRD_PARTY_NOTICES.md')) `
        -Label 'THIRD_PARTY_NOTICES.md'

    $packageJson = Read-JsonFile -Path $packageJsonPath -Label 'package.json'
    $tauriConfig = Read-JsonFile -Path $tauriConfigPath -Label 'src-tauri/tauri.conf.json'
    $version = Get-RequiredJsonString -Object $packageJson -Property 'version' -Label 'package.json'
    $packageLicense = Get-RequiredJsonString -Object $packageJson -Property 'license' -Label 'package.json'
    $tauriVersion = Get-RequiredJsonString -Object $tauriConfig -Property 'version' -Label 'src-tauri/tauri.conf.json'
    Assert-SafeVersion -Version $version

    $cargoText = [System.IO.File]::ReadAllText($cargoTomlPath, [System.Text.Encoding]::UTF8)
    $cargoVersion = Get-CargoPackageString -Text $cargoText -Property 'version'
    $cargoLicense = Get-CargoPackageString -Text $cargoText -Property 'license'
    $description = 'Keyboard-first read-only PDF viewer for Windows'

    if ($tauriVersion -cne $version -or $cargoVersion -cne $version) {
        throw "Version mismatch: package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml must be identical."
    }
    if ($packageLicense -cne 'MIT' -or $cargoLicense -cne 'MIT') {
        throw 'package.json and src-tauri/Cargo.toml must declare the product license as MIT.'
    }

    $licenseText = [System.IO.File]::ReadAllText($licensePath, [System.Text.Encoding]::UTF8)
    if ($licenseText -notmatch '(?im)^\s*MIT License\s*$') {
        throw 'Root LICENSE does not contain the MIT License heading.'
    }

    $pdfJsRoot = [System.IO.Path]::Combine($repositoryFullPath, 'public', 'assets', 'pdfjs-6.2.108')
    $fixedPdfJsLicenses = @(
        'cmaps\LICENSE',
        'iccs\LICENSE',
        'standard_fonts\LICENSE_FOXIT',
        'standard_fonts\LICENSE_LIBERATION',
        'wasm\LICENSE_JBIG2',
        'wasm\LICENSE_PDFJS_JBIG2',
        'wasm\LICENSE_OPENJPEG',
        'wasm\LICENSE_PDFJS_OPENJPEG',
        'wasm\LICENSE_PDFJS_QCMS',
        'wasm\LICENSE_QCMS'
    )
    $pdfJsLicenseFiles = @()
    foreach ($relativeLicense in $fixedPdfJsLicenses) {
        $source = Resolve-RequiredFile `
            -Path ([System.IO.Path]::Combine($pdfJsRoot, $relativeLicense)) `
            -Label ("PDF.js license public/assets/pdfjs-6.2.108/{0}" -f ($relativeLicense -replace '\\', '/'))
        $pdfJsLicenseFiles += [pscustomobject]@{
            Source = $source
            Relative = $relativeLicense
        }
    }

    $sourceCommit = Get-SourceCommit -Root $repositoryFullPath
    $payloadDirectory = [System.IO.Path]::Combine($stagingDirectory, 'payload')
    $null = [System.IO.Directory]::CreateDirectory($payloadDirectory)

    Copy-PackageFile -Source $executableFullPath -PayloadRoot $payloadDirectory -RelativeDestination 'modeleaf.exe'
    Assert-X64GuiPeHeader -Path ([System.IO.Path]::Combine($payloadDirectory, 'modeleaf.exe'))
    Copy-PackageFile -Source $licensePath -PayloadRoot $payloadDirectory -RelativeDestination 'LICENSE'
    Copy-PackageFile -Source $thirdPartyNoticesPath -PayloadRoot $payloadDirectory -RelativeDestination 'THIRD_PARTY_NOTICES.md'
    foreach ($pdfJsLicense in $pdfJsLicenseFiles) {
        Copy-PackageFile `
            -Source $pdfJsLicense.Source `
            -PayloadRoot $payloadDirectory `
            -RelativeDestination ([System.IO.Path]::Combine('licenses', 'pdfjs', $pdfJsLicense.Relative))
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipBasename = "modeleaf-$version-windows-x64.zip"
    $zipPath = [System.IO.Path]::Combine($stagingDirectory, $zipBasename)
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $payloadDirectory,
        $zipPath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
    [System.IO.Directory]::Delete($payloadDirectory, $true)

    $zipSha256 = Get-Sha256 -Path $zipPath
    [int64]$zipBytes = ([System.IO.FileInfo]::new($zipPath)).Length
    $releaseUrl = "https://github.com/$RepositorySlug/releases/download/v$version/$zipBasename"

    $manifest = [ordered]@{
        version = $version
        description = $description
        homepage = "https://github.com/$RepositorySlug"
        license = 'MIT'
        architecture = [ordered]@{
            '64bit' = [ordered]@{
                url = $releaseUrl
                hash = $zipSha256
            }
        }
        bin = 'modeleaf.exe'
        shortcuts = @(, @('modeleaf.exe', 'Modeleaf'))
        notes = @(
            'Requires Windows 11 x64.'
            'Requires the Microsoft Edge WebView2 Runtime to be installed.'
        )
    }
    Write-JsonFile -Path ([System.IO.Path]::Combine($stagingDirectory, 'modeleaf.json')) -Value $manifest

    $checksumLine = "$zipSha256  $zipBasename" + [Environment]::NewLine
    Write-Utf8File -Path ([System.IO.Path]::Combine($stagingDirectory, 'SHA256SUMS')) -Content $checksumLine

    $receipt = [ordered]@{
        source = [ordered]@{
            commit = $sourceCommit
            version = $version
        }
        artifact = [ordered]@{
            basename = $zipBasename
            sha256 = $zipSha256
            bytes = $zipBytes
        }
        status = [ordered]@{
            signature = 'not-verified'
            executableValidation = 'header-only'
            nativeAcceptance = 'not-verified'
        }
    }
    Write-JsonFile `
        -Path ([System.IO.Path]::Combine($stagingDirectory, 'package-receipt.json')) `
        -Value $receipt

    if (Test-Path -LiteralPath $outputFullPath) {
        throw 'OutputDirectory appeared during packaging; refusing to overwrite it.'
    }
    [System.IO.Directory]::Move($stagingDirectory, $outputFullPath)
    $ownsStagingDirectory = $false
} finally {
    if ($ownsStagingDirectory -and [System.IO.Directory]::Exists($stagingDirectory)) {
        [System.IO.Directory]::Delete($stagingDirectory, $true)
    }
}
