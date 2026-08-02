[CmdletBinding()]
param(
 [string]$ExePath,
 [string]$KoreanFixturePath,
 [string]$EvidenceDirectory,
 [string]$SourceArtifactSha256,
 [switch]$DryRun,
 [switch]$UiProbe,
 [long]$UiProbeWindow,
 [string]$UiProbeFixtureNameSha256,
 [string]$UiProbeOutput,
 [switch]$UiProbeHangForTest
)
if($UiProbeHangForTest){ while($true){Start-Sleep -Seconds 60} }
if($UiProbe){
 $uiProbeStage="from-handle"
 try {
  if($UiProbeWindow -le 0){throw "UiProbeWindow must be positive"};if($UiProbeFixtureNameSha256 -notmatch "^[0-9a-f]{64}$"){throw "UiProbe fixture hash is invalid"}
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $uiProbeHandle=[IntPtr]::new($UiProbeWindow);$window=[System.Windows.Automation.AutomationElement]::FromHandle($uiProbeHandle)
  $uiProbeStage="find-tabs";$tabs=@($window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)))
  $uiProbeStage="find-pages";$renderedPages=@($window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Image))|Where-Object{[string]$_.Current.Name -match "^PDF page [1-9][0-9]*$"})
  $uiProbeStage="read-selection";$selected=@($tabs|Where-Object{try{([System.Windows.Automation.SelectionItemPattern]$_.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Current.IsSelected}catch{$false}})
  $uiProbeStage="read-status";$status=$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,"status"))
  $uiProbeStage="write-output";[IO.File]::WriteAllText($UiProbeOutput,([ordered]@{ok=$true;visible=(-not $window.Current.IsOffscreen);tabCount=$tabs.Count;renderedPdfPageCount=$renderedPages.Count;statusHasCommittedPage=if($null -eq $status){$false}else{([string]$status.Current.Name -match "^Page 1 of [1-9][0-9]* · ")};selectedSemanticTabCount=$selected.Count;selectedFixture=@($selected|Where-Object{$bytes=[Text.Encoding]::UTF8.GetBytes(([string]$_.Current.Name).Normalize([Text.NormalizationForm]::FormC));$sha=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-","").ToLowerInvariant()) -eq $UiProbeFixtureNameSha256}finally{$sha.Dispose()}}).Count -gt 0;statusIsLocalCopyRejection=if($null -eq $status){$false}else{([string]$status.Current.Name -eq "Network PDFs are not supported. Copy the PDF to a local drive and open the local copy.")}}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  return
 } catch {
  try {if(-not [string]::IsNullOrWhiteSpace($UiProbeOutput)){[IO.File]::WriteAllText($UiProbeOutput,([ordered]@{ok=$false;failureStage=$uiProbeStage}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}} catch {}
  exit 1
 }
}
$scriptPath=Join-Path $PSScriptRoot "smoke-cp4.ps1"
if(-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)){throw "Smoke script path is unavailable"}
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class ModeleafCp4Native {
 [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
 [DllImport("user32.dll", SetLastError=true)] public static extern bool IsWindowVisible(IntPtr hWnd);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalLock(IntPtr memory);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GlobalUnlock(IntPtr memory);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GlobalFree(IntPtr memory);
 public static void PostDrop(IntPtr window, string path) {
  if (window == IntPtr.Zero) throw new ArgumentException("Window handle is required");
  byte[] text = Encoding.Unicode.GetBytes(path + "\0\0");
  const int header = 20, GMEM_MOVEABLE = 0x0002;
  IntPtr memory = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)(header + text.Length));
  if (memory == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
  try {
   IntPtr locked = GlobalLock(memory);
   if (locked == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
   try { Marshal.WriteInt32(locked, 0, header); Marshal.WriteInt32(locked, 4, 0); Marshal.WriteInt32(locked, 8, 0); Marshal.WriteInt32(locked, 12, 0); Marshal.WriteInt32(locked, 16, 1); Marshal.Copy(text, 0, IntPtr.Add(locked, header), text.Length); }
   finally { GlobalUnlock(memory); }
   if (!PostMessage(window, 0x0233, memory, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "WM_DROPFILES post failed");
   memory = IntPtr.Zero; // The receiver owns HDROP after a successful post.
  } finally { if (memory != IntPtr.Zero) GlobalFree(memory); }
 }
}
public static class ModeleafCp4Job {
 const uint CREATE_SUSPENDED = 0x00000004, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
 const int JobObjectBasicAccountingInformation = 1, JobObjectExtendedLimitInformation = 9;
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public IntPtr Affinity; public uint PriorityClass, SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, out int returnedLength);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 public static IntPtr CreateKillOnClose() {
  IntPtr job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
  EXTENDED_LIMIT limits = new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  IntPtr data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(EXTENDED_LIMIT)));
  try { Marshal.StructureToPtr(limits, data, false); if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, data, Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) { int error=Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error); } }
  finally { Marshal.FreeHGlobal(data); }
  return job;
 }
 public static int ActiveProcessCount(IntPtr job) { BASIC_ACCOUNTING accounting = new BASIC_ACCOUNTING(); int ignored; IntPtr data=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BASIC_ACCOUNTING))); try { if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, data, Marshal.SizeOf(typeof(BASIC_ACCOUNTING)), out ignored)) throw new Win32Exception(Marshal.GetLastWin32Error()); accounting=(BASIC_ACCOUNTING)Marshal.PtrToStructure(data, typeof(BASIC_ACCOUNTING)); return checked((int)accounting.ActiveProcesses); } finally { Marshal.FreeHGlobal(data); } }
 public static Process StartSuspendedAssigned(IntPtr job, string executable, string argument) {
  STARTUPINFO startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(typeof(STARTUPINFO)); PROCESS_INFORMATION created; StringBuilder command = new StringBuilder("\"" + executable + "\" " + argument);
  if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED, IntPtr.Zero, System.IO.Path.GetDirectoryName(executable), ref startup, out created)) throw new Win32Exception(Marshal.GetLastWin32Error());
  try { if (!AssignProcessToJobObject(job, created.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error()); if (ResumeThread(created.hThread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error()); return Process.GetProcessById(created.dwProcessId); }
  catch { TerminateProcess(created.hProcess, 1); throw; }
  finally { CloseHandle(created.hThread); CloseHandle(created.hProcess); }
 }
 public static void Terminate(IntPtr job) { if (!TerminateJobObject(job, 1)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 public static void Close(IntPtr job) { if (job != IntPtr.Zero && !CloseHandle(job)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
}
"@
if($null -eq ("ModeleafCp4Native" -as [type])){throw "ModeleafCp4Native type was not defined"}
$LaunchTimeoutMs = 15000; $ExitTimeoutMs = 10000; $CleanCloseCycles = 20
$RemoteRejectionStatus = "Network PDFs are not supported. Copy the PDF to a local drive and open the local copy."
function Get-Sha256([string]$Path) { $stream=[IO.File]::OpenRead($Path); $algorithm=[Security.Cryptography.SHA256]::Create(); try { [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() } finally { $algorithm.Dispose(); $stream.Dispose() } }
function Get-StringSha256([string]$Value) { $bytes=[Text.Encoding]::UTF8.GetBytes($Value.Normalize([Text.NormalizationForm]::FormC));$algorithm=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($algorithm.ComputeHash($bytes)).Replace("-","").ToLowerInvariant()}finally{$algorithm.Dispose()} }
function Get-SafeDisplayName([string]$Path) { $name=[IO.Path]::GetFileName($Path); if([string]::IsNullOrWhiteSpace($name)){throw "Display name is empty"}; $safe=[regex]::Replace($name,"[\x00-\x1F\x7F]","_"); if($safe.Length -gt 120){$safe=$safe.Substring(0,120)}; $safe }
$script:monotonicClock=[Diagnostics.Stopwatch]::StartNew()
$script:ownedRoots=[Collections.Generic.List[object]]::new()
$script:secondaryRoots=[Collections.Generic.List[object]]::new()
$script:jobs=[Collections.Generic.List[IntPtr]]::new()
function Get-ProcessCim([int]$Id) { Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId={0}" -f $Id) -ErrorAction SilentlyContinue }
function New-ProcessIdentity([Diagnostics.Process]$Process) { $Process.Refresh(); $startTicks=$Process.StartTime.ToUniversalTime().Ticks; $cim=Get-ProcessCim $Process.Id; if($null -eq $cim -or [string]::IsNullOrWhiteSpace($cim.ExecutablePath)){throw "Started process identity is unavailable"}; [pscustomobject]@{process=$Process;processId=[int]$Process.Id;creationTimeUtcTicks=$startTicks;executablePath=[string]$cim.ExecutablePath;ownership="job-root"} }
function Test-ProcessIdentity([object]$Identity) { $live=Get-Process -Id $Identity.processId -ErrorAction SilentlyContinue; if($null -eq $live){return $false}; try{$live.Refresh();if($live.StartTime.ToUniversalTime().Ticks -ne $Identity.creationTimeUtcTicks){return $false}}catch{return $false}; $cim=Get-ProcessCim $Identity.processId; $null -ne $cim -and -not [string]::IsNullOrWhiteSpace([string]$cim.ExecutablePath) -and [string]::Equals([string]$cim.ExecutablePath,[string]$Identity.executablePath,[StringComparison]::OrdinalIgnoreCase) }
function Get-LiveProcess([object]$Identity) { if(-not(Test-ProcessIdentity $Identity)){return $null}; try{$Identity.process.Refresh();if($Identity.process.HasExited){return $null};$Identity.process}catch{return $null} }
function Get-JobActiveProcessCount([IntPtr]$Job) { [ModeleafCp4Job]::ActiveProcessCount($Job) }
$script:uiaWorkerStuck=$false
$script:uiaProbeOutcome="no-window"
$script:uiaProbeSnapshot=$null
function Wait-For([scriptblock]$Predicate,[int]$TimeoutMs,[string]$Failure) { $clock=[Diagnostics.Stopwatch]::StartNew(); do {if(& $Predicate){return};Start-Sleep -Milliseconds 100} while($clock.ElapsedMilliseconds -lt $TimeoutMs);throw $Failure }
function Wait-ForCleanExit([object]$Root,[string]$Failure,[int]$TimeoutMs=$ExitTimeoutMs) { Wait-For { (Get-JobActiveProcessCount $Root.job) -eq 0 -and -not(Test-ProcessIdentity $Root) } $TimeoutMs $Failure }
function Quote-WindowsArgument([string]$Argument) { if($Argument.Length -eq 0){return '""'};$builder=[Text.StringBuilder]::new();[void]$builder.Append('"');$slashes=0;foreach($character in $Argument.ToCharArray()){if($character -eq '\'){$slashes++;continue};if($character -eq '"'){[void]$builder.Append(('\'*(($slashes*2)+1)));[void]$builder.Append('"');$slashes=0;continue};if($slashes){[void]$builder.Append(('\'*$slashes));$slashes=0};[void]$builder.Append($character)};if($slashes){[void]$builder.Append(('\'*($slashes*2)))};[void]$builder.Append('"');$builder.ToString() }
if([string]::IsNullOrWhiteSpace($ExePath) -or [string]::IsNullOrWhiteSpace($KoreanFixturePath) -or [string]::IsNullOrWhiteSpace($EvidenceDirectory)){throw "ExePath, KoreanFixturePath, and EvidenceDirectory are required"}
$exe=(Resolve-Path -LiteralPath $ExePath -ErrorAction Stop).Path; $fixture=(Resolve-Path -LiteralPath $KoreanFixturePath -ErrorAction Stop).Path
if(-not(Test-Path -LiteralPath $exe -PathType Leaf)){throw "EXE path is not a file"};if(-not(Test-Path -LiteralPath $fixture -PathType Leaf) -or [IO.Path]::GetExtension($fixture) -ine ".pdf"){throw "Fixture must be a PDF file"}
$exeName=Get-SafeDisplayName $exe;$fixtureName=Get-SafeDisplayName $fixture;$fixtureNameSha256=Get-StringSha256 $fixtureName;if($fixtureName -notmatch "\s" -or $fixtureName -notmatch "[\p{IsHangulSyllables}\p{IsHangulJamo}]"){throw "Korean fixture basename must contain Korean and whitespace"}
if(-not $DryRun){if($SourceArtifactSha256 -notmatch "^[0-9A-Fa-f]{64}$"){throw "SourceArtifactSha256 must be exactly 64 hexadecimal characters"};$SourceArtifactSha256=$SourceArtifactSha256.ToLowerInvariant()}
$exeSha256=Get-Sha256 $exe;$fixtureSha256=Get-Sha256 $fixture;$smokeScriptSha256=Get-Sha256 $scriptPath;$runId=[guid]::NewGuid().ToString("N");$evidence=$null;if(-not $DryRun){New-Item -ItemType Directory -Force -Path $EvidenceDirectory|Out-Null;$evidence=(Resolve-Path -LiteralPath $EvidenceDirectory).Path;foreach($artifact in @("cp4-native-evidence.json","cp4-native-progress.json")){ $path=Join-Path $evidence $artifact;if([IO.File]::Exists($path)){[IO.File]::Delete($path)}}}
$script:probeDirectory=if($DryRun){Join-Path ([IO.Path]::GetTempPath()) "modeleaf-cp4-uia-current"}else{Join-Path $evidence ".cp4-native-uia-current"};if([IO.Directory]::Exists($script:probeDirectory)){[IO.Directory]::Delete($script:probeDirectory,$true)};[void][IO.Directory]::CreateDirectory($script:probeDirectory)
function Start-Modeleaf([string]$Argument,[switch]$Secondary) {
 $job=[ModeleafCp4Job]::CreateKillOnClose();[void]$script:jobs.Add($job)
 $process=[ModeleafCp4Job]::StartSuspendedAssigned($job,$exe,(Quote-WindowsArgument $Argument))
 try {$identity=New-ProcessIdentity $process} catch {
  $process.Refresh()
  if(-not $Secondary -or -not $process.HasExited){throw}
  $identity=[pscustomobject]@{process=$process;processId=[int]$process.Id;creationTimeUtcTicks=0L;executablePath=$exe;ownership="job-secondary-exited"}
 }
 if(-not [string]::Equals($identity.executablePath,$exe,[StringComparison]::OrdinalIgnoreCase)){throw "Started process executable identity does not match the requested EXE"}
 $identity|Add-Member -NotePropertyName job -NotePropertyValue $job
 [void]$script:ownedRoots.Add($identity);if($Secondary){[void]$script:secondaryRoots.Add($identity)}
 $identity
}
function Complete-UiHelperCleanup([IntPtr]$Job,[Diagnostics.Process]$Helper,[string]$Failure,[switch]$InjectTerminateFailure) {
 $cleanupFailure=$null;$injected=$false;$closeFailure=$null
 try {try {if($null -ne $Helper -and -not $Helper.HasExited){if($InjectTerminateFailure){$injected=$true;throw "DryRun injected TerminateJobObject failure"};[ModeleafCp4Job]::Terminate($Job)};Wait-For {(Get-JobActiveProcessCount $Job) -eq 0} 1000 "${Failure}: job members remained"}catch{$cleanupFailure=$_}} finally {try{[ModeleafCp4Job]::Close($Job)}catch{$closeFailure=$_}}
 try {if($null -eq $Helper -or -not $Helper.WaitForExit(1000)){throw "${Failure}: helper survived kill-on-close"}}catch{if($null -eq $closeFailure){$closeFailure=$_}}
 if($null -ne $closeFailure){throw $closeFailure};if($InjectTerminateFailure -and -not $injected){throw "${Failure}: injection was not exercised"};if($null -ne $cleanupFailure -and -not $injected){throw $cleanupFailure}
}
function Set-UiProbeDiagnostic([string]$Outcome,[object]$Snapshot=$null) {
 $script:uiaProbeOutcome=$Outcome
 $script:uiaProbeSnapshot=$Snapshot
}
function Get-UiProbeFailureStage([object]$Dto) {
 $stageProperty=$Dto.PSObject.Properties["failureStage"]
 if($null -eq $stageProperty -or $stageProperty.Value -isnot [string]){throw "snapshot-invalid"}
 $stage=[string]$stageProperty.Value
 if(@("from-handle","find-tabs","find-pages","read-selection","read-status","write-output") -notcontains $stage){throw "snapshot-invalid"}
 $stage
}
function Get-UiSnapshot([object]$Root) {
 $process=Get-LiveProcess $Root
 if($null -eq $process){Set-UiProbeDiagnostic "root-unavailable";throw "Owned root identity was lost before UI observation"}
 $process.Refresh();$handle=$process.MainWindowHandle
 if($handle -eq [IntPtr]::Zero){Set-UiProbeDiagnostic "no-window";return $null}
 $output=Join-Path $script:probeDirectory ("snapshot-{0}.json" -f [guid]::NewGuid().ToString("N"));$helperJob=[ModeleafCp4Job]::CreateKillOnClose();$helper=$null;$cleanupFailure=$null
 try {
  $arguments="-NoProfile -File `"$scriptPath`" -UiProbe -UiProbeWindow $($handle.ToInt64()) -UiProbeFixtureNameSha256 $fixtureNameSha256 -UiProbeOutput `"$output`""
  $helper=[ModeleafCp4Job]::StartSuspendedAssigned($helperJob,(Join-Path $PSHOME "powershell.exe"),$arguments)
  if(-not $helper.WaitForExit(1000)){Set-UiProbeDiagnostic "helper-timeout";throw "uia-snapshot-timeout"}
  if(-not [IO.File]::Exists($output)){Set-UiProbeDiagnostic "missing-output";return $null}
  try {
   $rawSnapshot=[IO.File]::ReadAllText($output)|ConvertFrom-Json;$okProperty=$rawSnapshot.PSObject.Properties["ok"]
   if($null -eq $okProperty -or $okProperty.Value -isnot [bool]){throw "snapshot-invalid"}
   if(-not [bool]$okProperty.Value){$failureStage=Get-UiProbeFailureStage $rawSnapshot;if($helper.ExitCode -eq 0){throw "snapshot-invalid"};Set-UiProbeDiagnostic ("helper-failure-{0}" -f $failureStage);return $null}
   foreach($name in @("visible","tabCount","selectedSemanticTabCount","selectedFixture","renderedPdfPageCount","statusHasCommittedPage","statusIsLocalCopyRejection")){if($null -eq $rawSnapshot.PSObject.Properties[$name]){throw "snapshot-invalid"}}
   if($rawSnapshot.visible -isnot [bool] -or $rawSnapshot.selectedFixture -isnot [bool] -or $rawSnapshot.statusIsLocalCopyRejection -isnot [bool] -or $rawSnapshot.statusHasCommittedPage -isnot [bool] -or ($rawSnapshot.tabCount -isnot [int] -and $rawSnapshot.tabCount -isnot [long]) -or ($rawSnapshot.selectedSemanticTabCount -isnot [int] -and $rawSnapshot.selectedSemanticTabCount -isnot [long]) -or ($rawSnapshot.renderedPdfPageCount -isnot [int] -and $rawSnapshot.renderedPdfPageCount -isnot [long])){throw "snapshot-invalid"}
   $tabCount=[int]$rawSnapshot.tabCount;$selectedTabCount=[int]$rawSnapshot.selectedSemanticTabCount;$renderedPageCount=[int]$rawSnapshot.renderedPdfPageCount
   if($tabCount -lt 0 -or $tabCount -gt 1024 -or $selectedTabCount -lt 0 -or $selectedTabCount -gt $tabCount -or $renderedPageCount -lt 0 -or $renderedPageCount -gt 1024){throw "snapshot-invalid"}
   $snapshot=[pscustomobject]@{visible=[bool]$rawSnapshot.visible;tabCount=$tabCount;selectedSemanticTabCount=$selectedTabCount;selectedFixture=[bool]$rawSnapshot.selectedFixture;renderedPdfPageCount=$renderedPageCount;statusHasCommittedPage=[bool]$rawSnapshot.statusHasCommittedPage;statusIsLocalCopyRejection=[bool]$rawSnapshot.statusIsLocalCopyRejection}
   Set-UiProbeDiagnostic "snapshot-read" $snapshot;$snapshot
  } catch {Set-UiProbeDiagnostic "snapshot-invalid";return $null}
 } finally {
  try {Complete-UiHelperCleanup $helperJob $helper "uia-snapshot-cleanup-failed"}catch{$cleanupFailure=$_}
  try {if([IO.File]::Exists($output)){[IO.File]::Delete($output)}}catch{if($null -eq $cleanupFailure){$cleanupFailure=$_}}
  if($null -ne $cleanupFailure){throw $cleanupFailure}
 }
}
function Wait-ForUi([object]$Root,[scriptblock]$Predicate,[string]$Failure) {
 $snapshot=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
 do {
  $snapshot=Get-UiSnapshot $Root
  if($null -ne $snapshot -and (& $Predicate $snapshot)){return $snapshot}
  Start-Sleep -Milliseconds 100
 } while($clock.ElapsedMilliseconds -lt $LaunchTimeoutMs)
 $script:failureStage="uia-predicate-timeout"
 Add-Evidence "uia-timeout-diagnostic" $script:uiaProbeOutcome $script:uiaProbeSnapshot $Root.job
 throw $Failure
}
$events=[Collections.Generic.List[object]]::new();$success=$false;$failure=$null;$script:failureStage=$null
function Add-Evidence([string]$Action,[string]$Outcome,[object]$Snapshot,[IntPtr]$Job=[IntPtr]::Zero,[string]$FailureStage=$null) {
 [void]$events.Add([ordered]@{
  monotonicMs=$script:monotonicClock.ElapsedMilliseconds
  action=$Action
  outcome=$Outcome
  failureStage=$FailureStage
  jobActiveProcessCount=if($Job -eq [IntPtr]::Zero){$null}else{Get-JobActiveProcessCount $Job}
  ui=if($null -eq $Snapshot){$null}else{[ordered]@{windowVisible=[bool]$Snapshot.visible;semanticTabCount=[int]$Snapshot.tabCount;selectedSemanticTabCount=[int]$Snapshot.selectedSemanticTabCount;selectedFixture=[bool]$Snapshot.selectedFixture;renderedPdfPageCount=[int]$Snapshot.renderedPdfPageCount;statusHasCommittedPage=[bool]$Snapshot.statusHasCommittedPage;statusIsLocalCopyRejection=[bool]$Snapshot.statusIsLocalCopyRejection}}
 })
 if(-not $DryRun -and $null -ne $evidence){Write-ProgressEvidence}
}
function Write-AtomicJson([string]$Target,[object]$Record) {
 $temporary=Join-Path $evidence ((".{0}.{1}.tmp" -f [IO.Path]::GetFileName($Target),[guid]::NewGuid().ToString("N")))
 $backup=Join-Path $evidence ((".{0}.{1}.bak" -f [IO.Path]::GetFileName($Target),[guid]::NewGuid().ToString("N")))
 try {
  $writer=[IO.StreamWriter]::new($temporary,$false,[Text.UTF8Encoding]::new($false))
  try {$writer.Write(($Record|ConvertTo-Json -Depth 8));$writer.Flush();$writer.BaseStream.Flush($true)} finally {$writer.Dispose()}
  if([IO.File]::Exists($Target)){[IO.File]::Replace($temporary,$Target,$backup)}else{[IO.File]::Move($temporary,$Target)}
 } finally {
  if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}
  if([IO.File]::Exists($backup)){[IO.File]::Delete($backup)}
 }
}
function Write-Evidence([object]$Record) { Write-AtomicJson (Join-Path $evidence "cp4-native-evidence.json") $Record }
function Write-ProgressEvidence { Write-AtomicJson (Join-Path $evidence "cp4-native-progress.json") ([ordered]@{schemaVersion=5;kind="cp4-native-windows-progress";status="in-progress";runId=$runId;sourceArtifactSha256=$SourceArtifactSha256;smokeScriptSha256=$smokeScriptSha256;retainedExeSha256=$exeSha256;events=$events}) }
try {
 if(@(Get-CimInstance -ClassName Win32_Process|Where-Object{$null -ne $_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$exe,[StringComparison]::OrdinalIgnoreCase)}).Count -ne 0){throw "Retained EXE is already running; refusing to interfere with an existing instance"}
 if($DryRun){
  $dryRunJob=[ModeleafCp4Job]::CreateKillOnClose();[void]$script:jobs.Add($dryRunJob)
  if((Get-JobActiveProcessCount $dryRunJob) -ne 0){throw "Fresh per-launch job object unexpectedly contains active processes"}
  foreach($injectTerminateFailure in @($false,$true)){
   $faultJob=[ModeleafCp4Job]::CreateKillOnClose()
   $fault=$null
   try {
    $fault=[ModeleafCp4Job]::StartSuspendedAssigned($faultJob,(Join-Path $PSHOME "powershell.exe"),"-NoProfile -File `"$scriptPath`" -UiProbeHangForTest")
    if($fault.WaitForExit(100)){throw "DryRun UIA fault helper unexpectedly exited"}
   } finally {
    Complete-UiHelperCleanup $faultJob $fault "DryRun UIA fault helper cleanup failed" -InjectTerminateFailure:$injectTerminateFailure
   }
  }
  Add-Evidence "dry-run-job-object-setup" "validated-per-launch-kill-on-close-job-and-timeout-cleanup-including-injected-terminate-failure; no-product-process-started" $null $dryRunJob
  $success=$true
}  else { for($cycle=1;$cycle -le $CleanCloseCycles;$cycle++) { $root=Start-Modeleaf $fixture;$initial=Wait-ForUi $root {param($ui)$ui.visible -and $ui.selectedSemanticTabCount -eq 1 -and $ui.tabCount -eq 1} "Korean argv did not render as one selected semantic tab";Add-Evidence ("cold-korean-space-argv:{0}" -f $cycle) "visible-selected-korean-semantic-tab" $initial $root.job;if($cycle -eq 1){Start-Sleep -Milliseconds 3000;$running=Start-Modeleaf $fixture -Secondary;Wait-ForCleanExit $running "Running direct argv secondary job did not cleanly exit within the bounded timeout";Add-Evidence "running-second-instance-clean-exit" "exact-secondary-job-members-exited" $null $running.job;$afterRunning=Wait-ForUi $root {param($ui)$ui.visible -and $ui.selectedSemanticTabCount -eq 1 -and $ui.tabCount -eq 1} "Running same-path argv changed selected semantic tab cardinality";Add-Evidence "running-second-instance-direct-argv" "same-path-route-kept-one-selected-semantic-tab" $afterRunning $root.job;$manual=Start-Modeleaf $fixture -Secondary;Wait-ForCleanExit $manual "Direct argv secondary job did not cleanly exit within the bounded timeout";Add-Evidence "direct-argv-clean-exit" "exact-secondary-job-members-exited" $null $manual.job;$afterManual=Wait-ForUi $root {param($ui)$ui.visible -and $ui.selectedSemanticTabCount -eq 1 -and $ui.tabCount -eq 1} "Direct same-path argv changed selected semantic tab cardinality";Add-Evidence "direct-argv-not-shell-open-with" "same-path-route-kept-one-selected-semantic-tab" $afterManual $root.job;$remote=Start-Modeleaf "\\example.invalid\modeleaf-cp4\rejected.pdf" -Secondary;Wait-ForCleanExit $remote "Remote argv secondary job did not cleanly exit within the bounded timeout";Add-Evidence "remote-route-clean-exit" "exact-secondary-job-members-exited" $null $remote.job;$afterRemote=Wait-ForUi $root {param($ui)$ui.visible -and $ui.selectedSemanticTabCount -eq 1 -and $ui.tabCount -eq 1} "Remote argv changed selected semantic tab cardinality";Add-Evidence "remote-route-rejection-argument-unc" "no-semantic-tab-added-for-rejected-remote-route" $afterRemote $root.job;$liveRoot=Get-LiveProcess $root;if($null -eq $liveRoot){throw "Owned root identity was lost before drop"};$liveRoot.Refresh();[ModeleafCp4Native]::PostDrop($liveRoot.MainWindowHandle,$fixture);$afterDrop=Wait-ForUi $root {param($ui)$ui.visible -and $ui.selectedSemanticTabCount -eq 1 -and $ui.tabCount -eq 1} "Native same-path WM_DROPFILES changed selected semantic tab cardinality";Add-Evidence "native-wm-dropfiles" "same-path-route-kept-one-selected-semantic-tab" $afterDrop $root.job};$main=Get-LiveProcess $root;if($null -eq $main){throw "Owned root identity was lost before close"};$main.Refresh();if($main.MainWindowHandle -eq [IntPtr]::Zero -or -not [ModeleafCp4Native]::PostMessage($main.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw "Could not post native close message"};Wait-ForCleanExit $root "Clean close exact job members did not exit within the bounded timeout";Add-Evidence ("clean-close:{0}" -f $cycle) "exact-job-members-exited" $null $root.job };$success=$true }
} catch {
 $failure="invariant-failed"
 if($null -eq $script:failureStage){$script:failureStage="invariant"}
 Add-Evidence "failure" $failure $null ([IntPtr]::Zero) $script:failureStage
}
finally {
 $activeJobMembersBeforeForcedCleanup=$null;$activeJobMembersBeforeForcedCleanupQueryFailed=$false
 $activeJobMembersAfterTermination=$null;$activeJobMembersAfterTerminationQueryFailed=$false
 $cleanupComplete=$true;$jobMembersExited=$false;$allJobHandlesClosed=$true;$rootExitProofCount=$null;$rootExitProofQueryFailed=$false;$rootExitProofComplete=$false
 try {
  try {$activeJobMembersBeforeForcedCleanup=0;foreach($job in $script:jobs){$activeJobMembersBeforeForcedCleanup+=[int](Get-JobActiveProcessCount $job)}}catch{$activeJobMembersBeforeForcedCleanup=$null;$activeJobMembersBeforeForcedCleanupQueryFailed=$true;$cleanupComplete=$false;$success=$false;$failure="cleanup-invariant-failed"}
  foreach($job in $script:jobs){
   try {
    if((Get-JobActiveProcessCount $job) -ne 0){
     $success=$false;if($null -eq $failure){$failure="clean-exit-invariant-failed"}
     Add-Evidence "forced-cleanup" "forced-exact-job-termination-after-clean-exit-failure" $null $job
     [ModeleafCp4Job]::Terminate($job)
     Wait-For {(Get-JobActiveProcessCount $job) -eq 0} $ExitTimeoutMs "Job members remained after forced cleanup"
    }
   } catch {$cleanupComplete=$false;$success=$false;$failure="cleanup-invariant-failed"}
  }
  try {$activeJobMembersAfterTermination=0;foreach($job in $script:jobs){$activeJobMembersAfterTermination+=[int](Get-JobActiveProcessCount $job)}}catch{$activeJobMembersAfterTermination=$null;$activeJobMembersAfterTerminationQueryFailed=$true}
  $jobMembersExited=($null -ne $activeJobMembersAfterTermination -and $activeJobMembersAfterTermination -eq 0)
  if(-not $jobMembersExited){$cleanupComplete=$false;$success=$false;$failure="cleanup-invariant-failed"}
  try {Wait-For {@($script:ownedRoots|Where-Object{Test-ProcessIdentity $_}).Count -eq 0} $ExitTimeoutMs "Tracked roots remained after job termination"}catch{$cleanupComplete=$false;$success=$false;$failure="cleanup-invariant-failed"}
  try {$rootExitProofCount=[int]@($script:ownedRoots|Where-Object{-not(Test-ProcessIdentity $_)}).Count;$rootExitProofComplete=($rootExitProofCount -eq $script:ownedRoots.Count)}catch{$rootExitProofCount=$null;$rootExitProofQueryFailed=$true;$rootExitProofComplete=$false}
  if(-not $rootExitProofComplete){$cleanupComplete=$false;$success=$false;$failure="cleanup-invariant-failed"}
 } finally {
  foreach($job in $script:jobs){try{[ModeleafCp4Job]::Close($job)}catch{$allJobHandlesClosed=$false;$cleanupComplete=$false;$success=$false;$failure="cleanup-invariant-failed"}}
 }
 $cleanupProof=$jobMembersExited -and $rootExitProofComplete -and $allJobHandlesClosed
 if($cleanupComplete){
  try {
   if([IO.Directory]::Exists($script:probeDirectory)){[IO.Directory]::Delete($script:probeDirectory,$true)}
   if([IO.Directory]::Exists($script:probeDirectory)){throw "UI probe directory survived cleanup"}
  } catch {$cleanupComplete=$false;$success=$false;$failure="cleanup-invariant-failed"}
 }
 if(-not $DryRun){
  Write-Evidence ([ordered]@{schemaVersion=5;kind="cp4-native-windows-evidence";status=if($success -and $cleanupComplete -and $cleanupProof){"passed"}else{"failed"};dryRun=$false;runId=$runId;sourceArtifactSha256=$SourceArtifactSha256;smokeScriptSha256=$smokeScriptSha256;retainedExe=[ordered]@{displayName=$exeName;sha256=$exeSha256};fixture=[ordered]@{displayName=$fixtureName;sha256=$fixtureSha256};invariants=[ordered]@{registryOrAssociationMutation="not-performed";rendererAccess="not-performed";directArgvLeg="not-an-actual-Windows-shell-Open-With";cleanCloseCyclesRequired=$CleanCloseCycles;cleanCloseCyclesCompleted=@($events|Where-Object{$_.action -like "clean-close:*" -and $_.outcome -eq "exact-job-members-exited"}).Count;secondaryRootsTracked=$script:secondaryRoots.Count;perLaunchJobsTracked=$script:jobs.Count;activeJobMembersBeforeForcedCleanup=$activeJobMembersBeforeForcedCleanup;activeJobMembersBeforeForcedCleanupQueryFailed=$activeJobMembersBeforeForcedCleanupQueryFailed;activeJobMembersAfterTermination=$activeJobMembersAfterTermination;activeJobMembersAfterTerminationQueryFailed=$activeJobMembersAfterTerminationQueryFailed;cleanupResult=if($cleanupProof){"proven"}else{"failed"};jobHandleCloseSucceeded=$allJobHandlesClosed;rootExitProofCount=$rootExitProofCount;rootExitProofQueryFailed=$rootExitProofQueryFailed;rootExitProofComplete=$rootExitProofComplete};events=$events})
  $progress=Join-Path $evidence "cp4-native-progress.json"
  if([IO.File]::Exists($progress)){[IO.File]::Delete($progress)}
 }
}
if(-not $success){exit 1};exit 0
