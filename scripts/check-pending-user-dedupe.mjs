#!/usr/bin/env node
/**
 * 【QA · 2026-11-10】「主人那句话不许出现两遍」—— 乐观气泡必须被历史收掉
 *
 * ══ 这个脚本为什么存在 ══
 *
 * 主人每发一句话，前端会**先乐观地插一颗主人气泡**（`pushPendingUser`），等这句话
 * 真的写进盘里的历史之后，再把它撤掉（`dropLandedPending`），由历史那条接手画。
 * 撤不掉 = 屏幕上同一句话出现两遍（一颗「待发送」，一颗「历史」）。
 *
 * 2026-11-10 换框架收口时实测到的真缺陷：
 *   `public/ui/chat.js` 的 `logSetHistory()` 是**直接写 `LOG_STATE.turns` 再 notifyStore()**，
 *   它压根不经过 `src-ui/store.js` 的 `setHistory()`。而「撤掉乐观气泡」这件事
 *   只写在 `setHistory()` 里 —— 于是它从来没被执行过：
 *     · `setHistory` 在生产代码里**零调用点**（只有自己 export 出去）
 *     · `dropLandedPending` / `notes = []` / `histWin.delete` 全是死代码
 *   结果：跑完一轮，屏幕上 `.msg.user` 是 **2** 个，盘上只有 **1** 条。
 *   （实测：两个气泡的文字**逐字相同**，且都等于盘上那条。）
 *
 * ══ 断言（只断言行为 + 一条源码不变式）══
 *   ① 源码：`logSetHistory` 必须把写入交给 store（否则 dropLandedPending 永远不跑）
 *      判据不看函数名，看**行为**：`__logStore.setHistory` 在生产代码里必须被调用
 *   ② 单测：落盘对账的九种边界（工具轮、同字连发、下标 0、旧尸体、收尾…），
 *      不用浏览器也不用模型 —— 【2026-11-11 加，见下面那段长注释】
 *   ③ 真机：发一句话跑完，`.msg.user` 恰好 1 个（盘上也只有 1 条）
 *   ④ 真机：那一颗主人气泡的文字 == 盘上那条（没串、没截）
 *
 * 用法：node scripts/check-pending-user-dedupe.mjs [--public public]
 * 需要隔离实例（XY_CDP_PORT）才有真机格；没有就跑源码 + 单测两节。
 */
import fs from 'node:fs';
import path from 'node:path';
import { startIsolated } from './_test-instance.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '\n       ' + extra : '')); }
};
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ');
const read = (p) => stripComments(fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'));

/* ══════════════════════════════════════════════════════════════
 * 一、源码不变式：写入必须走 store（否则清账的钩子永远不跑）
 * ══════════════════════════════════════════════════════════════ */
console.log('\n一、源码：历史写入必须经过 store（撤乐观气泡的钩子挂在它上面）');
{
  const chat = read('public/ui/chat.js');
  const html = read('public/index.html');
  const store = read('src-ui/store.js');

  /* 清账逻辑本身在 store 里 */
  const hasHook = /function\s+setHistory\(/.test(store) && /dropLandedPending\(pendingUser/.test(store);
  ok(hasHook, 'store.setHistory 里有「落盘后撤掉乐观气泡」这一步');

  /* 生产代码里必须真的调它 —— 零调用点就是死代码，这条就是那个 bug 的指纹 */
  const callers = [...(chat + '\n' + html).matchAll(/__logStore\s*\.\s*setHistory\s*\(/g)].length;
  ok(callers > 0, '生产代码里真的调了 __logStore.setHistory（不是死代码）',
    '一处都没调 —— 撤乐观气泡的钩子永远不会执行，那句话会显示两遍');

  /* 反向：谁都不许绕过 store 直接写 turns（那就是「两套账」的小号版本） */
  const bypass = [...chat.matchAll(/(?:^|[^.\w$])LOG_STATE\s*\.\s*turns\s*=/g)].length;
  ok(bypass === 0 || callers > 0, 'LOG_STATE.turns 的写入没有绕开 store',
    'chat.js 里直接写 LOG_STATE.turns ' + bypass + ' 处，且没有一处经 store');
}

/* ══════════════════════════════════════════════════════════════
 * 二、单测：直接跑真 store 的落盘对账（不需要浏览器，也不需要模型）
 *
 * 【2026-11-11 加·主人报「我发的话会重复显示到 ai 回复的后面」】
 *
 * 上一节只能证明「钩子被调到」，证明不了「钩子认得出这句话已落盘」。
 * 真正病根在判据本身：`dropLandedPending()` 拿 `turns.slice(-6)` 当窗口，
 * 前提是「刚发出去那句必然贴着尾巴」——而 assistant 是**一条消息一个 turn**，
 * 她调几次工具一轮就劈成七八条，实测主人那份会话最后一句 user 之后跟了 101 条 turn。
 * 窗口里一条 user 都没有 → 文字比对必然落空 → 气泡永远撤不掉。
 *
 * 这一节把边界钉死，任何人再动这段逻辑，跑一次就知道有没有踩回去。
 * ══════════════════════════════════════════════════════════════ */
console.log('\n二、单测：落盘对账的边界（假 window + 真 store）');
{
  globalThis.window = { __logState: { sid: 's-dedupe-check', turns: [], live: null } };
  const store = await import('../src-ui/store.js');

  const SID = 's-dedupe-check';
  const U = (text, at) => ({ role: 'user', text, rewindId: at });
  const A = (i) => ({ role: 'assistant', text: '第 ' + i + ' 段', rewindId: 300 + i });
  const ASK = 'QA 主人一句';
  const left = () => store.getSnapshot().pendingUser.length;
  const tools = (n) => Array.from({ length: n }, (_, i) => A(i));

  /* ① 一轮带 7 次工具：这就是 slice(-6) 全军覆没的形状 */
  store.setHistory(SID, []);
  store.pushPendingUser({ text: ASK });
  store.setHistory(SID, [U(ASK, 10), ...tools(7)]);
  ok(left() === 0, '① user + 7 段 assistant 时，乐观气泡要收掉', '还剩 ' + left() + ' 颗');

  /* ② 刚落、还不知道落盘下标：先留着（否则发送瞬间气泡会闪一下就没） */
  store.pushPendingUser({ text: '还没落盘的一句' });
  const idNew = store.getSnapshot().pendingUser[0].id;
  ok(left() === 1, '② 刚落、下标未知时先留着', '还剩 ' + left() + ' 颗');
  store.setHistory(SID, [U(ASK, 10), ...tools(7)]);
  ok(left() === 1, '③ 历史没变时不许乱撤', '还剩 ' + left() + ' 颗');

  /* ④ done.at 回来，下标对上 */
  store.setPendingRewind(idNew, 20);
  store.setHistory(SID, [U(ASK, 10), ...tools(7), U('还没落盘的一句', 20), A(8)]);
  ok(left() === 0, '④ 落盘下标对上就撤（改过字也认得出）', '还剩 ' + left() + ' 颗');

  /* ⑤ 同一句话连发两次：未落盘那颗不能被历史里同字的那句连坐 */
  store.setHistory(SID, [U('继续', 30), A(9)]);
  const id2 = store.pushPendingUser({ text: '继续' });
  ok(left() === 1, '⑤ 同字未落盘时先留着（不然第二句会先消失再冒出来）', '还剩 ' + left() + ' 颗');
  store.setPendingRewind(id2, 40);
  store.setHistory(SID, [U('继续', 30), A(9), U('继续', 40), A(10)]);
  ok(left() === 0, '⑥ 同字那句真落盘了才撤', '还剩 ' + left() + ' 颗');

  /* ⑦ 下标 0 是合法值（会话第一条）—— Number(null) === 0 的坑 */
  store.setHistory(SID, []);
  const id3 = store.pushPendingUser({ text: '第一句' });
  store.setPendingRewind(id3, 0);
  store.setHistory(SID, [U('第一句', 0), A(1)]);
  ok(left() === 0, '⑦ 落盘下标 0 也算对上', '还剩 ' + left() + ' 颗');

  /* ⑧ 上一版漏收留下的尸体：下标比历史里最后一句主人话还早 → 下一轮顺手清掉 */
  const id4 = store.pushPendingUser({ text: '很久以前那句' });
  store.setPendingRewind(id4, 5);
  store.setHistory(SID, [U('第一句', 0), A(1), U('后来那句', 30), A(2)]);
  ok(left() === 0, '⑧ 上一版漏收的尸体，下一轮清掉（不要求主人重启）', '还剩 ' + left() + ' 颗');

  /* ⑨ 收尾那一路也要收干净 */
  store.pushPendingUser({ text: '断线那句' });
  store.setHistory(SID, [U('第一句', 0), A(1), U('后来那句', 30), A(2), U('断线那句', 40)]);
  store.setLive(SID, null);
  ok(left() === 0, '⑨ 这一轮结束时 setLive(null) 不留气泡', '还剩 ' + left() + ' 颗');
}

/* ══════════════════════════════════════════════════════════════
 * 三、真机：跑一轮，数主人气泡
 * ══════════════════════════════════════════════════════════════ */
if (!process.env.XY_CDP_PORT) {
  console.log('\n真机格：SKIP（没有 XY_CDP_PORT，不是隔离实例；源码断言已跑完）');
} else {
  const { connect } = await import('../_t_cdp.mjs');
  const cdp = await connect({ port: Number(process.env.XY_CDP_PORT) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n三、真机：发一句话跑完 → 主人的话只许占一个气泡');

  const ready = async () => {
    try {
      const v = await cdp.eval('return { store: !!(window.__logStore && window.__logState), sid: String((window.__logState||{}).sid||""), page: String(window.sessionId||"") };');
      return !!(v && v.store && v.sid && v.sid === v.page);
    } catch (e) { return false; }
  };
  let up = false;
  for (let i = 0; i < 80; i++) { if (await ready()) { up = true; break; } await sleep(250); }
  ok(up, '页面 store 就绪（__logState.sid 有值）');

  if (up) {
    /**
     * 【2026-11-10 加·每次新建一个会话再发】
     *
     * 原来直接用当前会话发，断言「盘上 1 条 / 屏幕 1 颗」——
     * 只要这个会话之前跑过就必然假红（历史里本来就有好几条 user）。
     * 回归里同一实例反复跑、或者人手动点过几次，都会命中。
     *
     * 新建会话 + 只发一句 = 「双画」这个 bug 才有唯一确定的判据。
     * 用完把这个会话删掉，不给别人留垃圾。
     */
    const madeSid = await cdp.eval(`return (async function(){
      try {
        var r = await fetch('/api/sessions/new', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title: '__dedupe_check__' }) });
        var j = await r.json();
        var id = (j && j.session && j.session.id) || '';
        if (id && typeof window.switchSession === 'function') { await window.switchSession(id); }
        return id;
      } catch (e) { return ''; }
    })()`);
    ok(!!madeSid, '新建了一个干净会话（只发一句才判得准）', String(madeSid));
    await sleep(1200);

    const P = '就用一句话回我：收到。';
    await cdp.eval('window.__t = window.runTurn({ text: ' + JSON.stringify(P) + ' }); return 1;').catch(() => {});
    let done = false;
    for (let i = 0; i < 240; i++) {
      const b = await cdp.eval('return !!window.busy;').catch(() => true);
      if (!b && i > 8) { done = true; break; }
      await sleep(250);
    }
    ok(done, '这一轮跑完了（busy 变 false）');
    await sleep(3000);   // 等 settleFromHistory 落定

    const r = await cdp.eval(`return (function(){
      var lg = document.getElementById('log');
      var nrm = function(x){ return String(x || '').replace(/\\s+/g, ''); };
      var users = [].slice.call(lg.querySelectorAll('.msg.user')).map(function(m){
        return nrm((m.querySelector('.bubble') || {}).textContent);
      });
      var turns = (window.__logState.turns || []);
      var diskUsers = turns.filter(function(t){ return t && t.role === 'user'; }).map(function(t){ return nrm(t.text); });
      /* 本次刚发的那句话，在屏幕与历史里各出现几次？这才是「有没有双画」的判据。 */
      var mine = nrm(${JSON.stringify(P)});
      var screenMine = users.filter(function(u){ return u === mine; }).length;
      var diskMine = diskUsers.filter(function(u){ return u === mine; }).length;
      return {
        userCount: users.length,
        users: users.map(function(u){ return u.slice(0, 24); }),
        diskUser: diskUsers[0] || '',
        diskUserCount: diskUsers.length,
        screenMine: screenMine,
        diskMine: diskMine,
      };
    })();`);

    console.log('    屏幕上主人气泡 ' + r.userCount + ' 个：' + JSON.stringify(r.users));
    console.log('    盘上主人消息 ' + r.diskUserCount + ' 条');
    console.log('    本次那句话 → 屏幕 ' + r.screenMine + ' 次 / 盘上 ' + r.diskMine + ' 次');
    /**
     * 【2026-11-10 判据修正·原来这条会假红】
     *
     * 本脚本**不新建会话**，直接在当前会话里发一句。原来断言「盘上只有 1 条
     * 主人消息 / 屏幕恰好 1 颗」—— 只要这个会话之前跑过（回归里同一实例
     * 反复跑、或人手动点过几次），历史里就有好几条 user，屏幕上自然也有好几颗。
     * 那不是双画，是**本来就说了好几句话**。
     *
     * 真正要抓的 bug 只有一个：**同一句话被画了两遍**。
     * 所以判据改成「本次这句在屏幕上的次数 == 它在历史里的次数」，且不多于 1。
     */
    ok(r.diskMine === 1, '本次那句话在盘上只有 1 条', '实际 ' + r.diskMine);
    ok(r.screenMine === r.diskMine, '本次那句话在屏幕上的次数 == 盘上次数（没多画）',
      '屏幕 ' + r.screenMine + ' / 盘上 ' + r.diskMine + '（屏幕共 ' + r.userCount + ' 颗）');
    ok(r.screenMine <= 1, '本次那句话没有在屏幕上留成两颗', '实际 ' + r.screenMine + ' 颗');
    ok(r.users.slice(-1)[0] === String(r.diskUser).slice(0, 24) || !r.diskUser,
      '屏幕上最后那颗气泡的文字与盘上首条对得上（没串、没截）',
      '气泡 ' + (r.users.slice(-1)[0] || '') + ' / 盘上 ' + String(r.diskUser).slice(0, 24));

    /* 临时会话用完就删（主人的规矩），不留垃圾给别人 */
    if (madeSid) {
      try {
        await cdp.eval(`return (async function(){
          try { await fetch('/api/sessions/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: ${JSON.stringify(madeSid)} }) }); } catch(e){}
          return 1;
        })()`);
        console.log('    · 临时会话 ' + String(madeSid).slice(0, 12) + ' 已删');
      } catch (e) { /* 删不掉不影响断言 */ }
    }
  }
  try { cdp.close(); } catch {}
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);