/**
 * mac 上的 NapCat（QQ 协议端）—— 探测、拉起、找二维码。
 *
 * 【为什么单开一个文件】
 * Windows 上 NapCat 是「一个独立的 boot exe + 一个自己的目录」，装哪、跑没跑、
 * 二维码落哪儿，三件事都能用一个路径回答。mac 完全不是这个形状：
 *
 *   · 没有 NapCatWinBootMain.exe。NapCat 是**改 QQ 入口**注入进 QQ.app 的，
 *     官方给的是一支 xcode 写的 NapCat-Mac-Installer，动手改/还原入口由它负责；
 *   · 配置、插件、缓存都在 QQ 自己的容器里：
 *       ~/Library/Containers/com.tencent.qq/Data/Documents/napcat
 *   · 拉起就是「启动 QQ」——入口已经被改成 NapCat 了，没有第二个进程；
 *   · 因此「在跑」只能靠 QQ 主进程 + 3001 端口两个信号合起来判。
 *
 * 这些差异不适合塞进 scripts/qq-protocol.mjs（那个文件通篇是 LOCALAPPDATA、
 * cmd、tasklist、Expand-Archive），所以在这边单独实现，再由它转调。
 *
 * 【不假装能自动安装】
 * mac 装 NapCat 必须走官方安装器（要改 QQ 入口、首次还要在「隐私与安全性 →
 * App 管理」里授权）。我们没有签名、也不该替主人点系统授权，所以这里只做到
 * 「把安装器下载页打开 + 装完能认出来 + 能启动」，不替它静默改 QQ。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const QQ_APP = '/Applications/QQ.app';

/** 安装器下载页（官方仓库的 release 列表）。 */
export const MAC_INSTALLER_URL = 'https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest';

/**
 * NapCat 在 mac 上可能落在哪些目录。
 *
 * 第一个是官方安装器写的（配置和插件都在那儿，更新时保留）；
 * 后两个是旧教程/手工注入留下的位置，留着不亏 —— 认出来就能直接用。
 */
export function macNapcatRoots() {
  const home = os.homedir();
  const list = [
    path.join(home, 'Library', 'Containers', 'com.tencent.qq', 'Data', 'Documents', 'napcat'),
    path.join(home, 'Library', 'Application Support', 'QQ', 'napcat'),
    path.join(home, 'NapCat'),
    path.join(QQ_APP, 'Contents', 'Resources', 'app', 'napcat'),
  ];
  /* 手工指定/验证用：XIAOYU_NAPCAT_ROOT 指向哪个目录就先认它。
   * 有了它，验收脚本不用去动主人真实的 QQ 容器。 */
  const env = String(process.env.XIAOYU_NAPCAT_ROOT || '').trim();
  if (env) list.unshift(env);
  return list;
}

/** 目录里有没有 NapCat 的痕迹（空目录不算装过）。 */
function looksLikeNapCat(dir) {
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    if (!ents.length) return false;
    return ents.some((e) =>
      (e.isDirectory() && /^(config|cache|plugins|temp)$/i.test(e.name))
      || (e.isFile() && /^(napcat|qqnt|onebot11)\.(mjs|json|js)$/i.test(e.name)));
  } catch {
    return false;
  }
}

/**
 * 找到装好的 NapCat。
 *
 * 返回 { found, dir, qrDirs }
 *   qrDirs：二维码可能落的目录，按可能性排序（qq-qrcode 会挨个试）
 */
export function detectMacNapCat() {
  for (const dir of macNapcatRoots()) {
    if (!looksLikeNapCat(dir)) continue;
    // 二维码：NapCat 自己会写 cache/qrcode.png；有的版本落在 temp/ 下
    const qrDirs = [
      path.join(dir, 'cache'),
      path.join(dir, 'temp'),
      dir,
    ].filter((d) => fs.existsSync(d));
    return { found: true, dir, qrDirs };
  }
  return { found: false, dir: '', qrDirs: [] };
}

/** 一个端口上有没有人在听（比 http 探测更干净：不挑协议）。 */
export function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

/**
 * QQ 主进程在不在（mac 上 NapCat 就跑在这个进程里）。
 *
 * 用同步的 execFileSync：installed()/running() 是同步接口，status() 每两秒被
 * 面板拉一次，别为了这一个信号把整条链路改成 async。
 */
export function qqRunning() {
  try {
    const out = execFileSync('pgrep', ['-x', 'QQ'], { timeout: 4000, encoding: 'utf8' });
    return String(out || '').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * mac 上「协议端在跑」= QQ 开着 **且** NapCat 装过。
 *
 * 只看 QQ 进程会骗人：原版 QQ 也开着，主人会以为协议端好了。
 * 只看 3001 也不够：没登录时端口就是不开，但那不代表没跑起来。
 */
export function macNapCatRunning() {
  const cat = detectMacNapCat();
  if (!cat.found) return false;
  return qqRunning();
}

/**
 * 拉起：mac 上就是「打开 QQ」。
 *
 * 入口已经被安装器改成 NapCat，所以不需要额外参数；已经开着的话 `open -a`
 * 只是把窗口提到前面，不会开第二个实例（QQ 自己有单实例锁）。
 */
export async function launchMacNapCat({ waitMs = 20000 } = {}) {
  if (!fs.existsSync(QQ_APP)) {
    return { ok: false, error: '没装 QQ（/Applications/QQ.app）。先装 QQ，再装 NapCat 安装器。' };
  }
  const cat = detectMacNapCat();
  if (!cat.found) {
    return {
      ok: false,
      needsInstaller: true,
      url: MAC_INSTALLER_URL,
      error: '这台机器还没装 NapCat。mac 上要先用官方安装器把它装进 QQ.app（要改 QQ 入口并授权，这一步只能你点）。',
    };
  }
  try {
    await run('open', ['-a', QQ_APP], { timeout: 8000 });
  } catch (e) {
    return { ok: false, error: '启动 QQ 失败：' + String(e?.message ?? e) };
  }

  // 等 3001 开门：扫码登录成功后 NapCat 才会把 WebSocket 服务端拉起来
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    if (await portOpen(3001)) {
      return { ok: true, started: true, port: 3001, dir: cat.dir, waitedMs: Date.now() - t0 };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    ok: true,
    started: true,
    port: 0,
    dir: cat.dir,
    note: 'QQ 起来了，但 3001 还没开 —— 多半是还没扫码登录。扫完它自己会开。',
  };
}

/** 打开官方安装器下载页（mac 上「准备协议端」在没装时干这个）。 */
export async function openMacInstallerPage() {
  try {
    await run('open', [MAC_INSTALLER_URL], { timeout: 8000 });
    return { ok: true, opened: true, url: MAC_INSTALLER_URL };
  } catch (e) {
    return { ok: false, url: MAC_INSTALLER_URL, error: String(e?.message ?? e) };
  }
}

/** 面板上给主人看的一句话（按真实现状说，不编）。 */
export async function macNapCatState() {
  const cat = detectMacNapCat();
  const qq = qqRunning();
  const ws = await portOpen(3001);
  const webui = await portOpen(6099);
  return {
    platform: 'darwin',
    installed: cat.found,
    running: cat.found && qq,
    qqRunning: qq,
    websocket: ws,
    webui,
    dir: cat.dir || '',
    qqApp: fs.existsSync(QQ_APP) ? QQ_APP : '',
    installerUrl: MAC_INSTALLER_URL,
  };
}
