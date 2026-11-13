Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WE {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
[WE]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 1000
Write-Host "fg=$([WE]::GetForegroundWindow()) h=$h"
# 点手机号框（比例：x 686/1749, y 338/1034）
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT2 { public int L, T, R, B; }
public class WF {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT2 r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
'@
$r = New-Object RECT2
[WF]::GetWindowRect($h, [ref]$r) | Out-Null
$x = [int]($r.L + ($r.R - $r.L) * (686/1749)) + 2
$y = [int]($r.T + ($r.B - $r.T) * (338/1034)) + 2
[WF]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 250
[WF]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[WF]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 800
# 用 SendKeys 一位位打
[System.Windows.Forms.SendKeys]::SendWait('18502722591')
Start-Sleep -Milliseconds 600
Write-Host 'phone done'
