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
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { config } from './config.mjs';

const ROOT = config.root;
const STATE = join(ROOT, '.state');
const UPDATE_INFO = join(STATE, 'update.json');
const BACKUP_ROOT = join(STATE, 'update-backup');

const REPO = 'wxzjss/xiaoyu-agent';
const BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
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
  const pkg = readJson(join(ROOT, 'package.json'), null);
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
        headers: { 'User-Agent': 'xiaoyu-updater', Accept: 'application/vnd.github+json' },
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

/** 用 git clone 拉一份到临时目录；没装 git 返回 null */
function downloadWithGit(dir) {
  const has = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (has.status !== 0) return null;
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', BRANCH, CLONE_URL, dir], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return dir;
  } catch {
    return null;
  }
}

/** 没有 git 就逐个文件从 raw 下（raw 不算 API 限额） */
async function downloadWithRaw(dir) {
  const treeUrl = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
  const res = await fetch(treeUrl, {
    headers: { 'User-Agent': 'xiaoyu-updater', Accept: 'application/vnd.github+json' },
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

  for (const f of wanted) {
    const r = await fetch(`${RAW_BASE}/${f.path}`, {
      headers: { 'User-Agent': 'xiaoyu-updater' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`下载 ${f.path} 失败 HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const dst = join(dir, f.path);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, buf);
  }
  return { dir, count: wanted.length };
}

/** 下到临时目录，返回来源目录 */
async function download(targetVersion) {
  const dir = join(tmpdir(), `xiaoyu-update-${targetVersion}-${Date.now().toString(36)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const viaGit = downloadWithGit(dir);
  if (viaGit) {
    // 校验一下下到的是不是真东西
    if (existsSync(join(dir, 'src', 'server.mjs')) && existsSync(join(dir, 'package.json'))) {
      const got = readJson(join(dir, 'package.json'), {}).version;
      if (!got || compareVersion(got, targetVersion) === 0) return { dir, via: 'git' };
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

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

    const nowVersion = readJson(join(ROOT, 'package.json'), {})?.version ?? null;
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
    // 失败也落一份记录（带 status），main.cjs 的 quickVersionCheck 靠它做重试节流
    try {
      writeFileSync(
        UPDATE_INFO,
        JSON.stringify({ at: Date.now(), status: 'failed', from: local, to: remote, detail: String(err?.message ?? err) }, null, 2),
        'utf8',
      );
    } catch {}
    return {
      status: 'failed',
      local,
      remote,
      detail: `发现新版 ${remote} 但更新失败：${String(err?.message ?? err).slice(0, 160)}`,
      error: String(err?.message ?? err),
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
