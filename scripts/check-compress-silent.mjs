/**
 * 【真·静默压缩】—— 2026-11-09 换框架后重写
 *
 * 主人 2026-11-07 原话：「压缩记忆写摘要时还是会把写的内容显示出来，仅【压缩记忆】
 * 这个标题出现一瞬间删了，内容还是会有 —— 我的要求是真做到静默压缩。」
 *
 * ══ 这一版为什么整个重写 ══
 *
 * 换框架（对话区改 React）之后，「流式写进气泡」那条路整段没了：
 * `addAssistantAuto` / `pushStreamText` / `_compressMuted` 一个都不存在。
 * 旧检查是照着那条路写的（它自己调 `addAssistantAuto()` 造气泡），于是
 * **检查红、产品其实是好的** —— 典型的「断言实现，没断言行为」。
 *
 * 现在按**行为**验，验主人真正在意的两件事：
 *   ① 数据里带着「【压缩记忆…」的正文，**屏幕上（含流式中途）看不到摘要**；
 *   ② 数据里出现 `name:'compress'` 的假工具条，**屏幕上不出现那张卡**
 *      （旧前端有 4 处硬拦，重写后 `liveToItems` 不过滤了 —— 这一条现在红，是真缺口）。
 *
 * 怎么「喂数据」：新架构只有一个数据源 `window.__logState`，
 * 写入走 `window.__logStore.setLive(sid, {running, items})`。
 * 所以这里不造 DOM、不调绘制函数 —— 只喂数据，然后看 React 画出来什么。
 * 实现换掉、函数改名，这个检查都不用改。
 */
import { makeChecker, ensureLogStore } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';
import fs from 'node:fs';

const t = makeChecker('ui / 静默压缩');
const ui = readUISource();
const agent = fs.readFileSync('src/agent.mjs', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');

// ── 1. 后端：不再有假的 compress 工具条 ──────────────────────────
t.ok('后端不再推 compress 的 tool_start', !/name: 'compress'/.test(agent));
t.ok('后端不再推 compress 的 tool_end', !/type: 'tool_end'[^}]*name: 'compress'/.test(agent));
t.ok('压缩条变量已删干净', !/_compressBarId/.test(agent));
t.ok('静默压完仍打日志（可查）', /静默压完/.test(agent));
t.ok('compressed 事件仍在（数字要跟着掉）', /type: 'compressed'/.test(agent));

// ── 2. 正文里的「【压缩记忆」在**画之前**就被切掉 ────────────────
/* 新架构里 markdown 仍走 window.mdInto（React 只负责把 text 交给它），
 * 而 mdInto 第一件事就是剥 thinking / 压缩记忆 / XML 工具调用。
 * 这是「摘要不上屏」的实现落点，所以要断言它还在。 */
t.ok('mdInto 会先剥掉压缩记忆', /stripXmlToolCalls\(stripCompressMemoryText\(stripThinkingTags\(/.test(html));
t.ok('剥压缩记忆的函数还在', /function stripCompressMemoryText\(/.test(html));

// ── 3. 清洗路径：至少有一条（mdInto 那条是主路；DOM 安全网是备胎） ──
/* 【2026-11-09 换框架收尾时 NEES 安全网被删了】它本来只兜「不是走 mdInto 的插入」。
 * 主路（mdInto）还在，就够「摘要不上屏」。所以这里不强制安全网存在；
 * 但如果它还在，就必须认这个记号 —— 免得将来加回来却漏配。 */
const needs = html.match(/const NEEDS = \[([^\]]*)\]/);
if (needs) {
  t.ok('安全网 NEEDS 认「【压缩记忆」', needs[1].includes('【压缩记忆'), needs[1]);
} else {
  t.skip('DOM 安全网（NEEDS）已不在', '主路 mdInto 仍会剥，真机行为见下');
}

// ── 4. 前端不再画任何压缩提示 ────────────────────────────────────
t.ok('没有任何地方真的画「已压缩」', !/addSysNote\([^)]*已压缩/.test(ui) && !/addSysNote\([^)]*已压缩/.test(html));

/* ── 5. 真机：喂数据，看屏幕 ───────────────────────────────────
 * 只在隔离实例给过来的 CDP 端口上跑（XY_CDP_PORT 由 _test-instance 注入）。
 * 没有这个环境变量就 SKIP —— 绝不去猜 9223，那是主人自己开着的浏览器。 */
let cdp = null;
if (!process.env.XY_CDP_PORT) {
  console.log('\n真机格：SKIP（没有 XY_CDP_PORT，说明不是隔离实例在跑；源码断言已全过）');
} else {
  try {
    const { connect } = await import('../_t_cdp.mjs');
    cdp = await connect({ port: Number(process.env.XY_CDP_PORT) });
  } catch (e) { cdp = null; }
  if (!cdp) console.log('\n真机格：SKIP（连不上隔离实例的调试端口）');
}

if (cdp) {
  await ensureLogStore(cdp);

  /* ① 正文里带摘要：流式中途（busy=true）时也不许上屏 */
  const r1 = await cdp.eval(`
    const out = {};
    const head = '主人这件事我接着干。';
    const secret = '【压缩记忆·seg-9-abcdef】这一段是我写给自己的摘要，绝不该出现在屏幕上。';
    const keep = window.busy;
    window.busy = true;                       // 模拟「正在流式输出」
    window.__logStore.setLive(window.sessionId, {
      running: true, startedAt: Date.now(),
      items: [{ k: 'text', t: head + secret }],
    });
    await new Promise(function(r){ setTimeout(r, 700); });
    const lg = document.getElementById('log');
    out.busyText = String(lg.textContent || '');
    out.hasSecretBusy = out.busyText.indexOf('绝不该') >= 0;
    out.hasMarkBusy = out.busyText.indexOf('【压缩记忆') >= 0;
    window.busy = false;
    await new Promise(function(r){ setTimeout(r, 400); });
    out.idleText = String(lg.textContent || '');
    out.hasSecretIdle = out.idleText.indexOf('绝不该') >= 0;
    try { window.__logStore.setLive(window.sessionId, null); } catch (e) {}
    window.busy = keep;
    return out;
  `);
  t.ok('真机：流式中途摘要一个字都不上屏', r1 && r1.hasSecretBusy === false, String(r1 && r1.busyText).slice(-60));
  t.ok('真机：连「【压缩记忆」这个记号都不上屏', r1 && r1.hasMarkBusy === false, String(r1 && r1.busyText).slice(-60));
  t.ok('真机：停下来之后也不留痕', r1 && r1.hasSecretIdle === false, String(r1 && r1.idleText).slice(-60));
  t.ok('真机：标记前面那句照常显示', /接着干/.test(String(r1 && r1.busyText)), String(r1 && r1.busyText).slice(0, 40));

  /* ② 假工具条（name='compress'）：屏幕上不许出现那张卡
   *    —— 旧前端有 4 处硬拦（tool_start / tool_end / parts 重画 / …），
   *       换框架后 liveToItems 原样往下传，于是这张卡会被画出来。 */
  const r2 = await cdp.eval(`
    window.__logStore.setLive(window.sessionId, {
      running: true, startedAt: Date.now(),
      items: [{ k: 'tool', id: 'c1', name: 'compress', args: '{}', status: 'run', output: '' },
              { k: 'text', t: '正常的正文' }],
    });
    await new Promise(function(r){ setTimeout(r, 700); });
    const lg = document.getElementById('log');
    const out = {
      toolCards: lg.querySelectorAll('details.tool, .tool').length,
      hasCompressWord: String(lg.textContent || '').indexOf('压缩') >= 0,
      text: String(lg.textContent || ''),
    };
    try { window.__logStore.setLive(window.sessionId, null); } catch (e) {}
    return out;
  `);
  t.ok('真机：compress 假工具条不画卡', r2 && r2.toolCards === 0,
    '画出来 ' + (r2 && r2.toolCards) + ' 张；屏上文字：' + String(r2 && r2.text).slice(-50));
  t.ok('真机：屏幕上不出现「压缩」字样', r2 && r2.hasCompressWord === false,
    String(r2 && r2.text).slice(-50));
  t.ok('真机：同一份数据里的正常正文照常画', /正常的正文/.test(String(r2 && r2.text)));

  cdp.close();
}

t.done();
