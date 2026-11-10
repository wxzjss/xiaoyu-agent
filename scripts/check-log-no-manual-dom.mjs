#!/usr/bin/env node
/**
 * 【2026-11-10 A8 · 规格步骤 4 的漏项补齐】#log 内不许手写 DOM —— 守卫。
 *
 * check-log-react.mjs 已经守住了大头（createRoot 接管、旧绘制函数删除、
 * appendChild/innerHTML 不指向 #log）。这个检查补的是 React 收编**第二批**
 * （A1-A4）之后新钉住的几条不变式，全部是源码层静态断言 ——
 * **故意不连 CDP**（历史教训：check 里连 CDP 会卡死全量回归 11 分钟），
 * 行为层交给 check-log-react 的隔离实例段。
 *
 * 断言清单：
 *   1. addEl 的 `(target||log).appendChild` 模式不再存在（函数已删，调用点已改
 *      走 addSysNote / store）；
 *   2. 旧滚动机制一族（stickBottom / hardScrollBottom / stickToBottom /
 *      anchorToggle）的函数名不得在 index.html / chat.js / ui/*.js 重现 ——
 *      贴底只有一个写口：src-ui/LogView.jsx；
 *   3. 文件卡旧路（placeSentCard / sentTailRow / settleSentFiles / liveBubbleHost /
 *      outCard / attachFiles / lastAssistantWrap）不得复活 —— 文件是清单条目
 *      （k:'file'），由 FileCard 照数据画；
 *   4. chat.js 的 logSetLive 必须转调 store.setLive（sid 校验 + 清账钩子只在
 *      那一份里），不许旁路直写 LOG_STATE.live；
 *   5. attach* 装饰器族白名单：index.html 里有登记注释（A5），表外的
 *      attachXxx 函数一律算违规。
 *
 * 用法：node scripts/check-log-no-manual-dom.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return ''; }
};

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '\n       ' + extra : '')); }
};

/** 把注释剥掉再判 —— 注释里提到旧函数名是正常的（我们靠注释解释为什么删） */
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}

/* log.bundle.js 是构建产物（esbuild 打包的 IIFE），不在检查范围 ——
 * 检查的是源头：index.html 的内联脚本 + public/ui 的模块源。 */
const FILES = [
  'public/index.html',
  'public/ui/chat.js',
  'public/ui/hub.js',
  'public/ui/sessions.js',
];

const stripped = {};
for (const f of FILES) stripped[f] = stripComments(read(f));
const html = stripped['public/index.html'];
const chat = stripped['public/ui/chat.js'];

console.log('\n一、addEl 那条「(target||log).appendChild」的路不再存在');
{
  const bad = FILES.filter((f) => /\(target\s*\|\|\s*log\)\s*\.appendChild/.test(stripped[f]));
  ok(bad.length === 0, '没有任何文件还有 `(target||log).appendChild`（addEl 已删）',
    bad.join(', '));
  ok(!/function\s+addEl\s*\(/.test(html), 'index.html 里没有 function addEl（调用点已改走 addSysNote / store）');
  ok(!/addEl\s*\(/.test(html), 'index.html 里没有任何 addEl( 调用残留');
}

console.log('\n二、旧滚动机制一族不许重现（贴底的唯一写口在 src-ui/LogView.jsx）');
{
  /* 函数名 / 状态位名本身当特征：注释已剥，正文里出现一次就算复活。
   * 「rememberStick / _reallyAtBottom / _bumpOncePerSpeech / SCROLL_STICK_PX /
   *   anchorToggle」是同一族的内脏，一并钉住。 */
  const NAMES = ['stickBottom', 'hardScrollBottom', 'stickToBottom', 'anchorToggle',
    'rememberStick', '_reallyAtBottom', '_bumpOncePerSpeech', 'SCROLL_STICK_PX',
    'stickIfFollowing', '__ignoreScrollUntil', '__anchorBusyUntil'];
  for (const f of FILES) {
    const hits = NAMES.filter((n) => new RegExp('\\b' + n + '\\b').test(stripped[f]));
    ok(hits.length === 0, f + ' 里没有旧滚动机制的任何残留', hits.join(', '));
  }
  /* 跳底按钮还在（幸存者二），且走的是直接跳底 */
  ok(/function\s+jumpToBottom\s*\(\)/.test(html), 'jumpToBottom 还在（跳底按钮的幸存者）');
  ok(/log\.scrollTop\s*=\s*log\.scrollHeight/.test(html), '跳底是直接 scrollTop = scrollHeight（不判断不动画）');
  /* noteNewContent 还在（幸存者一），但不许碰滚动位置 */
  const nn = /function\s+noteNewContent\s*\(\)\s*\{([\s\S]{0,300}?)\}/.exec(html);
  ok(!!nn, 'noteNewContent 还在（「底下压了几条」的计数器）');
  if (nn) {
    ok(!/scrollTop|stickToBottom|hardScrollBottom/.test(nn[1]),
      'noteNewContent 是纯计数器（不碰 log.scrollTop）', nn[1].replace(/\s+/g, ' ').slice(0, 120));
  }
}

console.log('\n三、文件卡旧路不许复活（文件 = 清单条目 k:\'file\'，FileCard 照数据画）');
{
  const GONE = ['placeSentCard', 'sentTailRow', 'settleSentFiles', 'liveBubbleHost',
    'outCard', 'attachFiles', 'lastAssistantWrap', 'sentMsgRoot', 'voiceBubble'];
  const hits = GONE.filter((n) => new RegExp('function\\s+' + n + '\\s*\\(').test(html));
  ok(hits.length === 0, 'index.html 里那一族手写文件卡函数整段没了（' + GONE.length + ' 个）',
    hits.length ? '还在：' + hits.join(', ') : '');
  const callers = GONE.filter((n) => new RegExp('\\b' + n + '\\s*\\(').test(html));
  ok(callers.length === 0, 'index.html 里也没有它们的调用点', callers.join(', '));
  /* React 侧不许再借 attachFiles（挂 .bubble 的路谁走谁没 —— mdInto 重写 innerHTML） */
  const SRC_UI = ['src-ui/LogView.jsx', 'src-ui/items.js', 'src-ui/AssistantBubble.jsx',
    'src-ui/MateBubble.jsx', 'src-ui/UserBubble.jsx', 'src-ui/store.js', 'src-ui/FileCard.jsx'];
  const uiHits = SRC_UI.filter((f) => /attachFiles|placeSentCard|sentTailRow/.test(stripComments(read(f))));
  ok(uiHits.length === 0, 'src-ui 里没有谁再调文件卡旧路', uiHits.join(', '));
  /* 数据链三件套在位：服务端合成、前端直出、FileCard 渲染 */
  const srv = read('src/server.mjs');
  ok(/k:\s*'file'/.test(srv), '服务端把文件合成 k:\'file\' 条目（appendLiveItem / buildLiveItems）');
  ok(/it\.k === 'file'/.test(read('src-ui/items.js')), '前端清单对 k:\'file\' 直出（items.js）');
  ok(/export default memo\(FileCardInner\)/.test(read('src-ui/FileCard.jsx')), 'FileCard 在位且 memo 住');
}

console.log('\n四、logSetLive 收进唯一写口（A9）');
{
  ok(/window\.__logStore\.setLive\(/.test(chat), 'logSetLive 转调 store.setLive（sid 校验 + 清账钩子都在那一份里）');
  const cut = chat.split('window.__logStore.setLive(')[0] || '';
  ok(!/LOG_STATE\.live\s*=/.test(cut.split('export function logSetLive')[1] || ''),
    'logSetLive 没有在转调 store 之前自己写 LOG_STATE.live（那会让清账钩子失效）');
  ok(/dropLandedPending/.test(read('src-ui/store.js')), 'store 里有「直播收尾撤乐观气泡」的唯一实现');
}

console.log('\n五、attach* 装饰器族白名单（A5 登记，下轮收编）');
{
  const MARK = 'attach* 装饰器族白名单';
  /* 白名单注释本体就在注释里 —— 对**原文**判，不能对剥过注释的 */
  ok(read('public/index.html').includes(MARK), 'index.html 有 attach* 白名单登记注释（A5）');
  /* 登记表里的函数必须真的还在（登记与实现对得上） */
  for (const n of ['attachRewind', 'attachEdit', 'attachBranchBtn', 'attachDelBtn',
    'attachCopyBtn', 'attachRetry', 'attachTime', 'maybeFoldBubble', 'appendTurnUsage', 'actionsOf']) {
    ok(new RegExp('function\\s+' + n + '\\s*\\(').test(html), '白名单成员在位：' + n);
  }
  /* 白名单之外不许再长出新的 attachXxx（下轮收编前冻结名单） */
  const WHITELIST = new Set(['attachRewind', 'attachEdit', 'attachBranchBtn', 'attachDelBtn',
    'attachCopyBtn', 'attachRetry', 'attachTime', 'maybeFoldBubble', 'appendTurnUsage']);
  const found = [...html.matchAll(/function\s+(attach[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
  const outlaws = found.filter((n) => !WHITELIST.has(n));
  ok(outlaws.length === 0, '没有白名单之外的 attachXxx 函数（新装饰器先登记再上岗）',
    outlaws.join(', '));
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
