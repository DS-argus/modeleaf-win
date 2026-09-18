[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][int]$ProcessId,
    [Parameter(Mandatory=$true)][ValidateSet('n','p','d','u')][string]$Key,
    [ValidateSet('burst','held')][string]$Mode = 'held',
    [ValidateRange(2,100)][int]$Count = 30,
    [ValidateRange(0,100)][int]$IntervalMs = 15
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$process = Get-Process -Id $ProcessId
$expected = Join-Path $root '.internal\preview-target\debug\modeleaf.exe'
if ($process.Path -ne $expected) { throw 'Input target is not this worktree preview candidate.' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class ReaderRepeatInput {
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    public static void Send(IntPtr window, byte key, bool held, int count, int interval) {
        ShowWindow(window, 9);
        BringWindowToTop(window);
        uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        uint ownThread = GetCurrentThreadId();
        bool attached = foregroundThread != ownThread && AttachThreadInput(ownThread, foregroundThread, true);
        try { SetForegroundWindow(window); }
        finally { if (attached) AttachThreadInput(ownThread, foregroundThread, false); }
        Thread.Sleep(200);
        if (GetForegroundWindow() != window) throw new InvalidOperationException("Preview did not acquire foreground ownership: target="+window+" foreground="+GetForegroundWindow()+".");
        try {
            for (int i = 0; i < count; i++) {
                if (GetForegroundWindow() != window) throw new InvalidOperationException("Preview lost foreground ownership.");
                keybd_event(key, 0, 0, UIntPtr.Zero);
                if (!held) { Thread.Sleep(1); keybd_event(key, 0, 2, UIntPtr.Zero); }
                Thread.Sleep(interval);
            }
        } finally { keybd_event(key, 0, 2, UIntPtr.Zero); }
    }
}
'@
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($ProcessId)) { throw 'Preview activation was rejected.' }
Start-Sleep -Milliseconds 200
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$nodes = $window.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)
$reader = @($nodes | Where-Object { $_.Current.IsKeyboardFocusable -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Pane -and $_.Current.Name -match ', tab [0-9]+ of [0-9]+$' })
if ($reader.Count -ne 1) { throw 'Expected one focusable native PDF reader pane.' }
$reader[0].SetFocus()
[ReaderRepeatInput]::Send($process.MainWindowHandle, [byte][char]$Key.ToUpperInvariant(), ($Mode -eq 'held'), $Count, $IntervalMs)
