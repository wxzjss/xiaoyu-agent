import { execFile } from 'node:child_process';

/**
 * 设备状态：屏幕亮度 / 主音量 / 是否静音 / 后台开着哪些窗口。
 *
 * 【2026-11-18 主人要求】「增加屏幕亮度以及音量（与是否静音），后台有哪些窗口开着」
 *
 * 三个坑，先写清楚免得下次踩：
 *
 * ① **音量没有现成的命令行。**
 *    Windows 不提供读主音量的 CLI，也不带 AudioDeviceCmdlets 模块。
 *    只能走 CoreAudio 的 COM 接口 —— 而那需要在运行期编译一小段 C#
 *    （PowerShell 的 Add-Type）。下面那段 C# 是公开的标准写法。
 *
 * ② **亮度只对内置屏有效。**
 *    `WmiMonitorBrightness` 是笔记本内置屏的亮度；台式机 / 外接显示器读不到
 *    （返回空）。这时**不写那一行**，也不报错 —— 台式机上不该多一句「查不到亮度」。
 *
 * ③ **一次子进程要几百毫秒，Add-Type 还要多一秒。**
 *    所以三样东西**合并成一次调用**（起一次进程全拿回来），结果缓存 60 秒，
 *    失败一律降级成「没有这几行」。
 *
 * 窗口列表刻意做了三件事：去重（同进程同名窗口只留一条）、掐长度（每条最多 40 字）、
 * 限量（最多 12 条）—— 它是给人读的一句话，不是给机器解析的清单。
 */

const TTL_MS = 60 * 1000;
let _dev = { at: 0, bright: null, vol: null, mute: null, wins: [] };
let _refreshing = false;

/** 拿主音量的 C#（CoreAudio interop） */
const AUDIO_CS = `
$code = @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  /* ⚠️ 这几个占位函数**不是随便写的**，它们代表虚拟表里的槽位顺序。
     官方 IAudioEndpointVolume 的顺序是：
       0 RegisterControlChangeNotify   1 UnregisterControlChangeNotify
       2 GetChannelCount               3 SetMasterVolumeLevel
       4 SetMasterVolumeLevelScalar    5 GetMasterVolumeLevel
       6 GetMasterVolumeLevelScalar  ← 要读的是这个
       7 SetChannelVolumeLevel         8 SetChannelVolumeLevelScalar
       9 GetChannelVolumeLevel        10 GetChannelVolumeLevelScalar
      11 SetMute                      12 GetMute
     2026-11-18 我第一次写成「4 个占位 + Get...Scalar」，结果它落在**第 4 槽**
     ＝ SetMasterVolumeLevelScalar（收一个 float **入参**）——
     调用时把主音量**设成了 0**（实测主人机器被静音）。
     所以这里必须 6 个占位，再 5 个占位。**改这段之前先数槽位。** */
  int _0(); int _1(); int _2(); int _3(); int _4(); int _5();
  int GetMasterVolumeLevelScalar(out float level);
  int _7(); int _8(); int _9(); int _10(); int _11();
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int clsCtx, IntPtr ap, [MarshalAs(UnmanagedType.IUnknown)] out object aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int _0();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class XyAudio {
  static IAudioEndpointVolume Vol() {
    var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    e.GetDefaultAudioEndpoint(0, 1, out dev);
    var iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    return (IAudioEndpointVolume)o;
  }
  public static int VolPct() { float v; Vol().GetMasterVolumeLevelScalar(out v); return (int)Math.Round(v * 100); }
  public static bool Muted() { bool m; Vol().GetMute(out m); return m; }
}
'@
`;

/**
 * 拼那一段脚本。写成多行字符串而不是一堆拼接，是为了在日志里能整段读。
 * 每个块都各自 try/catch —— 音量编译失败不影响亮度和窗口。
 */
function buildScript() {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    /* 【编码】PowerShell 默认按系统 ANSI 代码页输出，中文窗口标题到 Node 这边
     * 就是一堆 ??? / 乱码（实测「丸子·超维中枢」变成「���ӡ���ά����」）。
     * 先把控制台输出编码顶成 UTF-8，再读的时候按 utf8 解。 */
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'try {',
    '  $b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop',
    '  if ($b) { "BRIGHT=" + $b.CurrentBrightness }',
    '} catch {}',
    AUDIO_CS,
    'try {',
    '  Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop',
    '  "VOL=" + [XyAudio]::VolPct()',
    '  if ([XyAudio]::Muted()) { "MUTE=1" } else { "MUTE=0" }',
    '} catch {}',
    '$seen = @{}',
    'Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() } | ForEach-Object {',
    '  $t = $_.MainWindowTitle.Trim()',
    '  if ($t.Length -gt 40) { $t = $t.Substring(0, 40) }',
    '  $k = $_.ProcessName + "|" + $t',
    '  if (-not $seen.ContainsKey($k)) { $seen[$k] = 1; "WIN=" + $k }',
    '}',
  ].join('\r\n');
}

/**
 * 刷新设备状态（**异步**）。
 *
 * 【为什么必须异步】实测一次约 760ms（起 PowerShell + Add-Type 编译那段 C#）。
 * 用 execFileSync 会把 Node 的事件循环整个卡住这么久 —— 正好撞上流式输出时，
 * 主人看到的就是「她说着说着突然卡一下」。所以：**异步取、同步读**
 * （deviceText 只读缓存，永不发子进程）。
 *
 * 并发调用只跑一次；失败保持上一次的值。
 */
export async function refreshDevice() {
  if (process.platform !== 'win32') return;
  const now = Date.now();
  if (_dev.at && now - _dev.at < TTL_MS) return;
  if (_refreshing) return;
  _refreshing = true;
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('powershell', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildScript(),
      ], { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });

    let bright = null;
    let vol = null;
    let mute = null;
    const wins = [];
    for (const line of String(out).split(/\r?\n/)) {
      const s = line.trim();
      if (s.startsWith('BRIGHT=')) {
        const v = Number(s.slice(7));
        if (Number.isFinite(v)) bright = Math.round(v);
      } else if (s.startsWith('VOL=')) {
        const v = Number(s.slice(4));
        if (Number.isFinite(v)) vol = Math.round(v);
      } else if (s.startsWith('MUTE=')) {
        mute = s.slice(5).trim() === '1';
      } else if (s.startsWith('WIN=')) {
        const raw = s.slice(4);
        if (wins.length < 12 && raw) wins.push(raw.replace('|', '：'));
      }
    }
    _dev = { at: now, bright, vol, mute, wins };
  } catch {
    /* 问不到就保持上一次；一次都没成功过时全是 null → 上下文里不出现这几行 */
    _dev = { at: now, bright: _dev.bright, vol: _dev.vol, mute: _dev.mute, wins: _dev.wins };
  } finally {
    _refreshing = false;
  }
}

/** 同步读（给 contextMessage 用，绝不发子进程） */
export function deviceText() {
  return {
    bright: _dev.bright,
    vol: _dev.vol,
    mute: _dev.mute,
    wins: Array.isArray(_dev.wins) ? _dev.wins.slice() : [],
  };
}

/** 测试用 */
export function _resetDeviceCache() {
  _dev = { at: 0, bright: null, vol: null, mute: null, wins: [] };
}
