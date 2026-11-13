/** run_command 快速通道：分类保守、两条壳都能真跑、超时说明还在。 */
import { makeChecker } from './_harness_util.mjs';
import { pickShell, needsPowerShell, shellLabel } from '../src/harness/exec-shell.mjs';
import { exec } from 'node:child_process';
import fs from 'node:fs';

const t = makeChecker('harness / exec-shell');
const win = process.platform === 'win32';

// ── 分类：简单 → cmd；任何 PowerShell 味道 → 老路 ──────────────────
const SIMPLE = ['node -v', 'npm -v', 'git status', 'dir', 'echo hello', 'cd .. && dir', 'python --version'];
const PS = [
  '$env:APPDATA', 'Get-Content x.txt', 'Write-Output "hi"', 'ls | Select-Object Name',
  'node -e "console.log(1)"', 'a > b.txt', 'Start-Process notepad',
  '(Get-ChildItem).Name', 'Stop-Process -Name x',
  'node -v; node -v',        // ; 是 PowerShell 分隔符，cmd 不认，必须回老路

];
for (const c of SIMPLE) t.ok('简单命令走快路 · ' + c, !needsPowerShell(c), shellLabel(c));
for (const c of PS) t.ok('PowerShell 味道回老路 · ' + c.slice(0, 26), needsPowerShell(c), shellLabel(c));
t.ok('空命令不算简单', pickShell('', 'auto') === (win ? 'powershell.exe' : '/bin/sh'));
t.ok('shell_hint=cmd 强制快路', pickShell('Get-Content x', 'cmd') === (win ? 'cmd.exe' : '/bin/sh'));
t.ok('shell_hint=powershell 强制老路', pickShell('node -v', 'powershell') === (win ? 'powershell.exe' : '/bin/sh'));
t.ok('非 Windows 一律 /bin/sh', win || pickShell('node -v') === '/bin/sh');

// ── 两条壳都真的能跑通一条命令 ────────────────────────────────────
const run = (shell) => new Promise((done) => {
  exec('node -v', { shell, timeout: 15000 }, (err, stdout, stderr) => {
    done({ err, out: String(stdout || '').trim(), errText: String(stderr || '') });
  });
});
if (win) {
  for (const sh of ['cmd.exe', 'powershell.exe']) {
    const r = await run(sh);
    t.ok('真跑通 ' + sh, !r.err && /^v\d+\./.test(r.out), r.out || r.errText.slice(0, 60));
  }
} else {
  const r = await run('/bin/sh');
  t.ok('真跑通 /bin/sh', !r.err && /^v\d+\./.test(r.out), r.out);
}

// ── 接入点 / 契约 ─────────────────────────────────────────────────
const tools = fs.readFileSync('src/tools.mjs', 'utf8');
t.ok('tools.mjs 真的用上了 pickShell', /shell: pickShell\(command, shell_hint\)/.test(tools));
t.ok('不再无条件写死 powershell.exe', !/shell: process\.platform === 'win32' \? 'powershell\.exe'/.test(tools));
t.ok('shell_hint 进 schema（2026-11-13 起按平台给说明，Windows 单行 / 其他平台多行）', /shell_hint: \{ type: 'string'/.test(tools) || /shell_hint: \{\s*[\s\S]{0,200}type: 'string'/.test(tools));
t.ok('timeout_ms 没被动掉', /timeout_ms: \{ type: 'number'/.test(tools));
t.ok('超时说明仍在', /超时掐掉了/.test(tools));

t.done();
