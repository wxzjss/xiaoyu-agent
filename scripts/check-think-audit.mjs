/**
 * 【2026-11-06 严检】thinking 泄漏的全面体检。
 *
 * 主人要求：各个角度严格检查，只要检查中出现一次问题，修完再从头完整查一遍，
 * 直到完整一轮零问题。
 *
 * 覆盖的角度：
 *  ① llm.mjs   —— 逐块剥（流式）
 *  ② llm.mjs   —— 拼完整再剥（收尾）
 *  ③ sessions-core —— 读盘两道门 + 剥的效果
 *  ④ 前端 public/index.html —— stripThinkingTags（历史渲染 + 流式 + MutationObserver）
 *  ⑤ 盘上的真实会话数据 —— 还有没有残留
 *  ⑥ 误伤检查 —— 普通尖括号、提到 "thinking" 这个词
 *  ⑦ 冷门形态 —— 大写 / 带属性 / 嵌套 / 未闭合 / 多个连用 / 全文只有思考
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
const fails = [];
const ok = (label) => { pass++; console.log('  ✔ ' + label); };
const bad = (label, detail) => { fails.push(label + (detail ? '  [' + detail + ']' : '')); console.log('  ✘ ' + label + (detail ? '  → ' + detail : '')); };
const eq = (label, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) ok(label); else bad(label, JSON.stringify(got) + ' ≠ ' + JSON.stringify(want)); };
const yes = (label, cond, detail) => { if (cond) ok(label); else bad(label, detail); };

// ── 取出三份 stripThinkTags 的实现，逐个跑同一套用例 ──────────────
/**
 * 按行切到函数结尾（顶格的那个 `}`）。
 *
 * 不能用「数括号」的办法：函数体里有正则和字符串，里面的 { } 会把计数带偏，
 * HTML 那份就是这么被切坏的（第一轮严检里报「找得到 stripThinkTags」失败，
 * 其实是提取器的问题，不是代码的问题）。
 */
function extractFn(src, name) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => l.indexOf('function ' + name) >= 0);
  if (start < 0) return null;
  const indent = lines[start].match(/^\s*/)[0].length;
  /* 顶格写的 `export function xxx` 不能直接塞进 new Function —— 先把 export 摘掉 */
  const first = lines[start].replace(/\bexport\s+/, '');
  const out = [first];
  for (let i = start + 1; i < lines.length; i++) {
    out.push(lines[i]);
    if (lines[i].trim() === '}' && lines[i].match(/^\s*/)[0].length === indent) break;
  }
  return out.join('\n');
}

const CASES = [
  ['成对完整', '前文<thinking>想法</thinking>后文', '前文后文'],
  ['大写', '<THINKING>大写想</THINKING>后文', '后文'],
  ['带属性', 'a<thinking type="x">想</thinking>b', 'ab'],
  /* 单个孤立结束标签：只能把标签本身拿掉，「接着想」这三个字谁都认不出来
     （起始标签在前一块已经被吃掉了）—— 所以这里的正确答案是保留它，
     真正拦住这种残渣的是 agent.mjs 的「拼完整再剥」，下面单独验。 */
  ['跨块残渣（只去标签）', '接着想</thinking>你好', '接着想你好'],
  ['孤立结束标签', ' </thinking>\n正文', ' \n正文'],
  ['大写孤立结束', '</THINKING>大写', '大写'],
  ['未闭合到结尾', '话说一半<thinking>还没想完', '话说一半'],
  ['多个连用', '<thinking>a</thinking>中间<thinking>b</thinking>尾巴', '中间尾巴'],
  ['全文只有思考', '<thinking>全是想的</thinking>', ''],
  ['短标签 think', '正常<think>短</think>段落', '正常段落'],
  ['reasoning', 'A<reasoning>想</reasoning>B', 'AB'],
  ['普通尖括号', 'a < b 且 c > d', 'a < b 且 c > d'],
  ['提到 thinking 这个词', '我觉得 thinking 很重要', '我觉得 thinking 很重要'],
  ['代码里写标签', '```\n<thinking>示例</thinking>\n```', '```\n\n```'],
];

/* 前端那个函数叫 stripThinkingTags（多了 ing），后端两个都叫 stripThinkTags —— 别弄混 */
const sources = [
  ['llm.mjs', 'src/llm.mjs', 'stripThinkTags'],
  ['sessions-core.mjs', 'src/sessions-core.mjs', 'stripThinkTags'],
  ['public/index.html', 'public/index.html', 'stripThinkingTags'],
];

for (const [label, rel, fnName] of sources) {
  const src = read(rel);
  const fnSrc = extractFn(src, fnName);
  if (!fnSrc) { bad(label + ' 里找得到 ' + fnName); continue; }
  let fn;
  try {
    fn = new Function(fnSrc + '\nreturn ' + fnName + ';')();
  } catch (e) {
    bad(label + ' 的 ' + fnName + ' 能独立求值', String(e.message).slice(0, 60));
    continue;
  }
  let allOk = true;
  for (const [name, input, want] of CASES) {
    let got;
    try { got = fn(input); } catch (e) { got = 'THROW:' + e.message; }
    if (got !== want) { allOk = false; bad(label + ' | ' + name, JSON.stringify(got) + ' ≠ ' + JSON.stringify(want)); }
  }
  if (allOk) ok(label + ' 的 stripThinkTags：' + CASES.length + ' 种形态全过');
}

// ── 流式：必须有状态地剥（跨块残渣的真正解法） ──────────────
{
  const llmSrc = read('src/llm.mjs');
  yes('llm.mjs 导出了 createThinkStripper', /export function createThinkStripper/.test(llmSrc));
  yes('流式那一段用的是有状态的 _feedThink', /_feedThink\(delta\.content\)/.test(llmSrc));
  yes('流式不再一块一块独立剥', !/const cleaned = stripThinkTags\(delta\.content\)/.test(llmSrc));
  let mk = null;
  try {
    const mod = await import('../src/llm.mjs');
    mk = mod.createThinkStripper;
  } catch (e) {
    bad('能 import createThinkStripper', String(e.message).slice(0, 50));
  }
  if (typeof mk === 'function') {
    const STREAM_CASES = [
      [['<thinking>我在想', '，还没想完</thinking>你好呀'], '你好呀', '标签切在两块中间'],
      [['<thin', 'king>想</thin', 'king>正文'], '正文', '标签本身被劈开'],
      [['正文<thinking>想', '</thinking>尾巴'], '正文尾巴', '正文前后各一段'],
      [['<thinking>', '纯思考', '</thinking>', '正文'], '正文', '四块完整包着'],
      [['<thinking>想', '</thinking>'], '', '整条只有思考'],
      [['没有标签的一句话'], '没有标签的一句话', '无标签原样'],
      [['a < b 且 c > d'], 'a < b 且 c > d', '普通尖括号不误伤'],
      [['<THINKING>大写', '</THINKING>后'], '后', '大写标签'],
      [['话说一半<thinking>没闭合'], '话说一半', '未闭合'],
    ];
    let allOk = true;
    for (const [parts, want, name] of STREAM_CASES) {
      const feed = mk();
      const got = parts.map((p) => feed(p)).join('');
      if (got !== want) { allOk = false; bad('流式 | ' + name, JSON.stringify(got) + ' ≠ ' + JSON.stringify(want)); }
    }
    if (allOk) ok('流式有状态剥离：' + STREAM_CASES.length + ' 种切法全过');
  }
}

// ── llm.mjs 必须导出，agent.mjs 必须收尾再剥 ──────────────
const llm = read('src/llm.mjs');
yes('llm.mjs 导出 stripThinkTags', /export function stripThinkTags/.test(llm));
const ag = read('src/agent.mjs');
yes('agent.mjs 引了 stripThinkTags', /import \{[^}]*stripThinkTags[^}]*\} from '\.\/llm\.mjs'/.test(ag));
yes('agent.mjs 流结束后整体再剥一次', /text = stripThinkTags\(text\);/.test(ag));

// ── sessions-core 两道门都要认「结束标签」 ──────────────
const sc = read('src/sessions-core.mjs');
/* 【2026-11-08 改准】原来筛的是「所有 typeof m.content === 'string' && test(m.content) 的行」，
 * 可 11-07 又加了一道**角色标签**的门（assistant/user/system），它当然不含 thinking ——
 * 于是这条永远红。它要守的是「thinking 那几道门必须认结束标签」，先筛出 thinking 的门再判。 */
const guardLines = sc.split(/\r?\n/).filter((l) => l.includes("typeof m.content === 'string'")
  && l.includes('test(m.content)')
  && l.includes('thinking'));
yes('sessions-core 读盘外门认结束标签', guardLines.length > 0 && guardLines.every((l) => l.includes('<\\/?(thinking')), String(guardLines.length) + ' 行');

// ── 前端：三处渲染出口都要套上 ──────────────
const ui = read('public/index.html');
yes('前端 mdInto 里剥了', /stripXmlToolCalls\(stripCompressMemoryText\(stripThinkingTags\(rawText\)\)\)/.test(ui));
/* 【2026-11-09 换框架】原来这里断言 `paintSpeech` 里也剥一遍 —— paintSpeech 已删。
 * 换成断言**行为等价物**：React 那一侧的每个正文气泡都必须走同一条渲染入口
 * （MdDiv → window.mdInto），也就是「没有第二个绕过剥标签的出口」。 */
const mdDiv = read('src-ui/MdDiv.jsx');
yes('React 正文只有一个渲染入口（MdDiv → mdInto）',
  /mdInto\(inner\.current, text\)/.test(mdDiv) && /from '\.\.\/ui\/bridge\.js'|from '\.\/bridge\.js'/.test(mdDiv));
{
  /* 没有人绕开 MdDiv 直接塞 innerHTML/textContent 画正文 */
  const uiFiles = fs.readdirSync('src-ui').filter((f) => /\.(jsx|js)$/.test(f));
  const raw = uiFiles.filter((f) => /dangerouslySetInnerHTML/.test(read('src-ui/' + f)));
  yes('src-ui 里没有 dangerouslySetInnerHTML（正文字节都走 mdInto）', raw.length === 0, raw.join(','));
}
/* 【2026-11-09 换框架·这条也退化了】
 * 原来这里有四格在验「DOM 监听清洗器」：装没装、调没调、覆盖哪些选择器、认不认新增节点。
 * 换 React 之后，`installTagCleaner()` 已经变成 `return false;` 的**空壳**（正文只走 mdInto，
 * 浏览器里再也不会有「手写插进来的节点」需要扫）。所以：
 *   · 如果它还是空壳 —— 不假装「清洗器在工作」，如实记 skip，并说明防护只剩 mdInto 一条；
 *   · 如果将来有人把它真装回来 —— 那四格照旧要过（选择器 + addedNodes 一个都不能少）。
 * 这样这条检查既不会因为「删了死代码」而假红，也不会因为「空壳还在」而假绿。 */
{
  const stub = /function installTagCleaner\(\)\s*\{\s*return false;\s*\}/.test(ui);
  if (stub) {
    console.log('  [--] DOM 监听清洗器已退化为空壳（正文只走 mdInto，防护只剩一条）');
  } else {
    yes('前端装了 DOM 监听清洗', /function installTagCleaner\(\)/.test(ui));
    yes('监听真的被调起来', /installTagCleaner\(\);\s*\}\s*catch/.test(ui));
    yes('清洗覆盖 bubble/thinkBody/md/pre', /SEL = '\.bubble, \.thinkBody, \.md, pre'/.test(ui));
    yes('清洗器会查「新加进来的节点」', /m\.addedNodes/.test(ui));
  }
}

// ── 盘上的真实会话：一条不留 ──────────────
/* 【2026-11-09】隔离回归时扫临时目录，别去翻主人的会话 */
const DATA = process.env.XY_TEST_DATA || process.env.MINI_AGENT_DATA || 'C:/Users/35453/AppData/Roaming/小鱼Agent/data';
const sessDir = path.join(DATA, '.state', 'sessions');
let dirty = 0, scanned = 0;
const dirtySamples = [];
try {
  for (const f of fs.readdirSync(sessDir)) {
    if (!f.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8')); } catch { continue; }
    const ms = Array.isArray(d.messages) ? d.messages : [];
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m) continue;
      scanned++;
      const c = typeof m.content === 'string' ? m.content : '';
      if (!c) continue;
      // 盘上的脏数据本身不算错 —— 读的时候会被剥掉。这里只统计「读之后还脏不脏」。
      const low = c.toLowerCase();
      if (low.indexOf('<thinking') >= 0 || low.indexOf('</thinking>') >= 0) {
        dirty++;
        if (dirtySamples.length < 3) dirtySamples.push(f + '#' + i + ' role=' + m.role);
      }
    }
  }
} catch (e) {
  bad('能扫会话目录', String(e.message).slice(0, 50));
}
console.log('  · 盘上扫了 ' + scanned + ' 条消息，含标签的 ' + dirty + ' 条（读盘时会被剥掉，不算失败）');
if (dirtySamples.length) dirtySamples.forEach((s) => console.log('    - ' + s));

// ── 结果 ──────────────
console.log('');
if (fails.length) {
  console.log('★ 失败 ' + fails.length + ' 条（通过 ' + pass + '）');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('PASS 严检第 1 轮：' + pass + ' 项全过');
