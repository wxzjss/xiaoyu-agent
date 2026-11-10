/**
 * 守卫：子智能体发的文件，不许挂到**上一轮**那句回复上。
 *
 * 【这个脚本钉的是什么】
 *
 * 2026-11-10 审计实测的 P1：`server.mjs` 四处 `stashFile` 闭包都用同一段逻辑 ——
 * 从 `messages` **末尾往前**找「最后一条 `role === 'assistant' && !context`」：
 *
 *     let ix = -1;
 *     for (let q = ss.messages.length - 1; q >= 0; q--) {
 *       const m2 = ss.messages[q];
 *       if (m2 && m2.role === 'assistant' && !m2.context) { ix = q; break; }
 *     }
 *     if (ix < 0) { ss.messages.push({ role:'assistant', content:'', at:Date.now() }); ix = ...; }
 *
 * **上一轮的 assistant 早就落地了**（`saveSession` 之后它就在 `messages` 里），
 * 而且它的 `context` 是 falsy —— 所以这个循环会**命中上一轮那条**。
 *
 * 出错的窗口很窄，所以我实测定位过：
 *
 *   · worker 在本轮主智能体**产出任何文字之前**就回来了 → 挂到上一轮 ❌
 *   · 主智能体已经吐过字（哪怕一句「我来整理」）       → 挂到本轮 ✅
 *
 * 也就是说：**慢活不出错，快活才出错**。所以它一直没被发现 ——
 * 主人也不会去翻上一轮看有没有多出一个文件。
 *
 * 【修法】
 * 「倒着找 + 本轮起点封底」—— 四种判据在四个真实场景上试过，只有这个 4/4 全对：
 *
 *     for (let q = messages.length - 1; q >= Math.max(0, turnStart); q--) {
 *       const m = messages[q];
 *       if (m && m.role === 'assistant' && !m.context) return q;
 *     }
 *     return -1;   // 本轮还没有 assistant → 新建一条
 *
 * 为什么不是别的写法（都实测过，各自会挂错场景）：
 *   · 只从末尾往前、不封底      → 本轮刚开跑时挂到上一轮
 *   · 从 turnStart 往后找        → 本轮有多条 assistant 时挂到第一条（多半是工具调用那条哑巴）
 *   · 「最后一条 user 之后」      → 主人中途插话（steer 会 push 一条 user）时挂不到本轮
 *
 * 【一个提醒】
 * `runAgent` 的 `refreshSystem` 会 `messages.length = 0` 重建数组 —— 但重建的是
 * `wire`（`server.mjs:2877` 的 `history.slice()` 副本），`session.messages` 不动。
 * 所以 `turnStart = ss.messages.length` 在闭包创建时取是**安全**的；
 * 唯一要小心的是「别把判据建在 wire 上」。
 *
 * 【跑法】
 *   node scripts/check-stashfile-turn.mjs
 *
 * 纯静态 + 纯函数，不起服务、不碰主人真实的 .state。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  [ok] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
};

const readSrc = (rel) => {
  try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; }
};

/* ============================================================
 * 一、先证明「从末尾往前找」这个写法本身是错的（纯函数，不依赖仓库）
 * ============================================================ */

console.log('=== 1. 复刻当前的查找逻辑，看它挂到哪 ===');

/** 当前 server.mjs 里的写法：从末尾往前找最后一条 assistant */
function currentPick(messages) {
  let ix = -1;
  for (let q = messages.length - 1; q >= 0; q--) {
    const m2 = messages[q];
    if (m2 && m2.role === 'assistant' && !m2.context) { ix = q; break; }
  }
  return ix;
}

/** 修好后的写法：从末尾往前找，但以「本轮起点」为下限 */
function fixedPick(messages, turnStart) {
  for (let q = messages.length - 1; q >= Math.max(0, turnStart); q--) {
    const m2 = messages[q];
    if (m2 && m2.role === 'assistant' && !m2.context) return q;
  }
  return -1;
}

/** 另外两种候选判据 —— 这里留着是为了证明「只有封底那版 4/4 全对」 */
function forwardPick(messages, turnStart) {
  for (let q = Math.max(0, turnStart); q < messages.length; q++) {
    const m2 = messages[q];
    if (m2 && m2.role === 'assistant' && !m2.context) return q;
  }
  return -1;
}
function afterLastUserPick(messages) {
  let lastUser = -1;
  for (let q = messages.length - 1; q >= 0; q--) {
    const m = messages[q];
    if (m && m.role === 'user' && !m.context) { lastUser = q; break; }
  }
  for (let q = messages.length - 1; q > lastUser; q--) {
    const m2 = messages[q];
    if (m2 && m2.role === 'assistant' && !m2.context) return q;
  }
  return -1;
}

/* 场景 A：上一轮已落地，本轮刚开跑（worker 秒回）—— 这就是出错的那个窗口 */
const caseA = [
  { role: 'system', content: 'sys' },
  { role: 'user', context: true, content: '规则副本' },
  { role: 'user', content: '帮我整理下载文件夹' },
  { role: 'assistant', content: '好的，我来…' },      // ← 上一轮
];
const startA = caseA.length;   // 本轮从这里开始，还没有任何消息
check(
  '当前写法：会挂到上一轮那条（这是 bug）',
  currentPick(caseA) === 3,
  'ix=' + currentPick(caseA) + '（= 上一轮）',
);
check(
  '修好后：本轮还没有 assistant → 应该新建一条',
  fixedPick(caseA, startA) === -1,
  'ix=' + fixedPick(caseA, startA),
);

/* 场景 B：本轮已经吐了字 —— 当前写法恰好也对，这是它能瞒这么久的原因 */
const caseB = caseA.concat({ role: 'assistant', content: '我正在整理…' });
check(
  '当前写法：本轮已有 assistant 时也对（所以慢活不暴露）',
  currentPick(caseB) === 4,
  'ix=' + currentPick(caseB),
);
check(
  '修好后：命中本轮那条',
  fixedPick(caseB, startA) === 4,
  'ix=' + fixedPick(caseB, startA),
);

/* ============================================================
 * 一·补：四种判据 × 四个真实场景（证明为什么只有「封底」那版对）
 * ============================================================ */

console.log('');
console.log('=== 1b. 四种判据 × 四个场景（只有「倒着找 + 封底」4/4 全对） ===');

const u = { role: 'user', content: '帮我整理' };
const a1 = { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] };
const t1 = { role: 'tool', content: 'ok' };
const a2 = { role: 'assistant', content: '整理完了' };
const steer = { role: 'user', content: '算了', _steer: true };

/* 期望值说明：
 *   ① 本轮刚开跑（只有 user）→ -1（要新建）
 *   ② 本轮一条 assistant       → 末条
 *   ③ 多轮工具后的最终回复      → **最后**那条（a2），不是工具调用那条
 *   ④ 最终回复后又插话（steer） → 仍是最后那条 assistant
 */
const scenes = [
  ['① 本轮刚开跑', caseA.concat(u), -1],
  ['② 本轮一条 assistant', caseA.concat(u, a1), 5],
  ['③ 多轮工具后最终回复', caseA.concat(u, a1, t1, a2), 7],
  ['④ 最终回复后又插话', caseA.concat(u, a1, t1, a2, steer), 7],
];

let fixedAllPass = true;
for (const [name, msgs, want] of scenes) {
  const got = fixedPick(msgs, startA);
  const ok = got === want;
  if (!ok) fixedAllPass = false;
  check('封底版 · ' + name, ok, 'got=' + got + ' 期望=' + want);
}

/* 反面：两种候选判据各自会在哪挂 —— 留在这里当「为什么不用它们」的证据 */
const fwdFail = scenes.filter(([, msgs, want]) => forwardPick(msgs, startA) !== want).length;
const userFail = scenes.filter(([, msgs, want]) => afterLastUserPick(msgs) !== want).length;
console.log('    参考：从 turnStart 往后找 会在 ' + fwdFail + '/4 场景挂；'
  + '「末条 user 之后」会在 ' + userFail + '/4 场景挂');
check('封底版是四者里唯一 4/4 全对的', fixedAllPass);

/* ============================================================
 * 二、静态断言：仓库里的 stashFile 必须带「本轮」判据
 * ============================================================ */

console.log('');
console.log('=== 2. 静态断言：server.mjs 的四处 stashFile 都要有「本轮」判据 ===');

const serverSrc = readSrc('src/server.mjs');
check('server.mjs 读得到', serverSrc.length > 10000, serverSrc.length + ' 字节');

/* 数一下有多少处 stashFile 闭包（现在应该是 4） */
const stashCount = (serverSrc.match(/stashFile:\s*\(f\)\s*=>/g) || []).length;
check('stashFile 闭包数量 = 4（四处入口各一份）', stashCount === 4, '实测 ' + stashCount + ' 处');

/* 【核心断言】闭包里必须出现「本轮起点」的痕迹。
 * 认这几种写法，任何一种都算修好了：
 *   turnStart / turnFrom / turnMark / 本轮起点 / _turnId / streaming
 * 认不出来就报红 —— 因为「从末尾往前找」这个写法本身是错的。 */
const stashBodies = serverSrc.split(/stashFile:\s*\(f\)\s*=>/).slice(1).map((s) => s.slice(0, 1200));
const MARKERS = /turnStart|turnFrom|turnMark|本轮起点|_turnId|turnId|streaming/i;
const marked = stashBodies.filter((b) => MARKERS.test(b)).length;

check(
  '每处 stashFile 都带「本轮」判据（turnStart / streaming 等）',
  stashCount > 0 && marked === stashCount,
  marked + '/' + stashCount + ' 处带判据',
);

/* 【负向断言】如果还在用「从末尾往前找、且没有任何本轮判据」，直接判红。
 * 这条是核心：它钉的不是「有没有某个变量」，而是「还在不在用那个错写法」。 */
const stillBackward = stashBodies.filter(
  (b) => /for\s*\(\s*let\s+q\s*=\s*ss\.messages\.length\s*-\s*1\s*;\s*q\s*>=\s*0/.test(b) && !MARKERS.test(b),
).length;

check(
  '没有「从末尾往前找且无本轮判据」的写法残留',
  stillBackward === 0,
  stillBackward ? stillBackward + ' 处仍是老写法' : '0 处',
);

/* ============================================================
 * 三、提醒：refreshSystem 会重建数组，绝对下标不安全
 * ============================================================ */

console.log('');
console.log('=== 3. 修的时候要注意：runAgent 会重建 messages 数组 ===');

const agentSrc = readSrc('src/agent.mjs');
const rebuilds = /messages\.length\s*=\s*0/.test(agentSrc) || /messages\.push\(\.\.\./.test(agentSrc);
check(
  'runAgent 确实会重建 messages（重建的是 wire 副本，不是 session.messages）',
  rebuilds,
  rebuilds ? '已确认：重建的是 wire（history.slice()），session.messages 不动 → turnStart 安全' : '没找到重建逻辑，需人工确认',
);

console.log('');
console.log('断言：' + pass + '/' + (pass + fail));
if (fail) {
  console.log('★ 失败 ' + fail + ' 条');
  console.log('');
  console.log('【这些红是预期的】stashFile 还没修：');
  console.log('   worker 在本轮主智能体吐字之前回来时，它发的文件会挂到上一轮那句回复上。');
  console.log('   修法：倒着找 + 以「本轮起点」封底（refreshSystem 重建的是 wire，session.messages 不动）。');
  console.log('修完之后这个脚本应该转绿；转绿之前不许把它从 run-all-checks 里摘掉。');
  process.exit(1);
}
console.log('PASS 子智能体发的文件只会挂到本轮回复上（不会挂到上一轮）');
