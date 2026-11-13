/**
 * 检查：子 Agent 名字必须中文（2026-11-13 主人钦点）
 * 1) name-zh.mjs 的规整逻辑
 * 2) spawn_worker / spawn_workers / ask_subagent 三个入口都过规整
 * 3) subagent.mjs 能导入（currentSessionId 没丢）
 */
import assert from 'node:assert';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const DIR = 'D:/小鱼Agent/src/';
const U = (f) => pathToFileURL(DIR + f).href;
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✔ ' + n); };
const bad = (n, e) => { fail++; console.log('  ✘ ' + n + ' → ' + e); };

console.log('=== 1. name-zh 规整 ===');
const zh = await import(U('name-zh.mjs'));
const cases = [
  ['小鲸', true, '小鲸'],
  ['查价员', true, '查价员'],
  ['', false, null],
  [null, false, null],
  ['worker-1', false, null],
  ['Agent-X', false, null],
];
for (const [inp, keep, want] of cases) {
  const r = zh.enforceZhWorkerName(inp, '工');
  try {
    assert.strictEqual(r.changed, !keep, `changed 不对（${inp}）`);
    if (keep) assert.strictEqual(r.name, want);
    else assert.match(r.name, /^工[\u4e00-\u9fa5]+$/, '改名结果必须是「工+中文数字」');
    ok(JSON.stringify(inp) + ' → ' + r.name + (r.changed ? '［改名］' : '［保留］'));
  } catch (e) { bad(JSON.stringify(inp), e.message); }
}

console.log('\n=== 2. 三个入口都接上规矩 ===');
const toolsSrc = fs.readFileSync(DIR + 'tools.mjs', 'utf8');
const checks = [
  ['spawn_worker 用 enforceZhWorkerName', /name:\s*'spawn_worker'[\s\S]{0,6000}?enforceZhWorkerName\(name/],
  ['spawn_workers 用 enforceZhWorkerName', /name:\s*'spawn_workers'[\s\S]{0,8000}?enforceZhWorkerName\(t\.name/],
  ['ask_subagent 用 enforceZhWorkerName', /name:\s*'ask_subagent'[\s\S]{0,4000}?enforceZhWorkerName\(name/],
];
for (const [n, re] of checks) {
  try { assert.match(toolsSrc, re); ok(n); } catch (e) { bad(n, '源码里没找到'); }
}

console.log('\n=== 3. 默认名不再有英文 ===');
try {
  assert.ok(!/worker-' \+ \(i \+ 1\)/.test(toolsSrc), 'spawn_workers 还在拼 worker-N');
  ok('spawn_workers 默认名不再是 worker-N');
} catch (e) { bad('默认名', e.message); }

console.log('\n=== 4. subagent.mjs 能导入（currentSessionId 在） ===');
try {
  const t = await import(U('tools.mjs'));
  assert.strictEqual(typeof t.currentSessionId, 'function', 'tools.mjs 没导出 currentSessionId');
  ok('tools.mjs 导出 currentSessionId');
} catch (e) { bad('currentSessionId', e.message); }
try {
  await import(U('subagent.mjs'));
  ok('subagent.mjs 导入通过');
} catch (e) { bad('subagent.mjs 导入', e.message); }

console.log('\n=== 5. 生效份和仓库一致 ===');
const LIVE = process.env.APPDATA + '/小鱼Agent/data/code/src/';
for (const f of ['tools.mjs', 'team.mjs', 'task-mode.mjs', 'name-zh.mjs']) {
  try {
    const a = fs.readFileSync(DIR + f, 'utf8');
    const b = fs.readFileSync(LIVE + f, 'utf8');
    assert.strictEqual(a, b, '两边不一致');
    ok(f + ' 一致');
  } catch (e) { bad(f, e.message); }
}

console.log(`\n结果：${pass} 过 / ${fail} 没过`);
process.exit(fail ? 1 : 0);
