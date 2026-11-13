Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class W2 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
$r = New-Object RECT
[W2]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Host "RECT: L=$($r.L) T=$($r.T) W=$($r.R-$r.L) H=$($r.B-$r.T)"

function Click-At($fx, $fy) {
  $x = [int]($r.L + ($r.R - $r.L) * $fx)
  $y = [int]($r.T + ($r.B - $r.T) * $fy)
  [W2]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 300
  [W2]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 200
  [W2]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [W2]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Write-Host "clicked $x,$y"
}
# 手机号框：截图(517,263)/1180x820
Click-At (517/1180) (263/820)
Start-Sleep -Milliseconds 500
# 打手机号
[System.Windows.Forms.SendKeys]::SendWait('18502722591')
