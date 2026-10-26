#!/usr/bin/env node
/**
 * 发布前闸门：把会白屏的错误挡在「发布」和「同步到安装版」之前。
 *
 * 为什么：2026-10-26 小鱼加任务清单时留下
 *   document.getElementById('todoAddBtn').onclick = ...
 * 而 HTML 里没有那个元素 → 整段脚本中断 → 白屏。
 * JS 语法合法、HTML 合法，node --check 抓不到，只会在真机上炸。
 *
 * 这个脚本跑三关，任何一关不过就退出码 1：
 *   1. 所有 src/*.mjs 的 node --check（语法）
 *   2. 页面自检 scripts/check-ui.mjs（白屏类）
 *   3. 源码 / 数据目录 / git 三者是否一致（防止改了数据目录却没进 git）
 *
 * 用法：node scripts/preflight.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:\\小鱼Agent';
let bad = 0;

function head(t) { console.log('\n──── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length))); }
function ok(t) { console.log('  ✔ ' + t); }
function no(t) { console.log('  ✘ ' + t); bad++; }
function note(t) { console.log('  · ' + t); }

// ---------- 1. 语法 ----------
head('1. src/*.mjs 语法');
const srcDir = join(ROOT, 'src');
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.mjs') || f.endsWith('.cjs') || f.endsWith('.js')) files.push(p);
  }
})(srcDir);
let synOk = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    synOk++;
  } catch (e) {
    no(f.replace(ROOT + '\\', '') + ' 语法错: ' + String(e.stderr || e.message).split('\n').slice(0, 3).join(' '));
  }
}
if (synOk === files.length) ok(files.length + ' 个文件全过');

// ---------- 2. 页面自检 ----------
head('2. 页面自检（会白屏的那类错）');
try {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-ui.mjs'), '--all'], { stdio: 'pipe' });
  const txt = out.toString('utf8');
  const m = txt.match(/致命问题 (\d+)/);
  if (m) no('check-ui 报 ' + m[1] + ' 处致命问题');
  else ok('源码 + 安装版两份都干净');
} catch (e) {
  no('check-ui 不通过：\n' + String(e.stdout || e.message).split('\n').filter((l) => /✘/.test(l)).join('\n'));
}

// ---------- 3. 三处一致 ----------
head('3. 源码 / 数据目录 / git 一致性');
const PAIRS = [
  ['public/index.html', join(ROOT, 'public', 'index.html'), join(process.env.APPDATA, '小鱼Agent', 'data', 'public', 'index.html')],
  ['src/plan.mjs', join(ROOT, 'src', 'plan.mjs'), join(process.env.APPDATA, '小鱼Agent', 'data', 'code', 'src', 'plan.mjs')],
  ['src/server.mjs', join(ROOT, 'src', 'server.mjs'), join(process.env.APPDATA, '小鱼Agent', 'data', 'code', 'src', 'server.mjs')],
];
for (const [name, a, b] of PAIRS) {
  if (!existsSync(a) || !existsSync(b)) { note(name + ' 有一边不存在，跳过'); continue; }
  const va = readFileSync(a, 'utf8');
  const vb = readFileSync(b, 'utf8');
  if (va === vb) ok(name + ' 源码 = 安装版');
  else note(name + ' 两边不一致（源码 ' + va.length + ' / 安装版 ' + vb.length + '）→ 跑 node scripts/sync-live.mjs');
}

// git 里有没有未提交改动
try {
  const st = execFileSync('git', ['status', '--short'], { cwd: ROOT, stdio: 'pipe' }).toString('utf8').trim();
  if (!st) ok('git 工作区干净');
  else {
    const lines = st.split('\n').filter((l) => /^\s*M|^\?\?/.test(l));
    note('git 有 ' + lines.length + ' 处未提交改动，记得 commit：');
    for (const l of lines.slice(0, 10)) note('    ' + l.trim());
  }
} catch { note('git 不可用，跳过'); }

// ---------- 结论 ----------
console.log('\n' + '═'.repeat(60));
if (bad) {
  console.log('✘ 预检不通过（' + bad + ' 处）—— 别发布，别同步到安装版。');
  process.exit(1);
}
console.log('✔ 预检通过');
