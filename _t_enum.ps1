Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W7 {
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr lp);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
}
'@
$top = [W7]::FindWindow($null, '小鱼Agent')
Write-Host "top=$top"
$cb = {
  param($h, $lp)
  $cls = New-Object System.Text.StringBuilder 256
  [W7]::GetClassName($h, $cls, 256) | Out-Null
  $txt = New-Object System.Text.StringBuilder 256
  [W7]::GetWindowText($h, $txt, 256) | Out-Null
  Write-Host "child: $($h) cls=$($cls.ToString()) txt=$($txt.ToString())"
  return $true
}
[W7]::EnumChildWindows($top, $cb, [IntPtr]::Zero) | Out-Null
Write-Host '---- deepseek windows ----'
0..20 | ForEach-Object {
  $h = [W7]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, $null, "DeepSeek*")
  if ($h -eq [IntPtr]::Zero) { return }
  Write-Host "found deepseek window: $h"
  break
}
