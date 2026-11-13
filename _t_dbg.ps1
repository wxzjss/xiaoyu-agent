Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W8 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr h);
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
$r = New-Object RECT
[W8]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Host "rect L=$($r.L) T=$($r.T) R=$($r.R) B=$($r.B)"
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
# 手机号框
Click-At (517/1180) (263/820)
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait('18502722591')
Start-Sleep -Milliseconds 500
# 打完后截一下焦点
Write-Host "fg after phone: $([W8]::GetForegroundWindow()) expect $h"
