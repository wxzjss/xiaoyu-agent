// backup/ 清理：每个源文件只留最新一份 .bak
// 规则：按「.bak 之前那段文件名」分组，每组留 mtime 最新的，其余删掉。
// 保护：
//   1. git 里跟踪的一律不动（ls-files 校验）
//   2. 10-28 之后（含今天）的备份一律不动 —— 那是我和大鱼这两天干活的现场
//   3. 非 .bak 的文件（test-*.mjs、whale-self.mjs 这类独立备份）不动
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * 【2026-11-10 修·别把本机路径写死在发布出去的文件里】
 *
 * 主人问「在你的电脑上能正常运行的在别人电脑上会不会出问题」。
 * 这个脚本原来第一行就是 `const ROOT = 'D:/小鱼Agent'` —— 别人 clone 下来
 * 一跑就 ENOENT（目录不存在），而且这句还跟着源码发布出去了，
 * 等于把本机目录名告诉了所有人。
 *
 * 现在从脚本自己的位置往上推一层（scripts/ 的上一级 = 仓库根），
 * 谁 clone 到哪都算得对。想指定别的目录就设 XY_REPO。
 */
const path0 = require('path');
const ROOT = process.env.XY_REPO
  ? path0.resolve(process.env.XY_REPO)
  : path0.resolve(__dirname, '..');
const BAK = path0.join(ROOT, 'backup');

if (!require('fs').existsSync(BAK)) {
  console.log('没有 backup/ 目录（' + BAK + '），没什么可清的。');
  process.exit(0);
}

const tracked = new Set(
  execSync('git ls-files backup', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
);

const all = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.includes('.bak')) all.push(p);
  }
})(BAK);

const CUTOFF = new Date('2026-10-28T00:00:00').getTime();

const groups = new Map();
for (const p of all) {
  const base = path.basename(p).split('.bak')[0];
  if (!groups.has(base)) groups.set(base, []);
  groups.get(base).push(p);
}

const toDelete = [];
const kept = [];
const protectedList = [];

for (const [base, files] of groups) {
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const newest = files[0];
  kept.push(newest);
  for (const f of files.slice(1)) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const mtime = fs.statSync(f).mtimeMs;
    if (tracked.has(rel)) { protectedList.push(rel + '（在 git 里）'); continue; }
    if (mtime >= CUTOFF) { protectedList.push(rel + '（10-28 之后的现场）'); continue; }
    toDelete.push(f);
  }
}

console.log('backup/ 里 .bak 总数: ' + all.length);
console.log('按源文件分组: ' + groups.size + ' 组');
console.log('每组留最新: ' + kept.length + ' 份');
console.log('可清理: ' + toDelete.length + ' 份');
if (protectedList.length) {
  console.log('受保护不动: ' + protectedList.length + ' 份');
  for (const p of protectedList) console.log('    · ' + p);
}

if (process.argv.includes('--apply')) {
  let bytes = 0;
  for (const f of toDelete) {
    try { bytes += fs.statSync(f).size; fs.unlinkSync(f); } catch (e) { console.log('删不掉: ' + f + ' ' + e.message); }
  }
  console.log('\n✅ 已删 ' + toDelete.length + ' 份，释放 ' + (bytes / 1024 / 1024).toFixed(1) + ' MB');
} else {
  console.log('\n（这是预演。加 --apply 才真删）');
  console.log('样例：');
  for (const f of toDelete.slice(0, 8)) console.log('    ' + path.relative(ROOT, f));
}
