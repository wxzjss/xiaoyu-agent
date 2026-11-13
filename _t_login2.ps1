Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W9 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
$r = New-Object RECT
[W9]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Host "rect R=$($r.R) B=$($r.B)"
function Click-At([double]$fx, [double]$fy) {
  $x = [int]($r.L + ($r.R - $r.L) * $fx)
  $y = [int]($r.T + ($r.B - $r.T) * $fy)
  [W9]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 400
  [W9]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 250
  [W9]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [W9]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Write-Host "clicked $x,$y"
}
Click-At (686/1749) (338/1034)
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait('18502722591')
Write-Host 'phone typed'
