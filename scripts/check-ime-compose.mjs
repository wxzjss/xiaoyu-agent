/**
 * 【输入法白框】
 *
 * 主人 2026-11-07 发截图：输入框上方卡着一块白框，里面是一串带撇号的拼音
 * （zhe'ge'bai'kuang'…），那是微软拼音的**预编辑串 composition**。
 *
 * 这个程序有个「一点输入框就掰输入法」的功能：走 imm32 翻中英转换状态，
 * 还会 focus() 重建 IME 上下文。打字打到一半点一下输入框，正好在
 * composition 中途动它 → 拼音串残在那儿变成白框。前端原本完全没有
 * compositionstart/end 监听，只在 keydown 里判过 isComposing。
 *
 * 修法：拼音没上屏、或刚上屏 250ms 内，既不抢焦点也不切输入法；
 * 慢请求（imeFeatureOn 的 fetch）回来之后还要再查一次。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('ui / 输入法白框');
const ui = fs.readFileSync('public/index.html', 'utf8');

t.ok('有 compositionstart 监听', /input\.addEventListener\('compositionstart'/.test(ui));
t.ok('有 compositionend 监听', /input\.addEventListener\('compositionend'/.test(ui));
t.ok('compositionend 记了时间戳', /__xyImeEndAt = Date\.now\(\)/.test(ui));
t.ok('imeBusy 覆盖「正在打」+「刚上屏冷却」', /function imeBusy\(\)[\s\S]{0,220}__xyImeComposing[\s\S]{0,220}< 250/.test(ui));
t.ok('imeMatchOnce 进门第一件事就让路', /async function imeMatchOnce\(\) \{\s*\n\s*if \(imeBusy\(\) \|\| imeTypingRecently\(\)\) return;/.test(ui));
t.ok('await 慢请求之后再查一次', /if \(!\(await imeFeatureOn\(\)\)\) return;[\s\S]{0,340}if \(imeBusy\(\)\) return;/.test(ui));
t.ok('抢焦点 grab() 也让路', /const grab = \(\) => \{[\s\S]{0,320}imeBusy\(\)/.test(ui));
t.ok('Enter 选词不发送那条还在', /e\.isComposing \|\| e\.keyCode === 229/.test(ui));
t.ok('状态挂 window 上，避开 let 暂时性死区', /window\.__xyImeComposing = false/.test(ui));

// ── 真机格 ─────────────────────────────────────────────────────────
let cdp = null;
try {
  const m = await import('../_t_cdp.mjs');
  cdp = await m.connect({ port: 9223, match: '8788' });
} catch { /* 没开调试浏览器 */ }
if (cdp) {
  try {
    const r = await cdp.eval(`
      const out = {};
      const inp = document.getElementById('input');
      window.__xyImeComposing = false;
      window.__xyImeEndAt = 0;
      imeSwitching = false;
      out.idle = imeBusy();
      inp.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      out.composing = imeBusy();
      /* 正在打拼音时点输入框：imeMatchOnce 应该第一行就退，连锁都不上 */
      imeMatchOnce();
      out.lockedWhileComposing = imeSwitching;
      inp.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      out.justEnded = imeBusy();
      window.__xyImeEndAt = Date.now() - 400;
      out.afterCooldown = imeBusy();
      window.__xyImeComposing = false;
      return out;
    `);
    t.ok('真机：闲时允许切', r.idle === false, JSON.stringify(r));
    t.ok('真机： composition 中禁止切', r.composing === true);
    t.ok('真机：打拼音时点输入框不会触发切换', r.lockedWhileComposing === false);
    t.ok('真机：刚上屏仍在冷却', r.justEnded === true);
    t.ok('真机：冷却过了恢复', r.afterCooldown === false);
  } catch (e) {
    t.ok('真机探针能跑', false, String(e.message).slice(0, 120));
  } finally {
    try { cdp.close(); } catch {}
  }
} else {
  console.log('  [skip] 没连上调试浏览器，真机那几格跳过（不算失败）');
}

// ── 【2026-11-07 主人定位后的修法】点击不立刻切，人一动手就作废 ──────────
let cdp2 = null;
try {
  const { connect } = await import('../_t_cdp.mjs');
  cdp2 = await connect({ port: 9223, match: '8788' });
} catch { cdp2 = null; }
t.ok('有「等一等再切」的入口', /function imeMatchSoon\(\)/.test(ui));
t.ok('有「作废」的入口', /function imeCancelSoon\(\)/.test(ui));
/* 【2026-11-07】触发点拆成两条：用户按下（pointerdown）才是「他想换输入法」，
 * 程序自己 focus（页面加载、插完附件）不算 —— 那条正是「重启后直接打字出白框」的根因。 */
t.ok('用户按下才算要切', /addEventListener\('pointerdown'[\s\S]{0,140}_imeUserTouchedAt = Date\.now\(\)[\s\S]{0,100}imeMatchSoon\(\)/.test(ui));
t.ok('程序代 focus 不切（要刚点过才认）', /_imeUserTouchedAt > 1500\) return;/.test(ui));
t.ok('打字会取消待切', /'keydown', markTyping/.test(ui));
t.ok('打拼音也会取消', /'compositionstart', markTyping/.test(ui));
t.ok('刚打过字就整段不切', /function imeTypingRecently\(\)/.test(ui) && /imeBusy\(\) \|\| imeTypingRecently\(\)/.test(ui));

if (cdp2) {
  try {
    const r2 = await cdp2.eval(`
      const out = {};
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const inp = document.getElementById('input') || document.querySelector('textarea');
      let calls = 0;
      try {
        imeGateOn = true; imeGateAt = Date.now();
        window.desktop = window.desktop || {};
        window.desktop.imeMatchSystem = async () => { calls += 1; };
        const click = () => inp.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        window.__xyImeTypeAt = 0;

        /* ① 程序自己 focus（页面加载那条路）→ 一次都不许切
           【2026-11-07 主人】「重启后直接点键盘就出白框」就是被这条坑的 */
        calls = 0; _imeUserTouchedAt = 0;
        inp.blur(); inp.focus();
        await sleep(1000);
        out.programFocus = calls;

        /* ② 用户点一下、接着打字 → 一次都不许切 */
        calls = 0; window.__xyImeTypeAt = 0;
        click();
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        await sleep(1000);
        out.typing = calls;

        /* ③ 用户点一下、一直不打字 → 该切（延迟不是把功能关掉） */
        calls = 0; window.__xyImeTypeAt = 0; imeCancelSoon();
        click();
        await sleep(1000);
        out.idle = calls;

        /* ④ 刚打完字（3 秒内）再点 → 也不切 */
        calls = 0; window.__xyImeTypeAt = Date.now();
        click();
        await sleep(1000);
        out.within3s = calls;

        /* ⑤ 打过字已过 3 秒 → 恢复该切 */
        calls = 0; window.__xyImeTypeAt = Date.now() - 4000;
        click();
        await sleep(1000);
        out.after3s = calls;
      } catch (e) { out.err = String(e); }
      window.__xyImeTypeAt = 0;
      return out;
    `);
    console.log('');
    console.log('真机（延迟切换）：' + JSON.stringify(r2));
    t.ok('真机：程序代 focus 不切（重启后直接打字的根因）', r2.programFocus === 0, String(r2.programFocus));
    t.ok('真机：点完立刻打字——一次都没切', r2.typing === 0, String(r2.typing));
    t.ok('真机：只点不打字——照旧会切', r2.idle >= 1, String(r2.idle));
    t.ok('真机：刚打完字再点——不切', r2.within3s === 0, String(r2.within3s));
    t.ok('真机：过了 3 秒——恢复该切', r2.after3s >= 1, String(r2.after3s));
  } catch (e) {
    t.ok('真机探针（延迟切换）能跑', false, String(e.message).slice(0, 120));
  } finally {
    try { cdp2.close(); } catch {}
  }
}

t.done();
