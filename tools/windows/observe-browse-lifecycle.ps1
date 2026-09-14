param([Parameter(Mandatory=$true)][uint32]$OwnerProcess)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NestedWindows71 {
  public delegate bool EnumProc(IntPtr h,IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUI { public int cbSize; public uint flags; public IntPtr active,focus,capture,menu,move,caret; public RECT rect; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc,IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT rect);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder name,int size);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool GetGUIThreadInfo(uint tid,ref GUI info);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool PostMessageW(IntPtr h,uint m,IntPtr w,IntPtr l);
}
'@
[Console]::WriteLine('{"ready":true}')
$count=0
while($null -ne ($line=[Console]::ReadLine())) {
  if(++$count -gt 200){break}
  $request=$line | ConvertFrom-Json
  try {
    if($request.op -eq 'snapshot') {
      $rows=[Collections.Generic.List[object]]::new()
      [void][NestedWindows71]::EnumWindows({param($h,$p)
        $owner=[uint32]0
        $tid=[NestedWindows71]::GetWindowThreadProcessId($h,[ref]$owner)
        if($owner -eq $OwnerProcess) {
          $name=New-Object Text.StringBuilder 128
          [void][NestedWindows71]::GetClassName($h,$name,128)
          $rect=New-Object NestedWindows71+RECT
          [void][NestedWindows71]::GetWindowRect($h,[ref]$rect)
          $rows.Add([ordered]@{hwnd=$h.ToInt64();owner=[NestedWindows71]::GetWindow($h,4).ToInt64();tid=$tid;class=$name.ToString();visible=[NestedWindows71]::IsWindowVisible($h);enabled=[NestedWindows71]::IsWindowEnabled($h);width=$rect.right-$rect.left;height=$rect.bottom-$rect.top})
        }
        return $true
      },[IntPtr]::Zero)
      $threads=@(foreach($tid in @($rows | ForEach-Object {$_.tid} | Sort-Object -Unique)) {
        $gui=New-Object NestedWindows71+GUI
        $gui.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($gui)
        $ok=[NestedWindows71]::GetGUIThreadInfo($tid,[ref]$gui)
        $errorCode=if($ok){0}else{[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
        [ordered]@{tid=$tid;success=$ok;error=$errorCode;focus=$gui.focus.ToInt64();focusRoot=[NestedWindows71]::GetAncestor($gui.focus,2).ToInt64();capture=$gui.capture.ToInt64()}
      })
      $result=@{windows=@($rows);threads=$threads}
    } elseif($request.op -eq 'close') {
      $h=[IntPtr][long]$request.hwnd
      $owner=[uint32]0
      [void][NestedWindows71]::GetWindowThreadProcessId($h,[ref]$owner)
      if($owner -ne $OwnerProcess){throw 'Refusing close for a window outside the launched QA process'}
      if(-not [NestedWindows71]::PostMessageW($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Owned WM_CLOSE post failed'}
      $result=@{posted=$true;hwnd=$request.hwnd}
    } elseif($request.op -eq 'exit'){break}
    else {throw 'Unknown observer operation'}
    [Console]::WriteLine((@{id=$request.id;ok=$true;result=$result} | ConvertTo-Json -Depth 8 -Compress))
  } catch {
    [Console]::WriteLine((@{id=$request.id;ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress))
  }
}
