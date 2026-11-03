/**
 * 严检：清单剩余步骤的算法 —— 绝不能再把 loadPlan() 的返回值当成纯文本
 *
 * 【为什么要有这一条】
 * 2026-11-01 一天之内同一个坑踩了两次：
 *   ① /api/restart 里用 loadPlan() 切文本 → openSteps 恒为空
 *   ② resumeInterruptedTurn 里用 String(loadPlan()) → _planLeft 恒为 0
 *      → 清单上还有 8 步没做完，续跑却每次都判「清单也清空了」直接跳过
 * 病根都一样：loadPlan 返回的是对象 {goal, steps:[…]}，String(它) == "[object Object]"。
 * 这条回归把「正确算法」和「错误算法」都跑一遍，钉死差异。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const planMod = await import('file:///' + path.join(root, 'src/plan.mjs').replace(/\\/g, '/'));
const { loadPlan, planAction, planHasOpenSteps } = planMod;

let ok = 0, bad = 0;
const chk = (name, pass, extra = '') => {
  if (pass) { ok++; console.log('  ✔ ' + name + (extra ? '  ' + extra : '')); }
  else { bad++; console.log('  ✘ ' + name + (extra ? '  ' + extra : '')); }
};

const KEY = '__check_planleft__';
planAction(KEY, {
  action: 'create',
  goal: '测试用清单',
  steps: ['做完的第一步', '跳过的第二步', '还没做的第三步', '还没做的第四步', '钉死的第五步'],
});

console.log('=== 1. loadPlan 返回的是对象，不是字符串 ===');
const p = loadPlan(KEY);
chk('返回对象', p && typeof p === 'object', 'typeof=' + typeof p);
chk('有 steps 数组', Array.isArray(p && p.steps), 'length=' + (p && p.steps ? p.steps.length : 'N/A'));

console.log('=== 2. 错误写法：String(loadPlan()) ===');
const wrong = String(loadPlan(KEY) || '');
const wrongCount = wrong.split(/\r?\n/).filter((ln) => /^\s*\d+\.\s*·/.test(ln)).length;
chk('String(对象) 得到的是字面量', wrong === '[object Object]', JSON.stringify(wrong));
chk('错误写法数出来一定是 0（这正是不该用的原因）', wrongCount === 0, '数到 ' + wrongCount);

console.log('=== 3. 正确写法：读 steps 数组、按 status 数 ===');
const steps = (p && Array.isArray(p.steps)) ? p.steps : [];
// 头部三条留成未做（create 出来都是 pending），把 1、2 标成 done / skipped 做对照
if (steps[0]) steps[0].status = 'done';
if (steps[1]) steps[1].status = 'skipped';
const right = steps.filter((x) => x && x.status !== 'done' && x.status !== 'skipped');
chk('做完 / 跳过的减掉后还剩 3 步', right.length === 3, '数到 ' + right.length);
chk('done 的不算', !right.some((x) => x === steps[0]));
chk('skipped 的不算', !right.some((x) => x === steps[1]));

console.log('=== 4. planHasOpenSteps 与手算一致 ===');
chk('planHasOpenSteps 说还有没做完的', planHasOpenSteps(KEY) === true);

console.log('=== 5. 源码里不许再出现 String(loadPlan ===');
const src = fs.readFileSync(path.join(root, 'src/server.mjs'), 'utf8');
const srcLines = src.split('\n');
const offenders = [];
for (let i = 0; i < srcLines.length; i++) {
  const t = srcLines[i];
  if (/String\s*\(\s*loadPlan\s*\(/.test(t) && !/^\s*\*/.test(t)) {
    offenders.push((i + 1) + ': ' + t.trim().slice(0, 80));
  }
}
chk('没有 String(loadPlan( 的调用', offenders.length === 0, offenders.join(' | '));

console.log('=== 6. 续跑那处确实按 steps 数 ===');
const hasStepsCount = /_steps\.filter\(\(x\)\s*=>\s*x\s*&&\s*x\.status\s*!==\s*'done'\s*&&\s*x\.status\s*!==\s*'skipped'\)\.length/.test(src);
chk('resumeInterruptedTurn 用 steps 算未完成', hasStepsCount);

console.log('');
console.log('──────');
console.log('断言：' + ok + '/' + (ok + bad));
if (bad) { console.log('FAIL 有断言没过'); process.exit(1); }
console.log('PASS 全部通过');
