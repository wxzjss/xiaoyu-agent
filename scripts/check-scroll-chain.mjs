#!/usr/bin/env node
/**
 * 守卫：`overscroll-behavior` 不许写不存在的值。
 *
 * 【这个坑的现场（2026-11-15，主人报）】
 * 主人：「工具调用显示展开后的滚轮能带动柜子上下滚，思考链的不行。」
 *
 * 查下去发现：上一版修复写的是
 *     details.toolhub details.tool pre,
 *     details.toolhub details.think .thinkBody { overscroll-behavior: normal; }
 * 而 `overscroll-behavior` 的合法值只有 **auto | contain | none** —— **没有 normal**。
 * 写了非法值，Chromium 把**整条声明（整条规则）丢掉**，于是「放行」从来没生效过。
 *
 * 最要命的地方：它不报错、不警告、看不出任何异常。
 *   · 工具卡看着正常 —— 因为它压根没被设成 contain，默认就是 auto，撞对了；
 *   · 思考链坏了 —— 它的 .thinkBody 被显式设了 contain，滚到头不给柜子接力。
 * 也就是说：一句写错的 CSS，让「同一件事」在两个地方表现相反，
 * 而人只会觉得「思考链有 bug」，根本想不到是上一版修复自己没生效。
 *
 * CDP 实测对照（修复前后，柜子 hubBody 的 scrollTop）：
 *   修复前  思考链 0      工具卡 9.3   ← 不一致
 *   修复后  思考链 17.3   工具卡 9.3   ← 一致
 *
 * 【这个脚本钉什么】
 *   1. 页面里所有 overscroll-behavior / -x / -y 的声明值，只能是 auto/contain/none。
 *   2. 柜子内的 B 框（画思考的 .thinkBody、画工具输出的 pre）必须是 auto 或 none，
 *      不能是 contain —— 否则「滚到头带柜子一起滚」这件事就断了。
 *   3. 注释里的示例不算数（先剥注释再看，否则文档里写个反例就假红）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'public', 'index.html');

let pass = 0;
let fail = 0;
const one = (cond, name, detail = '') => {
  if (cond) { pass++; console.log('  ✔ ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  ✘ ' + name + (detail ? '   ' + detail : '')); }
};

const raw = fs.readFileSync(HTML, 'utf8');

/* 只取 <style> … </style> 之间的内容，再把 CSS 注释剥掉 ——
 * 注释里出现的「反例」「历史写法」不能当成真声明来判。 */
const styles = [];
for (const m of raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) styles.push(m[1]);
one(styles.length > 0, '找到了页面里的 <style> 块', styles.length + ' 段');

const css = styles.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');

/* ① 所有 overscroll-behavior 声明的值都要合法 */
const VALID = new Set(['auto', 'contain', 'none']);
const bad = [];
for (const m of css.matchAll(/overscroll-behavior(?:-[xy])?\s*:\s*([^;}]+)/gi)) {
  const vals = m[1].trim().toLowerCase().split(/\s+/);
  for (const v of vals) {
    if (!VALID.has(v)) bad.push(m[0].trim());
  }
}
one(bad.length === 0,
  'overscroll-behavior 的值都合法（只允许 auto / contain / none）',
  bad.length ? '非法：' + [...new Set(bad)].join(' | ') : '');

/* ② 柜子内的 B 框必须放行（不能 contain）——这是主人要的那件事本身 */
const chainRules = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].replace(/\s+/g, ' ').trim();
  const decl = m[2];
  if (!/overscroll-behavior/.test(decl)) continue;
  chainRules.push({ sel, decl: decl.replace(/\s+/g, ' ') });
}
const thinkChain = chainRules.filter((r) => /thinkBody/.test(r.sel));
one(thinkChain.length > 0, '有专门给柜子里 thinkBody 的 overscroll-behavior 规则',
  thinkChain.map((r) => r.sel).join(' | ').slice(0, 80));
const thinkOk = thinkChain.some((r) => /overscroll-behavior\s*:\s*(auto|none)/.test(r.decl));
one(thinkOk, '柜子里的 thinkBody 是放行的（auto/none），滚到头能带动柜子',
  thinkChain.map((r) => r.decl).join(' | ').slice(0, 90));

/* ③ 柜子内容区（.hubBody）必须放行（auto/none）：A 框滚到头要能带动上下文
 *
 * 【2026-11-17 判据反向·主人报「A 框滚到极限为什么不带动上下文」】
 * 原来这条要求 .hubBody 自己带 contain —— 那是 2026-11-11 的取舍
 * （防「一撸到底把整个对话也滚走」）。可代价是 A 到头之后**彻底死掉**，
 * 主人只能把鼠标挪出去再滚。
 * 现在改成 auto：链继续往上走，真正的边界交给 JS 精确判断
 * （src-ui/LogView.jsx 的 fromInnerScroller）—— 只有 A 真的到头、
 * 滚轮还在往那个方向推时才让上下文接管，中途滚动仍全归 A。
 * 所以断言要跟着反过来：contain 才是错的。 */
const hubRules = chainRules.filter((r) => /hubBody/.test(r.sel));
const hubOk = hubRules.some((r) => /overscroll-behavior\s*:\s*(auto|none)/.test(r.decl));
one(hubOk, '柜子内容区 .hubBody 是放行的（auto/none），滚到头能带动上下文',
  hubRules.map((r) => r.decl).join(' | ').slice(0, 90));

/* ④ 思考块在柜子里不能被 overflow:hidden 截住滚动链 */
one(/details\.toolhub details\.think\s*\{\s*overflow\s*:\s*visible/.test(css),
  '柜子里的 details.think 是 overflow: visible（不半路截住滚动链）');

console.log(`\n── 滚动链（思考链 ↔ 柜子）：${pass} 过 / ${fail} 挂 ──`);
process.exit(fail ? 1 : 0);
