#!/usr/bin/env node
/**
 * 【2026-11-11 加·小鲸名字颜色·真机实测】
 *
 * 主人报：「重启后历史上下文里小鲸的名字是白色（应该是蓝色）」。
 *
 * 为什么不能只读一眼稳定态：
 *   本地回环下 /api/agents 几毫秒就回来了，改前改后**都是蓝的** —— 这种测法永远抓不到。
 *   主人看到白的那一刻是**节点创建的那一帧**，而且重启后那一次网络往返不会那么快。
 *   所以这里做两件事：
 *     ① 在文档执行前注入 MutationObserver，记下每个新 .msg 出现那一拍的 .role 颜色；
 *     ② 把 /api/agents 人为拖慢（默认 2500ms，可用 XY_AGENTS_DELAY 调）——
 *        模拟重启后「颜色表还没回来，历史已经画完了」那一拍。
 *   改之前：这两拍都是白；改之后：第一拍就该是蓝的（内置表），网络回来也不用补。
 *
 * 环境：隔离实例（临时数据目录 + 独立端口 + 独立 headless 浏览器），不碰主人那份。
 * 用法：node scripts/check-whale-color.mjs
 */
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../_t_cdp.mjs';
import { startIsolated } from './_test-instance.mjs';

const SID = process.env.XY_WHALE_SID || 'smwa2p0lqyxjo';
const AGENTS_DELAY = Number(process.env.XY_AGENTS_DELAY || 2500);
const USER_DATA = process.env.XY_USER_DATA
  || join(process.env.APPDATA || '', '小鱼Agent', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = `return (function(){
  const rows = [];
  document.querySelectorAll('#log .msg').forEach((el) => {
    const rl = el.querySelector('.role');
    if (!rl) return;
    const nm = String(rl.textContent || '').replace(/\\s*·\\s*姐妹\\s*/g, '').trim();
    const cs = getComputedStyle(rl);
    rows.push({
      cls: String(el.className),
      who: nm,
      inline: String(rl.style.color || ''),
      whoC: String(el.style.getPropertyValue('--whoC') || ''),
      color: cs.color,
    });
  });
  return {
    total: rows.length,
    rows,
    filtered: rows.filter((r) => /\\bassistant\\b/.test(r.cls) && r.who === '小鲸'),
    whale: rows.filter((r) => /\\bwhale\\b/.test(r.cls) && r.who === '小鲸'),
    firstFrames: (Array.isArray(window.__firstColors) ? window.__firstColors : [])
      .filter((x) => /\\bassistant\\b/.test(x.cls) && x.who === '小鲸'),
    mapSize: (function(){ try { return window.__mateColors ? window.__mateColors.size : 'no-map'; } catch(e){ return 'err'; } })(),
  };
})();`;

const isBlue = (c) => {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(c)) || [];
  return Number(m[3]) > Number(m[1]) + 20;
};

/** 注入到每份新文档：记录「节点创建那一拍」的颜色 + 拖慢 /api/agents */
const INJECT = `
(function(){
  window.__firstColors = [];
  var take = function (el) {
    var rl = el.querySelector && el.querySelector('.role');
    if (!rl) return;
    var nm = String(rl.textContent || '').replace(/\\s*·\\s*姐妹\\s*/g, '').trim();
    window.__firstColors.push({
      cls: String(el.className || ''),
      who: nm,
      inline: String(rl.style.color || ''),
      color: getComputedStyle(rl).color,
      t: Math.round(performance.now()),
    });
  };
  var scan = function (node) {
    if (!node || node.nodeType !== 1) return;
    if (node.classList && node.classList.contains('msg')) take(node);
    if (node.querySelectorAll) node.querySelectorAll('.msg').forEach(take);
  };
  var start = function () {
    try {
      new MutationObserver(function (recs) {
        recs.forEach(function (r) { r.addedNodes.forEach(scan); });
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  };
  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });

  /* 拖慢 /api/agents：模拟重启后颜色表还没回来的那一拍 */
  var DELAY = ${AGENTS_DELAY};
  var origFetch = window.fetch;
  window.__agentsDelay = DELAY;
  window.fetch = function (u, o) {
    var url = String((u && u.url) || u || '');
    if (url.indexOf('/api/agents') >= 0 && url.indexOf('/api/agents/') < 0 && DELAY > 0) {
      return new Promise(function (res) { setTimeout(res, DELAY); })
        .then(function () { return origFetch.call(window, u, o); });
    }
    return origFetch.call(window, u, o);
  };
})();
`;

(async () => {
  let inst = null;
  let pass = 0, fail = 0;
  const ok = (c, m, extra) => {
    if (c) { pass++; console.log('  OK   ' + m); }
    else { fail++; console.log('  [!!] ' + m + (extra ? '  → ' + extra : '')); }
  };

  inst = await startIsolated({ appPort: 8795, cdpPort: 9223 });
  console.log('隔离实例: ' + inst.base + '   （/api/agents 延迟 ' + AGENTS_DELAY + 'ms）');
  try {
    /* 把主人的真会话复制进隔离实例（只读复制，不改原文） */
    const src = join(USER_DATA, '.state', 'sessions', SID + '.json');
    const dstDir = join(inst.dataDir, '.state', 'sessions');
    mkdirSync(dstDir, { recursive: true });
    if (!existsSync(src)) throw new Error('找不到会话文件：' + src);
    copyFileSync(src, join(dstDir, SID + '.json'));
    console.log('已复制会话 ' + SID + '（只读副本）');

    const cdp = await connect({ port: inst.cdpPort, match: String(new URL(inst.base).port) });
    await cdp.send('Page.enable', {});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });

    /* 带着会话 id 重新打开 —— 等价于「重启后点开这个会话」 */
    const url = inst.base + '/?s=' + encodeURIComponent(SID);
    await cdp.eval(`location.href = ${JSON.stringify(url)}; return 1;`);
    await sleep(1500 + AGENTS_DELAY + 1200);

    const out = await cdp.eval(READ);
    ok(out.total > 0, '屏幕上画出了历史（共 ' + out.total + ' 条带署名的消息）');
    ok(out.filtered.length > 0, '.msg.assistant 里署名「小鲸」的有 ' + out.filtered.length + ' 条');
    console.log('  __mateColors.size = ' + out.mapSize);

    console.log('  ── 稳定态：全部署名与颜色 ──');
    for (const r of out.rows) {
      console.log('     ' + r.cls + ' | ' + r.who + ' | ' + r.color
        + ' | inline=' + (r.inline || '空') + ' | --whoC=' + (r.whoC || '空'));
    }

    console.log('  ── 节点刚被创建那一拍（MutationObserver，颜色表还没回来）──');
    for (const x of out.firstFrames) {
      console.log('     t=' + x.t + 'ms  ' + x.cls + ' 小鲸 → ' + x.color + '  (inline=' + (x.inline || '空') + ')');
    }
    const firstBad = out.firstFrames.filter((x) => !isBlue(x.color));
    const stableBad = out.filtered.filter((r) => !isBlue(r.color));

    ok(out.firstFrames.length > 0, '抓到 ' + out.firstFrames.length + ' 条「创建瞬间」样本');
    ok(firstBad.length === 0,
      '创建那一拍就是蓝色（白样本 ' + firstBad.length + '/'
        + out.firstFrames.length + (firstBad.length ? '：' + firstBad[0].color : '') + '）');
    ok(stableBad.length === 0,
      '稳定态全部蓝色（白样本 ' + stableBad.length + '/'
        + out.filtered.length + (stableBad.length ? '：' + stableBad[0].color : '') + '）');
    ok(out.filtered.every((r) => String(r.color) !== 'rgb(230, 230, 230)'),
      '没有一条落在默认白 rgb(230,230,230)');

    /**
     * 【表回来了要能自己纠回来】内置表是兜底，真源仍是 /api/agents。
     * 把卡色改掉 → 重新加载 → 数据回来后 React 必须自己重画成新色，
     * 不能靠谁去手工改 DOM（下一次渲染又会被覆盖回去）。
     */
    const agentsFile = join(inst.dataDir, '.state', 'agents.json');
    if (existsSync(agentsFile)) {
      const raw = JSON.parse(readFileSync(agentsFile, 'utf8'));
      raw.colors = raw.colors && typeof raw.colors === 'object' ? raw.colors : {};
      raw.colors.xiaojing = '#ff6b6b';
      writeFileSync(agentsFile, JSON.stringify(raw, null, 2), 'utf8');
      console.log('  （把卡色临时改成 #ff6b6b，验「数据回来后会不会自动重渲染」）');

      await cdp.eval(`location.href = ${JSON.stringify(url)}; return 1;`);
      await sleep(1200);
      const mid = await cdp.eval(READ);
      await sleep(AGENTS_DELAY + 1500);
      const later = await cdp.eval(READ);

      const midColor = (mid.filtered[0] || {}).color;
      const laterColor = (later.filtered[0] || {}).color;
      console.log('  卡色改掉后：首拍=' + midColor + '  数据回来后=' + laterColor);
      ok(String(laterColor) === 'rgb(255, 107, 107)',
        '颜色表回来后变成新色',
        '首拍=' + midColor + ' 最终=' + laterColor);

      raw.colors.xiaojing = '#5b9bd5';
      writeFileSync(agentsFile, JSON.stringify(raw, null, 2), 'utf8');
    }

    /**
     * 【最狠的一条：/api/agents 彻底拿不到】
     *
     * 这才是主人遇到的形态 —— 重启冷启动时那次请求不只是慢，还可能没回来
     * （后端还在起、路由还没挂上）。index.html 的 mateColorOf 拿不到就只能吐默认白，
     * 而它**没有任何重试**；屏幕于是白到下一次整屏重画。
     *
     * 内置表的意义就在这条：网络完全不可用的时候，小鲸的名字还是蓝的。
     */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        var of = window.fetch;
        window.fetch = function (u, o) {
          var url = String((u && u.url) || u || '');
          if (url.indexOf('/api/agents') >= 0 && url.indexOf('/api/agents/') < 0) {
            return Promise.reject(new Error('模拟：重启后这次请求没回来'));
          }
          return of.call(window, u, o);
        };
        window.__agentsBlocked = true;
      })();`,
    });
    await cdp.eval(`location.href = ${JSON.stringify(url)}; return 1;`);
    await sleep(3000);
    const blocked = await cdp.eval(READ);
    console.log('  ── 断网态（/api/agents 直接失败）：__mateColors.size=' + blocked.mapSize + ' ──');
    for (const x of blocked.firstFrames) {
      console.log('     t=' + x.t + 'ms  ' + x.cls + ' 小鲸 → ' + x.color + '  (inline=' + (x.inline || '空') + ')');
    }
    const bFirstBad = blocked.firstFrames.filter((x) => !isBlue(x.color));
    const bStableBad = blocked.filtered.filter((r) => !isBlue(r.color));
    ok(blocked.filtered.length > 0, '断网态也画出了 .msg.assistant 的小鲸（' + blocked.filtered.length + ' 条）');
    ok(bFirstBad.length === 0,
      '断网时创建那一拍仍是蓝色（白样本 ' + bFirstBad.length + '/'
        + blocked.firstFrames.length + (bFirstBad.length ? '：' + bFirstBad[0].color : '') + '）');
    ok(bStableBad.length === 0,
      '断网时稳定态仍是蓝色（白样本 ' + bStableBad.length + '/'
        + blocked.filtered.length + (bStableBad.length ? '：' + bStableBad[0].color : '') + '）');

    cdp.close();
  } finally {
    try { await inst.stop(); } catch {}
  }

  console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('探针失败: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e));
  process.exit(2);
});