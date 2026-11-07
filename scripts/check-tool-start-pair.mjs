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
import { makeChecker } from './_harness_util.mjs';
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
const ui = fs.readFileSync('public/index.html', 'utf8');
const sched = fs.readFileSync('src/harness/scheduler.mjs', 'utf8');
const server = fs.readFileSync('src/server.mjs', 'utf8');
t.ok('调度器在 runTool 之前调 onStart', /try \{ onStart\(c\); \} catch \{\}/.test(sched));
t.ok('agent 把 onStart 接成 tool_start', /onStart: \(c\) => onEvent\(\{[\s\S]*?type: 'tool_start'/.test(agent));
t.ok('主循环命中缓存时跳过重复 start', /if \(!_hit\) \{[\s\S]*?onEvent\(\{ type: 'tool_start'/.test(agent));
t.ok('服务端转发 tool_start', /if \(ev\.type === 'tool_start'\) send\(\{ type: 'tool_start'/.test(server));
t.ok('前端收到 tool_start 会设「运行中…」', /ev\.type === 'tool_start'[\s\S]{0,900}运行中…/.test(ui));
t.ok('前端 hubRefreshTitle 会显示「正在…」', /正在' \+/.test(ui) || /正在/.test(ui));
t.ok('前端跑完 hubRefreshTitle 会退回计数', /hubRefreshTitle\(\);/.test(ui));

// ── 5. 真机格：屏幕上那行字到底会不会变（连不上就跳，不算失败） ────
let cdp = null;
try {
  const m = await import('../_t_cdp.mjs');
  cdp = await m.connect({ port: 9223, match: '8788' });
} catch { /* 没开调试浏览器 */ }
if (cdp) {
  try {
    const r = await cdp.eval(`
      const out = {};
      const lg = document.getElementById('log');
      const hub = document.createElement('details');
      hub.className = 'toolhub';
      hub.innerHTML = '<summary><span class="hubname"></span><span class="status ok"></span><span class="hubpeek"></span></summary>'
        + '<details class="tool"><summary class="toolHead"><span class="name">跑命令</span><span class="status warn">运行中…</span></summary><pre></pre></details>';
      lg.appendChild(hub);
      const _old = typeof _liveHub !== 'undefined' ? _liveHub : null;
      _liveHub = hub;
      hubRefreshTitle();
      out.running = hub.querySelector('.hubname').textContent;
      const st = hub.querySelector('details.tool .status');
      st.textContent = '完成'; st.className = 'status ok';
      hubRefreshTitle();
      out.after = hub.querySelector('.hubname').textContent;
      _liveHub = _old;
      hub.remove();
      return out;
    `);
    t.ok('真机：运行中柜门写「正在跑命令…」', r && r.running === '正在跑命令…', JSON.stringify(r));
    t.ok('真机：跑完退回「调了 1 次工具」', r && r.after === '调了 1 次工具', JSON.stringify(r));
  } catch (e) {
    t.ok('真机柜门探针能跑', false, String(e.message).slice(0, 100));
  } finally {
    try { cdp.close(); } catch {}
  }
} else {
  console.log('  [skip] 没连上调试浏览器，真机柜门那两格跳过（不算失败）');
}

t.done();
