/**
 * 自动更新 —— 真正的落地动作：查最新发行版、把安装包下下来、校验、静默重装。
 *
 * 【为什么是「下安装包重装」，而不是「逐个文件覆盖」】
 * 以前 updater.mjs 走的是「按白名单逐个文件覆盖」：src/、public/、persona/…
 * 这条路有三个治不好的毛病，全部实测踩过：
 *
 *   1. 分支写死。`BRANCH = 'main'` 而代码一直推在 master，origin/main 停在 0.9.28，
 *      于是每次检查都判「我比线上新」，静默不更新，不报错不提示 —— 主人以为自动更新
 *      从来没用过，其实是它一直在跑，只是永远得出「不用更新」。
 *   2. 依赖跟不上。代码换个 import 就多一个包，逐文件覆盖只盖代码不带 node_modules，
 *      于是新包能启动、某个功能一用就 "Cannot find package 'ws'"。
 *   3. 速度。225 个文件、几十次 api.github.com 请求、每个大文件 6 秒，还撞每小时
 *      60 次的匿名额度；而整个安装包 92MB 走镜像分片 30 秒就下完了。
 *
 * 所以这里只做一件事：把**官方发布的安装包**拉下来，校验，静默装一遍。
 * 装完的产物就是官方发布的那份，代码/依赖/图标/快捷方式全一致，不会出现「代码新了
 * 依赖没跟上」这种半新半旧的状态。
 *
 * 【网络现实（这台机器实测，别改回去）】
 *   - api.github.com 通（releases/latest 约 750ms）→ 用它拿版本号和 asset 元数据
 *   - github.com 的 releases/download 直链几乎下不动（25KB/s，单流 4MB 直接超时）
 *   - 镜像 ghfast.top 217~286KB/s，8 段并发能到 1.5MB/s
 *   - 所以：**必须走镜像 + 分片并发**，并在 429/5xx 时换镜像 + 指数退避
 */
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';

export const REPO = 'wxzjss/xiaoyu-agent';

/** 元数据接口（通）与下载直链（基本不通）分开写，免得以后又有人把两者混起来 */
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const DL_BASE = `https://github.com/${REPO}/releases/download`;

const NET_TIMEOUT = 12000;
/** 分片大小 2MB：太小请求数爆炸，太大单段超时率变高 */
const SEG = 2 * 1024 * 1024;
/** 并发 4：实测 8 段会开始撞 429 */
const PAR = 4;

/**
 * 镜像顺序 = 实测速度排序。
 * 第一个是主力（ghfast.top），后面两个是它抽风时的备胎，最后才是直连。
 */
const MIRRORS = [
  (u) => 'https://ghfast.top/' + u,
  (u) => 'https://gh-proxy.com/' + u,
  (u) => 'https://ghproxy.net/' + u,
  (u) => u,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ghHeaders() {
  const h = { 'User-Agent': 'xiaoyu-agent-updater', Accept: 'application/vnd.github+json' };
  try {
    const t = String(process.env.XIAOYU_GITHUB_TOKEN || '').trim();
    if (t) h.Authorization = `Bearer ${t}`;
  } catch {}
  return h;
}

/**
 * 问 GitHub 要「最新那个发行版」。
 *
 * 注意这里读的是 **tag_name**，不是某个分支上的 package.json ——
 * 分支名会改名、会落后，tag 是发布时打上的，不会骗人。
 *
 * @returns {Promise<{ok:boolean, version?:string, tag?:string, assets?:Array<{name:string,size:number,sha256:string|null,url:string}>, reason?:string}>}
 */
export async function latestRelease() {
  try {
    const res = await fetch(API_LATEST, { headers: ghHeaders(), signal: AbortSignal.timeout(NET_TIMEOUT) });
    if (!res.ok) return { ok: false, reason: `GitHub 接口回 ${res.status}` };
    const j = await res.json();
    const tag = String(j?.tag_name || '');
    if (!tag) return { ok: false, reason: '发行版里没有 tag' };
    const assets = (Array.isArray(j.assets) ? j.assets : []).map((a) => ({
      name: String(a.name || ''),
      size: Number(a.size || 0),
      // digest 形如 "sha256:abc…"；老版本 API 可能没有，那就 null（后面只校验大小）
      sha256: (() => {
        const d = String(a.digest || '');
        const m = /^sha256:([0-9a-f]{64})$/i.exec(d);
        return m ? m[1].toLowerCase() : null;
      })(),
      url: `${DL_BASE}/${tag}/${encodeURIComponent(String(a.name || ''))}`,
    }));
    return { ok: true, tag, version: tag.replace(/^v/i, ''), assets };
  } catch (e) {
    const msg = String(e?.message ?? e);
    return { ok: false, reason: /timeout|aborted|fetch failed/i.test(msg) ? '连不上 GitHub（网络问题）' : msg.slice(0, 160) };
  }
}

/**
 * 从资产清单里挑出「要给这台机器装的安装包」。
 *
 * 优先 setup（有开始菜单/桌面快捷方式、能升级已装的那份）；
 * 没有 setup 才退而用 portable —— portable 无法覆盖已安装的版本，只能另放一份。
 */
export function pickInstaller(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const exes = list.filter((a) => /\.exe$/i.test(a.name));
  const setup = exes.find((a) => /setup/i.test(a.name) && /x64/i.test(a.name)) || exes.find((a) => /setup/i.test(a.name));
  if (setup) return { ...setup, kind: 'setup' };
  const portable = exes.find((a) => /portable/i.test(a.name));
  if (portable) return { ...portable, kind: 'portable' };
  return null;
}

/** 用 Range 探一下这条线路能不能下、总长多少 */
async function probeMirror(url, timeout = 20000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'xiaoyu-agent-updater', Range: 'bytes=0-0' },
    signal: AbortSignal.timeout(timeout),
  });
  const cr = r.headers.get('content-range') || '';
  const m = /\/(\d+)\s*$/.exec(cr);
  const total = m ? Number(m[1]) : Number(r.headers.get('content-length') || 0);
  try { await r.arrayBuffer(); } catch {}
  if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return total;
}

/** 下一片；碰到 429/5xx/长度不符算「软失败」，退避重试 */
async function fetchSeg(base, from, to) {
  const want = to - from + 1;
  let wait = 600;
  let lastErr = null;
  for (let k = 0; k < 6; k++) {
    try {
      const r = await fetch(base, {
        headers: { 'User-Agent': 'xiaoyu-agent-updater', Range: `bytes=${from}-${to}` },
        signal: AbortSignal.timeout(120000),
      });
      if (r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) {
        try { await r.arrayBuffer(); } catch {}
        throw Object.assign(new Error(`HTTP ${r.status}`), { soft: true });
      }
      if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length !== want) throw Object.assign(new Error(`长度不符 ${b.length}/${want}`), { soft: true });
      return b;
    } catch (e) {
      lastErr = e;
      if (k === 5) break;
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
  throw lastErr || new Error('分片下载失败');
}

/**
 * 把安装包下到本地。返回落盘路径（已校验大小与 sha256）。
 *
 * @param {{url:string, size:number, sha256:string|null, name:string}} asset
 * @param {{dir?:string, onProgress?:(got:number,total:number)=>void}} [opts]
 */
export async function downloadInstaller(asset, opts = {}) {
  if (!asset || !asset.url) throw new Error('没有可下载的安装包');
  const dir = opts.dir || join(config.dataDir, '.state', 'downloads');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, asset.name || 'xiaoyu-setup.exe');

  // 已经下过并且对得上，直接复用（省一次 92MB）
  try {
    if (existsSync(out) && asset.size > 0 && statSync(out).size === asset.size) {
      if (!asset.sha256 || (await sha256OfFile(out)) === asset.sha256) {
        return { file: out, reused: true, size: asset.size };
      }
    }
  } catch {}

  // 先探一圈，把能用的线路排前面（不探出总长就不敢分片）
  const good = [];
  let total = Number(asset.size || 0);
  for (const mk of MIRRORS) {
    const u = mk(asset.url);
    try {
      const t = await probeMirror(u);
      if (t > 1000) {
        total = total || t;
        good.push({ url: u, total: t });
      }
    } catch {}
    if (good.length >= 2) break;
  }
  if (!good.length) throw new Error('所有镜像都下不动（这台机器的网络连不上 GitHub 及其镜像）');
  const usable = good.filter((g) => !total || g.total === total).map((g) => g.url);
  if (!usable.length) throw new Error('镜像报的文件大小跟官方对不上，怕是缓存了旧包');

  const ranges = [];
  for (let s = 0; s < total; s += SEG) ranges.push([s, Math.min(s + SEG - 1, total - 1)]);
  const bufs = new Array(ranges.length);
  let nextIdx = 0;
  let done = 0;

  const worker = async (seat) => {
    for (;;) {
      const my = nextIdx++;
      if (my >= ranges.length) return;
      let got = null;
      let lastErr = null;
      for (let t = 0; t < usable.length && !got; t++) {
        const u = usable[(seat + t) % usable.length];
        try {
          got = await fetchSeg(u, ranges[my][0], ranges[my][1]);
        } catch (e) {
          lastErr = e;
        }
      }
      if (!got) throw lastErr || new Error(`第 ${my} 片所有线路都失败`);
      bufs[my] = got;
      done++;
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress(done * SEG, total); } catch {}
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(PAR, ranges.length) }, (_, i) => worker(i)));

  const all = Buffer.concat(bufs);
  if (total && all.length !== total) throw new Error(`下完的大小不对：${all.length} / ${total}`);
  const head = all.subarray(0, 2).toString('latin1');
  if (head !== 'MZ') throw new Error('下下来的东西不是 Windows 可执行文件');
  if (asset.sha256) {
    const h = createHash('sha256').update(all).digest('hex');
    if (h !== asset.sha256) throw new Error(`校验不过：sha256 是 ${h}，官方是 ${asset.sha256}`);
  }
  writeFileSync(out, all);
  return { file: out, reused: false, size: all.length };
}

/** 算文件的 sha256（用来判断已下好的包还能不能复用） */
export async function sha256OfFile(file) {
  const { createReadStream } = await import('node:fs');
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const st = createReadStream(file);
    st.on('data', (b) => h.update(b));
    st.on('error', reject);
    st.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 静默装一遍，装完把新版拉起来。
 *
 * 【为什么用 cmd 中转，而不是直接 spawn 安装包】
 * NSIS 的 /S 是「静默装」，但它要求被覆盖的程序**已经退出**。我们现在还在跑，
 * 直接装会撞「文件被占用」。所以：
 *   1. 生成一个临时 .cmd：等 3 秒（让我们退出）→ 跑安装包 /S → 装完 start 新版
 *   2. spawn 这个 cmd（detached，跟当前进程脱钩）
 *   3. 调用方立刻 app.exit(0)
 * 这样即使本进程马上死掉，cmd 还在，安装和重启都能走完。
 *
 * @param {{file:string, kind?:'setup'|'portable', appExe?:string}} job
 * @returns {{ok:boolean, script?:string, error?:string}}
 */
export function spawnSilentInstall(job) {
  const file = String(job?.file || '');
  if (!file || !existsSync(file)) return { ok: false, error: '安装包不在了' };
  const dir = join(config.dataDir, '.state', 'downloads');
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'apply-update.cmd');

  /**
   * 安装完成后要拉起来的那个 exe。
   *
   * 【为什么不能无脑用 process.execPath】
   * 免安装版（portable）的 execPath 是那个便携 exe 自己。用它跑 setup 装完之后，
   * 程序装到了标准位置，而便携 exe 还是旧的那份 —— 一 start 就把旧版拉起来了，
   * 看着像「装了没生效」。所以 setup 一律优先拉标准安装位置那份。
   */
  const stdExe = join(process.env.LOCALAPPDATA || '', 'Programs', 'xiaoyu-mini-agent', '小鱼Agent.exe');
  const kind = job?.kind === 'portable' ? 'portable' : 'setup';
  let appExe = String(job.appExe || process.execPath || '');
  if (kind === 'setup' && stdExe && existsSync(stdExe)) appExe = stdExe;

  /**
   * 等旧进程退出：按 **PID** 查，不按进程名。
   *
   * 进程名带中文（小鱼Agent.exe），在 cmd 里跟代码页较劲很容易误判；
   * 而「按 pid 找，看输出里还有没有 .exe」是纯 ASCII 判断，怎么都不会错。
   * （tasklist 找不到时会吐一句中文提示，里面不含 .exe，所以 find 不会误命中。）
   */
  const myPid = Number(job?.pid || process.pid) || 0;
  const head = ['@echo off', 'chcp 65001 >nul', 'setlocal enabledelayedexpansion'];
  const waitBlock = myPid
    ? [
        'rem 等旧进程真的退出（文件被占用时装不上），最多等 30 秒',
        'set /a n=0',
        ':wait',
        `tasklist /FI "PID eq ${myPid}" /NH 2>nul | find /I ".exe" >nul && goto still`,
        'goto run',
        ':still',
        'ping -n 2 127.0.0.1 >nul',
        'set /a n+=1',
        'if %n% GEQ 15 goto run',
        'goto wait',
      ]
    : [];
  const lines = [
    ...head,
    ...waitBlock,
    ':run',
    'ping -n 2 127.0.0.1 >nul',
    `"${file}" /S`,
    'rem 装完给安装器一点收尾时间，再拉新版',
    'ping -n 4 127.0.0.1 >nul',
  ];
  if (appExe && /\.exe$/i.test(appExe)) {
    lines.push(`if exist "${appExe}" start "" "${appExe}"`);
  }
  lines.push('endlocal', 'del "%~f0" >nul 2>nul', '');
  try {
    writeFileSync(script, lines.join('\r\n'), 'utf8');
  } catch (e) {
    return { ok: false, error: `写不了安装脚本：${String(e?.message ?? e)}` };
  }

  try {
    const child = spawn('cmd.exe', ['/c', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: dir,
    });
    child.unref();
  } catch (e) {
    return { ok: false, error: `起不来安装脚本：${String(e?.message ?? e)}` };
  }
  return { ok: true, script };
}

/** 清掉下好的安装包（校验失败或主人说「别再装了」） */
export function dropInstaller(file) {
  try {
    if (file && existsSync(file)) unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
