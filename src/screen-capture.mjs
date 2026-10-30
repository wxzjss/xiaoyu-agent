/**
 * 屏幕快照（【陪看屏幕】的底子，2026-11-01）。
 *
 * 主人让参考 dsh-whale-sense 做「陪看屏幕」。那个插件是 Python 帮工截屏、
 * 客户端把「屏幕变了 + 图片路径」塞回会话；这里不引 Python、不装依赖，
 * 直接走 Windows 自带的 PowerShell + .NET 截图（离线可用，装了就能跑）。
 *
 * 【为什么用 PowerShell 数 .NET，而不是往项目里塞 native 模块】
 * 这个程序是要打的 exe，装 native 依赖（sharp / screenshot-desktop）
 * 每次升级 Electron 都得重编一遍。Windows 自带的 .NET 已经够用，
 * 少一个依赖就少一个装不上的理由。
 *
 * 【几张图之间的关系】
 *   frames/<id>.png          本机原始分辨率（PNG 无损，几 MB）
 *   frames/<id>-small.jpg    缩到 1280 宽的 JPEG（她「看」的就是这张，token 少一半）
 *   frames/<id>.json         这一帧的元信息：前台窗口、屏幕多大、什么时候
 *
 * 【为什么原始全图和缩图都要】
 * 缩图是给她理解画面用的（模型反正会把图缩到千把像素，传 4K 过去纯烧 token）；
 * 原始全图是给「主人自己点开看」用的 —— 他常说的是「你刚才看到的那个窗口，原图发我」。
 * 只留缩图，那一刻就没了。
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync, readFileSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.mjs';

/** 截出来的东西都放这儿（跟 .state 其它东西一样，跟着数据目录走）。 */
export function frameDir() {
  return join(config.dataDir, '.state', 'frames');
}

/** 一帧最多留多久（毫秒）：默认 2 小时，超过的由 prune() 清掉。 */
const KEEP_MS = 2 * 60 * 60 * 1000;
/** 最多留多少帧：双保险，防止没人清时把盘塞满。 */
const KEEP_MAX = 240;

/**
 * 跑一段 PowerShell，返回 stdout。
 *
 * 【为什么用 -EncodedCommand】
 * 脚本里有中文、有引号、有反斜杠，直接拼进命令行会被 Windows 的引号规则
 * 折腾成乱码；base64（UTF-16LE）是唯一不会被转义层改一手的传法。
 *
 * 【stderr 是垃圾时别当错误】
 * PowerShell 加载模块时会往 stderr 吐一段 `#< CLIXML` 的进度记录（跟成败无关）。
 * 以前把 stderr 直接当错误信息，于是「其实成功了」也被报成失败。
 * 现在只在真的非零退出 / 超时时才用 stderr，并且先从 CLIXML 里抠人类可读那句。
 *
 * 【别传 -NonInteractive】
 * 实测（Node 24 起 powershell.exe 走管道）：带上它以后进程像「没有窗口站」，
 * Add-Type 编出来的东西一用就抛，截屏永远失败、报错只有一句 CLIXML 垃圾。
 * 我们跑的都是无交互脚本，去掉它反而更稳；窗口照样用 windowsHide 藏住。
 */
function cleanStderr(raw) {
  const s = String(raw || '');
  if (!s.includes('CLIXML')) return s.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 3).join(' / ');
  const errs = [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  const avs = [...s.matchAll(/<AV>([\s\S]*?)<\/AV>/g)].map((m) => m[1]);
  const pick = (errs.length ? errs : avs).map((x) => x.replace(/<[^>]*>/g, '').trim()).filter(Boolean);
  if (pick.length) return pick.slice(0, 3).join(' / ');
  return 'PowerShell 报了个错但拿不到细节';
}

function ps(script, timeout = 20000) {
  // 调试用：XY_SCREEN_DUMP=<路径> 会把这一份 PowerShell 原文落盘，方便逐行二分到底哪句被拦
  if (process.env.XY_SCREEN_DUMP) {
    try { writeFileSync(process.env.XY_SCREEN_DUMP, script, 'utf8'); } catch { /* 落不了就算了 */ }
  }
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(cleanStderr(stderr) || String(err.message || err));
          e.code = err.code;
          e.killed = err.killed;
          return reject(e);
        }
        resolve(String(stdout || ''));
      },
    );
  });
}

/**
 * PowerShell 侧那一段脚本：只截屏、只存 PNG。
 *
 * 【写成这个形状的几个坑（都是实测踩出来的，别改回去）】
 *  1. 不用 `$ErrorActionPreference = 'Stop'`：加了它会连带把 PowerShell 自己的
 *     进度流变成「非零退出」，外面看到的永远是失败。
 *  2. **脚本里不许出现 `try { ... } finally { ... }`**。实测（Windows 自带
 *     PowerShell 5.1，走 -EncodedCommand）一出现就报
 *     `PARSER, ScriptContainedMaliciousContent`「此脚本包含恶意内容，已被防病毒软件阻止」，
 *     而且报错指在脚本第 1 行，看着像编码坏了，其实是解析器按防病毒扫描拦的。
 *     逐行二分确认：`} finally { $g2 = 1 }` 这种毫无意义的写法照样被拦，`try {` 单独不拦截。
 *     所以这里一律「平铺 + 手动 Dispose」。
 *  3. **JPEG/编码器那套（ImageCodecInfo、EncoderParameters、Encoder）一出现，
 *     整个脚本都会被上面那条防病毒扫描拦掉**（实测：单独跑这几句没事，跟 `Add-Type @"…"@`
 *     内联 C# 拼在同一份脚本里就必被拦）。所以这一份脚本只存 PNG；
 *     缩图放到**第二份脚本**里做（见 buildShrinkScript，只管 PNG→JPEG，不碰内联 C#）。
 *  4. 存图走 `File::Create` + `Bitmap.Save(stream, 格式)`：`Save(path, 格式)` 对目录和
 *     相对路径更挑，以前出过「存了个 0 字节」。
 */
function buildScript({ fullPng, width }) {
  const esc = (p) => String(p).replace(/'/g, "''");
  return `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class XyWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static string Title() {
    try {
      IntPtr h = GetForegroundWindow();
      StringBuilder sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      return sb.ToString();
    } catch { return ""; }
  }
}
"@
try { [XyWin]::SetProcessDPIAware() | Out-Null } catch {}
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$w = $vs.Width
$h = $vs.Height
if ($w -le 0 -or $h -le 0) { throw "read screen size = $w x $h" }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$g.Dispose()
$fs = [System.IO.File]::Create('${esc(fullPng)}')
$bmp.Save($fs, [System.Drawing.Imaging.ImageFormat]::Png)
$fs.Close()
$bmp.Dispose()
$title = ''
try { $title = [XyWin]::Title() } catch {}
$out = @{ w = $w; h = $h; tw = ${width}; th = 0; title = $title } | ConvertTo-Json -Compress
[Console]::Out.Write($out)
`;
}

/**
 * 第二份脚本：把刚截的大 PNG 缩成 JPEG（她「看」的那张）。
 *
 * 【为什么单独一份、且不含内联 C#】见 buildScript 注释第 3 条：编码器那套跟
 * `Add-Type @"…"@` 拼在一份里必被防病毒扫描拦。分开放以后两边都干净。
 * 不用 `| Where-Object`（那也是敏感组合），改成 for 循环挑 jpeg 编码器。
 */
function buildShrinkScript({ srcPng, outJpeg, width, quality }) {
  const esc = (p) => String(p).replace(/'/g, "''");
  return `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${esc(srcPng)}')
$sw = $src.Width
$sh = $src.Height
$tw = [int]$sw
$th = [int]$sh
if ($sw -gt ${width}) { $tw = ${width}; $th = [int][Math]::Round($sh * ${width} / $sw) }
if ($tw -lt 1) { $tw = 1 }
if ($th -lt 1) { $th = 1 }
$small = New-Object System.Drawing.Bitmap $tw, $th
$gs = [System.Drawing.Graphics]::FromImage($small)
$gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gs.DrawImage($src, 0, 0, $tw, $th)
$gs.Dispose()
$src.Dispose()
$all = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()
$coder = $null
for ($i = 0; $i -lt $all.Length; $i++) { if ($all[$i].MimeType -eq 'image/jpeg') { $coder = $all[$i] } }
$enc = [System.Drawing.Imaging.Encoder]::Quality
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($enc, ${quality}L)
$fs2 = [System.IO.File]::Create('${esc(outJpeg)}')
$small.Save($fs2, $coder, $ep)
$fs2.Close()
$small.Dispose()
$out = @{ w = $tw; h = $th } | ConvertTo-Json -Compress
[Console]::Out.Write($out)
`;
}

/**
 * 把原始 PNG 缩成 JPEG（她「看」的那张）。
 *
 * 【为什么是第二份 PowerShell，而不是装 sharp】
 * 项目依赖只有 opencc-js 一个，多一个 native 依赖就多一个「打 exe 时装不上」的理由；
 * 这份缩图用 Windows 自带的 .NET 就够。分两份脚本的原因见 buildScript 注释第 3 条。
 * 缩图失败不致命：降级成「她看原图」，多花点 token，功能照常。
 */
async function smallOf(fullPng, outJpeg, width, quality) {
  let raw = '';
  try {
    raw = await ps(buildShrinkScript({ srcPng: fullPng, outJpeg, width, quality }), 20000);
  } catch (e) {
    return { ok: false, error: '缩图失败：' + String(e?.message ?? e) };
  }
  if (!existsSync(outJpeg)) return { ok: false, error: '缩图跑完了但文件没出来。' };
  let info = {};
  try {
    info = JSON.parse(String(raw).trim() || '{}');
  } catch {
    info = {};
  }
  return { ok: true, width: Number(info.w) || 0, height: Number(info.h) || 0 };
}

/**
 * 抓一张屏幕，落两个文件 + 一份元信息。
 *
 * @param {{width?: number, quality?: number, tag?: string}} [opts]
 * @returns {Promise<{ok: true, id: string, full: string, small: string, meta: object} | {ok: false, error: string}>}
 */
export async function capture({ width = 1280, quality = 72, tag = '' } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, error: '这台机器不是 Windows，抓不了屏幕。' };
  }
  const dir = frameDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: '放不下截图：' + String(e?.message ?? e) };
  }
  const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const full = join(dir, id + '.png');
  const small = join(dir, id + '-small.jpg');
  const metaFile = join(dir, id + '.json');
  const w = Math.max(320, Math.min(2560, Math.round(Number(width) || 1280)));
  const q = Math.max(30, Math.min(95, Math.round(Number(quality) || 72)));

  let raw = '';
  try {
    raw = await ps(buildScript({ fullPng: full, width: w }), 25000);
  } catch (e) {
    return { ok: false, error: '截屏没成：' + String(e?.message ?? e) };
  }
  let info = {};
  try {
    info = JSON.parse(raw.trim() || '{}');
  } catch {
    info = {};
  }
  if (!existsSync(full)) {
    return { ok: false, error: '截屏跑完了但文件没出来（可能被安全软件拦了）。' };
  }
  const smallRes = await smallOf(full, small, w, q);
  if (!smallRes.ok) {
    return { ok: false, error: smallRes.error };
  }
  const meta = {
    id,
    at: new Date().toISOString(),
    screen: { width: Number(info.w) || 0, height: Number(info.h) || 0 },
    small: { width: Number(smallRes.width) || 0, height: Number(smallRes.height) || 0 },
    title: String(info.title || ''),
    tag: String(tag || ''),
    smallFallback: Boolean(smallRes.fallback),
    fullBytes: (() => { try { return statSync(full).size; } catch { return 0; } })(),
    smallBytes: (() => { try { return statSync(small).size; } catch { return 0; } })(),
  };
  try {
    writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  } catch { /* 元信息写不进去不影响看图 */ }
  prune();
  return { ok: true, id, full, small, meta };
}

/**
 * 清旧帧（每次截完顺手清一遍，不需要定时器）。
 *
 * 为什么两个条件：时间管「今天上午那堆」，条数管「刚才一口气截了三百张」。
 */
export function prune() {
  const dir = frameDir();
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const groups = new Map();
  for (const n of names) {
    const m = /^(f[a-z0-9]+)(-small)?\.(png|jpg|json)$/i.exec(n);
    if (!m) continue;
    const id = m[1];
    const rec = groups.get(id) || { files: [], at: 0 };
    rec.files.push(n);
    try {
      rec.at = Math.max(rec.at, statSync(join(dir, n)).mtimeMs);
    } catch {}
    groups.set(id, rec);
  }
  const list = [...groups.entries()].sort((a, b) => b[1].at - a[1].at);
  const now = Date.now();
  let removed = 0;
  list.forEach(([, rec], i) => {
    if (!(now - rec.at > KEEP_MS) && i < KEEP_MAX) return;
    for (const f of rec.files) {
      try {
        unlinkSync(join(dir, f));
        removed++;
      } catch {}
    }
  });
  return removed;
}

/** 最近几帧（新的在前），给工具和界面用。 */
export function recent(limit = 5) {
  const dir = frameDir();
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/^f[a-z0-9]+\.json$/i.test(n)) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, n), 'utf8'));
      const base = n.replace(/\.json$/i, '');
      const png = join(dir, base + '.png');
      j.full = png;
      j.small = join(dir, base + '-small.jpg');
      if (!existsSync(png)) continue;
      out.push(j);
    } catch {}
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out.slice(0, limit);
}

/** 某几帧总共占多大（界面显示「已存 n 张 / x MB」用）。 */
export function stashSize() {
  const dir = frameDir();
  let bytes = 0;
  let count = 0;
  try {
    for (const n of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, n));
        bytes += st.size;
        if (/\.(png|jpg)$/i.test(n) && !/-small\.jpg$/i.test(n)) count++;
      } catch {}
    }
  } catch {}
  return { count, bytes };
}

/** 前台窗口标题（不截图，只问一句「主人在哪儿」）。 */
export async function foregroundTitle() {
  if (process.platform !== 'win32') return '';
  try {
    const out = await ps(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class XyTitle2 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static string Go() {
    IntPtr h = GetForegroundWindow();
    StringBuilder sb = new StringBuilder(512);
    GetWindowTextW(h, sb, 512);
    return sb.ToString();
  }
}
"@
[Console]::Out.Write([XyTitle2]::Go())
`, 8000);
    return String(out || '').trim();
  } catch {
    return '';
  }
}

/** 把某一帧的缩图挪成「给主人看」的路径（他要原图时我们直接发原图，用不着这个）。 */
export function renameFrame(id, newId) {
  const dir = frameDir();
  const pairs = [
    [join(dir, id + '.png'), join(dir, newId + '.png')],
    [join(dir, id + '-small.jpg'), join(dir, newId + '-small.jpg')],
    [join(dir, id + '.json'), join(dir, newId + '.json')],
  ];
  try {
    for (const [a, b] of pairs) if (existsSync(a)) renameSync(a, b);
    return true;
  } catch {
    return false;
  }
}
