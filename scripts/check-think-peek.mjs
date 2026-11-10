#!/usr/bin/env node
/**
 * 【2026-11-09 主人报·思考时柜门标题能长满，想完就缩回一小截】
 *
 * 现象：思考过程中，柜门（toolhub）标题后面那段灰字会一路长到右边框；
 * 思考一结束，它立刻缩成短短一小截，后面空一大片。
 *
 * 【2026-11-09 换框架·判据改口径 —— 为什么老判据过时了】
 *
 * 老判据把 `hubPeekOf()` 抽出来跑：那个函数是**扫 DOM**（找 .think / .tool 元素、
 * 读它们的 textContent）来算灰字的。换 React 之后柜门由 `src-ui/ToolCard.jsx`
 * 从**数据**算，扫 DOM 那条路已经整个删掉了 —— 再去跑它，验的是一个不存在的实现。
 *
 * 现在按三处新家分别钉：
 *   ① 灰字长度：`public/ui/hub.js` 的 `thinkPeekTail`（纯函数，抽出来真跑）
 *   ② 柜门「正在X…」「调了 N 次工具」：`src-ui/ToolCard.jsx` 由 items 算
 *   ③ 收边方式：CSS 从 ellipsis 改成 clip（**这一轮的根治点**：
 *      省略号要重新测量截断点，文字一变就重排 → 鼠标停在灰字上会抖）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HUB = fs.readFileSync(path.join(ROOT, 'public/ui/hub.js'), 'utf8').replace(/\r\n/g, '\n');
const UI = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');
const TOOLCARD = fs.readFileSync(path.join(ROOT, 'src-ui/ToolCard.jsx'), 'utf8').replace(/\r\n/g, '\n');
const GRAY = fs.readFileSync(path.join(ROOT, 'src-ui/GrayText.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const t = {
  ok(name, cond, extra) {
    if (cond) { pass++; console.log('  OK  ' + name); }
    else { fail++; console.log('  [!!] ' + name + (extra ? '  →  ' + extra : '')); }
  },
};

function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error(name + ' 大括号没配平');
}

const { thinkPeekTail } = new Function(grab(HUB, 'thinkPeekTail') + '\nreturn { thinkPeekTail };')();

console.log('\n一、思考完了，灰字必须还是长的（不许缩回 30 字）');

const longThought = '我先看看这个文件里到底有没有那段逻辑，如果没有就得从头加一个判断，'
  + '而且还要考虑老数据没有这个字段的情况，不能一上来就崩。'
  + '接着我要确认一下服务端那边是不是也有同样的分支，不然只改前端等于没改。';

{
  const peek = thinkPeekTail(longThought);
  t.ok('长思考 → 灰字是长的（>60 字）', peek.length > 60, '实际 ' + peek.length + ' 字：' + peek.slice(0, 40) + '…');
  t.ok('正文一个字都没被改写（最多前面加一个 …）',
    longThought.replace(/\s+/g, ' ').trim().endsWith(peek.replace(/^…/, '')));
}

{
  t.ok('换行/多空格被压成一行', thinkPeekTail('第一行\n\n第二行   第三行') === '第一行 第二行 第三行');
  t.ok('空文本 → 空串（不画空壳）', thinkPeekTail('   ') === '');
}

{
  /* 超长只取尾巴 160 字：柜门只有一行，前面那些字本来也显示不出来 */
  const huge = '啊'.repeat(1200);
  const peek = thinkPeekTail(huge);
  t.ok('超长正文取尾巴 160 字（前面加 …）', peek.length === 161 && peek.startsWith('…'), String(peek.length));
}

console.log('\n二、柜门那一行由数据算（ToolCard.jsx），不再扫 DOM');

{
  t.ok('柜门标题：在跑的时候写「正在X…」', /'正在'\s*\+\s*\(niceTool\(running\.name, running\.args\)/.test(TOOLCARD));
  t.ok('柜门标题：平常写「调了 N 次工具」', /'调了 '\s*\+\s*n\s*\+\s*' 次工具'/.test(TOOLCARD));
  t.ok('柜门状态：失败数写「N 个失败」', /bad \+ ' 个失败'/.test(TOOLCARD));
  t.ok('灰字组件从 bridge 借 thinkPeek（同一个来源，不会两处各算一套）',
    /import \{ thinkPeek \} from '\.\/bridge\.js'/.test(GRAY) && /thinkPeek\(flat\)/.test(GRAY));
  t.ok('灰字组件 memo 住了（文案不变就不重渲染）', /memo\(function GrayPeek/.test(GRAY));
  t.ok('hub.js 里扫 DOM 的 hubPeekOf 已经空了（不再参与渲染）',
    /function hubPeekOf\(\)\s*\{\s*return '';\s*\}/.test(HUB));
}

console.log('\n三、收边方式：一行 + clip（不再是 ellipsis）');

{
  /* 换框架后的覆盖规则：灰字与柜门标题一律 nowrap + hidden + clip */
  const m = /\.hubpeek,\s*details\.think\s+\.thinkMeta,\s*details\.toolhub\s*>\s*summary\s+\.hubname\s*\{([^}]*)\}/.exec(UI);
  const css = m ? m[1] : '';
  t.ok('灰字/柜门标题统一成 nowrap + hidden + clip（不画省略号）',
    /white-space:\s*nowrap/.test(css) && /overflow:\s*hidden/.test(css) && /text-overflow:\s*clip/.test(css),
    css.replace(/\s+/g, ' ').trim().slice(0, 90) || '没找到覆盖规则');
  t.ok('这条覆盖规则排在 .hubpeek 原规则之后（后写的才生效）',
    // 取最后一处 clip：前面思考标题也有一处，第一处不代表覆盖规则的位置
    UI.lastIndexOf('text-overflow: clip') > UI.indexOf('.hubpeek {') + 30);
}

{
  t.ok('源码里不再有「思考只取 30 字」的截断',
    !/slice\(0,\s*30\)\s*\+\s*\(t\.length\s*>\s*30/.test(HUB));
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
