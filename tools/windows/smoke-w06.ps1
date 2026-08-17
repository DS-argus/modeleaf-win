[CmdletBinding(DefaultParameterSetName='DryRun')]
param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$PdfPath,
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
  [Parameter(ParameterSetName='Run')][switch]$Run,
  [Parameter(ParameterSetName='Run')][ValidateRange(1000,60000)][int]$LaunchTimeoutMs=20000,
  [Parameter(ParameterSetName='Run')][ValidateRange(1000,60000)][int]$ActionTimeoutMs=8000,
  [Parameter(ParameterSetName='Run')][ValidateRange(1000,60000)][int]$ExitTimeoutMs=15000,
  [Parameter(ParameterSetName='Run')][ValidateRange(64,4096)][int]$MaxWorkingSetMiB=768,
  [Parameter(ParameterSetName='Run')][ValidateRange(1000,86400000)][long]$MaxCpuMilliseconds=7200000
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class W06Native {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public IntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,int l);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateJobObject(IntPtr j,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h,uint m,IntPtr w,string l);
 public static IntPtr CreateKillOnCloseJob() { IntPtr j=CreateJobObject(IntPtr.Zero,null); if(j==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error()); var x=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); x.BasicLimitInformation.LimitFlags=0x2000; IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(x)); try { Marshal.StructureToPtr(x,p,false); if(!SetInformationJobObject(j,9,p,Marshal.SizeOf(x))) throw new Win32Exception(Marshal.GetLastWin32Error()); return j; } catch { CloseHandle(j); throw; } finally { Marshal.FreeHGlobal(p); } }
 public static void Key(IntPtr h,int key,bool ctrl,bool shift) { SetForegroundWindow(h); if(ctrl) PostMessageW(h,0x100,(IntPtr)0x11,IntPtr.Zero); if(shift) PostMessageW(h,0x100,(IntPtr)0x10,IntPtr.Zero); PostMessageW(h,0x100,(IntPtr)key,IntPtr.Zero); PostMessageW(h,0x101,(IntPtr)key,(IntPtr)0xC0000001); if(shift) PostMessageW(h,0x101,(IntPtr)0x10,(IntPtr)0xC0000001); if(ctrl) PostMessageW(h,0x101,(IntPtr)0x11,(IntPtr)0xC0000001); }
}
'@

function Get-Sha256([string]$Path) { $s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create();try { ([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','').ToLowerInvariant() } finally { $h.Dispose();$s.Dispose() } }
function Wait-Until([scriptblock]$Predicate,[int]$TimeoutMs,[string]$Failure) { $watch=[Diagnostics.Stopwatch]::StartNew();do { if(& $Predicate) { return }; Start-Sleep -Milliseconds 100 } while($watch.ElapsedMilliseconds -lt $TimeoutMs);throw $Failure }
function Write-AtomicTerminal([string]$Path,[object]$Record) { $temporary="$Path.$([guid]::NewGuid().ToString('N')).tmp";try { [IO.File]::WriteAllText($temporary,($Record|ConvertTo-Json -Depth 10 -Compress),[Text.UTF8Encoding]::new($false));if([IO.File]::Exists($Path)){throw 'Terminal evidence already exists'};[IO.File]::Move($temporary,$Path) } finally { if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)} } }
function Add-Event([string]$Action,[string]$Outcome,[object]$Sample=$null) { $event=[ordered]@{action=$Action;outcome=$Outcome;monotonicMs=$clock.ElapsedMilliseconds};if($null -ne $Sample){$event.sample=$Sample};[void]$events.Add($event) }
function Get-Sample { $process.Refresh();[ordered]@{ownedRoot=$true;workingSetBytes=[long]$process.WorkingSet64;cpuMilliseconds=[math]::Round($process.TotalProcessorTime.TotalMilliseconds,3)} }
function Assert-Resources([object]$Sample) { if([long]$Sample.workingSetBytes -gt ($MaxWorkingSetMiB*1MB)){throw 'Owned working set exceeded bound'};if([double]$Sample.cpuMilliseconds -gt $MaxCpuMilliseconds){throw 'Owned CPU exceeded bound'} }
function Assert-FixtureUnchanged([string]$Action) { $after=Get-Sha256 $pdf;if($after -ne $fixtureHash){throw "Fixture SHA-256 changed after $Action"};Add-Event "fixture:$Action" 'sha256-unchanged' }
function Capture-VisualHash([string]$State) { $process.Refresh();$rect=New-Object W06Native+RECT;if($process.MainWindowHandle -eq [IntPtr]::Zero -or -not [W06Native]::GetWindowRect($process.MainWindowHandle,[ref]$rect)){throw 'Reader window is unavailable'};$width=$rect.Right-$rect.Left;$height=$rect.Bottom-$rect.Top;if($width -lt 320 -or $height -lt 240){throw 'Reader bounds are invalid'};$bitmap=New-Object Drawing.Bitmap $width,$height;$graphics=[Drawing.Graphics]::FromImage($bitmap);try{$graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size);$bytes=[Collections.Generic.List[byte]]::new();$colors=[Collections.Generic.HashSet[int]]::new();for($x=0;$x -lt 32;$x++){for($y=0;$y -lt 32;$y++){$pixel=$bitmap.GetPixel([math]::Floor(($x+.5)*$width/32),[math]::Floor(($y+.5)*$height/32));[void]$colors.Add($pixel.ToArgb());[void]$bytes.Add($pixel.R);[void]$bytes.Add($pixel.G);[void]$bytes.Add($pixel.B)}};if($colors.Count -lt 12){throw 'Reader page is visually blank or uniform'};$h=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($h.ComputeHash($bytes.ToArray()))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};$visualHashes[$State]=$hash;Add-Event "visual:$State" "sha256:$hash;sample-colors:$($colors.Count)";Assert-FixtureUnchanged "visual:$State";return $hash}finally{$graphics.Dispose();$bitmap.Dispose()} }
function Send-ReaderKey([int]$Key,[bool]$Ctrl,[bool]$Shift,[string]$Action) { [W06Native]::Key($process.MainWindowHandle,$Key,$Ctrl,$Shift);Start-Sleep -Milliseconds 350;Add-Event $Action 'sent';Assert-FixtureUnchanged $Action }
function Invoke-PaletteAction([string]$Label,[string]$Action) { Send-ReaderKey 0x50 $true $true 'palette:open';$focus=[System.Windows.Automation.AutomationElement]::FocusedElement;if($null -eq $focus){throw 'Command palette did not focus an accessible element'};$value=$focus.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);if($null -eq $value){throw 'Command palette input has no value pattern'};$value.SetValue($Label);Start-Sleep -Milliseconds 250;[W06Native]::Key($process.MainWindowHandle,0x0D,$false,$false);Start-Sleep -Milliseconds 350;Add-Event $Action 'palette-submitted';Assert-FixtureUnchanged $Action }
function Assert-ReadOnlyUi { $root=[System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle);$nodes=$root.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition);if($nodes.Count -gt 512){throw 'Accessible UI tree exceeded bounded node count'};$forbidden='^(Save|Save As|Export|Download)(?:\b|$)';for($i=0;$i -lt $nodes.Count;$i++){if(([string]$nodes.Item($i).Current.Name) -match $forbidden){throw 'Accessible UI exposes a forbidden read-only capability'}};Add-Event 'read-only:forbidden-capability-check' "passed:nodes:$($nodes.Count)" }

$script=(Resolve-Path -LiteralPath $MyInvocation.MyCommand.Path).Path
$exe=(Resolve-Path -LiteralPath $ExePath -ErrorAction Stop).Path
$pdf=(Resolve-Path -LiteralPath $PdfPath -ErrorAction Stop).Path
if([IO.Path]::GetExtension($exe) -ine '.exe'){throw 'ExePath must name an EXE'}
if(Test-Path -LiteralPath $EvidenceDirectory){throw 'EvidenceDirectory already exists; refusing stale evidence overwrite'}
[void][IO.Directory]::CreateDirectory($EvidenceDirectory);$evidence=(Resolve-Path -LiteralPath $EvidenceDirectory).Path
$terminal=Join-Path $evidence 'w06-packaged-smoke.json'
$fixtureHash=Get-Sha256 $pdf;$exeHash=Get-Sha256 $exe;$scriptHash=Get-Sha256 $script
$clock=[Diagnostics.Stopwatch]::StartNew();$events=[Collections.Generic.List[object]]::new();$visualHashes=[ordered]@{};$process=$null;$job=[IntPtr]::Zero;$success=$false;$failure=$null;$cleanup=$false
try {
  $job=[W06Native]::CreateKillOnCloseJob()
  if(-not $Run) {
    $helper=Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden
    if(-not [W06Native]::AssignProcessToJobObject($job,$helper.Handle)){throw 'Could not assign dry-run helper to owned job'}
    if($helper.WaitForExit(100)){throw 'Dry-run helper unexpectedly exited'}
    [void][W06Native]::TerminateJobObject($job,1);Wait-Until { $helper.HasExited } 1000 'Dry-run owned helper cleanup timed out'
    Add-Event 'dry-run:helper-timeout-cleanup' 'passed:no-product-process-started'
  } else {
    $process=Start-Process -FilePath $exe -PassThru
    if(-not [W06Native]::AssignProcessToJobObject($job,$process.Handle)){throw 'Could not assign product to owned job'}
    Add-Event 'launch:owned-job' 'started'
    Wait-Until { $process.Refresh();$process.MainWindowHandle -ne [IntPtr]::Zero } $LaunchTimeoutMs 'Reader main window launch timeout'
    Send-ReaderKey 0x4F $true $false 'native-open-dialog:open'
    Wait-Until { [System.Windows.Automation.AutomationElement]::FocusedElement -ne $null } $ActionTimeoutMs 'Native Open dialog focus timeout'
    $dialog=[System.Windows.Automation.AutomationElement]::FocusedElement;$value=$dialog.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);if($null -eq $value){throw 'Native Open dialog input is unavailable'};$value.SetValue($pdf);[W06Native]::Key($dialog.Current.NativeWindowHandle,0x0D,$false,$false);Add-Event 'native-open-dialog:fixture-selected' 'submitted-without-retaining-path'
    Wait-Until { try { Capture-VisualHash 'page-visible'|Out-Null;$true } catch {$false} } $ActionTimeoutMs 'Nonblank reader page timeout'
    Assert-FixtureUnchanged 'open';Assert-ReadOnlyUi;$before=Get-Sample;Assert-Resources $before;Add-Event 'resource:before' 'owned-process-resource-bounded' $before
    Send-ReaderKey 0x57 $false $false 'view:fit-width-default';Capture-VisualHash 'fit-width'|Out-Null
    Invoke-PaletteAction 'Actual Size' 'view:actual-size';Capture-VisualHash 'actual-size'|Out-Null
    Send-ReaderKey 0xBB $false $false 'view:zoom-in';Capture-VisualHash 'zoom-in'|Out-Null
    Send-ReaderKey 0xBD $false $false 'view:zoom-out';Capture-VisualHash 'zoom-out'|Out-Null
    Send-ReaderKey 0xDD $false $false 'view:rotate-quarter-turn';Capture-VisualHash 'rotated'|Out-Null
    Send-ReaderKey 0x4E $false $false 'page:navigate-next';Send-ReaderKey 0x44 $false $false 'scroll:viewport-down';Capture-VisualHash 'navigation-scroll'|Out-Null
    for($i=0;$i -lt 20;$i++){Send-ReaderKey $(if(($i%2)-eq 0){0x4E}else{0x50}) $false $false 'navigation:bounded-repeat'}
    $after=Get-Sample;Assert-Resources $after;Add-Event 'resource:after' 'owned-process-resource-bounded' $after;Assert-ReadOnlyUi
    if(-not $process.CloseMainWindow()){throw 'Reader rejected clean close'};Wait-Until { $process.HasExited } $ExitTimeoutMs 'Reader clean close timeout';Add-Event 'close:clean' "exit-code:$($process.ExitCode)";if($process.ExitCode -ne 0){throw 'Reader exited unsuccessfully'}
  }
  Assert-FixtureUnchanged 'terminal';$success=$true
} catch { $failure=$_.Exception.Message;Add-Event 'failure' 'invariant-failed' }
finally {
  try { if($job -ne [IntPtr]::Zero){[void][W06Native]::TerminateJobObject($job,1)};if($null -ne $process -and -not $process.HasExited){Wait-Until {$process.HasExited} $ExitTimeoutMs 'Owned product survived cleanup'};$cleanup=$true } catch { $success=$false;$failure=if($null -eq $failure){$_.Exception.Message}else{$failure} }
  if($job -ne [IntPtr]::Zero){try{[void][W06Native]::CloseHandle($job)}catch{$success=$false;$cleanup=$false}}
  $status=if($success -and $cleanup){'passed'}else{'failed'};$safeFailure=if($null -eq $failure){$null}else{'invariant-failed'}
  Write-AtomicTerminal $terminal ([ordered]@{schemaVersion=1;kind='w06-packaged-windows-smoke';status=$status;dryRun=(-not $Run);bindings=[ordered]@{exeSha256=$exeHash;scriptSha256=$scriptHash;fixtureSha256Before=$fixtureHash;fixtureSha256After=(Get-Sha256 $pdf)};limits=[ordered]@{launchTimeoutMs=$LaunchTimeoutMs;actionTimeoutMs=$ActionTimeoutMs;exitTimeoutMs=$ExitTimeoutMs;maxWorkingSetMiB=$MaxWorkingSetMiB;maxCpuMilliseconds=$MaxCpuMilliseconds};visualHashes=$visualHashes;events=$events;cleanupGuaranteed=$cleanup;failure=$safeFailure})
}
if(-not $success -or -not $cleanup){if($null -eq $failure){throw 'W06 packaged smoke failed'};throw $failure}
