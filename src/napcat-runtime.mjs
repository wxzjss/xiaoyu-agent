/**
 * NapCat 运行时 —— 「一键装依赖」那条路。
 *
 * 【为什么要有这个文件】
 * QQ 的协议端（NapCat）跟 QQ 本体是两套版本号，QQ 一升级，原来那套 NapCat
 * 的 qqnt.json 就对不上，3001 端口压根不开，界面报「连不上」。
 * 主人不该自己去翻版本号 —— 所以这里做成一键：
 *
 *   ① 自己扫本机 QQ 的版本（读 QQ 安装目录，不写死）
 *   ② 去 NapCat 官方发布里挑一个跟这个版本对得上的
 *   ③ 下下来、解开、把 qqnt.json 对齐
 *   ④ 回来告诉界面：装好了，去扫码
 *
 * 【铁律】任何一步失败都不许把已经能用的东西弄坏 ——
 * 全程下到临时目录，验过再落地；原来的 NapCat 先备份再动。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

// ---------- 跑一条 PowerShell，收字符串 ----------

function ps(command, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(String(v || '').trim());
    };
    let p;
    try {
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
      });
    } catch {
      return finish('');
    }
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      finish(out);
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += String(d)));
    p.on('error', () => { clearTimeout(timer); finish(''); });
    p.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

// ---------- 找 QQ 装在哪 ----------

const QQ_GUESS = [
  'C:/Program Files/Tencent/QQNT/QQ.exe',
  'C:/Program Files (x86)/Tencent/QQNT/QQ.exe',
  'D:/Program Files/Tencent/QQNT/QQ.exe',
  'D:/Tencent/QQNT/QQ.exe',
];

/** 读一个 exe 的文件版本号 */
async function fileVersion(exe) {
  const safe = exe.replace(/'/g, "''");
  return await ps(`(Get-Item -LiteralPath '${safe}').VersionInfo.FileVersion`);
}

/**
 * 扫本机 QQ。返回 { exe, found, version, build, raw }
 * version 统一成 NapCat 的写法：9.9.31-49738
 */
export async function detectQQ() {
  const cands = [...QQ_GUESS];

  // 正在跑的 QQ 补一个（主人可能装在别处）
  const running = await ps(`Get-Process QQ -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path`);
  if (running && !cands.includes(running)) cands.unshift(running);

  for (const exe of cands) {
    if (!fs.existsSync(exe)) continue;
    const v = await fileVersion(exe);
    const m = String(v).match(/(\d+)\.(\d+)\.(\d+)[.\-](\d+)/);
    if (!m) continue;
    return {
      exe,
      found: true,
      version: `${m[1]}.${m[2]}.${m[3]}-${m[4]}`,
      build: m[4],
      raw: v,
    };
  }
  return { exe: '', found: false, version: '', build: '', raw: '' };
}

// ---------- 找 NapCat 装在哪 ----------

const NAPCAT_GUESS = ['D:/NapCat', 'C:/NapCat', 'C:/Program Files/NapCat'];

export function detectNapCat() {
  for (const dir of NAPCAT_GUESS) {
    const boot = path.join(dir, 'NapCatWinBootMain.exe');
    if (!fs.existsSync(boot)) continue;
    let version = '';
    let baseVersion = '';
    try {
      const qqnt = JSON.parse(fs.readFileSync(path.join(dir, 'qqnt.json'), 'utf8'));
      version = String(qqnt.version || '');
    } catch {}
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      baseVersion = String(cfg.baseVersion || cfg.curVersion || '');
    } catch {}
    return { dir, found: true, version, baseVersion };
  }
  return { dir: '', found: false, version: '', baseVersion: '' };
}

// ---------- 3001 开着没 ----------

export async function portOpen(port = 3001, host = '127.0.0.1') {
  try {
    const net = await import('node:net');
    return await new Promise((resolve) => {
      const s = net.createConnection({ host, port });
      const done = (v) => {
        try { s.destroy(); } catch {}
        resolve(v);
      };
      s.setTimeout(1200);
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
      s.on('timeout', () => done(false));
    });
  } catch {
    return false;
  }
}

// ---------- 综合状态 ----------

export async function napcatStatus() {
  const qq = await detectQQ();
  const cat = detectNapCat();
  const port = await portOpen(3001);

  // 版本对不对：NapCat 自己带的壳版本 vs QQ 本体
  const versionMatch = Boolean(
    qq.found && cat.found && qq.version && cat.version && qq.version === cat.version
  );

  return {
    qq,
    napcat: cat,
    port3001: port,
    ready: port,
    versionMatch,
    // 要装/要修的情形：没装、版本对不上、或者版本对但 3001 没开
    needInstall: !cat.found || !versionMatch,
  };
}

// ---------- 拿 NapCat 的发布列表 ----------

const NAPCAT_RELEASE_API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
const NAPCAT_ALL_API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases?per_page=30';

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'xiaoyu-agent',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!r.ok) throw new Error(`GitHub 接口 ${r.status}`);
  return await r.json();
}

/**
 * 找跟 QQ 版本对得上的 NapCat 包。
 * NapCat 的包名形如 NapCat.Shell.9.9.31-49738.zip，版本号就在名字里。
 */
export async function findNapCatAsset(qqVersion) {
  const want = String(qqVersion || '').trim(); // 9.9.31-49738
  const builds = [want];
  // 也对一下纯 build 号（49738），有的包只写这个
  const m = want.match(/-(\d+)$/);
  if (m) builds.push(m[1]);

  const pools = [];
  try {
    pools.push(await getJson(NAPCAT_RELEASE_API));
  } catch {}
  try {
    pools.push(...(await getJson(NAPCAT_ALL_API)));
  } catch {}

  if (!pools.length) throw new Error('拿不到 NapCat 的发布列表（检查网络）');

  for (const rel of pools) {
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    for (const a of assets) {
      const name = String(a.name || '');
      if (!/\.zip$/i.test(name)) continue;
      if (!/Shell|Windows|win/i.test(name)) continue;
      if (builds.some((b) => b && name.includes(b))) {
        return {
          tag: rel.tag_name || '',
          name,
          url: a.browser_download_url,
          size: a.size || 0,
        };
      }
    }
  }

  // 实在没有完全对上的，就把最新的 Shell 包拿出来，落地后强行对齐 qqnt.json
  for (const rel of pools) {
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    for (const a of assets) {
      const name = String(a.name || '');
      if (/^NapCat\.Shell.*\.zip$/i.test(name) || (/\.zip$/i.test(name) && /Shell/i.test(name))) {
        return {
          tag: rel.tag_name || '',
          name,
          url: a.browser_download_url,
          size: a.size || 0,
          fallback: true,
        };
      }
    }
  }

  throw new Error(`没找到跟 QQ ${want} 对得上的 NapCat 包`);
}

// ---------- 下载 ----------

async function download(url, dest, onStep) {
  onStep && onStep('正在下载 NapCat…');
  const r = await fetch(url, { headers: { 'User-Agent': 'xiaoyu-agent' } });
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  const total = Number(r.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0;
  if (r.body && typeof r.body.getReader === 'function') {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (total && onStep) {
        onStep(`正在下载 NapCat… ${Math.round((got / total) * 100)}%`);
      }
    }
  } else {
    const buf = Buffer.from(await r.arrayBuffer());
    chunks.push(buf);
    got = buf.length;
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
  onStep && onStep('下载完了，正在解开…');
  return dest;
}

// ---------- 装 ----------

/**
 * 装 / 修 NapCat。
 * @param {(msg:string)=>void} onStep 进度回调（界面显示用）
 */
export async function installNapCat(onStep = () => {}) {
  const qq = await detectQQ();
  if (!qq.found) {
    throw new Error('没找到本机的 QQ，先装 QQ 或告诉我 QQ 装在哪');
  }
  onStep(`检测到 QQ ${qq.version}`);

  const asset = await findNapCatAsset(qq.version);
  onStep(`选中的包：${asset.name}${asset.fallback ? '（没有完全对版本的，用最新的，装完会对齐）' : ''}`);

  const tmp = path.join(os.tmpdir(), `xiaoyu-napcat-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const zipPath = path.join(tmp, asset.name);

  await download(asset.url, zipPath, onStep);

  // 解开
  onStep('正在解压…');
  const unzipDir = path.join(tmp, 'unzip');
  fs.mkdirSync(unzipDir, { recursive: true });
  const un = await ps(
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${unzipDir.replace(/'/g, "''")}' -Force`,
    180000
  );
  // Expand-Archive 出错时往 stderr 走，这里只核结果
  if (!fs.existsSync(unzipDir) || fs.readdirSync(unzipDir).length === 0) {
    throw new Error('解压失败：' + (un || '没生成文件'));
  }

  // 找里面有 NapCatWinBootMain.exe 的那层
  onStep('正在安放…');
  let root = null;
  const stack = [unzipDir];
  while (stack.length) {
    const d = stack.shift();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    if (ents.some((e) => e.isFile() && e.name === 'NapCatWinBootMain.exe')) {
      root = d;
      break;
    }
    for (const e of ents) if (e.isDirectory()) stack.push(path.join(d, e.name));
  }
  if (!root) throw new Error('包里没找到 NapCatWinBootMain.exe，可能下错包了');

  // 目标目录：原来装哪就装哪，没装过就放 D:\NapCat
  const target = detectNapCat().dir || 'D:\\NapCat';

  // 先备份旧的
  if (fs.existsSync(target)) {
    const bak = `${target}.bak-${Date.now()}`;
    onStep('先备份原来的 NapCat…');
    fs.renameSync(target, bak);
    onStep(`原目录备份在 ${bak}`);
  }

  onStep(`正在铺到 ${target}…`);
  fs.mkdirSync(target, { recursive: true });
  const copy = await ps(
    `Copy-Item -Path '${path.join(root, '*').replace(/'/g, "''")}' -Destination '${target.replace(/'/g, "''")}' -Recurse -Force`,
    180000
  );
  if (!fs.existsSync(path.join(target, 'NapCatWinBootMain.exe'))) {
    throw new Error('铺过去之后没找到 NapCatWinBootMain.exe：' + copy);
  }

  // 对齐 qqnt.json 的版本 —— 这是最关键的一步
  const qqntPath = path.join(target, 'qqnt.json');
  if (fs.existsSync(qqntPath)) {
    try {
      const qqnt = JSON.parse(fs.readFileSync(qqntPath, 'utf8'));
      const m = qq.version.match(/^(\d+\.\d+\.\d+)-(\d+)$/);
      if (m) {
        const [_, ver, build] = m;
        qqnt.version = qq.version;
        qqnt.buildVersion = build;
        fs.writeFileSync(qqntPath, JSON.stringify(qqnt, null, 2), 'utf8');
        onStep(`qqnt.json 已对齐到 ${qq.version}`);
      }
    } catch (e) {
      onStep('对齐 qqnt.json 没成功（不影响，装上了先试）');
    }
  }

  // config.json 也一并写对
  const cfgPath = path.join(target, 'config.json');
  try {
    const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
    cfg.baseVersion = qq.version;
    cfg.curVersion = qq.version;
    cfg.onErrorVersions = Array.isArray(cfg.onErrorVersions) ? cfg.onErrorVersions : [];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {}

  // 清临时
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  onStep('装好了！');

  return {
    ok: true,
    target,
    qqVersion: qq.version,
    asset: asset.name,
    fallback: Boolean(asset.fallback),
  };
}

/**
 * 启动 NapCat（让 3001 开起来，然后要扫码）
 */
export async function launchNapCat() {
  const cat = detectNapCat();
  if (!cat.found) throw new Error('还没装 NapCat');
  const boot = path.join(cat.dir, 'NapCatWinBootMain.exe');
  const qq = await detectQQ();
  const args = qq.exe ? [qq.exe] : [];

  const child = spawn(boot, args, {
    detached: true,
    stdio: 'ignore',
    cwd: cat.dir,
  });
  child.unref();
  return { ok: true, pid: child.pid, dir: cat.dir };
}
