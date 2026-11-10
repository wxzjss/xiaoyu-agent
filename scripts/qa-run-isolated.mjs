#!/usr/bin/env node
/**
 * 【QA 用·2026-11-09】把任意一个 check 脚本放到隔离实例上跑。
 *
 * 为什么需要：`node scripts/check-core.mjs` 这类「入口」自己不起隔离实例，
 * 里面的子检查会 detectBase() 自动探测 8700~8799，**探到的第一个就是主人开着的那个**——
 * 于是核心里有几句会在主人的真实会话里发消息、造会话。
 *
 * 这个 wrapper：起隔离实例 → 把 BASE / MINI_AGENT_DATA 传下去跑目标脚本 → 收工杀干净。
 *
 * 用法：node scripts/qa-run-isolated.mjs scripts/check-core.mjs [--more args]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { startIsolated } from './_test-instance.mjs';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法：node scripts/qa-run-isolated.mjs <script.mjs> [args...]');
  process.exit(2);
}
const target = path.resolve(process.cwd(), args[0]);

let iso;
try {
  iso = await startIsolated();
} catch (e) {
  console.error('起隔离实例失败：', (e && e.message) || e);
  process.exit(2);
}
console.log('隔离实例 ' + iso.base + '（数据目录 ' + iso.dataDir + '）');
console.log('跑：' + path.basename(target) + '\n');

let code = 1;
try {
  const r = spawnSync(process.execPath, [target, ...args.slice(1)], {
    stdio: 'inherit',
    env: iso.env,
    timeout: 20 * 60 * 1000,
  });
  code = r.status == null ? 1 : r.status;
} finally {
  try { await iso.stop(); } catch (e) {}
}
process.exit(code);
