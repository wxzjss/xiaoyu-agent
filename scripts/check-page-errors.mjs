#!/usr/bin/env node
/**
 * check-page-errors.mjs — 【真浏览器】页面加载 + 静置 6 秒，**一条 JS 报错都不许有**。
 *
 * 和 check-ui-smoke.mjs 的分工：
 *   · 那份连主人**正在用的应用**（CDP 9222，要 App 带调试端口起来）；
 *   · 这份自己拉一个 headless 浏览器打开页面，只要有服务在跑就能查，
 *     适合塞进日常回归（run-all-checks 的隔离实例直接就能跑）。
 *
 * 为什么要它：2026-11-15 主人报了
 *   ReferenceError: hint is not defined  at rwGo.onclick
 * —— 一个从来没声明过的自由变量，**那一行之后的代码全都不执行**。
 * esbuild/`node --check` 都不管（语法合法），静态扫又满屏误报。
 * 只有真在浏览器里跑一遍、把 window 的 error / unhandledrejection 全接住，才抓得准。
 *
 * 跑法：node scripts/check-page-errors.mjs [端口]
 *   端口默认跟着 XY_CHECK_PORT（隔离实例），没有就 8788。
 *   服务没起 / 找不到浏览器 → SKIP（退出码 0）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from './_cdp-connect.mjs';

const PORT_NUM = Number(process.argv[2] || process.env.XY_CHECK_PORT || 8788);
const BASE = 'http://127.0.0.1:' + PORT_NUM;
const CDP_PORT = Number(process.env.XY_CDP_PORT3 || 9256);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  process.env.XY_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + String(x).slice(0, 600) : '')); }
};

let child = null, cdp = null;
try {
  const health = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
  if (!health) { console.log('SKIP 页面报错检查：' + BASE + ' 没有服务在跑'); process.exit(0); }
  if (!EDGE) { console.log('SKIP 页面报错检查：找不到 Edge/Chrome'); process.exit(0); }

  const profile = mkdtempSync(join(tmpdir(), 'xy-pageerr-'));
  child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
    '--disable-background-timer-throttling', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, BASE + '/'], { stdio: 'ignore' });

  for (let i = 0; i < 40; i++) {
    try {
      const l = await fetch('http://127.0.0.1:' + CDP_PORT + '/json').then((r) => r.json());
      if (l.some((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'))) break;
    } catch {}
    await sleep(300);
  }
  cdp = await connect({ port: CDP_PORT, match: String(PORT_NUM) });

  /* 【关键】收集器必须**注入到每个新文档**，不能只在当前文档里挂 window 钩子：
   * 一 reload，当前文档连它的 __pageErrs 一起扔了 —— 那样「零报错」是假的
   * （第一版就栽在这儿：自检抛错也抓不到，说明收集器压根没在工作）。 */
  await cdp.send('Page.enable', {}).catch(() => {});
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__pageErrs = [];
      window.addEventListener('error', function (e) { window.__pageErrs.push('error: ' + (e && e.message)); });
      window.addEventListener('unhandledrejection', function (e) {
        var r = e && e.reason;
        window.__pageErrs.push('rejection: ' + String((r && (r.message || r)) || '未知')
          + (r && r.stack ? ' | ' + String(r.stack).split('\\n').slice(0, 3).join(' / ') : ''));
      });`,
  }).catch(() => {});
  await cdp.send('Page.reload', {}).catch(() => {});
  await sleep(6000);

  const errs = await cdp.eval('return window.__pageErrs || [];').catch(() => null);
  ok('页面能起来、能取到报错账本', Array.isArray(errs), errs);
  if (Array.isArray(errs)) {
    ok('加载 + 静置 6 秒：零 JS 报错', errs.length === 0, errs.slice(0, 5).join('  ||  '));
    /* 顺手抽一条「关键 UI 是真的挂上了」的证据，防止白页也算过 */
    const alive = await cdp.eval(`return {
      send: !!document.getElementById('send'),
      input: !!document.getElementById('input'),
      pending: !!document.getElementById('pendingQueue'),
      rows: (document.getElementById('log') || {}).childElementCount || 0,
    };`).catch(() => null);
    ok('关键节点都在（发送键 / 输入框 / 待发送容器）',
      alive && alive.send && alive.input && alive.pending, JSON.stringify(alive));

    /* 【负向自检】这个脚本要是收集器本身失灵，就会天天报「零报错」骗人。
     * 故意在一次 timer 里抛错（`window.onerror` 那条路），必须被接住 ——
     * 接不住就说明上面那条绿的不可信。（rejection 在 CDP 的 eval 里会被吞，
     * 试过抓不到，所以这里用 throw。） */
    await cdp.eval(`window.__pageErrs.length = 0; setTimeout(function () { throw new Error('self-test-error'); }, 0); return 1;`).catch(() => {});
    await sleep(600);
    const got = await cdp.eval('return (window.__pageErrs || []).length;').catch(() => 0);
    ok('收集器灵敏（故意抛一个错能抓到）', Number(got) >= 1, '抓到 ' + got + ' 条');
  }
} catch (e) {
  fail++;
  console.log('  [!!] 脚本自身出错：' + (e && e.message ? e.message : e));
} finally {
  try { if (cdp) cdp.close(); } catch {}
  try { if (child) child.kill(); } catch {}
  console.log('\n页面报错检查：' + pass + ' 过 / ' + fail + ' 挂');
  process.exit(fail ? 1 : 0);
}
