/* 【2026-11-15】send_file 重复发同一文件 → 自动移除旧卡（主人钦点）
 * 验三处同口径去重逻辑：appendLiveItem / buildLiveItems（server.mjs）+
 * dedupeFileCards（src-ui/items.js）。同名文件常驻，正式回归进 run-all-checks。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = {
  n: 0, pass: 0,
  ok(name, cond) { this.n++; if (cond) { this.pass++; console.log('  ✔ ' + name); } else console.log('  ✘ ' + name); },
  done() { console.log(`\n${this.pass}/${this.n} 过`); process.exit(this.pass === this.n ? 0 : 1); },
};

const SERVER = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
const ITEMS = fs.readFileSync(path.join(ROOT, 'src-ui', 'items.js'), 'utf8');

/** 从源码里按大括号配对抠出一个函数体（跟 check-steer-dedupe 同款） */
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) { try { return new Function(src.slice(i, k + 1) + '\nreturn ' + name + ';')(); } catch (e) { console.log('  (grab ' + name + ' 报错: ' + e.message + ')'); return null; } }
    }
  }
  return null;
}

const appendLiveItem = grabFn(SERVER, 'appendLiveItem');
const dedupeFileCards = grabFn(ITEMS, 'dedupeFileCards');

t.ok('appendLiveItem 能从 server.mjs 抠出来跑', typeof appendLiveItem === 'function');
t.ok('dedupeFileCards 能从 items.js 抠出来跑', typeof dedupeFileCards === 'function');

/* ── ① appendLiveItem：同 fkey 旧卡被移除、新卡在尾部 ── */
if (typeof appendLiveItem === 'function') {
  const items = [
    { k: 'file', name: '提示词.txt', fkey: 'C:\\x\\提示词.txt', t: 1 },
    { k: 'text', text: '别的消息' },
  ];
  appendLiveItem(items, { type: 'sentfile', file: { name: '提示词.txt', path: 'C:\\x\\提示词.txt' }, ts: 2 });
  const fileCards = items.filter((x) => x.k === 'file' && x.name === '提示词.txt');
  t.ok('旧文件卡被移除（只剩 1 张）', fileCards.length === 1);
  t.ok('新卡在清单尾部', items[items.length - 1]?.name === '提示词.txt');
  t.ok('别的消息没被误伤', items.some((x) => x.k === 'text' && x.text === '别的消息'));

  /* 不同文件不受影响 */
  const items2 = [
    { k: 'file', name: 'a.txt', fkey: 'C:\\a.txt' },
    { k: 'file', name: 'b.txt', fkey: 'C:\\b.txt' },
  ];
  appendLiveItem(items2, { type: 'sentfile', file: { name: 'c.txt', path: 'C:\\c.txt' } });
  t.ok('发不同文件时旧卡都保留', items2.filter((x) => x.k === 'file').length === 3);

  /* 【防误删】同名但不同路径 ≠ 同一个文件，不许互相顶掉 */
  const items3 = [
    { k: 'file', name: 'x.txt', fkey: 'C:\\a\\x.txt' },
    { k: 'file', name: 'x.txt', fkey: 'C:\\b\\x.txt' },
  ];
  appendLiveItem(items3, { type: 'sentfile', file: { name: 'x.txt', path: 'C:\\c\\x.txt' } });
  t.ok('同名不同路径的三张卡互不顶掉', items3.filter((x) => x.k === 'file').length === 3);
}

/* ── ② dedupeFileCards：跨来源合并（历史轮 _out + 直播卡）只留最新 ── */
if (typeof dedupeFileCards === 'function') {
  const merged = [
    { kind: 'file', name: '提示词.txt', fkey: 'C:\\\\x\\\\提示词.txt', ts: 1 },
    { kind: 'text', text: '中间的话' },
    { kind: 'file', name: '提示词.txt', fkey: 'C:\\\\x\\\\提示词.txt', ts: 2 },
  ];
  const out = dedupeFileCards(merged);
  t.ok('跨来源同 fkey 只留最新一张', out.filter((x) => x.kind === 'file' && x.name === '提示词.txt').length === 1);
  t.ok('留下的那张是 ts 较新的', out.find((x) => x.kind === 'file')?.ts === 2);
  t.ok('text 气泡不受影响', out.some((x) => x.kind === 'text' && x.text === '中间的话'));
}

/* ── ③ 历史轮 _out 合并点：合并前先清前面消息里的同 key 旧条目 ── */
t.ok('server.mjs 落盘处有「先清历史 _out 同 key」的合并逻辑',
  SERVER.includes('自动移除旧卡片') && SERVER.includes('_newKeys'));
t.ok('三处口径都用 fkey 指纹', (SERVER.match(/fkey/g) || []).length >= 4 && (ITEMS.match(/fkey/g) || []).length >= 2);

t.done();
