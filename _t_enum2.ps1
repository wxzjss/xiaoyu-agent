Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WC {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
# 找出所有属于 31456 进程的顶层窗口（含所有者窗口）
$ids = @{}
$cb = [WC+EnumProc]{ param($h, $l)
  $sb = New-Object System.Text.StringBuilder 256
  [WC]::GetClassName($h, $sb, 256) | Out-Null
  $tb = New-Object System.Text.StringBuilder 256
  [WC]::GetWindowText($h, $tb, 256) | Out-Null
  $pid = 0
  [WC]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
  $vis = [WC]::IsWindowVisible($h)
  Write-Host "h=$h pid=$pid vis=$vis cls=$($sb.ToString()) txt=$($tb.ToString())"
  return $true
}
[WC]::EnumChildWindows((Get-Process -Id 31456).MainWindowHandle, $cb, [IntPtr]::Zero) | Out-Null
Write-Host '---- all top windows of pid 31456 ----'
Get-Process | Where-Object { $_.Id -eq 31456 } | ForEach-Object {
  Write-Host "main: $($_.MainWindowHandle) title=$($_.MainWindowTitle)"
}
