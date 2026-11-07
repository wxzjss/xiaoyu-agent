/**
 * 【插了附件，按回车就该发出去】
 *
 * 主人 2026-11-07：「在输入框插入文件比如说图片时，按回车不能直接发送出去，
 * 得按【发送】才行。」
 *
 * 卡的是「输入法选词」那道门：插完附件、输入框是空的，人想把图发出去，
 * 可有些输入法在空输入框里也给 keyCode 229（或 composition 状态没干净），
 * 这一下 Enter 就被当成「选词」吞了。
 *
 * 两处修：
 *   ① 输入框里：只要「一个字都没有 + 手上有附件」，管它 229 不 229，照发
 *   ② 焦点不在输入框时兜底：没开面板、有附件，回车也发
 *
 * 真机段会把 send 换成一个计数器，验完还原 —— 不会真发消息。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('ui / 回车发送附件');
const ui = fs.readFileSync('public/index.html', 'utf8');

// ── 源码 ─────────────────────────────────────────────────────────
t.ok('229/选词那道门还在', /e\.isComposing \|\| e\.keyCode === 229/.test(ui));
t.ok('空输入框 + 有附件时放行', /_imBlocked[\s\S]{0,320}attachments\.length\)\s*\{[\s\S]{0,120}send\(\)/.test(ui));
t.ok('空消息什么都不发', /!String\(input\.value \|\| ''\)\.trim\(\) && !attachments\.length\) return;/.test(ui));
t.ok('有文档级兜底监听', /document\.addEventListener\('keydown',[\s\S]{0,200}attachments\.length \|\| busy\) return;/.test(ui));
t.ok('兜底会避开面板和别的输入框', /dialog\[open\][\s\S]{0,400}tag === 'input'/.test(ui));

// ── 真机 ─────────────────────────────────────────────────────────
let cdp = null;
try {
  const { connect } = await import('../_t_cdp.mjs');
  cdp = await connect({ port: 9223, match: '8788' });
} catch { cdp = null; }

if (!cdp) {
  console.log('\n真机格：SKIP（没连上 9223 的调试浏览器，源码断言已全过）');
} else {
  /* 先刷新：运行版 index.html 可能刚同步过，页面里还是旧代码 —— 不刷新等于验了个假的。 */
  try {
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 14000));
  } catch { console.log('（刷新失败，按当前页面验）'); }
  const r = await cdp.eval(`
      const out = {};
      const inp = document.getElementById('input');
      const mk = (o) => {
        const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, shiftKey: !!o.shift });
        if (o.composing) Object.defineProperty(e, 'isComposing', { value: true });
        if (o.k229) Object.defineProperty(e, 'keyCode', { value: 229 });
        return e;
      };
      let calls = 0;
      const realSend = window.send;
      const realBusy = busy;
      const realAtts = attachments.slice();
      try {
        window.send = () => { calls += 1; };
        busy = false;
        attachments.length = 0;
        attachments.push({ path: 'D:/x/a.png', name: 'a.png', kind: 'image' });
        inp.value = '';
        inp.focus();

        calls = 0; inp.dispatchEvent(mk({ k229: true }));      out.enter229 = calls;
        calls = 0; inp.dispatchEvent(mk({}));                  out.enterPlain = calls;
        calls = 0; inp.dispatchEvent(mk({ composing: true })); out.enterComposing = calls;

        attachments.length = 0;
        calls = 0; inp.dispatchEvent(mk({}));                  out.enterNoAttach = calls;

        attachments.push({ path: 'D:/x/b.png', name: 'b.png', kind: 'image' });
        inp.value = 'ni';
        calls = 0; inp.dispatchEvent(mk({ composing: true }));  out.composingWithText = calls;

        inp.value = '';
        inp.blur();
        calls = 0; document.body.dispatchEvent(mk({}));        out.fromBody = calls;

        calls = 0;
        const d = document.createElement('dialog'); d.open = true; document.body.appendChild(d);
        document.body.dispatchEvent(mk({}));
        out.dialogOpen = calls;
        d.remove();
      } catch (e) { out.err = String(e); }
      window.send = realSend;
      busy = realBusy;
      attachments.length = 0;
      for (const a of realAtts) attachments.push(a);
      try { inp.value = ''; } catch {}
      return out;
  `);
  console.log('\n真机：' + JSON.stringify(r));
  t.ok('真机：229 + 只有附件 → 发出去', r.enter229 === 1, String(r.enter229));
  t.ok('真机：正常回车 + 只有附件 → 发出去', r.enterPlain === 1, String(r.enterPlain));
  t.ok('真机：空输入框没附件 → 不发', r.enterNoAttach === 0, String(r.enterNoAttach));
  t.ok('真机：正在打拼音（有字）→ 不发', r.composingWithText === 0, String(r.composingWithText));
  t.ok('真机：焦点在页面空白处 + 有附件 → 也能发', r.fromBody === 1, String(r.fromBody));
  t.ok('真机：面板开着 → 不发', r.dialogOpen === 0, String(r.dialogOpen));
  cdp.close();
}

t.done();
