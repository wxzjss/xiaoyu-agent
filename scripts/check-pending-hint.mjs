/**
 * check-pending-hint.mjs — 守「忙时消息进队列」这条链的零件都在。
 * 【2026-11-12 改】断言认现在的写法（sendBuffered / queueFromInput）。
 * 【2026-11-12 二次改·主人报了「按回车还出预发送金框」】回车/发送在忙时
 * 改成直接插话 interject()，不再走 queueFromInput()。原来那条「必须调
 * queueFromInput」的断言成了过期规矩，改成守「忙时直接插话」。
 */
import { readFileSync } from 'node:fs';

const s = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const bads = [];
const oks = [];
const ok = (t) => oks.push(t);
const bad = (t, d) => bads.push({ t, d });

const nInter = (s.match(/else interject\(\)|if \(!busy\) send\(\);|interject\(\);/g) || []).length;
if (nInter >= 1) ok(`忙时直接插话（interject 调用 ${nInter} 处）`);
else bad('忙时点【发送】/回车都在跑时直接插话', 'interject 调用 0 处');

const nQueueCall = (s.match(/return queueFromInput\(\);/g) || []).length;
if (nQueueCall === 0) ok('回车不再退回待发送金框（queueFromInput 调用 0 处）');
else bad('回车不再退回待发送金框', `还在调 queueFromInput ${nQueueCall} 处`);

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
