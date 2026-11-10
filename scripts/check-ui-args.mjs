/**
 * 严检：前端的工具条不许画出「参数：undefined」
 *
 * 【2026-11-09 换框架】工具卡从「手写 DOM（index.html + ui/hub.js）」搬到了 React
 * （`src-ui/ToolCard.jsx`），于是这一条检查只扫 index.html + ui/*.js 就扫不到人了 ——
 * 报的是「没有空值保护」，可实际上它好好地写在 ToolCard 里：
 *     const args = formatArgs(it.args);
 *     let s = args ? '参数：' + tidyToolText(args) : '（无参数）';
 *
 * 现在把 `src-ui/*` 也并进扫描范围（这三个层都属于前端源码），
 * 并且**按行为**认这几种写法：空值就显示「（无参数）」，不许把 undefined 画出来。
 */
import fs from 'node:fs';
import path from 'node:path';

const files = [
  'D:\\小鱼Agent\\public\\index.html',
  'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\public\\index.html',
];

const SRC_UI = 'D:\\小鱼Agent\\src-ui';
let srcUi = '';
try {
  for (const f of fs.readdirSync(SRC_UI)) {
    if (/\.(jsx?|js)$/.test(f)) srcUi += '\n' + fs.readFileSync(path.join(SRC_UI, f), 'utf8');
  }
} catch (e) { /* 没有 src-ui 就只扫页面 */ }

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
  const all = s + srcUi;
  console.log('\n=== ' + p + ' (+ui/ +src-ui/) ===');
  chk('没有无条件拼 参数：+ p.args', !all.includes("el.pre.textContent = '参数：' + p.args;"));
  /* 空值保护：认「先算出来再判空」这种写法（ToolCard 就是这么写的），也认老的几种 */
  chk('有空值保护', /\?\s*'参数：'/.test(all)
    || /p\.args \? '参数：'/.test(all)
    || /p\.args \?\? '/.test(all)
    || /p\.args === undefined/.test(all)
    || /p\.args == null/.test(all));
  chk('空参数时显示「（无参数）」而不是 undefined', /（无参数）/.test(all));
  chk('compress 映射还在', all.includes("compress: '压缩中'"));
}

console.log('\n------------');
console.log(`断言：${pass}/${total}`);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
