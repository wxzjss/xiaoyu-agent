/**
 * Windows UI Automation（UIA）读界面 —— 窗口列表 + 控件树 + 坐标（2026-11-03）。
 *
 * 【为什么写这个】
 * 主人让参考 dsh-computer-use 的做法。那套东西最值钱的一环是
 * 「先观察、拿到编号 + 坐标，再按编号动手」—— 模型看见什么就能点什么。
 * 小鱼Agent 原来只有 look_screen（一整张截图，模型只能自己猜像素坐标），
 * 点哪儿全靠估，估偏了就点坏东西。这一份补上「看得见的编号」。
 *
 * 【为什么不装 cua-driver / native 模块】
 * 那份驱动的 Windows 版本作者自己标了「未验收」，而且它要求主人亲手授权
 * 把整台电脑的键盘鼠标交出去。这里走 Windows 自带的 UI Automation + GDI，
 * 零依赖、离线可用，跟 src/screen-capture.mjs 是一个路子。
 *
 * 【PowerShell 那几个坑（跟 screen-capture.mjs 一模一样，别踩回去）】
 *  1. 脚本里不许出现 `try { ... } finally { ... }` —— PowerShell 5.1 走
 *     -EncodedCommand 时会被防病毒扫描拦成 `PARSER, ScriptContainedMaliciousContent`。
 *     一律「平铺 + 手动 Dispose」。
 *  2. **不许出现 JPEG/编码器那套**（ImageCodecInfo / EncoderParameters），
 *     跟 `Add-Type @"…"@` 拼在一份脚本里必被拦。这里只截 PNG。
 *  3. 不用 `$ErrorActionPreference = 'Stop'`（会把进度流变成非零退出）。
 *  4. 中文、引号、反斜杠一律走 base64（UTF-16LE）传，别拼命令行。
 *
 * 【两个可调旋钮】
 *  XY_TREE_RAW=1   把这一份 PowerShell 原文落盘到 XY_TREE_DUMP，方便逐句二分
 *  XY_TREE_DEBUG=1 打印每一段耗时
 */
import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

/** 界面树相关的临时文件放这儿（跟 frames 分开放，免得被截图清理顺手删了）。 */
export function uiDir() {
  return join(config.dataDir, '.state', 'ui');
}

function cleanStderr(raw) {
  const s = String(raw || '');
  if (!s.includes('CLIXML')) return s.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 3).join(' / ');
  const errs = [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  const avs = [...s.matchAll(/<AV>([\s\S]*?)<\/AV>/g)].map((m) => m[1]);
  const pick = (errs.length ? errs : avs).map((x) => x.replace(/<[^>]*>/g, '').trim()).filter(Boolean);
  if (pick.length) return pick.slice(0, 3).join(' / ');
  return 'PowerShell 报了个错但拿不到细节';
}

function ps(script, timeout = 25000) {
  if (process.env.XY_TREE_RAW) {
    try {
      writeFileSync(process.env.XY_TREE_DUMP || join(uiDir(), 'tree-debug.ps1'), script, 'utf8');
    } catch { /* 落不了就算了 */ }
  }
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
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
 * 公用的开头：加载 UIA、声明 Win32 那点东西、定义几个小工具函数。
 *
 * 【为什么用 Add-Type 内联 C# 而不是纯 PowerShell 反射】
 * 纯反射写 UIA 要一路 `[System.Windows.Automation.AutomationElement]` 全名，
 * 又长又慢还容易在 5.1 上踩类型转换；内联 C# 编译一次，后面全是强类型。
 * 注意：内联 C# 里**不许**出现 `finally`（同上，防病毒扫描那条）。
 */
const PRELUDE = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class XyUi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  public static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  public static uint PidOf(IntPtr h) { uint p = 0; GetWindowThreadProcessId(h, out p); return p; }
  public static bool Rect(IntPtr h, out int l, out int t, out int w, out int hh) {
    RECT r = new RECT();
    bool ok = GetWindowRect(h, out r);
    l = r.Left; t = r.Top; w = r.Right - r.Left; hh = r.Bottom - r.Top;
    return ok;
  }
  public static bool Front(IntPtr h) {
    ShowWindow(h, 9);
    return SetForegroundWindow(h);
  }
}
"@
[void][XyUi]::SetProcessDPIAware()
function J($o) { return ($o | ConvertTo-Json -Compress -Depth 6) }
function Txt($s, $max) {
  if ($null -eq $s) { return '' }
  $x = [string]$s
  $x = $x -replace '[\\uD800-\\uDFFF]', ''
  $x = $x -replace '[\\r\\n\\t]+', ' '
  if ($x.Length -gt $max) { $x = $x.Substring(0, $max) }
  return $x
}
`;

/**
 * 列出「有窗口的进程」——按前台顺序，带 pid / 标题 / 类名 / 位置。
 *
 * 【为什么不用 Get-Process】
 * Get-Process 给的是进程，不是窗口：一个 Chrome 有十几个窗口，
 * 一个没有窗口的后台进程也会被列出来，模型照着点会点空。
 * 这里走 EnumWindows 拿真实的顶层窗口。
 */
function buildListWindowsScript() {
  return `${PRELUDE}
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class XyEnum {
  public delegate bool Cb(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr p);
  public static List<IntPtr> All() {
    List<IntPtr> list = new List<IntPtr>();
    Cb cb = delegate(IntPtr h, IntPtr p) { list.Add(h); return true; };
    EnumWindows(cb, IntPtr.Zero);
    return list;
  }
}
"@
$fg = [XyUi]::GetForegroundWindow()
$shell = [XyUi]::GetShellWindow()
$rows = @()
foreach ($h in [XyEnum]::All()) {
  if (-not [XyUi]::IsWindowVisible($h)) { continue }
  if ($h -eq $shell) { continue }
  $title = Txt ([XyUi]::Title($h)) 100
  if ($title -eq '') { continue }
  $cls = [XyUi]::Cls($h)
  if ($cls -eq 'Progman' -or $cls -eq 'WorkerW' -or $cls -eq 'Shell_TrayWnd') { continue }
  $l = 0; $t = 0; $w = 0; $hh = 0
  $ok = [XyUi]::Rect($h, [ref]$l, [ref]$t, [ref]$w, [ref]$hh)
  if (-not $ok) { continue }
  if ($w -lt 80 -or $hh -lt 60) { continue }
  $rows += @{ hwnd = [int64]$h; pid = [int][XyUi]::PidOf($h); title = $title; cls = $cls;
              x = $l; y = $t; w = $w; hh = $hh; front = ($h -eq $fg) }
}
$out = @{ ok = $true; windows = $rows; count = $rows.Count } | ConvertTo-Json -Compress -Depth 5
[Console]::Out.Write($out)
`;
}

export async function listWindows() {
  if (process.platform !== 'win32') return { ok: false, error: '这台机器不是 Windows，列不了窗口。' };
  let raw = '';
  try {
    raw = await ps(buildListWindowsScript(), 20000);
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  let j = {};
  try {
    j = JSON.parse(String(raw).trim() || '{}');
  } catch {
    return { ok: false, error: '窗口列表回来了但看不懂：' + String(raw).slice(0, 200) };
  }
  const list = Array.isArray(j.windows) ? j.windows : (j.windows ? [j.windows] : []);
  return { ok: true, windows: list, count: list.length };
}

/**
 * 读某一个窗口的控件树，并**顺手把这一扇窗的截图存下来**。
 *
 * 【为什么截图和树在同一个 PowerShell 里做】
 * 元素编号和坐标必须是「同一帧」的：先截一张、过 300ms 再读树，
 * 中间窗口一动，模型点下去就偏了。所以一次调用里先量尺寸、再读树、最后截图，
 * 顺序固定，坐标和图像来自同一个时刻。
 *
 * 【编号是怎么定的】
 * 只给「能手点、能打字」的元素编号（按钮、输入框、菜单项、链接……）。
 * 静态文字、容器、面板不给编号 —— 给了模型就爱点它，
 * 点了没反应，它还以为成了。这不编号的东西照样以 `role` 文本出现，只是没有 [N]。
 */
function buildTreeScript({ targetHwnd, pngPath, maxElements }) {
  const esc = (p) => String(p).replace(/'/g, "''");
  return `${PRELUDE}
$targetHwnd = [IntPtr][int64]${Number(targetHwnd) || 0}
if ($targetHwnd -eq [IntPtr]::Zero) { $targetHwnd = [XyUi]::GetForegroundWindow() }
$l = 0; $t = 0; $w = 0; $hh = 0
$okRect = [XyUi]::Rect($targetHwnd, [ref]$l, [ref]$t, [ref]$w, [ref]$hh)
if (-not $okRect -or $w -le 0 -or $hh -le 0) {
  $err = @{ ok = $false; error = 'read window rect failed' } | ConvertTo-Json -Compress
  [Console]::Out.Write($err)
  exit 0
}

# —— 1. 截图（先截，坐标与图来自同一时刻）——
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($l, $t, 0, 0, $bmp.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$g.Dispose()
$fs = [System.IO.File]::Create('${esc(pngPath)}')
$bmp.Save($fs, [System.Drawing.Imaging.ImageFormat]::Png)
$fs.Close()
$bmp.Dispose()

# —— 2. 读树 ——
$root = [System.Windows.Automation.AutomationElement]::FromHandle($targetHwnd)
$title = ''
$appName = ''
$els = @()
if ($null -ne $root) {
  $title = Txt ($root.Current.Name) 120
  $p = 0
  try { $p = [XyUi]::PidOf($targetHwnd) } catch {}
  if ($p -gt 0) { try { $appName = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName } catch {} }
  $tree = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $total = $tree.Count
  $actable = @('Button','Edit','ComboBox','CheckBox','RadioButton','MenuItem','TabItem','Hyperlink','TreeItem','Slider','Spinner','SplitButton','Calendar','HeaderItem')
  $n = 0
  $idx = 0
  # 只收前 maxElements 个，然后退出 —— 别把整棵树 walk 完再截断
  $limit = ${(Number(maxElements) || 500) * 6}
  for ($i = 0; $i -lt $total; $i++) {
    if ($idx -ge $limit) { break }
    if ($n -ge ${Number(maxElements) || 500}) { break }
    $e = $tree.Item($i)
    if ($null -eq $e) { continue }
    $c = $e.Current
    $role = [string]$c.ControlType.ProgrammaticName
    $role = $role -replace '^ControlType\\.', ''
    $name = Txt ($c.Name) 60
    $val = ''
    try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if ($null -ne $vp) { $val = Txt ($vp.Current.Value) 40 } } catch {}
    $r = $c.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $interactive = $actable -contains $role
    # 大到离谱的是整页容器（Document 动辄一整窗），小到离谱的点不准
    if ($r.Width -ge ($w * 0.95) -and $r.Height -ge ($hh * 0.95)) { $interactive = $false }
    if ($r.Width -lt 6 -or $r.Height -lt 6) { $interactive = $false }
    # 只留窗口内部的（外面那些是别的窗/阴影）
    if ($r.Right -lt 0 -or $r.Bottom -lt 0 -or $r.Left -gt $w -or $r.Top -gt $hh) { continue }
    if (-not $interactive -and $name -eq '' -and $val -eq '') { continue }
    $rec = @{ i = 0; role = $role; name = $name; value = $val;
              x = [int][Math]::Round($r.Left - $l + $r.Width / 2);
              y = [int][Math]::Round($r.Top - $t + $r.Height / 2);
              w = [int][Math]::Round($r.Width); h = [int][Math]::Round($r.Height);
              act = $interactive }
    # 只有「能点的」才给编号：给了编号就等于承诺「点它会有反应」，
    # 编号给错了比不给更坏 —— 模型会照着编号点一个点不动的东西，然后反复怀疑自己。
    if ($interactive) { $n++; $rec.i = $n }
    $els += $rec
    $idx++
  }
} else {
  $total = 0
}
$out = @{ ok = $true; hwnd = [int64]$targetHwnd; pid = [int][XyUi]::PidOf($targetHwnd);
          title = $title; app = $appName; winX = $l; winY = $t; winW = $w; winH = $hh;
          elements = $els; shown = $els.Count; total = $total } | ConvertTo-Json -Compress -Depth 6
[Console]::Out.Write($out)
`;
}

/** 读窗口的按钮文字（危险词检测要用），一次给一小批。 */
export async function windowText(hwnd) {
  if (process.platform !== 'win32') return '';
  const script = `${PRELUDE}
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]${Number(hwnd) || 0})
if ($null -eq $root) { [Console]::Out.Write('[]'); exit 0 }
$tree = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$acc = @()
for ($i = 0; $i -lt $tree.Count; $i++) {
  $e = $tree.Item($i)
  if ($null -eq $e) { continue }
  $nm = $e.Current.Name
  if ($nm) { $acc += (Txt $nm 40) }
  if ($acc.Count -ge 400) { break }
}
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $acc))
`;
  try {
    const raw = await ps(script, 20000);
    const arr = JSON.parse(String(raw).trim() || '[]');
    return Array.isArray(arr) ? arr : [arr];
  } catch {
    return '';
  }
}

/**
 * 读控件树 + 截这一扇窗。
 *
 * @param {{hwnd?: number, maxElements?: number, tag?: string}} [opts]
 */
export async function readWindow({ hwnd = 0, maxElements = 500, tag = '' } = {}) {
  if (process.platform !== 'win32') return { ok: false, error: '这台机器不是 Windows，读不了界面。' };
  const dir = uiDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: '放不下界面图：' + String(e?.message ?? e) };
  }
  const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const png = join(dir, id + '.png');
  let raw = '';
  try {
    raw = await ps(buildTreeScript({ targetHwnd: hwnd, pngPath: png, maxElements }), 30000);
  } catch (e) {
    return { ok: false, error: '读界面没成：' + String(e?.message ?? e) };
  }
  let j = {};
  try {
    j = JSON.parse(String(raw).trim() || '{}');
  } catch {
    return { ok: false, error: '界面树回来了但看不懂：' + String(raw).slice(0, 200) };
  }
  if (!j.ok) return { ok: false, error: String(j.error || '读界面失败') };
  const els = Array.isArray(j.elements) ? j.elements : (j.elements ? [j.elements] : []);
  const meta = {
    id,
    at: new Date().toISOString(),
    hwnd: Number(j.hwnd) || 0,
    pid: Number(j.pid) || 0,
    title: String(j.title || ''),
    app: String(j.app || ''),
    win: { x: Number(j.winX) || 0, y: Number(j.winY) || 0, w: Number(j.winW) || 0, h: Number(j.winH) || 0 },
    shown: Number(j.shown) || els.length,
    total: Number(j.total) || 0,
    tag: String(tag || ''),
    png,
    pngBytes: (() => { try { return statSync(png).size; } catch { return 0; } })(),
  };
  try {
    writeFileSync(join(dir, id + '.json'), JSON.stringify(meta, null, 2), 'utf8');
  } catch { /* 元信息写不进去不影响读 */ }
  return { ok: true, id, meta, elements: els, hasPng: existsSync(png) };
}
