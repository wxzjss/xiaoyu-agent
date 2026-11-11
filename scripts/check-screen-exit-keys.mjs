/**
 * 【关屏·解除键只许 Esc 与右键】—— 2026-11-11
 *
 * 主人 2026-11-11 定：PrtSc / Delete / Insert / Home / End / PgUp / PgDn / NumLock
 * 全部不许再解除黑屏（空格、左键、鼠标移动也不解除），只留 **Esc** 和 **鼠标右键**。
 *
 * 真机那一轮（逐键实按）需要人动手按键盘，没法进回归；但**结论是可以自动钉住的**：
 * 黑屏期间会不会被某个键解除，完全取决于那两个轮询循环里扫描了什么。
 * 这条检查就钉这件事，谁把某个键偷偷加回扫描路径，立刻红。
 *
 * 它验四件事：
 *   ① 默认参数只有 Esc（0x1B），别把别的键写回默认值
 *   ② 被移除的那 8 个 VK 码只允许出现在「键名映射表」里（SelfTest / DetectKey 用），
 *      不许出现在轮询扫描路径里
 *   ③ 两个轮询循环（预启动 / 黑屏）里，退出判据只来自 `$ExitKeys` 扫描、右键 0x02、
 *      以及锁屏/超时兜底 —— 没有别的手写键码
 *   ④ 文案（features 描述 / 工具说明 / 界面提示）不许再提那 8 个键能解除
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';

const t = makeChecker('tool / 关屏解除键');

const ps1 = fs.readFileSync('scripts/screen-off.ps1', 'utf8');
const ui = readUISource();

/* ── ① 默认值只有 Esc ─────────────────────────────────────────── */
t.ok('默认 -ExitKeys 只有 0x1B（Esc）',
  /\[int\[\]\]\$ExitKeys\s*=\s*@\(\s*0x1B\s*\)/.test(ps1),
  (ps1.match(/\[int\[\]\]\$ExitKeys\s*=\s*@\([^)]*\)/) || ['没找到'])[0]);

/* 被移除的 8 个键（PrtSc Delete Insert Home End PgUp PgDn NumLock） */
const REMOVED = [
  { code: '0x2C', name: 'PrtSc' },
  { code: '0x2D', name: 'Insert' },
  { code: '0x2E', name: 'Delete' },
  { code: '0x21', name: 'PgUp' },
  { code: '0x22', name: 'PgDn' },
  { code: '0x23', name: 'End' },
  { code: '0x24', name: 'Home' },
  { code: '0x90', name: 'NumLock' },
];

/**
 * 找出「键名映射」那一段的行号区间（VkName / SelfTest / DetectKey 用，允许出现这些码）。
 * 实际写法是 C# switch 里的一句：   case 0x2C: return "PrintScreen(PrtSc)";
 * 这行的作用只是「起个中文名给人看」，不参与任何按键判定 —— 所以豁免。
 */
function mapLineSet(src) {
  const ok = new Set();
  src.split(/\r?\n/).forEach((line, i) => {
    /* C# switch 的键名分支 */
    if (/^\s*case\s+0x[0-9A-Fa-f]{2}\s*:\s*return\s+"/.test(line)) { ok.add(i); return; }
    /* 另一种写法：0x2C = 'PrtSc' */
    if (/^\s*0x[0-9A-Fa-f]{2}\s*=\s*'[^']*'\s*,?\s*$/.test(line)) ok.add(i);
  });
  return ok;
}
const mapLines = mapLineSet(ps1);

/* ── ② 8 个被移除的键不许出现在扫描路径 ──────────────────────── */
for (const r of REMOVED) {
  const bad = [];
  ps1.split(/\r?\n/).forEach((line, i) => {
    if (mapLines.has(i)) return;                        // 键名表豁免
    if (/^\s*#/.test(line)) return;                     // 注释（说明文案）豁免
    if (new RegExp('\\b' + r.code + '\\b', 'i').test(line)) bad.push(i + 1);
  });
  t.ok('扫描路径里没有 ' + r.code + '（' + r.name + '）', bad.length === 0,
    bad.length ? '出现在第 ' + bad.join(',') + ' 行' : '');
}

/* ── ③ 两个轮询循环的退出判据来源 ─────────────────────────────── */
/* 循环里必须扫 $ExitKeys，必须有右键 0x02，必须有超时兜底 */
t.ok('预启动/黑屏两个循环都在扫 $ExitKeys',
  (ps1.match(/foreach\s*\(\s*\$k\s+in\s+\$ExitKeys\s*\)/g) || []).length >= 2,
  '找到 ' + (ps1.match(/foreach\s*\(\s*\$k\s+in\s+\$ExitKeys\s*\)/g) || []).length + ' 处');
t.ok('右键（VK 0x02）仍能解除',
  /\$prev\[\s*0x02\s*\]|IsDownNow\(\s*0x02\s*\)/.test(ps1));
t.ok('超时兜底还在（$TimeoutSec）',
  /TimeoutSec/.test(ps1) && /超时/.test(ps1));

/* 关键：循环体里出现的「裸 VK 字面量」只许是 0x02（右键） */
{
  /* 抓到 foreach ($k in $ExitKeys) 所在的循环体（用大括号配对） */
  const bodies = [];
  const re = /foreach\s*\(\s*\$k\s+in\s+\$ExitKeys\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(ps1))) {
    const open = ps1.indexOf('{', m.index);
    let depth = 0;
    for (let k = open; k < ps1.length; k++) {
      if (ps1[k] === '{') depth += 1;
      else if (ps1[k] === '}') {
        depth -= 1;
        if (depth === 0) { bodies.push(ps1.slice(open, k + 1)); break; }
      }
    }
  }
  t.ok('抓到扫描循环体', bodies.length >= 1, '共 ' + bodies.length + ' 个');
  const bad = [];
  for (const b of bodies) {
    for (const mm of b.matchAll(/\b0x([0-9A-Fa-f]{2})\b/g)) {
      const v = parseInt(mm[1], 16);
      if (v === 0x02) continue;             // 右键，允许
      if (v === 0x1B) continue;             // Esc 走的是 $ExitKeys 里的值，万一写死也算合法
      bad.push('0x' + mm[1].toUpperCase());
    }
  }
  t.ok('扫描循环体里没有其它写死的键码', bad.length === 0, bad.join(','));
}

/* ── ④ 文案一致性：不许再提那 8 个键能解除 ────────────────────── */
{
  const badWords = ['PrtSc', 'PrintScreen', 'NumLock', 'Insert', 'PgUp', 'PgDn'];
  const hits = [];
  for (const w of badWords) {
    /* 界面与功能描述里出现「解除」+ 这个键名 → 说明文案又写错了 */
    if (new RegExp(w + '[^<\\n]{0,20}(解除|退出|关闭黑屏)', 'i').test(ui)) hits.push(w + '(界面)');
  }
  t.ok('界面文案没有「某键可解除」的残留', hits.length === 0, hits.join(','));
  /* 功能描述里必须明确只有 Esc 与右键 */
  t.ok('功能描述写明只有 Esc / 右键',
    /Esc/.test(ui) && /右键/.test(ui));
}

t.done();
