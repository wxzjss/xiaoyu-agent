#!/usr/bin/env node
/**
 * 【真机】插话在**历史**里该排在哪 —— 主人 2026-11-11 报「一轮结束消息全堆在轮末」
 * 「插话后她已说出的回复也消失」。
 *
 * 盯的是 src-ui/items.js 的 buildMerged（React 那唯一一条「数据 → 屏幕条目」的路）：
 * 带 `steer` / `steerAt` 的 user turn，必须把她紧挨着的那段 assistant 正文
 * **在 steerAt 处劈开**，把插话嵌在中间。老 DOM 渲染器靠这两个字段劈气泡
 * （server.mjs:12633「前端重绘时按 _atChars 把我那段话劈成两半，把主人的话嵌在中间」），
 * React 重写后这条丢了 —— 于是历史里的插话只能按数组顺序排，看起来就是「堆到轮末」。
 *
 * 口径（跟服务端、老渲染器一致，别自己另立一套）：
 *   · steerAt 量的是**当前那一段**正文的字数，不是整轮累计（累计值会把插话
 *     插到很早之前那一段里，index.html:9949 记过这个坑）；
 *   · 超过段长 → 夹到段末（= 不劈，排在这段之后）；
 *   · 0 → 排在这段前面；
 *   · 多气泡（同一句话被工具劈开又合并回来的）只劈最后一个气泡，前面一个字不动。
 *
 * 用法：node scripts/check-steer-position.mjs
 */
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* items.js 只在函数体里读 window（store.js 的 logState / __logStore），
 * 给一个空 window 就能在 node 里直接跑 —— 不用起浏览器。 */
globalThis.window = globalThis.window || {};
const uiMod = await import('file:///' + path.join(ROOT, 'src-ui/items.js').replace(/\\/g, '/'));
const buildMerged = uiMod.buildMerged;

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '  ' + extra : '')); }
};

const A40 = 'A'.repeat(40);
const B60 = 'B'.repeat(60);
const LONG = A40 + B60;                 /* 100 字的一段正文 */

/** 跑一次 buildMerged，把「正文 / 插话」按屏幕顺序拍成一行，方便眼看 */
function screen(turns, live, pendingUser) {
  const snap = {
    sid: 'chk-steer',
    turns,
    live: live || null,
    pendingUser: pendingUser || [],
    notes: [],
  };
  const r = buildMerged(snap);
  const seq = (r.items || []).filter((x) => x && (x.kind === 'assistant' || x.kind === 'user'))
    .map((x) => (x.kind === 'assistant'
      ? 'A:' + (Array.isArray(x.bubbles) ? x.bubbles.join('|') : String(x.text || ''))
      : 'U:' + String(x.text || '')));
  return { res: r, items: r.items || [], seq };
}
const ass = (text, extra) => Object.assign({ role: 'assistant', text }, extra || {});
const usr = (text, extra) => Object.assign({ role: 'user', text }, extra || {});

console.log('场景 A：assistant(100 字) + user(steer, steerAt=40) → 前 40 字 / 插话 / 后 60 字');
{
  const s = screen([ass(LONG), usr('插一句', { steer: true, steerAt: 40 })]);
  ok(s.seq.length === 3, '三条：前半 / 插话 / 后半', JSON.stringify(s.seq.map((x) => x.slice(0, 12) + '…(' + (x.length - 2) + ')')));
  ok(s.seq[0] === 'A:' + A40, '前半 = 原正文前 40 字', '实际长度 ' + String(s.seq[0] || '').length);
  ok(s.seq[1] === 'U:插一句', '中间 = 主人那句插话', s.seq[1]);
  ok(s.seq[2] === 'A:' + B60, '后半 = 原正文后 60 字', '实际长度 ' + String(s.seq[2] || '').length);
  const u = s.items.find((x) => x.kind === 'user');
  ok(u && u.tag === '插话', '插话气泡带「插话」小标（轮末落盘换历史后不许丢）', u && u.tag);
  ok(u && u.steer === true, '插话条目保留 steer 记号');
  /* 一个字都不许丢 / 不许重复 */
  const asst = s.items.filter((x) => x.kind === 'assistant').map((x) => x.bubbles.join('')).join('');
  ok(asst === LONG, '前半 + 后半 == 原文（不丢字、不重复）', asst.length + ' 字');
  /* key 唯一：重复 key = React 会把两行当成同一行 */
  const keys = s.items.map((x) => x.key);
  ok(new Set(keys).size === keys.length, 'key 全不相同（后半是 t-<i>-sb）', JSON.stringify(keys));
}

console.log('\n场景 B：steerAt > 该段长度 → 夹到段末（排整段之后，不丢字不重复）');
{
  const s = screen([ass(LONG), usr('插一句', { steer: true, steerAt: 500 })]);
  ok(s.seq.length === 2, '两条：整段 / 插话（不劈）', JSON.stringify(s.seq.map((x) => x.slice(0, 10))));
  ok(s.seq[0] === 'A:' + LONG, '整段正文一个字没动', String(s.seq[0] || '').length + ' 字');
  ok(s.seq[1] === 'U:插一句', '插话排在整段之后', s.seq[1]);
  ok(s.items.filter((x) => x.kind === 'assistant').length === 1, '没有多出一个空气泡');
  ok(s.items.filter((x) => x.kind === 'user').length === 1, '插话恰好一颗（不双画）');
}

console.log('\n场景 C：steerAt=0 → 插话排在该段前面');
{
  const s = screen([ass(LONG), usr('插一句', { steer: true, steerAt: 0 })]);
  ok(s.seq.length === 2, '两条：插话 / 整段', JSON.stringify(s.seq.map((x) => x.slice(0, 10))));
  ok(s.seq[0] === 'U:插一句', '插话在最前', s.seq[0]);
  ok(s.seq[1] === 'A:' + LONG, '整段正文一个字没动', String(s.seq[1] || '').length + ' 字');
}

console.log('\n场景 D：一条 assistant 里多段正文（bubbles 合并）→ 只劈最后一段，不空气泡');
{
  /* 同一轮里被工具劈成两段 assistant turn，buildMerged 会把它们并回一个气泡组 */
  const s = screen([
    ass('AAAA'),
    ass('BBBB'),
    usr('插一句', { steer: true, steerAt: 2 }),
  ]);
  ok(s.seq.length === 3, '三条：前段(含更早那几段) / 插话 / 后半', JSON.stringify(s.seq));
  const asstItems = s.items.filter((x) => x.kind === 'assistant');
  ok(asstItems.length === 2 && asstItems[0].bubbles.join('|') === 'AAAA|BB',
    '更早那一段原样保留（不跨气泡累加去劈），只有最后一段末两个字符被切到后半',
    asstItems[0] && JSON.stringify(asstItems[0].bubbles));
  ok(s.seq[2] === 'A:BB', '只把**最后**那一段劈成「BB」+ 插话 +「BB」', s.seq[2]);
  ok(asstItems.every((x) => Array.isArray(x.bubbles) && x.bubbles.length > 0), '没有气泡被劈成空数组');
  ok(asstItems.every((x) => x.bubbles.every((b) => String(b).length > 0)), '没有空字符串气泡');
  ok(asstItems.map((x) => x.bubbles.join('')).join('') === 'AAAABBBB', '总正文守恒（AAAA + BBBB）',
    asstItems.map((x) => x.bubbles.join('')).join('') || '(空)');
  /* steerAt=6 超过最后一段（4 字）→ 夹到段末：按「最后一段」口径算，等于排在 BBBB 之后 */
  const s2 = screen([ass('AAAA'), ass('BBBB'), usr('插一句', { steer: true, steerAt: 6 })]);
  ok(s2.seq.join(' ≤ ') === 'A:AAAA|BBBB ≤ U:插一句',
    'steerAt 超过最后一段 → 夹到段末（不劈），插话排在整段之后',
    JSON.stringify(s2.seq));
}

console.log('\n场景 E：不带 steer 的普通 user 完全不受影响');
{
  const s = screen([
    ass('她说的第一段'),
    usr('我正常发的一句'),
    ass('她答的'),
    usr('我又一句', { steerAt: 3 }),      /* 有 steerAt 但没有 steer：不许劈 */
  ]);
  ok(s.seq.length === 4, '四条，顺序原样', JSON.stringify(s.seq));
  ok(s.seq[0] === 'A:她说的第一段' && s.seq[1] === 'U:我正常发的一句', '第一轮顺序不变');
  ok(s.seq[2] === 'A:她答的' && s.seq[3] === 'U:我又一句', '第二轮顺序不变（没有 steer 记号的 steerAt 不当数）');
  const u = s.items.filter((x) => x.kind === 'user');
  ok(u.every((x) => x.tag === ''), '普通 user 气泡不带「插话」小标', JSON.stringify(u.map((x) => x.tag)));
  ok(u.every((x) => !x.steer), '普通 user 条目没有 steer 记号');

  /* 带 steer 但**没有** steerAt（老会话 / DOM 兜底没算出来）→ 照老样子排末尾，不许猜 0 */
  for (const missing of [undefined, null]) {
    const sm = screen([ass('她说的'), usr('老插话', { steer: true, steerAt: missing })]);
    ok(sm.seq.join(' ≤ ') === 'A:她说的 ≤ U:老插话',
      '没有 steerAt（' + String(missing) + '）→ 不劈，排在这一段之后（Number(null)=0 的坑）',
      JSON.stringify(sm.seq));
  }
  /* 带 steer、steerAt 是 0 的老实话：0 是合法的「还没说」→ 排在前面 */
  const s0 = screen([ass('她说的'), usr('真 0', { steer: true, steerAt: 0 })]);
  ok(s0.seq.join(' ≤ ') === 'U:真 0 ≤ A:她说的', 'steerAt 真的是 0 → 排在这一段前面（跟 null 区分开）',
    JSON.stringify(s0.seq));
}

console.log('\n场景 F：跑着的时候（running=true，直播在画）历史这半边照样劈');
{
  const s = screen(
    [ass(LONG), usr('插一句', { steer: true, steerAt: 40 })],
    { running: true, items: [{ k: 'text', t: '接下来那段' }] },
  );
  const tail = s.seq.slice(-1)[0];
  ok(tail === 'A:接下来那段', '直播那段正文排在最后（历史 → 直播）', tail);
  ok(s.seq[0] === 'A:' + A40 && s.seq[1] === 'U:插一句' && s.seq[2] === 'A:' + B60,
    '历史里前半 / 插话 / 后半 的顺序不变', JSON.stringify(s.seq.slice(0, 3)));
}

console.log('\n场景 G：多轮叠加 —— 同一轮插两次话，各劈各的那一段');
{
  const s = screen([
    ass('X'.repeat(10)),
    usr('第一次插话', { steer: true, steerAt: 4 }),
    ass('Y'.repeat(10)),
    usr('第二次插话', { steer: true, steerAt: 2 }),
  ]);
  ok(s.seq.join(' ≤ ') === 'A:XXXX ≤ U:第一次插话 ≤ A:XXXXXX ≤ A:YY ≤ U:第二次插话 ≤ A:YYYYYYYY',
    '两次插话分别嵌在自己的位置（可叠加）', JSON.stringify(s.seq));
  ok(s.items.filter((x) => x.kind === 'user').length === 2, '两句话两颗气泡，不多不少');
}

console.log('\n' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
