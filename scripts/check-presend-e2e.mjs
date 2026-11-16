#!/usr/bin/env node
/**
 * check-presend-e2e.mjs — 【真浏览器】插话预发送的六个场景，一个个点过去。
 *
 * 主人 2026-11-15 要的行为：
 *   ① 新增预发送：她在跑时点【发送】→ 不立刻发，进「待发送」队列
 *   ② 轮次结束后自动发送：她不忙了 → 队列自己放行
 *   ③ 预发送阶段「直接发送」：立刻插进去
 *   ④ 编辑：把那条搬回输入框、出队
 *   ⑤ 删除：直接没了，不复活
 *   ⑥ 回车不受影响：在跑时按回车仍然是**直接插话**，不进队列
 *
 * 跑法：node scripts/check-presend-e2e.mjs [端口]
 *   应用没起 / 找不到浏览器 → SKIP（不判红：run-all-checks 里通常没起应用）
 *
 * 不碰真模型：busy 是伪造的，fetch 只把 /api/interject 换成假的记账，
 * 其余请求照原样走。所以这个脚本不花钱、不写脏数据。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from './_cdp-connect.mjs';

/* 【端口】run-all-checks 跑的是隔离实例（XY_CHECK_PORT，默认 8950）——
 * 有它就跟着它走，别去操作主人正开着的 8788。手动跑的时候不设变量就是 8788。 */
const PORT_NUM = Number(process.argv[2] || process.env.XY_CHECK_PORT || 8788);
const BASE = 'http://127.0.0.1:' + PORT_NUM;
const CDP_PORT = Number(process.env.XY_CDP_PORT2 || 9247);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra !== undefined ? '  → ' + String(extra).slice(0, 300) : '')); }
};
const sk = (m, why) => { skip++; console.log('  SKIP ' + m + (why ? '  → ' + why : '')); };

const EDGE = [
  process.env.XY_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find((p) => { try { return existsSync(p); } catch { return false; } });

let child = null, cdp = null, sid = '';

/* 页面里的一小块「探针」：读状态 + 造状态 */
const PROBE = `
window.__pq = function () {
  const box = document.getElementById('pendingQueue');
  const rows = box ? [...box.querySelectorAll('.pendingItem')] : [];
  return {
    n: (typeof pendingQueue !== 'undefined' && pendingQueue) ? pendingQueue.length : -1,
    hidden: box ? !!box.hidden : true,
    head: (box && box.querySelector('.pendingHead')) ? box.querySelector('.pendingHead').textContent : '',
    texts: rows.map((r) => (r.querySelector('.ptext') || {}).textContent || ''),
    btns: rows.length ? [...rows[0].querySelectorAll('button')].map((b) => b.textContent) : [],
    input: String((document.getElementById('input') || {}).value || ''),
    busy: (typeof busy !== 'undefined') ? !!busy : null,
  };
};`;

async function typeAndSendByButton(text) {
  await cdp.eval(`(function(){
    const i = document.getElementById('input');
    i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })();`);
  await sleep(120);
  await cdp.eval(`document.getElementById('send').click(); return 1;`);
  await sleep(350);   // sendBuffered 是 async（要 await 一次 cfg），给它一拍
}

(async () => {
  try {
    const health = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
    if (!health) { sk('插话预发送真机验收', BASE + ' 没有应用在跑（先 npm start）'); return done(); }
    if (!EDGE) { sk('插话预发送真机验收', '找不到 Edge/Chrome'); return done(); }

    const s = await fetch(BASE + '/api/sessions/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '预发送验收（可删）' }),
    }).then((r) => r.json()).catch(() => null);
    sid = String((s && (s.session || s) && (s.session || s).id) || '');
    if (!sid) { sk('插话预发送真机验收', '建会话失败'); return done(); }

    const profile = mkdtempSync(join(tmpdir(), 'xy-presend-'));
    child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile, BASE + '/?s=' + encodeURIComponent(sid)], { stdio: 'ignore' });

    for (let i = 0; i < 40; i++) {
      try {
        const l = await fetch('http://127.0.0.1:' + CDP_PORT + '/json').then((r) => r.json());
        if (l.some((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'))) break;
      } catch {}
      await sleep(300);
    }
    cdp = await connect({ port: CDP_PORT, match: String(PORT_NUM) });
    await sleep(1200);

    ok(await cdp.eval('return typeof pendingQueue !== "undefined" && typeof sendBuffered === "function";'),
      '页面里预发送那套还在（sync 到位）');

    /* 装探针 + 把 /api/interject 换成记账（不真插话，不花钱） */
    await cdp.eval(PROBE + `
      window.__ij = 0;
      if (!window.__origFetch) {
        window.__origFetch = window.fetch.bind(window);
        window.fetch = function (u, o) {
          try {
            if (String(u).indexOf('/api/interject') >= 0) { window.__ij += 1; return Promise.resolve(new Response(JSON.stringify({ ok: true, running: true, steered: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })); }
          } catch (e) {}
          return window.__origFetch(u, o);
        };
      }
      return 1;`);

    /* ── ① 新增预发送 ─────────────────────────────────────────────── */
    console.log('\n① 她在跑时点【发送】→ 进预发送（不立刻发）');
    /* 【为什么要把 busy 按住】页面里有个「她到底还在不在跑」的复核（scheduleSendingRecheck），
         * 它会问服务端 /api/running；测试里 busy 是伪造的、服务端那边没跑，于是会被纠正成 false ——
         * 那样点【发送】就走了「不忙」的路（缓冲/直接发），测不到预发送。
         * 每 80ms 压一次，就等于稳定地「她正在跑」。 */
        await cdp.eval('(function(){ window.__holdBusy = setInterval(function(){ busy = true; }, 80); busy = true; return 1; })();');
    // 清空上一轮可能残留的队列（同一个浏览器 profile 是新的，一般没有）
    await cdp.eval('try { pendingQueue.length = 0; savePendingQueue(); renderPendingQueue(); } catch (e) {} window.__ij = 0; return 1;');
    await typeAndSendByButton('预发送-第一条');
    let st = await cdp.eval('return window.__pq();');
    ok(st.n === 1, '入队 1 条', JSON.stringify(st));
    ok(st.hidden === false, '输入框上方那排「待发送」出来了');
    ok(st.input === '', '输入框被清空（话已经收进队列）');
    ok(/她这轮说完自动发/.test(st.head), '状态写清了「她这轮说完自动发」', st.head);
    ok((await cdp.eval('return window.__ij;')) === 0, '这一刻**没有**走插话（没打断她）');

    await typeAndSendByButton('预发送-第二条');
    st = await cdp.eval('return window.__pq();');
    ok(st.n === 2, '再点一次 → 队列 2 条', JSON.stringify(st));
    ok(['直接发送', '编辑', '删除'].every((t) => st.btns.includes(t)), '每条都有【直接发送】【编辑】【删除】', st.btns.join('/'));

    /* ── ③ 直接发送 ───────────────────────────────────────────────── */
    console.log('\n③ 预发送阶段点【直接发送】→ 立刻插进去');
    await cdp.eval(`(function(){
      const rows = [...document.querySelectorAll('#pendingQueue .pendingItem')];
      const b = rows[0] && [...rows[0].querySelectorAll('button')].find((x) => x.textContent === '直接发送');
      if (b) b.click();
      return 1;
    })();`);
    await sleep(500);
    ok((await cdp.eval('return window.__ij;')) >= 1, '【直接发送】确实走了插话通道（/api/interject）');
    ok((await cdp.eval('return window.__pq().n;')) === 1, '那一条出队了，剩 1 条');

    /* ── ④ 编辑 ───────────────────────────────────────────────────── */
    console.log('\n④ 点【编辑】→ 搬回输入框、出队');
    await cdp.eval(`(function(){
      const rows = [...document.querySelectorAll('#pendingQueue .pendingItem')];
      const b = rows[0] && [...rows[0].querySelectorAll('button')].find((x) => x.textContent === '编辑');
      if (b) b.click();
      return 1;
    })();`);
    await sleep(250);
    st = await cdp.eval('return window.__pq();');
    ok(st.n === 0, '队列空了');
    ok(/预发送-第二条/.test(st.input), '那条文字回到输入框（能接着改）', st.input);
    ok(st.hidden === true, '队列条收起来了');

    /* ── ⑤ 删除 ───────────────────────────────────────────────────── */
    console.log('\n⑤ 点【删除】→ 直接没了');
    await cdp.eval(`(function(){ const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })();`);
    await typeAndSendByButton('预发送-待删除');
    ok((await cdp.eval('return window.__pq().n;')) === 1, '先入队一条');
    await cdp.eval(`(function(){
      const rows = [...document.querySelectorAll('#pendingQueue .pendingItem')];
      const b = rows[0] && [...rows[0].querySelectorAll('button')].find((x) => x.textContent === '删除');
      if (b) b.click();
      return 1;
    })();`);
    await sleep(250);
    st = await cdp.eval('return window.__pq();');
    ok(st.n === 0 && st.hidden === true, '删掉后队列空了、条也收了', JSON.stringify(st));

    /* ── ⑥ 回车不受影响 ───────────────────────────────────────────── */
    console.log('\n⑥ 在跑时按回车 → 仍然是直接插话（不进队列）');
    await cdp.eval('window.__ij = 0; busy = true; return 1;');
    await cdp.eval(`(function(){
      const i = document.getElementById('input');
      i.value = '回车直接插话';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.focus();
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return 1;
    })();`);
    await sleep(600);
    st = await cdp.eval('return window.__pq();');
    ok(st.n === 0, '回车**没有**把它塞进预发送队列', JSON.stringify(st));
    ok((await cdp.eval('return window.__ij;')) >= 1, '回车走的是插话（/api/interject 被调用）');

    /* ── ② 轮次结束后自动发送 ─────────────────────────────────────── */
    console.log('\n② 她不忙了 → 队列自己放行（2 秒那一拍）');
    await cdp.eval('try { clearInterval(window.__holdBusy); } catch (e) {} return 1;');
    /* 只记账、不调原函数：原函数会真起一轮（花 token），这里要验的是「会不会被触发」，
     * 触发之后的实际发送由静态那几条（flushPendingQueue 的实现）+ 主人日常使用来保证。 */
    await cdp.eval(`
      window.__flushHit = 0;
      window.__origFlush = flushPendingQueue;
      flushPendingQueue = function () { window.__flushHit += 1; return undefined; };
      return 1;`).catch(() => {});
    await cdp.eval('busy = true; return 1;');
    await typeAndSendByButton('预发送-等她说完');
    ok((await cdp.eval('return window.__pq().n;')) === 1, '入队一条等她说完');
    /* 把 busy 按住 3 秒（有别的定时器会把它拨回 true，压住才验得准） */
    await cdp.eval(`(function(){
      window.__busySamples = [];
      window.__busyHold = setInterval(function(){ window.__busySamples.push(!!busy); busy = false; }, 200);
      busy = false;
      return 1;
    })();`);
    await sleep(2800);
    await cdp.eval('clearInterval(window.__busyHold); return 1;');
    const hits = await cdp.eval('return window.__flushHit || 0;');
    ok(hits >= 1, 'busy 变 false 后 2 秒内自动触发了 flush（轮末自动发）', 'hits=' + hits + ' 采样=' + JSON.stringify(await cdp.eval('return window.__busySamples.slice(0,8);')));
    ok(/马上发出/.test((await cdp.eval('return window.__pq();')).head),
      '空闲时文案变成「马上发出…」（不会让人以为还要再点一次）');

    /* 收尾：队列清掉，免得留在 localStorage 里下次进会话冒出来 */
    await cdp.eval(`try {
      pendingQueue.length = 0; savePendingQueue(); renderPendingQueue();
      flushPendingQueue = window.__origFlush;
      window.fetch = window.__origFetch;
      busy = false;
    } catch (e) {} return 1;`);
  } catch (e) {
    fail++;
    console.log('  [!!] 脚本自身出错：' + (e && e.message ? e.message : e));
  } finally {
    done();
  }
})();

function done() {
  try { if (cdp) cdp.close(); } catch {}
  try { if (child) child.kill(); } catch {}
  /* 收掉测试会话（不留在主人侧栏里） */
  if (sid) {
    fetch(BASE + '/api/sessions/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid }),
    }).catch(() => {});
  }
  setTimeout(() => {
    console.log('\n插话预发送·真机：' + pass + ' 过 / ' + fail + ' 挂 / ' + skip + ' 跳过');
    process.exit(fail ? 1 : 0);
  }, 300);
}
