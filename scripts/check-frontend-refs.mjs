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
  const bare = name.replace(/[$]/g, '\\$');
  const declLines = [];
  const useLines = [];
  for (let i = 0; i < codeLines.length; i++) {
    const l = codeLines[i];
    const re = new RegExp('(?:const|let|var|function)\\s+' + bare + '\\b');
    if (re.test(l)) { declLines.push(i + 1); continue; }
    const reUse = new RegExp('(?:^|[^.\\w$])' + bare + '\\b', 'g');
    if (isRealUse(l, reUse, name)) useLines.push(i + 1);
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

/**
 * 【2026-11-09 修·两种假红】把「名字出现」分成「真用了这个变量」和「只是碰巧同名」：
 *
 *   ① **属性访问**：`handle.__pendingId` —— 前面是 `.`（正则里已排除）。
 *      但老版本还会遇到 `x?.__foo` 这种，统一在这儿兜。
 *   ② **对象字面量的键**：`return { __pendingId: id };` —— 这是**定义**一个字段名，
 *      不是引用变量。老版本把它当成「用了没声明」，于是 `__pendingId` 假红了一条。
 *      判据：前面是 `{` 或 `,`，后面紧跟 `:`。
 *      （`cond ? __x : y` 里前面不是 `{`/`,`，所以不会被误放过。）
 */
function isRealUse(line, re, name) {
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(line))) {
    const start = m.index + m[0].length - name.length;
    const before = line.slice(0, start);
    const after = line.slice(start + name.length);
    if (/^\s*:/.test(after) && /[{,]\s*$/.test(before)) continue;   // 对象键
    return true;
  }
  return false;
}

console.log('script ' + blocks.length + ' 段 / ' + lines.length + ' 行 / ' + names.size + ' 个 __ 名字');
if (!problems.length) { console.log('✔ 没有「用了但没声明 / 声明太晚」的 __ 名字'); process.exit(0); }
console.log('✘ 发现 ' + problems.length + ' 处:');
for (const p of problems) console.log('  第' + p.line + '行 ' + p.name + ' — ' + p.why);
process.exit(1);
