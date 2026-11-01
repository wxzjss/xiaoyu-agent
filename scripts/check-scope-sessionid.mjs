/**
 * 防回归：不许有「在某个顶层函数里用了 sessionId，但那个函数没有这个参数」。
 *
 * 被自己坑出来的教训：批量替换 estimateTokens(...) 加 sessionId，
 * 加到了 findCut / compressHistory 里，那些函数根本没这个参数 ——
 * 压缩整个抛异常，一条都没压下去。
 *
 * 只查顶层函数（列 0 起的 function / export function），闭包和箭头函数跳过，
 * 它们能看到外层作用域。
 */
import fs from 'node:fs';

const base = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\';
const files = ['compress.mjs', 'compact-core.mjs', 'agent.mjs'];

let pass = 0, total = 0;
const chk = (l, c, extra = '') => {
  total++;
  if (c) { pass++; console.log('  [ok] ' + l); }
  else console.log('  [FAIL] ' + l + (extra ? '  ' + extra : ''));
};

const TOP_FUNC = /^(export\s+)?(async\s+)?function\s+(\w+)\s*\(/;

console.log('=== 逐个顶层函数扫 sessionId ===');
const bad = [];
for (const f of files) {
  const p = base + f;
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const m = TOP_FUNC.exec(lines[i]);
    if (!m) continue;
    const name = m[3];

    // 参数区：配平括号
    let depth = 0, started = false, paramEnd = i;
    for (let k = i; k < Math.min(i + 60, lines.length); k++) {
      for (const ch of lines[k]) {
        if (ch === '(') { depth++; started = true; }
        else if (ch === ')') depth--;
      }
      if (started && depth <= 0) { paramEnd = k; break; }
    }
    const paramText = lines.slice(i, paramEnd + 1).join('\n');
    const hasSid = /\bsessionId\b/.test(paramText);

    // 函数体：从 paramEnd 到列 0 的 }（顶层函数都这么结尾）
    let bodyEnd = lines.length;
    for (let k = paramEnd + 1; k < lines.length; k++) {
      if (/^\}/.test(lines[k])) { bodyEnd = k; break; }
    }

    if (hasSid) continue;

    for (let k = paramEnd + 1; k <= bodyEnd && k < lines.length; k++) {
      const l = lines[k];
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;      // 注释
      if (/^\s*sessionId\s*=/.test(l)) continue;       // 自己声明的局部变量
      if (/(?<![\w.$])sessionId\b/.test(l)) {
        bad.push(`${f}:${k + 1}  ${name}()  ->  ${l.trim().slice(0, 90)}`);
        break;
      }
    }
  }
}

for (const b of bad) console.log('  [FAIL] ' + b);
chk('没有「顶层函数用了 sessionId 却没这个参数」', bad.length === 0, bad.length ? `共 ${bad.length} 处` : '');

console.log('');
console.log('------------');
console.log('断言：' + pass + '/' + total);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
