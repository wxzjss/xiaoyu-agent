# 把源码打进「已安装的」小鱼Agent 的 app.asar 里。
#
# 为什么需要这个：桌面快捷方式启动的是安装版，它把代码整包塞在
# <安装目录>\resources\app.asar 里。改了 src/ 和 public/ 之后安装版看不见 ——
# 界面会一直是旧版本。每次改完代码跑一遍这个脚本，安装版就跟源码同步了。
#
# 用法：  powershell -File scripts\repack-installed-app.ps1
#         powershell -File scripts\repack-installed-app.ps1 -InstallDir "D:\某个目录"
#         powershell -File scripts\repack-installed-app.ps1 -SelfUpdate
#           ↑【2026-11-13 管理员档专属】主人开了管理员权限时，智能体自己更新程序本体用。
#             跳过父链自检（她就是故意的），流程不变：杀应用 → 换包 → 自动拉回来；
#             她这一轮会被硬杀一次，重启后由开机自续接回（半截话也能显示）。
param(
  [string]$InstallDir = '',
  [switch]$SelfUpdate
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

# 【2026-11-13 加·防自毁】如果这个脚本是被小鱼自己拉起来的（父进程链里有小鱼Agent.exe
# 或它带的服务端 node），第 1 步的 Stop-Process 就会杀死宿主自己 —— 实测表现就是
# 「重启后没一会自动退出」（主人 2026-11-13 早上连环遇到的）。
# 被小鱼拉起时直接报错退出，一个人都不杀；请到外部终端跑。
$probe = $null
try {
  $cur = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
  for ($i = 0; $i -lt 12 -and $cur; $i++) {
    if ($cur.Name -like '*小鱼*' -or $cur.Name -like '*xiaoyu*') { $probe = $cur.Name; break }
    $pp = $cur.ParentProcessId
    if (-not $pp) { break }
    $cur = Get-CimInstance Win32_Process -Filter "ProcessId = $pp" -ErrorAction SilentlyContinue
  }
} catch {}
if ($probe -and -not $SelfUpdate) {
  throw ('这个脚本正在被小鱼Agent自己拉起（祖先进程：' + $probe + '），跑下去会把它自己杀掉。'
    + '请在**外部**终端（PowerShell/cmd）里运行这条命令 —— 替换完它会自动把应用拉回来。'
    + '（管理员档下可以用 -SelfUpdate 参数：她就是在自更程序本体，杀掉后自动拉回、轮子自动接回。）')
}
if ($SelfUpdate) {
  Write-Host '【SelfUpdate】管理员档自更：跳过父链自检，跑完自动把应用拉回来。'
}

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

# vendor/ 是运行期要 exec 的外部程序（看视频那套的 vw.py + 替身 magick.bat），
# 跟 src 一样属于「没有就跑不起来」，必须一起进包。
foreach ($d in @('src', 'public', 'persona', 'electron', 'assets', 'scripts', 'vendor')) {
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

# 3.5) 打包之前先把 .bak 中间版本清出去。
# 我改代码时每步都留一个 .bak-before-xxx，要是跟着打进包，
# 包会白白胖一大圈（实测 20.8MB → 22.8MB），而且里面全是重复代码，看着乱。
# 只清 electron / src / public 三个目录下的，别的一概不碰。
foreach ($d in @('electron', 'src', 'public')) {
  $dir = Join-Path $work $d
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\.bak(-|$)' -and $_.Extension -ne '.md' } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

$new = Join-Path $src '.build\app-new.asar'
if (Test-Path $new) { Remove-Item $new -Force }
& $node $asarJs pack $work $new

# 4) 换上去
Copy-Item $new $asarP -Force

$files = (Get-ChildItem $work -Recurse -File | Measure-Object).Count
Write-Host "好了：$files 个文件，app.asar = $((Get-Item $asarP).Length) 字节"

# 【2026-11-13 加】第 1 步杀掉的应用拉回来 —— 主人少一步手动双击。
# -WindowStyle Hidden 让它跟正常双击一样进托盘/窗口，不带黑框。
$exe = Join-Path $InstallDir '小鱼Agent.exe'
if (Test-Path $exe) {
  Start-Sleep -Seconds 1
  Start-Process $exe | Out-Null
  Write-Host '应用已重新拉起。'
}
