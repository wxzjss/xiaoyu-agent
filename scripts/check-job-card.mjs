/**
 * check-job-card.mjs — 守「后台任务画成卡片」+「回归只能交给子Agent跑」。
 *
 * 主人 2026-11-16 两条原话：
 *   ① 「我希望跑回归时会有和跑子Agent时一样的显示，且并入子Agent干活的那个柜子，
 *       删输入框左上角【正在跑变更】之类的话」
 *   ② 「让回归之类的路径只能交给子Agent跑」
 *
 * 做法：
 *   · run_command 里硬拦「重活回归」（全量 / 冒烟 / 增量 / --only=），
 *     引导 spawn_worker；子Agent 自己放行。
 */
import { readFileSync } from 'node:fs';

const srv = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const prompt = readFileSync(new URL('../persona/FACTORY-PROMPT.md', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/* ── 三、【2026-11-16 主人钦点】回归工具全部还给她，只留软引导 ───── */
/* 一天之内改了两轮：早上「回归只能交给子Agent」→ 我在 run_command 里加硬拦；
 * 中午「回归等工具全部还给她，限制她自己跑后台的提示词全删」→ 硬拦整段删掉。
 * 现在守的是：① 不许再把硬拦加回来；② 两句软引导必须在。 */
ok('run_command 里不再硬拦回归（没有 _looksRun / _hasCheck）',
  !/_looksRun/.test(tools) && !/_hasCheck/.test(tools));
ok('不再返回「回归一律交给子Agent」那种拒绝',
  !/回归一律交给子Agent/.test(tools));
ok('也没有「后台任务一律交给子Agent」那种拒绝',
  !/后台任务一律交给子Agent/.test(tools));
ok('主轮系统提示带软引导：跑回归/长活优先让子Agent跑',
  /如果需要跑回归以及耗时长的工具调用时，请优先让子Agent跑/.test(srv));
ok('「每轮开始·第一条」和「重启续上·第一条」两处都带（各一次以上）',
  (srv.match(/如果需要跑回归以及耗时长的工具调用时，请优先让子Agent跑/g) || []).length >= 2);

/* ── 四、【2026-11-16】后台作业也只能交给子Agent ───── */
/* 主人原话：「能否把所有后台任务全部只能交给子Agent跑？」
 * 以前回归类**默认后台**（11-15 要的）；那条跟今天的「回归交给子Agent」打架，
 * 而且后台作业仍挂在主轮上（跑完叫醒、整轮再拉长）。现在主轮一律拒。 */
/* 【2026-11-16 主人钦点·后台作业整套删掉】
 * 原话：「把后台作业的有关代码全删了，要求代码层面做到要么前台要么子Agent」。
 * 所以这里不再守「主轮被拒」，改成守「这套东西根本不存在了」——
 * 只要有人把 background / startJob / check_job 加回来，这条就红。 */
ok('run_command 没有 background 参数了',
  !/_wantBg/.test(tools) && !/shell_hint, background/.test(tools));
ok('tools.mjs 不再引用 jobs.mjs', !/from '\.\/jobs\.mjs'/.test(tools));
ok('三个后台工具已删（check_job / list_jobs / stop_job）',
  !/name: 'check_job'/.test(tools) && !/name: 'list_jobs'/.test(tools) && !/name: 'stop_job'/.test(tools));
ok('src/jobs.mjs 文件已删',
  !(() => { try { readFileSync(new URL('../src/jobs.mjs', import.meta.url), 'utf8'); return true; } catch { return false; } })());

/* 【2026-11-16 删·这两条守的是已被撤掉的硬拦】
 * 主人中午把回归工具全还给她了，run_command 里那段判据整段删除，
 * 「她绕过闸的三种写法」也就不存在了 —— 留着只会一直红。
 * 现在只守一件事：run_command 里再也别长出这类判据（见上一节）。 */

console.log('\n后台卡片 + 回归路由 + 后台拦截：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
