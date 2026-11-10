/**
 * 【工具卡会不会跑到柜子外面】—— 2026-11-09 换框架后重写
 *
 * 主人 2026-11-01：「不要一出工具就套柜子」；后来又报过「展开柜子一堆散卡漏在外面」。
 * 旧实现为此装了一个 MutationObserver 自愈守卫（`installToolLeakGuard`），
 * 专门把「漏在 #log 外面的散卡」搬回柜子里 —— 因为手写 DOM 会漏。
 *
 * ══ 换 React 之后这条为什么还留着、但换个验法 ══
 * 柜子不再「搬节点」，而是**从数据折出来**：`LogView.jsx` 的 `toRows()` 把
 * 连续的 tool item 收成一个 `{type:'tools'}` 行，再交给 `ToolGroup` 画。
 * 也就是说「散卡漏在外面」「柜套柜」在结构上不可能发生 —— 这是要验的**行为**，
 * 而不是「守卫函数还在不在」（守卫已经不需要了）。
 *
 * 所以现在验：
 *   ① 源码：只有一个「折行」的地方（toRows），柜子由它产生；
 *   ② 真机：连续 N 张工具 → 恰好 1 个柜子、柜外 0 张散卡、无柜套柜、无空柜；
 *           单张 → 1 张卡 0 个柜子；中间隔一段话 → 分开成两组。
 */
import fs from 'node:fs';
import { makeChecker, ensureLogStore } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';

const t = makeChecker('ui / 工具卡不漏在外面');
const ui = readUISource();
const logView = fs.readFileSync('src-ui/LogView.jsx', 'utf8');
const toolCard = fs.readFileSync('src-ui/ToolCard.jsx', 'utf8');

/* ── 源码：柜子只由「折行」产生 ─────────────────────────────────── */
t.ok('LogView 里有唯一的分组逻辑 toRows', /function toRows\(items\)/.test(logView));
t.ok('toRows 把连续的 tool 收成一组', /if \(it\.kind === 'tool'\)[\s\S]{0,200}run\.items\.push\(it\)/.test(logView));
t.ok('柜子组件 ToolGroup 在（≥2 张才成柜）', /list\.length === 1\) return <ToolCard it=\{list\[0\]\} \/>/.test(toolCard) && /className="toolhub"/.test(toolCard));
/* 【别死抠「函数还在不在」】那台「搬节点自愈守卫」还留着定义（死代码，无害），
 * 但**没有任何调用点** —— 也就是它根本没装。断言「没装」而不是「不存在」，
 * 这样将来谁把死代码删干净了也不会误报。 */
{
  const calls = (ui.match(/installToolLeakGuard\s*\(\)/g) || []).length;
  const defs = (ui.match(/function\s+installToolLeakGuard\s*\(/g) || []).length;
  t.ok('旧的「搬节点自愈守卫」没有装（React 下不需要）', calls === 0 || calls === defs,
    '定义 ' + defs + ' 处 / 调用 ' + calls + ' 处');
}

/* ── 真机 ───────────────────────────────────────────────────────── */
let cdp = null;
if (!process.env.XY_CDP_PORT) {
  console.log('\n真机格：SKIP（没有 XY_CDP_PORT，不是隔离实例；源码断言已过）');
} else {
  try { const { connect } = await import('../_t_cdp.mjs'); cdp = await connect({ port: Number(process.env.XY_CDP_PORT) }); } catch (e) { cdp = null; }
  if (!cdp) console.log('\n真机格：SKIP（连不上隔离实例的调试端口）');
}

if (cdp) {
  if (!(await ensureLogStore(cdp))) console.log('  （页面 store 一直没就绪，真机格按空处理）');

  /* ① 连续 3 张工具 → 1 个柜子，柜外 0 张散卡 */
  const r1 = await cdp.eval(`
    const sid = window.sessionId;
    try { window.__logStore.setHistory(sid, []); } catch (e) {}
    window.__logStore.setLive(sid, { running: true, startedAt: Date.now(), items: [
      { k: 'tool', id: 'a', name: 'run_command', args: '{}', status: 'ok', output: '' },
      { k: 'tool', id: 'b', name: 'read_file', args: '{}', status: 'ok', output: '' },
      { k: 'tool', id: 'c', name: 'list_dir', args: '{}', status: 'ok', output: '' },
    ]});
    const lg = document.getElementById('log');
    let tries = 0;
    while (tries++ < 20 && !lg.querySelector('details.toolhub')) { await new Promise(function(r){ setTimeout(r, 150); }); }
    const out = {
      hubs: lg.querySelectorAll('details.toolhub').length,
      looseTool: lg.querySelectorAll(':scope > details.tool').length,
      nestedHub: lg.querySelectorAll('details.toolhub details.toolhub').length,
      emptyHubs: [].slice.call(lg.querySelectorAll('details.toolhub')).filter(function(h){ return !h.querySelector('details.tool'); }).length,
      cardsInside: [].slice.call(lg.querySelectorAll('details.toolhub')).map(function(h){ return h.querySelectorAll('details.tool').length; }),
    };
    try { window.__logStore.setLive(sid, null); } catch (e) {}
    return out;
  `);
  t.ok('真机：连续 3 张 → 恰好 1 个柜子', r1 && r1.hubs === 1, JSON.stringify(r1));
  t.ok('真机：柜外一张散卡都没有', r1 && r1.looseTool === 0, JSON.stringify(r1));
  t.ok('真机：柜子里有 3 张卡', r1 && r1.cardsInside[0] === 3, JSON.stringify(r1));
  t.ok('真机：没有柜套柜', r1 && r1.nestedHub === 0, JSON.stringify(r1));
  t.ok('真机：没有空柜子', r1 && r1.emptyHubs === 0, JSON.stringify(r1));

  /* ② 单张 → 1 张卡、0 个柜子（不套柜） */
  const r2 = await cdp.eval(`
    const sid = window.sessionId;
    window.__logStore.setLive(sid, { running: true, startedAt: Date.now(), items: [
      { k: 'tool', id: 'z', name: 'run_command', args: '{}', status: 'ok', output: '' },
    ]});
    const lg = document.getElementById('log');
    let tries = 0;
    while (tries++ < 20 && !lg.querySelector('details.tool')) { await new Promise(function(r){ setTimeout(r, 150); }); }
    const out = { tools: lg.querySelectorAll('details.tool').length, hubs: lg.querySelectorAll('details.toolhub').length };
    try { window.__logStore.setLive(sid, null); } catch (e) {}
    return out;
  `);
  t.ok('真机：单张工具不套柜子（1 张卡 0 个柜）', r2 && r2.tools === 1 && r2.hubs === 0, JSON.stringify(r2));

  /* ③ 中间隔一段话 → 分成两组，各 1 张 */
  const r3 = await cdp.eval(`
    const sid = window.sessionId;
    window.__logStore.setLive(sid, { running: true, startedAt: Date.now(), items: [
      { k: 'tool', id: 'p', name: 'run_command', args: '{}', status: 'ok', output: '' },
      { k: 'text', t: '中间说一句' },
      { k: 'tool', id: 'q', name: 'read_file', args: '{}', status: 'ok', output: '' },
    ]});
    const lg = document.getElementById('log');
    let tries = 0;
    while (tries++ < 20 && lg.querySelectorAll('details.tool').length < 2) { await new Promise(function(r){ setTimeout(r, 150); }); }
    const out = {
      tools: lg.querySelectorAll('details.tool').length,
      hubs: lg.querySelectorAll('details.toolhub').length,
      order: [].slice.call(lg.children).map(function(el){ return el.className || el.tagName; }).join('|'),
    };
    try { window.__logStore.setLive(sid, null); } catch (e) {}
    return out;
  `);
  t.ok('真机：隔一句话就是两组（2 张卡 / 0 个柜）', r3 && r3.tools === 2 && r3.hubs === 0, JSON.stringify(r3));
  t.ok('真机：顺序是「卡 → 话 → 卡」（没被搬乱）', r3 && /details|tool/.test(r3.order) && r3.order.indexOf('assistant') > -1, r3 && r3.order);

  cdp.close();
}

t.done();
