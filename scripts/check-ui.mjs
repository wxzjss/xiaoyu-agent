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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
/** 判断这个 / 是「正则开头」还是「除号」。只看前一个非空白字符。 */
function looksLikeRegexStart(out) {
  let k = out.length - 1;
  while (k >= 0 && (out[k] === ' ' || out[k] === '\n' || out[k] === '\r' || out[k] === '\t')) k--;
  if (k < 0) return true;
  const p = out[k];
  if ('(,=:[!&|?{};+-*%<>~^'.includes(p)) return true;
  if (p === ')') return false;
  // return /re/ 这种：看前面几个字符是不是关键字
  const tail = out.slice(Math.max(0, k - 8), k + 1);
  if (/\b(return|typeof|case|in|of|void|delete|instanceof|new|do|else|yield|await)$/.test(tail)) return true;
  return false;
}

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
    /* 【2026-11-06 修·漏了正则字面量，实测吞掉 83% 的代码】
     * 页面里 replace(/^[\s\n]+/, '') 这种写法，老版本会把 / 当成普通字符，
     * 于是 / 里的 ' 被当成字符串开头，一路吃到下一个 ' —— 中间几千行代码全被吞。
     * 结果：那一段里的未声明变量永远查不出来（真出过一次：addSysNote 里被塞了残骸没人发现）。
     */
    if (c === '/' && looksLikeRegexStart(out)) {
      i++;
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '/') { i++; break; }
        if (code[i] === '\n') break;
        i++;
      }
      while (i < n && /[gimsuy]/.test(code[i])) i++;
      out += "''";
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
    if (VOID.has(tag)) continue;
    const open = countRealTags(html, tag, 'open');
    const close = countRealTags(html, tag, 'close');
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
  /**
   * 【2026-11-08 拆分配套】public/ui/*.js 也是页面脚本的一部分
   * —— 普通 <script> 引进来、定义在全局。这里把它们并进「已声明」的扫描范围，
   * 否则主脚本里调 hubPeekOf 会被判成「被当变量用但没声明」，
   * 而那正是我们刚拆出去的那个函数（拆之前当然也在主脚本里）。
   * 只用来收声明，不参与「用法」分析 —— 用法的判断仍然只看主脚本。
   */
  let _uiCode = '';
  try {
    const _uiDir = join(process.cwd(), 'public', 'ui');
    if (existsSync(_uiDir)) {
      for (const f of readdirSync(_uiDir)) {
        if (f.endsWith('.js')) _uiCode += '\n' + readFileSync(join(_uiDir, f), 'utf8');
      }
    }
  } catch (e) {}
  const code = scripts.map((s) => s.code).join('\n') + _uiCode;
  const declared = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}/g)) {
    for (const p of m[1].split(',')) declared.add(p.trim().split(':').pop().trim());
  }
  /**
   * 【2026-11-09 修·数组解构没被算成「已声明」→ 假红】
   *
   * 这条是 #15「对话区改 React 声明式重写」逼出来的：React 里满屏都是
   *   const [open, setOpen] = useState(false);
   * 而上面那两条只认 `const x` 和 `const {a, b}`，**不认 `const [a, b]`** ——
   * 于是 setOpen 被判成「被当变量用但没声明」，preflight 整条红，
   * 报的还是「这个页面打开会白屏」，纯粹冤枉（bundle 是能跑的）。
   *
   * 实测 2026-11-09：public/ui/log.bundle.js 里 5 处数组解构，
   * 修前 preflight ✘ 致命 2 处，修后 ✔。
   *
   * 注意：只把方括号里那些**裸标识符**登记成声明；`[k, v]`、`[a = 1]`、
   * `[...rest]` 都要认，嵌套的 `[[x, y]]` 也过一遍（递归展开）。
   */
  const addArrayPattern = (inner) => {
    // 展开嵌套：[ [a, b], c ] → 一段一段剥
    let s = inner;
    let prev = '';
    while (s !== prev) { prev = s; s = s.replace(/\[([^[\]]*)\]/g, '$1'); }
    for (const p of s.split(',')) {
      const nm = p.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) declared.add(nm);
    }
  };
  /**
   * 【找数组解构的方括号必须配平，不能用 /\[([^\]]*)\]/】
   *
   * 2026-11-09 第一版就是那么写的，`const [outerX, [innerY, innerZ]] = ...`
   * 会在**内层**第一个 `]` 处截断，拿到的是 `outerX, [innerY, innerZ` ——
   * 内层名字全成了垃圾串，`innerY` 照样被判未声明。
   * 写成嵌套解构的检查（check-ui-destructuring 的 ⑥）当场就抓到了。
   *
   * 现在手工配平：从 `[` 往后数方括号深度，回到 0 才算这一段结束。
   */
  const scanArrayPatterns = (text) => {
    const re = /\b(?:const|let|var)\s*\[/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
        else if (c === '\n' && depth === 0) break; // 没闭合就别跨行瞎抓
      }
      if (end > open) addArrayPattern(text.slice(open + 1, end));
    }
  };
  scanArrayPatterns(code);
  /* 函数参数里的数组解构：function f([a, b]) / ([a, b]) => 也要认 */
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const mm of m[1].matchAll(/\[([^[\]]*)\]/g)) addArrayPattern(mm[1]);
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
  /**
   * 【2026-11-09 加·class 的方法名不算「未声明的变量」】
   *
   * 用例：React 的错误边界
   *   class RowBoundary extends React.Component {
   *     static getDerivedStateFromError(err) { … }
   *     componentDidCatch(err, info) { … }
   *   }
   * 这两个是**方法定义**（`名字(...) {`），不是变量用法。
   * 收集器只认 `function name(` / `const x =` / 参数 / 箭头函数，于是把它们
   * 报成「被当变量用但全文没有声明」→ preflight 判「页面会白屏」，冤枉。
   *
   * 修法：把 `class ... { … }` 整块按大括号配平抠出来，只在这块里认
   * `^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?名字\s*\(`。
   * 限定在 class 体内是刻意的 —— 全局范围这么认会把普通调用当成定义（那就把检查改哑了）。
   */
  for (const m of code.matchAll(/class\s+[A-Za-z_$][\w$]*[^{]*\{/g)) {
    const from = m.index + m[0].length - 1;
    let d = 0;
    let to = from;
    for (let k = from; k < code.length; k++) {
      if (code[k] === '{') d++;
      else if (code[k] === '}') { d--; if (d === 0) { to = k; break; } }
    }
    const body = code.slice(from, to + 1);
    for (const mm of body.matchAll(/^[ \t]*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
      declared.add(mm[1]);
    }
  }
  // 先把注释和字符串字面量挖掉，剩下的才是真·标识符用法
  const bare = stripCommentsAndStrings(code);
  const suspicious = new Set();
  for (const m of bare.matchAll(/\b([a-z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*)\b/g)) {
    const n = m[1];
    if (declared.has(n)) continue;
    if (BROWSER_GLOBALS.has(n)) continue;
    /* 【2026-11-06 修·两处真缺口 + 两处误报】
     *
     * 缺口①（真）原来只认 = ( ? : 和调用/属性访问。`const q = zzzMissingVarX + 1;`
     *   这种后面跟算术运算符的写法被当成「不是在当变量用」直接放过，
     *   负向自检里那条「引用一个没声明的驼峰变量」抓不到，破坏就留在页面上了。
     *
     * 缺口②（更严重，今天才发现）stripCommentsAndStrings 原来不认正则字面量。
     *   页面里 replace(/^[\s\n]+/, '') 这类写法会把 / 里的引号当字符串开头，
     *   一路吃到下一个引号 —— 那段代码整片被吞掉，里面的变量永远查不到。
     *   实测修前只保留 16.6% 的代码，修后 64.5%。
     *
     * 误报① 对象字面量的 key：{ agentIds: ids } —— 后面跟 : 不是「当变量用」。
     * 误报② typeof 保护过的：typeof healthNow !== 'undefined' && healthNow —— 人家自己防了。
     *
     * 仍然保守：小写裸名（如 zzzmissingvar）不查，误报太多；这个缺口在文件末尾写着。
     */
    const re = new RegExp(
      '(?:^|[^.\\w$])(?:!' + n + '\\b|' + n + '\\s*(?:\\(|&&|\\|\\||\\?|\\.|=[^=]))'
      /* 算术运算符那条必须带同一个前缀约束，否则 el.clientWidth + 20 里的
       * clientWidth 会被当成裸变量（实测 10 处假阳性）。 */
      + '|(?:^|[^.\\w$])' + n + '\\s*[+*/%]'
    );
    if (!re.test(bare)) continue;
    /* 【2026-11-06 修·两种误报，实测各命中一次】
     * ① 对象字面量的 key：{ agentIds: ids } —— 后面跟 : 不是「当变量用」
     * ② typeof 保护过的：typeof healthNow !== 'undefined' && healthNow —— 人家自己防了
     * 这两种都不是 bug，排掉。 */
    if (new RegExp('(?:^|[^\\w$.])' + n + '\\s*:').test(bare)) continue;
    if (new RegExp('typeof\\s+' + n + '\\b').test(bare)) continue;
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

function stripScriptAndComments(html) {
  let s = html;
  // 挖掉 <script>...</script> 的内容，但保留 script 标签本身，方便数 script 配对
  s = s.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => m.replace(body, ''));
  // 挖掉 HTML 注释
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // 挖掉 <style> 内容里的 /* */（style 标签本身保留）
  s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, body, b) => a + body.replace(/\/\*[\s\S]*?\*\//g, '') + b);
  return s;
}

function countRealTags(html, tag, kind) {
  const stripped = stripScriptAndComments(html);
  const re = kind === 'close' ? new RegExp('</' + tag + '\\s*>', 'gi') : new RegExp('<' + tag + '\\b[^>]*>', 'gi');
  return (stripped.match(re) || []).length;
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
