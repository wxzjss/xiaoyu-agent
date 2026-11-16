#!/usr/bin/env node
/**
 * 守卫：`tools.mjs` 里的每个工具，都必须在 `features.mjs` 的功能表里登记。
 *
 * 【这个坑已经踩过两次了，不能再踩第三次】
 *
 * features 的规矩是：**不在任何功能的 tools 列表里 → 从模型手里拿掉**。
 * 也就是说工具写好了、描述写漂亮了、参数校验也全对 —— 只要没登记，
 * 模型连看都看不到，一次都不会被调用。而且它**不报错**，只在启动日志里
 * 悄悄写一行「没登记到 features 的功能表（会被静默关闭，永远用不了）」。
 *
 *   第一次（2026-11-08）：schedule_task / list_schedules / cancel_schedule
 *     三个工具全没登记，主人说「明天九点提醒我」她只能嘴上答应，落地不了。
 *   第二次（2026-11-15）：新加的 check_job / list_jobs / stop_job 又漏了，
 *     被隔离实例启动时的告警吵出来 —— 那意味着「后台跑回归」这个能力
 *     在真机上其实是死的。
 *
 * 两次都是回归/日志偶然吵出来的，靠运气。所以改成静态守卫：
 * 直接比对两边的名字，少一个就红。
 *
 * 【为什么不做成「连服务再问模型拿到哪些工具」】
 * 那要起实例、要端口、要模型配置，慢且脆。这里读两个文件就够，
 * 而 features 的过滤逻辑是纯函数式的（名字进、名字出），静态比对等价。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const one = (cond, name, detail = '') => {
  if (cond) { pass++; console.log('  ✔ ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  ✘ ' + name + (detail ? '   ' + detail : '')); }
};

const { tools } = await import('file://' + path.join(ROOT, 'src', 'tools.mjs'));
const fsrc = fs.readFileSync(path.join(ROOT, 'src', 'features.mjs'), 'utf8');

/* 把 features.mjs 里所有 `tools: [...]` 中的字符串抓出来。
 * 用宽松的正则而不是 AST：features 的文件结构很固定（一个数组、每项一支 tools），
 * AST 反而要引入依赖；这里漏抓的唯一可能是写成变量拼接，那种情况下面会因
 * 「missing 里出现它」被反向暴露出来。 */
const registered = new Set();
for (const m of fsrc.matchAll(/tools:\s*\[([^\]]*)\]/g)) {
  for (const q of m[1].matchAll(/'([^']+)'/g)) registered.add(q[1]);
}

const names = tools.map((t) => (t && t.name) || '').filter(Boolean);
one(names.length > 0, '读到了工具清单', names.length + ' 个');

const missing = names.filter((n) => !registered.has(n));
one(missing.length === 0,
  '每个工具都在功能表里登记了（漏了=被静默关闭，模型永远用不到）',
  missing.length ? '漏了：' + missing.join(', ') : '');

/* 反向查：功能表里写了、tools.mjs 里没有 —— 说明登记错字或工具被删了，
 * 界面上会出现一个「勾了也没用」的功能。 */
const ghosts = [...registered].filter((n) => !names.includes(n));
one(ghosts.length === 0,
  '功能表里的工具名字都对得上（没有指不存在的工具）',
  ghosts.length ? '幽灵：' + ghosts.join(', ') : '');

/* 【2026-11-16 判据更新】后台作业（check_job / list_jobs / stop_job + jobs.mjs）
 * 已被整条删掉，功能块也一起删了。这里不再要求它们在场 —— 上面「每个工具都登记」
 * 和「没有幽灵登记」两条已经足够兜住这个面，删掉的工具留在这里只会假红。 */

console.log(`\n── 功能表登记完整：${pass} 过 / ${fail} 挂 ──`);
process.exit(fail ? 1 : 0);
