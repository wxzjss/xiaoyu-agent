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
  # 【2026-11-14 修·这个 throw 块让整个脚本语法错误】
  # 原来写成 `throw ('字符串' + $probe + '字符串'` 跨行拼接 —— Windows PowerShell 5.1
  # 在这个位置解析不出来（报「表达式中缺少右")"」），**整个脚本根本跑不起来**，
  # 于是「改完源码 → 打进安装包 → 重启」这条路一直是断的：改的东西只进了 data/code，
  # 而程序跑的是 asar 里那份旧的。
  # 现在改成先拼字符串再 throw，解析器不吃这套。
  $msg = '这个脚本正在被小鱼Agent自己拉起（祖先进程：' + $probe + '），跑下去会把它自己杀掉。'
  $msg += '请在**外部**终端（PowerShell/cmd）里运行这条命令 —— 替换完它会自动把应用拉回来。'
  $msg += '（管理员档下可以用 -SelfUpdate 参数：她就是在自更程序本体，杀掉后自动拉回、轮子自动接回。）'
  throw $msg
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
  # 【2026-11-14 夜修·自动拉起不稳】原来只 Start-Process 一次 explorer 就收工：
  # 老进程刚被 kill 还没放掉单实例锁 / explorer 这次只是把请求交给已有窗口，
  # 新实例都会秒退，表现就是「repack 说拉起了，其实端口没起来」。
  # 现在：① 等老进程真的全退 ② explorer 拉起后轮询端口（port.txt 为准）
  # ③ 60 秒内没起来就重试，最多 3 次，每次都重新确认没有残留实例。
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    $left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -like '*xiaoyu-mini-agent*' })
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  $portFile = Join-Path $env:APPDATA '小鱼Agent\port.txt'
  $up = $false
  $ProgressPreference = 'SilentlyContinue'   # 轮询时别刷一屏 WebRequest 进度条
  for ($try = 1; $try -le 3 -and -not $up; $try++) {
    # 【2026-11-15 修·每打包一次就漏一个「Temp - 文件资源管理器」窗口】
    #
    # 主人报：「和记事本一样，我后台打开了一堆的文件管理器窗口。」
    # 实测：13 个 explorer 进程，标题全是「Temp - 文件资源管理器」，
    # 启动时间 9:11~13:14 —— 正好是我今天反复打包重启的时段，一次漏一个。
    #
    # 病根：explorer.exe 的 /select 与「把参数当路径打开」这层语义很挑。
    # 传一个带中文/空格的 exe 路径时，若引号或工作目录不对，
    # explorer 不认它是可执行文件 → **把它当目录打开**，而这个进程的当前目录
    # 是 TEMP，于是开出一个「Temp」窗口；程序没起来，重试还再开一个（最多 3 次）。
    #
    # 修法：**不要自己给路径加引号**。Start-Process 会再包一层，
    # 变成 ""C:\...\小鱼Agent.exe"" —— explorer 认不出这是可执行文件，
    # 就当目录打开，于是弹出一个「Temp」窗口（explorer 当前目录是 TEMP）。
    # 直接把路径作为参数交给 PowerShell，让它自己处理引号。
    Start-Process explorer.exe -WorkingDirectory (Split-Path $exe -Parent) -ArgumentList $exe | Out-Null
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 1
      $port = 8788
      try { $p = (Get-Content $portFile -Raw -ErrorAction Stop).Trim(); if ($p -match '^\d+$') { $port = [int]$p } } catch {}
      try {
        $r = Invoke-WebRequest "http://127.0.0.1:$port/" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $up = $true; break }
      } catch {}
    }
    if (-not $up) { Write-Host "第 $try 次拉起没见服务，再来一次…" }
  }
  if ($up) { Write-Host '应用已重新拉起（explorer + 端口轮询确认 200）。' }
  else { Write-Host '⚠ 三次都没拉起来，请手动双击小鱼Agent.exe。' }

  # 【2026-11-15 加·兜底清创】万一还是漏了「Temp - 文件资源管理器」窗口，
  # 打包结束时自己收走 —— 主人的桌面不该因为我们的打包多出东西。
  # 只认标题**精确等于**「Temp - 文件资源管理器」的，绝不碰主人自己开的文件夹。
  try {
    $stray = @(Get-Process explorer -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle -eq 'Temp - 文件资源管理器' })
    if ($stray.Count -gt 0) {
      $stray | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
      Write-Host ("顺手关掉了 " + $stray.Count + " 个多出来的「Temp」窗口")
    }
  } catch {}
}
