/**
 * check-pending-hint.mjs — 守两件事：
 *
 * ① **预发送队列必须在、而且接对了**
 *    主人 2026-11-12：「插话修好了那就把原来的预发送机制搞回来」。
 *    （11-11 曾要求整段删除，12 号又要回来 —— 这条断言的方向跟着翻过来了。）
 *    守四条：零件齐 / 忙时两个入口都进队列 / 队列条上的【直接发送】走 interject /
 *    轮末定时 flush 且跑去的时候绝不 flush。
 *
 * ② 「正在发送」那句改口不许回来
 *    主人 2026-11-11 要求删掉「已经 N 秒没有回音，可能卡住了」那句改口，现在它**不许存在**。
 *    但 `RUNNING_STALL_MS` 常量还要给会话列表绿点变黄用，那条守住。
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
/* 去掉注释再验「那句话有没有写进界面」——注释里提它不算（历史上就是栽在这上面：
 * 改成不剥注释之后，一句「以前这里写着…」的说明会被当成复活）。 */
const sNoComment = s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

console.log('check-pending-hint');

/* ── ① 预发送队列：在，而且接对 ─────────────────────────────── */
{
  const pieces = [
    ['pendingQueue 变量/容器', 'pendingQueue'],
    ['queueFromInput（收进队列）', 'function queueFromInput'],
    ['flushPendingQueue（轮末自动发）', 'function flushPendingQueue'],
    ['sendPendingNow（直接发送那条）', 'async function sendPendingNow'],
    ['pendingStoreKey（按会话存 localStorage）', 'function pendingStoreKey'],
    ['xy_pending_ 前缀', 'xy_pending_'],
  ];
  const missing = pieces.filter(([, k]) => !s.includes(k)).map(([n]) => n);
  if (missing.length) bad('预发送队列的零件齐了', '缺：' + missing.join('、'));
  else ok('预发送队列的零件齐了（容器 / 入队 / 轮末发 / 直接发送 / 存储 key）');

  /* 两个入口：忙时进队列（不是直接 interject） */
  const nBtn = (s.match(/if \(!busy\) return send\(\);\s*\n\s*if \(input\.value\.trim\(\) \|\| attachments\.length\) return queueFromInput\(\);/g) || []).length;
  const nEnter = (s.match(/if \(!busy\) send\(\);\s*\n\s*else queueFromInput\(\);/g) || []).length;
  if (nBtn === 1 && nEnter >= 1) ok('忙时点【发送】/回车都进队列（按钮 ' + nBtn + ' 处 + 回车 ' + nEnter + ' 处）');
  else bad('忙时点【发送】/回车都进队列', '按钮 ' + nBtn + ' 处 / 回车 ' + nEnter + ' 处');

  /* 【直接发送】必须走 interject —— 也就是修好的那条插话路 */
  const gi = s.indexOf('async function sendPendingNow');
  const goSeg = gi >= 0 ? s.slice(gi, gi + 1400) : '';
  if (/await interject\(\)/.test(goSeg)) ok('【直接发送】走的还是 interject（劈段 / 不吞正文 / 落历史还在中间，全都继承）');
  else bad('【直接发送】走 interject', 'sendPendingNow 里没看到 await interject()');

  /* 轮末定时 flush（2 秒一拍） */
  let hasTick = false;
  for (let i = s.indexOf('setInterval'); i >= 0; i = s.indexOf('setInterval', i + 1)) {
    if (s.slice(i, i + 500).includes('flushPendingQueue')) { hasTick = true; break; }
  }
  if (hasTick) ok('轮末定时 flush 还在（2 秒一拍）');
  else bad('轮末定时 flush', '没找到 setInterval → flushPendingQueue');

  /* 跑去的时候不许 flush */
  const fi = s.indexOf('function flushPendingQueue');
  const guard = 'if (_flushingPending || busy || !pendingQueue.length) return;';
  if (fi >= 0 && s.slice(fi, fi + 260).includes(guard)) ok('跑去的时候不 flush（等这一轮彻底结束）');
  else bad('running 时不 flush', 'flushPendingQueue 的守卫没找到');

  /* 队列条上三颗按钮都在 */
  const hasGo = s.includes('sendPendingNow(it.id)');
  const hasEdit = s.includes('function editPending');
  const hasDel = s.includes('function removePending');
  if (hasGo && hasEdit && hasDel) ok('队列条上【直接发送】/【编辑】/【删除】都在');
  else bad('队列条三颗按钮', 'go=' + hasGo + ' edit=' + hasEdit + ' del=' + hasDel);
}

/* ── ② 那句改口：不许回来；RUNNING_STALL_MS 要留着 ─────────────── */
{
  if (/已经\s*\d*\s*秒没有回音/.test(sNoComment)) bad('改口已经删掉（不再说「没有回音 / 可能卡住了」）', '又出现了');
  else ok('改口已经删掉（不再说「没有回音 / 可能卡住了」）');

  if (/RUNNING_STALL_MS/.test(s)) ok('RUNNING_STALL_MS 还在给会话列表黄点用');
  else bad('RUNNING_STALL_MS 被顺手删了', '会话列表的黄点会失效');

  if (s.includes('正在发送消息')) ok('「正在发送消息」还在');
  else bad('「正在发送消息」不见了', '提示行没了');
}

console.log('\n断言：' + (pass + fail) + ' 条，过 ' + pass + '，挂 ' + fail);
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
