[CmdletBinding(DefaultParameterSetName='DryRun')]
param(
 [string]$ExePath,
 [string]$SourceArtifactPath,
 [string]$EvidenceDirectory,
 [string]$SourceArtifactSha256,
 [Parameter(ParameterSetName='Run')][switch]$Run,
 [Parameter(ParameterSetName='Run')][ValidateRange(1,10000)][int]$LifecycleCycles=20,
 [Parameter(ParameterSetName='Run')][ValidateRange(1,30)][int]$SoakMinutes=0,
 [Parameter(ParameterSetName='Run')][switch]$ExerciseCtrlQ,
 [Parameter(ParameterSetName='Run')][ValidateRange(1000,120000)][int]$LaunchTimeoutMs=15000,
 [Parameter(ParameterSetName='Run')][ValidateRange(64,4096)][int]$MaxWorkingSetMiB=512,
 [Parameter(ParameterSetName='Run')][ValidateRange(1,1024)][int]$MaxSoakGrowthMiB=64,
 [Parameter(ParameterSetName='Run')][ValidateRange(1000,86400000)][long]$MaxCpuMilliseconds=7200000,
 [Parameter(ParameterSetName='Run')][ValidateRange(1000,120000)][int]$ExitTimeoutMs=10000,
 [Parameter(ParameterSetName='UiHelper')][switch]$UiCtrlQHelper,
 [Parameter(ParameterSetName='UiHelper')][long]$UiWindowHandle,
 [Parameter(ParameterSetName='UiHelper')][string]$UiOutput,
 [Parameter(ParameterSetName='Fault')][switch]$FaultHelperHang
)

# The default parameter set is deliberately non-launching.  -Run is required before
# any product process can be created; -ExerciseCtrlQ is the one visible desktop leg.
if($FaultHelperHang) { while($true) { Start-Sleep -Seconds 60 } }
if($UiCtrlQHelper) {
 Set-StrictMode -Version Latest; $ErrorActionPreference='Stop'
 $stage='validate'
 $nodes=@()
 try {
  if($UiWindowHandle -le 0 -or [string]::IsNullOrWhiteSpace($UiOutput)){ throw 'Invalid UI helper arguments' }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  $stage='from-handle'; $window=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($UiWindowHandle))
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Threading; public static class ModeleafCp5Keys { [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); public static void CtrlQ(IntPtr h) { SetForegroundWindow(h); keybd_event(0x11,0,0,UIntPtr.Zero); keybd_event(0x51,0,0,UIntPtr.Zero); Thread.Sleep(20); keybd_event(0x51,0,2,UIntPtr.Zero); keybd_event(0x11,0,2,UIntPtr.Zero); } }'
  if($null -eq $window -or $window.Current.IsOffscreen){ throw 'Target window is unavailable or hidden' }
  $stage='focus';$automationShell=New-Object -ComObject WScript.Shell;if(-not $automationShell.AppActivate('Modeleaf')){throw 'Target window could not be activated'};Start-Sleep -Milliseconds 150
  $stage='reacquire';$window=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($UiWindowHandle));if($null -eq $window){throw 'Target window could not be reacquired after activation'}
  $treeClock=[Diagnostics.Stopwatch]::StartNew();$themeIndex=-1;$tabsIndex=-1;$nodes=@()
  do {
   $stage='uia-tree';$elements=$window.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
   $stage='uia-tree-size';if($elements.Count -gt 512){throw 'UIA tree exceeds bounded node limit'}
   $nodes=@();$uiaElements=@();for($index=0;$index -lt $elements.Count;$index++){try{$element=$elements.Item($index);$name=[string]$element.Current.Name;$liveSetting='';try{$liveSetting=[string]$element.Current.LiveSetting}catch{};$nodes+=[ordered]@{name=$name;automationId=[string]$element.Current.AutomationId;controlType=[string]$element.Current.ControlType.ProgrammaticName;enabled=[bool]$element.Current.IsEnabled;offscreen=[bool]$element.Current.IsOffscreen;hasKeyboardFocus=[bool]$element.Current.HasKeyboardFocus;isKeyboardFocusable=[bool]$element.Current.IsKeyboardFocusable;liveSetting=$liveSetting};$uiaElements+=$element}catch{}}
   $themeIndex=[array]::FindIndex([object[]]$nodes,[Predicate[object]]{param($node) $node.name -eq 'Theme'})
   $tabsIndex=[array]::FindIndex([object[]]$nodes,[Predicate[object]]{param($node) $node.name -eq 'Open documents'})
   if($themeIndex -ge 0 -and $tabsIndex -ge 0){break};Start-Sleep -Milliseconds 100
  } while($treeClock.ElapsedMilliseconds -lt 8000)
  $stage='required-chrome';if($themeIndex -lt 0 -or $tabsIndex -lt 0){throw 'UIA tree is missing required named chrome'}
  $stage='root-name';$rootName=[string]$window.Current.Name;if($rootName -ne 'Modeleaf'){throw 'UIA application name mismatch'}
  $stage='path-redaction';if(@($nodes|Where-Object{$_.name -match '(?:[A-Za-z]:(?:\\|/)|\\\\|file:/+)'}).Count -ne 0){throw 'UIA tree disclosed a filesystem path'}
  $stage='chrome-order';if($themeIndex -ge $tabsIndex){throw 'UIA chrome order is not deterministic'}
  $stage='focus-target';$uiaElements[$themeIndex].SetFocus();Start-Sleep -Milliseconds 100
  $stage='ctrl-q'; [ModeleafCp5Keys]::CtrlQ([IntPtr]::new($UiWindowHandle))
  [IO.File]::WriteAllText($UiOutput,([ordered]@{ok=$true;stage='ctrl-q-sent';rootName=$rootName;nodeCount=$nodes.Count;nodes=$nodes}|ConvertTo-Json -Depth 5 -Compress),[Text.UTF8Encoding]::new($false))
  exit 0
 } catch {
  try { $safeNames=@($nodes|ForEach-Object{if($_.name -match '(?:[A-Za-z]:(?:\\|/)|\\\\|file:/+)'){'[redacted-path]'}else{([string]$_.name).Substring(0,[Math]::Min(80,([string]$_.name).Length))}}|Where-Object{$_}|Select-Object -Unique -First 50); [IO.File]::WriteAllText($UiOutput,([ordered]@{ok=$false;stage=$stage;nodeCount=@($nodes).Count;sampleNames=$safeNames}|ConvertTo-Json -Depth 3 -Compress),[Text.UTF8Encoding]::new($false)) } catch {}
  exit 1
 }
}
$scriptPath=Join-Path $PSScriptRoot 'smoke-cp5.ps1'
if(-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)){ throw 'Smoke script path is unavailable' }
$powershellHost=(Get-Process -Id $PID -ErrorAction Stop).Path
if(-not (Test-Path -LiteralPath $powershellHost -PathType Leaf)){ throw 'PowerShell helper host is unavailable' }
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class ModeleafCp5Job {
 const uint CREATE_SUSPENDED=0x4, CREATE_NO_WINDOW=0x08000000, STARTF_USESHOWWINDOW=0x1, SW_HIDE=0;
 const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000;
 const int JobObjectBasicAccountingInformation=1, JobObjectExtendedLimitInformation=9, JobObjectBasicProcessIdList=3;
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved,lpDesktop,lpTitle; public int dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public short wShowWindow,cbReserved2; public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess,hThread; public int dwProcessId,dwThreadId; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public IntPtr Affinity; public uint PriorityClass,SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING { public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime; public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,int l);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr p,int l,out int r);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint c);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint c);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string a,StringBuilder c,IntPtr pa,IntPtr ta,bool ih,uint f,IntPtr e,string d,ref STARTUPINFO s,out PROCESS_INFORMATION p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr h);
 public static IntPtr Create() { IntPtr j=CreateJobObject(IntPtr.Zero,null); if(j==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error()); EXTENDED_LIMIT x=new EXTENDED_LIMIT(); x.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMIT))); try { Marshal.StructureToPtr(x,p,false); if(!SetInformationJobObject(j,JobObjectExtendedLimitInformation,p,Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) { int e=Marshal.GetLastWin32Error(); CloseHandle(j); throw new Win32Exception(e); } return j; } finally { Marshal.FreeHGlobal(p); } }
 public static Process Start(IntPtr j,string exe,string args,bool show) { STARTUPINFO s=new STARTUPINFO(); s.cb=Marshal.SizeOf(typeof(STARTUPINFO)); s.dwFlags=(int)STARTF_USESHOWWINDOW; s.wShowWindow=(short)(show?1:SW_HIDE); PROCESS_INFORMATION p; StringBuilder cmd=new StringBuilder("\""+exe+"\" "+args); if(!CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,false,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,System.IO.Path.GetDirectoryName(exe),ref s,out p)) throw new Win32Exception(Marshal.GetLastWin32Error()); try { if(!AssignProcessToJobObject(j,p.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error()); if(ResumeThread(p.hThread)==UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error()); return Process.GetProcessById(p.dwProcessId); } catch { TerminateProcess(p.hProcess,1); throw; } finally { CloseHandle(p.hThread); CloseHandle(p.hProcess); } }
 public static int Active(IntPtr j) { BASIC_ACCOUNTING a=new BASIC_ACCOUNTING(); int n; IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BASIC_ACCOUNTING))); try { if(!QueryInformationJobObject(j,JobObjectBasicAccountingInformation,p,Marshal.SizeOf(typeof(BASIC_ACCOUNTING)),out n)) throw new Win32Exception(Marshal.GetLastWin32Error()); a=(BASIC_ACCOUNTING)Marshal.PtrToStructure(p,typeof(BASIC_ACCOUNTING)); return checked((int)a.ActiveProcesses); } finally { Marshal.FreeHGlobal(p); } }
 public static int[] ProcessIds(IntPtr j) { int capacity=8+(64*IntPtr.Size),needed; IntPtr p=Marshal.AllocHGlobal(capacity); try { if(!QueryInformationJobObject(j,JobObjectBasicProcessIdList,p,capacity,out needed)) throw new Win32Exception(Marshal.GetLastWin32Error()); int count=Marshal.ReadInt32(p,4); if(count<0||count>64) throw new InvalidOperationException("Owned job process list exceeded its bound"); int[] ids=new int[count]; int offset=8; for(int i=0;i<count;i++) ids[i]=checked((int)Marshal.ReadIntPtr(p,offset+i*IntPtr.Size).ToInt64()); return ids; } finally { Marshal.FreeHGlobal(p); } }
 public static void Terminate(IntPtr j) { if(!TerminateJobObject(j,1)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 public static void Close(IntPtr j) { if(j!=IntPtr.Zero&&!CloseHandle(j)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
}
'@

function Get-Sha256([string]$Path) { $s=[IO.File]::OpenRead($Path);$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose();$s.Dispose()} }
function Wait-Until([scriptblock]$Predicate,[int]$Timeout,[string]$Failure) { $w=[Diagnostics.Stopwatch]::StartNew();do{if(& $Predicate){return};Start-Sleep -Milliseconds 100}while($w.ElapsedMilliseconds -lt $Timeout);throw $Failure }
function Write-AtomicJson([string]$Path,[object]$Data) { $tmp="$Path.$([guid]::NewGuid().ToString('N')).tmp";try{[IO.File]::WriteAllText($tmp,($Data|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false));if([IO.File]::Exists($Path)){throw "Atomic evidence target already exists: $Path"};[IO.File]::Move($tmp,$Path)}finally{if([IO.File]::Exists($tmp)){[IO.File]::Delete($tmp)}} }
function Get-JobSample([IntPtr]$Job) {
 $ids=@([ModeleafCp5Job]::ProcessIds($Job));$working=0L;$cpu=0.0
 foreach($id in $ids){try{$p=Get-Process -Id $id -ErrorAction Stop;$working+=$p.WorkingSet64;$cpu+=$p.TotalProcessorTime.TotalMilliseconds}catch{}}
 [ordered]@{monotonicMs=$clock.ElapsedMilliseconds;jobActiveProcessCount=[ModeleafCp5Job]::Active($Job);jobProcessIds=$ids;workingSetBytes=$working;cpuMilliseconds=[math]::Round($cpu,3)}
}
function Assert-ResourceSample([object]$Sample) {
 if([long]$Sample.workingSetBytes -gt ($MaxWorkingSetMiB*1MB)){throw 'Owned working set exceeded the configured bound'}
 if([long]$Sample.cpuMilliseconds -gt $MaxCpuMilliseconds){throw 'Owned CPU time exceeded the configured bound'}
 if([int]$Sample.jobActiveProcessCount -gt 8){throw 'Owned process count exceeded the configured bound'}
}
function Assert-NoHostNetwork([int]$RootProcessId) {
 $tcp=@(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $RootProcessId -and $_.State -ne 'Listen' -and $_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::') })
 $udp=@(Get-NetUDPEndpoint -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $RootProcessId -and $_.LocalAddress -notin @('127.0.0.1','::1') })
 if($tcp.Count -ne 0 -or $udp.Count -ne 0){throw "Native host network transport detected for process $RootProcessId"}
}
function Start-Owned([bool]$Visible) {
 $job=[ModeleafCp5Job]::Create();[void]$jobs.Add($job)
 $p=[ModeleafCp5Job]::Start($job,$exe,'',$Visible);$p.Refresh();$identity=[pscustomobject]@{processId=$p.Id;creationTimeUtcTicks=$p.StartTime.ToUniversalTime().Ticks;job=$job};[void]$roots.Add($identity);$identity
}
function Test-RootExited([object]$Root) { $p=Get-Process -Id $Root.processId -ErrorAction SilentlyContinue;if($null -eq $p){return $true};try{$p.StartTime.ToUniversalTime().Ticks -ne $Root.creationTimeUtcTicks}catch{$true} }
function Close-Owned([object]$Root,[bool]$UseCtrlQ) {
 $p=Get-Process -Id $Root.processId -ErrorAction Stop;$uiaResult=$null
 if($UseCtrlQ) {
  $handle=$p.MainWindowHandle;if($handle -eq [IntPtr]::Zero){throw 'Visible desktop validation has no main window'}
  $out=Join-Path $probeDirectory 'ctrl-q.json';$helperJob=[ModeleafCp5Job]::Create();[void]$jobs.Add($helperJob)
  $helper=[ModeleafCp5Job]::Start($helperJob,$powershellHost,"-NoProfile -File `"$scriptPath`" -UiCtrlQHelper -UiWindowHandle $($handle.ToInt64()) -UiOutput `"$out`"",$false)
  if(-not $helper.WaitForExit($ExitTimeoutMs)){throw 'Ctrl+Q UIA helper timeout'}
  if(-not [IO.File]::Exists($out)){throw 'Ctrl+Q UIA helper produced no result'}
  $uiaResult=[IO.File]::ReadAllText($out)|ConvertFrom-Json
  if(-not [bool]$uiaResult.ok){throw "Ctrl+Q UIA helper failed at stage $([string]$uiaResult.stage)"}
 } else {
  Wait-Until { $p.Refresh(); $p.MainWindowHandle -ne [IntPtr]::Zero } $LaunchTimeoutMs 'Hidden lifecycle root did not publish a main window'
  Start-Sleep -Milliseconds 1000
  if(-not $p.CloseMainWindow()){throw 'Hidden lifecycle root rejected close request'}
 }
 Wait-Until {([ModeleafCp5Job]::Active($Root.job) -eq 0) -and (Test-RootExited $Root)} $ExitTimeoutMs 'Owned job or root survived bounded clean close'
 return $uiaResult
}
if($SourceArtifactSha256 -notmatch '^[0-9a-fA-F]{64}$'){throw 'SourceArtifactSha256 must be exactly 64 hexadecimal characters'}
$exe=(Resolve-Path -LiteralPath $ExePath -ErrorAction Stop).Path
if(-not (Test-Path -LiteralPath $exe -PathType Leaf) -or [IO.Path]::GetExtension($exe) -ine '.exe'){throw 'ExePath must be a caller-supplied EXE file'}
$sourceArtifact=(Resolve-Path -LiteralPath $SourceArtifactPath -ErrorAction Stop).Path
$actualSourceHash=Get-Sha256 $sourceArtifact
if($actualSourceHash -ne $SourceArtifactSha256.ToLowerInvariant()){throw 'Source artifact hash does not match SourceArtifactSha256'}
$sourceHash=$actualSourceHash;$exeHash=Get-Sha256 $exe;$scriptHash=Get-Sha256 $scriptPath
New-Item -ItemType Directory -Force -Path $EvidenceDirectory|Out-Null;$evidence=(Resolve-Path -LiteralPath $EvidenceDirectory).Path
$terminal=Join-Path $evidence 'cp5-native-evidence.json';$progress=Join-Path $evidence 'cp5-native-progress.json'
if([IO.File]::Exists($terminal) -or [IO.File]::Exists($progress)){throw 'Stale CP5 evidence exists; refusing to overwrite proof'}
$runId=[guid]::NewGuid().ToString('N');$clock=[Diagnostics.Stopwatch]::StartNew();$events=[Collections.Generic.List[object]]::new();$jobs=[Collections.Generic.List[IntPtr]]::new();$roots=[Collections.Generic.List[object]]::new();$probeDirectory=Join-Path $evidence '.cp5-uia'
$success=$false;$failure=$null;$cleanupProof=$false
function Write-Progress { Write-AtomicJson $progress ([ordered]@{schemaVersion=1;kind='cp5-native-windows-progress';status='in-progress';runId=$runId;sourceArtifactSha256=$sourceHash;exeSha256=$exeHash;smokeScriptSha256=$scriptHash;events=$events}) }
try {
 Write-Progress
 if(-not $Run) {
  # Fault injection proves bounded helper ownership without creating a product process.
  $faultJob=[ModeleafCp5Job]::Create();[void]$jobs.Add($faultJob);$fault=[ModeleafCp5Job]::Start($faultJob,$powershellHost,"-NoProfile -File `"$scriptPath`" -FaultHelperHang",$false)
  if($fault.WaitForExit(100)){throw 'DryRun fault helper unexpectedly exited'};[ModeleafCp5Job]::Terminate($faultJob);Wait-Until { [ModeleafCp5Job]::Active($faultJob) -eq 0 } 1000 'DryRun fault helper survived owned-job cleanup'
  [void]$events.Add([ordered]@{action='dry-run';outcome='validated-owned-helper-timeout-cleanup; no-product-process-started';sample=(Get-JobSample $faultJob)})
 } else {
  for($cycle=1;$cycle -le $LifecycleCycles;$cycle++) {
   $root=Start-Owned $false;Wait-Until { [ModeleafCp5Job]::Active($root.job) -gt 0 } $LaunchTimeoutMs 'Owned root did not remain alive after launch';Assert-NoHostNetwork $root.processId;$sample=Get-JobSample $root.job;Assert-ResourceSample $sample;[void]$events.Add([ordered]@{action="lifecycle:$($cycle):started";outcome='hidden-owned-root-resource-bounded';sample=$sample})
   Close-Owned $root $false;[void]$events.Add([ordered]@{action="lifecycle:$($cycle):closed";outcome='exact-owned-job-members-exited';sample=(Get-JobSample $root.job)})
  }
  if($SoakMinutes -gt 0) {
   $root=Start-Owned $false
   $until=$clock.ElapsedMilliseconds+($SoakMinutes*60000)
   $soakWarmupUntil=$clock.ElapsedMilliseconds+[math]::Min(60000,[math]::Floor(($SoakMinutes*60000)/2))
   $soakBaseline=$null;$soakPeak=0L
   while($clock.ElapsedMilliseconds -lt $until){
    Assert-NoHostNetwork $root.processId;$sample=Get-JobSample $root.job;Assert-ResourceSample $sample
    if($clock.ElapsedMilliseconds -ge $soakWarmupUntil){
     if($null -eq $soakBaseline){$soakBaseline=[long]$sample.workingSetBytes}
     $soakPeak=[math]::Max($soakPeak,[long]$sample.workingSetBytes)
     if(($soakPeak-$soakBaseline) -gt ($MaxSoakGrowthMiB*1MB)){throw 'Soak working-set growth exceeded the configured post-warmup bound'}
    }
    $outcome=if($clock.ElapsedMilliseconds -lt $soakWarmupUntil){'native-host-offline-and-owned-resources-warming'}else{'native-host-offline-and-owned-resources-bounded'}
    [void]$events.Add([ordered]@{action='soak-sample';outcome=$outcome;sample=$sample});Start-Sleep -Seconds 10
   }
   Close-Owned $root $false
  }
  if($ExerciseCtrlQ) {
   [void][IO.Directory]::CreateDirectory($probeDirectory);$root=Start-Owned $true
   Wait-Until {(Get-Process -Id $root.processId -ErrorAction SilentlyContinue).MainWindowHandle -ne [IntPtr]::Zero} $LaunchTimeoutMs 'Visible desktop validation window did not appear'
   Start-Sleep -Milliseconds 1000
   Assert-NoHostNetwork $root.processId;$visibleSample=Get-JobSample $root.job;Assert-ResourceSample $visibleSample
   $uia=Close-Owned $root $true
   [void]$events.Add([ordered]@{action='desktop-ctrl-q';outcome='bounded-uia-tree-ctrl-q-and-clean-exit';uia=$uia;sample=$visibleSample})
  }
 }
 $success=$true
} catch { $failure=$_.Exception.Message;[void]$events.Add([ordered]@{action='failure';outcome='invariant-failed';detail=$failure}) }
finally {
 try { foreach($job in $jobs){if([ModeleafCp5Job]::Active($job) -ne 0){[ModeleafCp5Job]::Terminate($job);Wait-Until {[ModeleafCp5Job]::Active($job) -eq 0} $ExitTimeoutMs 'Owned job members survived forced cleanup'}};foreach($root in $roots){if(-not(Test-RootExited $root)){throw 'Owned root survived job cleanup'}};$cleanupProof=$true } catch {$success=$false;if($null -eq $failure){$failure=$_.Exception.Message}}
 foreach($job in $jobs){try{[ModeleafCp5Job]::Close($job)}catch{$success=$false;$cleanupProof=$false;if($null -eq $failure){$failure=$_.Exception.Message}}}
 try {if([IO.Directory]::Exists($probeDirectory)){[IO.Directory]::Delete($probeDirectory,$true)};if([IO.Directory]::Exists($probeDirectory)){throw 'UIA helper directory survived cleanup'}}catch{$success=$false;$cleanupProof=$false;if($null -eq $failure){$failure=$_.Exception.Message}}
 try { if([IO.File]::Exists($progress)){[IO.File]::Delete($progress)};if([IO.File]::Exists($progress)){throw 'Progress evidence survived terminalization'} } catch {$success=$false;$cleanupProof=$false;if($null -eq $failure){$failure=$_.Exception.Message}}
 $status=if($success -and $cleanupProof){'passed'}else{'failed'}
 Write-AtomicJson $terminal ([ordered]@{
  schemaVersion=1;kind='cp5-native-windows-evidence';status=$status;runId=$runId;dryRun=(-not $Run)
  sourceArtifactSha256=$sourceHash;retainedExe=[ordered]@{path=$exe;sha256=$exeHash};smokeScriptSha256=$scriptHash
  parameters=[ordered]@{lifecycleCycles=$LifecycleCycles;soakMinutes=$SoakMinutes;exerciseCtrlQ=[bool]$ExerciseCtrlQ;maxWorkingSetMiB=$MaxWorkingSetMiB;maxSoakGrowthMiB=$MaxSoakGrowthMiB;maxCpuMilliseconds=$MaxCpuMilliseconds}
  invariants=[ordered]@{network='no-native-host-network-transport-observed';resources='configured-working-set-cpu-process-and-soak-growth-bounds-enforced';ownedRootsExited=$cleanupProof;ownedHelpersExited=$cleanupProof;ownedJobMembersExited=$cleanupProof;progressRemoved=(-not [IO.File]::Exists($progress))}
  events=$events;failure=$failure
 })
}
if(-not $success){exit 1}
exit 0
