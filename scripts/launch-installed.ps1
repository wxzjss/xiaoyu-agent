# 启动「安装版」小鱼Agent —— 主要是给自动化和脚本用的
#
# 为什么需要这个包装：如果当前 shell 里带着 ELECTRON_RUN_AS_NODE（有些开发环境会设），
# 双击 exe 也**没有任何反应**：Electron 不加载 app.asar，而是把参数当 node 脚本跑，
# 立刻退出、不打印任何东西。2026-11-09 我（AI）就因为这一条，误判「安装版被我打坏了」，
# 白折腾了半小时，还把主人的用户态挪走又搬回来。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launch-installed.ps1

$ErrorActionPreference = 'Stop'

$exe = Join-Path $env:LOCALAPPDATA 'Programs\xiaoyu-mini-agent\小鱼Agent.exe'
if (-not (Test-Path $exe)) { throw "找不到安装版：$exe" }

# 关键：先把这个变量清掉，否则 exe 会静默退出
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue

Start-Process -FilePath $exe
Write-Host "已启动：$exe"
