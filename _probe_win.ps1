Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr h);
  [DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr h, IntPtr imc);
  [DllImport("imm32.dll")] public static extern bool ImmGetOpenStatus(IntPtr imc);
  [DllImport("imm32.dll")] public static extern int ImmGetConversionStatus(IntPtr imc, out int conv, out int sent);
  [DllImport("imm32.dll")] public static extern bool ImmSetOpenStatus(IntPtr imc, bool open);
}
"@

$target = $args[0]
$found = New-Object System.Collections.ArrayList
$cb = [W+EnumProc]{
  param($h, $p)
  if ([W]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][W]::GetWindowTextW($h, $sb, 512)
    $t = $sb.ToString()
    if ($t -and $t -match $target) {
      $pid_ = 0
      [void][W]::GetWindowThreadProcessId($h, [ref]$pid_)
      [void]$found.Add([pscustomobject]@{ Hwnd=$h; Title=$t; Pid=$pid_ })
    }
  }
  return $true
}
[void][W]::EnumWindows($cb, [IntPtr]::Zero)

if ($found.Count -eq 0) { Write-Output "NO-WINDOW-MATCH: $target"; exit 0 }

foreach ($w in $found) {
  $imc = [W]::ImmGetContext($w.Hwnd)
  Write-Output ("=== " + $w.Title + " pid=" + $w.Pid + " hwnd=" + $w.Hwnd)
  if ($imc -eq [IntPtr]::Zero) {
    Write-Output "  HIMC=0  (窗口没有 IME 上下文)"
  } else {
    $conv = 0; $sent = 0
    $open = [W]::ImmGetOpenStatus($imc)
    [void][W]::ImmGetConversionStatus($imc, [ref]$conv, [ref]$sent)
    $nativeMode = ($conv -band 1)
    Write-Output ("  HIMC=" + $imc + " OPEN=" + $open + " CONV=" + $conv + " bit0=" + $nativeMode + " (1=中文 0=英文)")
    [void][W]::ImmReleaseContext($w.Hwnd, $imc)
  }
}