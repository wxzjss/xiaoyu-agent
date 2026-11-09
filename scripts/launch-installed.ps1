# 启动「安装版」小鱼Agent
#
# 为什么需要这个包装：如果当前 shell 里带着 ELECTRON_RUN_AS_NODE，
# exe 会**静默退出** —— 没窗口、没输出、退出码 1。
# 因为 Electron 那时候不加载 app.asar，而是把参数当 node 脚本跑。
#
# 脚本里不写死中文 exe 名（PowerShell 5.1 按 ANSI 读 .ps1 会读坏），
# 所以用「目录里除卸载器以外那个 exe」来找，文件开头带 BOM 保证中文注释不乱。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch-installed.ps1

$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:LOCALAPPDATA 'Programs\xiaoyu-mini-agent'
if (-not (Test-Path $dir)) { throw "install dir not found: $dir" }

$exe = Get-ChildItem $dir -Filter '*.exe' -File |
  Where-Object { $_.Name -notlike 'Uninstall*' } |
  Select-Object -First 1
if (-not $exe) { throw "exe not found under $dir" }

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue

Start-Process -FilePath $exe.FullName
Write-Host ("started: " + $exe.FullName)
