/**
 * check-pending-hint.mjs — 守两件事：
 *  ① 预发送队列：消息交给 runTurn **之前**就要摘队重画。
 *     原来等整轮跑完才摘，主人看到「明明发出去了，下面还挂着待发送」。
 *  ② 「正在发送」提示只说这一句：主人 2026-11-11 要求删掉
 *     「已经 N 秒没有回音，可能卡住了」那句改口，现在它**不许存在**。
 *     但 `RUNNING_STALL_MS` 常量还要给会话列表绿点变黄用，那条守住。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'public', 'index.html');

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log('  ✔ ' + name); };
const bad = (name, why) => { fail++; console.log('  [!!] ' + name + (why ? ' —— ' + why : '')); };

if (!fs.existsSync(HTML)) {
  console.log('找不到 ' + HTML);
  process.exit(1);
}
const s = fs.readFileSync(HTML, 'utf8');

console.log('check-pending-hint');

/* ── ① 摘队发生在 await runTurn 之前 ───────────────────────── */
const fn = (() => {
  const i = s.indexOf('async function flushPendingQueue(');
  if (i < 0) return '';
  const rest = s.slice(i + 10);
  const m = rest.match(/\n(?:async\s+)?function\s/);
  return m ? s.slice(i, i + 10 + m.index) : s.slice(i, i + 5000);
})();

if (!fn) bad('找得到 flushPendingQueue');
else {
  const ixOut = fn.indexOf('pendingQueue.splice(_takenOut, 1)');
  const ixRun = fn.indexOf('await runTurn(');
  if (ixOut < 0) bad('发出前先摘队', '没找到摘队语句');
  else if (ixRun < 0) bad('发出前先摘队', '没找到 runTurn 调用');
  else if (ixOut > ixRun) bad('发出前先摘队', '摘队还在 runTurn 后面，等于没修');
  else ok('发出前先摘队（不再等整轮跑完）');

  if (!fn.includes('pendingQueue.unshift(next)')) bad('失败了要放回队列', 'catch 里没放回，主人那句话会凭空消失');
  else ok('失败了要放回队列');

  const head = fn.slice(0, Math.max(ixRun, 0));
  if (!head.includes('renderPendingQueue()')) bad('摘队后立刻重画', '没重画，界面上还挂着');
  else ok('摘队后立刻重画');
}

/* ── ② 聊天区那句改口：主人 2026-11-11 要求删掉 ─────────────────
 *
 * 原来这里断言「本轮空闲时长要取服务端 idleMs 和本轮自己计时的小值」——
 * 那是「已经 N 秒没有回音，可能卡住了」这句改口的实现细节。
 * 主人看不惯那句话，`public/index.html` 里那段取小值的逻辑连同改口一起删了，
 * 现在只剩「正在发送消息」。
 *
 * 所以断言整个反过来：**改口不许存在**（界面不许出现「没有回音」「可能卡住了」），
 * 「正在发送消息」照常。注意 `RUNNING_STALL_MS` 常量没删 —— 会话列表那颗
 * 绿点变黄还在用它，那条要守住，不能让人顺手一起删掉。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const hintBlock = (() => {
  const j = s.indexOf("const _hh = document.getElementById('sendingHint')");
  if (j < 0) return '';
  return s.slice(j, j + 900);
})();
const hintCode = stripComments(hintBlock);

if (!hintBlock) bad('找得到「正在发送消息」那段', '没有 sendingHint 的处理段');
else {
  if (!/正在发送消息/.test(hintCode)) bad('「正在发送消息」还在', '提示行被删空了');
  else ok('「正在发送消息」还在（而且是唯一那句）');

  const nag = /没有回音|可能卡住了/.exec(hintCode);
  if (nag) bad('改口已经删掉', '聊天区还会说「' + nag[0] + '」');
  else ok('改口已经删掉（不再说「没有回音 / 可能卡住了」）');

  /* 全局也不许再有把它写到界面上的代码（注释里的历史说明不算） */
  const allCode = stripComments(s);
  const nagAll = /没有回音|可能卡住了/.exec(allCode);
  if (nagAll) bad('全文件没有把改口写进界面', '还有一处：' + nagAll[0]);
  else ok('全文件没有把改口写进界面');

  /* stalled 这个类名只许「摘掉」，不许「加上」 */
  if (/classList\.add\(\s*['"]stalled['"]\s*\)/.test(allCode)) bad('不会再给提示行加 stalled 金样式', '还有 add');
  else ok('不会再给提示行加 stalled 金样式');
}

/* 会话列表的绿点/黄点还在用 RUNNING_STALL_MS —— 这个不许跟着一起删 */
if (!/const RUNNING_STALL_MS = \d+/.test(s)) bad('RUNNING_STALL_MS 常量还在', '被顺手删了，会话列表黄点会失效');
else if (!/idleMs[^\n]{0,80}RUNNING_STALL_MS/.test(s)) bad('会话列表还在按它变黄点', '常量成了摆设');
else ok('RUNNING_STALL_MS 还在给会话列表黄点用（没被顺手删掉）');

console.log('\n断言：' + (pass + fail) + ' 条，过 ' + pass + '，挂 ' + fail);
if (fail) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
