/**
 * check-unread-badge.mjs — 「回到最新」未读角标的账（2026-11-12）。
 *
 * 主人报「滚轮往以前翻时，数字一下子加一大堆」。根因是同一件新东西被记了
 * 三四次（LogView 按字数变化 +1 / tool_start +1 / text 事件 +1 / flushSpeech +1）。
 * 规矩：**角标只有一个记账人 —— LogView 的「行数变大」**，这里钉死不许回潮：
 *  ① LogView 只在 count 变大时叫 noteNewContent（不再看 lastLen 字数）；
 *  ② 事件分发里不再有 tool_start / text 的逐事件计数；
 *  ③ flushSpeech 不再 +1（只维护记号）；
 *  ④ showSending 不再 +1（你那句话本身会被行数数到）；
 *  ⑤ 'compressed' 那路保留 +1（压缩不是屏幕上的一行，它不数就没人数了）。
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log('  [ok] ' + m); } else { fail++; console.log('  [!!] ' + m + (d ? ' —— ' + d : '')); } };

const logView = readFileSync('src-ui/LogView.jsx', 'utf8');
const html = readFileSync('public/index.html', 'utf8');

ok('LogView 只认行数变大（count > prevCountRef）',
  /if \(count > prevCountRef\.current\) \{[\s\S]{0,120}noteNewContent/.test(logView));
ok('LogView 不再看 lastLen 触发计数（effect 依赖只剩 [count]）',
  !/}, \[count, lastLen\]\)/.test(logView));
ok('事件分发里没有 tool_start 逐事件 +1',
  !html.includes("if (_et === 'tool_start') { try { bumpUnseen(); } catch {} }"));
ok('事件分发里没有 text 逐事件 +1',
  !html.includes("if (_et === 'text') { try { noteNewContent(); } catch {} }"));
ok('flushSpeech 不再 +1（函数体里没有 bumpUnseen）',
  (() => {
    const i = html.indexOf('function flushSpeech()');
    const body = i >= 0 ? html.slice(i, html.indexOf('}', html.indexOf('st.counted.add', i)) + 1) : '';
    return body.length > 0 && !body.includes('bumpUnseen');
  })());
ok('showSending 不再 +1（你那句话由行数数到）',
  !/sendingHint\.classList\.add\('show'\);\s*\n\s*noteNewContent\(\);/.test(html));
ok('compressed 那路保留计数（不是屏幕行，只有它数）',
  /ev\.type === 'compressed'[\s\S]{0,400}noteNewContent\(\)/.test(html));

console.log('\n' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
