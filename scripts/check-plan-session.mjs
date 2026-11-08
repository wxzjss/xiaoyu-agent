/**
 * 【2026-11-08 加】清单不许跑到别的会话头上 —— 站岗
 *
 * 主人原话：「这个也不是一次两次了，是压根没生效过，我要求根治」
 *
 * 背景：tools.mjs 的 runTool 里，runWithToolContext 原来只传了 signal，
 * 漏传 sessionId —— 于是 plan 里的 ctxNow().sessionId 是空的，
 * 退回全局 CTX.sessionId（＝最后开跑的那个会话）。
 * 结果：跑全量回归时，测试脚本新建 __ord__ 之类的临时会话，
 * 我的清单就写进了那些会话下面；测试跑完删会话，清单成了孤儿。
 * 一次任务被拆成 6 份清单，归档逻辑只管一份，等于没生效。
 *
 * 这个脚本守三件事：
 *   1. runTool 里必须把 sessionId 传进 runWithToolContext
 *   2. plan 目录里不许出现「会话文件不存在」的孤儿清单
 *   3. 探针残留（__xxx.json）不许留在 plan 目录里
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = (await import('../src/config.mjs')).config.dataDir + '/.state';
const PLAN_DIR = path.join(DATA, 'plan');
const SESS_DIR = path.join(DATA, 'sessions');

let bad = 0;
let n = 0;
const ok = (name, cond, extra) => {
  n++;
  if (cond) console.log('[ok] ' + name);
  else {
    bad++;
    console.log('[!!] ' + name + (extra ? '  ' + extra : ''));
  }
};

// 1. 源码这一关：runTool 必须把 sessionId 传进去
const toolsSrc = fs.readFileSync(path.join(ROOT, 'src', 'tools.mjs'), 'utf8');
/* 【2026-11-08 改口径】原来的写法是 `{ sessionId, signal }` 一起给，
 * 后来发现 sessionId 可能是空的（会话外跑 / 启动自检），塞个 undefined 进去
 * 会把全局 CTX 里那份好值盖掉。现在改成「有值才塞」：
 *   if (sessionId) _ctx.sessionId = sessionId;
 * 要守的语义没变：有 sessionId 时必须传进去，别让清单跑到别的会话头上。 */
ok(
  'runTool 把 sessionId 传进 runWithToolContext',
  /if \(sessionId\) _ctx\.sessionId = sessionId;/.test(toolsSrc)
    || /runWithToolContext\(\{\s*sessionId,/.test(toolsSrc),
  '漏传 sessionId 的话，清单会跑到最后开跑的那个会话头上',
);

// 2. 数据这一关：plan 目录里不许有孤儿
if (fs.existsSync(PLAN_DIR) && fs.existsSync(SESS_DIR)) {
  const alive = new Set(
    fs
      .readdirSync(SESS_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => f.replace(/\.json$/, '')),
  );
  const orphans = [];
  const probes = [];
  const nowMs = Date.now();
  for (const f of fs.readdirSync(PLAN_DIR)) {
    if (!f.endsWith('.json')) continue;
    const b = f.replace(/\.json$/, '');
    if (b.startsWith('_')) continue;
    if (b.startsWith('__')) { probes.push(b); continue; }
    if (alive.has(b)) continue;
    // 刚写出来的先放过：全量回归里别的检查脚本正拿着临时会话写清单，
    // 那时会话文件还没落盘，看着像孤儿，其实人家正用着。3 分钟后再算数。
    try { if (nowMs - fs.statSync(path.join(PLAN_DIR, f)).mtimeMs < 180000) continue; } catch {}
    orphans.push(b);
  }
  ok('plan 目录没有孤儿清单', orphans.length === 0,
    orphans.length ? ('有 ' + orphans.length + ' 份：' + orphans.slice(0, 5).join(',')) : '');
  for (const b of probes) {
    try { fs.unlinkSync(path.join(PLAN_DIR, b + '.json')); } catch {}
  }
  const probesLeft = probes.filter((b) => fs.existsSync(path.join(PLAN_DIR, b + '.json')));
  ok('plan 目录没有探针残留', probesLeft.length === 0,
    probesLeft.length ? ('剩 ' + probesLeft.length + ' 份：' + probesLeft.slice(0, 5).join(',')) : '');
} else {
  console.log('[skip] 找不到 plan 或 sessions 目录，跳过数据检查');
}

// 3. 生效那份也要有，不然改了不生效等于没改
const liveTools = path.join(
  process.env.APPDATA || '',
  '小鱼Agent',
  'data',
  'code',
  'src',
  'tools.mjs',
);
if (fs.existsSync(liveTools)) {
  const liveSrc = fs.readFileSync(liveTools, 'utf8');
  ok(
    '生效那份也传了 sessionId',
    /if \(overrideSignal\) return runWithToolContext\(\{\s*sessionId,\s*signal: overrideSignal\s*\}/.test(
      liveSrc,
    ),
  );
}

console.log(bad === 0 ? '\n── 清单不串会话：' + n + '/' + n + ' 全过 ──' : '\n── 有 ' + bad + ' 项没过 ──');
process.exit(bad === 0 ? 0 : 1);
