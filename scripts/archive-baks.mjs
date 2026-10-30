import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 把散在源码目录里的 *.bak / *.bak-* 统一挪进 backup/<原目录>/
//
// 为什么要有这个：写代码时「动手前先 Copy-Item 一份」是救命的（这次靠它
// 好几次捞回了被回退的 public/index.html），但留完不收拾，src/ 里就会
// 攒出一堆同名的 .bak。sync-live 会跳过它们、git 也忽略它们，于是谁也
// 看不见 —— 直到某个时候你/AI 去 src/ 里扫文件被它们带偏，或者自检报告
// 里出现一行「.bak 堆积」挡在真正的问题前面。
//
// 用法：
//   node scripts/archive-baks.mjs            看会挪哪些（不改）
//   node scripts/archive-baks.mjs --apply    真的挪
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BK = path.join(ROOT, 'backup');
const APPLY = process.argv.includes('--apply');
const SKIP_DIRS = new Set(['node_modules', '.git', 'sandbox', 'backup', 'dist', '.state', 'dump', 'node_modules']);
const SCAN_DIRS = ['', 'src', 'public', 'electron', 'scripts', 'mobile', 'persona', 'assets'];

const isBak = (n) => n.includes('.bak');

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (isBak(e.name)) out.push(p);
  }
  return out;
}

const found = [];
for (const d of SCAN_DIRS) {
  const abs = d ? path.join(ROOT, d) : ROOT;
  if (d) { if (fs.existsSync(abs)) walk(abs, found); }
  else for (const e of fs.readdirSync(abs, { withFileTypes: true })) if (e.isFile() && isBak(e.name)) found.push(path.join(abs, e.name));
}

if (!found.length) { console.log('  干净：没有要归档的 .bak'); process.exit(0); }

console.log('  找到 ' + found.length + ' 个 .bak：');
let moved = 0;
for (const f of found) {
  const relDir = path.relative(ROOT, path.dirname(f));
  const destDir = path.join(BK, relDir);
  const dest = path.join(destDir, path.basename(f));
  console.log('    ' + path.relative(ROOT, f) + '  ->  ' + path.relative(ROOT, dest));
  if (APPLY) {
    fs.mkdirSync(destDir, { recursive: true });
    // 撞名就加序号，绝不覆盖已归档的东西
    let target = dest, i = 1;
    while (fs.existsSync(target)) target = dest + '.' + (i++);
    fs.renameSync(f, target);
    moved++;
  }
}
console.log(APPLY ? '  好了：挪走 ' + moved + ' 个到 backup/' : '  （只是看看，加 --apply 才真挪）');
