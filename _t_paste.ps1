Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class WA {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
$r = New-Object RECT
[WA]::GetWindowRect($h, [ref]$r) | Out-Null
function Click-At([double]$fx, [double]$fy) {
  $x = [int]($r.L + ($r.R - $r.L) * $fx)
  $y = [int]($r.T + ($r.B - $r.T) * $fy)
  [WA]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 500
  [WA]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 300
  [WA]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [WA]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 600
}
# 手机号框
Click-At (686/1749) (338/1034)
# 剪贴板粘贴
[System.Windows.Forms.Clipboard]::SetText('18502722591')
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 500
Write-Host 'phone pasted'
