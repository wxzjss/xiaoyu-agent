#!/usr/bin/env node
/**
 * 【2026-11-09 主人报·「多段消息堆一块」「F5 之后又堆一块」根治检查】
 *
 * 病根不是某条路径忘了去重，而是**同一轮有两套画法、各记各的账**：
 *   ① 老路：SSE 收到 text / reasoning / tool_start 就 addAssistantAuto /
 *      pushStreamText / openThink / addTool **直接建节点**；
 *   ② 新路：服务端 live.items 到位后，renderLog → paintSnapshot 照清单先删后画。
 * 两条路对「一段话算一段」的判据不同 → 屏幕上两份 / 多段挤一块。
 *
 * 根治后只有一条路：事件先喂进清单（liveItemsFeed），画只由 renderLog 做。
 * 这条检查钉三件事：
 *   一、增量累积（liveItemsFeed）与一次算完（itemsFromEvents）**逐条相等**；
 *   二、同一段文字在「历史 + 直播」拼出来的屏幕上**只出现一次**；
 *   三、源码层面：SSE 段里不许再出现任何「直接建节点」的调用（防回退）。
 *
 * 不启服务、不连浏览器 —— 三份规则都是抽出来真跑的（同 check-segment-split.mjs 的手法）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const UI = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');
const CHAT = fs.readFileSync(path.join(ROOT, 'public/ui/chat.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const t = {
  ok(name, cond, extra) {
    if (cond) { pass++; console.log('  OK  ' + name); }
    else { fail++; console.log('  [!!] ' + name + (extra ? '  →  ' + extra : '')); }
  },
};

/** 从源码里按大括号配平抠出一个函数 */
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

const uiMod = new Function(
  grab(UI, 'itemsFromEvents') + '\n' + grab(UI, 'liveItemsFeed')
  + '\nreturn { itemsFromEvents, liveItemsFeed };',
)();
const { trimTurnsForLive } = new Function(
  grab(CHAT, 'trimTurnsForLive') + '\nreturn { trimTurnsForLive };',
)();

/** 增量累积：一条一条喂 */
function grow(events) {
  const st = { items: [], open: false };
  for (const e of events) uiMod.liveItemsFeed(st, e);
  return st.items;
}

const textsOf = (items) => items.filter((x) => x && x.k === 'text').map((x) => x.t);

/**
 * 屏幕上「该有的文字」= 历史（跑着的时候只画到最后一条 user）+ 直播清单的正文。
 * 这就是 renderLog（running === true）交给 DOM 的那两份东西。
 */
function screenTexts(historyTurns, items) {
  const out = [];
  for (const t2 of trimTurnsForLive(Array.isArray(historyTurns) ? historyTurns : [])) {
    if (t2 && t2.role === 'assistant') out.push(String(t2.text || ''));
  }
  for (const it of items) if (it && it.k === 'text') out.push(String(it.t || ''));
  return out;
}

/** 某段文字在屏幕上出现了几次（空白抹掉再比，跟画的时候同一套口径） */
function countOnScreen(screen, piece) {
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const want = norm(piece);
  if (!want) return 0;
  return screen.filter((s) => norm(s) === want || norm(s).includes(want)).length;
}

/** 抹掉注释再扫源码 —— 注释里写着「以前这里是 addAssistantAuto」不算回退 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

console.log('\n一、一轮的典型形状：说 → 工具 → 说 → 轮末 → 再说');

const round = [
  { type: 'reasoning', text: '先想想。' },
  { type: 'text', text: '我去看一眼。' },
  { type: 'tool_start', id: 'c1', name: 'run_command', args: '{"cmd":"ls"}' },
  { type: 'tool_end', id: 'c1', ok: true, output: 'a.txt' },
  { type: 'text', text: '看完了，没问题。' },
  { type: 'done' },
  { type: 'text', text: '下一轮接着说。' },
];
{
  const inc = grow(round);
  const one = uiMod.itemsFromEvents(round);
  t.ok('增量累积 == 一次算完（JSON 逐字相等）', JSON.stringify(inc) === JSON.stringify(one),
    JSON.stringify(inc) + ' vs ' + JSON.stringify(one));
  t.ok('正文分成三段（工具与轮末都是分段线）',
    JSON.stringify(textsOf(inc)) === JSON.stringify(['我去看一眼。', '看完了，没问题。', '下一轮接着说。']),
    JSON.stringify(textsOf(inc)));
  t.ok('顺序仍是「想 → 说 → 工具 → 说 → 说」，没被重排',
    inc.map((x) => x.k).join(',') === 'think,text,tool,text,text', inc.map((x) => x.k).join(','));
}

console.log('\n二、同一段文字在屏幕上只出现一次');

{
  /* 场景 a：服务端边跑边落盘 —— 历史里已经有本轮的前两段，直播清单里也有整轮。
   * 跑着的时候历史只画到「最后一条 user」为止，落盘那两段必须让给直播，
   * 否则屏幕上就是「同一个气泡内容出现两份」。 */
  const items = grow(round);
  const history = [
    { role: 'user', text: '帮我看看' },
    { role: 'assistant', text: '我去看一眼。' },
    { role: 'assistant', text: '看完了，没问题。' },
  ];
  const screen = screenTexts(history, items);
  for (const piece of ['我去看一眼。', '看完了，没问题。', '下一轮接着说。']) {
    t.ok('「' + piece + '」只出现一次', countOnScreen(screen, piece) === 1,
      '出现 ' + countOnScreen(screen, piece) + ' 次：' + JSON.stringify(screen));
  }
  const kept = trimTurnsForLive(history);
  t.ok('历史那条主人说的话留着（边界砍在它之后）',
    kept.length === 1 && kept[0].role === 'user' && kept[0].text === '帮我看看',
    JSON.stringify(kept.map((x) => x.role)));
  t.ok('屏幕上正文段数 == 清单里的正文条数（一段一个容器）',
    screen.length === textsOf(items).length,
    screen.length + ' 段 / 清单 ' + textsOf(items).length + ' 段');
}

{
  /* 场景 b：F5 那一刻 —— 历史里有一整段，直播清单里也有同一段（服务端边跑边落盘）。
   * 跑着的历史只画到最后一条 user，所以落盘的那段不会重复画出来。 */
  const items = [{ k: 'text', t: '这一轮已经说了这么多' }];
  const history = [
    { role: 'user', text: '开始吧' },
    { role: 'assistant', text: '这一轮已经说了这么多' },
  ];
  const screen = screenTexts(history, items);
  t.ok('F5 场景：正文只有一份', countOnScreen(screen, '这一轮已经说了这么多') === 1,
    JSON.stringify(screen));
}

{
  /* 场景 c：历史里一条 user 都没有（续跑 / 定时任务）→ 退回「只砍最后一条」的老口径，
   * 宁可多留一条也不能整屏不画。 */
  const items = [{ k: 'text', t: '续跑接着说' }];
  const history = [{ role: 'assistant', text: '续跑前说的' }, { role: 'assistant', text: '续跑接着说' }];
  const screen = screenTexts(history, items);
  t.ok('续跑场景：屏幕上不出现两份同一段', countOnScreen(screen, '续跑接着说') === 1, JSON.stringify(screen));
}

console.log('\n三、幂等：同一份清单画一百次，屏幕上的文字一个字都不多');

{
  const items = grow(round);
  const history = [{ role: 'user', text: '帮我看看' }];
  const first = screenTexts(history, items);
  let same = true;
  for (let i = 0; i < 100; i++) {
    const again = screenTexts(history, items);
    if (JSON.stringify(again) !== JSON.stringify(first)) { same = false; break; }
  }
  t.ok('画一百次，屏幕内容完全一样', same);
  /* 增量累积也必须幂等：同一串事件喂两遍到「两份不同的清单」里，结果必须一样
   * （喂进同一份当然会翻倍 —— 那不是画的问题，是同一条事件被投递两次） */
  const a = grow(round);
  const b = grow(round);
  t.ok('两次独立累积结果一致（没有隐藏状态）', JSON.stringify(a) === JSON.stringify(b));
}

console.log('\n四、长轮次：两份合成器长期等价（含轮末 / 通知 / 子任务 / 别人的话）');

{
  const evs = [];
  for (let n = 1; n <= 160; n++) {
    evs.push({ type: 'text', text: n + '. 第' + n + '句。\n' });
    if (n % 7 === 0) evs.push({ type: 'tool_start', id: 'c' + n, name: 'run_command', args: '{}' });
    if (n % 7 === 1) evs.push({ type: 'tool_end', id: 'c' + (n - 1), ok: true, output: 'ok' });
    if (n % 21 === 0) evs.push({ type: 'done' });
    if (n % 33 === 0) evs.push({ type: 'reasoning', text: '想' + n });
    if (n % 13 === 0) evs.push({ type: 'text', notice: true, text: '（还在跑）' });
    if (n % 29 === 0) evs.push({ type: 'whale', who: '小鲸', text: '我来说一句' + n });
    if (n % 40 === 0) evs.push({ type: 'worker', wid: 'w1', name: '写代码', status: 'run', kind: 'step', text: '第' + n + '步' });
  }
  const inc = grow(evs);
  const one = uiMod.itemsFromEvents(evs);
  t.ok('增量累积 == 一次算完（JSON 逐字相等）', JSON.stringify(inc) === JSON.stringify(one),
    inc.length + ' vs ' + one.length);
  const seen = new Set();
  let dup = 0;
  for (const tx of textsOf(inc)) { if (seen.has(tx)) dup += 1; seen.add(tx); }
  t.ok('清单里没有重复的正文段', dup === 0, dup + ' 段重复');
  t.ok('轮末真的断出了多段（>= 7）', textsOf(inc).length >= 7, String(textsOf(inc).length));
  t.ok('首尾都还在', textsOf(inc).join('').includes('第1句') && textsOf(inc).join('').includes('第160句'));
  /* 屏幕上：历史（只剩最后一条 user）= 空 + 清单正文 → 每段只出现一次 */
  const screen = screenTexts([], inc);
  let bad = 0;
  for (const tx of textsOf(inc)) if (countOnScreen(screen, tx) !== 1) bad += 1;
  t.ok('长轮次：每一段正文在屏幕上恰好一份', bad === 0, bad + ' 段对不上');
}

console.log('\n五、源码层面钉住「这个洞别再开」');

{
  /* ① SSE 段里不许再出现任何「直接建节点」的调用（注释抹掉再扫：
   *    注释里写着「以前这里是 addAssistantAuto」不算回退，代码里真调用才算） */
  const liveStart = UI.indexOf('const { value, done } = await reader.read()');
  const liveEnd = UI.indexOf('syncSendBtn();', liveStart);
  const liveSegRaw = (liveStart > 0 && liveEnd > liveStart) ? UI.slice(liveStart, liveEnd) : '';
  const liveSeg = stripComments(liveSegRaw);
  t.ok('找到实时流处理段', !!liveSeg, 'chars=' + liveSeg.length);
  const DOM_BUILDERS = [
    'addAssistantAuto', 'pushStreamText', 'openThink', 'addTool(',
    'whaleStreamStart', 'whaleStreamDelta', 'whaleStreamFinish', 'addWhaleBubble',
    'paintLiveEvents',
  ];
  const offenders = DOM_BUILDERS.filter((n) => liveSeg.includes(n));
  t.ok('SSE 段里没有任何直接建节点的调用', offenders.length === 0, offenders.join(', '));
  t.ok('SSE 段里没有局部 bubble / think / toolEls 句柄（第二套账）',
    !/\bconst bubble\b|\blet bubble\b|\blet think\b|\bconst toolEls\b/.test(liveSeg));

  /* ② SSE 段必须走「喂清单 + 叫画入口」这条路 */
  t.ok('SSE 段喂清单（liveItemsFeed）', /liveItemsFeed\(model, ev\)/.test(liveSeg));
  t.ok('SSE 段叫唯一画入口（liveModelPaint*）', /liveModelPaint(Throttled|Flush)?\(/.test(liveSeg));
  t.ok('SSE 段开跑时把这一屏交给 state（logBeginTurn）',
    /window\.logBeginTurn\(turnSession, currentTurns\)/.test(UI));
  t.ok('done / aborted / error 先 flush 再收尾',
    /liveModelFlush\(turnSession\)/.test(liveSeg)
    && !/logSetLive\([^)]*null/.test(liveSeg));   // 收尾不许清清单

  /* ③ 画正文那一段：一条正文一个容器（不会把两段并进一个气泡） */
  const PB = stripComments(CHAT);
  const i0 = PB.indexOf("if (it.k === 'text') {");
  const j0 = PB.indexOf("} else if (it.k === 'think') {", i0);
  const branch = (i0 >= 0 && j0 > i0) ? PB.slice(i0, j0) : '';
  t.ok('paintSnapshot0 的正文分支：一条正文只建一个容器',
    (branch.match(/addAssistantAuto\(/g) || []).length === 1, branch.slice(0, 120));

  /* ④ 快路不再「把多条正文拼成一串」 */
  const UIcode = stripComments(UI);
  t.ok('快路只认「尾巴那段在变长」',
    /lastItem\.k !== 'text'/.test(UIcode) && /wraps\.length !== textCount/.test(UIcode)
    && !/_snapTextOnly/.test(UIcode));

  /* ⑤ 只有 renderLog 能画：paintSnapshot 的定义之外只有一个调用点，且在 renderLog 里 */
  const renderLogAt = PB.indexOf('export function renderLog(opts)');
  const renderLogEnd = PB.indexOf('export function paintSnapshot(sid', renderLogAt);
  const body = (renderLogAt >= 0 && renderLogEnd > renderLogAt) ? PB.slice(renderLogAt, renderLogEnd) : '';
  const callsAll = (PB.match(/[^.\w]paintSnapshot\(/g) || []).length;
  const callsInRenderLog = (body.match(/[^.\w]paintSnapshot\(/g) || []).length;
  t.ok('paintSnapshot 只被 renderLog 调用（定义 1 处 + 调用 1 处）',
    callsAll === 2 && callsInRenderLog === 1, '总共 ' + callsAll + ' 处 / renderLog 里 ' + callsInRenderLog + ' 处');
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
