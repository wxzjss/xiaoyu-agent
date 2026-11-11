#!/usr/bin/env node
/**
 * askApproval 真弹窗 · 端到端回归（2026-11-11）
 *
 * 【为什么要有这个】
 * 2026-11-10 三方审计抓到：`askApproval`（危险动作弹窗问主人）**从来没被注入**
 * —— ui-guard 里调 `exec.askApproval`，全仓没有任何一方提供这个函数。
 * 于是所有 needAsk=true 的操作都走「主人没有点头」分支，还报绿 ✓。
 * 注入修好之后，这条链路必须真机验一遍，不能只靠单元断言：
 *
 *   危险动作 → SSE ask_approval → 前端弹确认框 → 主人点允许/不许
 *   → POST /api/ask-approval → 工具继续执行 / 返回红 ✗
 *
 * 【怎么做到不碰主人的桌面 + 走真实用户路径】
 * 起隔离实例（_test-instance.mjs），自己 spawn 一个空白记事本当靶子。
 * **消息从浏览器页面里发**（往 #input 塞字 + 回车）—— 前端自己持有 SSE 流，
 * ask_approval 才会真的走到弹窗；脚本从旁边只做两件事：CDP 点确认框、
 * 用 /api/chat/live 断言工具结果。ui_observe 只看靶子记事本（hwnd 是测试查的），
 * ui_key 按的是 ctrl+delete —— 命中 DANGER_KEYS_EN（needAsk），
 * 点「不许」什么都没发生；点「允许」也只往空记事本按一下，无害。
 *
 * 跑法：node scripts/check-ask-approval.mjs   （要网络 + 模型配置，比较慢）
 */
import { spawn, execFile } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startIsolated } from './_test-instance.mjs';
import { connect as cdpConnect } from '../_t_cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log('  [ok] ' + m + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  [FAIL] ' + m + (detail ? '   ' + detail : '')); }
};

/* ---- 记事本靶子 ---- */

async function findNotepad() {
  const ps = (cmd) => new Promise((res) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true }, (e, so) => res(e ? '' : String(so || '').trim()));
  });
  for (let i = 0; i < 20; i++) {
    const out = await ps(`Get-Process -Name notepad -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.MainWindowHandle)" }`);
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (m && Number(m[2]) > 0) return { pid: Number(m[1]), hwnd: Number(m[2]) };
    }
    await sleep(500);
  }
  return null;
}

function killNotepad(pid) {
  if (!pid) return;
  try { spawn('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
}

/* ---- CDP 助手 ---- */

async function cdpTry(cdp, expr) {
  try { return await cdp.eval(expr); } catch { return undefined; }
}

/* ⚠ cdp.eval 会把表达式包进 (async () => { ... })()，**不自动 return** ——
 * 里头必须自己写 return，不然永远拿到 undefined（第一版就栽在这）。 */

/* 把还开着的旧确认框按「不许」收掉 —— 不然新一轮的弹窗出不来 / 会点错框 */
async function cdpDismissStale(cdp) {
  for (let i = 0; i < 12; i++) {
    const v = await cdpTry(cdp, `return (function(){
      const d = document.getElementById('confirmDlg');
      if (!d || !d.open) return 'closed';
      const c = document.getElementById('confirmCancel');
      if (c) c.click();
      return 'dismissed';
    })()`);
    if (v === 'closed') return;
    await sleep(400);
  }
}

/* 等确认框弹出来；wantClickOk=true 点「允许」，false 点「不许」。
 * 返回 'clicked:标题' / 'timeout'。弹窗最长等 90 秒（前端拿到事件有延迟）。 */
async function cdpWaitDialogAndClick(cdp, wantClickOk) {
  for (let i = 0; i < 225; i++) {
    const v = await cdpTry(cdp, `return (function(){
      const d = document.getElementById('confirmDlg');
      if (!d || !d.open) return 'closed';
      const t = (document.getElementById('confirmTitle')||{}).textContent || '';
      if (!/她要动/.test(t)) return 'closed';
      const b = document.getElementById(${wantClickOk ? "'confirmOk'" : "'confirmCancel'"});
      if (!b) return 'nobtn';
      b.click();
      return 'clicked:' + t;
    })()`);
    if (typeof v === 'string' && v.startsWith('clicked:')) return v;
    await sleep(400);
  }
  return 'timeout';
}

/* 从浏览器页面把话发出去（真实用户路径：#input + 回车） */
async function pageSend(cdp, text) {
  const v = await cdpTry(cdp, `return (function(){
    const inp = document.getElementById('input');
    if (!inp) return 'no-input';
    inp.value = ${JSON.stringify(text)};
    inp.focus();
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    return 'sent';
  })()`);
  return v;
}

/* 这一轮的 sessionId：发完立刻问 /api/running */
async function grabSessionId(base) {
  for (let i = 0; i < 40; i++) {
    try {
      const j = await fetch(base + '/api/running').then((r) => r.json());
      const list = (j && j.running) || [];
      if (list.length) return list[0].sessionId;
    } catch {}
    await sleep(500);
  }
  return null;
}

/* 等 live 事件流里出现 ui_key 的 tool_end（/api/chat/live 的 events 是原始事件，type/name/ok/output） */
async function waitUiKeyDone(base, sid, maxMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const lv = await fetch(base + '/api/chat/live?sessionId=' + encodeURIComponent(sid)).then((r) => r.json());
      const evs = (lv && (lv.events || lv.items)) || [];
      const ends = evs.filter((e) => e && e.type === 'tool_end' && e.name === 'ui_key');
      if (ends.length) return ends;
    } catch {}
    await sleep(1000);
  }
  return [];
}

/* 等这一轮彻底收尾（running 里没了）—— 下一轮要等空闲才能发 */
async function waitTurnEnd(base, sid, maxMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const j = await fetch(base + '/api/running').then((r) => r.json());
      const list = (j && j.running) || [];
      if (!list.some((x) => x.sessionId === sid)) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

/* ---- 主流程 ---- */

const iso = await startIsolated({ appPort: 8795, cdpPort: 9223 });
let np = null;
try {
  console.log('隔离实例：' + iso.base);

  /* 操作桌面必须在功能面板里开着（defaultOn=false，主人那份 features.json 里未必开着） */
  const featPath = join(iso.dataDir, '.state', 'features.json');
  let feats = {};
  try { if (existsSync(featPath)) feats = JSON.parse(readFileSync(featPath, 'utf8')); } catch {}
  feats.desktopHands = true;
  writeFileSync(featPath, JSON.stringify(feats));
  /* 白名单清空 = 不限窗口（主人的 settings.json 可能限了别的名单） */
  const setPath = join(iso.dataDir, '.state', 'settings.json');
  let st = {};
  try { if (existsSync(setPath)) st = JSON.parse(readFileSync(setPath, 'utf8')); } catch {}
  st.uiAllowedApps = [];
  writeFileSync(setPath, JSON.stringify(st));

  np = await findNotepad();
  if (!np) {
    spawn('notepad.exe', [], { stdio: 'ignore', detached: false });
    np = await findNotepad();
  }
  if (!np) throw new Error('记事本靶子没起来（没查到带主窗口的 notepad 进程）');
  console.log('靶子记事本：pid=' + np.pid + ' hwnd=' + np.hwnd);

  await sleep(1500);
  const cdp = await cdpConnect({ port: iso.cdpPort, match: iso.base });

  /* 刷新一次页面，确保跑的是当前仓库的 index.html */
  try {
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(9000);
  } catch {}
  const hasInput = await cdpTry(cdp, `return !!document.getElementById('input')`);
  if (!hasInput) throw new Error('页面上没有 #input（页面没就绪？）');

  const PROMPT = '请按顺序做这两件事，别做别的，做完用一句话汇报：'
    + '1) 调用 ui_observe 工具，hwnd 参数填 ' + np.hwnd + '；'
    + '2) 调用 ui_key 工具，keys 参数填 ctrl+delete。';

  /* ===== 第一轮：弹窗 → 点「不许」→ 工具必须红 ✗ 且没按 ===== */
  console.log('\n=== 1. 点「不许」===');
  await cdpDismissStale(cdp);
  const sent1 = await pageSend(cdp, PROMPT);
  ok(sent1 === 'sent', '从浏览器页面把消息发了出去', String(sent1));
  const sid = await grabSessionId(iso.base);
  ok(Boolean(sid), '拿到这一轮的 sessionId', String(sid));

  const dlg1 = await cdpWaitDialogAndClick(cdp, false);
  ok(dlg1.startsWith('clicked:'), '前端真弹了确认框，点掉了「不许」', String(dlg1).slice(0, 60));
  const tools1 = await waitUiKeyDone(iso.base, sid);
  ok(tools1.length > 0, 'live 事件流里有 ui_key 的 tool_end', tools1.length + ' 条');
  ok(tools1.some((t) => t.ok === false && /✗|没动/.test(String(t.output || ''))),
    '点不许后 ui_key 返回红 ✗（没按）',
    tools1.map((t) => 'ok=' + t.ok + ' out=' + String(t.output || '').slice(0, 40)).join(' | '));
  await waitTurnEnd(iso.base, sid);
  await cdpDismissStale(cdp);

  /* ===== 第二轮：弹窗 → 真浏览器里点「允许」→ 工具执行 ===== */
  console.log('\n=== 2. 点「允许」===');
  const sent2 = await pageSend(cdp, PROMPT);
  ok(sent2 === 'sent', '第二轮消息发出', String(sent2));
  const sid2 = await grabSessionId(iso.base);
  ok(Boolean(sid2), '第二轮拿到 sessionId', String(sid2));

  const dlg2 = await cdpWaitDialogAndClick(cdp, true);
  ok(dlg2.startsWith('clicked:'), '确认框弹出且点掉了「允许」', String(dlg2).slice(0, 60));
  const tools2 = await waitUiKeyDone(iso.base, sid2);
  ok(tools2.some((t) => t.ok === true || /按了/.test(String(t.output || ''))),
    '点允许后 ui_key 真的执行了（ok / 「按了 ctrl+delete」）',
    tools2.map((t) => 'ok=' + t.ok + ' out=' + String(t.output || '').slice(0, 40)).join(' | '));
  await waitTurnEnd(iso.base, sid2);

  console.log('\n────────────────────────────────');
  if (!fail) { console.log('断言：' + pass + '/' + pass + '   全部通过'); console.log('PASS askApproval 链路真机全通'); }
  else { console.log('断言：' + pass + '/' + (pass + fail) + '   有失败'); process.exitCode = 1; }
} catch (e) {
  console.error('[check-ask-approval] ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  killNotepad(np && np.pid);
  await iso.stop();
}
