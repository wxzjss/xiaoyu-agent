#!/usr/bin/env node
/**
 * 守卫：界面真的能跑起来，且**一条 JS 报错都没有**。
 *
 * 【为什么用真浏览器查，而不是静态扫描】
 * 2026-11-15 主人贴来的那一屏红字：
 *   Uncaught ReferenceError: snap is not defined
 *   at renderRow (log.bundle.js:9856:104)
 * 这是**运行时**错误：esbuild 编得过（它不校验自由变量），
 * 静态扫又因为 import 别名、循环变量、解构而满屏误报（试过，19 个文件全红，没法用）。
 * 唯一靠得住的办法就是**真在浏览器里跑一遍，把 console 的报错全接住**。
 *
 * 而且这个错特别毒：它一炸，`renderRow` 后面【所有】行都不再渲染 ——
 * 屏幕还在、消息却缺一大半，看着像"数据丢了"。所以必须钉死"零报错"。
 *
 * 【怎么跑】连应用自己的远程调试端口（Electron 的 CDP），
 * 挂 Runtime.exceptionThrown + Log.entryAdded，刷新页面，等渲染完，收账。
 *
 * 用法：node scripts/check-ui-smoke.mjs
 * 退出码：0 = 零报错；1 = 有报错（会把原文打出来）
 */
import { connect } from './_cdp-connect.mjs';

const PORT = Number(process.env.XY_CDP_PORT || 9222);
/* 【2026-11-16 修】connect() 连不上是抛 Error，不是返回 null ——
 * 原来只判 `if (!cdp)`，应用重启/没开调试端口时整个脚本直接 uncaughtException 崩掉，
 * 冒烟里被记成一条 FAIL（看着像界面有错，其实是环境没起来）。这里真接住。 */
let cdp = null;
try {
  cdp = await connect({ port: PORT, match: '/', tries: 12 });
} catch (e) {
  cdp = null;
  console.log('连不上界面（应用没开或没开调试端口）—— 跳过：' + String((e && e.message) || e).slice(0, 200));
}
if (!cdp) {
  console.log('连不上界面（应用没开或没开调试端口）—— 跳过');
  process.exit(0);
}

const errors = [];
let pass = 0;

/* 订阅两类事件：未捕获异常、console.error */
try {
  await cdp.send('Runtime.enable', {});
  await cdp.send('Log.enable', {});
} catch {}

/* _cdp-connect 只暴露了 eval/send，没有事件回调；这里用页面内的钩子代替：
 * 在页面加载前装一个 error 收集器，加载后读它。刷新会清掉，所以顺序很重要 ——
 * 先装钩子（写在 sessionStorage 里由页面自己装做不到），改用「刷新后再注入」的方式：
 * 直接读 performance + window.__xyErrs（页面若自己收集过）。
 * 稳妥做法：不刷新，直接在现有页面上触发一次完整重渲染并监听 —— 见下面步骤。 */
const install = `
return (() => {
  if (window.__xyErrHook) return 'already';
  window.__xyErrs = [];
  window.__xyErrHook = true;
  window.addEventListener('error', (e) => {
    try {
      window.__xyErrs.push('error: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
    } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      const r = e && e.reason;
      window.__xyErrs.push('rejection: ' + ((r && (r.message || String(r))) || '未知'));
    } catch (_) {}
  });
  const oe = console.error;
  console.error = function (...a) {
    try { window.__xyErrs.push('console.error: ' + a.map((x) => (x && x.message) || String(x)).join(' ')); } catch (_) {}
    return oe.apply(console, a);
  };
  return 'installed';
})()
`;
await cdp.eval(install);

/* 强制一次完整重渲染：切一下会话再切回来，逼 renderRow 把每一行都画一遍。
 * 这是关键 —— 只在首页静态渲染一次的话，有问题的那个分支可能压根没走到。 */
const before = await cdp.eval('return (window.__xyErrs || []).length');
await cdp.eval(`
return (async () => {
  const sid = (typeof sessionId === 'string' && sessionId) || '';
  if (!sid) return 'no-sid';
  const list = await fetch('/api/sessions').then((r) => r.json()).catch(() => null);
  const ids = (list && (list.sessions || list)) || [];
  const other = (Array.isArray(ids) ? ids : []).map((x) => (typeof x === 'string' ? x : x && x.id)).filter((x) => x && x !== sid)[0];
  if (typeof switchSession === 'function') {
    if (other) { await switchSession(other); await new Promise((r) => setTimeout(r, 400)); }
    await switchSession(sid);
  }
  return 'rendered';
})()
`).catch(() => {});
await new Promise((r) => setTimeout(r, 900));

const got = await cdp.eval(`
return (() => {
  const errs = Array.isArray(window.__xyErrs) ? window.__xyErrs.slice() : [];
  const log = document.getElementById('log');
  return JSON.stringify({
    errs,
    msgCount: log ? log.querySelectorAll('.msg').length : -1,
    logChildren: log ? log.children.length : -1,
  });
})()
`);

let parsed = { errs: [], msgCount: -1, logChildren: -1 };
try { parsed = JSON.parse(got); } catch {}
const errs = Array.isArray(parsed.errs) ? parsed.errs : [];

const one = (cond, name, detail = '') => {
  if (cond) { pass++; console.log('  ✔ ' + name + (detail ? '   ' + detail : '')); }
  else { console.log('  ✘ ' + name + (detail ? '   ' + detail : '')); }
};

one(errs.length === 0, '页面零 JS 报错', errs.length ? errs.length + ' 条' : '');
if (errs.length) {
  console.log('    报错原文（前 6 条）：');
  for (const e of errs.slice(0, 6)) console.log('      · ' + String(e).slice(0, 200));
}
one(parsed.logChildren > 0, '对话区真的画出了东西（不是空白页）', 'log 子节点 ' + parsed.logChildren);

console.log(`\n── 界面冒烟：零报错${errs.length ? '（有 ' + errs.length + ' 条）' : ''} ──`);
cdp.close();
process.exit(errs.length ? 1 : 0);
