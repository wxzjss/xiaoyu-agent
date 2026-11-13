Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W6 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
$r = New-Object RECT
[W6]::GetWindowRect($h, [ref]$r) | Out-Null
function Click-At([double]$fx, [double]$fy) {
  $x = [int]($r.L + ($r.R - $r.L) * $fx)
  $y = [int]($r.T + ($r.B - $r.T) * $fy)
  [W6]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 300
  [W6]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 200
  [W6]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [W6]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Write-Host "clicked $x,$y"
}
Click-At (517/1180) (263/820)
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait('18502722591')
Start-Sleep -Milliseconds 400
$fg = [W6]::GetForegroundWindow()
Write-Host "fg=$fg h=$h focused=$($fg -eq $h)"
Click-At (517/1180) (341/820)
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait('wxz457457')
Start-Sleep -Milliseconds 300
Write-Host 'done'
