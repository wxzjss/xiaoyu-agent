#!/usr/bin/env node
/**
 * 【2026-11-09 主人报·思考时柜门标题能长满，想完就缩回一小截】
 *
 * 现象：思考过程中，柜门（toolhub）标题后面那段灰字会一路长到右边框；
 * 思考一结束，它立刻缩成短短一小截，后面空一大片。
 *
 * 病根：思考中那段灰字取 `thinking.dataset.peek`（实时尾巴，能长满一行），
 * 思考结束 `thinking-now` 一撤，就落到 `hubPeekOf()` —— 那里写死
 * `t.slice(0, 30) + '…'`，**只留 30 个字**。
 *
 * 这条检查把 hubPeekOf 抽出来真跑（造假的 think/tool 元素），并钉住 CSS 那边
 * 仍然是「一行 + 省略号」（不截字之后必须靠它收边，否则会换行把柜门撑成两行）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HUB = fs.readFileSync(path.join(ROOT, 'public/ui/hub.js'), 'utf8').replace(/\r\n/g, '\n');
const UI = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');

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

/* 只跑 hubPeekOf；它只用到 el.classList / el.querySelector，假元素够用 */
/* hubPeekOf 依赖模块级常量 HUB_PEEK_MAX —— 抽出来单跑时要一起带上，
 * 否则 ReferenceError。值从源码里读，别在测试里写死一份（改了就对不上）。 */
const peekMax = Number((/const HUB_PEEK_MAX = (\d+);/.exec(HUB) || [])[1]) || 400;
const { hubPeekOf } = new Function(
  'const HUB_PEEK_MAX = ' + peekMax + ';\n' + grab(HUB, 'hubPeekOf') + '\nreturn { hubPeekOf };',
)();

/** 造一个假元素：classList + querySelector（按 selector 找子元素） */
function fakeEl(cls, kids = {}) {
  const set = new Set(String(cls).split(/\s+/).filter(Boolean));
  return {
    classList: { contains: (c) => set.has(c) },
    querySelector: (sel) => {
      const key = String(sel).replace(/^\./, '');
      return kids[key] || null;
    },
  };
}
const textEl = (text) => ({ textContent: String(text) });

console.log('\n一、思考完了，灰字必须还是长的（不许缩回 30 字）');

const longThought = '我先看看这个文件里到底有没有那段逻辑，如果没有就得从头加一个判断，'
  + '而且还要考虑老数据没有这个字段的情况，不能一上来就崩。'
  + '接着我要确认一下服务端那边是不是也有同样的分支，不然只改前端等于没改。';

{
  const think = fakeEl('think', { thinkBody: textEl(longThought) });
  const peek = hubPeekOf([think]);
  t.ok('长思考 → 灰字是长的（>60 字）', peek.length > 60, '实际 ' + peek.length + ' 字：' + peek.slice(0, 40) + '…');
  t.ok('内容就是思考正文，没被加省略号', !peek.endsWith('…') || longThought.endsWith('…'));
  t.ok('正文一个字都没被改写', longThought.replace(/\s+/g, ' ').trim().startsWith(peek));
}

{
  /* 换行要压成一行 —— 柜门只有一行，多行会把标题撑高 */
  const think = fakeEl('think', { thinkBody: textEl('第一行\n\n第二行   第三行') });
  t.ok('换行/多空格被压成一行', hubPeekOf([think]) === '第一行 第二行 第三行');
}

{
  /* 超长（没标点的整段）只兜底 400 字，不能把 DOM 撑爆 */
  const huge = '啊'.repeat(1200);
  const think = fakeEl('think', { thinkBody: textEl(huge) });
  const peek = hubPeekOf([think]);
  t.ok('超长正文兜底 ' + peekMax + ' 字', peek.length === peekMax, String(peek.length));
}

console.log('\n二、工具/思考混在一起时，取「最后那一条」');

{
  const tool = fakeEl('tool', { name: textEl('读取 index.html') });
  const think = fakeEl('think', { thinkBody: textEl(longThought) });
  t.ok('末尾是思考 → 取思考', hubPeekOf([tool, think]).startsWith('我先看看'));
  t.ok('末尾是工具 → 取工具名', hubPeekOf([think, tool]) === '读取 index.html');
}

{
  /* 工具在跑：柜门标题已经写「正在…」，灰字应该让位（返回「正在X…」） */
  const running = fakeEl('tool', { name: textEl('跑命令'), status: textEl('运行中') });
  t.ok('工具在跑 → 返回「正在X…」', hubPeekOf([running]) === '正在跑命令…');
}

console.log('\n三、样式那头必须还是「一行 + 省略号」');

{
  const m = /\.hubpeek\s*\{([^}]*)\}/.exec(UI);
  const css = m ? m[1] : '';
  t.ok('.hubpeek 是单行省略（nowrap + hidden + ellipsis）',
    /white-space:\s*nowrap/.test(css) && /overflow:\s*hidden/.test(css) && /text-overflow:\s*ellipsis/.test(css), css.trim().slice(0, 80));
  t.ok('.hubpeek 允许被压缩（min-width:0），长文本才能在右边框停下',
    /min-width:\s*0/.test(css));
}

{
  t.ok('源码里不再有「思考只取 30 字」的截断',
    !/slice\(0,\s*30\)\s*\+\s*\(t\.length\s*>\s*30/.test(HUB));
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
