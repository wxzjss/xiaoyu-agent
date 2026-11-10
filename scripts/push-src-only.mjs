/**
 * 【定向只推 src/ —— 前端封冻期间的唯一合法同步方式】
 *
 * 为什么不能直接跑 scripts/sync-live.mjs：
 *   它那个循环（sync-live.mjs:176）同时列了 `src` 和 `public` —— 一推就把
 *   `public/index.html` 也推到主人在用的数据目录。而 2026-11-09 那天前端正在
 *   React 重写（#15）的中间态，`index.html` 里有一批符号「定义删了、调用还在」
 *   （liveItemsFeed / liveModelFlush / finishSpeech …），推过去就是白屏。
 *   所以：**后端可以单独生效，前端等重写收口再一起推**。
 *
 * 这个脚本只做一件事：把指定的几个 `src/*.mjs` 逐字节复制到
 * `<数据目录>/code/src/`，其余一概不碰。
 *
 * 安全措施（缺一不可）：
 *   1. 推之前把 `code/src` 整目录备份成 `code/src.bak-<时间戳>`
 *   2. 白名单：只推 --files 里点名的文件，不在名单里的一个都不动
 *   3. 推完逐字节比对（Buffer.equals），任何一份对不上就非零退出
 *   4. 推完复核 `public/index.html` 的字节数与 sha256 —— 变了就是出事
 *
 * 用法：
 *   node scripts/push-src-only.mjs --dry             只演练，不写
 *   node scripts/push-src-only.mjs                   推默认白名单
 *   node scripts/push-src-only.mjs --files=a.mjs,b.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const DATA = process.env.MINI_AGENT_DATA || path.join(process.env.APPDATA || '', '小鱼Agent', 'data');
const SRC = path.join(ROOT, 'src');
const LIVE_SRC = path.join(DATA, 'code', 'src');
const LIVE_PUBLIC_INDEX = path.join(DATA, 'public', 'index.html');

/* 2026-11-09 这一轮改过的后端文件。加文件请写清为什么。 */
const DEFAULT_FILES = [
  'thinking.mjs',      // 档位按 provider 分派 + perModel 稳定键
  'llm.mjs',           // 两处调用点把 ep 传进去
  'session-overrides.mjs', // 读出来就 normalizeLevel
  'models.mjs',        // 透传 thinkingFormat
  'deadline.mjs',      // 叫醒器定时器泄漏
  'server.mjs',        // session-config 的 defaultLevelName 走 levelFor(ep)
];

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const filesArg = argv.find((a) => a.startsWith('--files='));
const FILES = filesArg
  ? filesArg.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_FILES;

/**
 * 安全递归复制目录。
 *
 * 【为什么不用 fs.cpSync】实测 2026-11-09：对 `data/code/src`（178 个文件 +
 * 一个 harness 子目录）调 `fs.cpSync(src, dst, {recursive:true})`，进程直接
 * exit 127，一声不响地死掉，连 catch 都进不去（怀疑是里面某个条目触发了
 * Node 的 cp 实现崩）。而手工 `readdir` + `copyFileSync` 逐文件复制，
 * 同一份目录 178 个文件全部正常。
 *
 * 所以：备份这么关键的动作，宁可用最笨但能看见每一步的写法。
 */
function copyTree(from, to, depth = 0) {
  if (depth > 8) throw new Error('目录嵌套太深，放弃：' + from);
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name);
    const b = path.join(to, name);
    let st;
    try {
      st = fs.lstatSync(a);
    } catch {
      continue; // stat 不了的（权限/竞态）跳过，不因此整个备份失败
    }
    if (st.isSymbolicLink()) {
      try {
        fs.symlinkSync(fs.readlinkSync(a), b);
      } catch { /* 软链建不了就算了，.mjs 源码里没有 */ }
      continue;
    }
    if (st.isDirectory()) {
      n += copyTree(a, b, depth + 1);
      continue;
    }
    if (!st.isFile()) continue;
    fs.copyFileSync(a, b);
    n++;
  }
  return n;
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function die(msg) {
  console.error('✘ ' + msg);
  process.exit(1);
}

/* ── 先把前置条件全验掉，一个不对就一字节都不写 ─────────────── */
if (!fs.existsSync(LIVE_SRC)) die('找不到 ' + LIVE_SRC + '（数据目录不对？）');

/* 白名单校验：只允许推 src/ 下的 .mjs，堵掉 ../ 之类的路径穿越 */
for (const f of FILES) {
  if (!/^[A-Za-z0-9_.-]+\.mjs$/.test(f)) die('白名单里有不认识的文件名：' + JSON.stringify(f));
  if (!fs.existsSync(path.join(SRC, f))) die('仓库里没有这个文件：src/' + f);
}

const publicBefore = fs.existsSync(LIVE_PUBLIC_INDEX) ? fs.readFileSync(LIVE_PUBLIC_INDEX) : null;
const publicShaBefore = publicBefore ? sha(publicBefore) : '(不存在)';

console.log('仓库 src  →  ' + SRC);
console.log('生效 code/src  →  ' + LIVE_SRC);
console.log('要推 ' + FILES.length + ' 个文件' + (DRY ? '（演练，不写盘）' : ''));
console.log('');

/* ── 1. 备份 code/src 整目录 ───────────────────────────────── */
if (!DRY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = path.join(DATA, 'code', 'src.bak-' + stamp);
  let n = 0;
  try {
    n = copyTree(LIVE_SRC, bak);
  } catch (e) {
    die('备份失败，一字节都没推：' + String(e?.message ?? e));
  }
  if (!n) die('备份出来 0 个文件，不对劲，一字节都没推');
  console.log('已备份 code/src →  ' + bak + '（' + n + ' 个文件）');
  console.log('');
}

/* ── 2. 逐个复制并当场比对 ─────────────────────────────────── */
const results = [];
for (const f of FILES) {
  const from = path.join(SRC, f);
  const to = path.join(LIVE_SRC, f);
  const a = fs.readFileSync(from);
  const bBefore = fs.existsSync(to) ? fs.readFileSync(to) : null;
  const changed = !bBefore || !a.equals(bBefore);

  if (!DRY) {
    /* 先写临时文件再 rename：中途断电也不会留半个文件 */
    const tmp = to + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, a);
    fs.renameSync(tmp, to);
  }

  const bAfter = DRY ? bBefore : fs.readFileSync(to);
  const same = bAfter ? a.equals(bAfter) : false;
  results.push({ file: f, changed, same, bytes: a.length, sha: sha(a).slice(0, 16) });
  console.log((DRY ? '[演练] ' : '') + (changed ? '更新  ' : '本来就一致  ') + f.padEnd(24)
    + String(a.length).padStart(7) + ' bytes  sha=' + sha(a).slice(0, 16)
    + (DRY ? '' : (same ? '  ✔ 逐字节一致' : '  ✘ 对不上！')));
}

/* ── 3. 复核：public/ 一个字节都不许动 ─────────────────────── */
const publicAfter = fs.existsSync(LIVE_PUBLIC_INDEX) ? fs.readFileSync(LIVE_PUBLIC_INDEX) : null;
const publicShaAfter = publicAfter ? sha(publicAfter) : '(不存在)';
const publicUntouched = publicShaBefore === publicShaAfter;

console.log('');
console.log('data/public/index.html：' + (publicBefore ? publicBefore.length : 0) + ' bytes / sha=' + publicShaBefore.slice(0, 16));
console.log('推完再看：                ' + (publicAfter ? publicAfter.length : 0) + ' bytes / sha=' + publicShaAfter.slice(0, 16));
console.log(publicUntouched ? '✔ public/ 一个字节都没动' : '✘ public/ 被改了！立刻回滚');

const bad = results.filter((r) => !r.same && !DRY);
if (bad.length) console.log('\n✘ 这几份没对上：' + bad.map((r) => r.file).join(', '));
if (!publicUntouched || bad.length) process.exit(1);

console.log('');
console.log(DRY
  ? '演练结束，什么都没写。'
  : '✔ 已同步 ' + FILES.length + ' 个后端文件；public/ 未动。重启服务后生效。');