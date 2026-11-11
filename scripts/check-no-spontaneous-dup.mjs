#!/usr/bin/env node
/**
 * 【QA · 2026-11-09】#14 回归用例：「不刷新、不插话，纯流式跑着跑着自己把话堆起来」
 *
 * ══ 这个脚本为什么存在 ══
 *
 * 主人报过两种症状：「好几段话堆进一个气泡」/「F5 之后又堆一块」。
 * 前者修过一轮（口径统一：只有「新增条目」的事件才是分段线）。但还有一条没结：
 * **什么都不做（不刷新、不插话），它自己也会堆。**
 *
 * 这一条的价值不在「修旧实现」（旧实现正在被 React 重写整段替换），而在**基线**：
 *   · 现在（旧实现）应该是**红**的 —— 那就是重写的验收基线；
 *   · 重写完成后，拿**同一个脚本**跑，必须是**绿**的。
 * 所以断言只写「屏幕行为」，不写任何旧实现的内部结构（不 assert paintSnapshot /
 * renderLog / liveModels 存在）。重写把实现换掉，这个脚本一个字都不用改。
 *
 * ══ 怎么保证是「真」的 ══
 *
 *   · 真隔离实例（临时数据目录，不碰主人正在跑的 8788）；
 *   · 真无头 Edge + 真页面，真 runTurn / 真渲染管线；
 *   · 只有**网络层**是编排好的：/api/chat 吐我指定的 SSE、/api/chat/live 给指定清单，
 *     其余（会话、历史、配置）全部透传真服务。
 *   · 全程**不 reload、不 interject**（脚本里逐条断言：页面导航次数、interject 调用数都为 0）。
 *
 * 页面从哪来：`--public <dir>` 指定。默认用 **git HEAD 里那份**（手写 DOM 的旧实现），
 * 这样重写还在工作区里改来改去也不会污染基线。重写上线后跑 `--public public` 即可。
 *
 * ══ 断言（每一帧都查，120ms 取样）══
 *   ① 某一段文字**不能长在两个容器里**（数容器，不数关键字 —— 见下面的坑）；
 *   ② 任何一刻都不出现**两条文字完全相同**的 assistant 气泡（>8 字才算）；
 *   ③ 全程不 reload、不 interject（页面导航次数、interject 调用数都要为 0）；
 *   ④ 【真对话专用·这条才是抓到这个 bug 的那条】屏幕上某个标记**最多出现过几次**，
 *      必须 == 它在这轮**落盘正文**里出现几次。模型爱把指令复述几遍，所以不能假设它只出现一次，
 *      得拿「落盘那份」当基准去比。
 *
 * ══ 现在的结论（2026-11-09，旧实现）= 红，已复现 ══
 *
 * 触发条件（很窄，这正是自检一直绿、主人却天天遇到的原因）：
 *   **真模型的密集小块流式**。用合成 SSE（每条隔 180~400ms、每条一大块）跑 10 个形状
 *   —— 包括续跑、别人插话、tool_end、轮末接着跑、done 时历史+直播同时有 —— **全部绿**。
 *   换成真服务端 + 真模型（一次分三段的较长回答），12 秒内必现。
 *
 * 现象（实测）：容器**始终只有 1 个**（所以不是「长出两个气泡」，是**同一个气泡里重复贴**），
 *   但那个气泡里的字 = 回答重复了 **3~6 遍**；跑完仍留着（第 2 轮还在）。
 *   拿落盘正文比：屏幕上 QAT01END 最多 6 次，落盘只有 1 次 → 多出来的都是重画出来的。
 *
 * 定位（旧实现，git HEAD 的 public/index.html）：
 *   `tryLiveAppendFast()`（约 5873–5909 行）走「快路」时是这么追加的：
 *       const cur = bubble._rawText;                 // 屏幕上已经有的一整段
 *       const want = lastItem.t;                     // 清单里这一段的**完整**文字
 *       if (!want.startsWith(cur)) return false;
 *       pushStreamText(bubble, want.slice(cur.length));   // 只追加「多出来的那截」
 *   这条快路要成立，靠的是「`_rawText` 永远等于屏幕上那段文字」这个前提。
 *   而 `pushStreamText()`（6557 起）里有两处会把这个前提打破：
 *     · 出现「【压缩记忆」时**就地截断** `_rawText`（6576–6580 附近）；
 *     · `_rawText` 非空、`textContent` 却被别处清空时，把 `_rawText` 重置成 `''`（6561）。
 *   一旦 `_rawText` 比屏幕上那段短，`want.slice(cur.length)` 就不再是「新增的那一截」，
 *   而是**整段**——下一次快路又把它追加一遍。密集小块流式（k 很多、16ms 节流一帧）正好
 *   把这条路的调用次数放大，于是 1→2→3→6 倍地叠。字数是**波动**的（229→187→238），
 *   因为每次重画都按当时的 `_rawText` 重算一遍该追加什么。
 *
 *   → 这就是「不刷新也会自发堆一块」的机制：**同一个气泡被反复追加整段**。
 *   （不是 renderLog 里 `_histPainted && running` 那段；那一段我按你的提示专门验了，
 *    在 F/E/H 三个形状里是干净的。）
 *
 * 踩过的坑（写在脚本里免得下次再踩）：
 *   · 不能数「关键字在整屏出现几次」：模型会把指令原样复述好几遍（实测 4 遍），
 *     那会报成「同段出现 4 次」的假红。要数**容器**，以及**跟落盘次数比**。
 *   · 不能把「连着两条 text 事件」当两段：它们本来就该并成一段。第一版把期望值算成 6，
 *     实际 3，白追了半天。
 *
 * 用法：
 *   node scripts/check-no-spontaneous-dup.mjs                 # 基线（真模型两轮）——现在是红
 *   node scripts/check-no-spontaneous-dup.mjs --shapes        # 合成形状扫描（现在全绿）
 *   node scripts/check-no-spontaneous-dup.mjs --explore       # 同上但列明细
 *   node scripts/check-no-spontaneous-dup.mjs --public public # 换成工作区当前前端（重写验收）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { startIsolated } from './_test-instance.mjs';
import { connect } from '../_t_cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const EXPLORE = args.includes('--explore');
const PUB_ARG = argOf('public', '');

/* ── 0. 准备前端目录 ────────────────────────────────────────────────
 * 【2026-11-09 换框架·默认口径改了】
 *
 * 原来默认取 **git HEAD 里那份**（手写 DOM 的旧实现），本意是「重写还在工作区里
 * 改来改去，别污染基线」。可重写已经上线了 —— 于是这个检查一直在验旧代码：
 * 它报的重复是旧实现里的老朋友（tryLiveAppendFast 的 _rawText 失配），
 * 跟我们现在的实现毫无关系，却会一路红下去，还挡住了新代码的回归。
 *
 * 现在：
 *   · 默认验**工作区那份 public/**（React 实现）= 线上跑的那份；
 *   · `--public-head` 才回到 git HEAD 的旧实现，用来复现 / 对照那个历史 bug。
 */
function preparePublic() {
  if (PUB_ARG) {
    const p = path.resolve(ROOT, PUB_ARG);
    if (!fs.existsSync(path.join(p, 'index.html'))) throw new Error('--public 目录里没有 index.html：' + p);
    return { dir: p, from: '指定目录 ' + p };
  }
  if (!args.includes('--public-head')) {
    const dir = path.join(ROOT, 'public');
    if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error('工作区里没有 public/index.html');
    return {
      dir,
      /* React 版多一个预构建产物 —— 必须一起带过去，否则页面里没有渲染器 */
      extraFiles: ['ui/log.bundle.js'],
      from: '工作区 public/（React 实现）',
    };
  }
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-old-front-'));
  for (const rel of ['index.html', 'ui/chat.js', 'ui/hub.js', 'ui/sessions.js']) {
    const buf = execFileSync('git', ['show', 'HEAD:public/' + rel], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
  }
  return { dir, from: 'git HEAD(' + head + '):public（手写 DOM 的旧实现）' };
}

/* ── 1. 一个只给自己用的代理：静态文件给旧前端，/api 透传真服务，/api/chat* 换成编排 ── */
function startProxy({ pubDir, apiBase, state }) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    if (p === '/api/chat' && req.method === 'POST' && !state.real) return synthChat(req, res);
    if (p === '/api/chat/live' && !state.real) return synthLive(res, u);
    if (p === '/api/interject') { state.interjects++; return json(res, 200, { ok: true }); }
    /* 历史也编排：这一轮「服务端已经落了多少盘」直接决定历史里有没有半截 */
    if (p === '/api/sessions/select' && state.turns) {
      state.selectCalls = (state.selectCalls || 0) + 1;
      /* 必须回客户端要的那个 id —— 回空 id 的话前端 sessionId 一直是空，页面永远「没起来」 */
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let wantId = state.sid || '';
      try { wantId = JSON.parse(Buffer.concat(chunks).toString('utf8')).id || wantId; } catch {}
      return json(res, 200, { session: { id: wantId, turns: state.turns } });
    }
    /* 其它 /api 一律透传 */
    if (p.startsWith('/api/')) {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const r = await fetch(apiBase + req.url, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] || 'application/json' },
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        return res.end(buf);
      } catch (e) {
        return json(res, 502, { error: 'proxy: ' + (e && e.message) });
      }
    }
    /* 静态文件 */
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.join(pubDir, rel);
    if (!file.startsWith(pubDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 ' + rel);
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(file));
  });

  function json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  /** 编排好的 SSE：一条一条吐，节奏由 state.gap 控制；state.hold 时吐完也不关流 */
  function synthChat(req, res) {
    const evs = state.events || [];
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    let i = 0;
    state.chatOpenedAt = Date.now();
    const tick = () => {
      if (state.closed) { try { res.end(); } catch {} return; }
      if (i >= evs.length) {
        if (state.hold) return;                 // 不关流 = 这一轮一直在「正在跑」
        try { res.end(); } catch {}
        return;
      }
      const e = evs[i++];
      state.emitted.push(e);
      try { res.write('data: ' + JSON.stringify(e) + '\n\n'); } catch {}
      setTimeout(tick, state.gap || 320);
    };
    tick();
  }

  /** /api/chat/live：按 state.live 给（可随时间变化：数组 = 按调用次数依次取） */
  function synthLive(res, u) {
    state.liveCalls++;
    let L = state.live;
    if (Array.isArray(state.live)) {
      L = state.live[Math.min(state.liveCalls - 1, state.live.length - 1)];
    }
    if (!L) return json(res, 200, { sessionId: u.searchParams.get('sessionId'), running: false, items: [], events: [], nextSince: 0 });
    return json(res, 200, {
      sessionId: u.searchParams.get('sessionId'),
      running: L.running !== false,
      startedAt: L.startedAt || state.startedAt,
      items: L.items || [],
      events: L.events || [],
      since: 0, total: (L.events || []).length, nextSince: 0,
      textLen: (L.items || []).reduce((a, x) => a + (x && x.k === 'text' ? String(x.t || '').length : 0), 0),
    });
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ── 2. 屏幕读法（只读行为，不碰实现） ── */
const SNAP = `(function(){
  var lg = document.getElementById('log');
  var tx = function(el){ return String((el && el.textContent) || ''); };
  var nrm = function(s){ return String(s||'').replace(/\\s+/g,''); };
  var asst = [].slice.call(lg.querySelectorAll('.msg.assistant')).map(function(m){
    return { live: m.dataset.liveTurn === '1', text: nrm(tx(m)) };
  });
  /* 【只数正文】她说的话 = assistant 气泡里的 .bubble。
   * 思考块（details.think）、工具卡、用量行都在 .msg.assistant 里面，
   * 但**不是她说的话** —— 把它们算进「重复」就是假红。
   * 判据统一成「正文气泡 vs 落盘正文」，两侧口径一致。 */
  var bubbles = [].slice.call(lg.querySelectorAll('.msg.assistant .bubble'));
  return {
    all: nrm(tx(lg)),
    bubbleText: bubbles.map(tx).map(nrm).join('|'),
    bubbleCount: bubbles.length,
    asst: asst,
    asstCount: asst.length,
    liveCount: asst.filter(function(x){ return x.live; }).length,
    msgCount: lg.querySelectorAll('.msg').length,
    nav: (performance.getEntriesByType('navigation')||[]).length,
    busy: !!window.busy
  };
})()`;

/** 段落标记：每段正文里塞一个独一无二的 token，数它在整屏文字里出现几次 */
const tok = (i) => 'QA' + 'Z'.repeat(0) + 'T' + String(i).padStart(2, '0') + 'END';
const norm = (s) => String(s || '').replace(/\s+/g, '');

function countTok(hay, t) { return String(hay || '').split(t).length - 1; }
/**
 * 【判重的正确口径】某段文字出现在**几个容器**里。
 *
 * 一开始我数的是「这个 token 在整屏文字里出现几次」—— 结果模型自己把指令复述了 4 遍
 * （原文里就有 4 个 QAT01END），检查报「同段出现 4 次」，全是假红。
 * 屏幕上的「重复」只有一个意思：**同一段正文长出两个容器**。所以数容器。
 */
function containersWith(asst, t) {
  return (asst || []).filter((x) => String(x.text || '').indexOf(t) >= 0).length;
}

/** 两条文字完全相同的 assistant 气泡（>8 字才算，免得「好的」天然重复） */
function exactDup(a) {
  const m = new Map();
  for (const x of (a || [])) {
    if (String(x.text || '').length < 8) continue;
    m.set(x.text, (m.get(x.text) || 0) + 1);
  }
  return [...m.entries()].filter(([, n]) => n > 1).map(([t, n]) => n + '×' + t.slice(0, 14));
}

/* ── 3. 用例形状 ──────────────────────────────────────────────────
 * 每条 = { name, events, live, gap, hold, expectSeg }
 *   events : 喂给 /api/chat 的 SSE（编排）
 *   live   : /api/chat/live 返回的清单（null = 没有在跑的轮次）
 *   expectSeg : 这一轮**应该**在屏幕上有几个 assistant 气泡
 * 每个 `text` 事件都带一个唯一 token，用来数「这段在屏幕上出现几次」。
 */
function shapes() {
  const S = (i, extra) => ({ type: 'text', text: '第' + i + '段话' + tok(i) + '，' + (extra || '她说了一句比较长的话好让气泡看得出来。') });

  return [
    {
      /* 基线：说 → 工具 → 说 → 轮末 → 说（应该 3 段） */
      name: 'A 说→工具→说→轮末→说',
      events: [
        { type: 'reasoning', text: '先想想' },
        S(1), { type: 'tool_start', id: 'c1', name: 'run_command', args: '{}' },
        { type: 'tool_end', id: 'c1', ok: true, output: 'ok' },
        S(2), { type: 'done' }, S(3),
      ],
      live: null, gap: 300, hold: false, expectSeg: 3, segCheck: true,
      turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: S(1).text + '\n\n' + S(2).text + '\n\n' + S(3).text }],
    },
    {
      /* 别人插一句：她的正文中间夹一个 whale_delta（旧前端把它当分段线，服务端不当） */
      name: 'B 别人插一句（whale_delta 夹在正文中间）',
      events: [
        { type: 'whale_stream_start', who: '小鲸' },
        S(1),
        { type: 'whale_delta', who: '小鲸', text: '我插一句' },
        S(2),
      ],
      live: null, gap: 320, hold: true, expectSeg: 1, segCheck: false,
      turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: S(1).text + S(2).text }],
    },
    {
      /* 工具跑完接着说：中间那个 tool_end 只是「改已有卡」，不该劈段 */
      name: 'C 工具跑完接着说（tool_end 改已有卡）',
      events: [
        S(1),
        { type: 'tool_start', id: 'k', name: 'run_command', args: '{}' },
        S(2),
        { type: 'tool_end', id: 'k', ok: true, output: 'ok' },
        S(3),
      ],
      live: null, gap: 300, hold: true, expectSeg: 2, segCheck: false,
      turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: S(1).text + S(2).text + S(3).text }],
    },
    {
      /* 排队轮：这一轮 done 之后，服务端自己接着跑下一轮（同一份 live 续写） */
      name: 'D 轮末之后服务端接着跑下一轮',
      events: [S(1), { type: 'done' }, S(2)],
      live: null, gap: 400, hold: false, expectSeg: 2, segCheck: true,
      turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: S(1).text + '\n\n' + S(2).text }],
    },
    {
      /* done 之后前端对账（refreshLiveModel）拿到的清单比屏幕上多一段 */
      name: 'E done 后对账：清单里多一段（历史还没落盘）',
      events: [S(1), { type: 'done' }],
      live: { running: true, items: [{ k: 'text', t: S(1).text }, { k: 'text', t: S(2).text }] },
      gap: 300, hold: false, expectSeg: 2, segCheck: true,
      turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: S(1).text }],
    },
    {
      /* done 时历史已经落盘了整段，同时 live 清单里也有整段（同一帧两套各画一次） */
      name: 'F done 时历史与直播各有一份',
      events: [S(1), S(2), { type: 'done' }],
      live: { running: true, items: [{ k: 'text', t: S(1).text + S(2).text }] },
      gap: 280, hold: false, expectSeg: 1, segCheck: true,
      turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: S(1).text + S(2).text }],
    },
    {
      /* 长回复 + 每隔几段一个工具（段多，边界最容易对不上） */
      name: 'G 长回复（6 段，每段之间一个工具）',
      events: (() => {
        const e = [];
        /* 每段之间都塞一个工具：这样「一段一个气泡」是确定的，不会因为
         * 「连着两条 text 本来就会并成一段」把期望值算错（我第一版就写错了，见文件末尾的记录）。 */
        for (let i = 1; i <= 6; i++) {
          e.push(S(i));
          e.push({ type: 'tool_start', id: 't' + i, name: 'run_command', args: '{}' });
          e.push({ type: 'tool_end', id: 't' + i, ok: true, output: 'ok' });
        }
        e.push({ type: 'done' });
        return e;
      })(),
      live: null, gap: 180, hold: false, expectSeg: 6, segCheck: true,
      turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: [1,2,3,4,5,6].map(function(i){return S(i).text;}).join('\n\n') }],
    },
    {
      /* 轮末 + 有人接着说话 + 对账清单（三件事撞一起） */
      name: 'H 轮末 + 别人说话 + 对账清单',
      events: [S(1), { type: 'done' }, { type: 'whale', who: '小鲸', text: '我说一句' + tok(9) }],
      live: [{ running: true, items: [{ k: 'text', t: S(1).text }, { k: 'say', who: '小鲸', t: '我说一句' }] }],
      gap: 300, hold: false, expectSeg: 1, segCheck: true,
      turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: S(1).text }],
    },
    {
      /* 续跑：历史里已经落了「前半句」，这一轮接着说后半句（runTurn({resume:true})）。
       * 这是「服务端自己接着跑下一轮」在前端的真实入口，全程没有刷新、没有插话。 */
      name: 'I 续跑：历史里有前半句，流式接着说',
      events: [S(2)],
      resume: true,
      turns: [{ role: 'user', text: 'QA 主人一句' }, { role: 'assistant', text: S(1).text }],
      live: null, gap: 300, hold: false, expectSeg: 1, segCheck: true,
    },
    {
      /* 同上，但历史那半句里有 markdown（** / `）—— 前缀比对最容易在这里失手 */
      name: 'J 续跑 + 历史那半句带 markdown',
      events: [{ type: 'text', text: '后半句 **加粗** 和 `代码` 都在这里' + tok(2) + '。' }],
      resume: true,
      turns: [{ role: 'user', text: 'QA 主人一句' },
        { role: 'assistant', text: '前半句 **加粗** 和 `代码` 都在这里' + tok(1) + '。' }],
      live: null, gap: 300, hold: false, expectSeg: 1, segCheck: true,
    },
  ];
}

/* ── 4. 跑一个形状 ─────────────────────────────────────────────── */
async function runShape(cdp, base, sh, { tag }) {
  const state = {
    events: sh.events, live: sh.live, gap: sh.gap, hold: sh.hold,
    startedAt: Date.now(), emitted: [], liveCalls: 0, chatOpenedAt: 0, closed: false, interjects: 0,
    turns: sh.turns || null, sid: '',
  };
  const px = await startProxy({ pubDir: base.pubDir, apiBase: base.apiBase, state });
  const url = 'http://127.0.0.1:' + px.port + '/';

  /* 每次都从一个干净的页面开始（这是「准备」，不是「刷新页面看效果」）
   * —— 断言里会检查：跑的过程中 navigation 次数不再增加。 */
  await cdp.send('Page.navigate', { url });
  await sleep(1200);
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      const v = await cdp.eval('return { ok: !!document.getElementById("log"), sid: window.sessionId || "" };');
      if (v && v.ok && v.sid) { ready = true; break; }
    } catch (e) {}
    await sleep(250);
  }
  if (!ready) { try { px.server.close(); } catch {} return { name: sh.name, skip: '页面没起来' }; }

  const navBefore = await cdp.eval('return (performance.getEntriesByType("navigation")||[]).length;');
  const interjBefore = state.interjects;

  /* 真 runTurn（不 await，让它自己跑） */
  await cdp.eval('window.__t = window.runTurn(' + (sh.resume ? '{ resume: true }' : '{ text: "QA 主人一句" }') + '); return 1;').catch(() => {});

  /* 每 100ms 取一帧，一直到这一轮跑完（或超时） */
  const samples = [];
  const t0 = Date.now();
  let doneAt = 0;
  while (Date.now() - t0 < 12000) {
    const s = await cdp.eval('return ' + SNAP + ';').catch(() => null);
    if (s) {
      s.at = Date.now() - t0;
      samples.push(s);
      if (!s.busy && s.at > 1200 && Date.now() - t0 > 2500) { doneAt = s.at; break; }
    }
    await sleep(100);
  }
  /* 收尾再等两拍，把 done 之后的补画/对账也吃进来 */
  for (let i = 0; i < 8; i++) {
    const s = await cdp.eval('return ' + SNAP + ';').catch(() => null);
    if (s) { s.at = Date.now() - t0; samples.push(s); }
    await sleep(250);
  }
  const navAfter = await cdp.eval('return (performance.getEntriesByType("navigation")||[]).length;').catch(() => navBefore);
  const interjAfter = state.interjects;

  state.closed = true;
  try { px.server.close(); } catch {}

  /* ── 断言 ── */
  const toks = sh.events.filter((e) => e.type === 'text' && !e.notice).map((e) => (e.text.match(/QT\d\dEND/) || [])[0]).filter(Boolean);
  const violations = [];
  let worstTok = '';
  for (const s of samples) {
    for (const t of toks) {
      const n = containersWith(s.asst, t);
      if (n > 1) { violations.push({ at: s.at, kind: '同一段长在 ' + n + ' 个容器里', tok: t }); worstTok = t; }
    }
    const ed = exactDup(s.asst);
    if (ed.length) violations.push({ at: s.at, kind: '两条一样的气泡 ' + ed.join('|') });
  }
  const last = samples[samples.length - 1] || { asstCount: 0, asst: [], liveCount: 0 };
  /* 「段数」看的是**流式期间直播气泡最多几个**（收尾之后归历史，历史里一轮就是一条，
   * 拿它判段数没意义）。whale 插话 / tool_end 那两条是旧口径的已知差异，只作参考不判红，
   * 否则基线会被口径噪音淹掉。 */
  const maxLive = Math.max(0, ...samples.map((x) => x.liveCount || 0));
  const segOk = sh.segCheck === false ? true : (maxLive === sh.expectSeg);
  const navOk = navAfter === navBefore;
  const interjOk = interjAfter === interjBefore;

  return {
    name: sh.name, samples: samples.length, violations, expectSeg: sh.expectSeg,
    finalSeg: maxLive, finalAsst: last.asstCount, segOk, navOk, interjOk, toks, worstTok,
    ms: Date.now() - t0,
  };
}

/* ── 4.5 真对话模式：真服务端 + 真模型（最接近主人真实使用） ──
 * 合成 SSE 再像，也替代不了「服务端边跑边落盘 + 真分块 + 真 markdown」。
 * 这里连两轮：第二轮开始时历史里已经有第一轮的完整回答，边界条件最真实。
 */
async function runReal(cdp, pubDir, apiBase) {
  const state = { real: true, events: [], live: null, gap: 0, hold: false, interjects: 0, emitted: [], liveCalls: 0, turns: null };
  const px = await startProxy({ pubDir, apiBase, state });
  const url = 'http://127.0.0.1:' + px.port + '/';
  await cdp.send('Page.navigate', { url });
  await sleep(1500);
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      const v = await cdp.eval('return { ok: !!document.getElementById("log"), sid: window.sessionId || "" };');
      if (v && v.ok && v.sid) { ready = true; break; }
    } catch (e) {}
    await sleep(250);
  }
  if (!ready) { try { px.server.close(); } catch {} return { name: '真对话两轮', skip: '页面没起来' }; }

  /**
   * 【2026-11-11 parity-fixer 修·判重把「前几次跑的历史」当成了重画】
   *
   * 现场（run-all-checks 里第三次尝试红的那份日志，全文见
   * %TEMP%/xy-runall-logs/50-check-no-spontaneous-dup.mjs.log）：
   *   · 违规帧：`两个气泡开头一样（2 个）：QAT01END（把三个标记重新摆好`
   *   · 同一帧：`assistant 容器 4 个（其中直播 0 个）`，四个容器全是 [历史]
   *   · 同一份日志第 33 行：`屏幕上的次数 == 落盘次数 ✔` —— 一个字都没被多画
   *
   * 病根：这个脚本默认连跑 3 次（attempts=3，因为老 bug 是间歇性的），
   * 三次**共用同一间屋子**（每次只 Page.navigate，会话还是服务端 lastSessionId 那个）。
   * 于是第 3 次开始时屏幕上已经躺着前两次的 4 条回答；而模型的措辞高度一致，
   * 第 3 次的回答前 40 字跟第 1 次几乎一字不差 → 被「两个气泡开头一样」判成重画。
   * 那是**两次不同的发言**，不是同一个气泡被贴了两遍。
   *
   * 修法：把「这一次跑之前屏幕上就有的气泡」记成基线，判重时排除它们。
   * 判的仍然是「这次跑的过程中有没有长出第二个一模一样的」—— 本意没变，
   * 只是不再把上一轮的历史算进这一轮的账。
   * （为什么不用「新建一间屋子」：页面开局认的是设备本地 lastSessionId，
   *   `switchSessionSafe` 没暴露到 window，脚本改不了它开哪间屋子。基线更稳。）
   */
  const baseline = new Set();
  try {
    const pre = await cdp.eval(
      'return [].slice.call(document.querySelectorAll("#log .msg.assistant .bubble"))'
      + '.map(function (b) { return String(b.textContent || "").replace(/\\s+/g, ""); });',
    ).catch(() => []);
    for (const t of (pre || [])) if (t) baseline.add(t);
    if (baseline.size) console.log('  基线：这次跑之前屏幕上已有 ' + baseline.size + ' 条历史气泡（判重时排除）');
  } catch { /* 抓不到基线就当空的：退化成原来的严格口径，宁可多报也不漏报 */ }

  const navBefore = await cdp.eval('return (performance.getEntriesByType("navigation")||[]).length;');
  const samples = [];
  const prompts = [
    '请分三段回答，每段单独一行、段与段之间空一行。第一段必须以 QAT01END 开头，第二段以 QAT02END 开头，第三段以 QAT03END 开头。每段两三句话。不要用代码块。',
    '再来一次，同样分三段：第一段以 QAT04END 开头，第二段以 QAT05END 开头，第三段以 QAT06END 开头。每段两三句话，不要用代码块。',
  ];
  for (let turn = 0; turn < prompts.length; turn++) {
    const tok = 'QAT0' + (turn * 3 + 1) + 'END';
    await cdp.eval('window.__t = window.runTurn({ text: ' + JSON.stringify(prompts[turn]) + ' }); return 1;').catch(() => {});
    const t0 = Date.now();
    let idle = 0;
    while (Date.now() - t0 < 90000) {
      const s = await cdp.eval('return ' + SNAP + ';').catch(() => null);
      if (s) {
        s.at = Date.now() - t0; s.turn = turn + 1;
        /* 第一次发现重复，立刻把「屏幕上到底有几个容器、各是什么」抓下来 —— 这就是定位证据 */
        if (!s.diag && containersWith(s.asst, tok) > 1) {
          s.diag = await cdp.eval('return (function(){ var lg=document.getElementById("log"); return [].slice.call(lg.querySelectorAll(".msg.assistant")).map(function(m){ return { live: m.dataset.liveTurn === "1", n: String(m.textContent||"").replace(/\\s+/g,"").length, head: String(m.textContent||"").replace(/\\s+/g,"").slice(0,26) }; }); })();').catch(() => null);
        }
        samples.push(s);
      }
      const busy = s ? s.busy : true;
      if (!busy && Date.now() - t0 > 3000) { idle++; if (idle >= 4) break; } else idle = 0;
      await sleep(120);
    }
    await sleep(1500);
  }
  const navAfter = await cdp.eval('return (performance.getEntriesByType("navigation")||[]).length;').catch(() => navBefore);
  try { px.server.close(); } catch {}

  const toks = ['QAT01END', 'QAT02END', 'QAT03END', 'QAT04END', 'QAT05END', 'QAT06END'];
  const violations = [];
  for (const s of samples) {
    /* 【容器级判据：两个气泡的「开头」不许一模一样 —— 2026-11-09 第三次修正，这次想清楚了】
     *
     * 试过两种都不对：
     *   · 数「token 在几个容器里」→ 跨轮会长假红。两个 prompt 都带 QAT01END 这种标记，
     *     第 2 轮她顺口提一句「上次那个 QAT01END」很正常，那不是重复、是新说的一句话。
     *     （实测把 3 个容器判成红，其实分别是第 1 轮、第 2 轮、收尾语。）
     *   · 数「整屏文字里出现几次」→ 思考块复述指令 + 提示词本身就带 token，全是假红。
     *
     * 真正要抓的那个 bug（#14）是：**同一段话被整段又贴了一遍**。
     * 它的指纹非常明确 —— 两个气泡的**前 40 个字完全相同**。
     * 不同的轮次几乎不可能前 40 字一字不差，所以这条判据既准又不误伤。
     */
    /* 只算「这次跑出来的」气泡：基线（跑之前就有的历史）里的原文一律排除，
     * 理由见上面 baseline 那段注释 —— 那是上一次尝试说过的话，不是重画。 */
    const fresh = (s.asst || []).filter((x) => !baseline.has(norm(x.text)));
    const heads = fresh
      .map((x) => String(x.text || '').replace(/^(小鱼|主人|小鲸)/, '').slice(0, 40))
      .filter((h) => h.length >= 20);
    const seenHead = new Map();
    for (const h of heads) seenHead.set(h, (seenHead.get(h) || 0) + 1);
    for (const [h, n] of seenHead) {
      if (n > 1) violations.push({ at: s.at, turn: s.turn, kind: '两个气泡开头一样（' + n + ' 个）：' + h.slice(0, 18) });
    }
    const ed = exactDup(fresh);
    if (ed.length) violations.push({ at: s.at, turn: s.turn, kind: '两条一样的气泡 ' + ed.join('|') });
  }
  const hit = toks.filter((t) => samples.some((s) => s.all.indexOf(t) >= 0));
  /* 【真对话专用·判据修正——2026-11-09 收口后这一条连栽两次，必须写清】
   *
   * 判据：屏幕上某个 token 的最多次数，必须 == 它在这轮**落盘正文**里出现的次数。
   *
   * 假红来源有三处，这里逐条堵上：
   *   ① **提示词里就写着 token 本身** —— 主人那句必须算进来，否则屏幕上的那 1 次
   *      会被当成「多出来的」。
   *   ② **思考块也算「屏幕上」** —— `details.think` 里的正文同样是可见文字，而模型
   *      经常在 reasoning 里把「每段以 QAT01END 开头」这条指令复述两三遍。
   *      所以基准必须把 reasoning 也加进来（否则屏幕上 6 次、基准 2 次，全是假红）。
   *      但——它只在**思考块展开**时可见，`#log` 的 textContent 抓得到它；
   *      所以「屏幕」这一侧我也只在**正文气泡**里数（见下），两边口径才对齐。
   *   ③ 只数 `all`（整屏文字）会把「气泡 + 思考块 + 用量行」全算一遍，重复计数。
   *
   * 现在两侧都只数**正文**：
   *   屏幕侧 = `.msg.assistant .bubble` 的合并文字（思考块、工具卡、用量行都不算）
   *   基准侧 = 落盘里 assistant 的 `text`（不含 reasoning）
   * 这才是「她说的话有没有被贴两遍」——正是主人报的那个症状。
   * 思考块自己的重复由 check-think-* 那几条管，不在这条里管。 */
  let extra = [];
  try {
    const sid = await cdp.eval('return window.sessionId || "";').catch(() => '');
    const sel = await fetch(apiBase + '/api/sessions/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: sid }),
    }).then((r) => r.json()).catch(() => null);
    const turns = (sel && sel.session && sel.session.turns) || [];
    /* 基准：她说的正文 + 主人那句（提示词里就有 token） */
    const histText = norm(turns.map((x) => (x && x.role === 'assistant' ? String(x.text || '') : String((x && x.text) || ''))).join(' '));
    for (const t of toks) {
      const want = countTok(histText, t);
      const got = Math.max(0, ...samples.map((s) => countTok(s.bubbleText || '', t)));
      if (got > want) extra.push(t + '：正文气泡里最多 ' + got + ' 次，落盘只有 ' + want + ' 次');
    }
  } catch (e) { /* 拉不到历史就只报容器级 */ }

  /* 把「第一次重复前后」那几帧的容器数 / 字数列出来 —— 是「一个气泡里叠了 N 遍」
   * 还是「长出 N 个气泡」，一眼就能看出来 */
  const series = [];
  for (const s of samples) {
    const n = countTok(s.all, toks[0] || '');
    if (n > 1 || series.length) {
      series.push({ at: s.at, turn: s.turn, n, asstCount: s.asstCount, live: s.liveCount,
        len: (s.asst[0] ? String(s.asst[0].text || '').length : 0) });
      if (series.length >= 8) break;
    }
  }
  const firstDiag = (samples.find((s) => s.diag) || {}).diag || null;
  const firstBad = samples.find((s) => toks.some((t) => containersWith(s.asst, t) > 1)) || null;
  return {
    name: '真对话两轮（真模型）', samples: samples.length, violations, hit, toks, extra,
    maxLive: Math.max(0, ...samples.map((s) => s.liveCount || 0)),
    navOk: navAfter === navBefore, interjOk: state.interjects === 0, ms: 0,
    series, diag: firstDiag, badAt: firstBad ? { turn: firstBad.turn, at: firstBad.at, asstCount: firstBad.asstCount, live: firstBad.liveCount } : null,
  };
}

/* ── 5. 主流程 ── */
let iso = null;
let cdp = null;
let fails = 0;
try {
  const pub = preparePublic();
  console.log('前端来源：' + pub.from);
  iso = await startIsolated();
  console.log('隔离实例：' + iso.base);
  cdp = await connect({ port: iso.cdpPort });
  const base = { pubDir: pub.dir, apiBase: iso.base };

  if (!EXPLORE && !args.includes('--shapes')) {
    console.log('');
    /* 【为什么跑 3 次】这个 bug 是**间歇性**的（跟真模型的分块密度有关）：
     * 实测 4 次里 3 次复现（2×/4×/6×）、1 次干净。跑一次就判绿会把真问题漏掉，
     * 所以默认连跑 3 次，**任何一次出现重复就判红**，并报「第几次撞上」。 */
    const ATTEMPTS = Number(argOf('attempts', '3')) || 3;
    console.log('真对话模式（真服务端 + 真模型，连两轮 × 最多 ' + ATTEMPTS + ' 次）');
    let r = null;
    let hitAt = 0;
    for (let a = 1; a <= ATTEMPTS; a++) {
      r = await runReal(cdp, pub.dir, iso.base);
      if (r.skip) { console.log('  跳过：' + r.skip); r = null; break; }
      const bad = r.violations.length || (r.extra && r.extra.length);
      console.log('  第 ' + a + ' 次：取样 ' + r.samples + ' 帧，'
        + (bad ? '✘ 出现重复（' + ((r.extra && r.extra[0]) || (r.violations[0] && r.violations[0].kind) || '') + '）' : '✔ 干净'));
      if (bad) { hitAt = a; break; }
    }
    if (r) {
      console.log('  取样 ' + r.samples + ' 帧；出现过的段落标记：' + (r.hit.join(',') || '（一个都没有，模型没照做）'));
      console.log('  不 reload：' + (r.navOk ? '是' : '否！') + '；不 interject：' + (r.interjOk ? '是' : '否！'));
      if (r.violations.length) {
        console.log('  违规 ' + r.violations.length + ' 帧：');
        for (const v of r.violations.slice(0, 6)) console.log('    · 第 ' + v.turn + ' 轮 第 ' + v.at + 'ms：' + v.kind);
        if (r.badAt) console.log('  第一次出现时：第 ' + r.badAt.turn + ' 轮 第 ' + r.badAt.at + 'ms，'
          + 'assistant 容器 ' + r.badAt.asstCount + ' 个（其中直播 ' + r.badAt.live + ' 个）');
        if (r.diag) {
          console.log('  那一刻屏幕上这些 assistant 容器（live=是不是这一轮的直播节点）：');
          for (const d of r.diag.slice(0, 12)) console.log('    ' + (d.live ? '[live]' : '[历史]') + ' ' + String(d.n).padStart(4) + ' 字  ' + d.head);
          if (r.diag.length > 12) console.log('    …还有 ' + (r.diag.length - 12) + ' 个');
        }
      } else console.log('  没有重复 / 没有堆叠 ✔');
      console.log('  流式期间最多 ' + (r.maxLive || 0) + ' 个直播气泡');
      if (r.series && r.series.length) {
        console.log('  第一次重复前后那几帧（标记1=QAT01END 出现次数 / 容器数 / 首个容器字数）：');
        for (const x of r.series) console.log('    第' + x.turn + '轮 ' + String(x.at).padStart(6) + 'ms  标记1×' + x.n
          + '  容器 ' + x.asstCount + '（直播 ' + x.live + '）  首容器 ' + x.len + ' 字');
      }
      if (r.extra && r.extra.length) {
        console.log('  【重画证据】屏幕上比落盘多出来的（第 ' + hitAt + ' 次撞上）：');
        for (const x of r.extra) console.log('    · ' + x);
        fails++;
      } else console.log('  屏幕上的次数 == 落盘次数（没有被重画多出来的）✔');
      if (r.violations.length || !r.navOk || !r.interjOk) fails++;
    }
    console.log('');
    console.log('结果: ' + (fails ? fails + ' 出问题' : '干净'));
    if (fails) process.exitCode = 1;
    throw { handled: true };
  }

  const list = EXPLORE ? shapes() : shapes().slice(0, 1);   // 默认只跑基线那条（A）；--explore 全跑
  const results = [];
  for (const sh of list) {
    process.stdout.write((sh.name + ' ').padEnd(46, '·'));
    const r = await runShape(cdp, base, sh, { tag: 'x' });
    results.push(r);
    if (r.skip) { console.log(' 跳过：' + r.skip); continue; }
    const bad = r.violations.length || !r.segOk || !r.navOk || !r.interjOk;
    console.log(bad ? ' ✘ 出问题' : ' ✔ 干净');
  }

  console.log('\n==== 明细 ====');
  for (const r of results) {
    if (r.skip) { console.log('\n' + r.name + '：跳过（' + r.skip + '）'); continue; }
    console.log('\n' + r.name);
    console.log('  取样 ' + r.samples + ' 帧 / ' + (r.ms / 1000).toFixed(1) + 's；'
      + '流式期间最多 ' + r.finalSeg + ' 个直播气泡（应为 ' + r.expectSeg + '），收尾后归历史 ' + r.finalAsst + ' 个'
      + (r.segOk ? '' : '  ← 段数不对（少了=堆一块，多了=多画一份）'));
    console.log('  不 reload：' + (r.navOk ? '是' : '否！') + '；不 interject：' + (r.interjOk ? '是' : '否！'));
    if (r.violations.length) {
      const uniq = new Map();
      for (const v of r.violations) {
        const k = v.kind + (v.tok ? '[' + v.tok + ']' : '');
        if (!uniq.has(k)) uniq.set(k, v);
      }
      console.log('  违规 ' + r.violations.length + ' 帧，去重后 ' + uniq.size + ' 类：');
      for (const [k, v] of uniq) console.log('    · ' + k + '（最早出现在第 ' + v.at + 'ms）');
    }
    if (r.violations.length || !r.segOk || !r.navOk || !r.interjOk) fails++;
  }

  console.log('\n结果: ' + (results.length - fails - results.filter((r) => r.skip).length)
    + ' 干净 / ' + fails + ' 出问题 / ' + results.filter((r) => r.skip).length + ' 跳过');
} catch (e) {
  if (!(e && e.handled)) {
    fails++;
    console.log('\n跑挂了：' + (e && e.stack ? e.stack : e));
  }
} finally {
  try { cdp && cdp.close(); } catch {}
  try { iso && await iso.stop(); } catch {}
}
process.exit(fails ? 1 : 0);
