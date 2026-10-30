#!/usr/bin/env node
/**
 * 服务端标识符自检 —— 抓「语法合法但一跑就 ReferenceError」的那一类。
 *
 * 为什么要有这个东西：
 *   2026-10-30 我在 agent.mjs 里写了三行 ctxNow()，忘了在 import 里带上 ctxNow。
 *   node --check 全过，import 模块也全过（那三行在函数体里，没被调用到），
 *   直到重启小鱼、跟干活鱼2说一句话，才在真机上炸出「ctxNow is not defined」。
 *
 *   页面那边早有同类闸门（scripts/check-ui.mjs 会查「JS 用了没声明的标识符」），
 *   服务端这边一直是空的 —— 这个脚本补上那一格。
 *
 * 它查的是：src/*.mjs 里用了、但既没 import、也没在本文件声明的标识符。
 *
 * 怎么做到「不误报」：
 *   1. 先挖掉注释、字符串、模板字符串、正则字面量（不然中文和引号里的字都会当标识符）
 *   2. 收集本文件声明过的一切：import / const / let / var / function / class / 参数 / 解构
 *   3. 收集 Node 与浏览器全局（含 `import.meta`、`process`、`Buffer`、`URL` …）
 *   4. 剩下的「a.b(` 里的 b 不算（那是属性名），`{ a: 1 }` 里的 a 不算（对象键）
 *
 * 用法：
 *   node scripts/check-identifiers.mjs           检查 src/
 *   node scripts/check-identifiers.mjs --all     连 scripts/ 一起查
 *   node scripts/check-identifiers.mjs <file>    查指定文件
 *
 * 退出码：0 = 干净；1 = 有未定义标识符。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const args = process.argv.slice(2);
let files = [];
if (args.length && !args[0].startsWith('--')) {
  files = args;
} else {
  const dirs = [join(ROOT, 'src')];
  if (args.includes('--all')) dirs.push(join(ROOT, 'scripts'));
  for (const d of dirs) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isFile() && (f.endsWith('.mjs') || f.endsWith('.cjs') || f.endsWith('.js'))) files.push(p);
    }
  }
}

/** 把注释 / 字符串 / 模板 / 正则挖空，保留换行让行号对得上。 */
function strip(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  let lastSignificant = ''; // 上一个非空白非注释字符，用来判断 / 是不是正则
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    // 行注释
    if (c === '/' && d === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    // 块注释
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    // 单引号 / 双引号
    if (c === "'" || c === '"') {
      const q = c;
      out += ' ';
      i++;
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i++;
      continue;
    }
    // 模板字符串：里面的 ${...} 是真的代码，要保留
    if (c === '`') {
      out += ' ';
      i++;
      while (i < n && code[i] !== '`') {
        if (code[i] === '\\') { out += ' '; i += 2; continue; }
        if (code[i] === '\n') { out += '\n'; i++; continue; }
        if (code[i] === '$' && code[i + 1] === '{') {
          // 把 ${ ... } 之间的内容原样留下（里面可能有嵌套模板）
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (code[i] === '{') depth++;
            else if (code[i] === '}') { depth--; if (depth === 0) { i++; break; } }
            out += code[i];
            i++;
          }
          continue;
        }
        out += ' ';
        i++;
      }
      i++;
      continue;
    }
    // 正则字面量：/ 前面是 ( , = : [ ! & | ? { } ; return 之类
    if (c === '/' && /[=(:,![&|?{};+\-*%<>~^]$|^$|\breturn$|\btypeof$|\bcase$/.test(out.slice(-12).trimEnd())) {
      out += ' ';
      i++;
      let inClass = false;
      while (i < n) {
        const ch = code[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === '\n') break; // 正则不跨行，说明不是正则
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/.test(code[i])) i++; // 正则 flag
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Node + 浏览器 + 鱼自己常挂的全局 */
const GLOBALS = new Set([
  // 语言内建
  'Object', 'Function', 'Array', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Promise', 'Proxy', 'Reflect',
  'JSON', 'Math', 'Intl', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'globalThis', 'global', 'window', 'self', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false',
  'eval', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'console', 'queueMicrotask', 'structuredClone',
  // 控制流关键字（会被当成标识符扫到）
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'function', 'class', 'extends', 'super', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of',
  'void', 'yield', 'await', 'async', 'try', 'catch', 'finally', 'throw', 'var', 'let', 'const',
  'import', 'export', 'from', 'as', 'static', 'get', 'set', 'this', 'arguments',
  // Node
  'process', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
  'AbortSignal', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'clearImmediate', 'require', 'module', 'exports', '__dirname', '__filename', 'fetch', 'FormData',
  'Blob', 'File', 'Headers', 'Request', 'Response', 'WebSocket', 'Event', 'EventTarget',
  'performance', 'crypto', 'navigator', 'localStorage', 'sessionStorage', 'document', 'location',
  'alert', 'confirm', 'prompt', 'atob', 'btoa', 'requestAnimationFrame', 'cancelAnimationFrame',
  'MessageChannel', 'BroadcastChannel', 'Worker', 'SharedWorker', 'CompressionStream', 'DecompressionStream',
  'ReadableStream', 'WritableStream', 'TransformStream', 'DOMException', 'CustomEvent', 'Image',
  'Audio', 'FileReader', 'XMLHttpRequest', 'Notification', 'ResizeObserver', 'IntersectionObserver',
  'MutationObserver', 'HTMLElement', 'Node', 'Element', 'requestIdleCallback', 'scheduler',
]);

/**
 * 只挖注释、保留字符串（换行对齐）。给解析 import 用。
 *
 * 为什么不能直接用 strip()：strip 会把 `from './x.mjs'` 的引号也挖掉，正则匹配不到。
 * 为什么不能直接用原文：注释里出现「import」这个词就会把匹配带偏 ——
 *   server.mjs 有一行注释写着「openingTexts … 不再 import ——」，
 *   正则从那个 import 开始吞，把紧跟其后的 openingHeadIndexes 等一长串真的 import 全漏掉
 *   （2026-10-30 踩过，误报 5 处）。
 */
function stripCommentsOnly(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') { out += code[i] + (code[i + 1] || ''); i += 2; continue; }
        out += code[i];
        i++;
      }
      out += q;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 收集本文件声明过的名字。
 *
 * 注意三个都要传：
 *   - import 从 **noComment**（挖掉注释、留着字符串）里找。
 *   - 其余声明从 code（注释+字符串全挖）里找，避免把注释/字符串里的字当成声明。
 */
function collectDeclared(code, raw, noComment) {
  const names = new Set();
  const add = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); };

  // import ... from '...'  —— 用 noComment（挖了注释、留着引号）
  for (const m of noComment.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*['"]/g)) addNamesFromImport(m[1]);
  // export ... from '...'
  for (const m of noComment.matchAll(/\bexport\s+([\s\S]*?)\s+from\s*['"]/g)) addNamesFromImport(m[1]);

  function addNamesFromImport(spec) {
    let s = spec.trim();
    // 去掉 type 修饰
    s = s.replace(/^type\s+/, '');
    // 具名部分 { a, b as c }
    const brace = s.match(/\{([\s\S]*)\}/);
    if (brace) {
      for (const part of brace[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const asMatch = t.match(/\bas\s+([A-Za-z_$][\w$]*)/);
        if (asMatch) add(asMatch[1]);
        else add(t.replace(/^type\s+/, '').trim());
      }
    }
    // 默认导入 / 命名空间 import
    const head = s.replace(/\{[\s\S]*\}/, '').replace(/,/g, ' ');
    for (const tok of head.split(/\s+/)) {
      if (!tok) continue;
      if (tok === '*' || tok === 'as') continue;
      add(tok);
    }
  }

  // const / let / var，含解构
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([\s\S]{1,400}?)(?:=|;|$)/gm)) {
    const decl = m[1];
    // 对象解构 { a, b: c, ...rest }
    const ob = decl.match(/^\s*\{([\s\S]*)\}\s*$/);
    if (ob) {
      for (const part of ob[1].split(',')) {
        const t = part.trim().replace(/^\.\.\./, '');
        if (!t) continue;
        const kv = t.split(':');
        add((kv[1] || kv[0]).trim().replace(/=.*$/, '').replace(/^\.\.\./, ''));
      }
      continue;
    }
    // 数组解构
    const ar = decl.match(/^\s*\[([\s\S]*)\]\s*$/);
    if (ar) {
      for (const part of ar[1].split(',')) {
        const t = part.trim().replace(/^\.\.\./, '').replace(/=.*$/, '');
        add(t);
      }
      continue;
    }
    // 普通：a, b = 1
    for (const part of decl.split(',')) {
      const t = part.trim().replace(/=.*$/, '').trim();
      add(t);
    }
  }

  // function / class 名
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 具名函数表达式 / 箭头函数的参数
  for (const m of code.matchAll(/function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g)) {
    add(m[1]);
    for (const p of m[2].split(',')) add(p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').replace(/[{}\[\]]/g, '').trim());
  }
  // 所有括号参数表 —— 宁可多收，少报比多报好
  for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {    for (const p of m[1].split(',')) {
      const t = p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(t)) add(t);
      // 解构参数 { a, b }
      for (const inner of t.matchAll(/([A-Za-z_$][\w$]*)/g)) add(inner[1]);
    }
  }
  // 单个参数的箭头 x => ...
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  // catch (e)
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 标签 label:
  for (const m of code.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:for|while|do)\b/gm)) add(m[1]);

  return names;
}

let bad = 0;
let scanned = 0;

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const code = strip(raw);
  const noComment = stripCommentsOnly(raw);
  const declared = collectDeclared(code, raw, noComment);
  const lines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  const reported = new Set();

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    // 类/对象里的方法定义形如 `name(args) {`、`async name(args) {`、`*gen() {`，
    // 那是「定义」不是「调用」，不该当未定义标识符报（run / beat / constructor 全是这种）。
    const methodDef = line.match(/^\s*(?:async\s+)?(?:\*\s*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
    const methodName = methodDef ? methodDef[1] : null;
    for (const m of line.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*(\(|\.)/g)) {
      const name = m[2];
      // 只查「函数调用」形态 name(
      if (m[3] !== '(') continue;
      if (name === methodName) continue;
      if (GLOBALS.has(name) || declared.has(name)) continue;
      // 关键字后接括号
      if (/^(if|for|while|switch|catch|typeof|new|return|function|await|yield|super|import|delete|void|in|of|instanceof)$/.test(name)) continue;
      const key = ln + ':' + name;
      if (reported.has(key)) continue;
      reported.add(key);
      bad++;
      console.log('  ✘ ' + relative(ROOT, file) + ':' + (ln + 1) + '  「' + name + '」没用过也没声明过');
      console.log('      ' + (rawLines[ln] || '').trim().slice(0, 120));
    }
  }
  scanned++;
}

console.log('');
if (bad) {
  console.log('✘ 查出 ' + bad + ' 处可疑的未定义标识符（' + scanned + ' 个文件）');
  console.log('  如果确认是误报，把名字加进脚本里的 GLOBALS。');
  process.exit(1);
}
console.log('✔ ' + scanned + ' 个文件，没有未定义的标识符');
