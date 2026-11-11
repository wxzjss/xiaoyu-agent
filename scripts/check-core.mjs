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
  ['check-pending-hint.mjs', '发送提示（预发送队列已删·两条路都直接插话）'],
  ['check-think-display.mjs', '思考链渲染（字数/标题/收展）'],
  ['check-tool-naming.mjs', '工具命名与柜门'],
  ['check-factory-prompt.mjs', '出厂默认提示词（换机器还是这份）'],
  ['check-plan-archive.mjs', '清单归档（超十条自动收）'],
  ['check-ime-untouched.mjs', '输入法：应用一行都不碰'],
  ['check-ime-no-top-focus.mjs', '启动不许有裸 focus 把中打回英'],
  ['check-sending-hint.mjs', '「正在发送消息」不许自己灭掉再不回来'],
  ['check-segment-split.mjs', '轮末必须分段，几轮的话不许堆一个气泡'],
  ['check-think-peek.mjs', '思考完了柜门灰字不许缩回一小截'],
  ['check-qq-core.mjs', 'QQ：主人号/附件清理/发送失败/错误脱敏'],
  ['check-live-history-split.mjs', 'F5/切回来：历史只画到这一轮开头'],
  ['check-think-peek.mjs', '思考完了柜门灰字不许缩回一小截'],
  ['check-qq-core.mjs', 'QQ：主人号/附件清理/发送失败/错误脱敏'],
  /* 【2026-11-10 加·P0 级数据污染】
   * 子智能体的 signal / snap 会串到别的会话 —— B 会话点「停止」会 taskkill 掉
   * A 会话正在跑的命令树。这类必须每次提交都跑，不能只在发版前跑一次。
   *
   * 【2026-11-11 已修绿（commit d58a0e9）】subagent 改成每个 worker 自己开 ALS
   * （runWithToolContext 六处字段显式传），tools.mjs 基底继承外层链路。
   * 曾登记进 KNOWN_RED，转绿后按本表规矩已删掉 —— 现在它红了就是真坏了。 */
  ['check-signal-isolation.mjs', '子智能体上下文隔离（signal 串会话会杀别人的命令）'],
];

/**
 * 【已知红】
 *
 * 这些检查钉的是「应该是什么样」，而现在还没修到那儿 —— 所以它红是**预期**的。
 *
 * 为什么要留这么一张表，而不是把它们从 CORE 里摘掉：
 *   · 摘掉 = 没人再跑，修到哪儿了也不知道；
 *   · 一直当失败 = 核心回归永远红，红久了就没人看了（这才是最危险的）。
 * 所以：**照跑、照打印，但不算失败**，输出里标「已知红 + 原因」。
 *
 * 修好之后必须把它从这张表里删掉 —— 那时候它要是红了，就是真的坏了。
 * 【2026-11-11】check-signal-isolation 已修绿，从这里删掉了；目前表为空。
 */
const KNOWN_RED = new Map([
]);

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');

console.log('=== 核心回归（' + CORE.length + ' 项，覆盖主干链路）===');
if (DRY) {
  for (const [f, why] of CORE) console.log('  ' + f.padEnd(32) + why);
  console.log('--dry：只列不跑。');
  process.exit(0);
}

let fail = 0;
let knownRed = 0;
const t0 = Date.now();
const slow = [];
for (const [f, why] of CORE) {
  const one = Date.now();
  const x = spawnSync(process.execPath, [path.join(DIR, f)], {
    encoding: 'utf8', timeout: 10 * 60 * 1000,
  });
  const ms = Date.now() - one;
  slow.push([f, ms]);
  const isKnownRed = x.status !== 0 && KNOWN_RED.has(f);
  if (x.status === 0) {
    if (KNOWN_RED.has(f)) {
      /* 从「已知红」转绿了 —— 这是好事，但必须提醒去把白名单删掉，
       * 否则以后它真坏了会被当成「已知红」放过去。 */
      console.log('  OK   ' + f.padEnd(32) + (ms / 1000).toFixed(1) + 's   ' + why);
      console.log('       ⚠ 它原来是「已知红」，现在绿了 —— 请把它从 KNOWN_RED 里删掉，'
        + '否则以后真坏了会被放过。');
      knownRed++;
    } else {
      console.log('  OK   ' + f.padEnd(32) + (ms / 1000).toFixed(1) + 's   ' + why);
    }
  } else if (isKnownRed) {
    knownRed++;
    console.log('  已知红 ' + f.padEnd(28) + (ms / 1000).toFixed(1) + 's   ' + why);
    console.log('       原因：' + KNOWN_RED.get(f));
  } else {
    fail++;
    console.log('  FAIL ' + f.padEnd(32) + (ms / 1000).toFixed(1) + 's   ' + why);
    console.log(String(x.stdout || '').trim().split('\n').slice(-10).join('\n'));
    console.log(String(x.stderr || '').trim().split('\n').slice(-6).join('\n'));
  }
}
console.log('———— 核心回归：' + (CORE.length - fail - knownRed) + '/' + (CORE.length - knownRed)
  + ' 通过、' + knownRed + ' 项已知红、失败 ' + fail
  + '，' + ((Date.now() - t0) / 1000).toFixed(1) + 's ————');
const top = slow.sort((a, b) => b[1] - a[1]).slice(0, 4);
for (const [f, ms] of top) console.log('  ' + (ms / 1000).toFixed(1).padStart(6) + 's  ' + f);
console.log('注意：核心回归不覆盖全部。动到偏僻模块或发布前，仍要跑 run-all-checks.mjs 全量。');
process.exit(fail ? 1 : 0);
