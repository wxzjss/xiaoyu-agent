/**
 * check-compact-note.mjs — 守「压缩记忆别压成便签」。
 *
 * 主人 2026-11-16：「查压缩记忆是否存在问题」「你决定」。
 *
 * 查出来的问题很具体：**提示词写 1200 字，程序硬上限也是 1200 字**。
 * 而真实会话的压缩比能到「553 条 → 1200 字」（搭建鱼那段）——
 * 一小时的工作只剩一张便签，细节全灭，重启后当然「忘了做过什么」。
 *
 * 改了两处，必须成套改，改一处等于没改：
 *   ① src/self-compress.mjs 的 SELF_NOTE_MAX（程序会按这个数截断）
 *   ② 提示词里的字数上限 + 六块固定结构
 *
 * 六块是给「以后能接上」用的：目标 / 清单 / 已定的决定 / 关键路径命令参数 / 坑 / 现在断在哪。
 */
import { readFileSync } from 'node:fs';

const sc = readFileSync(new URL('../src/self-compress.mjs', import.meta.url), 'utf8');
const prompt = readFileSync(new URL('../persona/FACTORY-PROMPT.md', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/* ① 程序硬上限 */
const m = /SELF_NOTE_MAX\s*=\s*(\d+)/.exec(sc);
const cap = m ? Number(m[1]) : 0;
ok('找到 SELF_NOTE_MAX', cap > 0, String(cap));
ok('上限 ≥ 3000 字（1200 那版会把一小时的工作压成便签）', cap >= 3000, '现在是 ' + cap);

/* ② 提示词：字数上限与六块 */
ok('提示词里的上限跟程序一致（都写 3000）',
  prompt.includes('最多 ' + cap + ' 字') || prompt.includes('最多' + cap + '字'),
  '提示词写小了 = 模型自己就把内容砍掉，程序上限再大也没用');

for (const block of ['## 目标', '## 清单', '## 已定的决定', '## 关键路径', '## 坑', '## 现在断在哪']) {
  ok('提示词要求写「' + block + '」', prompt.includes(block));
}

/* ③ 别退回旧写法 */
ok('提示词里不再出现「最多 1200 字」', !/最多\s*1200\s*字/.test(prompt));

console.log('\n压缩记忆：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
