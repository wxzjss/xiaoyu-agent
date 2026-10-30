/**
 * 版本自更新。
 *
 * 思路：本地 package.json 的 version 和 GitHub 上的比一比，GitHub 更新就自动拉下来。
 *
 * 三条硬规矩：
 *   1. 只覆盖「发布物白名单」里的文件，.env / .state / sandbox / node_modules / dist 一个都不碰。
 *   2. 覆盖之前，把即将被改掉的现有文件整份备份到 .state/update-backup/<时间戳>/，
 *      用户自己改过 rules.md、persona 也能捡回来。
 *   3. 更新完了要重启才生效（Node 已经加载的模块不会自己变），所以返回 needsRestart，
 *      由 Electron 决定什么时候重启；并且带防抖，绝不无限重启。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { config } from './config.mjs';
import { inflateRawSync } from 'node:zlib';

/**
 * 更新要写到哪儿。
 *
 * 打包后 config.root 是 app.asar 这个**文件**（只读），往它里面 mkdir 报 ENOTDIR
 * —— 打包版的自动更新一直因此失败。所以：
 *   开发时（root 是真实目录）→ 直接改源码目录，跟以前一样
 *   打包后 → 写到 <数据目录>/code，electron/main.cjs 的 importSrc() 会优先从那儿加载
 * 两边都保留 .state 在数据目录里（STATE 用 config.dataDir，见下）。
 */
const ROOT = config.packaged ? join(config.dataDir, 'code') : config.root;
const STATE = join(config.dataDir, '.state');
const UPDATE_INFO = join(STATE, 'update.json');
const BACKUP_ROOT = join(STATE, 'update-backup');

/**
 * 现在真正在跑的那份代码在哪儿：优先 code/（更新过的），没有就 asar 里的原版。
 * 版本号必须从这份读 —— 只从 code/ 读的话，第一次更新前那儿是空的，
 * 就会报「读不到本地版本号」，然后永远判断不出该不该更新。
 */
const ACTIVE = existsSync(join(ROOT, 'package.json')) ? ROOT : config.root;

const REPO = 'wxzjss/xiaoyu-agent';
const BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

/**
 * 可选：给自己的仓库配一个 GitHub token。
 *
 * 为什么需要：匿名调 api.github.com 每小时只有 **60 次**请求，白名单 76 个文件
 * 一轮就爆（实测成功 31 个后全是 403），自动更新等于废的。
 * 带上 token 就是每小时 5000 次，一次更新连零头都用不到。
 *
 * token 从哪儿来（按顺序找，都没有就匿名跑）：
 *   1. 环境变量 XIAOYU_GITHUB_TOKEN
 *   2. 数据目录下的 .state/github-token.txt（一行，就是那串 ghp_…）
 *
 * 注意：这个 token 只用于读自己的公开仓库，权限按最小给（只要 read）。
 */
let _ghToken;

function ghToken() {
  if (_ghToken !== undefined) return _ghToken;
  _ghToken = null;
  try {
    const env = String(process.env.XIAOYU_GITHUB_TOKEN || "").trim();
    if (env) { _ghToken = env; return _ghToken; }
    // 两个地方都找：数据目录（用户放这儿）和源码/程序目录（开发时放这儿）
    const cands = [
      join(config.dataDir, ".state", "github-token.txt"),
      join(config.root, ".state", "github-token.txt"),
      join(config.root, "github-token.txt"),
    ];
    for (const f of cands) {
      if (!existsSync(f)) continue;
      const t = readFileSync(f, "utf8").trim().split(/\s+/).pop() || "";
      if (/^[A-Za-z0-9_]{20,}$/.test(t)) { _ghToken = t; break; }
    }
  } catch {}
  return _ghToken;
}

/** 调 api.github.com 统一的头（有 token 就带上，额度从 60 变 5000） */
function ghHeaders(extra = {}) {
  const h = { "User-Agent": "xiaoyu-updater", Accept: "application/vnd.github+json", ...extra };
  const t = ghToken();
  if (t) h.Authorization = "Bearer " + t;
  return h;
}
const CLONE_URL = `https://github.com/${REPO}.git`;

/** 允许被更新覆盖的东西，跟发布白名单保持一致 */
const WHITELIST_DIRS = ['src', 'public', 'electron', 'persona', 'rules', 'assets', 'scripts'];
const WHITELIST_FILES = [
  'package.json', 'README.md', 'LICENSE', '.env.example', '.gitignore',
  'start.bat', 'start.sh', 'make-shortcut.ps1',
];

const NEVER_TOUCH = new Set(['.env', '.state', 'sandbox', 'node_modules', 'dist', '.git', 'dump']);

/** 超时 8 秒，网络慢就跳过，绝不拖住启动 */
const NET_TIMEOUT = 8000;

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 本地版本 */
export function localVersion() {
  const pkg = readJson(join(ACTIVE, 'package.json'), null);
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

/**
 * 比大小。够用就行：1.2.3 vs 1.10.0 要判对。
 * @returns {number} a>b 正数，a<b 负数，相等 0
 */
export function compareVersion(a, b) {
  const norm = (v) => String(v ?? '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const A = norm(a);
  const B = norm(b);
  for (let i = 0; i < 3; i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 问 GitHub 要版本号。拿不到就返回 { ok:false },不抛。
 * 两个源：raw（不受 API 限额）→ API（备用）
 */
export async function remoteVersion() {
  const tryUrls = [
    `${RAW_BASE}/package.json`,
    `https://api.github.com/repos/${REPO}/contents/package.json`,
  ];
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, {
        headers: ghHeaders(),
        signal: AbortSignal.timeout(NET_TIMEOUT),
      });
      if (!res.ok) continue;
      let pkg;
      if (url.includes('api.github.com')) {
        const j = await res.json();
        if (!j?.content) continue;
        pkg = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
      } else {
        pkg = await res.json();
      }
      if (typeof pkg?.version === 'string') return { ok: true, version: pkg.version, source: url };
    } catch {
      // 网络不通、超时就试下一个
    }
  }
  return { ok: false, version: null, reason: '连不上 GitHub（可能是网络问题）' };
}

/** 上次更新的记录，用来防抖 */
export function lastUpdateInfo() {
  return readJson(UPDATE_INFO, null);
}

/** 刚更新过就别再折腾（默认 10 分钟内不重复） */
function recentlyUpdated(targetVersion, withinMs = 10 * 60 * 1000) {
  const info = lastUpdateInfo();
  if (!info) return false;
  if (info.to !== targetVersion) return false;
  return Date.now() - (info.at || 0) < withinMs;
}

/** 这次启动已经尝试过更新同一版本了吗（防止无限重启） */
function alreadyTriedThisBoot(targetVersion) {
  return lastUpdateInfo()?.triedBoot === targetVersion;
}

// ---------------------------------------------------------------- 下载

/**
 * 用 git clone 拉一份到临时目录；没装 git 或拉不动就返回 null。
 *
 * 【为什么超时只有 25 秒，而且是异步 spawn 不是 execFileSync】
 * 以前这里用的是 execFileSync + timeout: 120000，后果很严重：
 * 这台机器到 github.com:443 的连接经常被 reset（error: RPC failed; curl 55），
 * git 会一直重试，一路卡满 120 秒。而 execFileSync 是**同步**的 ——
 * 它把 Electron 主进程整个堵死，界面表现就是「重进小鱼Agent卡死、点了没反应」。
 * 唯一能松绑的办法是关掉进程。这个坑真踩过，别改回去。
 *
 * 现在：异步 spawn + 25 秒硬超时 + 失败立刻返回 null（走 raw 那条路）。
 * 拉不下来本来就不该让用户陪着等。
 */
const GIT_TIMEOUT_MS = 25000;

function downloadWithGit(dir) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let has;
    try {
      has = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 8000 });
    } catch {
      return finish(null);
    }
    if (!has || has.status !== 0) return finish(null);

    let child;
    try {
      child = spawn('git', ['clone', '--depth', '1', '--branch', BRANCH, CLONE_URL, dir], {
        stdio: 'ignore',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '15' },
      });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      console.warn('[update] git clone 25 秒还没动静，掐掉改走 http 下载');
      finish(null);
    }, GIT_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? dir : null);
    });
  });
}

// ---- 手写 zip 读取（项目零依赖，不引第三方包）----------------------------

/** 在 buf 里从 from 开始找一个 4 字节签名，找不到回 -1 */
function findSig(buf, sig, from = 0) {
  for (let i = from; i <= buf.length - 4; i++) {
    if (buf[i] === sig[0] && buf[i + 1] === sig[1] && buf[i + 2] === sig[2] && buf[i + 3] === sig[3]) return i;
  }
  return -1;
}

/** 读中央目录，得到每个条目的名字 / 偏移 / 是否压缩 */
export function listZip(file) {
  const buf = readFileSync(file);
  // EOCD 在文件尾，最多 65535 字节注释，所以从尾部往前找
  const eocd = findSig(buf, [0x50, 0x4b, 0x05, 0x06], Math.max(0, buf.length - 66000));
  if (eocd < 0) throw new Error("不是 zip（找不到中央目录结尾）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    out.push({ name, method, compSize, size, offset, dir: name.endsWith("/") });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 把某一项的内容解出来（只支持 store / deflate，zip 只用这两种） */
export function extractZipEntry(file, entry) {
  const buf = readFileSync(file);
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error("条目头坏了：" + entry.name);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error("不认识的压缩方式 " + entry.method + "：" + entry.name);
}

/**
 * 一次就把整包拿下来（codeload 的 zip）。
 *
 * 为什么留它：逐个文件走 api.github.com 看着优雅，但未认证的 API 每小时只有 60 次请求，
 * 白名单 76 个文件一轮就爆（实测成功 31 / 失败 45，remaining 0）。
 * zip 只算 1 次请求、不吃那个额度，所以先试它；但实测这台机器 23 MB 三分钟都下不完，
 * 所以超时只给 20 秒 —— 下不来就立刻放弃，交给逐文件那条路（1 MB 左右，很快就完）。
 */
const ZIP_TIMEOUT_MS = 20000;

async function downloadWithZip(dir) {
  const url = `https://codeload.github.com/${REPO}/zip/refs/heads/${BRANCH}`;
  let buf;
  let resp;
  try {
    resp = await fetch(url, {
      headers: { "User-Agent": "xiaoyu-updater" },
      signal: AbortSignal.timeout(ZIP_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[update] zip 包 HTTP ${resp.status}，改走逐文件`);
      return null;
    }
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    console.warn("[update] zip 包没下下来：" + String(e?.message ?? e));
    return null;
  }

  const tmpZip = join(dir + "-src.zip");
  writeFileSync(tmpZip, buf);

  // 包里套了一层 `仓库名-sha/` 前缀，要剥掉
  let entries;
  try {
    entries = listZip(tmpZip);
  } catch (e) {
    console.warn("[update] zip 解不开：" + String(e?.message ?? e));
    return null;
  }
  if (!entries.length) return null;

  let prefix = "";
  const first = entries[0].name;
  const slash = first.indexOf("/");
  if (slash > 0 && entries.every((e) => e.name.startsWith(first.slice(0, slash + 1)))) {
    prefix = first.slice(0, slash + 1);
  }

  let n = 0;
  for (const e of entries) {
    if (e.dir) continue;
    const rel = prefix ? e.name.slice(prefix.length) : e.name;
    if (!rel) continue;
    const top = rel.split("/")[0];
    const ok = rel.includes("/") ? WHITELIST_DIRS.includes(top) : WHITELIST_FILES.includes(rel);
    if (!ok || NEVER_TOUCH.has(top)) continue;
    const dst = join(dir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, extractZipEntry(tmpZip, e));
    n += 1;
  }
  try { rmSync(tmpZip, { force: true }); } catch {}
  if (!n) return null;
  return { dir, count: n };
}

/** 没有 git 就逐个文件从 raw 下（raw 不算 API 限额） */
async function downloadWithRaw(dir) {
  const treeUrl = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
  const res = await fetch(treeUrl, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(NET_TIMEOUT),
  });
  if (!res.ok) throw new Error(`列文件失败 HTTP ${res.status}`);
  const tree = await res.json();
  const blobs = (tree.tree ?? []).filter((t) => t.type === 'blob');
  const wanted = blobs.filter((t) => {
    const top = t.path.split('/')[0];
    if (t.path.includes('/')) return WHITELIST_DIRS.includes(top);
    return WHITELIST_FILES.includes(t.path);
  });
  if (!wanted.length) throw new Error('远端没列出任何要更新的文件');

  // 以前每个文件都去 raw.githubusercontent.com 拉 —— 那台机器在国内经常直接不通，
  // 于是「列得出文件、一个也下不下来」，日志只剩 `The operation was aborted due to timeout`，
  // 表现出来就是「发现新版 0.9.xx 但更新失败」，一年也更新不了一次。
  // 现在优先走 api.github.com 的 git/blob 接口（这台机器实测通），raw 只当备胎。
  // 大文件（片子、音乐、字典）不参与更新 —— 它们占 13 MB，而全部代码加起来才 1 MB。
  // 门槛定 512 KB：代码文件最大的也就几十 KB，而 bg-music.m4a 1.96 MB /
  // opencc-full.js 1.14 MB / background.mp4 10 MB 在这台机器上单个都下不完（15 秒超时），
  // 一个卡住就把整次更新带崩。这些资源只在本地没有时才补。
  const BIG_SKIP = 512 * 1024;
  let skippedBig = 0;
  let viaApi = 0;
  let viaRaw = 0;
  const haveToken = Boolean(ghToken());
  let apiErr = '';
  for (const f of wanted) {
    if ((f.size || 0) > BIG_SKIP) {
      // 「本地有没有」要按程序自带的原版算（config.root，也就是 asar 里那份）。
      // 只查 ROOT（更新后的 code/）会误判：第一次更新时 code/ 是空的，
      // 于是 10 MB 的 background.mp4 被当成「本地缺」去下载，卡 30 秒后把整次更新带崩。
      const hasIt = existsSync(join(ROOT, f.path)) || existsSync(join(config.root, f.path));
      if (hasIt) { skippedBig += 1; continue; }
    }
    let buf = null;
    if (f.sha) {
      try {
        const br = await fetch(`https://api.github.com/repos/${REPO}/git/blobs/${f.sha}`, {
          headers: ghHeaders(),
          signal: AbortSignal.timeout(30000),
        });
        if (br.status === 403 || br.status === 429) {
          // 额度用完了：不是网络问题，是匿名 60 次/小时被吃光。
          // 立刻抛出去说清楚，别继续跑剩下几十个文件。
          const reset = br.headers.get('x-ratelimit-reset');
          const when = reset ? new Date(Number(reset) * 1000).toLocaleTimeString('zh-CN') : '稍后';
          throw new Error('GitHub 接口额度用完了（匿名每小时 60 次），' + when + ' 之后才恢复');
        }
        if (br.ok) {
          const j = await br.json();
          if (j && typeof j.content === 'string') {
            buf = j.encoding === 'base64' ? Buffer.from(j.content, 'base64') : Buffer.from(j.content, 'utf8');
            viaApi++;
          }
        }
      } catch (e) {
        // 这里以前是空的 catch，把错误吞了，然后落到 raw.githubusercontent.com ——
        // 而那台机器上这个域名**根本解析不了**（ENOENT），于是整次更新只剩一句
        // 「fetch failed」。现在：带 token 时 API 是通路的，单个文件失败就直接说出
        // 是哪个文件、为什么失败；只有完全没 token 时才去试 raw 兜底。
        apiErr = `${f.path}: ${e?.message ?? e}`;
      }
    }
    if (!buf) {
      if (haveToken) {
        // 有 token 还失败 = 真出问题了，别再拿 raw 那条死路浪费时间
        throw new Error(`下载 ${f.path} 失败（${apiErr || '接口没回内容'}）`);
      }
      const r = await fetch(`${RAW_BASE}/${f.path}`, {
        headers: { 'User-Agent': 'xiaoyu-updater' },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(`下载 ${f.path} 失败 HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
      viaRaw++;
    }
    const dst = join(dir, f.path);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, buf);
  }
  return { dir, count: wanted.length, viaApi, viaRaw, skippedBig };
}

/** 下到临时目录，返回来源目录 */
/**
 * 删临时目录。删不掉就算了 —— 不为了清垃圾把更新搞挂。
 *
 * 这里踩过坑：git clone 被 SIGKILL 之后，Windows 上还会有一小会儿占着目录里的
 * .git 文件，rmSync 直接抛 EPERM: Permission denied，把整次更新带崩，
 * 报出来还特别迷惑：「发现新版 0.9.11 但更新失败：EPERM…」。
 * force: true 只管「文件不存在不报错」，不管权限 —— 别指望它。
 */
function tryRm(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 换一个干净的目录继续（删不掉旧的就不删了，反正落在 %TEMP% 里） */
function freshDir(base) {
  const d = `${base}-${Date.now().toString(36)}`;
  try {
    mkdirSync(d, { recursive: true });
    return d;
  } catch {
    return null;
  }
}
async function download(targetVersion) {
  const base = join(tmpdir(), `xiaoyu-update-${targetVersion}-${Date.now().toString(36)}`);
  let dir = base;
  tryRm(dir);
  mkdirSync(dir, { recursive: true });

  // 每次「推倒重来」都换个新目录，不去删可能还被占着的旧目录（见 tryRm 的注释）
  const reset = () => {
    const nd = freshDir(base);
    if (!nd) throw new Error('临时目录建不出来，可能是 %TEMP% 满了或者没权限');
    dir = nd;
  };

  // 1) git clone（最快，但要本机能连 github.com；这台机器大概率连不上）
  const viaGit = await downloadWithGit(dir);
  if (viaGit) {
    if (existsSync(join(dir, 'src', 'server.mjs')) && existsSync(join(dir, 'package.json'))) {
      const got = readJson(join(dir, 'package.json'), {}).version;
      if (!got || compareVersion(got, targetVersion) === 0) return { dir, via: 'git' };
    }
    reset();
  }

  // 2) zip 整包（1 次请求、不吃 API 额度；但 23 MB 在慢网上下不完，超时只有 45 秒）
  const viaZip = await downloadWithZip(dir);
  if (viaZip) {
    const hasCore = existsSync(join(dir, 'src', 'server.mjs')) && existsSync(join(dir, 'package.json'));
    if (hasCore) {
      const got = readJson(join(dir, 'package.json'), {}).version;
      if (!got || compareVersion(got, targetVersion) === 0) return { dir, via: 'zip' };
    }
    reset();
  }

  // 3) 逐个文件走 api.github.com（带 token 时 5000 次/小时，够用；大文件已跳过）
  await downloadWithRaw(dir);
  if (!existsSync(join(dir, 'src', 'server.mjs'))) throw new Error('下载完的文件不全（缺 src/server.mjs）');
  return { dir, via: 'http' };
}
// ---------------------------------------------------------------- 落盘

/** 递归列出白名单里的现有文件 */
function listLocal() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      out.push(p);
    }
  };
  for (const d of WHITELIST_DIRS) walk(join(ROOT, d));
  for (const f of WHITELIST_FILES) {
    const p = join(ROOT, f);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

/** 更新前把要覆盖的文件备份一份 */
function backupCurrent(files) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = join(BACKUP_ROOT, stamp);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const p of files) {
    const rel = relative(ROOT, p);
    if (!rel || rel.startsWith('..')) continue;
    try {
      const dst = join(dir, rel);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(p, dst);
      n++;
    } catch {}
  }
  return { dir, count: n };
}

/** 把下载来的白名单文件盖上去 */
function applyUpdate(srcDir) {
  const copied = [];
  const copyOne = (rel) => {
    const src = join(srcDir, rel);
    const dst = join(ROOT, rel);
    if (!existsSync(src)) return false;
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
    copied.push(rel);
    return true;
  };

  for (const d of WHITELIST_DIRS) {
    const srcDirPath = join(srcDir, d);
    if (!existsSync(srcDirPath)) continue;
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        copyOne(relative(srcDir, p).replace(/\\/g, '/'));
      }
    };
    walk(srcDirPath);
  }
  for (const f of WHITELIST_FILES) copyOne(f);
  return copied;
}

// ---------------------------------------------------------------- 对外

/**
 * 查版本，必要时更新。
 *
 * @param {{ apply?: boolean, targetVersion?: string, targetDir?: string }} opts
 *   apply=false 只查不动手（测试用）
 * @returns {Promise<{status:string, local:string|null, remote:string|null, detail:string,
 *                    needsRestart?:boolean, updated?:string[], backup?:string, error?:string}>}
 */
export async function checkForUpdate(opts = {}) {
  const local = localVersion();
  if (!local) {
    return { status: 'unknown', local: null, remote: null, detail: '读不到本地版本号' };
  }

  let remote = opts.targetVersion ?? null;
  if (!remote) {
    const r = await remoteVersion();
    if (!r.ok) return { status: 'offline', local, remote: null, detail: r.reason };
    remote = r.version;
  }

  const cmp = compareVersion(remote, local);
  if (cmp <= 0) {
    return { status: 'same', local, remote, detail: cmp === 0 ? `已是最新（${local}）` : `本地比线上新（本地 ${local} / 线上 ${remote}）` };
  }

  // 有新版
  if (opts.apply === false) {
    return { status: 'behind', local, remote, detail: `线上有新版 ${remote}（本地 ${local}）` };
  }

  if (recentlyUpdated(remote)) {
    return { status: 'behind', local, remote, detail: `线上是 ${remote}，刚更新过还没重启，重启就生效` };
  }

  try {
    let srcDir = opts.targetDir;
    let via = 'provided';
    if (!srcDir) {
      const d = await download(remote);
      srcDir = d.dir;
      via = d.via;
    }

    // 先看本地哪些文件跟「官方该有的样子」不一样 —— 那就是主人自己改过的
    // （不改它的行为，只做备份 + 如实告诉主人，别让改动悄悄消失）
    const locals = listLocal();
    const touched = locals.filter((p) => {
      const rel = relative(ROOT, p).replace(/\\/g, '/');
      const srcFile = join(srcDir, rel);
      if (!existsSync(srcFile)) return false;
      try {
        return readFileSync(p, 'utf8') !== readFileSync(srcFile, 'utf8');
      } catch {
        return false;
      }
    });

    const backup = backupCurrent(locals);
    const copied = applyUpdate(srcDir);
    if (!copied.length) throw new Error('一个文件都没覆盖上，可能下载的东西不对');

    const nowVersion = readJson(join(ACTIVE, 'package.json'), {})?.version ?? null;
    writeFileSync(
      UPDATE_INFO,
      JSON.stringify(
        {
          at: Date.now(),
          from: local,
          to: remote,
          nowVersion,
          via,
          files: copied.length,
          backup: backup.dir,
          triedBoot: remote,
          // 这几个是主人本地改过、这次被新版覆盖掉的（备份里能找回）
          locallyModified: touched.map((p) => relative(ROOT, p).replace(/\\/g, '/')),
        },
        null,
        2,
      ),
      'utf8',
    );

    const touchedRel = touched.map((p) => relative(ROOT, p).replace(/\\/g, '/'));

    return {
      status: 'updated',
      local,
      remote,
      detail: `已自动更新 ${local} → ${remote}（${copied.length} 个文件，走 ${via}），重启后生效`
        + (touchedRel.length ? `；其中 ${touchedRel.length} 个你本地改过，原文已备份` : ''),
      needsRestart: true,
      updated: copied,
      backup: backup.dir,
      locallyModified: touchedRel,
    };
  } catch (err) {
    const msg = String(err?.message ?? err);
    // 分清两种失败，别再一律报「更新失败」把人搞糊涂：
    //   net     —— 根本连不上 GitHub（这台机器 github.com / raw 常年不通），
    //              这种重试到天亮也没用，直接告诉主人「去手动下载」，别再假装能自动更新。
    //   other   —— 连上了但半路出问题（磁盘满、文件对不上），这种可以下次再试。
    const isNet = /timeout|aborted|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|fetch failed|EAI_AGAIN|socket hang up/i.test(msg);
    const kind = isNet ? 'net' : 'other';
    const REL = `https://github.com/${REPO}/releases`;
    const detail = isNet
      ? `这台机器连不上 GitHub，自动更新走不通。新版 ${remote} 请到 ${REL} 手动下载（覆盖安装即可，会话和设置都在）。`
      : `发现新版 ${remote} 但更新失败：${msg.slice(0, 160)}`;
    try {
      writeFileSync(
        UPDATE_INFO,
        JSON.stringify({ at: Date.now(), status: 'failed', kind, from: local, to: remote, detail, error: msg.slice(0, 300) }, null, 2),
        'utf8',
      );
    } catch {}
    return {
      status: 'failed',
      kind,
      local,
      remote,
      manual: isNet,
      url: REL,
      detail,
      error: msg,
    };
  }
}

/** 这次启动要不要因为更新而重启？（防抖） */
export function shouldRestartForUpdate() {
  const info = lastUpdateInfo();
  if (!info) return false;
  if (!info.at || Date.now() - info.at > 5 * 60 * 1000) return false; // 5 分钟前的更新不重启
  if (info.restarted) return false;
  // 记一笔，避免下次还重启
  try {
    writeFileSync(UPDATE_INFO, JSON.stringify({ ...info, restarted: true }, null, 2), 'utf8');
  } catch {}
  return true;
}

const RETRY_MS = 6 * 60 * 60 * 1000; // 上次失败的话，6 小时内不再试

/**
 * 每次启动都跑一次的那条路径：只查版本 + 真更新。
 *
 * 为什么单独拎出来：自检（selfcheck.mjs）按 SELFCHECK_VERSION 节流，环境没变就
 * 一直 skip，于是「查新版本」这件事被一起跳掉了 —— 装好之后可能好几天都不知道
 * 线上发了新版。所以版本检查必须独立，每次启动都走一遍。
 *
 * 失败要落盘（带 status: 'failed'），靠它做重试节流：没网、GitHub 抽风的时候
 * 别每次启动都去撞，撞一次等 RETRY_MS 再试。
 *
 * @param {{force?: boolean}} opts force=true 时无视节流（界面上的「检查更新」用）
 * @returns {Promise<{status:string, detail:string, needsRestart?:boolean, from?:string, to?:string, files?:string[]}>}
 */
export async function quickCheck(opts = {}) {
  // 【开发态绝不自动覆盖源码】
  //
  // 这条是血换来的。config.packaged 为 false 时 ROOT 就是源码目录本身
  // （见文件顶上的 ROOT = config.packaged ? join(config.dataDir,'code') : config.root），
  // 于是 quickCheck({apply:true}) 会拿 GitHub 上的版本直接盖掉工作区。
  //
  // 后果有多恶心：开发时改的 src/server.mjs、public/index.html 还没提交，
  // 三小时一到被定时器一盖，全部变回线上那版，而且没有任何提示 ——
  // 看起来就像「代码自己回退了」。这种事在 0.9.13~0.9.19 期间反复发生了好几次，
  // 每次都白排查一轮。
  //
  // 所以开发态只查不盖：要更新就去打包版里更新，或者在源码目录里自己 git pull。
  // 想强行试更新，显式传 { applyInDev: true }。
  if (!config.packaged && !opts.applyInDev) {
    const r = await checkForUpdate({ ...opts, apply: false });
    return { status: r.status, detail: r.detail, from: r.local, to: r.remote, dev: true };
  }

  const info = lastUpdateInfo();
  if (!opts.force && info && info.status === 'failed' && Date.now() - (info.at || 0) < RETRY_MS) {
    return { status: 'throttled', detail: '上次检查失败，先歇会儿再试' };
  }
  const r = await checkForUpdate({ apply: true });
  if (r.status === 'updated') {
    return { status: 'updated', detail: r.detail, needsRestart: true, from: r.local, to: r.remote, files: r.updated };
  }
  if (r.status === 'failed') {
    try {
      writeFileSync(
        UPDATE_INFO,
        JSON.stringify({ at: Date.now(), status: 'failed', from: r.local, to: r.remote, detail: r.detail }, null, 2),
        'utf8',
      );
    } catch {}
  }
  return { status: r.status, detail: r.detail, from: r.local, to: r.remote };
}

/** 给界面用的：现在是什么情况 */
export async function updateStatus() {
  const local = localVersion();
  const info = lastUpdateInfo();
  return {
    local,
    last: info && info.status !== 'failed' ? { at: info.at, from: info.from, to: info.to } : null,
    retryAt: info && info.status === 'failed' && Date.now() - (info.at || 0) < RETRY_MS ? (info.at || 0) + RETRY_MS : null,
    // 运行中定时查的下一步时间（界面要显示「下次几点查」）
    nextAt: nextPeriodicAt(),
    periodic: PERIODIC_MS,
  };
}

// ───────────────────────────── 运行中定时查 ─────────────────────────────
//
// 为什么要有：以前只有 Electron 启动时跑一次 quickCheck。主人开着小鱼Agent
// 一整天不关，那这一天里线上发了新版也不会知道 —— 得等下次重启。
// 现在服务端自己隔一段时间查一次（结果落盘，界面一刷新就能看见）。

/** 隔多久查一次：3 小时。再密就是白撞 GitHub，再疏就跟「只在启动时查」没区别 */
const PERIODIC_MS = 3 * 60 * 60 * 1000;

/** 半夜不查：凌晨 1–7 点直接顺延到 7 点，省得主人睡着的时候机器在那儿撞网 */
function nextPeriodicAt(from = Date.now()) {
  const at = from + PERIODIC_MS;
  const d = new Date(at);
  const h = d.getHours();
  if (h >= 1 && h < 7) {
    d.setHours(7, 0, 0, 0);
    // 如果 7 点已经过了（理论上不会，h<7 保证没到），保守加一天
    if (d.getTime() <= at) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

let periodicTimer = null;

/**
 * 开一个定时器，隔 PERIODIC_MS 查一次版本。
 *
 * 注意几点：
 *   - 用 unref()，别因为这个定时器让 node 退不出去；
 *   - 查的时候给 force:false（沿用 6 小时失败节流），免得没网时反复撞；
 *   - 发现更新只记状态、不自动重启 —— 重启会把主人正在跑的对话掐掉，
 *     得由界面上那个「新版本已经下好了，点这里重启」来确认。
 */
export function startUpdateWatcher(opts = {}) {
  if (periodicTimer) return { already: true, nextAt: nextPeriodicAt() };
  const tick = async () => {
    try {
      const info = lastUpdateInfo();
      // 已经因为更新过、等着重启了，就别再查
      if (shouldRestartForUpdate()) return;
      if (info && info.status === 'failed' && Date.now() - (info.at || 0) < RETRY_MS) return;
      const r = await quickCheck({ apply: true });
      if (r.status === 'updated' || r.status === 'failed') {
        console.log(`[update] 定时查：${r.status} — ${r.detail || ''}`);
      }
    } catch (e) {
      console.warn('[update] 定时查出错（不影响使用）：', String(e?.message ?? e));
    } finally {
      const next = nextPeriodicAt();
      periodicTimer = setTimeout(tick, Math.max(60_000, next - Date.now()));
      if (periodicTimer.unref) periodicTimer.unref();
    }
  };
  // 不立刻查（启动时 Electron 那边已经查过了），等第一个周期
  periodicTimer = setTimeout(tick, Math.max(60_000, nextPeriodicAt() - Date.now()));
  if (periodicTimer.unref) periodicTimer.unref();
  return { started: true, nextAt: nextPeriodicAt() };
}

/** 收工用（自检/测试里能关掉） */
export function stopUpdateWatcher() {
  if (periodicTimer) {
    clearTimeout(periodicTimer);
    periodicTimer = null;
  }
}

/** 给自检用的那一项 */
export async function versionCheckItem() {
  const r = await checkForUpdate();
  const name = '版本更新';
  switch (r.status) {    case 'same':
      return { id: 'version', name, level: 'ok', detail: r.detail };
    case 'unknown':
      return { id: 'version', name, level: 'warn', detail: r.detail };
    case 'offline':
      return { id: 'version', name, level: 'ok', detail: `跳过（${r.detail}）` };
    case 'behind':
      return { id: 'version', name, level: 'warn', detail: r.detail, pending: true };
    case 'updated':
      return { id: 'version', name, level: 'warn', detail: r.detail, fixed: true, needsRestart: true };
    default:
      return { id: 'version', name, level: 'warn', detail: r.detail, pending: true };
  }
}
