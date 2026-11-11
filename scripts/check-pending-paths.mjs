#!/usr/bin/env node
/**
 * 【真机】「发消息 / 插话 / 收尾」三条路上的账 —— store.js + buildMerged 的横向体检。
 *
 * 主人 2026-11-11 / 11-12 反复报的还是同一类：「正常发消息，一轮结束消息全堆在轮末」
 * 「插话后新消息不上屏」。这类 bug 全都长在「乐观气泡什么时候收」「收尾那一拍
 * 怎么写 live」「窗口裁剪会不会把刚发的那句裁掉」这几个关口上，所以这里逐个钉住：
 *
 *   一、乐观气泡在**每一条落盘路径**上都会被收掉（收尾 / 打断 / 报错 / 切会话 / 刷新）
 *   二、乐观气泡按 sid 记账会不会串屏（含「sid 还没摆上来」的孤儿）
 *   三、setLive 的 250ms 收尾缓冲：不许出空帧，也不许永远落不了账
 *   四、buildMerged 的窗口（WINDOW=40 + getWindowStart）会不会裁掉/重复「刚发的那句」
 *
 * 用法：node scripts/check-pending-paths.mjs
 */
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STORE = 'file:///' + path.join(ROOT, 'src-ui/store.js').replace(/\\/g, '/');
const ITEMS = 'file:///' + path.join(ROOT, 'src-ui/items.js').replace(/\\/g, '/');

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '  ' + extra : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * store.js 的模块状态（pendingUser / histWin / 定时器）是模块级的，
 * 每换一个场景都得拿一份**全新的模块实例**（加个 ?v= 破缓存），
 * 否则上一个场景的账会漏到下一个场景里，红绿都不可信。
 */
let modSeq = 0;
async function freshStore(state, winExtra) {
  const w = Object.assign({ __logState: state }, winExtra || {});
  globalThis.window = w;
  const m = await import(STORE + '?v=' + (++modSeq));
  return { m, w, state };
}

/* items.js 自己 import 了 './store.js'（不带 query，只有一份），
 * 它只用到 getWindowStart —— 模块级的 histWin 用 sid 区分，场景之间不互相污染。 */
globalThis.window = globalThis.window || {};
const { buildMerged } = await import(ITEMS);

console.log('一、乐观气泡在每一条落盘路径上都会被收掉');
{
  /* ① 正常收尾：finishTurn 走 setHistory（历史里已经有这句） */
  const st1 = { sid: 'A', turns: [], live: null };
  const { m } = await freshStore(st1);
  m.pushPendingUser({ text: '帮我看一下那个报错' });
  ok(m.getSnapshot().pendingUser.length === 1, '① 发出去那一刻乐观气泡画出来了（不然「我的话不见了」）');
  m.setHistory('A', [{ role: 'user', text: '帮我看一下那个报错' }, { role: 'assistant', text: '好，我看' }]);
  ok(m.getSnapshot().pendingUser.length === 0, '① setHistory 之后收掉（不会和落盘那份双画）');

  /* ② 收尾那一拍走 setLive(null) 也要收 */
  const st2 = { sid: 'A', turns: [{ role: 'user', text: '再说一句' }], live: null };
  const { m: m2 } = await freshStore(st2);
  m2.pushPendingUser({ text: '再说一句' });
  m2.setLive('A', null);
  ok(m2.getSnapshot().pendingUser.length === 0, '② setLive(null) 也收（收尾的另一条调用顺序）');

  /* ③ 上游失败 / 报错：一条 assistant 都没有，setHistory 不会被调 → dropPendingForScreen */
  const st3 = { sid: 'A', turns: [], live: null };
  const { m: m3 } = await freshStore(st3);
  m3.pushPendingUser({ text: '这条会失败' });
  const dropped = m3.dropPendingForScreen();
  ok(dropped === 1 && m3.getSnapshot().pendingUser.length === 0,
    '③ 报错那条路 dropPendingForScreen 收干净（不然每失败一轮多一颗）', '收掉 ' + dropped + ' 颗');

  /* ④ 打断（/api/stop）之后走的是同一条 setLive(null) + setHistory，这里钉住两件事：
   *    主人那句「停之前插的话」在历史里 → 收账；不在历史里 → 留着（不能吞） */
  const st4 = { sid: 'A', turns: [], live: null };
  const { m: m4 } = await freshStore(st4);
  m4.pushPendingUser({ text: '停之前那句' });
  m4.setLive('A', null);
  ok(m4.getSnapshot().pendingUser.length === 1, '④ 打断：历史里还没有这句时**不许**收（吞了就没处找回）');
  m4.setHistory('A', [{ role: 'user', text: '停之前那句' }]);
  ok(m4.getSnapshot().pendingUser.length === 0, '④ 打断后历史补上这句 → 立刻收掉');

  /* ⑤ 刷新：pendingUser 只在内存里，新模块实例 = 刷新后的页面 */
  const st5 = { sid: 'A', turns: [{ role: 'user', text: '老话' }], live: null };
  const { m: m5 } = await freshStore(st5);
  ok(m5.getSnapshot().pendingUser.length === 0, '⑤ 刷新（新模块实例）后账本为空，不会把旧气泡画回来');
}

console.log('\n二、乐观气泡按 sid 记账：不串屏，也不留孤儿');
{
  /* ① 在 A 发的账，切到 B 不许画出来 */
  const st = { sid: 'A', turns: [], live: null };
  const { m } = await freshStore(st);
  m.pushPendingUser({ text: 'A 会话说的话' });
  m.setHistory('B', [{ role: 'user', text: 'B 里的老话' }]);
  ok(m.getSnapshot().pendingUser.length === 0, '① 切到 B 屏：A 那句话不画（串消息根治）');
  /* ② 但物理账本要留着 —— 切回 A 还得看见 */
  m.setHistory('A', []);
  ok(m.getSnapshot().pendingUser.length === 1, '② 切回 A：那句话还在（没被 setHistory(B) 顺手删掉）');

  /* ③ 【新修】sid 还没摆上来时发的话，不许变成「每屏都画」的孤儿 */
  const st2 = { sid: '', turns: [], live: null };
  const { m: m2 } = await freshStore(st2, { sessionId: 'A' });
  ok(m2.getSnapshot().pendingUser.length === 0, '③ LOG_STATE.sid 还是空的（还没 setHistory）');
  m2.pushPendingUser({ text: '首屏第一句' });
  ok(m2.getSnapshot().pendingUser.length === 1, '③ 空 sid 时发的话先挂在当前屏上（getSnapshot 的 !p.sid 放行）');
  /* 这句话到底记给了谁：切到 B 之后如果不画，说明兜底到了 window.sessionId='A' */
  m2.setHistory('B', [{ role: 'user', text: 'B 的话' }]);
  ok(m2.getSnapshot().pendingUser.length === 0,
    '③ 兜底记成了 window.sessionId 那一屏（原来是空 sid → 切到哪屏都画、还永远清不掉）');
  m2.setHistory('A', []);
  ok(m2.getSnapshot().pendingUser.length === 1, '③ 切回 A 还在（账没丢）');
}

console.log('\n三、setLive 的 250ms 收尾缓冲：不出空帧，也不许永远落不了账');
{
  const mkRunning = () => ({
    sid: 'A',
    turns: [{ role: 'user', text: '话' }],
    live: { running: true, items: [{ k: 'text', t: '她正在说' }] },
  });

  /* ① 落账前不许空帧：false 快照进来那一瞬间，屏上还是旧的 running:true */
  const st = mkRunning();
  const { m } = await freshStore(st);
  const before = m.getSnapshot();
  ok(before.live && before.live.running === true, '① 缓冲前：屏上是 running:true 的直播');
  m.setLive('A', { running: false, items: [{ k: 'text', t: '她正在说' }] });
  ok(m.getSnapshot().live && m.getSnapshot().live.running === true,
    '① false 快照进来那一拍：**先不落账**（finishTurn 的历史还在路上，落了就空帧）');
  await sleep(320);
  const after = m.getSnapshot();
  ok(after.live && after.live.running === false,
    '① 250ms 后落账 running:false（原来这里恒被「屏上还有 running 快照」挡住 → 永远落不了账）',
    after.live ? 'running=' + after.live.running : 'live=null');

  /* ② 缓冲期来了新一轮的 running:true → 旧的 false 一个字都不许盖上去 */
  const st2 = mkRunning();
  const { m: m2 } = await freshStore(st2);
  m2.setLive('A', { running: false, items: [{ k: 'text', t: '她正在说' }] });
  await sleep(80);
  m2.setLive('A', { running: true, items: [{ k: 'text', t: '新一轮第一段' }] });
  await sleep(320);
  const s2 = m2.getSnapshot();
  ok(s2.live && s2.live.running === true && s2.live.items[0].t === '新一轮第一段',
    '② 新一轮接上了：旧 false 没盖回来', s2.live ? JSON.stringify(s2.live.items) : 'live=null');

  /* ③ 缓冲期来了 setLive(null)（收尾正常路径）→ 立即收成 null，旧 false 不许复活 */
  const st3 = mkRunning();
  const { m: m3 } = await freshStore(st3);
  m3.setLive('A', { running: false, items: [{ k: 'text', t: '她正在说' }] });
  await sleep(80);
  m3.setLive('A', null);
  await sleep(320);
  ok(m3.getSnapshot().live === null, '③ setLive(null) 之后 320ms 仍是 null（缓冲被作废，不会「撤了又冒出来」）');

  /* ④ 缓冲期历史长过了（finishTurn 的 setHistory 先到）→ 交棒给历史，别留旧直播 */
  const st4 = mkRunning();
  const { m: m4 } = await freshStore(st4);
  m4.pushPendingUser({ text: '话' });
  m4.setLive('A', { running: false, items: [{ k: 'text', t: '她正在说' }] });
  m4.setHistory('A', [{ role: 'user', text: '话' }, { role: 'assistant', text: '她正在说' }]);
  ok(m4.getSnapshot().live && m4.getSnapshot().live.running === true,
    '④ 历史先到、缓冲还没到点：这一刻屏上仍是直播（不许空帧）');
  ok(m4.getSnapshot().pendingUser.length === 0, '④ 历史一到就把乐观气泡收掉（不等 250ms）');
  await sleep(320);
  ok(m4.getSnapshot().live === null,
    '④ 到点后直接把 live 收成 null（历史已经接管 → 既不重复也不空帧）',
    m4.getSnapshot().live ? 'running=' + m4.getSnapshot().live.running : 'live=null');

  /* ⑤ 缓冲期切走了 → 这份账作废，别写到别人的屏上 */
  const st5 = mkRunning();
  const { m: m5 } = await freshStore(st5);
  m5.setLive('A', { running: false, items: [{ k: 'text', t: '她正在说' }] });
  m5.setHistory('B', []);
  await sleep(320);
  const s5 = m5.getSnapshot();
  ok(s5.sid === 'B' && s5.live === null, '⑤ 切到 B 之后 320ms：B 的屏上没有被写上 A 的直播', 'sid=' + s5.sid + ' live=' + JSON.stringify(s5.live));
}

console.log('\n四、窗口裁剪（WINDOW=40 + getWindowStart）不许裁掉/重复「刚发的那句」');
{
  /* 30 轮（60 条 turn）的老会话 */
  const turns = [];
  for (let i = 0; i < 30; i++) {
    turns.push({ role: 'user', text: '第 ' + i + ' 问' });
    turns.push({ role: 'assistant', text: '第 ' + i + ' 答' });
  }
  const count = (arr, pred) => arr.filter(pred).length;
  const r1 = buildMerged({ sid: 'W', turns: turns.slice(), live: null, pendingUser: [], notes: [] });
  ok(r1.start === 20, '① 默认只画最近 40 轮（start=60-40=20）', 'start=' + r1.start);
  ok(r1.items.some((x) => x.kind === 'user' && x.text === '第 29 问'), '① 最后一句提问在窗口里');
  ok(count(r1.items, (x) => x.kind === 'user' && x.text === '第 29 问') === 1, '① 最后一句只画一次');

  /* 刚发出新的一句（还没落盘）：历史（还是老的）+ 乐观气泡 + 直播 */
  const r2 = buildMerged({
    sid: 'W',
    turns: turns.slice(),
    live: { running: true, items: [] },
    pendingUser: [{ id: 'p1', text: '刚发的新一句', atts: [], who: '', tag: '', rewindId: null, ts: 1 }],
    notes: [],
  });
  ok(count(r2.items, (x) => x.kind === 'user' && x.text === '刚发的新一句') === 1,
    '② 刚发的那句恰好一颗（这时它还没进历史，只有乐观那一份）',
    '实际 ' + count(r2.items, (x) => x.kind === 'user' && x.text === '刚发的新一句') + ' 颗');
  ok(r2.items.slice(-1)[0].text === '刚发的新一句', '② 刚发的那句在清单里（没被窗口裁掉），就在最新位置');
  ok(r2.items.some((x) => x.kind === 'assistant' && (x.bubbles || []).join('').indexOf('第 29 答') >= 0),
    '② 上一轮的回复也还在（发消息那一瞬间不许「折叠」掉）');

  /* 落盘之后：历史里有这句了，但乐观气泡还没被收 —— 那是 store 的活（一·① 已钉），
   * buildMerged 只忠实画出来。这里钉住「最多两份、不会变成三份/四份」这个上限。 */
  const r2b = buildMerged({
    sid: 'W',
    turns: turns.concat([{ role: 'user', text: '刚发的新一句' }]),
    live: { running: true, items: [] },
    pendingUser: [{ id: 'p1', text: '刚发的新一句', atts: [], who: '', tag: '', rewindId: null, ts: 1 }],
    notes: [],
  });
  ok(count(r2b.items, (x) => x.kind === 'user' && x.text === '刚发的新一句') <= 2,
    '② 历史 + 乐观同时存在时最多两份（收账交给 store，不在渲染层偷偷去重）',
    '实际 ' + count(r2b.items, (x) => x.kind === 'user' && x.text === '刚发的新一句') + ' 份');

  /* 没落盘的正常情形：历史里没有它，只有乐观气泡 → 也恰好一颗 */
  const r3 = buildMerged({
    sid: 'W',
    turns: turns.slice(),
    live: { running: true, items: [] },
    pendingUser: [{ id: 'p2', text: '还没落盘的一句', atts: [], who: '', tag: '', rewindId: null, ts: 1 }],
    notes: [],
  });
  ok(count(r3.items, (x) => String(x.text || '') === '还没落盘的一句') === 1, '③ 只有乐观气泡时恰好一颗');
  ok(r3.items.slice(-1)[0].text === '还没落盘的一句', '③ 乐观气泡在清单末尾（但它就是最新那句，位置对）');

  /* 手动往前翻过（windowStart>0）：窗口起点听主人的，但**不能**把末尾截掉。
   * 注意：窗口起点必须记在 items.js 自己 import 的那一份 store 上，
   * 所以这里用不带 ?v= 的实例（跟 items.js 同一个模块）。 */
  globalThis.window = { __logState: { sid: 'W', turns: [], live: null } };
  const storeOfItems = await import(STORE);
  storeOfItems.setWindowStart('W', 5);
  const r4 = buildMerged({
    sid: 'W',
    turns: turns.concat([{ role: 'user', text: '翻到上面时发的' }]),
    live: { running: true, items: [] },
    pendingUser: [],
    notes: [],
  });
  ok(r4.start === 5, '④ 翻过历史就尊重窗口起点（start=5）', 'start=' + r4.start);
  ok(count(r4.items, (x) => x.kind === 'user' && x.text === '翻到上面时发的') === 1,
    '④ 窗口起点在前面时，刚发的那句照样画（start 只是下界，不是上界）');
  ok(r4.items.slice(-1)[0].text === '翻到上面时发的', '④ 最后一条就是刚发的那句（顺序没被窗口搅乱）');
}

console.log('\n' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
