# Source-contract tests only: the release harness itself is intentionally not launched here.
$scriptUnderTest = Join-Path $PSScriptRoot 'smoke-cp5.ps1'

Describe 'CP5 Windows release smoke source contract' {
 BeforeAll { $source = [IO.File]::ReadAllText($scriptUnderTest) }

 It 'is dry-run by default and requires an explicit Run switch before product launch' {
  $source | Should Match "DefaultParameterSetName='DryRun'"
  $source | Should Match 'if\(-not \$Run\)'
  $source | Should Match 'no-product-process-started'
 }

 It 'requires a caller EXE, hashes the EXE and source artifact, and rejects stale evidence' {
  $source | Should Match '\[string\]\$ExePath'
  $source | Should Match 'Get-Sha256 \$exe'
  $source | Should Match 'SourceArtifactSha256 must be exactly 64 hexadecimal characters'
  $source | Should Match '\[string\]\$SourceArtifactPath'
  $source | Should Match 'Get-Sha256 \$sourceArtifact'
  $source | Should Match 'Source artifact hash does not match SourceArtifactSha256'
  $source | Should Match 'Stale CP5 evidence exists; refusing to overwrite proof'
 }

 It 'uses kill-on-close jobs and only queries members of its owned jobs' {
  $source | Should Match 'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'
  $source | Should Match 'AssignProcessToJobObject'
  $source | Should Match 'TerminateJobObject'
  $source | Should Match '::ProcessIds\(\$Job\)'
  $source | Should Not Match 'Get-CimInstance.+Win32_Process'
 }

 It 'fails on native-host network transport and captures bounded owned-job resources' {
  $source | Should Match 'function Assert-NoHostNetwork'
  $source | Should Match 'Get-NetTCPConnection -ErrorAction Stop'
  $source | Should Match 'Get-NetUDPEndpoint -ErrorAction Stop'
  $source | Should Match 'RootProcessId'
  $source | Should Match 'workingSetBytes'
  $source | Should Match 'cpuMilliseconds'
  $source | Should Match 'Start-Sleep -Seconds 10'
 }

 It 'keeps visible Ctrl+Q validation explicit and bounds its UIA helper' {
  $source | Should Match '\[switch\]\$ExerciseCtrlQ'
  $source | Should Match '\[switch\]\$UiCtrlQHelper'
  $source | Should Match 'Assert-ResourceSample'
  $source | Should Match 'MaxWorkingSetMiB'
  $source | Should Match 'MaxSoakGrowthMiB'
  $source | Should Match 'MaxCpuMilliseconds'
  $source | Should Match 'Soak working-set growth exceeded the configured post-warmup bound'
  $source | Should Match 'soakWarmupUntil'
  $source | Should Match 'native-host-offline-and-owned-resources-warming'
  $source | Should Match 'ModeleafCp5Keys\]::CtrlQ'
  $source | Should Match 'Ctrl\+Q UIA helper timeout'
  $source | Should Match 'Ctrl\+Q UIA helper failed at stage'
  $source | Should Match 'Visible desktop validation window did not appear'
  $source | Should Match "AppActivate\('Modeleaf'\)"
  $source | Should Match 'UIA tree exceeds bounded node limit'
  $source | Should Match 'rootName=\$rootName;nodeCount=\$nodes\.Count;nodes=\$nodes'
  $source | Should Match 'UIA tree disclosed a filesystem path'
 }

 It 'writes in-progress and terminal evidence atomically, then proves cleanup' {
  $source | Should Match "status='in-progress'"
  $source | Should Match 'function Write-AtomicJson'
  $source | Should Match 'cp5-native-evidence.json'
  $source | Should Match 'UIA tree is missing required named chrome'
  $source | Should Match 'UIA chrome order is not deterministic'
  $source | Should Match 'file:/\+'
  $source | Should Match 'automationId='
  $source | Should Match 'liveSetting='
  $source | Should Match 'Progress evidence survived terminalization'
  $source | Should Match 'UIA helper directory survived cleanup'
  $source | Should Match 'ownedJobMembersExited=\$cleanupProof'
 }
}
