#!/usr/bin/env node
/**
 * 守卫：React hooks 必须写在**组件顶层的所有条件返回之前**。
 *
 * 【为什么非要有这个（真事）】
 * 2026-11-15 主人连着报两次「界面脚本出错了（这一行之后的东西都不会生效）」：
 *   · 第一次：Uncaught ReferenceError: snap is not defined —— renderRow 里用了外层的 snap
 *   · 第二次：Minified React error #310（Rendered more hooks than during the previous render）
 *
 * #310 的根因：我把 `const [collapsed, setCollapsed] = useState(false)`
 * 写在了 `if (!running.length && !extra.length) return null;` **后面**。
 * 没 worker 时少调一个 hook、有 worker 时多调一个 → React 当场崩掉整块渲染。
 *
 * 这类错**编译期发现不了**（esbuild 不跑 React 规则），崩起来是「后半屏全没了」，
 * 比白屏还难查。所以必须静态钉住。
 *
 * 【为什么不能只搜「return 后面有没有 hook」】
 * 第一版就是这么写的，结果满屏误报：`items.map((x) => { if (!x) return null; ... })`
 * 这种**回调里的** return 也被算成「提前返回」，可它跟 hooks 顺序毫无关系。
 * 现在按**括号深度**只认函数体顶层（depth===1）的 if-return，才准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'src-ui');

const HOOK_NAMES = new Set([
  'useState', 'useEffect', 'useLayoutEffect', 'useMemo', 'useRef', 'useCallback',
  'useReducer', 'useContext', 'useTransition', 'useDeferredValue', 'useId',
]);

/* 已知例外（文件名:函数名）。为空就是没有豁免 —— 有误报就往这里加，别关检查。 */
const ALLOW = new Set();

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(p);
  }
})(DIR);

/** 剥掉注释（保留长度，位置不变） */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:'"])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * 扫一个函数体，返回：
 *   guardAt —— 顶层条件 return 的位置（没有则 -1）
 *   hooks   —— 顶层 hook 调用的位置数组
 * 顶层 = 花括号深度 1（函数体那层）。
 */
function scanBody(body) {
  const src = stripComments(body);
  let depth = 0;
  let guardAt = -1;
  const hooks = [];

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }

    if (depth !== 1) continue;   // 只认函数体顶层，跳过所有嵌套回调

    /* 顶层 if (...) return —— 提前返回 */
    if (guardAt < 0 && c === 'i' && src.startsWith('if', i) && !/[\w$]/.test(src[i - 1] || '')) {
      /* 往后找到这一句的 end（分号或 } 结尾） */
      let j = i + 2;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '(') {
        /* 跳过括号 */
        let d = 0;
        for (; j < src.length; j++) {
          if (src[j] === '(') d++;
          else if (src[j] === ')') { d--; if (d === 0) { j++; break; } }
        }
        /**
         * 判定是不是「提前返回」。只看条件体**紧跟着的第一条语句**：
         *   if (x) return null;                             → 是（函数直接结束）
         *   if (x) { return <div/>; }                       → 是
         *   if (!ref.current) { ref.current = () => {…} }    → **不是**
         *      （return 在里面的箭头函数里，只是初始化一次回调，函数照常往下走）
         * 第一版把第三种也算成提前返回，于是 useTypeOut 假红。
         */
        const seg = src.slice(j, j + 120);
        const isEarlyReturn = /^\s*return\b/.test(seg) || /^\s*\{\s*return\b/.test(seg);
        if (isEarlyReturn) guardAt = i;
      }
    }

    /* 顶层 hook 调用 */
    if (/[A-Za-z_$]/.test(c) && !/[\w$.]/.test(src[i - 1] || '')) {
      const m = /^(use[A-Za-z0-9_$]*)\s*\(/.exec(src.slice(i, i + 60));
      if (m && HOOK_NAMES.has(m[1])) hooks.push(i);
    }
  }
  return { guardAt, hooks };
}

/**
 * 切出所有函数体。
 *
 * 【2026-11-15 修·这个函数自己有大 bug，导致整条检查形同虚设】
 * 原来写的是 `src.indexOf('{', h.index)` —— 直接找名字后面第一个 `{`。
 * 可组件几乎全是**解构参数**：`function TeamBar({ sid, items }) {`，
 * 第一个 `{` 是参数里的那个！于是函数体被切成 `{ sid, items }` 这一小截，
 * 里面既没有 if 也没有 hook，检查永远通过。
 * 也就是说：这条检查从上线起就没真正看过任何一个组件 —— 而 React #310
 * 恰恰就出在 TeamBar 里。
 *
 * 现在：先把**参数括号**整对跳过去，再从它后面找函数体的 `{`。
 */
function* bodies(src) {
  const headers = [
    ...src.matchAll(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g),
    ...src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g),
    ...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g),
  ].sort((a, b) => a.index - b.index);
  const seen = new Set();
  for (const h of headers) {
    if (seen.has(h.index)) continue;
    seen.add(h.index);
    const name = h[1];

    /* 先定位「参数列表结束」的位置：从名字后的第一个 ( 起，括号配平 */
    let from = h.index;
    const pOpen = src.indexOf('(', h.index);
    if (pOpen >= 0 && pOpen < h.index + 200) {
      let d = 0;
      for (let k = pOpen; k < src.length; k++) {
        if (src[k] === '(') d++;
        else if (src[k] === ')') { d--; if (d === 0) { from = k + 1; break; } }
      }
    }
    /* 从参数后面找函数体的 {
     * 箭头函数那一路已经带 `=> {`，这里同样适用（from 之后第一个 { 就是体）。 */
    let i = src.indexOf('{', from);
    if (i < 0) continue;
    let depth = 0;
    for (let k = i; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') {
        depth--;
        if (depth === 0) { yield { name, body: src.slice(i, k + 1) }; break; }
      }
    }
  }
}

let pass = 0;
let fail = 0;
const problems = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  for (const { name, body } of bodies(src)) {
    const { guardAt, hooks } = scanBody(body);
    if (guardAt < 0) { pass++; continue; }
    const after = hooks.filter((h) => h > guardAt);
    if (after.length && !ALLOW.has(rel + ':' + name)) {
      fail++;
      problems.push({ rel, name, n: after.length });
      console.log('  ✘ ' + rel + ' → ' + name + '：条件 return 之后还有 ' + after.length + ' 个 hook');
      console.log('      （React #310：hooks 每次渲染数量必须一致，否则整块渲染崩掉、后半屏全不生效）');
    } else {
      pass++;
    }
  }
}

console.log(`\n── UI hooks 顺序：${pass} 个函数干净 / ${fail} 个有问题 ──`);
if (!fail) console.log('（规矩：hooks 一律写在所有 if (...) return 之前）');
process.exit(fail ? 1 : 0);
