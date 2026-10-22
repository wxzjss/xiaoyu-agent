param([string]$Out = '.state\shot.png', [string]$ProcName = '', [string]$PathLike = '*win-unpacked*')

# Capture the largest visible top-level window of the packaged app.
# NOTE: keep this file ASCII-only - PowerShell 5.1 mangles non-BOM UTF-8 source.
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class ShotWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool SetThreadDpiAwarenessContext(IntPtr ctx);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static List<string> All() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      list.Add(pid + "|" + h.ToInt64() + "|" + (IsWindowVisible(h) ? "V" : "-") + "|" +
        r.Left + "|" + r.Top + "|" + (r.Right - r.Left) + "|" + (r.Bottom - r.Top) + "|" +
        IsZoomed(h) + "|" + c + "|" + t);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static bool SetForeground(IntPtr h) { return SetForegroundWindow(h); }
}
"@

# DPI fix: on a 150%-scaled display an unaware process sees virtualized 1280x800
# metrics and CopyFromScreen crops the real 1920x1200 window. Switch this thread to
# PER_MONITOR_AWARE_V2 (-4) before reading any window rect.
$dpiOk = $false
foreach ($ctx in @(-4, -3, -2)) {
  try { if ([ShotWin]::SetThreadDpiAwarenessContext([IntPtr]$ctx)) { $dpiOk = $true; Write-Output ('dpi_aware_ctx=' + $ctx); break } } catch { }
}
if (-not $dpiOk) { Write-Output 'dpi_aware=FAILED (capture may be cropped)' }

if ($ProcName) {
  $pids = @(Get-CimInstance Win32_Process -Filter "Name='$ProcName'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId)
} else {
  # ASCII-only fallback: any process running out of the build output folder
  $pids = @(Get-Process | Where-Object { $_.Path -like $PathLike } | Select-Object -ExpandProperty Id)
}
if (-not $pids -or $pids.Count -eq 0) { Write-Output 'NO_PROCESS'; exit 1 }

$best = $null; $bestArea = -1
foreach ($line in [ShotWin]::All()) {
  $f = $line.Split('|')
  if (-not ($pids -contains [int]$f[0])) { continue }
  if ($f[2] -ne 'V') { continue }
  $area = [int]$f[5] * [int]$f[6]
  if ($area -gt $bestArea) { $bestArea = $area; $best = $f }
}
if (-not $best) { Write-Output 'NO_WINDOW'; exit 1 }

$h = [IntPtr][int64]$best[1]
Write-Output ('pid=' + $best[0] + ' rect=' + $best[3] + ',' + $best[4] + ' size=' + $best[5] + 'x' + $best[6] + ' maximized=' + $best[7] + ' class=' + $best[8] + ' title=' + $best[9])
[void][ShotWin]::SetForeground($h)
Start-Sleep -Milliseconds 900

$r = New-Object ShotWin+RECT
[void][ShotWin]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
if ($w -le 0 -or $hh -le 0) { Write-Output 'BAD_RECT'; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([Math]::Max(0,$r.Left), [Math]::Max(0,$r.Top), 0, 0, $bmp.Size)
$path = Join-Path (Get-Location) $Out
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ('saved=' + $path + ' (' + $w + 'x' + $hh + ')')
