#!/usr/bin/env node
/**
 * 【抓现场】2026-11-11 主人报「发消息后还是会消失一下再冒出来」。
 *
 * 我前两次都是靠读代码猜根因，两次都猜错（改完还是闪）。
 * 这次不猜了 —— 用 CDP 每 100ms 采一次 DOM，把「闪的那一帧」到底少了什么记下来。
 *
 * 记录四件事：
 *   · 气泡数量（.msg 节点数）随时间的变化
 *   · 每次变化时，哪些气泡消失了（按正文前 20 字比对）
 *   · LOG_STATE 里的 turns / live.items 长度
 *   · pendingUser 长度
 *
 * 用法：node scripts/probe-flash.mjs [会话标题关键字]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '../_t_cdp.mjs';

const PORT = 8788;
const BASE = 'http://127.0.0.1:' + PORT;
const CDP_PORT = 9233;
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

    /** 建一个干净会话，避免历史干扰 */
    const s = await fetch(BASE + '/api/sessions/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
    sid = String((s && s.session && s.session.id) || s.id || '');
    console.log('临时会话 =', sid);

    const profile = mkdtempSync(join(tmpdir(), 'xy-probe-'));
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

    /* 先发第一句，让屏幕上有历史 */
    console.log('\n=== 第一句（建立历史）===');
    await cdp.eval(`(function(){
      const i = document.getElementById('input');
      i.value = '第一句话，请简短回一句就好。';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send').click();
      return 1;
    })();`);

    /* 等这一轮跑完 */
    for (let t = 0; t < 120; t++) {
      await sleep(1000);
      const done = await cdp.eval(`return !document.getElementById('stopBtn') || !document.getElementById('stopBtn').classList.contains('show');`);
      if (done) break;
    }
    await sleep(1500);

    /* ===== 开始采样：发第二句，每 100ms 记一次 ===== */
    console.log('\n=== 第二句（采样开始）===');
    const snap = () => cdp.eval(`return (function(){
      const log = document.getElementById('log');
      const msgs = log ? [...log.querySelectorAll('.msg')] : [];
      const bodies = msgs.map(m => {
        const b = m.querySelector('.bubble');
        return (b ? String(b.innerText || '') : '').replace(/\\s+/g, '').slice(0, 20);
      });
      let st = null;
      try {
        const S = window.__logState || window.LOG_STATE || null;
        if (S) st = { turns: (S.turns||[]).length, live: S.live ? (S.live.items||[]).length : null };
      } catch (e) {}
      return {
        n: msgs.length,
        bodies,
        st,
        pending: (function(){ try { return (window.__pendingUserCount || null); } catch(e){ return null; } })(),
      };
    })();`);

    const samples = [];
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        try { samples.push({ t: Date.now(), ...(await snap()) }); } catch { break; }
        await sleep(100);
      }
    })();

    await cdp.eval(`(function(){
      const i = document.getElementById('input');
      i.value = '第二句话，先说一句短的再说完。';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('send').click();
      return 1;
    })();`);

    await sleep(14000);
    stop = true;
    await sampler;

    /* ===== 分析：找出「数量下降」的那一帧 ===== */
    console.log('\n采样 ' + samples.length + ' 帧（100ms 一帧）');
    let drops = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      if (b.n >= a.n) continue;
      drops++;
      console.log('\n── 第 ' + i + ' 帧：气泡 ' + a.n + ' → ' + b.n + '（少了 ' + (a.n - b.n) + ' 条）──');
      console.log('  掉之前:', JSON.stringify(a.bodies));
      console.log('  掉之后:', JSON.stringify(b.bodies));
      const lost = a.bodies.filter((x, idx) => !b.bodies.includes(x));
      console.log('  **消失的**:', JSON.stringify(lost));
      console.log('  状态前: turns=' + (a.st?a.st.turns:'?') + ' live=' + (a.st?a.st.live:'?'));
      console.log('  状态后: turns=' + (b.st?b.st.turns:'?') + ' live=' + (b.st?b.st.live:'?'));
      if (drops >= 4) break;
    }
    console.log('\n下降帧总数 = ' + drops + (drops ? '' : '（这次没抓到，可能时机不对）'));

    /* 打印数量曲线 */
    const curve = samples.map((x) => x.n).join(',');
    console.log('\n气泡数曲线: ' + curve);
  } catch (e) {
    console.log('✘ ' + (e && e.message ? e.message : e));
  } finally {
    try { if (cdp && cdp.close) cdp.close(); } catch {}
    try { if (child) child.kill(); } catch {}
    if (sid) { try { await fetch(BASE + '/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid }) }); } catch {} }
  }
  process.exit(0);
})();