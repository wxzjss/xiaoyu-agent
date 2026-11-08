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
t.ok('三处标题都走 thinkTitleOf（实时/复用/历史）', (ui.match(/title\.textContent = thinkTitleOf\(flat\);/g) || []).length === 3);
/* 【2026-11-07 改口径】主人要「标题长到碰到右侧框框边界」。
 * 原来硬截 40 字，可一行能放七十来字 —— 标题后面永远空一截。
 * 现在只取第一句、上限放到 400（远大于一行），视觉截断交给 CSS 的 ellipsis。 */
t.ok('标题取第一句，长度交给 CSS 边界截断', /function thinkTitleOf\(flat\)/.test(ui) && /\{1,400\}/.test(ui));
/* 【2026-11-08 改口径】这两条守的是 11-07 的旧取舍「收起不占位、展开才显示字数」。
 * 主人今天明确要「展开前就显示字数」，旧断言与需求相反，删掉，
 * 由文件末尾那两条新断言接管（收起也显示 + 直播时就更新）。 */
t.ok('标题仍是 nowrap + 省略号', /details\.think \.thinkTitle \{[^}]*white-space: nowrap/.test(ui) && /details\.think \.thinkTitle \{[^}]*text-overflow: ellipsis/.test(ui));
t.ok('正文不截（thinkBody 写全文）', /body\.textContent = t;/.test(ui) || /_full = t/.test(ui));
t.ok('标题用一行省略兜底', /details\.think \.thinkTitle \{[^}]*nowrap/.test(ui));
t.ok('悬停 title 属性被移除', (ui.match(/title\.removeAttribute\('title'\)/g) || []).length >= 3);
const cssLine = (ui.split(/\r?\n/).find((l) => l.includes('details.think .thinkTitle {')) || '');
/* 【2026-11-07 再改】标题回到「一行 + 省略」，全文放正文 —— 见 thinkTitleOf 的说明。 */
t.ok('标题 CSS 一行不换行', /white-space:\s*nowrap/.test(cssLine), cssLine.trim().slice(0, 90));
t.ok('标题 CSS 溢出用省略号', /text-overflow:\s*ellipsis/.test(cssLine));
t.ok('正文 CSS 允许换行（全文照旧全显示）', /\.thinkBody\s*\{[^}]*pre-wrap/.test(ui));

// ── 2. 柜门三态链路 ───────────────────────────────────────────────
t.ok('openThink 建块就挂 thinking-now', /d\.className = 'think thinking-now'/.test(ui));
t.ok('思考流式中刷新柜门', /d\.classList\.add\('thinking-now'\); hubRefreshTitle\(\)/.test(ui));
t.ok('finish 撤标记并刷新柜门', (ui.match(/d\.classList\.remove\('thinking-now'\); hubRefreshTitle\(\)/g) || []).length >= 2);
t.ok('hubRefreshTitle 认 thinking-now', /querySelector\('details\.think\.thinking-now'\)/.test(ui));
t.ok('柜门写「正在思考中…」', ui.includes("'正在思考中…'"));
/* 【2026-11-08 改口径】主人要「调了 x 次」跟着实时动，所以柜门运行中是
 * 「调了 N 次 · 正在思考中…」/「调了 N 次 · 正在跑命令…」，计数是可选前缀。 */
t.ok('思考优先于工具状态', /n1\.textContent = _thinking\s*\?\s*\(_cnt \+ '正在思考中…'\)/.test(ui));
/* 【2026-11-07 改口径】工具在跑时灰字不再是空的，写金色「运行中」（主人要的那个） */
t.ok('hubpeek：思考给实时灰字、工具写金色「运行中」、结束给摘要',
  /if \(_thinking\) \{[\s\S]{0,80}pk\.textContent = _thinking\.dataset\.peek/.test(ui)
  && /else if \(_runEl\) \{[\s\S]{0,80}pk\.textContent = '运行中'/.test(ui));
t.ok('「正在跑命令…」没被弄坏', /'正在' \+/.test(ui));

// ── 2b. 柜门右侧「不断变化的思考灰字」 ────────────────────────────
t.ok('有 thinkPeekTail，且取的是尾部片段', /function thinkPeekTail\(text\)/.test(ui) && /flat\.slice\(-160\)/.test(ui));
t.ok('实时 set 每拍更新 dataset.peek', /d\.dataset\.peek = thinkPeekTail\(flat\)/.test(ui));
t.ok('整组重画也更新灰字', (ui.match(/dataset\.peek = thinkPeekTail\(flat\)/g) || []).length >= 2);
t.ok('灰字三分支：思考 / 工具(运行中) / 结束', /if \(_thinking\) \{[\s\S]{0,80}pk\.textContent = _thinking\.dataset\.peek/.test(ui)
  && /else if \(_runEl\) \{[\s\S]{0,80}pk\.textContent = '运行中'/.test(ui)
  && /pk\.textContent = hubPeekOf\(/.test(ui));
t.ok('金色「运行中」有对应样式', /\.hubpeek\.live \{ color: #f0b954/.test(ui));

// ── 3. 真机格 ─────────────────────────────────────────────────────
let cdp = null;
try {
  const m = await import('../_t_cdp.mjs');
  cdp = await m.connect({ port: Number(process.env.XY_CDP_PORT || 9223), match: '8788' });
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
      const thk = hub.querySelector('details.think');
      thk.dataset.peek = '在捋第一步';
      hubRefreshTitle();
      out.thinking = hub.querySelector('.hubname').textContent;
      out.peek1 = hub.querySelector('summary > .hubpeek').textContent;
      thk.dataset.peek = '在捋第二步，越想越多了';
      hubRefreshTitle();
      out.peek2 = hub.querySelector('summary > .hubpeek').textContent;
      thk.classList.remove('thinking-now');
      hubRefreshTitle();
      out.after = hub.querySelector('.hubname').textContent;
      out.peekAfter = hub.querySelector('summary > .hubpeek').textContent;
      hub.insertAdjacentHTML('beforeend', '<details class="tool"><summary class="toolHead"><span class="name">跑命令</span><span class="status warn">运行中…</span></summary><pre></pre></details>');
      hubRefreshTitle();
      out.tool = hub.querySelector('.hubname').textContent;
      out.peekTool = hub.querySelector('summary > .hubpeek').textContent;
      _liveHub = _old; hub.remove();
      const th = openThink();
      const long = '主人这件事我得从头捋一遍。'.repeat(25);
      th.set(long);
      const ti = th.el.querySelector('.thinkTitle');
      out.titleLen = String(ti.textContent).length;
      out.flatLen = long.replace(/\\s+/g, ' ').trim().length;
      out.ws = getComputedStyle(ti).whiteSpace;
      const bd = th.el.querySelector('.thinkBody');
      out.bodyLen = String((bd && bd.textContent) || '').length;
      out.hover = ti.hasAttribute('title');
      out.peekTail = String(th.el.dataset.peek || '');
      out.peekIsTail = long.replace(/\\s+/g, ' ').trim().endsWith(out.peekTail.replace(/^…/, ''));
      th.finish(); th.el.remove();
      try { if (typeof hubReset === 'function') hubReset(); } catch {}
      return out;
    `);
    t.ok('真机：思考中柜门写「正在思考中…」', r.thinking === '正在思考中…', JSON.stringify(r.thinking));
    t.ok('真机：想完退回统计', r.after === '想了 1 段', JSON.stringify(r.after));
    t.ok('真机：工具运行仍写「（调了 N 次 · ）正在跑命令…」',
      /(调了 \d+ 次 · )?正在跑命令…$/.test(String(r.tool)), JSON.stringify(r.tool));
    t.ok('真机：标题只放第一句（短）', r.titleLen > 0 && r.titleLen <= 44, String(r.titleLen));
    t.ok('真机：标题一行不换行', r.ws === 'nowrap', r.ws);
    t.ok('真机：正文仍是全文', r.bodyLen === r.flatLen, String(r.bodyLen) + '/' + String(r.flatLen));
        t.ok('真机：思考中右侧灰字有内容', r.peek1 === '在捋第一步', JSON.stringify(r.peek1));
    t.ok('真机：灰字跟着流不断变化', r.peek2 !== r.peek1 && r.peek2 === '在捋第二步，越想越多了', JSON.stringify(r.peek2));
    t.ok('真机：想完退回摘要', r.peekAfter.length > 0 && r.peekAfter !== r.peek2, JSON.stringify(r.peekAfter));
    t.ok('真机：工具运行时灰字是金色「运行中」', r.peekTool === '运行中', JSON.stringify(r.peekTool));
    t.ok('真机：长思考的灰字取的是最新尾部', r.peekTail.startsWith('…') && r.peekTail.length <= 161 && r.peekIsTail, JSON.stringify(r.peekTail));
  } catch (e) {
    t.ok('真机探针能跑', false, String(e.message).slice(0, 100));
  } finally {
    try { cdp.close(); } catch {}
  }
} else {
  console.log('  [skip] 没连上调试浏览器，真机那几格跳过（不算失败）');
}

/* 【2026-11-08 加·字数要收起时也看得见】
 * 主人：「柜子里的思考链需要展开后才在右侧显示有多少字，改成展开前就显示」。
 * 原 CSS 是 `display:none` + `[open] display:block`，直播那边其实一直在写
 * `meta.textContent = N 字`，只是被藏了。这里守两件事：不再藏、也不再只认展开态。 */
t.ok('思考字数收起时也显示（不再靠 [open] 才出现）',
  !/details\.think \.thinkMeta \{ display: none/.test(ui)
  && !/details\.think\[open\] \.thinkMeta/.test(ui)
  && /details\.think \.thinkMeta \{[^}]*flex: none/.test(ui));
t.ok('直播过程中就在更新字数', /meta\.textContent = body\.textContent\.length \+ ' 字'/.test(ui));

t.done();
