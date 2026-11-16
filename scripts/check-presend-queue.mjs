/**
 * check-presend-queue.mjs — 守「插话预发送」这条链（主人 2026-11-15 钦定）。
 *
 * 口径（主人原话）：
 *   「点击【发送】后不立即发送插话消息，而是先进入预发送状态，
 *     待当前轮次结束后自动发送；预发送阶段可以直接发送、编辑或删除该消息。
 *     仅【发送】按钮触发的插话消息进入预发送流程，键盘回车仍保持直接发送插话。」
 *
 * 【为什么要有这一份】
 * 这条规矩被改歪过一次：2026-11-12 把按钮在跑时的分派从「入队」改成了
 * 「开缓冲窗，到点 busy 就 interject」，于是主人这次又撞上——
 * 「我在跑的时候点发送，它直接插进去了，不是排队」。
 * 光靠注释拦不住人，得有断言。
 *
 * 纯静态（读 public/index.html 源码），真交互由 check-presend-e2e.mjs 用真浏览器点。
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/** 按名字抓一个函数体（function 声明或 `名字 = (...) => {`），大括号配平 */
function bodyOf(name) {
  const pats = [
    new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{'),
    new RegExp('\\b' + name + '\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*\\{'),
  ];
  let at = -1;
  for (const p of pats) { const m = p.exec(src); if (m) { at = m.index + m[0].length - 1; break; } }
  if (at < 0) return '';
  let d = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(at, i + 1); }
  }
  return '';
}

/* ── ① 按钮：忙 → 入队（不是插话、不是缓冲窗） ───────────────────── */
const buffered = bodyOf('sendBuffered');
ok('sendBuffered 抓到了', buffered.length > 100, '抓不到说明函数被改名了');
ok('点【发送】时在跑 → 进预发送队列（queueFromInput）',
  /if\s*\(\s*busy\s*\)\s*\{[\s\S]{0,400}?queueFromInput\s*\(/.test(buffered),
  '它得在 busy 分支里收进队列，否则又变成「忙时直接插话」');
ok('点【发送】在跑时**不许**走 interject',
  !/if\s*\(\s*busy\s*\)\s*\{[\s\S]{0,400}?interject\s*\(/.test(buffered),
  '按钮的忙分支里出现了 interject，说明预发送又被改回插话了');

/* ── ② 回车：忙 → 直接插话（原样保留） ─────────────────────────── */
const sendBody = bodyOf('send');
ok('send() 抓到了', sendBody.length > 100);
ok('回车在跑时仍然是直接插话（if (busy) return interject()）',
  /if\s*\(\s*busy\s*\)\s*return\s+interject\s*\(\s*\)/.test(sendBody),
  '回车这条是主人明确要保留的「直接发插话」，不许改');

/* ── ③ 缓冲窗到点时她若在跑：入队，不插话 ───────────────────────── */
const holdFire = bodyOf('_holdFire');
ok('_holdFire 抓到了', holdFire.length > 100);
ok('缓冲窗到点、她还在跑 → 入队（enqueueMessage）',
  /if\s*\(\s*busy\s*\)\s*\{[\s\S]{0,600}?enqueueMessage\s*\(/.test(holdFire));
ok('缓冲窗到点不许再 interject（那是插话，不是预发送）',
  !/if\s*\(\s*busy\s*\)\s*\{[\s\S]{0,600}?interject\s*\(/.test(holdFire));

/* ── ④ 队列本身的五件套 ─────────────────────────────────────────── */
ok('入队：enqueueMessage', /function enqueueMessage\s*\(/.test(src));
ok('渲染：renderPendingQueue 画到 #pendingQueue', /function renderPendingQueue\s*\(/.test(src) && /getElementById\('pendingQueue'\)/.test(src));
ok('立即发送：sendPendingNow', /function sendPendingNow\s*\(/.test(src));
ok('编辑：editPending 把内容搬回输入框', /function editPending\s*\(/.test(src) && /input\.value\s*=\s*String\(it\.text/.test(src));
ok('删除：removePending', /function removePending\s*\(/.test(src));
ok('轮末自动发：flushPendingQueue', /function flushPendingQueue\s*\(/.test(src));

/* ── ⑤ 驱动：2 秒轮询「不忙了 + 有货 → flush」 ──────────────────── */
ok('2 秒轮询在，且判据是「不忙 + 有货」',
  /setInterval\s*\(\s*\(\)\s*=>\s*\{[\s\S]{0,900}?if\s*\(!busy\s*&&\s*!_flushingPending\s*&&\s*pendingQueue\.length\)\s*flushPendingQueue\s*\(\)/.test(src),
  '「轮次结束后自动发送」全靠这一拍兜，掉了就永远不发');

/* ── ⑥ 状态显示：跑着 / 闲着的文案不一样 ────────────────────────── */
ok('队列头文案区分「她这轮说完自动发」和「马上发出」',
  /她这轮说完自动发/.test(src) && /马上发出/.test(src));
ok('忙碌状态变化时重画队列（文案会跟着换）',
  /_pendingBusyShown\s*!==\s*busy/.test(src));

/* ── ⑦ 落盘：刷新/重启不丢（按会话分 key） ─────────────────────── */
ok('队列按会话存在 localStorage', /function pendingStoreKey\s*\(/.test(src) && /xy_pending_/.test(src));

console.log('\n插话预发送：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
