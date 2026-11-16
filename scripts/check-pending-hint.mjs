/**
 * check-pending-hint.mjs — 守「忙时消息进队列」这条链的零件都在。
 * 【2026-11-12 改】断言认现在的写法（sendBuffered / queueFromInput）。
 * 【2026-11-15 改·口径回到主人最初要的样子】
 *   按钮在跑时 → **预发送入队**；回车在跑时 → **直接插话**。
 *   原来那两条「回车不再退回待发送（queueFromInput 0 处）」是 11-12 的反向规矩，
 *   现在把正面规矩交给 check-presend-queue.mjs（更细，按函数体断言），
 *   这里只留「零件都在」这一层，免得两处各说一套。
 */
import { readFileSync } from 'node:fs';

const s = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const bads = [];
const oks = [];
const ok = (t) => oks.push(t);
const bad = (t, d) => bads.push({ t, d });

const nInter = (s.match(/if \(busy\) return interject\(\);/g) || []).length;
if (nInter >= 1) ok(`回车在跑时仍直接插话（interject 调用 ${nInter} 处）`);
else bad('回车在跑时直接插话', 'interject 调用 0 处');

const nQueueCall = (s.match(/queueFromInput\(\)/g) || []).length;
if (nQueueCall >= 1) ok(`按钮在跑时收进预发送队列（queueFromInput 调用 ${nQueueCall} 处）`);
else bad('按钮在跑时收进预发送队列', 'queueFromInput 调用 0 处');

for (const [pat, t] of [
  [/function queueFromInput\(/, '入队函数 queueFromInput 在'],
  [/pendingQueue/, '预发送队列存储在'],
  [/sendPendingNow/, '【直接发送】按钮函数在'],
  [/editPending/, '【编辑】按钮函数在'],
  [/renderPending|pendingList/, '队列渲染在'],
  [/flushPendingQueue\(\);/, '轮末 flush 调用在'],
  [/, 2000\);/, '2 秒一拍定时器在'],
  [/RUNNING_STALL_MS/, '「正在发送消息」的卡住计时在'],
]) {
  if (pat.test(s)) ok(t);
  else bad(t, 'public/index.html 里找不到 ' + pat);
}

if (!/已经 [0-9]+ 秒没有回音/.test(s.replace(/\/\*[\s\S]*?\*\//g, ""))) ok('改口已经删掉（不再说「没有回音 / 可能卡住了」）');
else bad('改口已经删掉', '文案又出现了');

for (const t of oks) console.log('  ✔ ' + t);
for (const b of bads) console.log(`  [!!] ${b.t}\n       ${b.d}`);
console.log(`\n断言：${oks.length + bads.length} 条，过 ${oks.length}，挂 ${bads.length}`);
if (bads.length) process.exit(1);
