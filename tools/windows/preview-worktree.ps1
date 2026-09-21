[CmdletBinding()]
param(
    [string]$Pdf,
    [string]$Worktree,
    [switch]$SkipBuild,
    [switch]$Release
)

$ErrorActionPreference = 'Stop'
$scriptRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$root = if ($Worktree) { (Resolve-Path -LiteralPath $Worktree).Path } else { $scriptRoot }
$packageJson = Join-Path $root 'package.json'
$tauriCli = Join-Path $root 'node_modules\@tauri-apps\cli\tauri.js'
if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) { throw 'Preview must run from a Modeleaf worktree.' }
if (-not (Test-Path -LiteralPath $tauriCli -PathType Leaf)) { throw 'Worktree dependencies are missing. Run npm ci in this worktree first.' }
if ($Pdf -and -not (Test-Path -LiteralPath $Pdf -PathType Leaf)) { throw 'Preview PDF does not exist.' }
if (@(Get-Process -Name modeleaf -ErrorAction SilentlyContinue).Count -ne 0) {
    throw 'Close every Modeleaf process before previewing. Single-instance routing must not select another binary.'
}

function Sha256Text([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '' }
    finally { $sha.Dispose() }
}
function FileSha256([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '' }
    finally { $stream.Dispose(); $sha.Dispose() }
}
function SourceIdentity {
    $head = (& git -C $root rev-parse HEAD).Trim()
    $status = (& git -C $root status --porcelain=v1) -join "`n"
    $diff = (& git -C $root diff --binary HEAD) -join "`n"
    return [ordered]@{ head = $head; statusSha256 = Sha256Text $status; diffSha256 = Sha256Text $diff }
}

$branch = (& git -C $root branch --show-current).Trim()
if ([string]::IsNullOrWhiteSpace($branch)) { throw 'Preview requires a named worktree branch.' }
$target = Join-Path $root '.internal\preview-target'
$receiptPath = Join-Path $target 'preview-receipt.json'
$configuration = if ($Release) { 'release' } else { 'debug' }
$candidateKind = if ($Release) { 'standalone-tauri-release-no-bundle' } else { 'standalone-tauri-debug-no-bundle' }
$executable = Join-Path $target "$configuration\modeleaf.exe"
$identity = SourceIdentity

if (-not $SkipBuild) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $savedTarget = $env:CARGO_TARGET_DIR
    try {
        $env:CARGO_TARGET_DIR = $target
        $env:CARGO_BUILD_JOBS = '1'
        Push-Location $root
        $savedCi = $env:CI
        try {
            if ($Release) { $env:CI = 'true'; & npm run tauri -- build --no-bundle }
            else { & npm run tauri:build-debug }
        } finally { $env:CI = $savedCi; Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'Standalone preview build failed.' }
    } finally {
        $env:CARGO_TARGET_DIR = $savedTarget
    }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Standalone preview build produced no isolated executable.' }
    $identity = SourceIdentity
    [ordered]@{
        kind = $candidateKind
        branch = $branch
        source = $identity
        executableSha256 = FileSha256 $executable
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding utf8
} else {
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw 'No standalone preview receipt exists. Run without -SkipBuild.' }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Receipt has no isolated executable. Run without -SkipBuild.' }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.kind -ne $candidateKind -or $receipt.branch -ne $branch -or $receipt.source.head -ne $identity.head -or $receipt.source.statusSha256 -ne $identity.statusSha256 -or $receipt.source.diffSha256 -ne $identity.diffSha256) {
        throw 'Preview receipt is stale for this worktree. Rebuild without -SkipBuild.'
    }
    $actual = FileSha256 $executable
    if ($receipt.executableSha256 -ne $actual) { throw 'Preview executable does not match its receipt. Rebuild without -SkipBuild.' }
}

$profile = Join-Path $root ('.internal\preview-webview-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$previousProfile = $env:WEBVIEW2_USER_DATA_FOLDER
try {
    $env:WEBVIEW2_USER_DATA_FOLDER = $profile
    if ($Pdf) {
        $process = Start-Process -FilePath $executable -ArgumentList (Resolve-Path -LiteralPath $Pdf).Path -WorkingDirectory $root -PassThru
    } else {
        $process = Start-Process -FilePath $executable -WorkingDirectory $root -PassThru
    }
} finally {
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousProfile
}

[pscustomobject]@{
    Branch = $branch
    Executable = $executable
    ExecutableSha256 = FileSha256 $executable
    ProcessId = $process.Id
    WebViewProfile = $profile
    Receipt = $receiptPath
} | Format-List
