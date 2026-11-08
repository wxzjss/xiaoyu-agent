/**
 * 真发鼠标键盘事件 —— PostMessage + SendInput（2026-11-03 重写完整版）。
 *
 * 【两档，默认都不打扰主人】
 *   post    往目标窗口投 WM_LBUTTONDOWN/UP（不激活窗口、不动真鼠标）。
 *           优点：主人在别处打字的时候，这边照样能点。
 *           缺点：有些程序（Chromium 系、游戏）只认真输入，投了没反应 ——
 *                 那才轮到 send 档。
 *   send    先把目标窗口拉到前面（会抢焦点），再发真正的 SendInput。
 *           优点：哪儿都能点。
 *           缺点：会打断主人手上的事。所以**只在必要时显式选**，不是默认。
 *
 * 【为什么不用 cua-driver 那种虚拟光标】
 * Windows 没有系统级的虚拟光标。要「不抢焦点又真的点了」只能二选一：
 * 投消息（post）或者抢焦点（send）。这里两条都给了，默认走不打扰那条。
 *
 * 【PowerShell 老规矩（别踩回去）】
 *  不许出现 try { ... } finally { ... }；不许 JPEG 编码器那套；
 *  不许 $ErrorActionPreference='Stop'；别传 -NonInteractive。
 *  跟 screen-capture.mjs 同一个坑，踩过的。
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uiDir } from './ui-tree.mjs';

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
  if (process.env.XY_TREE_RAW) {
    try {
      writeFileSync(process.env.XY_TREE_DUMP || join(uiDir(), 'act-debug.ps1'), script, 'utf8');
    } catch { /* 落不了就算了 */ }
  }
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64],
      { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(cleanStderr(stderr) || String(err.message || err));
          e.killed = err.killed;
          return reject(e);
        }
        resolve(String(stdout || ''));
      },
    );
  });
}

/**
 * 发事件用的那段代码。
 *
 * 【坐标怎么来的】
 * UIA 的 BoundingRectangle 是**屏幕坐标**；send 档（SendInput 绝对模式）也是屏幕坐标，
 * 直接传。post 档投的是「客户区坐标」，用 ScreenToClient 让系统自己换算 ——
 * 手减会错（不同 DPI、不同窗口样式差的那几个像素不一样）。
 *
 * 【INPUT 结构体为什么这么写】
 * x64 下 INPUT = 40 字节（type 4 + 对齐 4 + union 32）。写错一个字段就是
 * 「点到了别处」或者「什么都没发生」。下面是照 Windows SDK 声明抄的，别改。
 */
/**
 * 【C# 源码里一条中文都不许写】
 * 这段脚本要过 -EncodedCommand（UTF-16LE base64）传给 PowerShell，实测中文进 C# 源码
 * 会被拆行、编出乱码命名空间（报「命名空间 System.Windows 中不存在类型 Form」）。
 * PowerShell 自己的语句里写中文没事，只有 @"…"@ 里面不行。
 */
const CS = `

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)] public struct XyRect { public int left, top, right, bottom; }

public static class XyScreens {
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  public static int Width() { return GetSystemMetrics(0); }
  public static int Height() { return GetSystemMetrics(1); }
}

public class XyAct {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  const uint WM_MOUSEMOVE = 0x0200;
  const uint WM_LBUTTONDOWN = 0x0201;
  const uint WM_LBUTTONUP = 0x0202;
  const uint WM_RBUTTONDOWN = 0x0204;
  const uint WM_RBUTTONUP = 0x0205;
  const uint WM_MOUSEWHEEL = 0x020A;
  const uint MK_LBUTTON = 0x0001;
  const uint MK_RBUTTON = 0x0002;

  const uint MOUSEEVENTF_MOVE = 0x0001;
  const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;

  static IntPtr LP(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }

  public static bool PostClick(IntPtr h, int sx, int sy, bool right, int count) {
    POINT p = new POINT(); p.X = sx; p.Y = sy;
    ScreenToClient(h, ref p);
    uint down = right ? WM_RBUTTONDOWN : WM_LBUTTONDOWN;
    uint up = right ? WM_RBUTTONUP : WM_LBUTTONUP;
    IntPtr lp = LP(p.X, p.Y);
    PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
    for (int i = 0; i < count; i++) {
      PostMessage(h, down, (IntPtr)(right ? MK_RBUTTON : MK_LBUTTON), lp);
      System.Threading.Thread.Sleep(40);
      PostMessage(h, up, IntPtr.Zero, lp);
      if (i + 1 < count) System.Threading.Thread.Sleep(70);
    }
    return true;
  }

  public static bool PostScroll(IntPtr h, int sx, int sy, int notches) {
    POINT p = new POINT(); p.X = sx; p.Y = sy;
    ScreenToClient(h, ref p);
    int delta = notches * 120;
    IntPtr wp = (IntPtr)((delta << 16) & unchecked((int)0xFFFF0000));
    PostMessage(h, WM_MOUSEWHEEL, wp, LP(p.X, p.Y));
    return true;
  }

  static void AbsMove(int sx, int sy) {
    int vx = (int)(sx * 65535.0 / (XyScreens.Width() - 1));
    int vy = (int)(sy * 65535.0 / (XyScreens.Height() - 1));
    INPUT inp = new INPUT();
    inp.type = 0;
    inp.u.mi.dx = vx; inp.u.mi.dy = vy;
    inp.u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
    SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }

  static void MouseBtn(uint down, uint up, int count) {
    for (int i = 0; i < count; i++) {
      INPUT a = new INPUT(); a.type = 0; a.u.mi.dwFlags = down;
      SendInput(1, new INPUT[] { a }, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(40);
      INPUT b = new INPUT(); b.type = 0; b.u.mi.dwFlags = up;
      SendInput(1, new INPUT[] { b }, Marshal.SizeOf(typeof(INPUT)));
      if (i + 1 < count) System.Threading.Thread.Sleep(70);
    }
  }

  public static bool SendClick(int sx, int sy, bool right, int count) {
    AbsMove(sx, sy);
    System.Threading.Thread.Sleep(30);
    MouseBtn(right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN,
             right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP, count);
    return true;
  }

  public static bool SendDrag(int x1, int y1, int x2, int y2, bool right) {
    AbsMove(x1, y1);
    System.Threading.Thread.Sleep(60);
    uint dn = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
    uint up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
    INPUT a = new INPUT(); a.type = 0; a.u.mi.dwFlags = dn;
    SendInput(1, new INPUT[] { a }, Marshal.SizeOf(typeof(INPUT)));
    int steps = 12;
    for (int i = 1; i <= steps; i++) {
      int mx = x1 + (x2 - x1) * i / steps;
      int my = y1 + (y2 - y1) * i / steps;
      AbsMove(mx, my);
      System.Threading.Thread.Sleep(16);
    }
    INPUT b = new INPUT(); b.type = 0; b.u.mi.dwFlags = up;
    SendInput(1, new INPUT[] { b }, Marshal.SizeOf(typeof(INPUT)));
    return true;
  }

  public static bool SendScroll(int notches) {
    INPUT inp = new INPUT();
    inp.type = 0;
    inp.u.mi.dwFlags = MOUSEEVENTF_WHEEL;
    inp.u.mi.mouseData = unchecked((uint)(notches * 120));
    SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
    return true;
  }

  public static bool SendVk(int vk) {
    INPUT a = new INPUT(); a.type = 1; a.u.ki.wVk = (ushort)vk;
    SendInput(1, new INPUT[] { a }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(20);
    INPUT b = new INPUT(); b.type = 1; b.u.ki.wVk = (ushort)vk; b.u.ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(1, new INPUT[] { b }, Marshal.SizeOf(typeof(INPUT)));
    return true;
  }


  public static bool SendVkdown(int vk) {
    INPUT a = new INPUT(); a.type = 1; a.u.ki.wVk = (ushort)vk;
    SendInput(1, new INPUT[] { a }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(20);
    return true;
  }

  public static bool SendVkup(int vk) {
    INPUT b = new INPUT(); b.type = 1; b.u.ki.wVk = (ushort)vk; b.u.ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(1, new INPUT[] { b }, Marshal.SizeOf(typeof(INPUT)));
    System.Threading.Thread.Sleep(20);
    return true;
  }
  public static bool SendText(string s) {
    foreach (char ch in s) {
      INPUT a = new INPUT(); a.type = 1; a.u.ki.wScan = (ushort)ch; a.u.ki.dwFlags = KEYEVENTF_UNICODE;
      SendInput(1, new INPUT[] { a }, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(8);
      INPUT b = new INPUT(); b.type = 1; b.u.ki.wScan = (ushort)ch; b.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      SendInput(1, new INPUT[] { b }, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(8);
    }
    return true;
  }

  public static bool Bring(IntPtr h) {
    ShowWindow(h, 9);
    SetForegroundWindow(h);
    System.Threading.Thread.Sleep(180);
    return GetForegroundWindow() == h;
  }
}
"@
`;

// ---------------------------------------------------------------------------
// 对外动作 —— 全部返回 { ok, via, note }
//   via 告诉你这一下是怎么发的：'post'（投消息，没打扰主人）或 'send'（真输入）
// ---------------------------------------------------------------------------

/**
 * 虚拟键码表。只列常用那些 —— 全表 200 多个没意义，缺的用 vk:数字 直接给。
 */
const VK = {
  enter: 0x0d, return: 0x0d, tab: 0x09, space: 0x20, spacebar: 0x20,
  esc: 0x1b, escape: 0x1b, back: 0x08, backspace: 0x08,
  del: 0x2e, delete: 0x2e, ins: 0x2d, insert: 0x2d,
  home: 0x24, end: 0x23, pgup: 0x21, pageup: 0x21, pgdn: 0x22, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, win: 0x5b, meta: 0x5b,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};

/** 'ctrl+shift+s' / 'enter' / 'f5' / 'vk:192' → 一组虚拟键码。 */
export function parseKeys(spec) {
  const parts = String(spec || '').split('+').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new Error('要给按键，比如 enter、ctrl+c、f5。');
  const codes = [];
  for (const p of parts) {
    if (/^vk:\d+$/.test(p)) {
      const n = Number(p.slice(3));
      if (n > 0 && n < 256) codes.push(n);
      else throw new Error('vk:' + p.slice(3) + ' 不是有效的键码（0~255）。');
    } else if (Object.prototype.hasOwnProperty.call(VK, p)) {
      codes.push(VK[p]);
    } else if (p.length === 1) {
      codes.push(p.toUpperCase().charCodeAt(0));
    } else {
      throw new Error('不认识这个键：' + p + '。常用的有 enter/tab/esc/方向键/f1-f12；组合键写成 ctrl+s；其它用 vk:数字。');
    }
  }
  return codes;
}

/** hwnd 在 PowerShell 里要当 IntPtr 用；超过 int32 得走补码写法。 */
function hx(hwnd) {
  const n = Number(hwnd);
  if (!Number.isFinite(n) || n <= 0) throw new Error('窗口句柄不对。');
  return n > 0x7fffffff ? '(New-Object System.IntPtr(' + n + '))' : '[IntPtr]' + n;
}

/** 拼一段「CS + 调用 + 回 OK」的脚本。 */
function call(callExpr) {
  // 【为什么最后还要再查一次 XyAct 在不在】Add-Type 编译失败不会中断脚本（它只说一句
  // 「Cannot add type」，然后 PowerShell 接着往下跑），最后那句 Write-Output 照样把
  // 空的 $r 拼成「OK 」打出来 —— 调用方看到 OK 就以为点成功了，其实一次事件都没发。
  // 所以先确认类型真的建起来了，没有再喊一嗓子，让调用方看见 ok:false 和原因。
  const GUARD = '\nif (-not ("XyAct" -as [type])) { Write-Output "FAIL 类型没建起来（看上面的编译错误）"; exit 3 }';
  return CS + GUARD + '\n$r = ' + callExpr + '\nWrite-Output ("OK " + $r)\n';
}

/**
 * 点一下。
 * @param {{hwnd:number, x:number, y:number, button?:'left'|'right', count?:number, mode?:'post'|'send'}} o
 */
export async function clickAt(o) {
  const mode = o.mode === 'send' ? 'send' : 'post';
  const right = o.button === 'right';
  const count = Math.max(1, Math.min(3, Number(o.count) || 1));
  const x = Math.round(Number(o.x) || 0);
  const y = Math.round(Number(o.y) || 0);
  const r = right ? 'true' : 'false';
  if (mode === 'send') {
    const out = await ps(call('[XyAct]::SendClick(' + x + ', ' + y + ', $' + r + ', ' + count + ')'), 15000);
    return { ok: /OK True/i.test(out), via: 'send', note: '真鼠标点了一下（屏幕坐标 ' + x + ',' + y + '）' };
  }
  const out = await ps(call('[XyAct]::PostClick(' + hx(o.hwnd) + ', ' + x + ', ' + y + ', $' + r + ', ' + count + ')'), 15000);
  return { ok: /OK True/i.test(out), via: 'post', note: '往窗口里投了一次点击（屏幕坐标 ' + x + ',' + y + '）' };
}

/** 拖拽：从 (x1,y1) 拉到 (x2,y2)。只能走 send —— 投消息做不出拖拽的手感。 */
export async function dragAt(o) {
  const x1 = Math.round(Number(o.x1) || 0);
  const y1 = Math.round(Number(o.y1) || 0);
  const x2 = Math.round(Number(o.x2) || 0);
  const y2 = Math.round(Number(o.y2) || 0);
  const right = o.button === 'right';
  const out = await ps(call('[XyAct]::SendDrag(' + x1 + ', ' + y1 + ', ' + x2 + ', ' + y2 + ', $' + (right ? 'true' : 'false') + ')'), 20000);
  return { ok: /OK True/i.test(out), via: 'send', note: '从 ' + x1 + ',' + y1 + ' 拖到 ' + x2 + ',' + y2 + '（拖拽必须动真鼠标）' };
}

/** 滚轮。notches 正数往下滚，负数往上滚。 */
export async function scrollAt(o) {
  const notches = Math.max(-10, Math.min(10, Number(o.notches) || -3));
  if (o.mode === 'send') {
    const out = await ps(call('[XyAct]::SendScroll(' + notches + ')'), 15000);
    return { ok: /OK True/i.test(out), via: 'send', note: '滚了 ' + notches + ' 格（真滚轮）' };
  }
  const x = Math.round(Number(o.x) || 0);
  const y = Math.round(Number(o.y) || 0);
  const out = await ps(call('[XyAct]::PostScroll(' + hx(o.hwnd) + ', ' + x + ', ' + y + ', ' + notches + ')'), 15000);
  return { ok: /OK True/i.test(out), via: 'post', note: '往窗口里投了 ' + notches + ' 格滚轮' };
}

/**
 * 按键。**必须窗口在前台**（键盘没有「投给某个窗口」这回事；
 * 用 PostMessage 发 WM_KEYDOWN 对现代程序基本无效，别指望）。
 */
export async function sendKeys(o) {
  const codes = parseKeys(o.keys);
  const last = codes[codes.length - 1];
  const mods = codes.slice(0, -1);
  const lines = mods.map((c) => '[void][XyAct]::SendVkdown(' + c + ')');
  lines.push('[void][XyAct]::SendVk(' + last + ')');
  for (let i = mods.length - 1; i >= 0; i--) lines.push('[void][XyAct]::SendVkup(' + mods[i] + ')');
  const out = await ps(CS + '\n' + lines.join('\n') + '\nWrite-Output "OK True"\n', 15000);
  return { ok: /OK True/i.test(out), via: 'send', note: '按了 ' + String(o.keys) };
}

/** 打字（逐字 unicode，中文也行）。**必须窗口在前台**。 */
export async function typeText(o) {
  const text = String(o.text ?? '');
  if (!text) throw new Error('没有要打的字。');
  if (text.length > 2000) throw new Error('一次最多打 2000 字（太长了容易打到一半跑偏）。');
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const set = '$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + b64 + '"))';
  const out = await ps(CS + '\n' + set + '\n[void][XyAct]::SendText($t)\nWrite-Output "OK True"\n', 30000);
  return { ok: /OK True/i.test(out), via: 'send', note: '打了 ' + text.length + ' 个字' };
}

/** 把窗口拉到前面。只有键盘类动作需要，鼠标 post 档不需要。 */
export async function bringToFront(hwnd) {
  const out = await ps(call('[XyAct]::Bring(' + hx(hwnd) + ')'), 12000);
  const ok = /OK True/i.test(out);
  return { ok, note: ok ? '窗口已经在前面了' : '没拉到前面（可能被系统拦了）' };
}
