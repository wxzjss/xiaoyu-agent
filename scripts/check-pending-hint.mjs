/**
 * check-pending-hint.mjs — 守两件事：
 *  ① **预发送队列必须已经彻底删掉**（主人 2026-11-11 定：忙时点【发送】/回车都直接插话）。
 *     原来这一段守的是「消息交给 runTurn 之前就要摘队重画」，那是队列还在时的口径。
 *     现在队列整段删了，反过来守：不许再出现 flushPendingQueue / pendingQueue / xy_pending_。
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

/* ── ① 预发送队列必须已经整段删掉（不许复活）───────────────────
 *
 * 主人 2026-11-11 原话：「把【预发送】机制整个删除，就按原来那个点【发送】直接插话，
 * 按回车也和点【发送】一样直接插话」。
 * 所以这里反过来钉：队列那套东西一个都不许再出现（函数、DOM、localStorage key、轮询）。
 * 同时钉住「两条路都走 interject」—— 不然哪天有人又把回车改成排队，主人会再看到两个行为。 */
{
  const leftovers = [
    ['flushPendingQueue', '队列的发送函数'],
    ['pendingQueue', '队列变量/容器'],
    ['queueFromInput', '回车收队列的函数'],
    ['xy_pending_', '队列的 localStorage key'],
    ['pendingStoreKey', '队列的存储 key 函数'],
  ].filter(([k]) => s.includes(k));
  if (leftovers.length) bad('预发送队列已彻底删除', '还有残留：' + leftovers.map(([k, d]) => k + '(' + d + ')').join('、'));
  else ok('预发送队列已彻底删除（函数 / DOM / localStorage / 轮询一个不剩）');

  /* 两条路必须都走 interject：点了发送、按了回车，忙时都是直接插话 */
  const elseInterject = (s.match(/if \(!busy\) send\(\);\s*\n\s*else interject\(\);/g) || []).length;
  if (elseInterject < 2) bad('回车忙时直接插话（两个入口都要）', '只找到 ' + elseInterject + ' 处');
  else ok('回车忙时直接插话（两个入口都是 ' + elseInterject + ' 处）');

  /* 主按钮那颗：`if (!busy) return send();` 紧跟 `return interject();` */
  if (!/if \(!busy\) return send\(\);\s*\n\s*if \(input\.value\.trim\(\) \|\| attachments\.length\) return interject\(\);/.test(s)) {
    bad('点【发送】忙时直接插话', 'sendBtn 里没走 interject');
  } else ok('点【发送】忙时直接插话');
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
