#Requires -Version 5.1
<#
.SYNOPSIS
Registers the installed Modeleaf executable as a PDF handler candidate.

.DESCRIPTION
Writes only Modeleaf-owned Windows Capabilities, RegisteredApplications,
ProgID, and .pdf OpenWithProgids values. It never reads or writes UserChoice,
default association values, hashes, or another application's registration.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Register', 'Unregister')]
    [string]$Action,

    [ValidateNotNullOrEmpty()]
    [string]$ExecutablePath = (Join-Path $PSScriptRoot 'modeleaf.exe')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$registeredApplicationsPath = 'HKCU:\Software\RegisteredApplications'
$classesPath = 'HKCU:\Software\Classes'
$applicationName = 'Modeleaf.Pdf'
$capabilitiesPath = 'Software\Classes\Modeleaf.Pdf\Capabilities'
$progId = 'Modeleaf.Pdf'
$progIdPath = Join-Path $classesPath $progId
$commandPath = Join-Path $progIdPath 'shell\open\command'
$openWithProgIdsPath = Join-Path $classesPath '.pdf\OpenWithProgids'

function Resolve-InstalledExecutable {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    if (-not [System.IO.File]::Exists($resolved.Path) -or
        [System.IO.Path]::GetFileName($resolved.Path) -cne 'modeleaf.exe') {
        throw 'ExecutablePath must resolve to an existing modeleaf.exe file.'
    }
    return [System.IO.Path]::GetFullPath($resolved.Path)
}

$executable = Resolve-InstalledExecutable -Path $ExecutablePath
$command = '"{0}" "%1"' -f $executable

if ($Action -eq 'Register') {
    New-Item -Path $registeredApplicationsPath -Force | Out-Null
    New-Item -Path $progIdPath -Force | Out-Null
    New-Item -Path (Join-Path $progIdPath 'Capabilities') -Force | Out-Null
    New-Item -Path (Join-Path $progIdPath 'Capabilities\FileAssociations') -Force | Out-Null
    New-Item -Path (Join-Path $progIdPath 'DefaultIcon') -Force | Out-Null
    New-Item -Path $commandPath -Force | Out-Null
    New-Item -Path $openWithProgIdsPath -Force | Out-Null

    New-ItemProperty -Path $registeredApplicationsPath -Name $applicationName -Value $capabilitiesPath -PropertyType String -Force | Out-Null
    New-ItemProperty -Path (Join-Path $progIdPath 'Capabilities') -Name 'ApplicationName' -Value 'Modeleaf' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path (Join-Path $progIdPath 'Capabilities') -Name 'ApplicationDescription' -Value 'Keyboard-first read-only PDF reader' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path (Join-Path $progIdPath 'Capabilities\FileAssociations') -Name '.pdf' -Value $progId -PropertyType String -Force | Out-Null
    Set-ItemProperty -Path $progIdPath -Name '(default)' -Value 'Modeleaf PDF Document'
    Set-ItemProperty -Path (Join-Path $progIdPath 'DefaultIcon') -Name '(default)' -Value ('"{0}",0' -f $executable)
    Set-ItemProperty -Path $commandPath -Name '(default)' -Value $command
    New-ItemProperty -Path $openWithProgIdsPath -Name $progId -Value '' -PropertyType String -Force | Out-Null
    exit 0
}

$registeredApplication = Get-ItemProperty -Path $registeredApplicationsPath -Name $applicationName -ErrorAction SilentlyContinue
$registeredCapability = $null
if ($null -ne $registeredApplication) {
    $registeredApplicationValue = $registeredApplication.PSObject.Properties[$applicationName]
    if ($null -ne $registeredApplicationValue) { $registeredCapability = $registeredApplicationValue.Value }
}
$currentCommandKey = Get-Item -Path $commandPath -ErrorAction SilentlyContinue
$currentCommand = if ($null -eq $currentCommandKey) { $null } else { $currentCommandKey.GetValue('') }
if ($registeredCapability -eq $capabilitiesPath -and $currentCommand -eq $command) {
    Remove-ItemProperty -Path $registeredApplicationsPath -Name $applicationName -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $openWithProgIdsPath -Name $progId -ErrorAction SilentlyContinue
    Remove-Item -Path $progIdPath -Recurse -Force
}
exit 0
