Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W4 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
$r = New-Object RECT
[W4]::GetWindowRect($h, [ref]$r) | Out-Null
$x = [int]($r.L + ($r.R - $r.L) * (517/1180))
$y = [int]($r.T + ($r.B - $r.T) * (341/820))
[W4]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
[W4]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 200
[W4]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
[W4]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait($args[0])
Write-Host "pw typed"
