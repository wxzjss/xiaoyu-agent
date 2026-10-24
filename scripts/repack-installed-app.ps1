# 把源码打进「已安装的」小鱼Agent 的 app.asar 里。
#
# 为什么需要这个：桌面快捷方式启动的是安装版，它把代码整包塞在
# <安装目录>\resources\app.asar 里。改了 src/ 和 public/ 之后安装版看不见 ——
# 界面会一直是旧版本。每次改完代码跑一遍这个脚本，安装版就跟源码同步了。
#
# 用法：  powershell -File scripts\repack-installed-app.ps1
#         powershell -File scripts\repack-installed-app.ps1 -InstallDir "D:\某个目录"
#
# 路径都不写死：安装目录按 %LOCALAPPDATA% 推，node 用当前跑着的那个。
param(
  [string]$InstallDir = ''
)

$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $PSScriptRoot
if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\xiaoyu-mini-agent'
}

$appDir = Join-Path $InstallDir 'resources'
$asarP = Join-Path $appDir 'app.asar'
$work = Join-Path $src '.build\asar-patch'
$asarJs = Join-Path $src 'node_modules\@electron\asar\bin\asar.js'

# 找 node：先看有没有 NODe 环境变量，再找项目里常见的几个位置
$node = $null
foreach ($cand in @($env:NODE_EXE, (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source)) {
  if ($cand -and (Test-Path $cand)) { $node = $cand; break }
}
if (-not $node) {
  foreach ($cand in @(
      (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
      'C:\Program Files\nodejs\node.exe'
    )) {
    if (Test-Path $cand) { $node = $cand; break }
  }
}
if (-not $node) { throw '找不到 node.exe，请设环境变量 NODE_EXE 指向它' }
if (-not (Test-Path $asarJs)) { throw "找不到 asar 工具：$asarJs（先在项目里 npm install）" }
if (-not (Test-Path $asarP)) { throw "找不到已安装的 app.asar：$asarP（先装一次安装版，或用 -InstallDir 指定）" }

Write-Host "源码   = $src"
Write-Host "安装版 = $InstallDir"
Write-Host "node   = $node"

# 1) 先停掉正在运行的安装版，否则 asar 被映射着替换不掉
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -like "*$($InstallDir -replace '\\', '\\')*" -or $_.Name -eq '小鱼Agent.exe' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# 2) 备份一次原始包（只在没有备份时做，免得把旧备份冲掉）
if (-not (Test-Path "$asarP.bak-original")) {
  Copy-Item $asarP "$asarP.bak-original"
  Write-Host '已备份原始 app.asar'
}

# 3) 解开现有包 → 用源码覆盖 → 重新打包
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work -Force | Out-Null
& $node $asarJs extract $asarP $work

foreach ($d in @('src', 'public', 'persona', 'electron', 'assets', 'scripts')) {
  $from = Join-Path $src $d
  if (-not (Test-Path $from)) { continue }
  $dst = Join-Path $work $d
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $from $dst -Recurse -Force
}
# scripts/ 只管语音合成那三个 .py；打包脚本、图标生成脚本这些不该进包，
# 拷完把它们再删掉，免得把 .ps1 / 开发工具也塞进 asar。
$ws = Join-Path $work 'scripts'
if (Test-Path $ws) {
  Get-ChildItem $ws -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -ne '.py' } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem $ws -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'voice' } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
Copy-Item (Join-Path $src 'package.json') (Join-Path $work 'package.json') -Force

$new = Join-Path $src '.build\app-new.asar'
if (Test-Path $new) { Remove-Item $new -Force }
& $node $asarJs pack $work $new

# 4) 换上去
Copy-Item $new $asarP -Force

$files = (Get-ChildItem $work -Recurse -File | Measure-Object).Count
Write-Host "好了：$files 个文件，app.asar = $((Get-Item $asarP).Length) 字节"
