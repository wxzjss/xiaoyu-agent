/**
 * 定时任务能不能真的跑起来 —— 静态 + 纯函数，不连 CDP、不起浏览器。
 *
 * 【为什么专门给 cron 写一条】2026-11-10 发现的：
 * `runCronTask` 里拼引子那行写的是 `.join(eol)`，而 **eol 这个变量整个项目里
 * 从来没定义过**。每次到点都在那一行抛 ReferenceError，被 cron.mjs 的 catch 吞掉，
 * 只在任务列表留一句「这一趟没跑起来」+ 一行 console.warn。
 *
 * 主人那边看到的就是：定时任务配了、时间也对、到点什么都不发生，
 * 翻遍界面看不出原因 —— 而 check-identifiers 报「101 个文件全干净」
 * （它当时只查调用位置，不查实参/右值）。
 *
 * 这个检查钉两件事：
 *   一、拼引子那段不许再引用未定义的变量（按名字白名单逐个放行，多一个就红）
 *   二、真正调一次组装逻辑，产出必须包含时间、任务正文、以及「这是定时任务」的交代
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 400) : '')); }
}

const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');

console.log('一、拼引子那段：只许用声明过的名字');
{
  /* 把 runCronTask 整个函数体按花括号配平截出来 */
  const start = serverSrc.indexOf('async function runCronTask(');
  let body = '';
  if (start >= 0) {
    let i = serverSrc.indexOf('{', start);
    let depth = 0;
    for (let k = i; k < serverSrc.length; k++) {
      if (serverSrc[k] === '{') depth++;
      else if (serverSrc[k] === '}') { depth--; if (depth === 0) { body = serverSrc.slice(start, k + 1); break; } }
    }
  }
  ok(Boolean(body), 'runCronTask 函数取到了', '没找到函数体');

  /* 只看「会真的跑起来的代码」：注释里提到的 `.join(eol)` 是在讲历史，不是 bug。
   * 把 /* *\/ 与 // 两种注释都挖掉，再判断。 */
  const codeOnly = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

  /* 定位 `const lead = [ ... ].join(X)` 里的 X —— 就是当初写错的那一处。
   * X 允许两种：字符串字面量（`'\n'`，正确写法）或声明过的变量（也不拦）。
   * 唯一不许的是「一个没定义的裸名字」—— eol 就是那个。 */
  const joinMatch = codeOnly.match(/\]\s*\.join\(\s*([^)]*?)\s*\)/);
  ok(Boolean(joinMatch), '找到了「拼引子」那行 .join(…)',
    (codeOnly.match(/.*\.join\(.*/) || [''])[0].trim());
  const joinedWith = joinMatch ? joinMatch[1].trim() : '';
  console.log('       .join 用的参数：' + JSON.stringify(joinedWith));
  const isLiteral = /^'(?:[^'\\]|\\.)*'$/.test(joinedWith) || /^"(?:[^"\\]|\\.)*"$/.test(joinedWith);
  const isDeclaredName = /^[A-Za-z_$][\w$]*$/.test(joinedWith) && declaredInBody.has(joinedWith);
  ok(isLiteral || isDeclaredName,
    '`.join` 用的是字面量或已声明的变量（当初这里写的是没定义的 eol）',
    '用了 ' + JSON.stringify(joinedWith) + '（既不是字面量，也不在函数内声明里）');

  /* 再兜一层：整个函数体里不许出现 eol 这种「看着像常量、其实没定义」的自由名字 */
  const declaredInBody = new Set();
  for (const m of codeOnly.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declaredInBody.add(m[1]);
  for (const m of codeOnly.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declaredInBody.add(m[1]);
  for (const m of codeOnly.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const p of m[1].split(',')) {
      const nm = p.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) declaredInBody.add(nm);
    }
  }
  ok(!/\beol\b/.test(codeOnly), '函数体（代码部分）里不再有未定义的 eol',
    (codeOnly.match(/.*\beol\b.*/) || [''])[0].trim());
}

console.log('\n二、真调一次组装，产出要对');
{
  /* 直接把那段拼装逻辑按原样复算一遍（不启动服务器、不碰磁盘）：
   * 先从源码里把注释挖掉，再抠出 `const lead = [ ... ].join(...)` 这段表达式。 */
  const codeForLead = serverSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const m = codeForLead.match(/const lead = \[([\s\S]*?)\]\.join\(([^)]*)\);/);
  ok(Boolean(m), '抠到了拼引子的表达式模板', '源码形态变了，检查需要跟着改');
  if (m) {
    const build = new Function('hh', 'mm', 'text', `
      return [${m[1]}].join(${m[2]});
    `);
    const out = build('09', '30', '把昨天的日报发我');
    ok(typeof out === 'string' && out.length > 0, '组装得出非空字符串');
    ok(out.includes('09:30'), '引子里带上了时间', out.slice(0, 60));
    ok(out.includes('把昨天的日报发我'), '引子里带上了任务正文', out.slice(0, 80));
    ok(out.includes('定时任务'), '引子里说明了「这是定时任务」（不然她以为是主人在说话）', out.slice(0, 60));
    ok(out.includes('\n'), '多行是用换行拼的（不是拼成一长串）', JSON.stringify(out.slice(0, 120)));
  }
}

console.log('\n三、cron 调度侧不许把失败吞成成功');
{
  const cronSrc = fs.readFileSync(path.join(ROOT, 'src', 'cron.mjs'), 'utf8');
  ok(/noteRunFailed/.test(cronSrc), '跑崩了会记一笔失败（不是记成绿）',
    '没找到 noteRunFailed');
  /* 「先记账再跑」是为了不重复触发，这个必须还在 */
  ok(/markRan\(task\.id, true/.test(cronSrc), '「先记账再跑」还在（不会一个任务反复触发）');
}

console.log('\n────────────────────────────────');
console.log('结果: ' + pass + ' 过 / ' + fail + ' 挂');
if (fail) process.exit(1);
