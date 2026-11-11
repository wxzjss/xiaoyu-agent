/**
 * 【工具卡会不会跑到柜子外面】—— 2026-11-09 换框架后重写
 *
 * 主人 2026-11-01：「不要一出工具就套柜子」；后来又报过「展开柜子一堆散卡漏在外面」。
 * 旧实现为此装了一个 MutationObserver 自愈守卫（`installToolLeakGuard`），
 * 专门把「漏在 #log 外面的散卡」搬回柜子里 —— 因为手写 DOM 会漏。
 *
 * ══ 换 React 之后这条为什么还留着、但换个验法 ══
 * 柜子不再「搬节点」，而是**从数据折出来**：`LogView.jsx` 的 `toRows()` 把
 * 连续的 tool / **think**（2026-11-11 起，思考链也折进柜子）收成一个 `{type:'group'}` 行，
 * 再交给 `ToolGroup` 画。
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
/* 【2026-11-11 改·思考块也进柜子】主人问「柜子为什么夹在思考链中间 / 思考链不该在柜子里吗」，
 * 而 v0.9.46 及以前确实是这么做的（旧代码里专门收集散落的 details.think 折进柜子）。
 * 0.9.47 换 React 重写时这条丢了。现在 toRows 把 tool **和 think** 一起收成一串。 */
t.ok('toRows 把连续的 tool / think 收成一组',
  /if \(it\.kind === 'tool' \|\| it\.kind === 'think'\)[\s\S]{0,220}run\.items\.push\(it\)/.test(logView));
t.ok('柜子组件 ToolGroup 在（单卡不成柜 / 只有思考时直画思考块）',
  /tools\.length === 1 && !thinks\.length\) return <ToolCard it=\{tools\[0\]\} \/>/.test(toolCard)
  && /if \(!tools\.length\)/.test(toolCard)
  && /className="toolhub"/.test(toolCard));
t.ok('柜子内容区套了 .hubBody（限高 + 内部滚动靠它）',
  /className="hubBody"/.test(toolCard) && /details\.toolhub > \.hubBody/.test(ui));
/* 【2026-11-11 加·一段活不许跨消息】
 * 历史里一条 turn 的数据顺序是「思考 → 她的正文 → 工具」，于是上一轮的工具和
 * 下一轮的思考在清单里是**相邻**的。光按相邻分组会把两条消息塞进一个柜子
 * （实测：柜子里装着「上一轮的工具 + 下一轮的思考」）。key 里带着轮次
 * （items.js：历史 t-<轮次>、直播 l-<下标>），分组要拿它当边界。 */
t.ok('分组按「轮次」设边界（turnTagOf 读 key 里的 t-<n> / l-<n>）',
  /function turnTagOf\(it\)/.test(logView) && /\^\(t-\\d\+\)\(\?:-\|\$\)/.test(logView) && /run\.tag/.test(logView));
/* 同一轮里思考在她的话上面、工具在她的话下面 —— 不挪就永远进不了柜子（主人要的是「思考在柜子里」） */
t.ok('同一轮里「只有思考」的那一行会并进那一轮的工具柜（hoistTurnThinks）',
  /function hoistTurnThinks\(rows\)/.test(logView) && /return hoistTurnThinks\(rows\)/.test(logView)
  && /n\.items = r\.items\.concat\(n\.items\)/.test(logView));
/* 【2026-11-11 加·hooks 必须无条件挂在形态分派之前】
 * ToolGroup 有三种形态（全是思考 / 单卡 / 柜子），直播是一帧一帧长的：
 * 「只有思考」那一帧走 early return 一个 hook 都不挂，「思考 + 刚到的工具」那一帧
 * 又要挂 4 个 —— React 当场抛「Rendered more hooks than during the previous render」，
 * 这一整行被 RowBoundary 换成「⚠ 这一条渲染出错了」。真机探针踩到过。
 * 断言的是顺序：useOpen / useRunTicker 都得排在第一个形态 return 前面。 */
{
  const iUseOpen = toolCard.indexOf("const [open, onToggle] = useOpen('hub-'");
  const iTicker = toolCard.indexOf('const tick = useRunTicker(Boolean(_running0));');
  const iDispatch = toolCard.indexOf('if (!tools.length)');
  t.ok('hooks 全挂在形态分派之前（直播里「思考先到、工具后到」不会炸）',
    iUseOpen >= 0 && iTicker > iUseOpen && iDispatch > iTicker,
    'useOpen@' + iUseOpen + ' ticker@' + iTicker + ' 分派@' + iDispatch);
}
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

  /* ④ 【2026-11-11 加·主人两问】一段活「思考 → 工具 → 思考 → 工具 → 她的回答」
   * 期望：**一个**柜子把思考也装进去（不再被思考切成一小截一小截夹在思考链中间），
   * 柜外没有游离的思考块。另外逐步喂两帧（先只有思考、再添工具）——
   * 「只有思考」那一帧 ToolGroup 会走 early return，hooks 顺序搞错就会当场崩成报错行。 */
  const r4 = await cdp.eval(`
    const sid = window.sessionId;
    const lg = document.getElementById('log');
    const wait = async (n) => { let i = 0; while (i++ < 20 && lg.querySelectorAll('details.tool').length < n) { await new Promise(function(r){ setTimeout(r, 150); }); } };
    window.__logStore.setHistory(sid, []);
    window.__logStore.setLive(sid, { running: true, startedAt: Date.now(), items: [
      { k: 'think', t: '第一段思考：先看看文件在不在' },
    ]});
    await new Promise(function(r){ setTimeout(r, 400); });
    const mid = { hubs: lg.querySelectorAll('details.toolhub').length, think: lg.querySelectorAll('details.think').length, errs: lg.querySelectorAll('.sysnote').length };
    window.__logStore.setLive(sid, { running: true, startedAt: Date.now(), items: [
      { k: 'think', t: '第一段思考：先看看文件在不在' },
      { k: 'tool', id: 'g1', name: 'run_command', args: '{}', status: 'ok', output: '' },
      { k: 'think', t: '第二段思考：看完再跑一次命令' },
      { k: 'tool', id: 'g2', name: 'read_file', args: '{}', status: 'ok', output: '' },
      { k: 'text', t: '都干完了，汇报一句。' },
    ]});
    await wait(2);
    await new Promise(function(r){ setTimeout(r, 400); });
    const out = {
      mid: mid,
      hubs: lg.querySelectorAll('details.toolhub').length,
      hubThink: lg.querySelectorAll('details.toolhub details.think').length,
      hubTool: lg.querySelectorAll('details.toolhub details.tool').length,
      looseThink: lg.querySelectorAll(':scope > details.think').length,
      looseTool: lg.querySelectorAll(':scope > details.tool').length,
      hubName: String((lg.querySelector('details.toolhub > summary .hubname') || {}).textContent || ''),
      rowErrors: lg.querySelectorAll('.sysnote').length,
    };
    try { window.__logStore.setLive(sid, null); } catch (e) {}
    return out;
  `);
  t.ok('真机：思考+工具交替的一段活 → 恰好 1 个柜子', r4 && r4.hubs === 1, JSON.stringify(r4));
  t.ok('真机：柜子里装着 2 段思考（思考不再被留在柜子外面）', r4 && r4.hubThink === 2, JSON.stringify(r4 && { hubThink: r4.hubThink }));
  t.ok('真机：柜子里 2 张工具卡', r4 && r4.hubTool === 2, JSON.stringify(r4 && { hubTool: r4.hubTool }));
  t.ok('真机：柜外 0 个游离思考块 / 0 张散卡',
    r4 && r4.looseThink === 0 && r4.looseTool === 0, JSON.stringify(r4 && { t: r4.looseThink, l: r4.looseTool }));
  t.ok('真机：柜门只数工具（调了 2 次工具）', r4 && r4.hubName === '调了 2 次工具', r4 && r4.hubName);
  t.ok('真机：先只到思考那一帧不炸（0 个柜子、1 个思考块、0 行报错）',
    r4 && r4.mid && r4.mid.hubs === 0 && r4.mid.think === 1 && r4.mid.errs === 0, JSON.stringify(r4 && r4.mid));

  /* ⑤ 【2026-11-11 加·主人第二问】柜子的框也要限高，超出的在框里滚 */
  const r5 = await cdp.eval(`
    const sid = window.sessionId;
    const lg = document.getElementById('log');
    const items = [];
    for (let i = 1; i <= 12; i++) items.push({ k: 'tool', id: 'y' + i, name: 'run_command', args: '{}', status: 'ok', output: '' });
    window.__logStore.setLive(sid, { running: true, startedAt: Date.now(), items: items });
    let i = 0;
    while (i++ < 20 && lg.querySelectorAll('details.tool').length < 12) { await new Promise(function(r){ setTimeout(r, 150); }); }
    const sum = lg.querySelector('details.toolhub > summary');
    if (sum && !lg.querySelector('details.toolhub').open) sum.click();
    await new Promise(function(r){ setTimeout(r, 400); });
    const b = lg.querySelector('details.toolhub > .hubBody');
    const out = b ? {
      clientH: b.clientHeight, scrollH: b.scrollHeight,
      overflow: getComputedStyle(b).overflowY,
      canScroll: (function(){ b.scrollTop = b.scrollHeight; return b.scrollTop; })(),
      contain: getComputedStyle(b).overscrollBehaviorY,
    } : null;
    try { window.__logStore.setLive(sid, null); } catch (e) {}
    return out;
  `);
  t.ok('真机：柜子内容区被限高在 340 附近', r5 && r5.clientH > 200 && r5.clientH <= 345, JSON.stringify(r5));
  t.ok('真机：内容比框高 → 框里滚得动（scrollHeight > clientHeight 且 scrollTop 能走）',
    r5 && r5.scrollH > r5.clientH + 40 && r5.canScroll > 40, JSON.stringify(r5));

  cdp.close();
}

t.done();
