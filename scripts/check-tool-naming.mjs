/**
 * 【工具卡 / 柜门 该叫什么名字】—— 2026-11-09 换框架后重写
 *
 * 主人要求：工具名说人话（跑命令 / 读文件，而不是 run_command），柜门写「调了 N 次工具」，
 * 跑着的时候写「正在跑命令…」。
 *
 * ══ 改了什么 ══
 * 旧版这一段的真机格去摸 `details.toolhub .sum` —— 那是**手写 DOM 时代**的结构。
 * 换 React 之后工具卡由 `src-ui/ToolCard.jsx` 画（单张 `<details class="tool">`，
 * 连着几张套一个 `<details class="toolhub">`），`.sum` 这个类已经不存在了，
 * 于是报 `Cannot read properties of null (reading 'sum')` —— 检查红、产品是好的。
 *
 * 现在按**行为**验：喂数据（store）→ 看屏幕上写的是不是人话。
 * 不管它是 React 画的还是手写的，只要名字对、柜门文案对就行。
 */
import fs from 'node:fs';
import { makeChecker, ensureLogStore } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';

const t = makeChecker('ui / 工具命名');
const ui = readUISource();
/* 【换框架】柜门文案搬进了 React 组件；断言要跟着去**源码**里找，而不是只扫 index.html */
const toolCard = fs.readFileSync('src-ui/ToolCard.jsx', 'utf8');

/* ── 源码：名字表还在、并且确实是「说人话」 ───────────────────── */
const NAMES = {
  run_command: '跑命令',
  read_file: '读文件',
  write_file: '写文件',
  compress: '压缩中',
};
for (const [k, v] of Object.entries(NAMES)) {
  t.ok('名字表里 ' + k + ' → ' + v, new RegExp(k + ":\\s*'" + v + "'").test(ui), k);
}
t.ok('柜门写「调了 N 次工具」',
  /调了 ' \+ n \+ ' 次工具/.test(toolCard) || /调了 \$\{n\} 次工具/.test(toolCard),
  '（在 src-ui/ToolCard.jsx 里找）');
t.ok('跑着的时候柜门写「正在…」', /正在/.test(toolCard) && /'正在' \+/.test(toolCard));

/* ── 真机：喂数据 → 看屏幕上的字 ─────────────────────────────── */
let cdp = null;
if (!process.env.XY_CDP_PORT) {
  console.log('\n真机格：SKIP（没有 XY_CDP_PORT，不是隔离实例；源码断言已过）');
} else {
  try { const { connect } = await import('../_t_cdp.mjs'); cdp = await connect({ port: Number(process.env.XY_CDP_PORT) }); } catch (e) { cdp = null; }
  if (!cdp) console.log('\n真机格：SKIP（连不上隔离实例的调试端口）');
}

if (cdp) {
  /* 【等「store 就绪」，不是等 sessionId】
   * 踩过的坑：只要 sessionId 一有值就往里喂数据，可这时 chat.js 的 logSetHistory 可能
   * 还没跑完（LOG_STATE.sid 还是空），setLive 被 sid 挡掉 → 屏幕一片空白 → 一堆假红。
   * 就绪判据：__logStore 在 && __logState.sid 非空。 */
  if (!(await ensureLogStore(cdp))) console.log('  （页面 store 一直没就绪，真机格按空处理）');
  const r = await cdp.eval(`
    const out = { tries: 0 };
    const lg = document.getElementById('log');
    const sid = window.sessionId;
    /* 先把这一屏「认下」（boot 里 logSetHistory 可能还没跑完），否则 setLive 会被 sid 挡掉 */
    try { window.__logStore.setHistory(sid, []); } catch (e) {}
    out.okSet = window.__logStore.setLive(sid, { running: true, startedAt: Date.now(), items: [
      { k: 'tool', id: 'a', name: 'run_command', args: '{}', status: 'ok', output: 'ok' },
      { k: 'tool', id: 'b', name: 'read_file', args: '{"path":"x"}', status: 'ok', output: 'ok' },
      { k: 'tool', id: 'c', name: 'weird_tool_name', args: '{}', status: 'run', output: '' },
    ]});
    /* 等它真的画出来（页面刚起时 React 可能还没订阅完），最多 3 秒 */
    while (out.tries++ < 20) {
      if (String(lg.textContent || '').trim().length) break;
      await new Promise(function(r){ setTimeout(r, 150); });
    }
    out.text = String(lg.textContent || '');
    out.hubTitle = [].slice.call(lg.querySelectorAll('.toolhub .hubname')).map(function(e){ return String(e.textContent||''); });
    out.cardNames = [].slice.call(lg.querySelectorAll('details.tool .name')).map(function(e){ return String(e.textContent||''); });
    out.statuses = [].slice.call(lg.querySelectorAll('details.tool .status')).map(function(e){ return String(e.textContent||''); });
    try { window.__logStore.setLive(window.sessionId, null); } catch (e) {}
    return out;
  `);
  /* 注意：run_command 带 cmd 时会被换成更贴切的叫法（如 ls → 看文件），
   * 所以这里用「没有参数」的那张卡验兜底名「跑命令」。 */
  t.ok('真机：run_command 显示成「跑命令」', /跑命令/.test(r.text), String(r.text).slice(0, 80));
  t.ok('真机：read_file 显示成「读文件」', /读文件/.test(r.text), String(r.text).slice(0, 80));
  /* 不认识的工具名：niceTool 会把下划线变空格（weird_tool_name → weird tool name），
   * 只要它还在屏幕上、没变成 undefined / 空白就算对。 */
  t.ok('真机：不认识的名字仍然显示出来（不吞、不变空）',
    /weird[ _]?tool[ _]?name/i.test(r.text) && !/undefined/.test(r.text), String(r.text).slice(0, 80));
  t.ok('真机：柜门写「调了 N 次工具」或「正在…」',
    r.hubTitle.some((s) => /调了 \d+ 次工具/.test(s) || /正在/.test(s)), JSON.stringify(r.hubTitle));
  t.ok('真机：跑着的那张卡写「运行中…」', r.statuses.some((s) => /运行中/.test(s)), JSON.stringify(r.statuses));
  t.ok('真机：跑完的那张卡写「完成」', r.statuses.some((s) => /完成/.test(s)), JSON.stringify(r.statuses));
  cdp.close();
}

t.done();
