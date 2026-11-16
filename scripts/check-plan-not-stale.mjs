/**
 * 严检：清单全部打勾之后，续上/重启那几条提示里不许再出现「还剩 N 步」「从没打勾那步接着干」。
 *
 * 【为什么要这一条】
 * 2026-11-16 主人：活早就做完了，我在那儿墨迹怀疑自己没做完两个小时。
 * 根因是四条提示都在照念断点那刻的快照（resume.json 的 openSteps）：
 *   ① liveOpenSteps 里 steps.length 判真假 → 清单清空就掉回快照兜底
 *   ② 每轮开头那句无条件的「根据清单上未完成的内容决定干什么」
 *   ③ 续跑提示末尾「【重启续上·第一条】请先整理清单…」
 *   ④ 重启唤醒末尾「直接从没打勾那步接着干」
 * 清单全 done 时这四条都必须变成「已经做完了，别翻旧账」。
 *
 * 这个脚本真跑函数，不靠 grep 猜。
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fails.push(name + (detail ? ' —— ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' —— ' + detail : '')); }
}

const SRC = 'D:/小鱼Agent/src/server.mjs';
const text = readFileSync(SRC, 'utf8');

console.log('\n=== 第一组：源码结构（三条提示都必须按实时清单分流） ===');

/* ① liveOpenSteps 不许再用 steps.length 当门槛 */
const mFn = text.match(/function liveOpenSteps\([\s\S]{0,1400}?\n\}/);
ok('liveOpenSteps 存在', !!mFn);
if (mFn) {
  ok('liveOpenSteps 不再用 steps.length 判真假', !/if \(steps && steps\.length\)/.test(mFn[0]),
    '这行是「清单清空就掉回快照」的根子');
  ok('liveOpenSteps 改成 if (steps)', /if \(steps\) \{/.test(mFn[0]));
}

/* ② 每轮开头那句：不许无条件说「未完成的内容」 */
ok('每轮开头按实时清单分流（_planLine）', /let _planLine =/.test(text));
ok('全 done 时明说没有剩余步骤', /没有剩余步骤/.test(text));

/* ③ 续跑提示末尾不许写死「请先整理清单」 */
ok('续跑提示「【重启续上·第一条】」不再写死求清单',
  !/【重启续上·第一条】请先整理清单/.test(text));

/* ④ 重启唤醒末尾不许无条件催「从没打勾那步接着干」 */
const mTail = text.match(/直接从没打勾那步接着干/);
ok('「从没打勾那步接着干」只在还有剩时才说（已被 _open.length 包住）',
  !mTail || /\? '\\\\n\\\\n（直接从没打勾那步接着干/.test(text) || /\)\s*\n?\s*\? '\\\\n\\\\n（直接从没打勾那步接着干/.test(text) || /Array\.isArray\(_open\) && _open\.length[/\s\S]{0,400}直接从没打勾那步接着干/.test(text));

console.log('\n=== 第二组：真跑 liveOpenSteps 的三种状态 ===');

/* 把 liveOpenSteps 从源码里抠出来，配两个假的依赖真跑 */
const fnSrc = mFn ? mFn[0] : '';
const runLive = (steps, snapshot) => {
  let loadPlanImpl = () => ({ steps });
  if (steps === '__THROW__') loadPlanImpl = () => { throw new Error('boom'); };
  const body = fnSrc.replace(/^function liveOpenSteps\(sessionId, snapshot\) \{/, '');
  const f = new Function('loadPlan', 'return function(sessionId, snapshot) {' + body + ';');
  return f(loadPlanImpl)('sid', snapshot);
};

const snapshotOld = [{ n: 1, text: '老账一' }, { n: 2, text: '老账二' }];

/* 状态一：清单全 done —— 快照里还留着老账，也不许念 */
const allDone = runLive(
  [{ n: 1, text: 'a', status: 'done' }, { n: 2, text: 'b', status: 'done' }, { n: 3, text: 'c', status: 'skipped' }],
  snapshotOld
);
ok('清单全 done → 返回空（快照被忽略）', Array.isArray(allDone) && allDone.length === 0,
  '实际 ' + JSON.stringify(allDone));

/* 状态二：清单被清空 —— 这是原来的漏，steps=[] 也不许掉回快照 */
const cleared = runLive([], snapshotOld);
ok('清单被清空 → 返回空（不掉回快照）', Array.isArray(cleared) && cleared.length === 0,
  '实际 ' + JSON.stringify(cleared));

/* 状态三：真还有剩 —— 只报剩下的，不报快照 */
const someLeft = runLive(
  [{ n: 1, text: 'a', status: 'done' }, { n: 2, text: 'b', status: 'pending' }, { n: 3, text: 'c', status: 'doing' }],
  snapshotOld
);
ok('还有剩 → 只报剩下那两步', someLeft.length === 2 && someLeft[0].text === 'b' && someLeft[1].text === 'c',
  '实际 ' + JSON.stringify(someLeft));

/* 状态四：真读不到清单（loadPlan 抛错）→ 才拿快照兜底 */
const thrown = runLive('__THROW__', snapshotOld);
ok('读不到清单 → 快照兜底（这是唯一该用快照的时候）',
  Array.isArray(thrown) && thrown.length === 2, '实际 ' + JSON.stringify(thrown));

console.log('\n=== 第三组：清单全 done 时，提示文案里不许出现"剩余/接着干"的催命句 ===');

/* 揪出每轮那句的分流代码，模拟全 done 分支算出它给的文案 */
const mLine = text.match(/else if \(!_openNow\.length\) \{\s*_planLine = '([\s\S]{0,320}?)';/);
ok('找到 _planLine 的三分支', !!mLine);
if (mLine) {
  const allDoneMsg = mLine[1];
  ok('全 done 文案里明说「没有剩余步骤」', /没有剩余步骤/.test(allDoneMsg), allDoneMsg);
  ok('全 done 文案里明说「别再回头重做」', /别再回头重做/.test(allDoneMsg), allDoneMsg);
  ok('全 done 文案不催「往下做」', !/往下做/.test(allDoneMsg), allDoneMsg);
}

const mResumeTail = text.match(/Array\.isArray\(_open\) && _open\.length\)\s*\?\s*'([^']*)'\s*:\s*'([^']*)'/);
ok('重启唤醒文案分了「有剩 / 没剩」两支', !!mResumeTail);
if (mResumeTail) {
  const noLeftMsg = mResumeTail[2];
  ok('没剩那支明说「全部打勾做完」', /全部打勾做完/.test(noLeftMsg), noLeftMsg);
  ok('没剩那支不催「接着干」', !/接着干/.test(noLeftMsg), noLeftMsg);
}

console.log('\n────────────────────────────');
if (fails.length) {
  console.log('FAIL ' + fails.length + ' 条，PASS ' + pass + ' 条');
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
console.log('全部通过：PASS ' + pass + ' 条，FAIL 0 条');
