/**
 * QQ 协议端（NapCat）的一键化。
 *
 * 设计原则：**绝不提权**。
 * NapCat 自带的 launcher.bat 会弹 UAC，让主人点「是」—— 那是它自己的选择，
 * 不是必须的。协议端和你的 QQ 在同一个权限级别上跑，照样工作；
 * 而且不提权的话，出事了我们还能自己收掉它。
 *
 * 用法：
 *   node scripts/qq-protocol.mjs status    # 看装没装、跑没跑
 *   node scripts/qq-protocol.mjs deploy    # 下载 + 解压 + 预写配置（只做一次）
 *   node scripts/qq-protocol.mjs start     # 拉起（不弹 UAC）
 *   node scripts/qq-protocol.mjs kill      # 收掉
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

const NAPCAT_VERSION = 'v4.18.41';
const MIRRORS = [
  'https://gh-proxy.com/https://github.com/NapNeko/NapCatQQ/releases/download/',
  'https://ghproxy.net/https://github.com/NapNeko/NapCatQQ/releases/download/',
  'https://github.com/NapNeko/NapCatQQ/releases/download/',
];
const ASSET = 'NapCat.Shell.Windows.Node.zip';

function dataDir() {
  if (process.env.MINI_AGENT_DATA) return process.env.MINI_AGENT_DATA;
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '小鱼Agent', 'data');
}

/**
 * 协议端装哪儿？
 *
 * 一定要纯英文路径。原因：NapCat 的启动器是 .bat，cmd.exe 按 ANSI/GBK 解码，
 * 一旦路径里有中文（比如 小鱼Agent），
 *   ① 我们自己写 .bat 会被它读成乱码；
 *   ② NapCat 内部 spawn 子进程时也会踩同一个坑。
 * 所以这里避开 %APPDATA%\小鱼Agent，改用 %LOCALAPPDATA%\XiaoyuAgent\qq-protocol。
 */
const DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'XiaoyuAgent', 'qq-protocol',
);
const ZIP = path.join(DIR, '_download.zip');
const RUNNER = path.join(DIR, '_run.bat');

const log = (...a) => console.log('[qq-protocol]', ...a);
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

/** QQ 装在哪。协议端要挂在它身上。 */
function findQQ() {
  const cands = [
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tencent', 'QQNT', 'QQ.exe'),
  ];
  return cands.find(exists) || '';
}


/* 【2026-10-31 主人要】自动检测 QQ 版本，别再写死。
 *
 * 老问题：NAPCAT_VERSION 写死 v4.18.41，它配的是 QQ 9.9.22；
 * 主人 QQ 一升到 9.9.33，qqnt.json 就对不上，3001 死活不开，
 * 界面只报「连不上」，人根本猜不到是版本号的事。
 * 现在改成：先看本机 QQ 是几版，再去找能配它的 NapCat。
 */

/** 本机 QQ 的 build 号（52230 这种）。读不到就给空串，绝不抛。 */
/**
 * 读本机 QQ 的 build 号 —— 【2026-10-31 修】读 versions 目录，别读 QQ.exe。
 *
 * 踩过的坑：QQ 升级之后，QQ.exe 的版本资源还停在老版本（实测 exe 说 52230，
 * 实际装的目录是 9.9.36-53644）。按 exe 报数会一路错到底，
 * 拿错的号去挑协议端，永远挑不对。
 *
 * 真正的答案在 <QQNT>\versions\<版本号>\resources\app\package.json。
 * versions 下如果有多个，挑最新的那个（按目录修改时间）。
 */
export function detectQqBuild() {
  const exe = findQQ();
  if (!exe) return '';
  const dir = path.dirname(exe);
  const vs = path.join(dir, 'versions');
  try {
    if (fs.existsSync(vs)) {
      const subs = fs.readdirSync(vs, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const full = path.join(vs, d.name);
          let mt = 0;
          try { mt = fs.statSync(full).mtimeMs; } catch {}
          return { name: d.name, full, mt };
        })
        .sort((a, b) => b.mt - a.mt);
      for (const sub of subs) {
        // ① 目录名本身就是版本号：9.9.36-53644
        const byName = sub.name.match(/-(\d{4,6})$/);
        if (byName) return byName[1];
        // ② 退一步读它自己的 package.json
        try {
          const pj = path.join(sub.full, 'resources', 'app', 'package.json');
          if (fs.existsSync(pj)) {
            const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
            const b = String(j.buildVersion || j.version || '').match(/(\d{4,6})/);
            if (b) return b[1];
          }
        } catch {}
      }
    }
  } catch {}
  // ③ 最后的退路：老办法读 exe（至少比没有强）
  try {
    const ps = "(Get-Item '" + exe.split("'").join("''") + "').VersionInfo.FileVersion";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 8000 });
    const m = String(out).match(/\d{4,6}/g);
    if (m && m.length) return m[m.length - 1];
  } catch {}
  return '';
}


/** 挑一个能配本机 QQ 的 release。 */
/** 取最新那个 release 的 tag。
 *
 * 【为什么不去猜它配哪个 QQ】试过读说明里的版本号 —— 里面全是 commit 哈希，
 * 猜出来的东西是假的，比不知道还坏。所以不猜：直接拿最新版，
 * 装完读它自己 qqnt.json 里的 version，再跟本机 QQ 比，对不上就照实说。
 */
async function pickRelease() {
  try {
    const r = await fetch("https://api.github.com/repos/NapNeko/NapCatQQ/releases?per_page=5", {
      headers: { 'User-Agent': 'xiaoyu-agent', Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) return null;
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) return null;
    return { tag: list[0].tag_name };
  } catch { return null; }
}
function installed() {
  return exists(path.join(DIR, 'NapCatWinBootMain.exe')) && exists(path.join(DIR, 'napcat', 'napcat.mjs'));
}

function running() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq NapCatWinBootMain.exe', '/NH'], { encoding: 'utf8' });
    return /NapCatWinBootMain/i.test(out);
  } catch { return false; }
}

async function download(url, to) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(to);
  let got = 0;
  let lastPrint = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    out.write(chunk);
    if (Date.now() - lastPrint > 2000) {
      lastPrint = Date.now();
      const pct = total ? Math.round((got / total) * 100) : 0;
      log(`  ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB  (${pct}%)`);
    }
  }
  await new Promise((r) => out.end(r));
  if (total && got < total * 0.98) throw new Error(`下得不完整：${got}/${total}`);
  return got;
}

/**
 * 预写 OneBot 配置，让 WebSocket 服务端（3001）一登录就开着。
 * NapCat 读的是 <它的配置目录>/onebot11.json —— 我们放在 config/ 下当默认值，
 * 它第一次登录时会照着这份抄一份 <QQ号>.json。
 */
function writeOneBotConfig() {
  const cfgDir = path.join(DIR, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const onebot = {
    network: {
      httpServers: [],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [{
        name: 'xiaoyu',
        enable: true,
        host: '127.0.0.1',
        port: 3001,
        messagePostFormat: 'array',
        reportSelfMessage: false,
        token: '',
        enableForcePushEvent: true,
        debug: false,
        heartInterval: 30000,
      }],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
  };
  fs.writeFileSync(path.join(cfgDir, 'onebot11.json'), JSON.stringify(onebot, null, 2), 'utf8');
  const napcat = {
    fileLog: true, consoleLog: true, fileLogLevel: 'info', consoleLogLevel: 'info',
    packetBackend: 'auto', packetServer: '', o3HookMode: 1, autoTimeSync: true,
    bypass: { hook: false, window: false, module: false, process: false, container: false, js: false },
  };
  fs.writeFileSync(path.join(cfgDir, 'napcat.json'), JSON.stringify(napcat, null, 2), 'utf8');
}

/** 取一个路径的 8.3 短名（cmd.exe 只认 ANSI，中文路径会被它按 GBK 读成乱码）。 */
function shortPath(p) {
  try {
    if (!exists(p)) return p;
    const isDir = fs.statSync(p).isDirectory();
    const meth = isDir ? 'GetFolder' : 'GetFile';
    // 让 PowerShell 用 UTF-8 输出，否则中文路径回来就是乱码
    const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
      + `$f = New-Object -ComObject Scripting.FileSystemObject; $f.${meth}('${p.replace(/'/g, "''")}').ShortPath`;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    const s = String(out).trim();
    if (s && !/[\ufffd\u4e00-\u9fa5]/.test(s) && /^[A-Za-z]:\\/.test(s)) return s;
  } catch {}
  // 退路：把一个已知的子目录短名剥出来（Roaming\<8.3>\data\qq-protocol）
  try {
    const parts = p.split(path.sep);
    const roaming = parts.indexOf('Roaming');
    if (roaming > 0 && parts[roaming + 1]) {
      const ps2 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
        + `$f = New-Object -ComObject Scripting.FileSystemObject; $f.GetFolder('${parts.slice(0, roaming + 2).join(path.sep)}').ShortPath`;
      const base = String(execFileSync('powershell', ['-NoProfile', '-Command', ps2], { encoding: 'utf8', windowsHide: true })).trim();
      if (base && !/[\ufffd\u4e00-\u9fa5]/.test(base)) return [base, ...parts.slice(roaming + 2)].join(path.sep);
    }
  } catch {}
  return p;
}

/** 写一个不提权的启动器。代替官方 launcher.bat（那个会弹 UAC）。 */
function writeRunner(qqPath) {
  // 关键：cmd.exe 按 GBK 解 .bat，路径里有中文（小鱼Agent）会变乱码。
  // 所以这里全部用 8.3 短路径，退化成纯 ASCII，谁也解不坏。
  const D = shortPath(DIR);
  const Q = shortPath(qqPath);
  const bat = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `cd /d "${D}" || exit /b 1`,
    `set "NAPCAT_PATCH_PACKAGE=${D}\\qqnt.json"`,
    `set "NAPCAT_LOAD_PATH=${D}\\loadNapCat.js"`,
    `set "NAPCAT_INJECT_PATH=${D}\\NapCatWinBootHook.dll"`,
    `set "NAPCAT_MAIN_PATH=${D}\\napcat\\napcat.mjs"`,
    `"${D}\\NapCatWinBootMain.exe" "${Q}" "${D}\\NapCatWinBootHook.dll" -q ${D}\\qqnt.json`,
    'exit /b %ERRORLEVEL%',
  ].join('\r\n');
  fs.writeFileSync(RUNNER, bat, 'latin1');
  return RUNNER;
}


/** 已装的那份协议端配的是哪版 QQ（读它自己的 qqnt.json）。 */
function installedBuild() {
  try {
    const p = path.join(DIR, 'qqnt.json');
    if (!fs.existsSync(p)) return '';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const v = String(j.version || '');
    return v.split('-').pop() || '';
  } catch { return ''; }
}
async function deploy() {
  fs.mkdirSync(DIR, { recursive: true });
  const qq = findQQ();
  if (!qq) throw new Error('这台机器上找不到 QQ.exe —— 协议端要挂在一个 QQ 客户端上');

  // 【2026-10-31 主人要】装过不等于装对了：QQ 一升级，老协议端就对不上。
  // 所以这里每次都先看本机 QQ 是几版，再看装好的那份配的是几版。
  const qqBuild = detectQqBuild();
  const haveBuild = installedBuild();
  log(`本机 QQ：${qqBuild || "没读出来"}   已装协议端配的：${haveBuild || "没读过"}`);

  if (installed() && qqBuild && haveBuild && qqBuild === haveBuild) {
    log('已经装好了，版本也对得上：' + DIR);
    writeOneBotConfig();
    return { ok: true, installed: true, dir: DIR, qqBuild, napcatBuild: haveBuild, upToDate: true };
  }

  const NEED_UPGRADE = installed();
  if (NEED_UPGRADE) {
    log(`版本对不上（QQ ${qqBuild} ≠ 协议端 ${haveBuild}），换一份能配上的`);
  }

  const pick = await pickRelease().catch(() => null);
  const TAG = pick && pick.tag ? pick.tag : NAPCAT_VERSION;
  if (pick) log(`用最新那版：${TAG}`);

  let ok = false;
  for (const m of MIRRORS) {
    const url = `${m}${TAG}/${ASSET}`;
    try {
      log('下载：' + url);
      await download(url, ZIP);
      ok = true;
      log('下载完成');
      break;
    } catch (e) {
      log('这条线不行：' + e.message);
      fs.rmSync(ZIP, { force: true });
    }
  }
  if (!ok) throw new Error('三条线都下不动，网络被挡了');
  log('解压中…');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${DIR}' -Force`], { stdio: 'inherit' });
  fs.rmSync(ZIP, { force: true });
  writeOneBotConfig();
  log('装好了：' + DIR);
  return { ok: true, installed: true, dir: DIR, qqBuild, napcatTag: TAG, upgraded: NEED_UPGRADE };
}

function start() {
  if (!installed()) throw new Error('还没装：先点「准备协议端」');
  if (running()) return { ok: true, already: true };
  const qq = findQQ();
  if (!qq) throw new Error('找不到 QQ.exe');
  writeRunner(qq);
  // 不提权：直接 spawn，stdio 忽略，detach 让它活着
  const child = spawn('cmd.exe', ['/c', RUNNER], {
    cwd: DIR, detached: true, stdio: 'ignore', windowsHide: false,
  });
  child.unref();
  log('已放开（不提权）。等它弹 QQ 窗口扫码。');
  return { ok: true, started: true, pid: child.pid };
}

function kill() {
  try {
    execFileSync('taskkill', ['/F', '/T', '/IM', 'NapCatWinBootMain.exe'], { stdio: 'ignore' });
    return { ok: true, killed: true };
  } catch {
    return { ok: true, killed: false };
  }
}

async function status() {
  let webui = false;
  try {
    const r = await fetch('http://127.0.0.1:6099/webui', { signal: AbortSignal.timeout(2000) });
    webui = r.ok || r.status < 500;
  } catch {}
  let ws = false;
  try {
    const c = new WebSocket('ws://127.0.0.1:3001');
    await new Promise((res, rej) => {
      c.addEventListener('open', res, { once: true });
      c.addEventListener('error', rej, { once: true });
      setTimeout(() => rej(new Error('timeout')), 2000);
    });
    ws = true;
    try { c.close(); } catch {}
  } catch {}
  return {
    ok: true,
    installed: installed(),
    running: running(),
    webui,
    websocket: ws,
    dir: DIR,
    qq: findQQ(),
  };
}

export { deploy, start, kill, status, installed, running, DIR };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const cmd = process.argv[2] || 'status';
  try {
    if (cmd === 'deploy') log(JSON.stringify(await deploy()));
    else if (cmd === 'start') log(JSON.stringify(start()));
    else if (cmd === 'kill') log(JSON.stringify(kill()));
    else log(JSON.stringify(await status(), null, 2));
  } catch (e) {
    log('出错：' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}
