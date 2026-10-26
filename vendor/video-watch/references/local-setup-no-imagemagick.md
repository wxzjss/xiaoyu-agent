# 本机安装记录：没有 ImageMagick，用 ffmpeg 替身

> 记录时间：2026-10-26　机器：Windows　装的是 `video-watch-plus`（MIT，衍生自 video-watch-skill）

## 结论先说

这台机器上**没有装 ImageMagick**，用的是 `tools/magick.cjs` + `tools/magick.bat`
这个 ffmpeg 替身。`VW_MAGICK` 指向 `tools/magick.bat` 即可，`vendor/vw.py` 一个字节没改。

已经跑通的命令：`doctor` / `probe` / `plan` / `sheet` / `read`。
没装的：`asr`（faster-whisper）、`ocr`（rapidocr）。

## 为什么不装 ImageMagick

不是图省事，是装不上：

- ImageMagick 的 Windows 包放在 GitHub release 上，下载走 `objects.githubusercontent.com` —— 这台机器上这个域名**连不通**（180 秒超时）。
- `imagemagick.org` 首页和 `script/download.php` 能连，但 `imagemagick.org/archive/binaries/*` 和 `/download/binaries/*` 也是连接超时。
- 而 ffmpeg 本机已经有（`C:\Users\35453\ffmpeg\bin\ffmpeg.exe`，9.0.2-full_build-www.gyan.dev），
  SKILL.md 要求的 7 个滤镜（drawtext/select/scale/tile/crop/signalstats/silencedetect）一个不缺。

`scripts/setup-windows.ps1` 会下载 ffmpeg + ImageMagick 并写用户级环境变量。
**没有跑它** —— 它会改全局 PATH，风险大于收益。

## 替身覆盖了哪四类调用

`vendor/vw.py` 里所有 magick 调用就这四类，全部核过：

| 用途 | vw.py 行 | 原始 ImageMagick | 替身怎么做 |
|---|---|---|---|
| 差异对比 | `L681` | `convert A B -compose difference -composite OUT` | `blend=all_mode=difference` |
| 竖向拼接 | `L699`、`L1024` | `convert A B ... -append OUT` | `vstack`（先统一宽度） |
| 拼网格 | `L709`、`L781`、`L955`、`L1112` | `montage ... -tile CxR -geometry +G+G -background #rgb OUT` | `pad` 到统一 cell + `xstack` |
| 取标准差 | `L1094` | `identify -format %[fx:standard_deviation] FILE` | `signalstats YAVG` 两趟算 E[Y]、E[Y²] |

替身的设计原则：**碰到没见过的写法就报错退出，绝不返回猜的结果**。
这个技能整套方法论就是「不许编」，替身自己先编就说不过去了。

## 踩到的四个坑（都写进了 magick.cjs 的注释里，防止以后有人"优化"回去）

### 1. ffmpeg 9 写单张图必须 `-update 1`

```
[image2] The specified filename 'x.png' does not contain an image sequence pattern
```
旧版 ffmpeg 不用，9.x 才报。替身在 `ff()` 里统一补：只要带了 `-frames:v` 且没有 `-update` 就插一个。

### 2. `xstack` 的 layout 里 `w0*2` 是不可靠的

- `w0` 单独出现 = 第 0 路输入的宽度，没问题。
- 但 `w0*1_0`、`w0*2_0` 这类乘式**不报错，结果却是错的**：
  9 张 254×144 的图本应拼成 762×432，实测出来是 **508×288**（只有 2 列），
  而且图版看起来"能用"，很隐蔽。
- 现在的做法：**直接用绝对像素** `0_0|254_0|508_0|0_144|...`。
  cell 尺寸本来就是我们自己算的，没必要绕 xstack 的表达式。

### 3. `xstack` 至少需要 2 路输入

`vw.py read` 在只有一帧时会走到 `montage`（`inputs=1`），
ffmpeg 报 `Value 1.000000 for parameter 'inputs' out of range [2 - 2.14748e+09]`。
替身对单图走退化分支：`pad` 一下直接输出，不拼。

### 4. `pad` 的颜色要写成 `0x111111` 不是 `#111`

`#111` 是 ImageMagick 的写法，ffmpeg 认 `0x111111` 或命名色。
替身的 `normColor()` 负责转换，三种形式都认。

## 验收数据（带真值）

用 `scripts/build_testclip.py` 造的 9 秒 / 640×360 / 24fps 短片，真值已知：

| 项 | 真值 | 实测 | |
|---|---|---|---|
| 切点 | `[3, 6]` | `[3, 6]` | ✔ |
| 冻结起点 | `[0, 6]` | `[0, 6]` | ✔ |
| 静音 | start 0 / end 3.66 | `{start,0}` `{end,3.66}` | ✔ |
| 内容判型 | 剪辑类（含硬切） | 剪辑类 | ✔ |

图版 `sheet_01.png`（762×432，3×3）：第 1~6 格全是 `SEG-1 IDLE`，
第 7~9 格变成 testcard 彩条 + `SEG-2 PLAY` —— **和切点 3.0s 精确吻合**。
小字面板 `read_13.png`（1240×340）左上角时间码 `00:00:00.083` 裁切放大后清晰可读。

## 复现装法

```powershell
$SK  = "C:\Users\35453\.dsh\profiles\dsh-memory-evolve\skills\video-watch-plus"
$PY  = "C:\Users\35453\AppData\Local\Python\bin\python.exe"   # PATH 上的 python 是 WindowsApps stub
$env:VW_MAGICK     = "$SK\tools\magick.bat"                   # 注意是 .bat 不是 .cjs
$env:PYTHONIOENCODING = "utf-8"; $env:PYTHONUTF8 = "1"        # 否则中文输出乱码

Push-Location $SK
& $PY vendor\vw.py doctor                                     # 应显示"必需项就绪"
& $PY vendor\vw.py probe  <media>                             # → vw_out/timeline.json
& $PY vendor\vw.py plan   vw_out\timeline.json                # → vw_out/shotlist.json
& $PY vendor\vw.py sheet  vw_out\shotlist.json <media>        # → vw_sheets/
& $PY vendor\vw.py read --media <media> --shotlist vw_out\shotlist.json   # → vw_read/
Pop-Location
```

**必须用 `.bat` 不能直接用 `.cjs`**：Python 的 `subprocess` 要能直接 exec 的目标，
`.cjs` 不是可执行文件，`find_magick()` 会判断"找不到"。

## 还没装的（要装的话）

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"      # 直连 huggingface 不通
$env:HF_HUB_DISABLE_XET = "1"                   # 否则会卡在 xet 传输
& $PY -m pip install faster-whisper "av<19"
```
small 模型约 500MB。装了才有 `asr` 子命令（音频侧），不装的话听觉那半边是空的，
视觉侧不受影响。
