/**
 * 【核心回归 · 2026-11-08 加】
 *
 * 主人要能分清「跑冒烟 / 跑核心 / 跑变更 / 跑全量」。这一档是**核心**：
 * 跟「改了什么都跑这一批」的固定子集 —— 覆盖真正的主干链路。
 *
 * 和另外三档的分工（写清楚，免得又混）：
 *   · 冒烟   check-smoke.mjs    纯源码断言，不碰服务、不连浏览器。15~60 秒。
 *   · 变更   check-changed.mjs  按你这次改到的文件反查受影响的检查。每次不同。
 *   · 核心   **本文件**          固定这一批：对话投递、工具循环、会话持久化、
 *                               续跑/看门狗、渲染主干、出厂提示词。2~3 分钟。
 *   · 全量   run-all-checks.mjs 70 个 + 真机格 + 接口扫描。7~9 分钟。发布前跑。
 *
 * 选这些的标准：**它坏了，主人当天就觉得「用不了」**。
 * 排除了：日志/汇总/归档这类坏了也不影响聊天的；以及纯 UI 细节。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'scripts');

/** 核心链路 —— 顺序按「坏了有多致命」排 */
const CORE = [
  ['check-chat-e2e.mjs', '发消息端到端（用户说话→她说话→收尾）'],
  ['check-live-sync.mjs', '仓库那份 == 真正在跑的那份（改了要生效）'],
  ['check-turn-watchdog.mjs', '整轮看门狗（别再「自己停了」）'],
  ['check-stuck-autoresume.mjs', '掐完自动接回'],
  ['check-resume-multi.mjs', '重启续跑（多会话不互相吃掉）'],
  ['check-pending-queue.mjs', '预发送队列（不丢话、不重复发）'],
  ['check-think-display.mjs', '思考链渲染（字数/标题/收展）'],
  ['check-tool-naming.mjs', '工具命名与柜门'],
  ['check-factory-prompt.mjs', '出厂默认提示词（换机器还是这份）'],
  ['check-plan-archive.mjs', '清单归档（超十条自动收）'],
];

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');

console.log('=== 核心回归（' + CORE.length + ' 项，覆盖主干链路）===');
if (DRY) {
  for (const [f, why] of CORE) console.log('  ' + f.padEnd(32) + why);
  console.log('--dry：只列不跑。');
  process.exit(0);
}

let fail = 0;
const t0 = Date.now();
const slow = [];
for (const [f, why] of CORE) {
  const one = Date.now();
  const x = spawnSync(process.execPath, [path.join(DIR, f)], {
    encoding: 'utf8', timeout: 10 * 60 * 1000,
  });
  const ms = Date.now() - one;
  slow.push([f, ms]);
  if (x.status === 0) {
    console.log('  OK   ' + f.padEnd(32) + (ms / 1000).toFixed(1) + 's   ' + why);
  } else {
    fail++;
    console.log('  FAIL ' + f.padEnd(32) + (ms / 1000).toFixed(1) + 's   ' + why);
    console.log(String(x.stdout || '').trim().split('\n').slice(-10).join('\n'));
    console.log(String(x.stderr || '').trim().split('\n').slice(-6).join('\n'));
  }
}
console.log('———— 核心回归：' + (CORE.length - fail) + '/' + CORE.length
  + ' 通过，' + ((Date.now() - t0) / 1000).toFixed(1) + 's ————');
const top = slow.sort((a, b) => b[1] - a[1]).slice(0, 4);
for (const [f, ms] of top) console.log('  ' + (ms / 1000).toFixed(1).padStart(6) + 's  ' + f);
console.log('注意：核心回归不覆盖全部。动到偏僻模块或发布前，仍要跑 run-all-checks.mjs 全量。');
process.exit(fail ? 1 : 0);
