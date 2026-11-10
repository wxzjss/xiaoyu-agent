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
 *   ① 真机：发一句话跑完，`.msg.user` 恰好 1 个（盘上也只有 1 条）
 *   ② 真机：那一颗主人气泡的文字 == 盘上那条（没串、没截）
 *   ③ 源码：`logSetHistory` 必须把写入交给 store（否则 dropLandedPending 永远不跑）
 *      判据不看函数名，看**行为**：`__logStore.setHistory` 在生产代码里必须被调用
 *
 * 用法：node scripts/check-pending-user-dedupe.mjs [--public public]
 * 需要隔离实例（XY_CDP_PORT）；没有就只跑源码那一条。
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
 * 二、真机：跑一轮，数主人气泡
 * ══════════════════════════════════════════════════════════════ */
if (!process.env.XY_CDP_PORT) {
  console.log('\n真机格：SKIP（没有 XY_CDP_PORT，不是隔离实例；源码断言已跑完）');
} else {
  const { connect } = await import('../_t_cdp.mjs');
  const cdp = await connect({ port: Number(process.env.XY_CDP_PORT) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log('\n二、真机：发一句话跑完 → 主人的话只许占一个气泡');

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
      return {
        userCount: users.length,
        users: users.map(function(u){ return u.slice(0, 24); }),
        diskUser: nrm((turns.filter(function(t){ return t && t.role === 'user'; })[0] || {}).text),
        diskUserCount: turns.filter(function(t){ return t && t.role === 'user'; }).length,
      };
    })();`);

    console.log('    屏幕上主人气泡 ' + r.userCount + ' 个：' + JSON.stringify(r.users));
    console.log('    盘上主人消息 ' + r.diskUserCount + ' 条：' + JSON.stringify(String(r.diskUser).slice(0, 24)));
    ok(r.diskUserCount === 1, '盘上只有 1 条主人消息', '实际 ' + r.diskUserCount);
    ok(r.userCount === 1, '屏幕上主人气泡恰好 1 个（没被留成两颗）',
      '实际 ' + r.userCount + ' 个：' + JSON.stringify((r.users || []).map((u) => String(u).slice(0, 16))));
    ok(!!r.users[0] && r.users[0] === String(r.diskUser).slice(0, 24),
      '那唯一一颗气泡的文字 == 盘上那条（没串、没截）',
      '气泡 ' + (r.users[0] || '') + ' / 盘上 ' + String(r.diskUser).slice(0, 24));
  }
  try { cdp.close(); } catch {}
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);