/**
 * 【冒烟回归 · 2026-11-08 加】
 *
 * 主人问：「底线里要求的【跑回归】为什么每次都跑全量而不是增量/冒烟？
 * 随便一个小任务做完都要跑全量？」
 *
 * 根因不是她偷懒，是**以前只有一个入口**：`run-all-checks.mjs`。
 * 它把 70 个检查串行 spawn 一遍，还带 5 个真机格（每个 Page.reload + 等 12 秒）
 * 和 107 个接口的 POST 自检 —— 实测 7 分 38 秒。改一行文案也照跑这么久。
 *
 * 这里给一个轻入口：只跑「纯源码快检」—— 不连 CDP、不起隔离服务、
 * 不设长等待的那些。按脚本内容自动识别，新增的轻量检查会自动进来，
 * 不用手工维护白名单。目标 30 秒内跑完。
 *
 *   node scripts/check-smoke.mjs
 *
 * 分级怎么用（写进出厂底线了）：
 *   · 只动一个文件 / 纯文案注释        → 冒烟
 *   · 动到核心链路、多文件、发布前      → run-all-checks.mjs 全量
 *   · 动到生效同步（code/ 与 public/）  → 再加 node scripts/sync-live.mjs --check
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'scripts');
/** 会拖时间的特征：连调试浏览器、起子进程、打网络、长等待 */
const HEAVY = /_t_cdp|\bconnect\(|Page\.reload|\bfetch\(|spawnSync\(|setTimeout\([^,]+,\s*[1-9]\d{3,}\)/;
/** 实测会卡到 60s 超时的：它走的是隔离实例那条路，源码里看不出 spawn 字样 */
/* check-live-sync 专管「仓库那份和生效那份是不是同一份」，它跟代码质量无关，
 * 而且只要有人（我或智能体）刚改完没同步就红 —— 放进冒烟只会误导。
 * 真要查同步，单独跑 node scripts/check-live-sync.mjs。 */
const SKIP = new Set(['check-bom.mjs', 'check-live-sync.mjs']);

const all = readdirSync(DIR)
  .filter((f) => /^check-.*\.mjs$/.test(f) && f !== 'check-smoke.mjs' && !SKIP.has(f))
  .sort();
const light = all.filter((f) => {
  try { return !HEAVY.test(readFileSync(path.join(DIR, f), 'utf8')); } catch { return false; }
});
const skipped = all.length - light.length;

console.log('=== 冒烟回归：' + light.length + ' 个轻量检查（跳过 ' + skipped + ' 个重型/真机格）===');
let fail = 0;
const t0 = Date.now();
const slow = [];
for (const f of light) {
  const one = Date.now();
  const r = spawnSync(process.execPath, [path.join(DIR, f)], {
    encoding: 'utf8', timeout: 60 * 1000,
  });
  const ms = Date.now() - one;
  slow.push([f, ms]);
  if (r.status === 0) console.log('  OK   ' + f + '  ' + (ms / 1000).toFixed(1) + 's');
  else {
    fail++;
    console.log('  FAIL ' + f + '  ' + (ms / 1000).toFixed(1) + 's');
    console.log(String(r.stdout || '').trim().split('\n').slice(-8).join('\n'));
    console.log(String(r.stderr || '').trim().split('\n').slice(-5).join('\n'));
  }
}
console.log('———— 冒烟：' + (light.length - fail) + '/' + light.length
  + ' 通过，' + ((Date.now() - t0) / 1000).toFixed(1) + 's ————');
const top = slow.slice().sort((a, b) => b[1] - a[1]).slice(0, 5);
for (const [f, ms] of top) console.log('  ' + (ms / 1000).toFixed(1).padStart(6) + 's  ' + f);
console.log('注意：冒烟不等于全量。动到核心链路 / 发布前仍要跑 run-all-checks.mjs。');
process.exit(fail ? 1 : 0);
