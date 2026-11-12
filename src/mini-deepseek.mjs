// 【2026-11-12 加·本机 DeepSeek 预设】
//
// 主人要的东西一句话说清：
//   「模型」页「添加模型」的接口地址预设，末尾多一个【本机 DeepSeek】。
//   选中它，输入框全空；点【测连通】——
//     · 没登录过 → 自动打开内置浏览器的 DeepSeek 登录页，等十分钟，没登录就停
//     · 登录过   → 自动取 token、起服务、把地址 / key / 模型名三项填好
//     · 已经加过这个模型 → 正常测连通；成功就什么都不做，失败则按原因自愈
//
// 这个模块只管「本机那套东西」：进程起没起、token 能不能取到、怎么停。
// 界面怎么填是前端的事，模型怎么存是 models.mjs 的事，这里不越界。
//
// 三条硬规矩：
//   1. token 绝不进日志、绝不回给前端 —— 前端只要知道「有没有」。
//   2. 起服务只用 spawn，不碰 shell 拼串（路径里有中文和空格，拼串必炸）。
//   3. 十分钟没登录就必须自己收尸，不许留一个空等着的进程。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);

/** 服务的固定端口。改这里等于改文档，别处的 README 也得跟着改。 */
export const MINI_DS_PORT = 8321;
/** 前端要填的三样东西。key 是假的 —— 本机服务不校验，但 OpenAI 客户端非要一个。 */
export const MINI_DS_BASE = `http://127.0.0.1:${MINI_DS_PORT}/v1`;
export const MINI_DS_KEY = 'local';
export const MINI_DS_MODEL = 'deepseek-web';

/** 等登录最多十分钟。到点自己收尸。 */
const LOGIN_WAIT_MS = 10 * 60 * 1000;
/** 轮询浏览器登录状态的间隔。 */
const POLL_MS = 1500;

/** 找 mini_ds 目录：优先仓库里的 sandbox/mini_ds，再退到 data 下的副本。 */
export function miniDsDir() {
  const cands = [
    join(process.cwd(), 'sandbox', 'mini_ds'),
    join(homedir(), 'AppData', 'Roaming', '小鱼Agent', 'data', 'sandbox', 'mini_ds'),
    join(dirname(fileURLToPath(import.meta.url)), '..', 'sandbox', 'mini_ds'),
  ];
  for (const d of cands) {
    try { if (existsSync(join(d, 'mini_ds.py'))) return d; } catch { /* 不存在就算了 */ }
  }
  return '';
}

/** 找 python 解释器。跟 start.bat 一个顺序，别自己另发明一套。 */
export function findPython() {
  const home = homedir();
  const cands = [
    join(home, 'AppData', 'Local', 'Python', 'bin', 'python.exe'),
    join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python314', 'python.exe'),
  ];
  if (process.env.MINI_DS_DIR) cands.unshift(process.env.MINI_DS_DIR);
  for (const p of cands) {
    try { if (existsSync(p)) return p; } catch { /* 跳过 */ }
  }
  // 再扫一遍 Python 目录下的所有版本
  try {
    const base = join(home, 'AppData', 'Local', 'Programs', 'Python');
    if (existsSync(base)) {
      const dirs = readdirSync(base).filter((x) => /^Python3\d+$/i.test(x)).sort().reverse();
      for (const d of dirs) {
        const p = join(base, d, 'python.exe');
        if (existsSync(p)) return p;
      }
    }
  } catch { /* 权限之类，跳过 */ }
  return 'python';
}

// ─────────────────────────────────────────── 取 token

/**
 * 从内置浏览器的 Local Storage 里把 DeepSeek 的 userToken 扒出来。
 *
 * 为什么要绕这么大圈：DeepSeek 的登录凭据存在浏览器本地，服务端拿不到，
 * 每次重开都得重新弄。而 leveldb 里这些值是被压缩块包着的，直接按明文搜
 * 搜不到 —— 之前就是在这儿栽的。所以逐字节扫、找 base64 长串。
 *
 * 返回 { token } 或 { error }。token 只在内存里过，不写文件。
 */

// ─────────────────────────────────────────── token 缓存（2026-11-12 修冻死）
//
// 【为什么必须缓存】readDeepSeekToken() 是同步扫整个 leveldb 目录：几百个文件
// 加压缩块，扫一遍几十秒。原来 localHealth() 每次调用（前端 2 秒轮一次）
// 都同步跑一遍，把 node 事件循环彻底堵死 —— 表现是 /api/health 都不应答。
// 现在：只有 ensure/start 这种真的要用 token 的地方才扫，其余读缓存。
let _tokenCache = { token: '', at: 0 };
let _tokenInflight = null;
const TOKEN_CACHE_MS = 60 * 1000;   // 新鲜期：一分钟内直接用
const TOKEN_STALE_MS = 30 * 60 * 1000; // 过期但还能顶着的宽限期

// 只读缓存，绝不触发扫描。【localHealth 这类要高频调的地方必须用这个】
// 缓存空着就返回空 —— 宁可显示"未登录"，也绝不阻塞事件循环。
function readDeepSeekTokenCached(force = false) {
  return _tokenCache;
}

// 异步刷新：后台跑，不阻塞任何请求。多少请求同时来都只跑一次。
function refreshTokenAsync() {
  if (_tokenInflight) return _tokenInflight;
  _tokenInflight = new Promise((resolve) => {
    try {
      readDeepSeekTokenAsync().then((got) => {
        _tokenCache = { token: (got && got.token) || '', at: Date.now(), detail: got };
        resolve(_tokenCache);
      }).catch(() => resolve(_tokenCache));
    } catch { resolve(_tokenCache); }
  }).finally(() => { _tokenInflight = null; });
  return _tokenInflight;
}

// 同步版本（只给 ensureToken 用，它会 await 异步版）
function readDeepSeekTokenSync() {
  return readDeepSeekToken();
}

// 异步版本：用 spawn 而不是 spawnSync，事件循环照常转。
function readDeepSeekTokenAsync() {
  return new Promise((resolve) => {
    const candidates = tokenDirs();
    const py = findPython();
    const script = join(miniDsDir(), 'get_token.py');
    if (existsSync(script)) {
      let out = '';
      let done = false;
      const finish = (tk) => {
        if (done) return;
        done = true;
        if (looksLikeToken(tk)) return resolve({ token: tk });
        // python 失败 → 同步兜底扫（这时目录已经知道不大）
        try { resolve(readDeepSeekTokenSyncFallback(candidates)); } catch { resolve({ token: '' }); }
      };
      try {
        const cp = spawn(py, [script], { windowsHide: true });
        const t = setTimeout(() => { try { cp.kill(); } catch {} finish(''); }, 20000);
        cp.stdout && cp.stdout.on('data', (d) => { out += d.toString('utf8'); });
        cp.on('error', () => { clearTimeout(t); finish(''); });
        cp.on('close', () => {
          clearTimeout(t);
          const tk = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || '';
          finish(tk);
        });
        return;
      } catch { /* 落到兜底 */ }
    }
    try { resolve(readDeepSeekTokenSyncFallback(candidates)); } catch { resolve({ token: '' }); }
  });
}

function tokenDirs() {
  const c = [];
  const push = (p) => { if (p && c.indexOf(p) < 0) c.push(p); };
  push(join(homedir(), 'AppData', 'Roaming', '小鱼Agent', 'Local Storage', 'leveldb'));
  push(join(homedir(), 'AppData', 'Roaming', '小鱼Agent', 'Partitions', 'persist', 'main', 'Local Storage', 'leveldb'));
  push(join(homedir(), 'AppData', 'Roaming', '小鱼Agent', 'data', 'Local Storage', 'leveldb'));
  return c;
}


// 兼容：外部还要同步版时给它纯扫描（不 spawn python，不会长时间堵）
export function readDeepSeekToken() {
  try { return readDeepSeekTokenSyncFallback(tokenDirs()); } catch { return { token: '' }; }
}

export function invalidateTokenCache() {
  _tokenCache = { token: '', at: 0 };
}

// 纯 JS 扫描兜底：不调 python，不 spawn。给异步版本失败时用。
function readDeepSeekTokenSyncFallback(candidates) {

  for (const dir of candidates) {
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => /\.(ldb|log)$/i.test(f));
    } catch { continue; }
    // 新的文件排前面（token 总是最后被写的）
    files.sort((a, b) => {
      try { return statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs; } catch { return 0; }
    });
    for (const f of files) {
      let buf;
      try { buf = readFileSync(join(dir, f)); } catch { continue; }
      const hit = findUserTokenIn(buf);
      if (hit) return { token: hit };
      // UTF-16LE 兜底：Chromium 有些值就是按宽字符存的
      try {
        const u16 = buf.toString('utf16le');
        const h2 = findUserTokenIn(u16);
        if (h2) return { token: h2 };
      } catch { /* 跳过 */ }
    }
  }
  return { error: '内置浏览器里没找到 DeepSeek 登录凭据' };
}

/**
 * 在一个 leveldb 文件里找 userToken。
 *
 * 两轮：先找明文的 `"userToken":"..."`（leveldb 里的 JSON 值）；
 * 找不到再退一步，把整块当字节流扫，捞长度像 token、字符集也像的那串，
 * 且附近 200 字节内得出现 chat.deepseek.com —— 不认域就等于乱认。
 */
function findUserTokenIn(buf) {
  if (!buf || !buf.length) return '';
  const text = buf.toString('utf8');
  // 第一轮：明文 JSON
  const re1 = /userToken[^\w]{0,6}["']?value["']?\s*:\s*["']([A-Za-z0-9_\-+/=]{20,})["']/g;
  let m;
  while ((m = re1.exec(text))) {
    if (looksLikeToken(m[1])) return m[1];
  }
  // 第二轮：字节流里扫，带域名校验
  const re2 = /[A-Za-z0-9_\-+/=]{40,400}/g;
  while ((m = re2.exec(text))) {
    const s = m[0];
    if (!looksLikeToken(s)) continue;
    const near = text.slice(Math.max(0, m.index - 300), Math.min(text.length, m.index + 300));
    if (/chat\.deepseek\.com|deepseek/i.test(near)) return s;
  }
  return '';
}

function looksLikeToken(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 40 || s.length > 400) return false;
  // 纯十六进制的是别的东西（哈希、id），DeepSeek 的 token 里必有大小写混合
  if (/^[0-9a-f]+$/i.test(s) && !/[A-Z]/.test(s)) return false;
  if (!/[A-Z]/.test(s) || !/[a-z]/.test(s)) return false;
  if (!/[0-9]/.test(s) && !/[+/=]/.test(s)) return false;
  return true;
}

// ─────────────────────────────────────────── 服务进程

/** 现在这套东西的状态，一个对象说清，前端只看这个。 */
const st = {
  proc: null,        // 子进程
  startedAt: 0,      // 什么时候起的
  logTail: [],       // 最近几十行日志（不含 token）
  waitingLogin: false,
  waitTimer: null,
  lastExit: null,
};

function noteLog(line) {
  const s = String(line || '').slice(0, 400);
  // token 万一被 echo 出来，这里兜一道
  const safe = s.replace(/[A-Za-z0-9_\-+/=]{40,}/g, (x) => `<${x.length}字符>`);
  st.logTail.push(safe);
  if (st.logTail.length > 60) st.logTail.shift();
}

/** 端口上有服务吗？用最轻的一记 /v1/models 探，别去扫端口。 */
export async function probeLocalService(timeoutMs = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${MINI_DS_BASE}/models`, {
      headers: { Authorization: `Bearer ${MINI_DS_KEY}` },
      signal: ctl.signal,
    });
    if (!r.ok) return { up: false, status: r.status };
    const j = await r.json().catch(() => null);
    const ids = Array.isArray(j?.data) ? j.data.map((x) => x?.id).filter(Boolean) : [];
    return { up: true, ids };
  } catch {
    return { up: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}

/** 起服务。已经在跑就直接说在跑。 */
export async function startLocalService({ token, opener, waitMs } = {}) {
  const already = await probeLocalService(900);
  if (already.up) return { ok: true, already: true, ids: already.ids };

  const dir = miniDsDir();
  if (!dir) return { ok: false, reason: 'no-program', error: '找不到 mini_ds 程序目录' };

  let tk = String(token || '').trim();
  if (!tk) {
    let got = await refreshTokenAsync();
    // __LOGIN_HOOK__ 【2026-11-12】没 token 不是直接失败：开内置浏览器登录页，等十分钟。
    if (!got.token) {
      const w = await waitForLogin({ opener, waitMs });
      if (!w.ok) return { ok: false, reason: w.reason, error: w.error || '没登录 DeepSeek' };
      tk = w.token;
    } else {
      tk = got.token;
    }
  }

  const py = findPython();
  const env = { ...process.env, DS_TOKEN: tk, DS_PORT: String(MINI_DS_PORT), PYTHONIOENCODING: 'utf-8' };
  // 绝不让 token 落进日志或回给前端
  delete env.DS_COOKIE;

  const child = spawn(py, ['mini_ds.py'], {
    cwd: dir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 【2026-11-12 修】脱离父进程：不然本进程一退，子服务跟着被带走。
    detached: true,
  });
  st.proc = child;
  st.startedAt = Date.now();
  // 【2026-11-12 修】父进程退出时不要把子服务拖走（unref 只影响退出策略，不影响管道读取）。
  try { child.unref(); } catch {}
  st.logTail = [];
  st.lastExit = null;

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l && noteLog(l)));
  child.stderr?.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => l && noteLog(l)));
  child.on('exit', (code) => {
    st.lastExit = { code, at: Date.now() };
    st.proc = null;
  });

  // 最多等 20 秒起来。python 冷启动 + 建第一个连接大概 2~5 秒。
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const p = await probeLocalService(800);
    if (p.up) {
      invalidateTokenCache();
      return { ok: true, started: true, ids: p.ids };
    }
    if (!st.proc) break;
  }
  const tail = st.logTail.slice(-6).join('\n');
  stopLocalService();
  return { ok: false, reason: 'start-failed', error: '服务起不来', log: tail };
}

/** 收尸。等登录那个定时器也一起清掉。 */
export function stopLocalService() {
  // 【2026-11-12 修】不是本进程起的服务（比如上次运行留下的）也要能停：按端口找 PID 再杀。
  if (!st.proc) {
    try {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
      const pids = new Set();
      for (const line of String(out.stdout || '').split(/\r?\n/)) {
        if (!line.includes(':' + MINI_DS_PORT)) continue;
        if (!/LISTENING/i.test(line)) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) {
        try { spawnSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true }); } catch {}
      }
      return { ok: true, killed: [...pids] };
    } catch { return { ok: false }; }
  }

  if (st.waitTimer) { clearTimeout(st.waitTimer); st.waitTimer = null; }
  st.waitingLogin = false;
  const p = st.proc;
  st.proc = null;
  if (!p) return { ok: true, already: true };
  try { p.kill(); } catch { /* 已经死了 */ }
  return { ok: true };
}

export function localStatus() {
  return {
    running: !!st.proc,
    startedAt: st.startedAt,
    waitingLogin: st.waitingLogin,
    lastExit: st.lastExit,
    logTail: st.logTail.slice(-20),
    dir: miniDsDir(),
    base: MINI_DS_BASE,
    key: MINI_DS_KEY,
    model: MINI_DS_MODEL,
  };
}

/**
 * 【2026-11-12】「本机 DeepSeek 到底能不能用」的唯一权威答案。
 *
 * 为什么不能只看 st.proc：主人可能自己双击过 start.bat，或者上次
 * 程序没来得及收尾就退了 —— 那时候端口上明明有服务，st.proc 却是空的。
 * 反过来 st.proc 还在不代表活得好（进程卡死、端口让出去）。
 *
 * 所以这里分两步问：
 *   ① 先看本进程手里有没有子进程句柄 —— 有就说明是「我起的」；
 *   ② 再探端口 —— 端口上有 /v1/models 应答，才叫真的能用。
 * 两个都记录下来，前端据此决定「要不要再起一个」。
 */
export async function localHealth(timeoutMs = 1500) {
  const p = await probeLocalService(timeoutMs);
  return {
    up: p.up,
    ids: p.ids ?? [],
    owned: !!st.proc,
    waitingLogin: st.waitingLogin,
    hasToken: !!readDeepSeekTokenCached().token,
    base: MINI_DS_BASE,
    key: MINI_DS_KEY,
    model: MINI_DS_MODEL,
    dir: miniDsDir(),
    lastExit: st.lastExit,
  };
}

// ─────────────────────────────────────────── 等登录

/**
 * 没登录的时候：打开内置浏览器的 DeepSeek 登录页，然后一直轮询本地存储，
 * 直到拿到 token，或者过了十分钟。
 *
 * 这一步是「等」不是「问」—— 主人不用回来点任何东西，登录完自动往下走。
 */
export async function waitForLogin({ opener, waitMs, reader } = {}) {
  // 已经在等了，别叠第二层
  if (st.waitingLogin) return { ok: false, reason: 'already-waiting' };

  const read = typeof reader === 'function' ? reader : readDeepSeekToken;
  const got0 = read();
  if (got0 && got0.token) return { ok: true, already: true };

  st.waitingLogin = true;
  try {
    if (typeof opener === 'function') {
      try { await opener('https://chat.deepseek.com/sign_in'); } catch { /* 打不开就算了，照样轮询 */ }
    }
    const total = Number(waitMs) > 0 ? Number(waitMs) : LOGIN_WAIT_MS;
    const deadline = Date.now() + total;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const got = read();
      if (got && got.token) {
        st.waitingLogin = false;
        return { ok: true, token: got.token };
      }
    }
    st.waitingLogin = false;
    return { ok: false, reason: 'timeout', error: '十分钟内没检测到登录' };
  } finally {
    st.waitingLogin = false;
  }
}

/** 【2026-11-12】给前端/接口用的三项默认值。 */
export const LOCAL_ID = 'local-deepseek';

export function localDeepSeekDefaults() {
  return {
    id: LOCAL_ID,
    name: '本机 DeepSeek',
    base: MINI_DS_BASE,
    key: MINI_DS_KEY,
    model: MINI_DS_MODEL,
  };
}



