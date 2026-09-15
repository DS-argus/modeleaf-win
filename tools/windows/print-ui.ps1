[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][int]$OwnedProcessId,
  [Parameter(Mandatory=$true)][ValidateSet('Windows','Close','Inspect','CtrlP','SelectPdf','Print','Cancel','SaveReady','Save','Screenshot','Memory')][string]$Action,
  [string]$OutputPath
)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
trap { [Console]::Error.WriteLine($_.ScriptStackTrace); [Console]::Error.WriteLine($_.InvocationInfo.PositionMessage); break }
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PrintProbeNative {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint process);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint command);
 public static bool BelongsToProcess(IntPtr hwnd,uint expected) {
  for(int depth=0;hwnd!=IntPtr.Zero && depth<8;depth++) {
   uint process;GetWindowThreadProcessId(hwnd,out process);
   if(process==expected)return true;
   hwnd=GetWindow(hwnd,4);
  }
  return false;
 }
 public sealed class WindowInfo { public long hwnd,owner;public uint process,thread;public string title,windowClass;public bool visible,enabled; }
 delegate bool EnumProc(IntPtr hwnd,IntPtr context);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr context);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,System.Text.StringBuilder text,int size);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,System.Text.StringBuilder text,int size);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
 public static WindowInfo[] WindowsForProcess(uint expected) {
  var result=new System.Collections.Generic.List<WindowInfo>();
  EnumWindows((hwnd,unused)=>{
   uint process;uint thread=GetWindowThreadProcessId(hwnd,out process);
   if(process==expected||BelongsToProcess(hwnd,expected)) {
    var text=new System.Text.StringBuilder(256);var cls=new System.Text.StringBuilder(128);
    GetWindowText(hwnd,text,256);GetClassName(hwnd,cls,128);
    result.Add(new WindowInfo{hwnd=hwnd.ToInt64(),owner=GetWindow(hwnd,4).ToInt64(),process=process,thread=thread,title=text.ToString(),windowClass=cls.ToString(),visible=IsWindowVisible(hwnd),enabled=IsWindowEnabled(hwnd)});
   }
   return true;
  },IntPtr.Zero);
  return result.ToArray();
 }
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr context);
 [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
 [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr hwnd,int id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] static extern IntPtr SendText(IntPtr hwnd,uint message,IntPtr wparam,System.Text.StringBuilder text);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
 public static IntPtr Dialog(uint process) {
  IntPtr found=IntPtr.Zero;
  foreach(var window in WindowsForProcess(process))if(window.visible&&window.enabled&&window.windowClass=="#32770"){
   if(found!=IntPtr.Zero)throw new InvalidOperationException("More than one owned native dialog");found=new IntPtr(window.hwnd);
  }
  if(found==IntPtr.Zero)throw new InvalidOperationException("Owned native dialog not found");return found;
 }
 public static IntPtr Reader(uint process) {
  IntPtr found=IntPtr.Zero;
  foreach(var window in WindowsForProcess(process))if(window.process==process&&window.visible&&window.windowClass=="Tauri Window") {
   if(found!=IntPtr.Zero)throw new InvalidOperationException("More than one owned reader window");found=new IntPtr(window.hwnd);
  }
  if(found==IntPtr.Zero)throw new InvalidOperationException("Owned reader HWND not found");return found;
 }
 public static void CloseReader(uint process){if(!PostMessage(Reader(process),0x10,IntPtr.Zero,IntPtr.Zero))throw new InvalidOperationException("Owned reader close failed");}
 static string ComboItem(IntPtr combo,int index) {
  int length=SendMessage(combo,0x149,new IntPtr(index),IntPtr.Zero).ToInt32();
  if(length<0||length>512)throw new InvalidOperationException("Invalid printer name length");
  var value=new System.Text.StringBuilder(length+1);SendText(combo,0x148,new IntPtr(index),value);return value.ToString();
 }
 static IntPtr PrinterCombo(IntPtr dialog,out int pdfIndex) {
  IntPtr found=IntPtr.Zero;int selected=-1;int matches=0;
  EnumChildWindows(dialog,(hwnd,unused)=>{
   var cls=new System.Text.StringBuilder(128);GetClassName(hwnd,cls,128);
   if(cls.ToString()=="ComboBox"){
    int count=SendMessage(hwnd,0x146,IntPtr.Zero,IntPtr.Zero).ToInt32();
    if(count>0&&count<=256)for(int index=0;index<count;index++)if(ComboItem(hwnd,index)=="Microsoft Print to PDF"){found=hwnd;selected=index;matches++;}
   }
   return true;
  },IntPtr.Zero);
  if(matches!=1)throw new InvalidOperationException("Microsoft Print to PDF combo not unique");pdfIndex=selected;return found;
 }
 public static void SelectPdf(uint process) {
  IntPtr dialog=Dialog(process);int index;IntPtr combo=PrinterCombo(dialog,out index);
  if(SendMessage(combo,0x147,IntPtr.Zero,IntPtr.Zero).ToInt32()!=index){
   if(SendMessage(combo,0x14e,new IntPtr(index),IntPtr.Zero).ToInt32()!=index)throw new InvalidOperationException("Printer selection failed");
   SendMessage(dialog,0x111,new IntPtr((1<<16)|GetDlgCtrlID(combo)),combo);
  }
  AssertPdf(dialog);
 }
 static void AssertPdf(IntPtr dialog){int expected;IntPtr combo=PrinterCombo(dialog,out expected);int actual=SendMessage(combo,0x147,IntPtr.Zero,IntPtr.Zero).ToInt32();if(actual!=expected||ComboItem(combo,actual)!="Microsoft Print to PDF")throw new InvalidOperationException("Refusing non-PDF printer");}
 public static void PrintPdf(uint process){IntPtr dialog=Dialog(process);AssertPdf(dialog);IntPtr button=GetDlgItem(dialog,1);if(button==IntPtr.Zero||!IsWindowEnabled(button)||!PostMessage(button,0xf5,IntPtr.Zero,IntPtr.Zero))throw new InvalidOperationException("Native Print button unavailable");}
 public static void CancelDialog(uint process){IntPtr dialog=Dialog(process);if(!PostMessage(dialog,0x111,new IntPtr(2),IntPtr.Zero))throw new InvalidOperationException("Native Cancel failed");}
 [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] static extern IntPtr SetText(IntPtr hwnd,uint message,IntPtr wparam,string text);
 public sealed class ControlInfo {public long hwnd,parent;public int id,parentId;public string windowClass;public bool visible,enabled;}
 public static ControlInfo[] Controls(uint process) {
  var result=new System.Collections.Generic.List<ControlInfo>();IntPtr dialog;
  try{dialog=Dialog(process);}catch(InvalidOperationException){return result.ToArray();}
  EnumChildWindows(dialog,(hwnd,unused)=>{var cls=new System.Text.StringBuilder(128);GetClassName(hwnd,cls,128);var parent=GetParent(hwnd);
   result.Add(new ControlInfo{hwnd=hwnd.ToInt64(),parent=parent.ToInt64(),id=GetDlgCtrlID(hwnd),parentId=GetDlgCtrlID(parent),windowClass=cls.ToString(),visible=IsWindowVisible(hwnd),enabled=IsWindowEnabled(hwnd)});return result.Count<1024;
  },IntPtr.Zero);return result.ToArray();
 }
 static IntPtr FileNameEdit(IntPtr dialog) {
  IntPtr found=IntPtr.Zero;int matches=0;
  EnumChildWindows(dialog,(hwnd,unused)=>{
   var cls=new System.Text.StringBuilder(128);GetClassName(hwnd,cls,128);
   if(cls.ToString()=="Edit"&&IsWindowVisible(hwnd)&&IsWindowEnabled(hwnd)){
    int id=GetDlgCtrlID(hwnd);bool filename=false;
    if(id==1001){
     var parentClass=new System.Text.StringBuilder(128);var hostClass=new System.Text.StringBuilder(128);
     GetClassName(GetParent(hwnd),parentClass,128);GetClassName(GetParent(GetParent(hwnd)),hostClass,128);
     filename=parentClass.ToString()=="ComboBox"&&hostClass.ToString()=="FloatNotifySink";
    }
    if(filename){found=hwnd;matches++;}
   }
   return true;
  },IntPtr.Zero);
  return matches==1?found:IntPtr.Zero;
 }
 public static bool SaveReady(uint process){try{return FileNameEdit(Dialog(process))!=IntPtr.Zero;}catch(InvalidOperationException){return false;}}
 public static void SavePdf(uint process,string path){
  IntPtr dialog=Dialog(process),edit=FileNameEdit(dialog);
  if(edit==IntPtr.Zero)throw new InvalidOperationException("Native filename control not identified");
  if(SetText(edit,0xc,IntPtr.Zero,path)==IntPtr.Zero)throw new InvalidOperationException("Native filename write failed");
  var value=new System.Text.StringBuilder(32768);SendText(edit,0xd,new IntPtr(value.Capacity),value);
  if(value.ToString()!=path)throw new InvalidOperationException("Native filename verification failed");
  IntPtr button=GetDlgItem(dialog,1);
  if(button==IntPtr.Zero||!IsWindowEnabled(button)||!PostMessage(button,0xf5,IntPtr.Zero,IntPtr.Zero))throw new InvalidOperationException("Native Save button unavailable");
 }
 public static void FocusOwned(IntPtr hwnd) {
  ShowWindow(hwnd,9);
  uint ignored; uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out ignored);
  uint current=GetCurrentThreadId();
  bool attached=foreground!=0 && foreground!=current && AttachThreadInput(current,foreground,true);
  try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); }
  finally { if(attached) AttachThreadInput(current,foreground,false); }
 }
}
'@
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$process=Get-Process -Id $OwnedProcessId
if(-not $process.Path.StartsWith(($root+[IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($process.Path) -ne 'modeleaf.exe'){throw 'Process is not the print worktree executable'}
$nodes=[Collections.Generic.List[object]]::new()
$windows=@()
if($Action -in @('Inspect','Screenshot')){
$allWindows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
$windows=@($allWindows | Where-Object { $_.Current.ProcessId -eq $OwnedProcessId -or [PrintProbeNative]::BelongsToProcess([IntPtr]([long]$_.Current.NativeWindowHandle),[uint32]$OwnedProcessId) })
foreach($window in $windows){
  $children=$window.FindAll([System.Windows.Automation.TreeScope]::Subtree,[System.Windows.Automation.Condition]::TrueCondition)
  if($children.Count -gt 4096){throw 'Native UI tree exceeds probe bound'}
  foreach($node in $children){$nodes.Add($node)}
}
}
function Pattern($Node,$Id){$value=$null;if($Node.TryGetCurrentPattern($Id,[ref]$value)){return $value};return $null}
function Validate-Output([string]$Extension){
  if([string]::IsNullOrWhiteSpace($OutputPath)){throw 'Output path required'}
  $full=[IO.Path]::GetFullPath($OutputPath)
  $safe=[IO.Path]::GetFullPath((Join-Path $root '.internal/evidence/issue-83/native'))+[IO.Path]::DirectorySeparatorChar
  if(-not $full.StartsWith($safe,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($full) -ine $Extension){throw 'Output must be a new print evidence file in the worktree'}
  if(Test-Path -LiteralPath $full){throw 'Refusing to overwrite evidence'}
  return $full
}
switch($Action){
 'Windows' { [PrintProbeNative]::WindowsForProcess([uint32]$OwnedProcessId) | ConvertTo-Json -Depth 4 -Compress }
 'Close' {
   [PrintProbeNative]::CloseReader([uint32]$OwnedProcessId)
   @{action='Close'}|ConvertTo-Json -Compress
 }
 'Inspect' {
   @($nodes | ForEach-Object {
     $value=Pattern $_ ([System.Windows.Automation.ValuePattern]::Pattern)
     $selected=Pattern $_ ([System.Windows.Automation.SelectionItemPattern]::Pattern)
     $controlType=$_.Current.ControlType
     [ordered]@{name=[string]$_.Current.Name;type=$(if($controlType -is [System.Windows.Automation.ControlType]){$controlType.ProgrammaticName}else{'ControlType.Unavailable'});id=[string]$_.Current.AutomationId;enabled=[bool]$_.Current.IsEnabled;handle=[long]$_.Current.NativeWindowHandle;value=$(if($null -ne $value){[string]$value.Current.Value}else{$null});selected=$(if($null -ne $selected){[bool]$selected.Current.IsSelected}else{$null})}
   }) | ConvertTo-Json -Depth 4 -Compress
 }
 'CtrlP' {
   $process.Refresh();$hwnd=[PrintProbeNative]::Reader([uint32]$OwnedProcessId)
   if($hwnd -eq [IntPtr]::Zero){throw 'Owned reader window is unavailable'}
   $activation=New-Object -ComObject WScript.Shell
   [void]$activation.AppActivate($OwnedProcessId)
   [PrintProbeNative]::FocusOwned($hwnd)
   Start-Sleep -Milliseconds 100
   [uint32]$foregroundProcess=0
   [void][PrintProbeNative]::GetWindowThreadProcessId([PrintProbeNative]::GetForegroundWindow(),[ref]$foregroundProcess)
   if($foregroundProcess -ne $OwnedProcessId){throw 'Foreground owner changed; no keys sent'}
   $sent=[Diagnostics.Stopwatch]::GetTimestamp()
   [PrintProbeNative]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
   try{[PrintProbeNative]::keybd_event(0x50,0,0,[UIntPtr]::Zero);[PrintProbeNative]::keybd_event(0x50,0,2,[UIntPtr]::Zero)}
   finally{[PrintProbeNative]::keybd_event(0x11,0,2,[UIntPtr]::Zero)}
   @{action='CtrlP';stopwatchTicks=$sent;frequency=[Diagnostics.Stopwatch]::Frequency}|ConvertTo-Json -Compress
 }
 'SelectPdf' {
   [PrintProbeNative]::SelectPdf([uint32]$OwnedProcessId)
   @{selected='Microsoft Print to PDF'}|ConvertTo-Json -Compress
 }
 'Print' {
   [PrintProbeNative]::PrintPdf([uint32]$OwnedProcessId)
   @{action='Print';verifiedPrinter='Microsoft Print to PDF'}|ConvertTo-Json -Compress
 }
 'Cancel' {
   [PrintProbeNative]::CancelDialog([uint32]$OwnedProcessId)
   @{action='Cancel'}|ConvertTo-Json -Compress
 }
 'SaveReady' { @{ready=[PrintProbeNative]::SaveReady([uint32]$OwnedProcessId);controls=[PrintProbeNative]::Controls([uint32]$OwnedProcessId)}|ConvertTo-Json -Depth 4 -Compress }
 'Save' {
   $path=Validate-Output '.pdf'
   [PrintProbeNative]::SavePdf([uint32]$OwnedProcessId,$path)
   @{action='Save';output=$path}|ConvertTo-Json -Compress
 }
 'Screenshot' {
   $path=Validate-Output '.png'
   $process.Refresh();$hwnd=[PrintProbeNative]::Reader([uint32]$OwnedProcessId)
   $target=@($windows | Where-Object {[long]$_.Current.NativeWindowHandle -eq $hwnd.ToInt64()})
   if($target.Count -ne 1){throw 'Owned main window not unique'}
   $rect=$target[0].Current.BoundingRectangle
   $bitmap=[Drawing.Bitmap]::new([int]$rect.Width,[int]$rect.Height)
   $graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
   try{if(-not [PrintProbeNative]::PrintWindow($hwnd,$dc,2)){throw 'Owned window capture failed'}}
   finally{$graphics.ReleaseHdc($dc);$graphics.Dispose()}
   try{$bitmap.Save($path,[Drawing.Imaging.ImageFormat]::Png)}finally{$bitmap.Dispose()}
   @{screenshot=$path}|ConvertTo-Json -Compress
 }
 'Memory' {
   $all=@(Get-CimInstance Win32_Process)
   $ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add($OwnedProcessId)
   do{$added=$false;foreach($entry in $all){if($ids.Contains([int]$entry.ParentProcessId) -and $ids.Add([int]$entry.ProcessId)){$added=$true}}}while($added)
   $sample=@(foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($null -ne $p){[pscustomobject][ordered]@{pid=$id;name=$p.ProcessName;workingSetBytes=$p.WorkingSet64;privateBytes=$p.PrivateMemorySize64;peakWorkingSetBytes=$p.PeakWorkingSet64}}})
   @{processes=$sample;workingSetBytes=($sample|Measure-Object -Property workingSetBytes -Sum).Sum;privateBytes=($sample|Measure-Object -Property privateBytes -Sum).Sum}|ConvertTo-Json -Depth 4 -Compress
 }
}
