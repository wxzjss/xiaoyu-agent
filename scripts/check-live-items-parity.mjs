#!/usr/bin/env node
/**
 * 【QA · 2026-11-09 · 换框架后重写】「这一段算一段」的规则，几份实现必须对得上。
 *
 * ══ 换框架之后谁是「几份」══
 *
 * 旧版这个检查对了**四份**：服务端两份 + 前端两份镜像（liveItemsFeed / itemsFromEvents）。
 * 换 React 之后前端那两份**被有意删掉了** —— 数据只有一份（服务端 items），
 * 屏幕由 `src-ui/items.js` 的 `buildMerged()` 一次性算出来。所以现在要盯的是：
 *
 *   ① 服务端 `appendLiveItem`  —— 增量攒（/api/chat/live 的 items 就是它）
 *   ② 服务端 `buildLiveItems`  —— 从头重算（items 空时兜底）
 *   ③ 前端 `buildMerged()`     —— 「数据 → 屏幕上的条目」的唯一算法（React 的唯一入口）
 *
 * 三条不变式（任何一条破 = 真回归）：
 *   ①==②  同一个接口在不同时刻（items 有 / 没有）不许给出段数不同的清单
 *   ③ 忠实   清单里几段正文 → 屏幕上几个 assistant 气泡；每段只出现一次
 *   F5 一致  直播路径(①) 与 刷新路径(②) 经 ③ 之后**完全一样**
 *
 * 「断言行为，不断言实现」：这里不再要求 `itemsFromEvents` / `liveItemsFeed` 存在
 * （它们本该被删）。只要求：谁给出 items、谁能算屏幕，两边的**结果**要对得上。
 *
 * 用法：node scripts/check-live-items-parity.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'src/server.mjs'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '\n       ' + extra : '')); }
};

/** 按大括号配平抠出一个函数 */
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('源码里找不到 ' + name);
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error(name + ' 大括号没配平');
}

const srv = new Function(
  grab(SRV, 'appendLiveItem') + '\n' + grab(SRV, 'buildLiveItems')
  + '\nreturn { appendLiveItem, buildLiveItems };',
)();

/* src-ui/items.js 是 React 那一侧唯一的算法。它只在函数体里读 window，
 * 所以给一个空 window 就能在 node 里直接跑 —— 不用起浏览器。 */
globalThis.window = globalThis.window || {};
const uiMod = await import('file:///' + path.join(ROOT, 'src-ui/items.js').replace(/\\/g, '/'));
const buildMerged = uiMod.buildMerged;

function compose(events) {
  const svInc = [];
  for (const e of events) srv.appendLiveItem(svInc, e);
  return { svInc, svOne: srv.buildLiveItems(events) };
}

const J = (x) => JSON.stringify(x);
/* 【2026-11-10 A6 同步滤空】空 text（t 为空白）在两端都不再落清单 ——
 * 服务端源头已不产生，前端 liveToItems 对 say/text 对称滤空。
 * 这里的口径跟着改：textsOf 数的是「屏幕上会出现的正文段」，
 * 空段本来就不该出现，滤掉才能跟屏幕对上。 */
const textsOf = (items) => (Array.isArray(items) ? items : [])
  .filter((x) => x && x.k === 'text' && String(x.t || '').trim())
  .map((x) => String(x.t || ''));
const kindsOf = (items) => (Array.isArray(items) ? items : []).map((x) => x && x.k).join(',');

function diffSummary(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  const lines = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (J(A[i]) !== J(B[i])) lines.push('  #' + i + ' A=' + J(A[i]) + '  B=' + J(B[i]));
  }
  return lines.slice(0, 4).join('\n');
}

/** 把「服务端清单」当成屏幕上这一轮，跑 buildMerged，取出屏幕上的正文段 */
function screenOf(items, { running = true, turns = [] } = {}) {
  const snap = {
    sid: 'qa',
    turns,
    live: running ? { running: true, startedAt: 1, items } : null,
    pendingUser: null,
    notes: [],
    windowStart: 0,
  };
  const r = buildMerged(snap);
  const asst = (r.items || []).filter((x) => x && x.kind === 'assistant');
  return { res: r, asst, texts: asst.flatMap((x) => (Array.isArray(x.bubbles) ? x.bubbles : [String(x.text || '')])) };
}

/* ── 随机事件生成（固定种子，可复现） ── */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const ALL_KINDS = ['text', 'text', 'text', 'reasoning', 'tool_start', 'tool_end', 'done', 'aborted',
  'error', 'notice', 'whale', 'whale_delta', 'whale_stream_start', 'whale_stream_finish', 'worker',
  /* 【2026-11-10 A2】文件事件也在训练集里：sentfile / files 必须在两份实现里
   * 合成出逐字相同的 k:'file' 条目（折叠：同一份文件只留一条）。 */
  'sentfile', 'files', 'sentfile',
  /* 【2026-11-10 主人钦点·插话】steer 事件必须在两份实现里都合成出
   * k:'user' 条目（独立条目 = 分段线，不许并进正文）。 */
  'steer'];

function genEvents(seed, n, pool) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  const out = [];
  const words = ['好', '的', '我看一下。', ' ', '\n', 'QA', '（还在跑）'];
  const P = Array.isArray(pool) && pool.length ? pool : ALL_KINDS;
  const opened = [];
  for (let i = 0; i < n; i++) {
    let t = pick(P);
    if (t === 'tool_end' && !opened.length) t = 'tool_start';
    const burst = r() < 0.35;
    let last = null;
    if (t === 'tool_start') { const id = 't' + i; opened.push(id); last = { type: 'tool_start', id, name: pick(['run_command', 'read_file']), args: '{}' }; }
    else if (t === 'tool_end') last = { type: 'tool_end', id: opened.shift(), name: pick(['run_command', 'read_file']), ok: r() > 0.3, output: 'o' };
    else if (t === 'text') last = { type: 'text', text: pick(words) };
    else if (t === 'reasoning') last = { type: 'reasoning', text: pick(words) };
    else if (t === 'done') last = { type: 'done' };
    else if (t === 'aborted') last = { type: 'aborted' };
    else if (t === 'error') last = { type: 'error', message: 'x' };
    else if (t === 'notice') last = { type: 'text', notice: true, text: pick(words) };
    else if (t === 'whale') last = { type: 'whale', who: pick(['小鲸', '别人']), text: pick(words) };
    else if (t === 'whale_delta') last = { type: 'whale_delta', who: pick(['小鲸', '别人']), text: pick(words) };
    else if (t === 'whale_stream_start') last = { type: 'whale_stream_start', who: pick(['小鲸', '别人']) };
    else if (t === 'whale_stream_finish') last = { type: 'whale_stream_finish', text: pick(words) };
    else if (t === 'worker') last = { type: 'worker', wid: 'w' + (i % 2), name: '干活', status: pick(['run', 'ok']), kind: pick(['step', 'start', 'mail', 'note']), text: pick(words) };
    else if (t === 'sentfile') last = { type: 'sentfile', file: { path: 'D:/out/文件' + (i % 3) + '.png', name: '文件' + (i % 3) + '.png', size: 1024 * (i % 3 + 1), kind: 'image', key: 'k' + (i % 3) }, note: '' };
    else if (t === 'files') last = { type: 'files', items: [{ path: 'D:/out/文件' + (i % 3) + '.png', name: '文件' + (i % 3) + '.png', size: 1024 * (i % 3 + 1), kind: 'image', key: 'k' + (i % 3) }], at: i };
    else if (t === 'steer') last = { type: 'steer', text: pick(['插一句', '等一下', '先跑这个']), ts: 1700000000000 + i };
    if (last) out.push(last);
    if (burst && last) {
      if (last.type === 'worker') out.push({ type: 'worker', wid: last.wid, name: '干活', status: 'ok', kind: 'note', text: pick(words) });
      else if (last.type === 'whale_delta') out.push({ type: 'whale_delta', who: last.who, text: pick(words) });
      else if (last.type === 'tool_end') out.push({ type: 'tool_end', id: last.id, name: last.name, ok: true, output: 'o2' });
    }
  }
  return out;
}

console.log('\n一、边界形状：把「长得像分段线」的东西一次塞满');
const EDGE = [
  { type: 'reasoning', text: '先想想' },
  { type: 'text', text: 'A' },
  { type: 'tool_start', id: 't1', name: 'run_command', args: '{}' },
  { type: 'tool_end', id: 't1', ok: true, output: 'o' },
  { type: 'text', text: 'B' },
  { type: 'done' },
  { type: 'text', text: 'C' },
  { type: 'reasoning', text: 'R2' },
  { type: 'reasoning', text: 'R3' },
  { type: 'text', text: 'D' },
  { type: 'aborted' },
  { type: 'text', text: 'E' },
  { type: 'worker', wid: '1', name: '干活', status: 'run', kind: 'step', text: 's1' },
  { type: 'worker', wid: '1', kind: 'step', text: 's2' },
  { type: 'text', text: 'F' },
  { type: 'text', notice: true, text: '（还在跑）' },
  { type: 'text', text: 'G' },
];
{
  const c = compose(EDGE);
  ok(J(c.svInc) === J(c.svOne), '服务端：增量 == 从头重算', diffSummary(c.svInc, c.svOne));
  ok(textsOf(c.svInc).join('|') === 'A|B|C|D|E|F|G',
    '正文分成 7 段（工具 / 轮末 / 子任务 / 提示都是分段线）', textsOf(c.svInc).join('|'));
  ok(kindsOf(c.svInc) === 'think,text,tool,text,text,think,text,text,worker,text,note,text',
    '种类顺序照事件原样', kindsOf(c.svInc));
}

console.log('\n二、随机串 200 轮（固定种子）');
{
  const PUSHING = ['text', 'text', 'text', 'reasoning', 'tool_start', 'tool_end', 'done', 'aborted', 'error', 'notice'];
  const WITH_UPDATES = PUSHING.concat(['whale', 'whale_delta', 'whale_stream_start', 'whale_stream_finish', 'worker']);
  const sweep = (pool) => {
    let bad = 0;
    const cases = [];
    for (let s = 1; s <= 200; s++) {
      const c = compose(genEvents(s, 12 + (s % 25), pool));
      if (J(c.svInc) !== J(c.svOne)) {
        bad++;
        if (cases.length < 3) cases.push('seed=' + s + '\n' + diffSummary(c.svInc, c.svOne));
      }
    }
    return { bad, cases };
  };
  const a = sweep(PUSHING);
  ok(a.bad === 0, '(a) 200 串（正文/思考/工具/轮末/提示）：服务端增量 == 从头重算', a.cases.join('\n'));
  const b = sweep(WITH_UPDATES);
  ok(b.bad === 0, '(b) 200 串（含 whale*/worker 突发）：服务端增量 == 从头重算', b.cases.join('\n'));
}

console.log('\n三、最小形状：口径 + 屏幕段数');
{
  const SHAPES = [
    ['① 别人插一句之后她接着说', [{ type: 'whale_stream_start', who: '小鲸' }, { type: 'text', text: '我看一下。' }, { type: 'whale_delta', who: '小鲸', text: ' ' }, { type: 'text', text: '的' }], 1],
    ['② 工具跑完之后她接着说', [{ type: 'text', text: 'A' }, { type: 'tool_start', id: 'k', name: 'run_command', args: '{}' }, { type: 'text', text: 'B' }, { type: 'tool_end', id: 'k', ok: true, output: 'o' }, { type: 'text', text: 'C' }], 2],
    ['③ text→worker→text→worker→text', [{ type: 'text', text: 'B' }, { type: 'worker', wid: 'w1', name: '干活', status: 'run', kind: 'step', text: 's1' }, { type: 'text', text: 'C' }, { type: 'worker', wid: 'w1', status: 'ok', kind: 'note', text: '' }, { type: 'text', text: 'D' }], 2],
    ['④ text→tool_end(更新)→text→tool_end(更新)→text', [{ type: 'tool_start', id: 'k1', name: 'run_command', args: '{}' }, { type: 'text', text: 'A' }, { type: 'tool_end', id: 'k1', ok: true, output: 'o1' }, { type: 'text', text: 'B' }, { type: 'tool_end', id: 'k1', ok: true, output: 'o2' }, { type: 'text', text: 'C' }], 1],
    ['⑤ text→whale_delta→text→whale_delta→text', [{ type: 'whale_stream_start', who: '小鲸' }, { type: 'text', text: 'A' }, { type: 'whale_delta', who: '小鲸', text: ' ' }, { type: 'text', text: 'B' }, { type: 'whale_delta', who: '小鲸', text: '！' }, { type: 'text', text: 'C' }], 1],
  ];
  for (const [name, evs, wantSeg] of SHAPES) {
    const c = compose(evs);
    ok(J(c.svInc) === J(c.svOne), name + ' → 服务端两份逐字相等', diffSummary(c.svInc, c.svOne));
    const scr = screenOf(c.svInc);
    ok(textsOf(c.svInc).length === wantSeg && scr.asst.length === wantSeg,
      name + ' → 清单 ' + wantSeg + ' 段 / 屏幕 ' + wantSeg + ' 个气泡',
      '清单 ' + textsOf(c.svInc).length + ' 段 / 屏幕 ' + scr.asst.length + ' 个');
  }
}

console.log('\n三·二、小鲸一句话只许一个气泡（2026-11-10 主人报「说两遍」）');
{
  /* 现场：她一句话在事件流里是 start(空占位) → delta×N(拼字) → finish → whale(整句)。
   * 最后那条 whale 原来无条件 push 一条新 say，于是清单里两条一模一样的，
   * 屏幕就是「小鲸把同一句话说两遍」——刷新前后都在，不是前端重画的锅。
   * 这里把四种真实到达形态各钉一条，少一条都算复发。 */
  const SENT = '（尾鳍轻轻搭在地上，没动）没干啥，就在这儿待着。';
  const FLOWS = [
    ['① 纯整句（没有流式）：只出一条', [{ type: 'whale', who: '小鲸', text: SENT }], 1],
    ['② start → delta 拼满 → finish → whale 整句：只出一条',
      [{ type: 'whale_stream_start', who: '小鲸' },
        { type: 'whale_delta', who: '小鲸', text: SENT.slice(0, 10) },
        { type: 'whale_delta', who: '小鲸', text: SENT.slice(10) },
        { type: 'whale_stream_finish', who: '小鲸', text: SENT },
        { type: 'whale', who: '小鲸', text: SENT }], 1],
    ['③ start → finish 直接给整句 → whale 整句：只出一条',
      [{ type: 'whale_stream_start', who: '小鲸' },
        { type: 'whale_stream_finish', who: '小鲸', text: SENT },
        { type: 'whale', who: '小鲸', text: SENT }], 1],
    ['④ 她真说了两句不一样的话：必须两条',
      [{ type: 'whale', who: '小鲸', text: '第一句。' },
        { type: 'whale', who: '小鲸', text: '第二句。' }], 2],
  ];
  for (const [name, evs, wantSay] of FLOWS) {
    const c = compose(evs);
    const incSay = (c.svInc || []).filter((x) => x && x.k === 'say').length;
    const oneSay = (c.svOne || []).filter((x) => x && x.k === 'say').length;
    ok(incSay === wantSay, name + ' → 增量清单 ' + wantSay + ' 条 say', '实际 ' + incSay);
    ok(oneSay === wantSay, name + ' → 重算清单 ' + wantSay + ' 条 say', '实际 ' + oneSay);
    ok(J(c.svInc) === J(c.svOne), name + ' → 服务端两份逐字相等', diffSummary(c.svInc, c.svOne));
  }
}

console.log('\n四、守卫：前端不许再长出第三份合成器');
{
  /* 【2026-11-09 收口后加】
   * 旧版最痛的一条是「同一条合并规则有好几份实现，各自算各自的账」——
   * 服务端两份、前端两份，段落划分稍有不同，屏幕上就是「跑着时三个气泡、刷新变两个」。
   * 换框架后前端那两份被删了，合成只发生在服务端。这条守卫就是**别再长回来**：
   *   · src-ui/ 里不许出现 itemsFromEvents / liveItemsFeed / buildLiveItems / appendLiveItem
   *   · 也不许有人手写「把 text 事件拼成段」那套逻辑（判据：出现 `k: 'text'` 这种构造）
   * 唯一算法是 buildMerged：它只做「清单 → 屏幕条目」，不再从事件流合成。
   */
  const SRC_UI = path.join(ROOT, 'src-ui');
  const files = fs.readdirSync(SRC_UI).filter((f) => /\.(jsx?|js)$/.test(f));
  const BANNED = ['itemsFromEvents', 'liveItemsFeed', 'buildLiveItems', 'appendLiveItem'];
  const found = [];
  const constructs = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC_UI, f), 'utf8');
    for (const b of BANNED) {
      if (new RegExp('function\\s+' + b + '\\s*\\(').test(src)) found.push(f + ':' + b);
    }
    /* 手写合成器的特征：往 items 里 push 一个 {k:'text', t:...} 形状的新条目。
     * （liveToItems 是把**服务端已算好的**条目转成屏幕条目，它读 it.k === 'text'，
     *   不是自己构造，所以这条正则不会误伤。） */
    if (/\.push\(\s*\{\s*k\s*:\s*'text'/.test(src)) constructs.push(f);
  }
  ok(found.length === 0, '前端没有第二份「事件 → 条目」合成器（合成只在服务端）',
    '又长回来了：' + found.join(', '));
  ok(constructs.length === 0, '前端没有手写「把 text 拼成段」的逻辑', '命中：' + constructs.join(', '));
  /* 唯一算法：buildMerged 仍是「清单 + 历史 → 屏幕条目」的入口 */
  ok(/export function buildMerged\(/.test(fs.readFileSync(path.join(SRC_UI, 'items.js'), 'utf8')),
    '屏幕的唯一算法入口仍在（src-ui/items.js 的 buildMerged）');
}

console.log('\n五、经 React 唯一算法（buildMerged）之后：直播路径 == 刷新路径');
{
  /* 这就是「F5 前后必须是同一份」：同一串事件，
   * 直播路径拿 appendLiveItem 的 items，刷新路径拿 buildLiveItems 的 items，
   * 两条都喂给 buildMerged，屏幕上的条目必须逐字一样。 */
  let bad = 0;
  const cases = [];
  for (let s = 1; s <= 100; s++) {
    const evs = genEvents(s, 14 + (s % 20));
    const c = compose(evs);
    const live = screenOf(c.svInc);
    const fresh = screenOf(c.svOne);
    if (J(live.texts) !== J(fresh.texts)) {
      bad++;
      if (cases.length < 3) cases.push('seed=' + s + ' 直播=' + J(live.texts) + ' 刷新=' + J(fresh.texts));
    }
    /* 【别用 Set 判重】随机事件里本来就可能出现两段一模一样的文字
     * （比如两个 text 事件都是「QA」，中间隔了个工具 → 数据里就是两段同文）。
     * 那不是「画重了」，是数据本来就长这样。所以这里比的是**多重集**：
     * 屏幕上正文的数量与内容，必须与清单里的正文一条不差。 */
    const svTexts = textsOf(c.svInc);
    if (live.texts.length !== svTexts.length
      || J(live.texts.slice().sort()) !== J(svTexts.slice().sort())) {
      bad++;
      if (cases.length < 3) cases.push('seed=' + s + ' 屏幕=' + J(live.texts) + ' 清单=' + J(svTexts));
    }
  }
  ok(bad === 0, '100 串：直播路径 == 刷新路径，且每段只出现一次', cases.slice(0, 3).join('\n'));
}

console.log('\n六、屏幕段数 == 清单正文条数；同一份数据画 100 次一模一样');
{
  const evs = [];
  for (let n = 1; n <= 60; n++) {
    evs.push({ type: 'text', text: n + '.' });
    if (n % 5 === 0) { evs.push({ type: 'tool_start', id: 'c' + n, name: 'run_command', args: '{}' }); evs.push({ type: 'tool_end', id: 'c' + n, ok: true, output: '' }); }
    if (n % 17 === 0) evs.push({ type: 'done' });
  }
  const c = compose(evs);
  ok(J(c.svInc) === J(c.svOne), '60 段正文 + 12 次工具 + 3 次轮末：服务端两份相等', diffSummary(c.svInc, c.svOne));
  const nText = textsOf(c.svInc).length;
  const scr = screenOf(c.svInc);
  ok(scr.asst.length === nText, '屏幕 assistant 气泡数 == 清单正文条数（' + nText + '）',
    '屏幕 ' + scr.asst.length + ' / 清单 ' + nText);
  const first = J(scr.texts);
  let same = true;
  for (let i = 0; i < 100; i++) if (J(screenOf(c.svInc).texts) !== first) { same = false; break; }
  ok(same, '同一份清单画 100 次，屏幕内容完全一样（幂等）');
  ok(scr.texts.join('') === textsOf(c.svInc).join(''), '屏幕上正文一个字不丢、顺序不乱');
}

console.log('\n七、插话位置：消息1 → 插话 → 消息2（主人钦点的形态）');
{
  /* 主人 2026-11-10 的原话：「消息1，调用工具，在插话预发送阶段【直接发送】后
   * 并将插话显示在这个位置，收到插话内容然后消息2，调用工具」。
   * 这里钉死三件事：
   *   ① 服务端两份实现都产出 k:'user' 条目（增量 == 从头重算）
   *   ② 插话是独立分段线，不并进她正在说的正文
   *   ③ 屏幕顺序：她消息1 → 工具 → 插话 → 她消息2 → 工具
   */
  const STEER = [
    { type: 'text', text: '消息1' },
    { type: 'tool_start', id: 't1', name: 'run_command', args: '{}' },
    { type: 'tool_end', id: 't1', ok: true, output: 'o' },
    { type: 'steer', text: '插一句：先跑这个', ts: 1700000000000 },
    { type: 'text', text: '消息2' },
    { type: 'tool_start', id: 't2', name: 'run_command', args: '{}' },
    { type: 'tool_end', id: 't2', ok: true, output: 'o' },
  ];
  const c = compose(STEER);
  ok(J(c.svInc) === J(c.svOne), '插话：服务端增量 == 从头重算', diffSummary(c.svInc, c.svOne));
  ok(kindsOf(c.svInc) === 'text,tool,user,text,tool', '种类顺序：正文1 → 工具 → 插话(user) → 正文2 → 工具', kindsOf(c.svInc));
  ok(textsOf(c.svInc).join('|') === '消息1|消息2', '正文被插话劈成两段（插话是分段线）', textsOf(c.svInc).join('|'));

  /* 屏幕顺序：把清单当直播跑一遍 buildMerged，取出「正文 / 插话」的先后 */
  const scr = screenOf(c.svInc);
  const seq = (scr.res.items || [])
    .filter((x) => x && (x.kind === 'assistant' || (x.kind === 'user' && x.steer)))
    .map((x) => (x.kind === 'assistant' ? 'A:' + (x.bubbles || []).join('') : 'U:' + String(x.text || '')));
  ok(J(seq) === J(['A:消息1', 'U:插一句：先跑这个', 'A:消息2']),
    '屏幕顺序：消息1 → 插话 → 消息2', J(seq));
  ok(scr.res.items.filter((x) => x && x.kind === 'user' && x.steer).length === 1,
    '插话在屏幕上恰好一颗气泡（不双画）');
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
