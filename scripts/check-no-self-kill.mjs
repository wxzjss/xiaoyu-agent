/**
 * 【2026-11-13 主人报「重启后没一会就自动退出」】
 * 根修 = 三处防自毁，这个站岗把它们钉死：
 *   ① tools.mjs run_command 的 HITS 清单必须点名 repack-installed-app（间接自毁）
 *   ② repack-installed-app.ps1 必须有父链自检（被小鱼拉起就报错，不杀宿主）
 *   ③ repack-installed-app.ps1 杀掉应用后必须拉回来（外部终端跑完不用手动双击）
 * 【2026-11-13 追加·管理员档】主人钦点「管理员权限下完美掌控程序本体」：
 *   ④ repack 拦截对管理员档放行（-SelfUpdate 自更姿势）
 *   ⑤ -SelfUpdate 跳过父链自检，但拉回/杀流程一字不动
 *   ⑥ restart_self 管理员档 409 自动 force（不再「先问主人」）
 *   ⑦ spawn_worker(s) 管理员档不看团队模式开关
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};

const tools = readFileSync(join(ROOT, 'src', 'tools.mjs'), 'utf8');
const repack = readFileSync(join(ROOT, 'scripts', 'repack-installed-app.ps1'), 'utf8');
const admin = readFileSync(join(ROOT, 'src', 'admin-mode.mjs'), 'utf8');

/* ── ① run_command 间接自毁拦截 ── */
ok('run_command HITS 点名 repack-installed-app（间接自毁）',
  /repack-installed-app/i.test(tools) && /['"]repack-installed-app['"]\s*,\s*\/repack-installed-app\/i/.test(tools));
ok('命中 repack 时有专门人话（说清正确姿势=外部终端）',
  /不能从小鱼里面跑/.test(tools) && /powershell -File scripts\\\\repack-installed-app\.ps1|自动把应用拉回来/.test(tools));

/* ── ② 父链自检 ── */
ok('repack 有父链自检（祖先里有小鱼就报错退出）',
  /ParentProcessId/.test(repack) && /正在被小鱼Agent自己拉起/.test(repack) && /throw \('这个脚本正在被小鱼Agent自己拉起/.test(repack));
ok('父链自检（throw 那句）排在真正的杀进程之前',
  repack.indexOf('正在被小鱼Agent自己拉起') < repack.indexOf('Stop-Process -Id'));

/* ── ③ 杀掉后拉回 ── */
ok('repack 结尾把应用拉回来（Start-Process 小鱼Agent.exe）',
  /Start-Process \$exe/.test(repack) && /应用已重新拉起/.test(repack));
ok('拉回排在 asar 替换之后（先 Copy-Item 后 Start-Process）',
  repack.indexOf('Copy-Item $new $asarP') < repack.indexOf('Start-Process $exe'));

/* ── ④⑤ 管理员档自更（-SelfUpdate）── */
ok('管理员档下 repack 拦截放行（CTX.adminMode 分叉在拦截之前）',
  /CTX\.adminMode === true/.test(tools) && /管理员档 · 程序本体自更/.test(tools)
  && tools.indexOf('管理员档 · 程序本体自更') < tools.indexOf('这条路是堵死的'));
ok('放行给的是 -SelfUpdate 姿势（不是裸跑）',
  /repack-installed-app\.ps1 -SelfUpdate/.test(tools));
ok('repack 脚本有 -SelfUpdate 参数，且能跳过父链自检',
  /\[switch\]\$SelfUpdate/.test(repack) && /if \(\$probe -and -not \$SelfUpdate\)/.test(repack));
ok('-SelfUpdate 不影响杀→换→拉回主流程（拉回仍在 Copy-Item 后）',
  repack.indexOf('Copy-Item $new $asarP') < repack.indexOf('Start-Process $exe'));

/* ── ⑥⑦ restart_self / spawn 的管理员自主 ── */
ok('restart_self 409 时管理员档自动 force（不再先问主人）',
  /管理员档.*409 会自动带 force|409 会自动带 force 重试/.test(tools)
  && /管理员档自动 force/.test(tools));
ok('spawn_worker(s) 管理员档不看团队模式开关',
  (tools.match(/!teamOn\(sid\) && CTX\.adminMode !== true/g) || []).length >= 2);

/* ── 提示词把「程序本体掌控」写清 ── */
ok('adminPromptBlock 写明程序本体掌控（改源码/重启/-SelfUpdate/派鱼）',
  /完美掌控小鱼Agent这个程序/.test(admin) && /repack-installed-app\.ps1 -SelfUpdate/.test(admin));

console.log(`\n防自毁三处钉死 + 管理员档自更：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
