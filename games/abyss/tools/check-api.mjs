import fs from 'node:fs';

const SRC = 'D:\\小鱼Agent\\games\\abyss\\src';
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));

// 1. 全量收集「定义过的名字」
const defined = new Set();
const texts = {};
for (const f of files) texts[f] = fs.readFileSync(`${SRC}\\${f}`, 'utf8');
for (const f of files) {
  const s = texts[f];
  for (const m of s.matchAll(/\bG\.([A-Za-z_$][\w$]*)\s*[=:]/g)) defined.add(m[1]);
  for (const m of s.matchAll(/\bG\.([A-Za-z_$][\w$]*)\s*\|\|/g)) defined.add(m[1]);
  for (const m of s.matchAll(/this\.([A-Za-z_$][\w$]*)\s*[=:(]/g)) defined.add(m[1]);
  for (const m of s.matchAll(/window\.G\.([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
}

// 2. 找用了但谁都没定义的
let bad = 0;
for (const f of files) {
  const used = new Map();
  // 可选钩子：if (G.xxx) G.xxx(...) 这种守卫式调用，没人实现不算缺口
  const scan = texts[f].replace(/if\s*\(\s*!?\s*G\.[\w$]+\s*\)[^;\n]*;?/g, '');
  for (const m of scan.matchAll(/\bG\.([A-Za-z_$][\w$]*)/g)) {
    used.set(m[1], (used.get(m[1]) || 0) + 1);
  }
  const missing = [...used.keys()].filter((n) => !defined.has(n)).sort();
  if (missing.length) {
    bad++;
    console.log(`[${f}] 无定义 ${missing.length} 个: ${missing.join(', ')}`);
  }
}
console.log(bad ? `\n共 ${bad} 个文件有问题` : '全部 API 都有定义 ✓');
if (bad) process.exitCode = 1;
