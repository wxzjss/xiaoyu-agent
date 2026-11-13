Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT { public int L, T, R, B; }
public class WB {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  public struct POINT { public int x, y; }
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
$r = New-Object RECT
[WB]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Host "rect L=$($r.L) T=$($r.T) R=$($r.R) B=$($r.B)"
# 点下去那个点的窗口类名
$x = [int]($r.L + ($r.R - $r.L) * (686/1749)) + 2
$y = [int]($r.T + ($r.B - $r.T) * (338/1034)) + 2
$pt = New-Object WB+POINT
$pt.x = $x; $pt.y = $y
$wh = [WB]::WindowFromPoint($pt)
$sb = New-Object System.Text.StringBuilder 256
[WB]::GetClassName($wh, $sb, 256) | Out-Null
Write-Host "window at click: $wh class=$($sb.ToString())"
$anc = [WB]::GetAncestor($wh, 2)
Write-Host "ancestor: $anc expect $h"
