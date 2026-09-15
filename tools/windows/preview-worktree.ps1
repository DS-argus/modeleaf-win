[CmdletBinding()]
param(
    [string]$Pdf,
    [string]$Worktree,
    [switch]$SkipBuild
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

function Sha256Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '' }
    finally { $sha.Dispose() }
}
function Sha256Text([string]$Value) { return Sha256Bytes ([Text.Encoding]::UTF8.GetBytes($Value)) }
function Sha256File([string]$Path) { return Sha256Bytes ([IO.File]::ReadAllBytes($Path)) }
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
$executable = Join-Path $target 'debug\modeleaf.exe'
$identity = SourceIdentity

if (-not $SkipBuild) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $savedTarget = $env:CARGO_TARGET_DIR
    try {
        $env:CARGO_TARGET_DIR = $target
        $env:CARGO_BUILD_JOBS = '1'
        Push-Location $root
        try { & npm run tauri:build-debug } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw 'Standalone preview build failed.' }
    } finally {
        $env:CARGO_TARGET_DIR = $savedTarget
    }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Standalone preview build produced no isolated executable.' }
    $identity = SourceIdentity
    [ordered]@{
        kind = 'standalone-tauri-debug-no-bundle'
        branch = $branch
        source = $identity
        executableSha256 = Sha256File $executable
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding utf8
} else {
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw 'No standalone preview receipt exists. Run without -SkipBuild.' }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Receipt has no isolated executable. Run without -SkipBuild.' }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.kind -ne 'standalone-tauri-debug-no-bundle' -or $receipt.branch -ne $branch -or $receipt.source.head -ne $identity.head -or $receipt.source.statusSha256 -ne $identity.statusSha256 -or $receipt.source.diffSha256 -ne $identity.diffSha256) {
        throw 'Preview receipt is stale for this worktree. Rebuild without -SkipBuild.'
    }
    $actual = Sha256File $executable
    if ($receipt.executableSha256 -ne $actual) { throw 'Preview executable does not match its receipt. Rebuild without -SkipBuild.' }
}

$profile = Join-Path $root ('.internal\preview-webview-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$previousProfile = $env:WEBVIEW2_USER_DATA_FOLDER
try {
    $env:WEBVIEW2_USER_DATA_FOLDER = $profile
    $launch = @{ FilePath = $executable; WorkingDirectory = $root; PassThru = $true }
    if ($Pdf) { $launch.ArgumentList = @((Resolve-Path -LiteralPath $Pdf).Path) }
    $process = Start-Process @launch
} finally {
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousProfile
}

[pscustomobject]@{
    Branch = $branch
    Executable = $executable
    ExecutableSha256 = Sha256File $executable
    ProcessId = $process.Id
    WebViewProfile = $profile
    Receipt = $receiptPath
} | Format-List
