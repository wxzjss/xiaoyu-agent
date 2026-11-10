/**
 * 【柜门「正在跑命令…」的事件链】
 *
 * 主人 2026-11-07 报：调用工具时，柜门本来会从「调了 N 次工具」变成「正在跑命令…」，
 * 现在不行了。根因：并行批交给调度器预跑后用了 emitEvents:false，
 * 而老窄补丁会在 Promise.all 之前先发一批 tool_start；换成调度器这段被删了，
 * 主循环命中 _poMap 又跳过补发 → 前端只收到 tool_end，建不出「运行中…」的卡，
 * hubRefreshTitle() 找不到带「运行」的状态，就一直显示统计数字。
 *
 * 这一格守的是「每个工具在开始跑之前，必须恰好收到一次 tool_start」。
 */
import { makeChecker, ensureLogStore } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';
import fs from 'node:fs';
import { executeBatch, clearIdempotency } from '../src/harness/scheduler.mjs';

const t = makeChecker('ui / 工具开始事件');
const C = (id, name) => ({ id, function: { name, arguments: '{}' } });

// ── 1. 并行批：每个调用开跑前都报一次 start ─────────────────────────
clearIdempotency('startpair');
const trace = [];
let tStart = 0;
await executeBatch([C('a', 'read_file'), C('b', 'list_dir'), C('c', 'search_files')], {
  emitEvents: false,
  onlyParallelLayers: true,
  sessionId: 'startpair',
  round: 1,
  onStart: (c) => { tStart = Date.now(); trace.push('start:' + c.id); },
  runTool: async () => { trace.push('run'); await new Promise((r) => setTimeout(r, 10)); return { ok: true, output: 'x' }; },
});
t.ok('3 个并行调用都报了 start', trace.filter((x) => x.startsWith('start:')).length === 3, JSON.stringify(trace));
t.ok('start 全部排在 run 之前（顺序对）',
  trace.indexOf('run') > 0 && trace.slice(0, 3).every((x) => x.startsWith('start:')), JSON.stringify(trace.slice(0, 5)));
t.ok('start 带的 id 是原始 id', trace.slice(0, 3).join(',') === 'start:a,start:b,start:c');
t.ok('开跑时间点被记到了', tStart > 0);

// ── 2. 单个 / 写操作不发 start（留给主循环自己发） ──────────────────
clearIdempotency('startpair');
const trace2 = [];
await executeBatch([C('w', 'write_file'), C('r', 'read_file')], {
  emitEvents: false,
  onlyParallelLayers: true,
  sessionId: 'startpair',
  round: 2,
  onStart: (c) => trace2.push('start:' + c.id),
  runTool: async () => ({ ok: true, output: 'x' }),
});
t.ok('单个层 / 写操作不由调度器发 start', trace2.length === 0, JSON.stringify(trace2));

// ── 3. 幂等命中不重复发 start ──────────────────────────────────────
clearIdempotency('startpair');
let nStart = 0;
const opts = {
  emitEvents: false, onlyParallelLayers: true, sessionId: 'startpair', round: 3,
  onStart: () => nStart++,
  runTool: async () => ({ ok: true, output: 'x' }),
};
const batch = [C('p', 'read_file'), C('q', 'list_dir')];
await executeBatch(batch, opts);
await executeBatch(batch, opts);
t.ok('同一批重发不重复报 start', nStart === 2, 'nStart=' + nStart);

// ── 4. 源码链路：后端有发、前端有收 ────────────────────────────────
const agent = fs.readFileSync('src/agent.mjs', 'utf8');
const ui = readUISource();
const sched = fs.readFileSync('src/harness/scheduler.mjs', 'utf8');
const server = fs.readFileSync('src/server.mjs', 'utf8');
t.ok('调度器在 runTool 之前调 onStart', /try \{ onStart\(c\); \} catch \{\}/.test(sched));
t.ok('agent 把 onStart 接成 tool_start', /onStart: \(c\) => onEvent\(\{[\s\S]*?type: 'tool_start'/.test(agent));
t.ok('主循环命中缓存时跳过重复 start', /if \(!_hit\) \{[\s\S]*?onEvent\(\{ type: 'tool_start'/.test(agent));
t.ok('服务端转发 tool_start', /if \(ev\.type === 'tool_start'\) send\(\{ type: 'tool_start'/.test(server));
/* 【2026-11-09 换框架】原来这三条断言的是手写 DOM 的实现细节
 * （`ev.type === 'tool_start'` 分支里写「运行中…」、`hubRefreshTitle()` 干什么）。
 * 那些函数已经删了 —— 现在「运行中 / 完成 / 柜门计数」全由 React 从**数据**算：
 *   · 单卡的三个字：ToolCard.jsx 的 statusText()
 *   · 柜门那行字：ToolGroup 里 running ? '正在…' : '调了 N 次工具'
 * 所以改成断言这三块**文案规则**还在（实现换掉也不影响这条检查的意义）。 */
const toolCard = fs.readFileSync('src-ui/ToolCard.jsx', 'utf8');
t.ok('前端：卡上有「运行中…」这个状态字',
  /return '运行中…'/.test(toolCard) && /s === 'ok'\) return '完成'/.test(toolCard), 'src-ui/ToolCard.jsx');
t.ok('前端：柜门跑着的时候写「正在…」',
  /正在' \+ \(niceTool\(running\.name, running\.args\) \|\| '干活'\) \+ '…'/.test(toolCard), 'src-ui/ToolCard.jsx');
t.ok('前端：柜门跑完退回「调了 N 次工具」',
  /'调了 ' \+ n \+ ' 次工具'/.test(toolCard), 'src-ui/ToolCard.jsx');

// ── 5. 真机格：喂数据 → 屏幕上那行字到底会不会变（连不上就跳，不算失败） ────
let cdp = null;
if (!process.env.XY_CDP_PORT) {
  console.log('  [skip] 没有 XY_CDP_PORT（不是隔离实例），真机那几格跳过');
} else {
  try { const m = await import('../_t_cdp.mjs'); cdp = await m.connect({ port: Number(process.env.XY_CDP_PORT) }); } catch { cdp = null; }
  if (!cdp) console.log('  [skip] 连不上隔离实例的调试端口，真机那几格跳过');
}
if (cdp) {
  if (!(await ensureLogStore(cdp))) console.log('  （页面 store 一直没就绪，真机格按空处理）');

  try {
    /* ① 两张都在跑 → 柜门「正在跑命令…」，卡上「运行中…」 */
    const run = await cdp.eval(`
      const sid = window.sessionId;
      try { window.__logStore.setHistory(sid, []); } catch (e) {}
      window.__logStore.setLive(sid, { running: true, startedAt: Date.now(), items: [
        { k: 'tool', id: 'a', name: 'run_command', args: '{}', status: 'run', output: '' },
        { k: 'tool', id: 'b', name: 'read_file', args: '{}', status: 'run', output: '' },
      ]});
      const lg = document.getElementById('log');
      let tries = 0;
      while (tries++ < 20 && !lg.querySelector('details.toolhub')) { await new Promise(function(r){ setTimeout(r, 150); }); }
      const out = {
        hub: String((lg.querySelector('.toolhub .hubname') || {}).textContent || ''),
        statuses: [].slice.call(lg.querySelectorAll('details.tool .status')).map(function(e){ return String(e.textContent||''); }),
      };
      /* ② 同一批跑完 → 柜门退回计数 */
      window.__logStore.setLive(sid, { running: true, startedAt: Date.now(), items: [
        { k: 'tool', id: 'a', name: 'run_command', args: '{}', status: 'ok', output: '' },
        { k: 'tool', id: 'b', name: 'read_file', args: '{}', status: 'ok', output: '' },
      ]});
      let t2 = 0;
      while (t2++ < 20 && !/调了/.test(String((lg.querySelector('.toolhub .hubname') || {}).textContent || ''))) { await new Promise(function(r){ setTimeout(r, 150); }); }
      out.after = String((lg.querySelector('.toolhub .hubname') || {}).textContent || '');
      out.statusesAfter = [].slice.call(lg.querySelectorAll('details.tool .status')).map(function(e){ return String(e.textContent||''); });
      try { window.__logStore.setLive(sid, null); } catch (e) {}
      return out;
    `);
    t.ok('真机：跑着的时候柜门写「正在跑命令…」（可带计数前缀）',
      /(调了 \d+ 次 · )?正在跑命令…$/.test(String(run.hub)), JSON.stringify(run.hub));
    t.ok('真机：跑着的时候卡上写「运行中…」',
      (run.statuses || []).filter((s) => /运行中/.test(s)).length === 2, JSON.stringify(run.statuses));
    t.ok('真机：跑完柜门退回「调了 2 次工具」', run.after === '调了 2 次工具', JSON.stringify(run.after));
    t.ok('真机：跑完卡上写「完成」',
      (run.statusesAfter || []).filter((s) => /完成/.test(s)).length === 2, JSON.stringify(run.statusesAfter));
  } catch (e) {
    t.ok('真机柜门探针能跑', false, String(e.message).slice(0, 100));
  } finally {
    try { cdp.close(); } catch {}
  }
}

t.done();
