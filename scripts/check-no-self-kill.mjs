/**
 * 【2026-11-13 主人报「重启后没一会就自动退出」】
 * 根修 = 三处防自毁，这个站岗把它们钉死：
 *   ① tools.mjs run_command 的 HITS 清单必须点名 repack-installed-app（间接自毁）
 *   ② repack-installed-app.ps1 必须有父链自检（被小鱼拉起就报错，不杀宿主）
 *   ③ repack-installed-app.ps1 杀掉应用后必须拉回来（外部终端跑完不用手动双击）
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

/* ── ① run_command 间接自毁拦截 ── */
ok('run_command HITS 点名 repack-installed-app（间接自毁）',
  /repack-installed-app/i.test(tools) && /['"]repack-installed-app['"]\s*,\s*\/repack-installed-app\/i/.test(tools));
ok('命中 repack 时有专门人话（说清正确姿势=外部终端）',
  /不能从小鱼里面跑/.test(tools) && /powershell -File scripts\\\\repack-installed-app\.ps1|自动把应用拉回来/.test(tools));
ok('repack 有父链自检（祖先里有小鱼就报错退出）',
  /ParentProcessId/.test(repack) && /正在被小鱼Agent自己拉起/.test(repack) && /throw \('这个脚本正在被小鱼Agent自己拉起/.test(repack));
ok('父链自检（throw 那句）排在真正的杀进程之前',
  repack.indexOf('正在被小鱼Agent自己拉起') < repack.indexOf('Stop-Process -Id'));

/* ── ③ 杀掉后拉回 ── */
ok('repack 结尾把应用拉回来（Start-Process 小鱼Agent.exe）',
  /Start-Process \$exe/.test(repack) && /应用已重新拉起/.test(repack));
ok('拉回排在 asar 替换之后（先 Copy-Item 后 Start-Process）',
  repack.indexOf('Copy-Item $new $asarP') < repack.indexOf('Start-Process $exe'));

console.log(`\n防自毁三处钉死：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
