param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$PdfPath,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ModeleafNativeWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  private struct GUITHREADINFO {
    public int cbSize;
    public int flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }

  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageW(IntPtr hWnd, uint message, IntPtr wParam, string lParam);

  private static IntPtr FocusedWindow(IntPtr topLevel) {
    uint thread = GetWindowThreadProcessId(topLevel, IntPtr.Zero);
    GUITHREADINFO info = new GUITHREADINFO { cbSize = Marshal.SizeOf<GUITHREADINFO>() };
    return thread != 0 && GetGUIThreadInfo(thread, ref info) && info.hwndFocus != IntPtr.Zero
      ? info.hwndFocus
      : topLevel;
  }

  public static IntPtr Foreground() { return GetForegroundWindow(); }

  public static bool Activate(IntPtr hWnd) {
    uint currentThread = GetCurrentThreadId();
    uint targetThread = GetWindowThreadProcessId(hWnd, IntPtr.Zero);
    IntPtr foreground = GetForegroundWindow();
    uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
    if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
    if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
    ShowWindow(hWnd, 9);
    BringWindowToTop(hWnd);
    bool activated = SetForegroundWindow(hWnd);
    SetFocus(hWnd);
    if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
    if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
    return activated;
  }

  public static bool PostKey(IntPtr topLevel, int virtualKey, bool control, bool shift) {
    IntPtr target = FocusedWindow(topLevel);
    bool result = true;
    if (control) result &= PostMessageW(target, 0x0100, (IntPtr)0x11, IntPtr.Zero);
    if (shift) result &= PostMessageW(target, 0x0100, (IntPtr)0x10, IntPtr.Zero);
    result &= PostMessageW(target, 0x0100, (IntPtr)virtualKey, IntPtr.Zero);
    result &= PostMessageW(target, 0x0101, (IntPtr)virtualKey, (IntPtr)0xC0000001);
    if (shift) result &= PostMessageW(target, 0x0101, (IntPtr)0x10, (IntPtr)0xC0000001);
    if (control) result &= PostMessageW(target, 0x0101, (IntPtr)0x11, (IntPtr)0xC0000001);
    return result;
  }

  public static bool SetFocusedText(IntPtr topLevel, string value) {
    return SendMessageW(FocusedWindow(topLevel), 0x000C, IntPtr.Zero, value) != IntPtr.Zero;
  }

  public static bool CloseWindow(IntPtr topLevel) {
    return PostMessageW(topLevel, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
}
"@
function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

$exe = (Resolve-Path -LiteralPath $ExePath).Path
$pdf = (Resolve-Path -LiteralPath $PdfPath).Path
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$evidence = (Resolve-Path -LiteralPath $EvidenceDirectory).Path
$sourceBefore = Get-Sha256 $pdf
$dialogPdf = Join-Path $evidence "smoke-input.pdf"
[System.IO.File]::Copy($pdf, $dialogPdf, $true)
$events = [System.Collections.Generic.List[object]]::new()
$process = $null
$automationShell = New-Object -ComObject WScript.Shell

function Add-Event([string]$Action, [string]$Outcome) {
  [void]$events.Add([ordered]@{
    monotonicMs = [Environment]::TickCount64
    action = $Action
    outcome = $Outcome
  })
}

function Focus-App {
  $process.Refresh()
  if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw "Modeleaf has no main window" }
  if (-not [ModeleafNativeWindow]::Activate($process.MainWindowHandle)) {
    [void]$automationShell.AppActivate($process.Id)
  }
  Start-Sleep -Milliseconds 250
}

function Send-Key([int]$VirtualKey, [bool]$Control, [bool]$Shift, [string]$Action) {
  if (-not [ModeleafNativeWindow]::PostKey($process.MainWindowHandle, $VirtualKey, $Control, $Shift)) {
    throw "Could not deliver $Action"
  }
  Add-Event $Action "sent"
  Start-Sleep -Milliseconds 400
}

function Capture-Window([string]$Name) {
  $process.Refresh()
  $rect = New-Object ModeleafNativeWindow+RECT
  if (-not [ModeleafNativeWindow]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) { throw "Could not read Modeleaf window bounds" }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 320 -or $height -lt 240) { throw "Modeleaf window bounds are invalid" }
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
    $output = Join-Path $evidence "$Name.png"
    $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
    $colors = [System.Collections.Generic.HashSet[int]]::new()
    for ($x = 0; $x -lt $width; $x += [Math]::Max(1, [Math]::Floor($width / 32))) {
      for ($y = 0; $y -lt $height; $y += [Math]::Max(1, [Math]::Floor($height / 32))) {
        [void]$colors.Add($bitmap.GetPixel($x, $y).ToArgb())
      }
    }
    if ($colors.Count -lt 8) { throw "Captured Modeleaf window is visually uniform" }
    Add-Event "capture:$Name" "passed:$($colors.Count)-sample-colors"
    $surfaceBytes = [System.Collections.Generic.List[byte]]::new()
    for ($column = 0; $column -lt 32; $column++) {
      for ($row = 0; $row -lt 32; $row++) {
        $sampleX = [Math]::Floor($width * (0.2 + (0.6 * ($column + 0.5) / 32)))
        $sampleY = [Math]::Floor($height * (0.12 + (0.76 * ($row + 0.5) / 32)))
        $sample = $bitmap.GetPixel($sampleX, $sampleY)
        [void]$surfaceBytes.Add($sample.R)
        [void]$surfaceBytes.Add($sample.G)
        [void]$surfaceBytes.Add($sample.B)
        [void]$surfaceBytes.Add($sample.A)
      }
    }
    $surfaceAlgorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      return [BitConverter]::ToString($surfaceAlgorithm.ComputeHash($surfaceBytes.ToArray())).Replace("-", "").ToLowerInvariant()
    } finally {
      $surfaceAlgorithm.Dispose()
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}
function Wait-For-VisiblePage([System.Diagnostics.Stopwatch]$Timer) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $process.Refresh()
    $rect = New-Object ModeleafNativeWindow+RECT
    if ([ModeleafNativeWindow]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      $bitmap = New-Object System.Drawing.Bitmap $width, $height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
        $lightSamples = 0
        $colors = [System.Collections.Generic.HashSet[int]]::new()
        for ($column = 0; $column -lt 16; $column++) {
          for ($row = 0; $row -lt 16; $row++) {
            $x = [Math]::Floor($width * (0.25 + (0.5 * ($column + 0.5) / 16)))
            $y = [Math]::Floor($height * (0.18 + (0.7 * ($row + 0.5) / 16)))
            $pixel = $bitmap.GetPixel($x, $y)
            [void]$colors.Add($pixel.ToArgb())
            if (($pixel.R + $pixel.G + $pixel.B) -ge 600) { $lightSamples++ }
          }
        }
        if ($lightSamples -ge 24 -and $colors.Count -ge 12) {
          $Timer.Stop()
          Add-Event "page:first-visible" "passed:$($Timer.ElapsedMilliseconds)ms"
          return $Timer.ElapsedMilliseconds
        }
      } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
      }
    }
    Start-Sleep -Milliseconds 50
  } while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  throw "A nonblank PDF page was not visible within 15 seconds"
}

function Send-InputBurst {
  for ($index = 0; $index -lt 100; $index++) {
    if (-not [ModeleafNativeWindow]::PostKey($process.MainWindowHandle, $(if (($index % 2) -eq 0) { 0x4E } else { 0x50 }), $false, $false)) {
      throw "Could not deliver navigation sample"
    }
  }
  Start-Sleep -Milliseconds 750
  $process.Refresh()
  if ($process.HasExited) { throw "Modeleaf exited during the navigation input burst" }
  Add-Event "input:n-p-100" "queued:process-alive-no-consumption-claim"
  return 100
}

try {
  $process = Start-Process -FilePath $exe -PassThru
  Add-Event "launch" "started"
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    $process.Refresh()
  } while ($process.MainWindowHandle -eq [IntPtr]::Zero -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline)
  if ($process.HasExited) { throw "Modeleaf exited before opening a window" }
  Focus-App
  Capture-Window "cp1-empty"

  Send-Key 0x4F $true $true "shortcut:Ctrl+Shift+O"
  Start-Sleep -Milliseconds 700
  Send-Key 0x0D $false $false "chooser:Browse"
  Start-Sleep -Milliseconds 700
  $dialog = [ModeleafNativeWindow]::Foreground()
  if ($dialog -eq [IntPtr]::Zero -or $dialog -eq $process.MainWindowHandle) { throw "Native PDF dialog did not become active" }
  if (-not [ModeleafNativeWindow]::SetFocusedText($dialog, $dialogPdf)) { throw "Could not enter the fixture path in the native dialog" }
  Add-Event "native-dialog:path-entry" "sent"
  $firstVisibleTimer = [System.Diagnostics.Stopwatch]::StartNew()
  if (-not [ModeleafNativeWindow]::PostKey($dialog, 0x0D, $false, $false)) { throw "Could not submit the native PDF dialog" }
  Add-Event "native-dialog:choose-local-pdf" "submitted"
  $firstVisibleMs = Wait-For-VisiblePage $firstVisibleTimer
  if ($firstVisibleMs -ge 2000) { throw "First visible page exceeded the 2000 ms checkpoint threshold: $firstVisibleMs ms" }
  Focus-App
  $page1Hash = Capture-Window "cp1-page-1"

  Send-Key 0x4E $false $false "shortcut:n"
  $nextPageHash = Capture-Window "cp1-next-page"
  $inputBurstCount = Send-InputBurst
  Send-Key 0x47 $false $true "shortcut:G"
  $lastPageHash = Capture-Window "cp1-last-page"
  Send-Key 0x47 $false $false "shortcut:g"
  Send-Key 0x47 $false $false "shortcut:g"
  $firstPageHash = Capture-Window "cp1-first-page"
  Send-Key 0xBF $false $true "shortcut:?"
  $helpHash = Capture-Window "cp1-help"
  if ($page1Hash -eq $nextPageHash) { throw "Next-page shortcut did not produce a different rendered surface" }
  if ($nextPageHash -eq $lastPageHash) { throw "Last-page shortcut did not produce a different rendered surface" }
  if ($page1Hash -ne $firstPageHash) { throw "First-page shortcut did not restore the first rendered surface" }
  if ($firstPageHash -eq $helpHash) { throw "Help shortcut did not produce a different rendered surface" }
  Send-Key 0x1B $false $false "shortcut:Esc"
  if (-not [ModeleafNativeWindow]::CloseWindow($process.MainWindowHandle)) { throw "Could not close Modeleaf" }
  Add-Event "close:WM_CLOSE" "sent"
  if (-not $process.WaitForExit(15000)) { throw "Modeleaf did not close within 15 seconds" }
  Add-Event "exit" "code:$($process.ExitCode)"

  $sourceAfter = Get-Sha256 $pdf
  if ($sourceAfter -ne $sourceBefore) { throw "Source PDF hash changed" }
  $receipt = [ordered]@{
    schemaVersion = 1
    kind = "native-desktop-automation-transcript"
    fixtureSha256 = $sourceBefore
    sourceHashUnchanged = $true
    firstVisibleMs = $firstVisibleMs
    inputBurstCount = $inputBurstCount
    processExitCode = $process.ExitCode
    events = $events
  }
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence "cp1-automation.json") -Encoding utf8
  if ($process.ExitCode -ne 0) { throw "Modeleaf exited with code $($process.ExitCode)" }
} catch {
  Add-Event "failure" $_.Exception.Message
  if ($null -ne $process -and -not $process.HasExited -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
    try { Capture-Window "cp1-failure" } catch { }
  }
  [ordered]@{
    schemaVersion = 1
    kind = "native-desktop-automation-transcript"
    fixtureSha256 = $sourceBefore
    status = "failed"
    events = $events
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence "cp1-automation-failed.json") -Encoding utf8
  throw
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
  Remove-Item -LiteralPath $dialogPdf -Force -ErrorAction SilentlyContinue
}
