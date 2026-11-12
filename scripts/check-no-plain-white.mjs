#!/usr/bin/env node
/**
 * 站岗：禁止「亮白框」控件样式（2026-11-12 主人钦定根治）
 *
 * 主人原话：「功能页的【发送缓冲】的【改时长】里的那段话里的【3】【5】【存】的
 * 背景框是亮白色，和背景不符改一下，然后全局搜是否还存在用这种亮白框背景的
 * 地方，然后写检测代码禁止写这种样式的，彻底根治这种情况」
 *
 * 病根（两处同源）：
 *   ① JS 动态 createElement 的控件不在任何 .field 类里，裸吃浏览器 UA 默认样式
 *      = 亮白背景。CSS 静态规则管不到动态节点，只能靠**元素级全局兜底**根治。
 *   ② 类名有样式但选择器限定父级（.featRow .featEditBtn），元素插在父级外面
 *      就命中不了 —— 改成通用类规则。
 *
 * 钉四条（前三条正向、最后一条反向自检）：
 *   ① input/textarea/select 全局兜底规则在（带主题变量，排除 checkbox/radio/file）
 *   ② button 全局兜底在（透明底 + color:inherit）
 *   ③ .featEditBtn 是通用类规则（不带 .featRow 父级限定）
 *   ④ 页面里不许出现「动态控件 + 明文亮白背景」的内联写法
 *      （background:#fff / white / #ffffff 出现在 createElement 附近的内联 cssText 里）
 *   ⑤ 反向自检：站岗自己造一个「内联亮白」样例，确认能抓到（防站岗失灵）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label, detail ? '｜' + detail : ''); }
  else { fail++; console.log('  ❌', label, detail ? '｜' + detail : ''); }
}

const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');

console.log('\n控件亮白框根治：\n');

/* ── ① 全局兜底：input/textarea/select ── */
ok('全局兜底：input/textarea/select 主题化底色（排除 checkbox/radio/file）',
  /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="file"\]\),\s*\n\s*textarea, select \{[\s\S]{0,200}var\(--input-bg/.test(html));
ok('兜底规则里没有明文亮白背景',
  !/input:not\(\[type="checkbox"\]\)[\s\S]{0,300}background:\s*(#fff\b|white|#ffffff)/i.test(html));

/* ── ② 全局兜底：button ── */
ok('button 全局兜底（透明底 + color:inherit，动态裸按钮绝不亮白）',
  /\n\s*button \{\s*\n\s*background: transparent;\s*\n\s*color: inherit;/.test(html));

/* ── ③ .featEditBtn 通用规则 ── */
ok('.featEditBtn 是通用类规则（不带 .featRow 父级限定，主人报的【存】亮白根修）',
  /^\s*\.featEditBtn \{/m.test(html) && !/\.featRow \.featEditBtn \{/.test(html));
ok('发送缓冲的两个时长输入框内联样式带主题变量（双保险）',
  /width:56px;padding:3px 6px;background:var\(--input-bg/.test(html));

/* ── ④ 动态控件明文亮白检测 ── */
/* 找所有 createElement('input'|'button'|'textarea'|'select') 后 6 行内联 cssText/style 里的明文亮白 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
function findPlainWhiteInDynamicControls(code) {
  const bare = stripComments(code);
  const hits = [];
  const lines = bare.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/createElement\((['"])(input|button|textarea|select)\1\)/.test(lines[i])) continue;
    const win = lines.slice(i, i + 7).join('\n');
    /* 明文亮白背景（#fff/#ffffff/white），且不是后面被覆盖或 rgb 形式 */
    if (/\bbackground(-color)?\s*:\s*(#fff\b|#ffffff\b|white\b)/i.test(win)) {
      hits.push('L' + (i + 1));
    }
  }
  return hits;
}
const plainWhiteHits = findPlainWhiteInDynamicControls(html);
ok('动态控件内联样式里没有明文亮白背景',
  plainWhiteHits.length === 0, plainWhiteHits.length ? plainWhiteHits.join(', ') : '');
/* 静态 CSS 里的明文亮白：允许的例外（纸面设计/二维码可读性）逐一列名单，名单外不许有 */
const WHITE_ALLOW = [/\.kbForm input, \.kbForm textarea/, /\.kbForm input, body\.skin/, /\.kbBtns button/, /\.qqQrShot/, /#mobQr svg/];
{
  const cssWhite = [];
  const lines = stripComments(html).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/\bbackground(-color)?\s*:\s*(#fff\b|#ffffff\b|white\b)\s*;/i.test(lines[i])) continue;
    /* 找它所属的规则块开头（向上找最近一条 { 前的选择器行） */
    let sel = '';
    for (let j = i; j >= 0 && j > i - 12; j--) {
      if (lines[j].includes('{')) { sel = lines[j]; break; }
    }
    if (!WHITE_ALLOW.some((re) => re.test(sel))) cssWhite.push('L' + (i + 1) + ' ' + sel.trim().slice(0, 60));
  }
  ok('静态 CSS 里的明文亮白只在白名单内（纸面设计/二维码），名单外零容忍',
    cssWhite.length === 0, cssWhite.length ? cssWhite.slice(0, 4).join(' | ') : '');
}

/* ── ⑤ 反向自检：站岗自己抓自己造的坏样例 ── */
{
  const bad = `const b = document.createElement('button');
  b.style.cssText = 'padding:4px;background:#fff;color:#000;';`;
  ok('反向自检：站岗能抓到「动态控件 + 内联亮白」（防失灵）',
    findPlainWhiteInDynamicControls(bad).length === 1);
}

console.log('\n控件亮白框根治：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
