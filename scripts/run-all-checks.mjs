/**
 * 跑全部 check-*.mjs，前后各清一遍测试留下的脏会话。
 *
 * 【为什么要这个】
 * 有几个检查脚本会 /api/sessions/new 造临时会话。它们本来在末尾自己删，
 * 但脚本中途抛错就跳过删除 —— 2026-11-02 就因为这个在主人会话列表里
 * 留下了 6 个标题叫 __ord__ 的空会话。
 *
 * 这里不指望每个脚本自己收拾干净：跑前先扫一遍，跑完再扫一遍。
 * 判定「是测试垃圾」的规矩（宁可漏删，绝不误删主人的会话）：
 *   · 标题以 __ 开头（__ord__ / __e2e_mate_speaks__ 这类）
 *   · 而且消息数很少（<= 20），不可能是主人认真聊过的
 *
 * 【2026-11-05 加】某个脚本挂了就把它的输出尾巴打出来。以前只打 FAIL
 * 不打原因，等于逼着人再单跑一遍去猜 —— 那不算查，算赌。
 *
 * 【2026-11-09 修·判红了却打不出原因】QA 实测：`check-live-real-refresh` 超时/挂掉时
 * 报的是「FAIL 346.4s」，可「失败详情」里只有一行「隔离实例 http://…」，
 * 真实原因一个字都没有，只能单跑一遍重新等 6 分钟。
 *
 * 两层病根：
 *   ① 子进程输出走 `spawnSync(encoding:'utf8')` 的**管道** —— 有 maxBuffer 上限，
 *      而且子脚本最后那句 `process.exit()` 会把**还没写出去的管道缓冲丢掉**
 *      （Node 的老毛病：stdout 是 pipe 时写入是异步的）。于是大输出 / 尾部全丢。
 *   ② 失败时只掐最后 30 行，还不管里面有没有关键行 —— 关键行在前面的照样被切掉。
 *
 * 现在：**子进程 stdout/stderr 直接落到临时文件**（不经管道、没有 maxBuffer、
 * 也不怕 process.exit 丢缓冲），跑完按文件读：
 *   · 关键行（含 `[!!]` / `FAIL` / `Error` / `✘`）**全部打出来**，一行不切；
 *   · 尾巴最多 200 行，并写明「共多少行、这是最后多少行」；
 *   · 超时 / 被信号杀掉也照打（走同一条读文件的路）；
 *   · 失败时完整日志留在磁盘上并把路径打出来，要深挖直接打开看。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { startIsolated } from './_test-instance.mjs';

/* 【2026-11-09 闸】全量回归只在隔离实例上跑。
 * 以前默认连 8788 —— 那正是主人开着的窗口，检查会在他的会话里发消息、
 * 造会话、开关智能体。现在临时目录 + 独立端口 + 独立浏览器，用完就删。
 * 起不来直接抛错退出，绝不退回主人实例。 */
let iso;
try {
  iso = await startIsolated();
} catch (e) {
  console.error('起隔离实例失败（绝不回落到主人实例）：', (e && e.stack) || e);
  process.exit(2);
}
console.log('隔离自检实例 ' + iso.base + '（配置副本 ' + iso.copied + ' 份，不含任何会话）');

/* sweep 也只准扫隔离目录。以前这里读 MINI_AGENT_DATA（没设就落回主人 data），
 * 等于每次回归都在主人的会话目录里删文件 —— 光是「会删」这件事就不该发生。 */
const DATA = iso.dataDir;
const SESS_DIR = path.join(DATA, '.state', 'sessions');

function sweep(tag) {
  if (!fs.existsSync(SESS_DIR)) return 0;
  const files = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith('.json') && !f.includes('.bak'));
  let n = 0;
  for (const f of files) {
    const p = path.join(SESS_DIR, f);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const t = String(j.title || '');
      const cnt = Array.isArray(j.messages) ? j.messages.length : 0;
      if (t.startsWith('__') && cnt <= 20) {
        fs.unlinkSync(p);
        n++;
        console.log('  [sweep:' + tag + '] 删测试会话 ' + f + ' title=' + JSON.stringify(t) + ' msgs=' + cnt);
      }
    } catch { /* 读不了就跳过，别把主人的东西删了 */ }
  }
  if (n) console.log('  [sweep:' + tag + '] 共清 ' + n + ' 个');
  return n;
}

/**
 * 【2026-11-08 修·分档入口不能被当成单项检查】
 *
 * 主人要「跑冒烟 / 跑变更 / 跑核心 / 跑全量」四档分清楚。
 * 可 check-smoke / check-changed / check-core 也长成 check-*.mjs 的样子，
 * 于是全量会**把它们当普通检查再跑一遍**：
 *   全量 → check-core → 里面又跑 11 个 → 56 秒白花，还跟正在跑的服务抢资源
 * （实测那 4 个红里有 2 个就是这么撞出来的）。
 * 这三个是**入口**，不是单项，全量只跑真正的一条条检查。
 */
const TIER_ENTRY = new Set(['check-smoke.mjs', 'check-changed.mjs', 'check-core.mjs']);
/* 【2026-11-08 加】check-gates-self 不进全量回归。
 * 它会把 public/index.html 改坏再还原（验证检查器抓得住），
 * 跑的那几秒里别的脚本读到的是坏文件 —— 全量回归里反复因此爆假红。
 * 它验的是「检查器本身」，属于元测试，单独跑：node scripts/check-gates-self.mjs */
const META_ONLY = new Set(["check-gates-self.mjs"]);

const scripts = fs
  .readdirSync(path.join(process.cwd(), 'scripts'))
  .filter((f) => /^check-.*\.mjs$/.test(f) && !TIER_ENTRY.has(f) && !META_ONLY.has(f))
  .sort();

console.log('=== 开始前先清一遍 ===');
sweep('before');

let fail = 0;
/* 【2026-11-09 修·分母对不上】`fail` 是个总失败数，里面还含 `_t_*` 那几个「额外」脚本
 * （_t_post / _t_ui / _t_api …）—— 可它们不在 `scripts.length` 里。
 * 于是自测时出现「回归：-1/3 通过」这种鬼数字，看着像 runner 自己坏了。
 * 现在另记一个「check-*.mjs 这一批里挂了几个」，分子分母同一个集合；
 * 额外脚本单独一行报。 */
let failChecks = 0;
const failed = [];
const tails = [];
/* 【2026-11-08 加】每个检查记一笔耗时，末尾报最慢的几个。
 * 主人问「为什么每次跑回归都这么慢」—— 以前只打印 OK/FAIL，
 * 70 个串行跑完根本看不出时间花在哪。 */
const durations = [];

/* ══════════════════════════════════════════════════════════════════
 * 跑子脚本 + 抓输出：落文件，不靠管道
 * ══════════════════════════════════════════════════════════════════ */
/** 失败时尾巴最多打这么多行（够看，又不刷屏） */
const TAIL_MAX = 200;
/** 定位用的关键行：命中就**全部**打出来，不受尾巴截断影响 */
const KEY_LINE_RE = /\[!!\]|FAIL|Error|✘/;
/** 完整日志留在这儿（不在隔离数据目录里，隔离实例删掉不影响它） */
const LOG_DIR = path.join(os.tmpdir(), 'xy-runall-logs');
let _logSeq = 0;
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

/**
 * 跑一个子脚本，输出**直接写文件**。
 *
 * 为什么不用 encoding:'utf8' 拿返回值：
 *   · spawnSync 有 maxBuffer，超了会截断甚至杀进程；
 *   · 子脚本末尾 `process.exit()` 会把管道里还没送出去的缓冲丢掉 ——
 *     这正是「判红了却只剩第一行」的真凶（stdout 是 pipe 时写是异步的）。
 * 落文件两头都躲开了，而且超时 / 被信号杀掉也能读到已经写出来的那部分。
 */
function runToFile(label, scriptPath, { timeout, env } = {}) {
  const safe = String(label).replace(/[^\w.\-]+/g, '_');
  const file = path.join(LOG_DIR, String(++_logSeq).padStart(2, '0') + '-' + safe + '.log');
  let fd = null;
  let r = null;
  try {
    fd = fs.openSync(file, 'w');
    r = spawnSync(process.execPath, [scriptPath], {
      stdio: ['ignore', fd, fd],     // 同一条 fd 给 stdout 和 stderr：看到的就是发生顺序
      timeout,
      env,
    });
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
  let text = '';
  let readCut = 0;         // >0 = 输出太大，只读了最后这么多字节
  try {
    const st = fs.statSync(file);
    /* 兜底：万一某个脚本刷出几百 MB，别把整个文件读进内存（会拖死 runner 自己）。
     * 只读最后 4MB —— 失败原因几乎总在尾部，而且前面的关键行本来也已经超了上限。 */
    const MAX_READ = 4 * 1024 * 1024;
    if (st.size > MAX_READ) {
      const buf = Buffer.alloc(MAX_READ);
      const rf = fs.openSync(file, 'r');
      try { fs.readSync(rf, buf, 0, MAX_READ, st.size - MAX_READ); } finally { try { fs.closeSync(rf); } catch {} }
      text = buf.toString('utf8');
      readCut = MAX_READ;
    } else {
      text = fs.readFileSync(file, 'utf8');
    }
  } catch {}
  const errCode = r && r.error ? (r.error.code || String(r.error.message || r.error)) : '';
  const timedOut = errCode === 'ETIMEDOUT' || (r && r.signal === 'SIGTERM' && errCode !== '');
  return { r, text, file, errCode, timedOut, readCut };
}

/**
 * 一次失败要打的东西：状态 + 关键行（全打）+ 尾巴（≤200 行）+ 完整日志路径。
 * 这是这次修的核心：**关键行永远不因为截断而消失**。
 */
function failureBlock(label, got) {
  const r = got.r || {};
  const all = String(got.text || '').replace(/\r\n/g, '\n').split('\n');
  /* 去掉末尾那一串空行（文件末尾必有换行），但保留中间的空行 */
  let end = all.length;
  while (end > 0 && all[end - 1] === '') end--;
  const lines = all.slice(0, end);
  const total = lines.length;

  const keyLines = lines.filter((l) => KEY_LINE_RE.test(l));
  const tail = total <= TAIL_MAX ? lines : lines.slice(-TAIL_MAX);

  const out = [];
  out.push('──── ' + label + ' ────');
  out.push('  status=' + r.status + ' signal=' + r.signal
    + (got.errCode ? ' error=' + got.errCode : '')
    + (got.timedOut ? '  ← 超时被杀（这一个不是「检查失败」，是跑不完）' : '')
    + '  输出共 ' + total + ' 行'
    + (got.readCut ? '（输出太大，只读了最后 ' + Math.round(got.readCut / 1024 / 1024) + 'MB）' : ''));

  if (got.timedOut && total === 0) {
    out.push('  （超时且一个字都没输出 —— 大概率卡在等网络/等端口，不是断言失败）');
  } else if (keyLines.length) {
    out.push('  ── 关键行 [!!] / FAIL / Error / ✘ 共 ' + keyLines.length + ' 行，全部列出 ──');
    for (const l of keyLines) out.push('  ' + l);
  } else {
    out.push('  ── 输出里没有 [!!] / FAIL / Error / ✘ 这类关键行（看下面的尾巴）──');
  }

  out.push('  ── 尾巴：' + (total <= TAIL_MAX ? '全部 ' + total + ' 行' : '最后 ' + TAIL_MAX + ' 行（共 ' + total + ' 行）') + ' ──');
  for (const l of tail) out.push('  ' + l);

  out.push('  · 完整输出：' + got.file + '（跑完没删，要深挖直接打开）');
  return { text: out.join('\n'), file: got.file };
}

/** 成功就把日志删掉，别在临时目录里堆垃圾 */
function dropLog(got) {
  if (!got || !got.file) return;
  try { fs.unlinkSync(got.file); } catch {}
}
for (const f of scripts) {
  process.stdout.write(f.padEnd(36));
  const t0 = Date.now();
  const got = runToFile(f, path.join(process.cwd(), 'scripts', f), {
    timeout: 15 * 60 * 1000,
    env: iso.env,
  });
  const ms = Date.now() - t0;
  const r = got.r || {};
  durations.push([f, ms]);
  if (r.status === 0) {
    console.log(' OK  ' + (ms / 1000).toFixed(1) + 's');
    dropLog(got);
  } else {
    fail++;
    failChecks++;
    failed.push(f);
    console.log(' FAIL  ' + (ms / 1000).toFixed(1) + 's'
      + (got.timedOut ? '（超时）' : '') + '  输出 ' + got.file);
    tails.push(failureBlock(f, got).text);
  }
}

/* ─────────────────────────────────────────────────────────────

   【2026-11-05 加】真机 UI 自检
   check-ui.mjs 只能证明"不会白屏"。真正渲染出来对不对，得在浏览器里看。
   这条路已经抓到过：markdown 代码块压根不渲染、大图关闭键压在图角上 ——
   两个静态检查全部漏掉的 bug。

   跑不了的时候（App 没开 / 没有 Edge）**明确说跳过**，不装作通过。
   要强制跳过用 --no-ui。
   ───────────────────────────────────────────────────────────── */
/* 【2026-11-05 加】POST 接口健壮性：自己起一个隔离实例（临时数据目录），
 * 空 body 打一遍，看有没有「没校验就 5xx」的。不碰主人正在用的那份。 */
process.stdout.write('_t_post.mjs（POST）'.padEnd(36));
const _gp = runToFile('_t_post', path.join(process.cwd(), '_t_post.mjs'), {
  timeout: 6 * 60 * 1000,
  env: iso.env,
});
if ((_gp.r || {}).status === 0) {
  console.log(' OK');
  dropLog(_gp);
} else {
  fail++;
  failed.push('_t_post.mjs');
  console.log(' FAIL  输出 ' + _gp.file);
  tails.push(failureBlock('_t_post.mjs', _gp).text);
}

if (!process.argv.includes('--no-ui')) {
  let alive = false;
  try {
    execFileSync(process.execPath, ['-e',
      "fetch('" + iso.base + "/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      { timeout: 6000, stdio: 'ignore' });
    alive = true;
  } catch { alive = false; }

  if (!alive) {
    console.log('');
    for (const _f of ['_t_ui.mjs（真机）', '_t_api.mjs（接口）', '_t_tools.mjs（工具）', '_t_write.mjs（写类）', '_t_agents2.mjs（办事/智能体）', '_t_prompt.mjs（system 预算）']) {
      console.log(_f.padEnd(36) + ' 跳过：隔离实例没在跑（' + iso.base + ' 连不上）');
    }
  } else {
    process.stdout.write('_t_ui.mjs（真机）'.padEnd(36));
    const gui = runToFile('_t_ui', path.join(process.cwd(), '_t_ui.mjs'), {
      timeout: 4 * 60 * 1000,
      env: iso.env,
    });
    if ((gui.r || {}).status === 0) {
      console.log(' OK');
      dropLog(gui);
    } else {
      fail++;
      failed.push('_t_ui.mjs');
      console.log(' FAIL  输出 ' + gui.file);
      tails.push(failureBlock('_t_ui.mjs', gui).text);
    }

    /* 【2026-11-05 加】接口全量 + 只读工具：都只读，不会改任何状态 */
    for (const _extra of ['_t_api.mjs', '_t_tools.mjs', '_t_write.mjs', '_t_agents2.mjs', '_t_prompt.mjs']) {
      process.stdout.write(_extra.padEnd(36));
      const gx = runToFile(_extra, path.join(process.cwd(), _extra), {
        timeout: 3 * 60 * 1000,
        env: iso.env,
      });
      if ((gx.r || {}).status === 0) {
        console.log(' OK');
        dropLog(gx);
      } else {
        fail++;
        failed.push(_extra);
        console.log(' FAIL  输出 ' + gx.file);
        tails.push(failureBlock(_extra, gx).text);
      }
    }
  }
}

console.log('');
console.log('=== 跑完再清一遍 ===');
sweep('after');

console.log('');
console.log('──────');
if (tails.length) {
  console.log('=== 失败详情 ===');
  console.log(tails.join('\n\n'));
  console.log('');
}
console.log('回归：' + (scripts.length - failChecks) + '/' + scripts.length + ' 通过'
  + (fail - failChecks ? '（另有 ' + (fail - failChecks) + ' 个额外脚本挂了：'
    + failed.filter((x) => !scripts.includes(x)).join(', ') + '）' : ''));
/* 最慢的几个单独列出来：慢一次就知道该优化谁，不用靠猜 */
const slow = durations.slice().sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('耗时合计 ' + (durations.reduce((a, b) => a + b[1], 0) / 1000).toFixed(1)
  + 's，最慢的几个：');
for (const [f, ms] of slow) console.log('  ' + (ms / 1000).toFixed(1).padStart(7) + 's  ' + f);
if (fail) console.log('失败：' + failed.join(', '));
await iso.stop();
console.log('隔离实例已关闭，临时数据已删除');
process.exit(fail ? 1 : 0);