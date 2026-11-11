#!/usr/bin/env node
/**
 * 【2026-11-11 加·markdown 渲染自检】
 *
 * 为什么要有：mdInto/mdInline/emitMdBlocks 是 public/index.html 里的内联函数，
 * 改它最容易「老七类被顺手改坏」。这份检查把渲染函数**原样抽出来**，
 * 在一个最小 DOM 桩上跑，覆盖：
 *   · 老七类：代码块 / 表格 / 标题 / 列表 / 粗体 / 行内代码 / 裸链接
 *   · 新四类：引用块（含嵌套 + XSS 转义） / 嵌套列表 / 删除线 / 任务列表
 *   · hljs 降级：vendor 没加载 / 语言不认 → 纯色不断流
 *
 * 用法：node scripts/check-md-render.mjs
 * 退出码：0 = 全过；1 = 有断言失败。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function slice(startMark, endMark) {
  const a = html.indexOf(startMark);
  const b = html.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error('抽取失败：找不到标记 ' + (a < 0 ? startMark : endMark));
  return html.slice(a, b);
}

/* 渲染函数本体 + repairMojibakeOnly（mdInto 依赖，定义在文件更后面） */
const code =
  slice('function mdHasFeature', '/**\n * 【2026-11-05 重做·把换行处理提出来】') +
  slice('function repairMojibakeOnly', 'function fixMojibake') +
  '\nreturn { mdInto, mdInline, mdHasFeature };';

/* ---- 最小 DOM 桩：只实现渲染链用到的那些 ---- */
class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this._text = null;
    this._classes = new Set();
    this.attrs = {};
    this.onclick = null;
    this.target = '';
    this.rel = '';
    this.checked = false;
    this.disabled = false;
    this.type = '';
    this.innerHTML = '';
    const self = this;
    this.classList = {
      add: (...cs) => cs.forEach((c) => self._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => self._classes.delete(c)),
      contains: (c) => self._classes.has(c),
    };
    let cls = '';
    Object.defineProperty(this, 'className', {
      get: () => cls,
      set(v) { cls = String(v); self._classes = new Set(cls.split(/\s+/).filter(Boolean)); },
    });
  }
  appendChild(c) {
    if (typeof c === 'string') c = new StubText(c);
    this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  get children() { return this.childNodes.filter((c) => c instanceof StubNode); }
  get lastElementChild() { const ch = this.children; return ch[ch.length - 1] || null; }
  get textContent() {
    if (this._text !== null && !this.childNodes.length) return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) { this._text = String(v); this.childNodes = []; }
}
class StubText extends StubNode {
  constructor(t) { super('#text'); this._text = String(t); }
  get tagName() { return '#text'; }
  set tagName(v) { /* noop */ }
  appendChild() { return null; }
}
const doc = {
  createElement: (t) => new StubNode(t),
  createTextNode: (t) => new StubText(t),
};

/* 抽出的函数里 `document` 是自由变量，参数注入；window 由用例决定（降级测试） */
const makeRender = (windowObj) => new Function('document', 'window', code)(doc, windowObj);

/* hljs vendor 在 Node 里加载一份，给「高亮成功」用例用 */
function loadHljs() {
  const src = readFileSync(join(ROOT, 'public', 'vendor', 'hljs-common.min.js'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.hljs || null;
}

/* ---- 断言小工具 ---- */
let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const render = (r, text) => {
  const el = new StubNode('div');
  r.mdInto(el, text);
  return el;
};
const kids = (el, tag) => el.children.filter((c) => c.tagName === String(tag).toUpperCase());
const text = (n) => n.textContent;
/** 递归收集后代（段落内容都在 .mdp 里，得往深处找） */
const deep = (n, out = []) => {
  for (const c of n.children) { out.push(c); deep(c, out); }
  return out;
};
const deepFind = (el, pred) => deep(el).find(pred);

console.log('── 老七类（一个都不能坏）──');
{
  const r = makeRender({});
  // 1 代码块
  let el = render(r, '前面\n```js\nconst a = 1;\n```\n后面');
  const box = kids(el, 'div').find((d) => d.classList.contains('mdcode'));
  ok(!!box, '代码块 → .mdcode');
  const pre = box && box.children.find((c) => c.tagName === 'PRE');
  const c = pre && pre.children.find((x) => x.tagName === 'CODE');
  ok(!!c && c.dataset.lang === 'js' && text(c).includes('const a = 1;'), '代码块 pre>code，lang=js，内容原样', c && { lang: c.dataset.lang, t: text(c) });
  // 2 表格（外面包着一层 .mdtable）
  el = render(r, '| 项 | 值 |\n|---|---|\n| a | 1 |');
  const tb = deepFind(el, (x) => x.tagName === 'TABLE');
  ok(!!tb && tb.children.length === 2 && text(tb).includes('项') && text(tb).includes('1'), '表格 → .mdtable>table>thead+tbody');
  // 3 标题
  el = render(r, '## 二级标题');
  const h = el.children.find((x) => x.classList.contains('mdh2'));
  ok(!!h && text(h) === '二级标题', '标题 → .mdh2');
  // 4 列表
  el = render(r, '- 甲\n- 乙\n- 丙');
  const ul = el.children.find((x) => x.tagName === 'UL');
  ok(!!ul && ul.children.length === 3 && text(ul).includes('丙'), '无序列表 3 项（合成一个 ul）');
  el = render(r, '1. 甲\n2. 乙');
  const ol = el.children.find((x) => x.tagName === 'OL');
  ok(!!ol && ol.children.length === 2, '有序列表 2 项');
  // 5 粗体 6 行内代码 7 裸链接
  el = render(r, '这是**加粗**和`行内`加 https://example.com/x 链接');
  ok(!!deepFind(el, (x) => x.tagName === 'STRONG') && text(el).includes('加粗'), '粗体 → strong');
  ok(!!deepFind(el, (x) => x.tagName === 'CODE' && text(x) === '行内'), '行内代码 → code');
  const a = deepFind(el, (x) => x.tagName === 'A');
  ok(!!a && a.href === 'https://example.com/x', '裸链接 → a[href]', a && a.href);
  // 无特征不动
  el = render(r, '就是一句话');
  ok(el.children.length === 0 && !el.classList.contains('md') && text(el) === '就是一句话', '无 markdown 特征 → 原样 textContent');
}

console.log('── 新四类 ──');
{
  const r = makeRender({});
  // 引用块：多行连续
  let el = render(r, '> 引用一行\n> 引用二行');
  const bq = el.children.find((x) => x.tagName === 'BLOCKQUOTE');
  ok(!!bq && text(bq).includes('引用一行') && text(bq).includes('引用二行'), '引用块 → blockquote，多行连续', bq && text(bq));
  ok(bq && !bq._classes.has('x'), '引用块样式挂 blockquote 标签');
  // 嵌套引用
  el = render(r, '> 外层\n> > 内层');
  const outer = el.children.find((x) => x.tagName === 'BLOCKQUOTE');
  const inner = outer && outer.children.find((x) => x.tagName === 'BLOCKQUOTE');
  ok(!!inner && text(inner).includes('内层') && text(outer).includes('外层'), '嵌套引用 > > 递归成双层 blockquote');
  // 引用内行内语法
  el = render(r, '> **粗**在引用里');
  const bq2 = el.children.find((x) => x.tagName === 'BLOCKQUOTE');
  ok(!!bq2 && !!deepFind(bq2, (x) => x.tagName === 'STRONG'), '引用内走行内处理（strong 不丢）');
  // XSS：引用里的 <script> 必须原样转义显示
  el = render(r, '> <script>alert(1)</script>');
  const bq3 = el.children.find((x) => x.tagName === 'BLOCKQUOTE');
  const noScript = JSON.stringify(bq3, (k, v) => (k === 'parentNode' ? undefined : v)).includes('"SCRIPT"') === false;
  ok(!!bq3 && noScript && text(bq3).includes('<script>alert(1)</script>'), 'XSS：引用内 <script> 只当文字（无 SCRIPT 节点）');
  // 嵌套列表
  el = render(r, '- 甲\n  - 乙\n    - 丙\n- 丁');
  const ul1 = el.children.find((x) => x.tagName === 'UL');
  const li1 = ul1 && ul1.children[0];
  const ul2 = li1 && li1.children.find((x) => x.tagName === 'UL');
  const li2 = ul2 && ul2.children[0];
  const ul3 = li2 && li2.children.find((x) => x.tagName === 'UL');
  ok(ul1 && ul2 && ul3
    && text(ul1.children[0]).startsWith('甲')
    && text(ul2.children[0]).startsWith('乙')
    && text(ul3.children[0]).startsWith('丙')
    && ul1.children.length === 2 && ul1.children[1].tagName === 'LI',
    '嵌套列表 ul>li>ul>li>ul 三层 + 同层继续', ul1 && [ul1.children.length, ul2.children.length]);
  // 有序嵌无序
  el = render(r, '1. 第一\n   - 子项');
  const ol = el.children.find((x) => x.tagName === 'OL');
  const sub = ol && ol.children[0].children.find((x) => x.tagName === 'UL');
  ok(!!ol && !!sub && text(sub).includes('子项'), '有序列表嵌无序子表');
  // 删除线
  el = render(r, '这段~~不要了~~保留');
  const del = deepFind(el, (x) => x.tagName === 'DEL');
  ok(!!del && text(del) === '不要了', '删除线 ~~xx~~ → del');
  // 任务列表
  el = render(r, '- [ ] 待办的事\n- [x] 办完的事');
  const tul = el.children.find((x) => x.tagName === 'UL');
  const boxes = tul && tul.children.map((li) => li.children.find((x) => x.tagName === 'INPUT'));
  ok(tul && boxes.length === 2 && boxes.every((b) => b && b.type === 'checkbox' && b.disabled === true)
    && boxes[0].checked === false && boxes[1].checked === true
    && text(tul.children[0]).includes('待办的事'),
    '任务列表 [ ]/[x] → 只读勾选框（disabled），状态正确', boxes && boxes.map((b) => b && { c: b.checked, d: b.disabled }));
}

console.log('── hljs 高亮与降级 ──');
{
  const hljs = loadHljs();
  ok(!!hljs && typeof hljs.highlightElement === 'function', 'vendor hljs bundle 在 Node 里可加载', !!hljs);
  // 高亮成功：code 带上 hljs 类与高亮 innerHTML（stub 支持 innerHTML 属性）
  const rHi = makeRender({ hljs });
  let el = render(rHi, '```js\nconst a = 1;\n```');
  const box0 = el.children[0];
  const pre0 = box0.children.find((x) => x.tagName === 'PRE');
  const code2 = pre0 && pre0.children.find((x) => x.tagName === 'CODE');
  ok(!!code2 && code2._classes.has('hljs') && String(code2.innerHTML).includes('hljs-keyword'),
    'hljs 高亮：code.hljs + keyword span', code2 && { cls: code2.className, html: String(code2.innerHTML).slice(0, 80) });
  ok(code2.dataset.lang === 'js', '语言角标数据：dataset.lang=js 仍在');
  // 降级 1：window.hljs 不存在 → 纯色，不抛错
  const rNo = makeRender({});
  el = render(rNo, '```js\nconst a = 1;\n```');
  let box1 = el.children[0];
  let c2 = box1.children.find((x) => x.tagName === 'PRE').children.find((x) => x.tagName === 'CODE');
  ok(text(c2) === 'const a = 1;' && !c2._classes.has('hljs'), '降级：hljs 未加载 → 原样纯色');
  // 降级 2：语言不认 → 纯色
  el = render(rHi, '```notalang\nabc\n```');
  box1 = el.children[0];
  const c3 = box1.children.find((x) => x.tagName === 'PRE').children.find((x) => x.tagName === 'CODE');
  ok(text(c3) === 'abc' && !c3._classes.has('hljs'), '降级：语言不认 → 原样纯色');
  // 语言角标 span
  const box2 = el.children[0];
  const tag = box2.children.find((x) => x.tagName === 'SPAN' && x.classList.contains('mdlang'));
  ok(!!tag && text(tag) === 'notalang', '语言角标：.mdlang span 显示语言名');
  const boxJs = render(rHi, '```go\nx := 1\n```').children[0];
  ok(boxJs.classList.contains('haslang') && boxJs.children.find((x) => x.classList.contains('mdlang')).textContent === 'go', '语言角标：haslang 类 + go 角标');
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
