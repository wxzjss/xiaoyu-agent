Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
}
'@
$h = [W]::FindWindow($null, '小鱼Agent')
if ($h -eq [IntPtr]::Zero) { $h = [W]::FindWindow($null, '内置浏览器') }
Write-Host "HWND=$h"
if ($h -ne [IntPtr]::Zero) {
  [W]::ShowWindow($h, 9) | Out-Null
  [W]::SetForegroundWindow($h) | Out-Null
  Write-Host 'fronted'
} else {
  Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { Write-Host "$($_.Id): $($_.MainWindowTitle)" }
}
