/**
 * 验证：worker 的事件能不能在 live items 里长出「一张带步骤的卡」。
 *
 * 【为什么要单独验】2026-11-15 主人报「子Agent 干活，点开消息展开什么都没有」。
 * 查出来是 pushWorkerEvent 把 `live.events` 当成 items 清单传给了 appendLiveItem ——
 * 事件进错了数组，items 里根本没建出 worker 卡，前端拿到的 steps 永远是空。
 * 这种错**不报任何错**，只是卡片永远空白，必须靠断言钉住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');

let pass = 0;
let fail = 0;
const one = (c, n, d = '') => {
  if (c) { pass++; console.log('  ✔ ' + n + (d ? '   ' + d : '')); }
  else { fail++; console.log('  ✘ ' + n + (d ? '   ' + d : '')); }
};

/* ① 静态：worker 通道必须把事件进 events、画面进 items */
const block = (() => {
  const i = src.indexOf('pushWorkerEvent: (sid, ev) => {');
  if (i < 0) return '';
  return src.slice(i, i + 1600);
})();
one(block.length > 0, '找到 pushWorkerEvent 通道');
one(/appendLiveItem\(live\.items, ev\)/.test(block), '画面清单用 live.items（不是 live.events）');
/* 只看真代码：把块注释剥掉再判，否则注释里提到旧写法会假红 */
const blockCode = block.replace(/\/\*[\s\S]*?\*\//g, '');
one(!/appendLiveItem\(live\.events/.test(blockCode), '没有再把 events 当 items 传（这就是那个 bug）');
one(/live\.events\.push\(ev\)/.test(block), '事件真的进了 events 数组');
one(/items: \[\]/.test(block), '新建 live 时带上 items: []（否则 appendLiveItem 直接 return）');
one(/journalLiveEvent\(sid, live, ev\)/.test(block), 'worker 进度也落盘（重启能接回）');

/* ② 行为：把两个函数抠出来真跑一遍 */
const pick = (name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let depth = 0;
  let started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  return null;
};
const fnItem = pick('appendLiveItem');
one(Boolean(fnItem), '拿到 appendLiveItem 源码');

if (fnItem) {
  const runtime = new Function(fnItem + '\nreturn appendLiveItem;')();
  const items = [];
  /* 模拟 worker 的 start + 两步 step */
  runtime(items, { type: 'worker', wid: '7', name: '工-1', kind: 'start', text: '开始干活', startedAt: 1000 });
  runtime(items, { type: 'worker', wid: '7', name: '工-1', kind: 'step', text: '第一步：读文件' });
  runtime(items, { type: 'worker', wid: '7', name: '工-1', kind: 'step', text: '第二步：改代码' });

  const card = items.find((x) => x && x.k === 'worker');
  one(Boolean(card), 'items 里长出了 worker 卡', card ? 'id=' + card.id : '没找到');
  one(Boolean(card && Array.isArray(card.steps) && card.steps.length >= 2),
    '卡上带上了步骤（展开不再空白）',
    card ? 'steps=' + (card.steps || []).length : '');
  one(Boolean(card && card.steps && card.steps.some((s) => /第一步/.test(s.t || ''))),
    '步骤内容是原文（不是空串）');

  /* end 事件要能把状态收尾 */
  runtime(items, { type: 'worker', wid: '7', name: '工-1', kind: 'end', text: '', status: 'ok', note: '干完了', endedAt: 2000 });
  const card2 = items.find((x) => x && x.k === 'worker');
  one(card2 && card2.status === 'ok', 'end 事件把状态收成 ok', card2 ? String(card2.status) : '');
}

console.log(`\n── 子Agent 卡：${pass} 过 / ${fail} 挂 ──`);
process.exit(fail ? 1 : 0);
