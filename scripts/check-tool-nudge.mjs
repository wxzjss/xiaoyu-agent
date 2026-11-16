/**
 * check-tool-nudge.mjs — 守「50 次工具调用提醒只给她本人看」。
 *
 * 主人 2026-11-16 原话：
 *   「改柜子里有 50 次工具调用开始会有的提示为仅小鱼Agent可见的系统提示，
 *     这个提示我自己不想看见」。
 *
 * 背景：11-15 那版是「两个都发」—— 屏幕推一条 notice 小条 + 给她插一条 _sysNote。
 * 现在屏幕那条删掉，只留 _sysNote（她收到会自己开口报进度，那句话才是主人该看到的）。
 *
 * 守着三件事：
 *   ① 刻度还是 50 起、每 20 次一条（主人 11-15 定的，别在修显示时顺手改掉）；
 *   ② 她说话就重新计数（不然报完一次就再也不提醒）；
 *   ③ 不往屏幕上推 notice —— 这条一回来，主人又会看见那行字。
 */
import { readFileSync } from 'node:fs';

const srv = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/* 只取 maybeNudgeProgress 的函数体（到下一个顶层 function 为止） */
const start = srv.indexOf('function maybeNudgeProgress(');
const tail = srv.indexOf('function appendLiveCache(', start);
const body = start >= 0 && tail > start ? srv.slice(start, tail) : '';

ok('找到 maybeNudgeProgress', body.length > 500, '函数体没抓到，下面的断言都不可信');

/* ① 刻度 */
ok('第 50 次开始提醒', /TOOL_NUDGE_START\s*=\s*50/.test(srv));
ok('之后每 20 次一条（不设上限）', /TOOL_NUDGE_EVERY\s*=\s*20/.test(srv));
ok('同一次刻度只提醒一次（_nudged 记账）',
  /live\._nudged\[n\]/.test(body));

/* ② 她说话就重新计数 */
ok('她说了正文就清零重数（报完一次还能再提醒）',
  /ev\.type === 'text' && !ev\.notice[\s\S]{0,200}live\._toolCalls = 0/.test(body));

/* ③ 只给她看，不画在屏幕上 */
ok('不再往 live 推 notice 小条（主人不想看见那行字）',
  !/notice:\s*true/.test(body),
  '又 push 了一条 notice → 屏幕上会重新出现「这一轮已经调了 N 次工具」');
ok('仍然给她本人插 _sysNote 系统提示',
  /steer\(sid,[\s\S]{0,400}_sysNote:\s*true/.test(body),
  '只删显示不给她提示，等于这条功能没了');
ok('整轮代码里不再有那句屏幕文案',
  !/这一轮已经调了/.test(srv),
  '留着文案模板，早晚又被谁接回去');

console.log('\n50 次提醒（只她可见）：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
