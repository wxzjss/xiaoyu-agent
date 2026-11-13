Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W8 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
$r = New-Object RECT
[W8]::GetWindowRect($h, [ref]$r) | Out-Null
function Click-At([double]$fx, [double]$fy) {
  $x = [int]($r.L + ($r.R - $r.L) * $fx)
  $y = [int]($r.T + ($r.B - $r.T) * $fy)
  [W8]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 400
  [W8]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 250
  [W8]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [W8]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Write-Host "clicked $x,$y"
}
Click-At (517/1180) (263/820)
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait('18502722591')
Start-Sleep -Milliseconds 500
Click-At (517/1180) (341/820)
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait('wxz457457')
Start-Sleep -Milliseconds 400
# 点登录按钮
Click-At (517/1180) (546/820)
Start-Sleep -Milliseconds 2500
Write-Host 'login clicked'
