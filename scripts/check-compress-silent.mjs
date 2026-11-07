/**
 * 【真·静默压缩】
 *
 * 主人 2026-11-07：「压缩记忆写摘要时还是会把写的内容显示出来，
 * 仅【压缩记忆】这个标题出现一瞬间删了，内容还是会有 —— 我的要求是真做到静默压缩。」
 *
 * 两道关：
 *   ① 后端不再推「压缩中」那条假工具条（原来会闪一下）
 *   ② 前端流式写到气泡前就把「【压缩记忆…」及其后全部截掉（原来只在重画时剥，
 *      直播这条路一个字都没管 → 摘要一个字一个字流到屏幕上）
 *   ③ DOM 安全网 NEEDS 也要认「【压缩记忆」，历史重画/快照路径同样静默
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('ui / 静默压缩');
const ui = fs.readFileSync('public/index.html', 'utf8');
const agent = fs.readFileSync('src/agent.mjs', 'utf8');

// ── 1. 后端：不再有假的 compress 工具条 ──────────────────────────
t.ok('后端不再推 compress 的 tool_start', !/name: 'compress'/.test(agent));
t.ok('后端不再推 compress 的 tool_end', !/type: 'tool_end'[^}]*name: 'compress'/.test(agent));
t.ok('压缩条变量已删干净', !/_compressBarId/.test(agent));
t.ok('静默压完仍打日志（可查）', /静默压完/.test(agent));
t.ok('compressed 事件仍在（数字要跟着掉）', /type: 'compressed'/.test(agent));

// ── 2. 前端流式：压缩记忆一出现就永久截断 ────────────────────────
t.ok('流式里截压缩记忆', /【压缩记忆/.test(ui));
t.ok('截断后上锁，后面的字不再收', /_compressMuted/.test(ui));
t.ok('上锁后不再追加', /else if \(!bubble\._compressMuted\)/.test(ui));

// ── 3. DOM 安全网认这个记号 ──────────────────────────────────────
const needs = ui.match(/const NEEDS = \[([^\]]*)\]/);
t.ok('NEEDS 里有「【压缩记忆」', !!needs && needs[1].includes('【压缩记忆'), needs ? needs[1] : '(没找到)');
t.ok('安全网切完是空的就藏起来', /el\.style\.display = f\.trim\(\) \? '' : 'none'/.test(ui));

// ── 4. 前端不再画任何压缩提示 ────────────────────────────────────
t.ok('compressed 分支不画东西', /ev\.type === 'compressed'\)[\s\S]{0,400}noteNewContent\(\);/.test(ui));
t.ok('没有任何地方真的画「已压缩」', !/addSysNote\([^)]*已压缩/.test(ui));

// ── 5. 真机：喂一段带压缩记忆的流，屏幕上不能出现摘要 ────────────
let cdp = null;
try {
  const { connect } = await import('../_t_cdp.mjs');
  cdp = await connect({ port: 9223, match: '8788' });
} catch (e) { cdp = null; }

if (!cdp) {
  console.log('\n真机格：SKIP（没连上 9223 的调试浏览器，源码断言已全过）');
} else {
  const r = await cdp.eval(`
      const out = {};
      const log = document.getElementById('log');
      try {
        const b = addAssistantAuto();
        const head = '主人这件事我接着干。';
        const secret = '【压缩记忆·seg-9-abcdef】这一段是我写给自己的摘要，绝不该出现在屏幕上。';
        pushStreamText(b, head);
        out.beforeMark = b.textContent;
        pushStreamText(b, secret.slice(0, 10));
        out.atMark = b.textContent;
        pushStreamText(b, secret.slice(10));
        pushStreamText(b, '后面还有一段也不许出来');
        out.final = b.textContent;
        out.hasSecret = b.textContent.indexOf('绝不该') >= 0 || b.textContent.indexOf('后面还有') >= 0;
        out.muted = !!b._compressMuted;
        b.closest('.msg')?.remove();
      } catch (e) { out.err = String(e); }
      return out;
  `);
  console.log('\n真机：' + JSON.stringify(r));
  t.ok('真机：标记前的话照常显示', /接着干/.test(String(r.beforeMark)), String(r.beforeMark));
  t.ok('真机：摘要一个字都没进气泡', r.hasSecret === false);
  t.ok('真机：上了锁', r.muted === true);
  t.ok('真机：气泡里只有标记前那句', String(r.final).trim() === '主人这件事我接着干。', String(r.final));
  cdp.close();
}

t.done();
