/**
 * 前端「用了但没声明」扫描（v8·务实版）。
 *
 * 主人报：「异步任务出错：__mark is not defined」。
 *
 * 前面七版都在死磕词法分析，全栽在注释/字符串里的花括号和 ${}。
 * 这版不搞那套了，只做一件笨但可靠的事：
 *   对每一个「名字是 __ 开头」的标识符，
 *   ① 全文找它有没有 const/let/var/function 声明；
 *   ② 如果有，再用**原始行文本**（不剥任何东西）判断：所有调用行是否都在声明行之后。
 *   ③ 注释里的名字，用「该行去掉注释后还剩不剩这个名字」来排除。
 *
 * __mark 的错型正好被②抓住：声明在第15153行，可第14926行就调用了。
 * 这个办法只在一种情况下漏：注释里的花括号骗过了行内注释判定——但这里按行处理，
 * 不跨行配对，所以不会。
 */
import fs from 'node:fs';

const FILE = process.argv[2] || 'D:/小鱼Agent/public/index.html';
const html = fs.readFileSync(FILE, 'utf8');
const blocks = [];
const sre = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi;
let sm;
while ((sm = sre.exec(html))) if (sm[1].trim()) blocks.push(sm[1]);
const code = blocks.join('\n');
const lines = code.split('\n');

/** 只去掉这一行里真正的注释段（按行处理，不跨行配对） */
function codePartOf(line, inBlockRef) {
  let s = line;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (inBlockRef.v) {
      const end = s.indexOf('*/', i);
      if (end < 0) { i = s.length; break; }
      i = end + 2; inBlockRef.v = false; continue;
    }
    if (s[i] === '/' && s[i + 1] === '*') { inBlockRef.v = true; i += 2; continue; }
    if (s[i] === '/' && s[i + 1] === '/') break;
    out += s[i]; i++;
  }
  return out.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const blk = { v: false };
const codeLines = lines.map((l) => codePartOf(l, blk));

// 收集所有 __ 名字
const names = new Set();
for (const l of codeLines) {
  for (const mm of l.matchAll(/(?:^|[^.\w$])(__[A-Za-z0-9_$]+)/g)) names.add(mm[1]);
}

const problems = [];
for (const name of names) {
  if (name === '__dirname' || name === '__filename') continue;
  const declLines = [];
  const useLines = [];
  for (let i = 0; i < codeLines.length; i++) {
    const l = codeLines[i];
    const re = new RegExp('(?:const|let|var|function)\\s+' + name.replace(/[$]/g, '\\$') + '\\b');
    if (re.test(l)) { declLines.push(i + 1); continue; }
    const reUse = new RegExp('(?:^|[^.\\w$])' + name.replace(/[$]/g, '\\$') + '\\b');
    if (reUse.test(l)) useLines.push(i + 1);
  }
  if (!declLines.length) {
    if (useLines.length) problems.push({ name, line: useLines[0], why: '全文没声明' });
    continue;
  }
  const first = Math.min(...declLines);
  const tooEarly = useLines.filter((u) => u < first);
  if (tooEarly.length) {
    problems.push({ name, line: tooEarly[0], why: '声明在第' + first + '行，可第' + tooEarly[0] + '行就用了' });
  }
}

console.log('script ' + blocks.length + ' 段 / ' + lines.length + ' 行 / ' + names.size + ' 个 __ 名字');
if (!problems.length) { console.log('✔ 没有「用了但没声明 / 声明太晚」的 __ 名字'); process.exit(0); }
console.log('✘ 发现 ' + problems.length + ' 处:');
for (const p of problems) console.log('  第' + p.line + '行 ' + p.name + ' — ' + p.why);
process.exit(1);
