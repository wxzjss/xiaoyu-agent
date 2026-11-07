/**
 * 办事模式开关的探针（被 check-task-mode.mjs 用独立数据目录 spawn）。
 * 只做真事：开、读、换会话、模拟重启、BOM、关。
 */
import fs from 'node:fs';
import path from 'node:path';
import { taskOn, setTaskOn } from '../src/task-mode.mjs';

const DATA = process.env.MINI_AGENT_DATA;
const out = { ok: true, steps: [] };
const fail = (m) => { out.ok = false; out.steps.push('✘ ' + m); };

try {
  /* ① 默认关 */
  out.defaultOff = !taskOn('sidA');
  if (!out.defaultOff) fail('没开过的时候应该是关的');

  /* ② 开 → 读得到 */
  setTaskOn('sidA', true);
  out.afterOn = taskOn('sidA');
  if (!out.afterOn) fail('开了之后读不到');

  /* ③ 不串会话 */
  out.otherOff = !taskOn('sidB');
  if (!out.otherOff) fail('开 A 把 B 也带开了');

  /* ④ 真的落盘了（不是只在内存） */
  const f = path.join(DATA, '.state', 'task-mode.json');
  out.fileExists = fs.existsSync(f);
  if (!out.fileExists) fail('没写出 task-mode.json');
  out.fileBody = out.fileExists ? fs.readFileSync(f, 'utf8').replace(/\s+/g, '') : '';
  if (out.fileBody.indexOf('sidA') < 0) fail('文件里没有 sidA');

  /* ⑤ 关掉 → 消失 */
  setTaskOn('sidA', false);
  out.afterOff = !taskOn('sidA');
  if (!out.afterOff) fail('关了之后还读得到');

  /* ⑥ BOM：PowerShell 写出来的文件带 BOM，读的时候必须削掉 */
  fs.writeFileSync(f, '\ufeff' + JSON.stringify({ version: 1, on: { sidBOM: true } }), 'utf8');
  out.bomRead = taskOn('sidBOM');
  if (!out.bomRead) fail('BOM 文件读不出来（开关会静默失效）');
} catch (e) {
  fail('抛错：' + String(e && e.message ? e.message : e));
}

console.log(JSON.stringify(out));
