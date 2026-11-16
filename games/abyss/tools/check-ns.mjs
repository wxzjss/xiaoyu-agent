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
  // obj 字面量里的方法简写： ns = { foo(...){}, bar: 1 }
  for (const f of files) {
    const s = texts[f];
    const idx = s.indexOf(`${ns} = {`);
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
    for (const m of texts[f].matchAll(new RegExp(`\\b${ns}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
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
console.log(bad ? '' : 'Game/UI/Cam/Audio 命名空间全部对齐 ✓');
