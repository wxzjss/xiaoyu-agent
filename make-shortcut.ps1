# 在桌面创建 / 修复「小鱼Agent」启动快捷方式。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File make-shortcut.ps1
#
# 程序每次启动也会自己查一遍（见 src/selfcheck.mjs），这个脚本是手动修的时候用。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$bat  = Join-Path $root 'start.bat'
$icon = Join-Path $root 'assets\xiaoyu.ico'
if (-not (Test-Path -LiteralPath $bat)) { throw "找不到启动器: $bat" }

# 桌面可能被重定向到 OneDrive，以系统登记的那个为准
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) {
  $desktop = Join-Path $env:USERPROFILE 'Desktop'
}
$lnk = Join-Path $desktop '小鱼Agent.lnk'

$ws = New-Object -ComObject WScript.Shell

# 已经有一个就检查指得对不对，不对就覆盖
if (Test-Path -LiteralPath $lnk) {
  $old = $ws.CreateShortcut($lnk)
  if ($old.TargetPath -ne $bat -or $old.WorkingDirectory -ne $root) {
    Write-Output ('旧的指向不对，重建：' + $old.TargetPath)
  }
}

$s = $ws.CreateShortcut($lnk)
$s.TargetPath = $bat
$s.WorkingDirectory = $root
$s.Description = '启动小鱼Agent桌面版'
# 最小化批处理窗口，只留 Electron 应用窗口
$s.WindowStyle = 7
if (Test-Path -LiteralPath $icon) { $s.IconLocation = $icon + ',0' }
$s.Save()

Write-Output ('快捷方式已就绪: ' + $lnk)
Write-Output ('  目标     : ' + $s.TargetPath)
Write-Output ('  工作目录 : ' + $s.WorkingDirectory)
Write-Output ('  图标     : ' + $s.IconLocation)
