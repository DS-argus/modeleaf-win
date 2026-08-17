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
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class W06Native {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public IntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved,lpDesktop,lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
 [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize,flags; public IntPtr hwndActive,hwndFocus,hwndCapture,hwndMenuOwner,hwndMoveSize,hwndCaret; public RECT rcCaret; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,int l);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateJobObject(IntPtr j,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr process);
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GUITHREADINFO info);
 [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 public static IntPtr CreateKillOnCloseJob() { IntPtr j=CreateJobObject(IntPtr.Zero,null); if(j==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error()); var x=new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); x.BasicLimitInformation.LimitFlags=0x2000; IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(x)); try { Marshal.StructureToPtr(x,p,false); if(!SetInformationJobObject(j,9,p,Marshal.SizeOf(x))) throw new Win32Exception(Marshal.GetLastWin32Error()); return j; } catch { CloseHandle(j); throw; } finally { Marshal.FreeHGlobal(p); } }
 public static Process StartOwned(IntPtr job,string exe,string argument) { var startup=new STARTUPINFO();startup.cb=Marshal.SizeOf(startup);PROCESS_INFORMATION created;var command=new StringBuilder("\""+exe+"\" \""+argument+"\"");if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x4,IntPtr.Zero,Path.GetDirectoryName(exe),ref startup,out created))throw new Win32Exception(Marshal.GetLastWin32Error());try{if(!AssignProcessToJobObject(job,created.hProcess))throw new Win32Exception(Marshal.GetLastWin32Error());if(ResumeThread(created.hThread)==UInt32.MaxValue)throw new Win32Exception(Marshal.GetLastWin32Error());return Process.GetProcessById(created.dwProcessId);}catch{TerminateProcess(created.hProcess,1);throw;}finally{CloseHandle(created.hThread);CloseHandle(created.hProcess);} }
 static IntPtr FocusedWindow(IntPtr topLevel) { uint thread=GetWindowThreadProcessId(topLevel,IntPtr.Zero);var info=new GUITHREADINFO();info.cbSize=Marshal.SizeOf(info);return thread!=0&&GetGUIThreadInfo(thread,ref info)&&info.hwndFocus!=IntPtr.Zero?info.hwndFocus:topLevel; }
 public static void Key(IntPtr h,int key,bool ctrl,bool shift) { ShowWindow(h,9);BringWindowToTop(h);SetForegroundWindow(h);Thread.Sleep(100);FocusedWindow(h);if(ctrl)keybd_event(0x11,0,0,UIntPtr.Zero);if(shift)keybd_event(0x10,0,0,UIntPtr.Zero);keybd_event((byte)key,0,0,UIntPtr.Zero);Thread.Sleep(20);keybd_event((byte)key,0,2,UIntPtr.Zero);if(shift)keybd_event(0x10,0,2,UIntPtr.Zero);if(ctrl)keybd_event(0x11,0,2,UIntPtr.Zero); }
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
function Assert-ReaderAlive([string]$State) { $process.Refresh();if($process.HasExited -or $process.MainWindowHandle -eq [IntPtr]::Zero){throw "Reader exited during $State"};$root=[System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle);if($null -eq $root){throw "Reader accessibility root unavailable during $State"};$nodes=$root.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition);if($nodes.Count -lt 1 -or $nodes.Count -gt 512){throw "Reader accessibility tree invalid during $State"};Add-Event "reader:$State" "alive-accessible:nodes:$($nodes.Count)" }
function Focus-ReaderDocument { $root=[System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle);$nodes=$root.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition);for($i=0;$i -lt $nodes.Count;$i++){$node=$nodes.Item($i);if([bool]$node.Current.IsKeyboardFocusable -and [string]$node.Current.ControlType.ProgrammaticName -ne 'ControlType.Edit'){$node.SetFocus();return}};throw 'Reader keyboard focus target is unavailable' }
function Send-ReaderKey([int]$Key,[bool]$Ctrl,[bool]$Shift,[string]$Action) { if(-not $automationShell.AppActivate($process.Id)){throw "Reader activation failed before $Action"};Start-Sleep -Milliseconds 100;Focus-ReaderDocument;Start-Sleep -Milliseconds 100;[W06Native]::Key($process.MainWindowHandle,$Key,$Ctrl,$Shift);Start-Sleep -Milliseconds 350;Add-Event $Action 'sent';Assert-FixtureUnchanged $Action }
function Assert-ReadOnlyUi { $root=[System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle);$nodes=$root.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition);if($nodes.Count -gt 512){throw 'Accessible UI tree exceeded bounded node count'};$forbidden='^(Save|Save As|Export|Download)(?:\b|$)';for($i=0;$i -lt $nodes.Count;$i++){if(([string]$nodes.Item($i).Current.Name) -match $forbidden){throw 'Accessible UI exposes a forbidden read-only capability'}};Add-Event 'read-only:forbidden-capability-check' "passed:nodes:$($nodes.Count)" }

$script=(Resolve-Path -LiteralPath $MyInvocation.MyCommand.Path).Path
$exe=(Resolve-Path -LiteralPath $ExePath -ErrorAction Stop).Path
$pdf=(Resolve-Path -LiteralPath $PdfPath -ErrorAction Stop).Path
if([IO.Path]::GetExtension($exe) -ine '.exe'){throw 'ExePath must name an EXE'}
if(Test-Path -LiteralPath $EvidenceDirectory){throw 'EvidenceDirectory already exists; refusing stale evidence overwrite'}
[void][IO.Directory]::CreateDirectory($EvidenceDirectory);$evidence=(Resolve-Path -LiteralPath $EvidenceDirectory).Path
$terminal=Join-Path $evidence 'w06-packaged-smoke.json'
$fixtureHash=Get-Sha256 $pdf;$exeHash=Get-Sha256 $exe;$scriptHash=Get-Sha256 $script
$automationShell=New-Object -ComObject WScript.Shell
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
    $process=[W06Native]::StartOwned($job,$exe,$pdf)
    Add-Event 'launch:owned-job' 'started'
    Wait-Until { $process.Refresh();$process.MainWindowHandle -ne [IntPtr]::Zero } $LaunchTimeoutMs 'Reader main window launch timeout'
    Add-Event 'native-open-request:fixture-selected' 'owned-startup-request-without-retaining-path'
    Wait-Until { try { Capture-VisualHash 'page-visible'|Out-Null;$true } catch {$false} } $ActionTimeoutMs 'Nonblank reader page timeout'
    Assert-FixtureUnchanged 'open';Assert-ReadOnlyUi;$before=Get-Sample;Assert-Resources $before;Add-Event 'resource:before' 'owned-process-resource-bounded' $before
    Send-ReaderKey 0x57 $false $false 'view:fit-width-default';Assert-ReaderAlive 'fit-width'
    Send-ReaderKey 0xBB $false $false 'view:zoom-in';Assert-ReaderAlive 'zoom-in'
    Send-ReaderKey 0xBD $false $false 'view:zoom-out';Assert-ReaderAlive 'zoom-out'
    Send-ReaderKey 0xDD $false $false 'view:rotate-quarter-turn';Assert-ReaderAlive 'rotated'
    Send-ReaderKey 0x4E $false $false 'page:navigate-next';Send-ReaderKey 0x44 $false $false 'scroll:viewport-down';Assert-ReaderAlive 'navigation-scroll'
    for($i=0;$i -lt 20;$i++){Send-ReaderKey $(if(($i%2)-eq 0){0x4E}else{0x50}) $false $false 'navigation:bounded-repeat'}
    $after=Get-Sample;Assert-Resources $after;Add-Event 'resource:after' 'owned-process-resource-bounded' $after;Assert-ReadOnlyUi
    if(-not $process.CloseMainWindow()){throw 'Reader rejected clean close'};Wait-Until { $process.HasExited } $ExitTimeoutMs 'Reader clean close timeout';Add-Event 'close:clean' 'bounded-owned-root-exited'
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
