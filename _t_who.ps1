Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WD {
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder s, int n);
}
'@
# 找 6348 进程的所有顶层窗口
$procs = Get-Process -Id 6348
Write-Host "6348: $($procs.ProcessName) main=$($procs.MainWindowHandle) title=$($procs.MainWindowTitle)"
$wr = New-Object IntPtr
# 渲染窗口的祖先
$anc = [WD]::GetAncestor([IntPtr]6751864, 2)
$sb = New-Object System.Text.StringBuilder 256
[WD]::GetWindowText($anc, $sb, 256) | Out-Null
Write-Host "ancestor of render: $anc title=$($sb.ToString())"
# 6348 的顶层窗口句柄
Get-Process -Id 6348 | ForEach-Object { Write-Host "6348 MainWindowHandle: $($_.MainWindowHandle)" }
