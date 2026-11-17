import fs from 'node:fs';

const SRC = 'D:\\小鱼Agent\\games\\abyss\\src';
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));

function collect(ns) {
  const defined = new Set();
  const texts = {};
  for (const f of files) texts[f] = fs.readFileSync(`${SRC}\\${f}`, 'utf8');

  const reDef = [
    new RegExp(`\\b${ns}\\.([A-Za-z_$][\\w$]*)\\s*[=:]`, 'g'),
    new RegExp(`\\b${ns}\\.([A-Za-z_$][\\w$]*)\\s*\\|\\|`, 'g'),
    new RegExp(`\\b\\w+\\.${ns}\\s*=\\s*\\{`, 'g'),
  ];
  for (const f of files) {
    for (const re of reDef) for (const m of texts[f].matchAll(re)) if (m[1]) defined.add(m[1]);
  }
  // 别名：const Cam = G.camera; -> Cam 的方法其实定义在 G.camera 字面量里
  const aliasKeys = [ns];
  for (const f of files) {
    const m = texts[f].match(new RegExp(`(?:const|let|var)\\s+${ns}\\s*=\\s*G\\.([A-Za-z_$][\\w$]*)`));
    if (m) aliasKeys.push('G.' + m[1]);
  }
  // obj 字面量里的方法简写： ns = { foo(...){}, bar: 1 }
  for (const f of files) {
    const s = texts[f];
    let idx = -1;
    for (const k of aliasKeys) { idx = s.indexOf(`${k} = {`); if (idx >= 0) break; }
    if (idx >= 0) {
      for (const m of s.slice(idx).matchAll(/^\s{2,6}([A-Za-z_$][\w$]*)\s*[(:]/gm)) defined.add(m[1]);
    }
  }
  return { defined, texts };
}

let bad = 0;
for (const ns of ['Game', 'UI', 'Cam', 'Audio', 'G']) {
  const { defined, texts } = collect(ns === 'G' ? 'G' : ns);
  const usedAll = new Map();
  for (const f of files) {
    // 可选钩子：if (G.xxx) G.xxx(...) 这种守卫式调用，没人实现不算缺口
    const scan = texts[f].replace(/if\s*\(\s*!?\s*G\.[\w$]+\s*\)[^;\n]*;?/g, '');
    for (const m of scan.matchAll(new RegExp(`\\b${ns}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
      usedAll.set(m[1], (usedAll.get(m[1]) || 0) + 1);
    }
  }
  const missing = [...usedAll.keys()].filter((n) => !defined.has(n)).sort();
  if (missing.length) {
    bad++;
    console.log(`\n[${ns}] 用了但没定义 (${missing.length}):`);
    console.log('  ' + missing.join(', '));
  }
}
console.log(bad ? `\n共 ${bad} 个命名空间有问题` : 'Game/UI/Cam/Audio 命名空间全部对齐 ✓');
if (bad) process.exitCode = 1;
