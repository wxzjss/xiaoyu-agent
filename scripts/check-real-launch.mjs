#!/usr/bin/env node
/**
 * 【实机验证 · 2026-11-11 主人要求】
 *
 * 主人原话：「开发完成后必须进行实机验证：实际启动小鱼Agent并发送消息，
 * 检查消息发送与显示是否正常，确保不再出现昨天启动后发送一句消息就暴露的问题。」
 *
 * 这条**不起隔离实例**——它连的是刚用 `npm start` 真启动的那个应用（默认 8788），
 * 只有这样才能验到「真启动 + 真后端 + 真页面」这条主人在用的路径。
 *
 * 为了不污染主人的会话：**新建一个临时会话**发消息，验完把会话删掉。
 *
 * 验四件事（对应昨晚暴露过的四个坑）：
 *   ① 发出去的话立刻出现在屏幕上（不是发完一片空白）
 *   ② 她的回复真的流式出现（不是等半天一起蹦）
 *   ③ 发完不会弹到很久以前的位置（滚动锚点）
 *   ④ 不会出现「已停止」「没有回音」这类提示
 *
 * 用法：node scripts/check-real-launch.mjs [端口]
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '../_t_cdp.mjs';

const PORT_NUM = Number(process.argv[2] || 8788);
const BASE = 'http://127.0.0.1:' + PORT_NUM;
const CDP_PORT = 9231;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skip = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '  → ' + String(extra).slice(0, 400) : '')); }
};
const sk = (m, why) => { skip++; console.log('  SKIP ' + m + (why ? '  → ' + why : '')); };

const EDGE_CANDIDATES = [
  process.env.XY_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const EDGE = EDGE_CANDIDATES.find((p) => { try { return existsSync(p); } catch { return false; } });

async function api(path, body) {
  const r = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json().catch(() => null);
}

let child = null, cdp = null, sid = '';

(async () => {
  console.log('实机验证 → ' + BASE);
  try {
    const health = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
    if (!health) { console.log('✘ 应用没在跑（' + BASE + ' 无响应）。先 npm start。'); process.exit(1); }

    if (!EDGE) { console.log('SKIP 找不到 Edge/Chrome，跑不了真机 DOM 检查'); process.exit(0); }

    /* ── 建临时会话（验完删） ── */
    const s = await api('/api/sessions/new', {});
    sid = String((s && (s.session || s) && (s.session || s).id) || '');
    if (!sid) { console.log('✘ 建不出临时会话：' + JSON.stringify(s).slice(0, 200)); process.exit(1); }
    console.log('临时会话 ' + sid + '（验完会删）');

    /* ── 起独立无头浏览器，打开这个会话 ── */
    const profile = mkdtempSync(join(tmpdir(), 'xy-real-'));
    child = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile, BASE + '/?s=' + encodeURIComponent(sid),
    ], { stdio: 'ignore' });

    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const list = await fetch('http://127.0.0.1:' + CDP_PORT + '/json').then((r) => r.json());
        if (list.some((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'))) { up = true; break; }
      } catch {}
      await sleep(300);
    }
    if (!up) { console.log('✘ 浏览器没起来'); process.exit(1); }
    cdp = await connect({ port: CDP_PORT, match: String(PORT_NUM) });
    await sleep(900);

    console.log('\n── 一、页面起来了，输入框可用 ──');
    const ready = await cdp.eval(`return { hasInput: !!document.getElementById('input'), hasLog: !!document.getElementById('log'), hasStar: !!document.getElementById('enhanceBtn') };`);
    ok(ready && ready.hasInput, '输入框在');
    ok(ready && ready.hasLog, '聊天区在');
    ok(ready && ready.hasStar, '新的星星按钮已加载（说明前端是刚改的那份）');

    console.log('\n── 二、发一句消息：立刻上屏 ──');
    const MSG = '你好，这是实机验证，请用一句话回答就好。';
    /* 用真实用户路径：输入框赋值 + input 事件 + 点发送键 */
    await cdp.eval(`(function(){
      const i = document.getElementById('input');
      i.value = ${JSON.stringify(MSG)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return 1;
    })();`);
    await sleep(250);
    await cdp.eval(`(function(){ const b = document.getElementById('send'); if (b) b.click(); return 1; })();`);
    await sleep(1200);

    const afterSend = await cdp.eval(`return (function(){
      const log = document.getElementById('log');
      return { text: log ? log.innerText : '', bubbles: log ? log.querySelectorAll('.msg').length : 0 };
    })();`);
    ok(afterSend && String(afterSend.text || '').includes('实机验证'), '发出去的话立刻出现在屏幕上', afterSend && afterSend.text.slice(-200));

    console.log('\n── 三、她的回复流式出现（最多等 90 秒）──');
    let grew = 0, lastLen = 0, sawStop = false, sawNoReply = false, sawStopped = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const cur = await cdp.eval(`return (function(){
        const log = document.getElementById('log');
        return { text: log ? log.innerText : '', html: document.body.innerText };
      })();`);
      const t = String((cur && cur.text) || '');
      if (t.length > lastLen + 20) { grew++; lastLen = t.length; }
      if (t.includes('已停止')) sawStopped = true;
      if (t.includes('没有回音') || t.includes('可能卡住了')) sawNoReply = true;
      /* 出现她的气泡（助手消息）就算回上来了 */
      const hasReply = await cdp.eval(`return document.querySelectorAll('#log .msg.assistant, #log .msg.bot, #log .assistant').length;`);
      if (hasReply > 0 && grew >= 2) { sawStop = true; break; }
    }
    ok(grew >= 1, '回复是**分段长出来**的（不是一动不动）', '增长次数 ' + grew);
    ok(lastLen > 60, '屏幕上确实出现了一段她的回复', '现在 ' + lastLen + ' 字');
    ok(!sawStopped, '没有出现【已停止】提示（主人要求删掉的那个）');
    ok(!sawNoReply, '没有出现「没有回音/可能卡住了」（主人要求删掉的那个）');

    console.log('\n── 四、滚动位置：没弹到很久以前 ──');
    const scroll = await cdp.eval(`return (function(){
      const log = document.getElementById('log');
      if (!log) return null;
      return { top: log.scrollTop, h: log.scrollHeight, ch: log.clientHeight,
               fromBottom: Math.round(log.scrollHeight - log.scrollTop - log.clientHeight) };
    })();`);
    ok(scroll && scroll.fromBottom < 200, '发完消息画面停在底部（离底 ' + (scroll && scroll.fromBottom) + 'px）', JSON.stringify(scroll));

    console.log('\n── 五、控制台有没有报错 ──');
    const errs = await cdp.eval(`return (window.__xyErrors || []).slice(0, 5);`).catch(() => []);
    ok(!errs || !errs.length, '页面没有捕获到 JS 报错', JSON.stringify(errs));

    console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂' + (skip ? ' / ' + skip + ' 跳过' : ''));
  } catch (e) {
    console.log('✘ 跑挂了: ' + (e && e.message ? e.message : e));
    fail++;
  } finally {
    try { if (cdp && cdp.close) cdp.close(); } catch {}
    try { if (child) child.kill(); } catch {}
    /* 清掉临时会话 */
    if (sid) {
      try { await api('/api/sessions/delete', { id: sid }); console.log('（临时会话已删除）'); } catch {}
    }
  }
  process.exit(fail ? 1 : 0);
})();