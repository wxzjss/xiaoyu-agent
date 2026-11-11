/**
 * 【插话在历史里出现两遍（数据层双写）】—— 2026-11-11
 *
 * 主人报的现象：同一句插话在服务端历史里躺着两份（办事鱼会话 [246][247][248] 三条
 * STEER 紧相邻、中间零回复）。她看到屏幕上没动静就反复重发，其中一部分是双写造成的。
 *
 * 根因两条，各自的判据分别是：
 *   ① /api/chat 落盘时的防重闸（server.mjs 的 findDupUserRef）—— 它对 `_steer`
 *      **一律跳过**，而 /api/interject 判「没在跑」时正是**带 _steer 直推进历史**。
 *      前端随后用同一句 POST /api/chat，对不上 → 又 push 一份。
 *   ② agent loop 取信箱（agent.mjs 的 isSteerAlreadyLanded）—— 那句已经因为①的
 *      直推落了盘，信箱里又排了一份，drainSteps 取出来再 push = 第二份。
 *
 * 两个判据都是「收得很窄」的：只认同文 + 带 _steer + 紧挨队尾。
 * 这条检查把源码里的两个函数**抠出来真跑**（跟 check-live-history-split 验
 * trimTurnsForLive 是同一套路子），钉住「该拦的拦、不该吞的不吞」。
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('chat / 插话双写');

/** 从源码里按大括号配对抠出一个函数 */
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return new Function(src.slice(i, k + 1) + '\nreturn ' + name + ';')();
        } catch { return null; }
      }
    }
  }
  return null;
}

const SERVER = fs.readFileSync('src/server.mjs', 'utf8');
const AGENT = fs.readFileSync('src/agent.mjs', 'utf8');

const findDupUserRef = grabFn(SERVER, 'findDupUserRef');
const isSteerAlreadyLanded = grabFn(AGENT, 'isSteerAlreadyLanded');

t.ok('server.mjs 里能找到 findDupUserRef', typeof findDupUserRef === 'function');
t.ok('agent.mjs 里能找到 isSteerAlreadyLanded', typeof isSteerAlreadyLanded === 'function');

/* 接线：函数写了还得真被调用，否则「钉住了一个没人用的函数」= 白钉 */
t.ok('server.mjs 落盘处真的调了 findDupUserRef',
  /const\s+__dupUserRef\s*=\s*findDupUserRef\(history,\s*userMsg\)/.test(SERVER));
t.ok('agent.mjs 取信箱处真的调了 isSteerAlreadyLanded',
  /if\s*\(\s*isSteerAlreadyLanded\(messages,\s*it\.text\)\s*\)\s*continue;/.test(AGENT));

/* ── ① 落盘防重闸 ─────────────────────────────────────────── */
if (typeof findDupUserRef === 'function') {
  const NOW = 1_800_000_000_000;
  const U = (content, extra = {}) => ({ role: 'user', content, at: NOW - 1000, ...extra });
  const A = (toolCalls) => (toolCalls
    ? { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] }
    : { role: 'assistant', content: '她说的话' });

  /* 双写主战场：直推的 _steer 副本就在队尾、刚写 → 必须认出「已经有了」 */
  {
    const hist = [U('前面那句'), A(false), U('插话正文', { _steer: true, at: NOW - 5000 })];
    const got = findDupUserRef(hist, { content: '插话正文', _who: '' }, NOW);
    t.ok('① 队尾的 _steer 副本（刚写）→ 认出已存在，不再 push', got === hist[2]);
  }
  /* 队尾但不是刚写的（五分钟前）→ 不算，照常 push（那种是上一轮的事） */
  {
    const hist = [U('前面那句'), A(false), U('插话正文', { _steer: true, at: NOW - 5 * 60 * 1000 })];
    const got = findDupUserRef(hist, { content: '插话正文', _who: '' }, NOW);
    t.ok('① 队尾的 _steer 但是 5 分钟前 → 不算（上一轮的话，照常落）', got === null);
  }
  /* _steer 在中间（不是队尾）→ 不算对照物（原来那条规矩没被破坏） */
  {
    const hist = [U('插话正文', { _steer: true, at: NOW - 1000 }), { role: 'tool', content: 'x' }, U('她后来的话')];
    const got = findDupUserRef(hist, { content: '插话正文', _who: '' }, NOW);
    t.ok('① 中间的 _steer → 依旧不算对照物', got === null);
  }
  /* 老规矩：普通 user 同文 + 中间她没答过话 → 认成兜底重发 */
  {
    const hist = [U('前面那句'), U('主人这句'), { role: 'tool', content: 'x' }];
    const got = findDupUserRef(hist, { content: '主人这句', _who: '' }, NOW);
    t.ok('① 普通 user 同文（她没答过）→ 认成兜底重发', got === hist[1]);
  }
  /* 中间她真答过话 → 有意重发，两条都落 */
  {
    const hist = [U('主人这句'), A(false)];
    const got = findDupUserRef(hist, { content: '主人这句', _who: '' }, NOW);
    t.ok('① 中间她答过话 → 有意重发，不吞', got === null);
  }
  /* 带 tool_calls 的 assistant 不算「答过话」，继续往前扫 */
  {
    const hist = [U('主人这句'), A(true), { role: 'tool', content: 'ok' }];
    const got = findDupUserRef(hist, { content: '主人这句', _who: '' }, NOW);
    t.ok('① 中间只有工具过程 → 继续当兜底重发', got === hist[0]);
  }
  /* 群聊：别的成员发同文，不吞 */
  {
    const hist = [U('同样一句', { _who: '小鲸' })];
    const got = findDupUserRef(hist, { content: '同样一句', _who: '主人' }, NOW);
    t.ok('① 同文但署名不同（群聊别人说的）→ 不吞', got === null);
  }
  /* 空历史 / 非数组 */
  t.ok('① 空历史不出错', findDupUserRef([], { content: 'x' }, NOW) === null);
  t.ok('① 非数组不出错', findDupUserRef(null, { content: 'x' }, NOW) === null);
}

/* ── ② 信箱取件时的防重 ───────────────────────────────────── */
if (typeof isSteerAlreadyLanded === 'function') {
  const U = (content, extra = {}) => ({ role: 'user', content, ...extra });
  const A = (toolCalls) => (toolCalls
    ? { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] }
    : { role: 'assistant', content: '她说的话' });

  t.ok('② 队尾有 _steer 同文 → 别再 push',
    isSteerAlreadyLanded([U('旧话'), A(false), U('插话正文', { _steer: true })], '插话正文') === true);
  t.ok('② 中间夹着工具过程也算已落',
    isSteerAlreadyLanded([U('插话正文', { _steer: true }), A(true), { role: 'tool', content: 'ok' }], '插话正文') === true);
  t.ok('② 中间她答过话 → 算新话，要 push',
    isSteerAlreadyLanded([U('插话正文', { _steer: true }), A(false)], '插话正文') === false);
  t.ok('② 普通 user 同文（不是插话）→ 不据此吞',
    isSteerAlreadyLanded([U('插话正文')], '插话正文') === false);
  t.ok('② 空文本 → false', isSteerAlreadyLanded([U('x', { _steer: true })], '  ') === false);
  t.ok('② 离队尾太远（第 5 条以外）→ 不算',
    isSteerAlreadyLanded([U('插话正文', { _steer: true }), U('a'), U('b'), U('c'), U('d')], '插话正文') === false);
  t.ok('② 空白差异也算同文',
    isSteerAlreadyLanded([U('插话 正文\n', { _steer: true })], '插话正文') === true);
  t.ok('② 非数组不出错', isSteerAlreadyLanded(null, 'x') === false);
}

t.done();
