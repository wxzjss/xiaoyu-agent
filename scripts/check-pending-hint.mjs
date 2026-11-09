/**
 * check-pending-hint.mjs — 守两件事：
 *  ① 预发送队列：消息交给 runTurn **之前**就要摘队重画。
 *     原来等整轮跑完才摘，主人看到「明明发出去了，下面还挂着待发送」。
 *  ② 「正在发送」提示：本轮空闲时长要取「服务端 idleMs」和「本轮自己的计时」的小值。
 *     原来只看服务端那份旧数，发新消息那一瞬间会闪一句「已经 N 秒没有回音」。
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

/* ── ② 超时提示取小值 ───────────────────────────────────────── */
const hintFn = (() => {
  const j = s.indexOf('const _srvIdle');
  if (j < 0) return '';
  return s.slice(j, j + 700);
})();

if (!hintFn) bad('找得到超时提示那段', '没有 _srvIdle');
else {
  if (!/_myIdle/.test(hintFn) || !/_turnT0/.test(hintFn)) bad('本轮自己的计时也算进来', '只看服务端旧数就会闪一下');
  else ok('本轮自己的计时也算进来');

  if (!/Math\.min\(\s*_srvIdle\s*,\s*_myIdle\s*\)/.test(hintFn)) bad('两边取小值', '没取小值，旧数还是会冒出来');
  else ok('两边取小值');

  if (!/_idle > RUNNING_STALL_MS/.test(hintFn)) bad('阈值判断还在');
  else ok('阈值判断还在');
}

console.log('\n断言：' + (pass + fail) + ' 条，过 ' + pass + '，挂 ' + fail);
if (fail) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
