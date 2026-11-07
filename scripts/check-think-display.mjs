/**
 * 【思考内容显示 + 柜门「正在思考中…」】
 *
 * 主人 2026-11-07 两条要求：
 *   ① 思考内容显示太短 → 能多长就显示多长（原来标题硬截 38 字、悬停截 400 字，
 *      CSS 还 nowrap+ellipsis，一眼只看得见一小截）
 *   ② 像「正在跑命令…」一样，思考时也显示「正在思考中…」
 *
 * 源码断言 + 真机格一起守：连不上调试浏览器就 SKIP，不算失败。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('ui / 思考显示');
const ui = fs.readFileSync('public/index.html', 'utf8');

// ── 1. 不截断 ─────────────────────────────────────────────────────
t.ok('没有 38 字标题截断', !ui.includes('slice(0, 38)'));
t.ok('没有 400 字悬停截断', !ui.includes('slice(0, 400)'));
t.ok('三处标题都改成全文（实时/复用/历史）', (ui.match(/title\.textContent = flat;/g) || []).length === 3);
t.ok('悬停 title 属性被移除', (ui.match(/title\.removeAttribute\('title'\)/g) || []).length >= 3);
const cssLine = (ui.split(/\r?\n/).find((l) => l.includes('details.think .thinkTitle {')) || '');
t.ok('标题 CSS 不再 nowrap', !/nowrap/.test(cssLine), cssLine.trim().slice(0, 90));
t.ok('标题 CSS 不再 ellipsis', !/text-overflow:\s*ellipsis/.test(cssLine));
t.ok('标题 CSS 允许换行', /white-space:\s*pre-wrap/.test(cssLine));

// ── 2. 柜门三态链路 ───────────────────────────────────────────────
t.ok('openThink 建块就挂 thinking-now', /d\.className = 'think thinking-now'/.test(ui));
t.ok('思考流式中刷新柜门', /d\.classList\.add\('thinking-now'\); hubRefreshTitle\(\)/.test(ui));
t.ok('finish 撤标记并刷新柜门', (ui.match(/d\.classList\.remove\('thinking-now'\); hubRefreshTitle\(\)/g) || []).length >= 2);
t.ok('hubRefreshTitle 认 thinking-now', /querySelector\('details\.think\.thinking-now'\)/.test(ui));
t.ok('柜门写「正在思考中…」', ui.includes("'正在思考中…'"));
t.ok('思考优先于工具状态', /n1\.textContent = _thinking\s*\?\s*'正在思考中…'/.test(ui));
t.ok('hubpeek 思考时不重复', /\(_thinking \|\| _runEl\) \? ''/.test(ui));
t.ok('「正在跑命令…」没被弄坏', /'正在' \+/.test(ui));

// ── 3. 真机格 ─────────────────────────────────────────────────────
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
        + '<details class="think thinking-now"><summary><span class="thinkTitle">在想…</span><span class="thinkMeta">1 字</span></summary><div class="thinkBody">在想…</div></details>';
      lg.appendChild(hub);
      const _old = typeof _liveHub !== 'undefined' ? _liveHub : null;
      _liveHub = hub;
      hubRefreshTitle();
      out.thinking = hub.querySelector('.hubname').textContent;
      hub.querySelector('details.think').classList.remove('thinking-now');
      hubRefreshTitle();
      out.after = hub.querySelector('.hubname').textContent;
      hub.insertAdjacentHTML('beforeend', '<details class="tool"><summary class="toolHead"><span class="name">跑命令</span><span class="status warn">运行中…</span></summary><pre></pre></details>');
      hubRefreshTitle();
      out.tool = hub.querySelector('.hubname').textContent;
      _liveHub = _old; hub.remove();
      const th = openThink();
      const long = '主人这件事我得从头捋一遍。'.repeat(25);
      th.set(long);
      const ti = th.el.querySelector('.thinkTitle');
      out.titleLen = String(ti.textContent).length;
      out.flatLen = long.replace(/\\s+/g, ' ').trim().length;
      out.ws = getComputedStyle(ti).whiteSpace;
      out.hover = ti.hasAttribute('title');
      th.finish(); th.el.remove();
      try { if (typeof hubReset === 'function') hubReset(); } catch {}
      return out;
    `);
    t.ok('真机：思考中柜门写「正在思考中…」', r.thinking === '正在思考中…', JSON.stringify(r.thinking));
    t.ok('真机：想完退回统计', r.after === '想了 1 段', JSON.stringify(r.after));
    t.ok('真机：工具运行仍写「正在跑命令…」', r.tool === '正在跑命令…', JSON.stringify(r.tool));
    t.ok('真机：长思考标题一字不截', r.titleLen === r.flatLen, r.titleLen + '/' + r.flatLen);
    t.ok('真机：标题 CSS 可换行', r.ws !== 'nowrap', r.ws);
    t.ok('真机：不再挂 400 字悬停', r.hover === false);
  } catch (e) {
    t.ok('真机探针能跑', false, String(e.message).slice(0, 100));
  } finally {
    try { cdp.close(); } catch {}
  }
} else {
  console.log('  [skip] 没连上调试浏览器，真机那几格跳过（不算失败）');
}

t.done();
