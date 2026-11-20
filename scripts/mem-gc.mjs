#!/usr/bin/env node
/**
 * 孤儿回收命令行入口（独立子进程跑，不进 Electron 主进程）
 *
 * ── 为什么必须单独跑，不能挂在 server 启动里 ──────────────
 * `src/mem-rotate.mjs` 那套轮转原来是在 `server.listen` 之后同步跑的，
 * 主人报过「双击图标启动那么慢」，查下来是 gzipSync 一口气处理 55MB 把事件循环堵死。
 * 后来整块被 `if (false)` 停用，注释写得很明白：
 *   > 维护类批处理不该跑在 Electron 主进程里 —— 要跑就单独起脚本/子进程。
 * 所以 mem-gc 从一开始就不做「自动后台跑」，只提供入口，
 * 由人（或定时任务/外部调度）在需要时叫它。宁可让它手动，
 * 也不把启动速度再拖坏一次 —— 那次的教训是「延后 = 把卡顿挪到窗口露面之后」，
 * 挪一下不解决问题，得彻底搬出去。
 *
 * ── 用法 ────────────────────────────────────────────────
 *   node scripts/mem-gc.mjs                 # 只看清单，不动手（默认就是 dry-run）
 *   node scripts/mem-gc.mjs --apply         # 真跑
 *   node scripts/mem-gc.mjs --days=30       # 保护期改成 30 天
 *   node scripts/mem-gc.mjs --by-kind       # 按目录分组显示
 *
 * 默认 dry-run 是刻意的：这个脚本会删文件，手滑一次就没了。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const byKind = argv.includes('--by-kind');
const daysArg = argv.find((a) => a.startsWith('--days='));
const days = daysArg ? Math.max(0, parseInt(daysArg.split('=')[1], 10) || 14) : 14;
const maxArg = argv.find((a) => a.startsWith('--max='));
const maxFiles = maxArg ? Math.max(1, parseInt(maxArg.split('=')[1], 10) || 3000) : 3000;

const mb = (b) => (b / 1048576).toFixed(1) + 'MB';
const kb = (b) => (b / 1024).toFixed(0) + 'KB';

const gc = await import(pathToFileURL(path.join(ROOT, 'src', 'mem-gc.mjs')).href);

console.log('孤儿回收' + (apply ? '（真跑）' : '（只看，不动手）'));
console.log('  保护期: ' + days + ' 天（比这新的不动）');
console.log('  单次上限: ' + maxFiles + ' 个');
console.log('  绝不碰: ' + gc.NEVER_TOUCH.join(' / '));
console.log('');

const r = gc.runGc({ days, maxFiles, dryRun: !apply });

if (!r.total) {
  console.log('没有要回收的孤儿 —— 干净的。');
  process.exit(0);
}

console.log('待回收: ' + r.total + ' 个 / ' + mb(r.totalBytes));
if (r.testN) console.log('  其中测试残留: ' + r.testN + ' 个 / ' + kb(r.testBytes) + '（不等保护期）');
if (r.deferred) console.log('  超出上限延后: ' + r.deferred + ' 个（下次再收）');
console.log('');

if (byKind) {
  console.log('按目录：');
  const rows = Object.entries(r.byKind).sort((a, b) => b[1].bytes - a[1].bytes);
  for (const [k, v] of rows) {
    console.log('  ' + k.padEnd(18) + String(v.n).padStart(6) + ' 个   ' + mb(v.bytes)
      + (v.test ? '   （测试 ' + v.test + '）' : ''));
  }
  console.log('');
}

if (!apply) {
  console.log('以上只是清单，一个字都没动。要真收就加 --apply');
  console.log('');
  console.log('（会先打包成 .gz 再删 —— chronicle / folded / selfnote 随时能还原；');
  console.log('  slim / tool-out 是工具输出副本，直接删，会话 json 里本来就有截断版）');
  process.exit(0);
}

console.log('回收结果：');
console.log('  打包: ' + r.packed + ' 个');
console.log('  直删: ' + r.dropped + ' 个');
console.log('  释放: ' + mb(r.freed));
if (r.files && r.files.length) {
  console.log('');
  console.log('存到这些包里（要翻随时能解）：');
  for (const f of r.files) console.log('  ' + f);
}
