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

async function deploy() {
  fs.mkdirSync(DIR, { recursive: true });
  if (installed()) {
    log('已经装好了：' + DIR);
    writeOneBotConfig();
    return { ok: true, installed: true, dir: DIR };
  }
  const qq = findQQ();
  if (!qq) throw new Error('这台机器上找不到 QQ.exe —— 协议端要挂在一个 QQ 客户端上');

  let ok = false;
  for (const m of MIRRORS) {
    const url = `${m}${NAPCAT_VERSION}/${ASSET}`;
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
  return { ok: true, installed: true, dir: DIR };
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
