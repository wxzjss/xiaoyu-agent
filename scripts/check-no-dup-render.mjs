#!/usr/bin/env node
/**
 * 【2026-11-09 · 换框架后重写】「同一段话在屏幕上只出现一次」+「#log 只有一个主人」
 *
 * ══ 旧版为什么必须重写 ══
 *
 * 旧版钉的是「SSE 段里不许调 addAssistantAuto / pushStreamText」「paintSnapshot 只被
 * renderLog 调用」—— 换 React 之后这些函数全被删了，检查变成在验「旧实现还在不在」，
 * 于是红。**红的原因不是产品坏了，是检查在断言实现。**
 *
 * 按「断言行为，不断言实现」重写成四条不变式：
 *
 *   ① **#log 只有一个主人**：它是 React 的挂载点，原生侧（index.html / ui/chat.js）
 *      一个节点都不许往里塞。这条替代了旧版的「paintSnapshot 只能被 renderLog 调」。
 *   ② **没有第二套账**：旧的两份前端合成器（liveItemsFeed / itemsFromEvents）
 *      和快路（tryLiveAppendFast）不许复活 —— 它们复活就意味着「两套算法各画一遍」。
 *   ③ **数据 → 屏幕是纯函数**：`buildMerged()` 画 100 次结果一模一样（幂等），
 *      且屏幕上正文的多重集 == 清单里正文的多重集（不多一份、不少一段）。
 *   ④ **跑着的时候历史让位**：服务端已经把这一轮的前半截落盘了，历史里也有；
 *      屏幕上那半截只能有一份（历史画到最后一条 user 为止，剩下的交给直播）。
 *      这条正是主人报的「同一句话出现两遍」的靶心。
 *
 * 全部可以在 node 里跑（buildMerged 只在函数体里读 window，给个空 window 就行）。
 * 不启服务、不连浏览器。
 *
 * 用法：node scripts/check-no-dup-render.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '\n       ' + extra : '')); }
};

const html = read('public/index.html');
const chat = read('public/ui/chat.js');
/** 【必须剥注释】变更说明里会写「原来是 `log.innerHTML = ''`」，不剥就会把注释里的
 * 例子当成真代码扫出来（这一版第一跑就踩了，报了 2 条假红）。 */
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const nat = stripComments(html + '\n' + chat);   // 原生侧（不含构建产物）
const ITEM_SRC = read('src-ui/items.js');

globalThis.window = globalThis.window || {};
const buildMerged = (await import('file:///' + path.join(ROOT, 'src-ui/items.js').replace(/\\/g, '/'))).buildMerged;

const J = (x) => JSON.stringify(x);
const textsOf = (items) => (Array.isArray(items) ? items : []).filter((x) => x && x.k === 'text').map((x) => String(x.t || ''));

function screen(snap) {
  const r = buildMerged(Object.assign({ sid: 'qa', turns: [], live: null, pendingUser: null, notes: [], windowStart: 0 }, snap));
  const asst = (r.items || []).filter((x) => x && x.kind === 'assistant');
  return { res: r, asst, texts: asst.flatMap((x) => (Array.isArray(x.bubbles) ? x.bubbles : [String(x.text || '')])) };
}

console.log('\n一、#log 只有一个主人（React 挂载点，原生侧不许往里塞节点）');
{
  const emptyLog = /<div id="log">\s*<\/div>/.test(html);
  ok(emptyLog, '#log 在 HTML 里是空容器（React 的挂载点）', '（它里面有东西，说明还有人手写节点）');

  /* 只认「对这个 #log 变量/元素的写操作」。CSS 里出现 #log 不算（那是样式）。 */
  const WRITES = [
    [/log\.appendChild\s*\(/, 'log.appendChild('],
    [/log\.insertBefore\s*\(/, 'log.insertBefore('],
    [/log\.replaceChildren\s*\(/, 'log.replaceChildren('],
    [/log\.innerHTML\s*=/, 'log.innerHTML ='],
    [/getElementById\(\s*['"]log['"]\s*\)\.appendChild/, "getElementById('log').appendChild"],
  ];
  const hits = WRITES.filter(([re]) => re.test(nat)).map(([, n]) => n);
  ok(hits.length === 0, '原生侧没有对 #log 的写节点操作', '命中：' + hits.join(', '));

  /* 构建产物必须存在，并且是被页面用普通 script 引进来的（bundle 不是 ES 模块） */
  const bundlePath = path.join(ROOT, 'public/ui/log.bundle.js');
  const bundleOk = fs.existsSync(bundlePath) && fs.statSync(bundlePath).size > 20 * 1024;
  ok(bundleOk, 'React 那份构建产物在（public/ui/log.bundle.js）');
  ok(/<script src="\/ui\/log\.bundle\.js"><\/script>/.test(html),
    'index.html 用普通 script 引入构建产物');
}

console.log('\n二、没有第二套账（旧的两份合成器 / 快路不许复活）');
{
  const LEGACY = ['liveItemsFeed', 'itemsFromEvents', 'paintSnapshot0', 'tryLiveAppendFast', 'paintLiveEvents'];
  const alive = LEGACY.filter((n) => new RegExp('function\\s+' + n + '\\s*\\(').test(nat) || new RegExp('function\\s+' + n + '\\s*\\(').test(fs.readdirSync(path.join(ROOT, 'src-ui')).map((f) => read('src-ui/' + f)).join('\n')));
  ok(alive.length === 0, '前端的旧合成器 / 快路都没复活', '还在：' + alive.join(', '));
  ok(/export function buildMerged\(/.test(ITEM_SRC), '屏幕只有一个算法入口：src-ui/items.js 的 buildMerged');
}

console.log('\n三、数据 → 屏幕是纯函数（幂等 + 不多不少）');
{
  const snap = {
    turns: [{ role: 'user', text: '帮我看看' }],
    live: {
      running: true, startedAt: 1,
      items: [{ k: 'text', t: '甲段' }, { k: 'tool', id: 't', name: 'run_command', status: 'ok', output: '' }, { k: 'text', t: '乙段' }],
    },
  };
  const a = screen(snap).texts;
  ok(a.length === 2, '两段正文 → 屏幕上 2 个气泡', J(a));
  let same = true;
  for (let i = 0; i < 100; i++) if (J(screen(snap).texts) !== J(a)) { same = false; break; }
  ok(same, '同一份数据画 100 次，屏幕完全一样（幂等）');
  ok(J(a) === J(textsOf(snap.live.items)), '屏幕上正文 == 清单里的正文（一条不多、一段不少）', J(a));
}

console.log('\n四、跑着的时候历史让位（同一段只能出现一份）');
{
  /* 真实场景：服务端边跑边落盘，历史里已经有这一轮的前半截；
   * 同时直播清单里也有同样那半截。屏幕上台只能看到一份。 */
  const HALF = '这一轮已经说出来的前半句';
  const snap = {
    turns: [
      { role: 'user', text: '开始吧' },
      { role: 'assistant', text: HALF },
    ],
    live: { running: true, startedAt: 1, items: [{ k: 'text', t: HALF }, { k: 'tool', id: 'x', name: 'run_command', status: 'ok', output: '' }, { k: 'text', t: '接着说的后半句' }] },
  };
  const s = screen(snap);
  const n = s.texts.filter((t) => String(t).indexOf(HALF) >= 0).length;
  ok(n === 1, '那半截在屏幕上只出现一次（历史那半截让位给直播）', '出现了 ' + n + ' 次：' + J(s.texts));
  ok(s.texts.length === 2, '屏幕上仍然只有这两段（历史不重复画）', J(s.texts));
  /* 历史那条主人说的话要留着（边界砍在它之后） */
  const userItems = (s.res.items || []).filter((x) => x && x.kind === 'user');
  ok(userItems.length === 1 && /开始吧/.test(String(userItems[0].text || '')), '主人那句历史话还在（边界砍在它之后）',
    J(userItems.map((x) => x.text)));
}

console.log('\n五、没人再自己合成 items（数据只从 /api/chat/live 来）');
{
  ok(/logSetLive\(/.test(chat) && /export function logSetLive\(/.test(chat), '写直播数据只有一条路：logSetLive');
  /* 【2026-11-10 A9 改口径】logSetLive 转调 store.setLive ——「落盘后撤乐观气泡」
   * 的清账钩子（dropLandedPending）只挂在 store 那一份里，旁路直写
   * LOG_STATE.live 会把账绕掉（跟 logSetHistory 当年「每轮两颗气泡」同病根）。 */
  ok(/function logSetLive\([^)]*\)\s*\{[\s\S]{0,600}?window\.__logStore\.setLive\(/.test(chat),
    'logSetLive 转调 store.setLive（sid 校验 + 清账钩子都在唯一写口里）');
  const _lsl = (chat.split('export function logSetLive')[1] || '').split('window.__logStore.setLive(')[0] || '';
  ok(!/LOG_STATE\.live\s*=/.test(_lsl), 'logSetLive 没有在转调 store 之前旁路写 LOG_STATE.live');
  ok(/window\.__logState = LOG_STATE/.test(chat), 'React 与 chat.js 读的是同一个对象（不是复制一份）');
  ok(!/function logSetLive\([\s\S]{0,400}(appendChild|innerHTML|insertBefore)/.test(chat),
    'logSetLive 里没有任何写节点动作');
  ok(!/items\s*\.\s*push\(\s*\{\s*k\s*:/.test(nat), '原生侧不再手工往 items 里 push（那是第二套账）');
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
