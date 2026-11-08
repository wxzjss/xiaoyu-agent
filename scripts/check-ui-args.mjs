/**
 * 严检：前端的工具条不许画出「参数：undefined」
 */
import fs from 'node:fs';

const files = [
  'D:\\小鱼Agent\\public\\index.html',
  'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\public\\index.html',
];

let pass = 0, total = 0;
const chk = (l, c) => { total++; c ? (pass++, console.log('  [ok] ' + l)) : console.log('  [FAIL] ' + l); };

for (const p of files) {
  /* 【2026-11-08 拆分配套】页面脚本拆成 index.html + ui/*.js 之后，
   * 工具卡那段（p.args 的空值保护）搬进了 ui/hub.js ——
   * 只读 index.html 会误判成「没有空值保护」。同目录的 ui/ 一并拼进来。 */
  let s = fs.readFileSync(p, 'utf8');
  try {
    const uiDir = p.replace(/index\.html$/, 'ui');
    for (const f of fs.readdirSync(uiDir)) {
      if (f.endsWith('.js')) s += '\n' + fs.readFileSync(uiDir + '/' + f, 'utf8');
    }
  } catch (e) {}
  console.log('\n=== ' + p + ' (+ui/) ===');
  chk('没有无条件拼 参数：+ p.args', !s.includes("el.pre.textContent = '参数：' + p.args;"));
  chk('有空值保护', s.includes("p.args ? '参数：'") || s.includes("p.args ?? '") || s.includes("p.args === undefined") || s.includes("p.args == null"));
  chk('compress 映射还在', s.includes("compress: '压缩中'"));
}

console.log('\n------------');
console.log(`断言：${pass}/${total}`);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
