/**
 * check-teambar-flow.mjs — 守「⚑ N 个在后台干活…」是流里的最后一块，不是浮层。
 *
 * 主人 2026-11-16 澄清（第二次说这件事，第一次我理解反了）：
 *   「我要的不是滚轮往以前位置翻时子Agent干活的柜子直接消失，
 *     我要的是和正常柜子一样正常显示在屏幕上，只是固定显示在所有消息与工具调用显示下面」。
 *
 * 所以：
 *   · 它必须**没有任何 sticky/fixed** —— 有的话就会脱离阅读顺序、浮在旧消息上面，
 *     主人滚去看历史时它还挂在屏幕上，看着就是「跟着我的滚轮走」；
 *   · 它必须是 #log 的**最后一个子元素**（所有消息 / 工具卡 / 思考链之后）；
 *   · 宽度仍要受那把 892 的尺子约束（不能捅出消息栏两侧）。
 */
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../src-ui/TeamBar.jsx', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const logView = readFileSync(new URL('../src-ui/LogView.jsx', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/** 剥注释再看，免得「注释里提到 sticky」被误判 */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

/**
 * 取出某个选择器的全部声明（同名规则可能分散几处）。
 * 用字符串定位 + 括号计数，不动态拼正则（转义太容易出错）。
 */
function rule(src, sel) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(sel, from);
    if (at < 0) break;
    from = at + sel.length;
    /* 选择器后面（同一行/下一行）必须紧跟 { —— 否则只是被别的规则提到 */
    const brace = src.indexOf('{', from);
    if (brace < 0) break;
    const gap = src.slice(from, brace);
    if (gap.trim() !== '' && gap.trim() !== ',') continue;
    let depth = 1;
    let i = brace + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(src.slice(brace + 1, i - 1));
  }
  return out.join('\n');
}

const htmlBare = strip(html);
const uiBare = strip(ui);

const pageBar = rule(htmlBare, '#log > .teamBar');
const inlineBar = rule(uiBare, '.teamBar');
const hint = rule(uiBare, '.teamBar .teamHint');

ok('抓到 #log > .teamBar 的声明', pageBar.length > 20, pageBar.slice(0, 60));
ok('抓到组件内联 .teamBar 的声明', inlineBar.length > 20, inlineBar.slice(0, 60));

/* ① 不许 sticky / fixed */
ok('页面那条明确 static', /position:\s*static/.test(pageBar));
ok('页面那条不含 sticky（主人在意的就是它）', !/sticky/.test(pageBar));
ok('页面那条不含 fixed', !/fixed/.test(pageBar));
ok('组件内联也 static', /position:\s*static/.test(inlineBar));
ok('组件内联不含 sticky / fixed', !/sticky|fixed/.test(inlineBar));
ok('⚑ 按钮本身也不 sticky（原来 top:0 会粘在聊天区顶上）',
  !/sticky/.test(hint) && !/position:\s*sticky/.test(uiBare));

/* ② 没有「翻历史就消失」那套（主人明确不要消失） */
ok('没有 away 逻辑（不许自己消失）', !/away/.test(uiBare));
ok('内联样式里没有 opacity:0 的淡出', !/opacity:\s*0\s*;/.test(inlineBar));

/* ③ 位置：LogView 里排在所有行之后 */
const teamIdx = logView.indexOf('<TeamBar');
const rowIdx = logView.indexOf('{rows.map((r) => (');
ok('TeamBar 在 LogView 里排在 rows 之后（流末尾）',
  rowIdx > -1 && teamIdx > rowIdx,
  '顺序错了就会出现「柜子插在消息中间」');

/* ④ 宽度仍受那把尺子约束 */
ok('#log > .teamBar 仍在宽度尺子里',
  /#log > details\.tool, #log > details\.toolhub, #log > details\.think,\s*\n\s*#log > \.teamBar/.test(htmlBare)
  || /#log > \.teamBar\s*\{[\s\S]{0,400}max-width:\s*892px/.test(htmlBare),
  '尺子丢了会捅出消息栏两侧');

console.log('\n团队条按顺序排在最后：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
