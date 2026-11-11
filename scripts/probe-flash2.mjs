#!/usr/bin/env node
/**
 * 【抓现场 v2】2026-11-11 主人要求「不要只猜，要实际看」。
 *
 * v1 已经抓到关键事实：消失前后 `turns / live.items` 数量都是 0 / 2 没变，
 * 但屏幕从 3 条掉到 1 条。这说明**数据没变，是渲染/状态层把内容丢了**。
 *
 * v2 补三件事，把「谁改的」钉死：
 *   ① 每 50ms 连拍，把「掉之前最后一帧」完整状态存下来
 *   ② 同时记录 buildMerged 的输出（items 条数、每条 kind/who/正文头）
 *   ③ 记录 renderLog 被调用的次数和调用栈（打桩，不改产品逻辑）
 *
 * 用法：node scripts/probe-flash2.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '../_t_cdp.mjs';

const PORT = 8788;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9234;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  process.env.XY_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });

let child = null, cdp = null, sid = '';

(async () => {
  try {
    const health = await fetch(BASE + '/api/health', { timeout: 4000 }).then((r) => r.json()).catch(() => null);
    if (!health) { console.log('✘ 应用没在跑'); process.exit(1); }
    if (!EDGE) { console.log('SKIP 没浏览器'); process.exit(0); }

    /* 建会话 + 先发一句建立历史 */
    const s = await fetch(BASE + '/api/sessions/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
    sid = String((s && s.session && s.session.id) || s.id || '');

    const profile = mkdtempSync(join(tmpdir(), 'xy-probe2-'));
    child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile, BASE + '/?s=' + encodeURIComponent(sid)], { stdio: 'ignore' });

    for (let i = 0; i < 40; i++) {
      try { const l = await fetch('http://127.0.0.1:' + CDP_PORT + '/json').then((r) => r.json()); if (l.some((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'))) break; } catch {}
      await sleep(300);
    }
    cdp = await connect({ port: CDP_PORT, match: String(PORT) });
    await sleep(1200);

    /* 打桩：记录 buildMerged 的每次输出 + renderLog 调用栈 */
    await cdp.eval(`(function(){
      window.__probe = { logs: [], renders: [] };
      /* 记录 LOG_STATE 的真实内容（React store 里的） */
      const snapOf = () => {
        try {
          const S = window.__logState || window.LOG_STATE || null;
          if (!S) return null;
          return {
            turns: Array.isArray(S.turns) ? S.turns.length : -1,
            liveItems: S.live && Array.isArray(S.live.items) ? S.live.items.length : -1,
            liveRunning: S.live ? S.live.running : null,
            pending: Array.isArray(S.pendingUser) ? S.pendingUser.length : -1,
          };
        } catch (e) { return { err: String(e && e.message) }; }
      };
      window.__probeSnap = snapOf;
      /* 劫持 renderLog，记调用栈（只记录，不影响原逻辑） */
      const orig = window.renderLog;
      if (typeof orig === 'function') {
        window.renderLog = function(...a){
          try { window.__probe.renders.push({ t: Date.now(), argsLen: a.length, stack: (new Error()).stack.split('\\n').slice(1,6).join(' | ') }); } catch(e){}
          return orig.apply(this, a);
        };
      }
      return 1;
    })();`);

    /* 第一句 */
    await cdp.eval(`(function(){
      const i = document.getElementById('input');
      i.value = '第一句话。';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send').click();
      return 1;
    })();`);
    for (let t = 0; t < 90; t++) {
      await sleep(1000);
      const done = await cdp.eval(`return !document.getElementById('stopBtn') || !document.getElementById('stopBtn').classList.contains('show');`);
      if (done) break;
    }
    await sleep(2000);

    /* 采样器：50ms 一帧，同时记 DOM + 状态 */
    const frame = () => cdp.eval(`return (function(){
      const log = document.getElementById('log');
      const msgs = log ? [...log.querySelectorAll('.msg')] : [];
      const bodies = msgs.map(m => {
        const b = m.querySelector('.bubble');
        return (b ? String(b.innerText || '') : '').replace(/\\s+/g,'').slice(0,16);
      });
      return { n: msgs.length, bodies, st: window.__probeSnap ? window.__probeSnap() : null };
    })();`);

    const samples = [];
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        try { samples.push({ t: Date.now(), ...(await frame()) }); } catch { break; }
        await sleep(50);
      }
    })();

    /* 第二句：采样期间发出去 */
    await cdp.eval(`(function(){
      const i = document.getElementById('input');
      i.value = '第二句话，请先说一句短的。';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send').click();
      return 1;
    })();`);

    await sleep(16000);
    stop = true;
    await sampler;

    /* 分析 */
    console.log('采样 ' + samples.length + ' 帧（50ms 一帧）');
    console.log('\n气泡数曲线:');
    let cur = samples.length ? samples[0].n : 0, run = 1;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].n === cur) { run++; continue; }
      process.stdout.write('  ' + cur + '×' + run + ' → ');
      cur = samples[i].n; run = 1;
    }
    console.log('  ' + cur + '×' + run);

    console.log('\n=== 所有下降点 ===');
    let found = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i-1], b = samples[i];
      if (b.n >= a.n) continue;
      found++;
      console.log('\n── 帧 ' + i + '（距开始 ' + Math.round((b.t - samples[0].t)) + 'ms）：' + a.n + ' → ' + b.n + ' ──');
      const lost = a.bodies.filter((x, idx) => b.bodies.indexOf(x) === -1);
      console.log('  消失: ' + JSON.stringify(lost));
      console.log('  掉前状态: ' + JSON.stringify(a.st));
      console.log('  掉后状态: ' + JSON.stringify(b.st));
      /* 掉之前的 5 帧状态，看有没有哪个字段先变 */
      console.log('  掉前 5 帧的 (n | turns, liveItems, running, pending):');
      for (let k = Math.max(0, i-5); k < i; k++) {
        const x = samples[k], st = x.st || {};
        console.log('    ' + x.n + ' | ' + st.turns + ', ' + st.liveItems + ', ' + st.liveRunning + ', ' + st.pending);
      }
      /* 掉之后的 3 帧 */
      console.log('  掉后 3 帧:');
      for (let k = i; k < Math.min(samples.length, i+3); k++) {
        const x = samples[k], st = x.st || {};
        console.log('    ' + x.n + ' | ' + st.turns + ', ' + st.liveItems + ', ' + st.liveRunning + ', ' + st.pending);
      }
      if (found >= 3) break;
    }
    if (!found) console.log('  （这次没抓到）');

    /* renderLog 调用记录 */
    const renders = await cdp.eval(`return (window.__probe && window.__probe.renders) ? window.__probe.renders.slice(-8) : [];`);
    console.log('\n=== 最后 8 次 renderLog 调用（谁调的） ===');
    for (const r of (renders || [])) console.log('  ' + JSON.stringify(r.stack).slice(0, 220));
  } catch (e) {
    console.log('✘ ' + (e && e.message ? e.message : e));
  } finally {
    try { if (cdp && cdp.close) cdp.close(); } catch {}
    try { if (child) child.kill(); } catch {}
    if (sid) { try { await fetch(BASE + '/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid }) }); } catch {} }
  }
  process.exit(0);
})();