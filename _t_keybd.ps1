Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT3 { public int L, T, R, B; }
public class WG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT3 r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
}
'@
$p = Get-Process -Id 31456
$h = $p.MainWindowHandle
[WG]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 900
$r = New-Object RECT3
[WG]::GetWindowRect($h, [ref]$r) | Out-Null
$x = [int]($r.L + ($r.R - $r.L) * (686/1749)) + 2
$y = [int]($r.T + ($r.B - $r.T) * (338/1034)) + 2
[WG]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 250
[WG]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[WG]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 700

foreach ($ch in '18502722591'.ToCharArray()) {
  $vk = [WG]::VkKeyScan($ch) -band 0xFF
  [WG]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [WG]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
}
Write-Host 'typed via keybd_event'
