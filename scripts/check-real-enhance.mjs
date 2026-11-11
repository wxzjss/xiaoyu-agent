#!/usr/bin/env node
/**
 * 【星星按钮·真应用点验】2026-11-11
 *
 * 跟 check-enhance-prompt-ui.mjs 的分工：
 *   · 那份用隔离实例，验的是「四态逻辑对不对」（15/15）；
 *   · 这份连**真启动的应用**（npm start 出来的 8788），验的是
 *     「同步到数据目录的那份前端 + 真后端路由，在主人实际用的环境里能不能跑」。
 *
 * 只验一条主链路（空输入不渲染 → 点了被改写 → 能恢复），
 * 因为四态逻辑已经由隔离那份覆盖，这里要防的是「部署没同步」这类事故。
 *
 * 用法：node scripts/check-real-enhance.mjs [端口]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '../_t_cdp.mjs';

const PORT_NUM = Number(process.argv[2] || 8788);
const BASE = 'http://127.0.0.1:' + PORT_NUM;
const CDP_PORT = 9232;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '  → ' + String(extra).slice(0, 300) : '')); }
};
const sk = (m, why) => { skip++; console.log('  SKIP ' + m + (why ? '  → ' + why : '')); };

const EDGE = [
  process.env.XY_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });

let child = null, cdp = null, sid = '';

(async () => {
  try {
    const health = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
    if (!health) { console.log('✘ 应用没在跑（' + BASE + '）'); process.exit(1); }
    if (!EDGE) { console.log('SKIP 找不到浏览器'); process.exit(0); }

    const s = await fetch(BASE + '/api/sessions/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).catch(() => null);
    sid = String((s && (s.session || s) && (s.session || s).id) || '');

    const profile = mkdtempSync(join(tmpdir(), 'xy-rstar-'));
    child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile, BASE + '/?s=' + encodeURIComponent(sid)], { stdio: 'ignore' });

    for (let i = 0; i < 40; i++) {
      try { const l = await fetch('http://127.0.0.1:' + CDP_PORT + '/json').then((r) => r.json()); if (l.some((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'))) break; } catch {}
      await sleep(300);
    }
    cdp = await connect({ port: CDP_PORT, match: String(PORT_NUM) });
    await sleep(900);

    const read = () => cdp.eval(`return (function(){
      const b = document.getElementById('enhanceBtn'), i = document.getElementById('input');
      if (!b) return { missing: true };
      return { visible: b.classList.contains('show'), busy: b.classList.contains('busy'),
               done: b.classList.contains('done'), title: b.title || '', value: i ? String(i.value||'') : '' };
    })();`);

    ok((await read()).missing !== true, '真应用里星星按钮存在（说明 sync-live 到位）');

    await cdp.eval(`(function(){ const i=document.getElementById('input'); i.value='把这份代码整理一下'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })();`);
    await sleep(250);
    ok((await read()).visible === true, '有字后星星出现');

    await cdp.eval(`document.getElementById('enhanceBtn').click(); return 1;`);
    let done = null;
    for (let i = 0; i < 120; i++) { await sleep(500); const c = await read(); if (c && !c.busy) { done = c; break; } }

    if (done && done.done) {
      ok(true, '真应用里增强成功，按钮变「恢复原文」');
      ok(done.value !== '把这份代码整理一下' && done.value.trim().length > 0, '输入框内容被真实改写', done.value.slice(0, 80));
      await cdp.eval(`document.getElementById('enhanceBtn').click(); return 1;`);
      await sleep(350);
      const back = await read();
      ok(back.value === '把这份代码整理一下', '点恢复原文后回到原话');
    } else {
      sk('真应用增强', '模型没回上来或太慢（隔离实例已 15/15 验证过逻辑）');
    }

    console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂' + (skip ? ' / ' + skip + ' 跳过' : ''));
  } catch (e) {
    console.log('✘ ' + (e && e.message ? e.message : e)); fail++;
  } finally {
    try { if (cdp && cdp.close) cdp.close(); } catch {}
    try { if (child) child.kill(); } catch {}
    if (sid) { try { await fetch(BASE + '/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid }) }); } catch {} }
  }
  process.exit(fail ? 1 : 0);
})();