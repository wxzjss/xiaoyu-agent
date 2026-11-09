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
import { readUISource } from './_ui-src.mjs';
import fs from 'node:fs';

const t = makeChecker('ui / 回车发送附件');
const ui = readUISource();

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
  cdp = await connect({ port: Number(process.env.XY_CDP_PORT || 9223) });
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

  /* 【2026-11-09 加】输入法「上屏那一下」+ 不再用原生 alert
   *
   * 主人要求先看 WorkBuddy 和 dsh 怎么做输入法。两边（WorkBuddy 的 renderer、
   * dsh-client-ui-conversation）都是自己维护 compositionstart/compositionend 状态，
   * 判回车时看的是那个状态而不是那一瞬间的 e.isComposing —— 因为有的输入法
   * 上屏时先 compositionend、再发 Enter，那时 isComposing 已经是 false 了。
   *
   * 另：删除失败那条分支原来走原生 alert，它是模态的，窗口不在最前时会变成
   * 一块看不见的挡板（主人报的「输入框变灰、点不动」）。现在换页内提示条。 */
  const r2 = await cdp.eval(`
    const out = {};
    const inp = document.getElementById('input');
    const realSend = window.send;
    let n = 0;
    window.send = function () { n += 1; };
    const comp = (type) => inp.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    const enter = () => inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));

    /* 【顺序很重要，而且全程不许用 setTimeout】
     * headless 里窗口不在前台，定时器会被节流到几乎不跑 —— 之前这里写了
     * await 220ms，结果 CDP 一直等不到 Promise，整条检查卡死 20 秒。
     * 所以改成：先测「正常回车」，再测两种「输入法里」的情况，全靠事件顺序，
     * 一个定时器都不用。 */
    inp.value = '你好';
    enter();                       // ① 没在输入法里 → 该发
    out.正常 = n;

    comp('compositionstart');
    inp.value = 'nihao';
    enter();                       // ② 拼音没选完 → 不发
    out.中途 = n;

    comp('compositionend');
    enter();                       // ③ 上屏那一下的回车 → 不发
    out.上屏同刻 = n;

    window.alert('测试：删不掉');
    const toast = document.querySelector('#xyToasts .xyToast');
    out.是提示条 = Boolean(toast);
    out.提示层不吃点击 = toast ? getComputedStyle(document.getElementById('xyToasts')).pointerEvents : '';
    inp.focus();
    out.输入框还能聚焦 = document.activeElement === inp;

    window.send = realSend;
    inp.value = '';
    try { if (toast) toast.remove(); } catch {}
    return out;
  `);
  /* 三次是**累计计数**：①发出去一次(n=1)，②③都不许让 n 再涨 */
  t.ok('真机：没在输入法里按回车 → 照发', r2.正常 === 1, String(r2.正常));
  t.ok('真机：输入法打一半按回车 → 不发', r2.中途 === 1, String(r2.中途));
  t.ok('真机：上屏那一下的回车 → 不发（这一条只有 composition 状态才拦得住）',
    r2.上屏同刻 === 1, String(r2.上屏同刻));
  t.ok('真机：alert 变成页内提示条（不再模态）', r2.是提示条 === true);
  t.ok('真机：提示条不吃点击、不抢焦点', r2.提示层不吃点击 === 'none' && r2.输入框还能聚焦 === true,
    r2.提示层不吃点击 + ' / ' + r2.输入框还能聚焦);
  cdp.close();
}

t.done();
