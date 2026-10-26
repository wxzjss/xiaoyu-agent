#!/usr/bin/env node
/**
 * 前端页面自检 —— 在「发布前」「同步前」跑一遍，拦住会白屏的那类错。
 *
 * 为什么要有这个东西：
 *   2026-10-26 小鱼加「任务清单」面板时，脚本里写了
 *     document.getElementById('todoAddBtn').onclick = ...
 *   可 HTML 里根本没有 id="todoAddBtn" 这个元素。
 *   → null.onclick 抛 TypeError → 整个顶层 <script> 从那一行起全部不执行
 *   → renderTurns / renderSessList / bootSessions 都没跑 → 掉进页面只剩骨架，白屏。
 *   JS 语法是合法的，HTML 也是合法的，任何现有的 `node --check` 都抓不到。
 *   只有在真机上打开才看得见，而且看起来像「服务挂了」。
 *
 * 这个脚本抓的正是「语法合法但一跑就炸」的那一类：
 *   1. JS 里 getElementById('x') 但 HTML 里没有 id="x"      ← 本次事故
 *   2. JS 里直接给可能为 null 的东西赋属性（.onclick/.textContent/...）
 *   3. 文件级结构错（<form>/<dialog>/<script> 不配对）      ← 2026-10-25 记忆本 0×0 事故
 *   4. 内联 script 语法错
 *   5. 顶层引用了未声明也未在文件中定义的标识符
 *
 * 用法：
 *   node scripts/check-ui.mjs                 检查源码 public/index.html
 *   node scripts/check-ui.mjs --live          检查安装版数据目录那份
 *   node scripts/check-ui.mjs --all           两份都检查
 *   node scripts/check-ui.mjs <path>          检查指定文件
 *
 * 退出码：0 = 干净；1 = 有致命问题（会让页面白屏）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:\\小鱼Agent';
const SOURCE = join(ROOT, 'public', 'index.html');
const LIVE = join(process.env.APPDATA || '', '小鱼Agent', 'data', 'public', 'index.html');

const args = process.argv.slice(2);
let targets = [];
if (args.includes('--all')) targets = [['源码', SOURCE], ['安装版', LIVE]];
else if (args.includes('--live')) targets = [['安装版', LIVE]];
else if (args.length && !args[0].startsWith('--')) targets = [['指定', args[0]]];
else targets = [['源码', SOURCE]];

let fatal = 0;
let warn = 0;

/** 挖掉注释与字符串字面量（保留换行，行号才对得上） */
function stripCommentsAndStrings(code) {
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
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { if (code[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === q) { i++; break; }
        if (code[i] === '\n') out += '\n';
        i++;
      }
      out += "''";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const BROWSER_GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'console', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'fetch', 'WebSocket', 'EventSource', 'AbortController', 'FormData',
  'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'Image', 'Audio', 'HTMLElement',
  'Element', 'Node', 'NodeList', 'DOMParser', 'XMLHttpRequest', 'JSON', 'Math', 'Date', 'Array',
  'Object', 'String', 'Number', 'Boolean', 'RegExp', 'Error', 'TypeError', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'Intl', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'alert',
  'confirm', 'prompt', 'getComputedStyle', 'matchMedia', 'devicePixelRatio', 'innerWidth',
  'innerHeight', 'scrollTo', 'scrollBy', 'Notification', 'AudioContext', 'webkitAudioContext',
  'SpeechSynthesisUtterance', 'speechSynthesis', 'ResizeObserver', 'IntersectionObserver',
  'MutationObserver', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'DragEvent',
  'ClipboardEvent', 'TextDecoder', 'TextEncoder', 'Buffer', 'process', 'require', 'module',
  'exports', 'globalThis', 'self', 'top', 'parent', 'frames', 'opener',
  'InvalidCharacterError', 'DOMException', 'MediaMetadata', 'HTMLMediaElement',
]);

function pad(s, n) { return String(s).padEnd(n); }

/** 取出所有内联 script（带在文件中的行号偏移） */
function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    out.push({ code: m[2], line: html.slice(0, bodyStart).split('\n').length });
  }
  return out;
}

function checkFile(label, path) {
  console.log('');
  console.log('── ' + label + ' ─ ' + path);
  if (!existsSync(path)) {
    console.log('  ✘ 文件不存在');
    fatal++;
    return;
  }
  const html = readFileSync(path, 'utf8');
  const allLines = html.split('\n');

  // ---------- 1. 内联 script 语法 ----------
  const scripts = inlineScripts(html);
  console.log('  内联脚本 ' + scripts.length + ' 段');
  for (const s of scripts) {
    try {
      new Function(s.code);
      console.log('    L' + s.line + '  语法 OK (' + s.code.length + ' 字符)');
    } catch (e) {
      console.log('    L' + s.line + '  ✘ 语法错误: ' + e.message);
      fatal++;
    }
  }

  // ---------- 2. HTML 结构配对 ----------
  console.log('  ── 结构配对');
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
  for (const tag of ['html', 'head', 'body', 'form', 'dialog', 'script', 'style', 'select', 'table']) {
    // 去掉注释和字符串里的伪标签：只数「真正在标签位置」的
    const open = (html.match(new RegExp('<' + tag + '\\b[^>]*>', 'gi')) || []).length;
    const close = (html.match(new RegExp('</' + tag + '\\s*>', 'gi')) || []).length;
    if (tag === 'dialog') {
      // <dialog> 在 JS 注释里出现是常见的（`<dialog>.close()`），要剔除
      const realOpen = countRealTags(html, tag, 'open');
      const realClose = (html.match(/<\/dialog\s*>/gi) || []).length;
      if (realOpen !== realClose) {
        console.log('    ✘ <' + tag + '> 真正开 ' + realOpen + ' 闭 ' + realClose + '（JS 注释里的不算）');
        fatal++;
      } else console.log('    ✔ <' + tag + '> ' + realOpen + ' 对');
      continue;
    }
    if (VOID.has(tag)) continue;
    if (open !== close) {
      console.log('    ✘ <' + tag + '> 开 ' + open + ' 闭 ' + close);
      fatal++;
    } else if (open) console.log('    ✔ <' + tag + '> ' + open + ' 对');
  }

  // ---------- 3. 重复 id ----------
  const idCount = new Map();
  for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) {
    idCount.set(m[1], (idCount.get(m[1]) || 0) + 1);
  }
  const dups = [...idCount].filter(([, c]) => c > 1);
  if (dups.length) {
    console.log('  ── 重复 id');
    for (const [id, c] of dups) { console.log('    ⚠ id="' + id + '" 出现 ' + c + ' 次'); warn++; }
  }

  // ---------- 4. JS 引用了 HTML 里不存在的 id（本次事故） ----------
  console.log('  ── JS 引用 vs HTML 存在');
  const htmlIds = new Set(idCount.keys());
  const missing = new Map(); // id -> [行号]
  for (const s of scripts) {
    const base = s.line - 1;
    for (const m of s.code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const id = m[1];
      if (htmlIds.has(id)) continue;
      const ln = base + s.code.slice(0, m.index).split('\n').length;
      if (!missing.has(id)) missing.set(id, []);
      missing.get(id).push(ln);
    }
  }
  if (missing.size === 0) console.log('    ✔ 全部存在');
  for (const [id, lines] of missing) {
    // 判断这一行是否被保护：本行或上一行/两行内有 if (!x) / if (x) / ?. / &&x / x&&
    const guarded = lines.some((ln) => {
      const l = allLines[ln - 1] || '';
      return /\?\./.test(l) || /\bif\s*\(/.test(l) || /&&/.test(l);
    });
    // 判断它是「同一个 const 变量名」在使用前是否 null 检查
    const varGuarded = lines.some((ln) => {
      // 找这一行对应的 const/let 变量名，再看后面几行有没有 if (!name)
      const l = allLines[ln - 1] || '';
      const vm = l.match(/(?:const|let|var)\s+(\w+)\s*=\s*document\.getElementById\(\s*['"]/.source);
      const mm = l.match(/(?:const|let|var)\s+(\w+)\s*=\s*$/);
      const name = mm ? mm[1] : null;
      if (!name) return false;
      for (let k = ln; k < Math.min(ln + 6, allLines.length); k++) {
        const n = allLines[k] || '';
        if (new RegExp('if\\s*\\(\\s*!\\s*' + name + '\\b').test(n)) return true;
        if (new RegExp('if\\s*\\(\\s*' + name + '\\s*\\)').test(n) && /\breturn\b/.test(n)) return true;
      }
      return false;
    });
    const bare = lines.filter((ln) => {
      const l = allLines[ln - 1] || '';
      if (/\?\./.test(l) || /\bif\s*\(/.test(l) || /&&/.test(l)) return false;
      return /\.\s*\w+\s*=/.test(l) || /\.\s*addEventListener\s*\(/.test(l);
    });
    if (bare.length && !varGuarded) {
      console.log('    ✘ id="' + id + '" 在 HTML 里没有，但 JS 第 ' + bare.join(',') + ' 行直接给它赋值/挂监听');
      console.log('       → 运行时会 TypeError，整段脚本中断 = 白屏');
      for (const ln of bare) console.log('         L' + ln + ': ' + (allLines[ln - 1] || '').trim().slice(0, 100));
      fatal++;
    } else if (bare.length) {
      console.log('    ⚠ id="' + id + '" 不存在（第 ' + bare.join(',') + ' 行），但有 null 保护，先放过');
      warn++;
    } else {
      console.log('    · id="' + id + '" 不存在，但引用处有保护（if/?./&&）→ OK');
    }
  }

  // ---------- 5. 顶层脚本里用到但既没声明也没定义的标识符 ----------
  // 只查 todo 这类明显遗漏：形如 `todoXxx` / `planXxx` 的自由标识符
  console.log('  ── 疑似未定义变量');
  const code = scripts.map((s) => s.code).join('\n');
  const declared = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const p of m[1].split(',')) declared.add(p.trim().split(':').pop().trim());
  }
  for (const m of code.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
  // 函数参数（含箭头函数、方法、catch）
  for (const m of code.matchAll(/(?:function\s*[\w$]*|catch)\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(',')) {
      const nm = p.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) declared.add(nm);
    }
  }
  // 箭头函数 / 方法简写的参数：`(a, b) =>` 和 `a =>`
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const p of m[1].split(',')) {
      const nm = p.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) declared.add(nm);
    }
  }
  for (const m of code.matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
  // for...of / for...in 的循环变量
  for (const m of code.matchAll(/for\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) declared.add(m[1]);
  // class 方法里的字段
  for (const m of code.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);
  // 先把注释和字符串字面量挖掉，剩下的才是真·标识符用法
  const bare = stripCommentsAndStrings(code);
  const suspicious = new Set();
  for (const m of bare.matchAll(/\b([a-z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*)\b/g)) {
    const n = m[1];
    if (declared.has(n)) continue;
    if (BROWSER_GLOBALS.has(n)) continue;
    // 只关心确实是「当变量用」的：出现在 = ( ? : 前，或作为调用/属性访问的对象
    const re = new RegExp('(?:^|[^.\\w$])(?:!' + n + '\\b|' + n + '\\s*(?:\\(|&&|\\|\\||\\?|\\.|=[^=]))');
    if (!re.test(bare)) continue;
    suspicious.add(n);
  }
  if (!suspicious.size) console.log('    ✔ 没有');
  for (const n of [...suspicious].sort()) {
    if (n === 'toJSON' || n === 'toFixed' || n === 'parseJSON') continue;
    console.log('    ✘ ' + n + ' 被当变量用，但全文没有 const/let/var/function 声明');
    // 找它的第一处用法行号
    for (const s of scripts) {
      const base = s.line - 1;
      const idx = s.code.search(new RegExp('(?:^|[^.\\w$])' + n + '\\b'));
      if (idx >= 0) {
        const ln = base + s.code.slice(0, idx).split('\n').length;
        console.log('       首次出现 L' + ln + ': ' + allLines[ln - 1].trim().slice(0, 100));
        break;
      }
    }
    fatal++;
  }

  console.log('  文件 ' + html.length + ' 字符 / ' + allLines.length + ' 行');
}

function countRealTags(html, tag, kind) {
  // 粗略剔除 JS 注释：先挖掉 <script> 内容，再数
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>');
  return (stripped.match(new RegExp('<' + tag + '\\b[^>]*>', 'gi')) || []).length;
}

console.log('前端页面自检');
for (const [label, path] of targets) checkFile(label, path);

console.log('');
console.log('════════════════════════════════');
if (fatal) {
  console.log('✘ 致命问题 ' + fatal + ' 处 —— 这个页面打开会白屏或按钮点不动，别发布。');
  process.exit(1);
}
if (warn) console.log('⚠ 提示 ' + warn + ' 处（不致命）');
console.log('✔ 检查通过');
process.exit(0);
