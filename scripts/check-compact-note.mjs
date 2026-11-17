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

for (const block of ['## 目标', '## 清单', '## 已定的决定', '## 关键路径', '## 坑', '## 主人原话', '## 现在断在哪']) {
  ok('提示词要求写「' + block + '」', prompt.includes(block));
}
/* 【2026-11-17 加】「主人原话」这一块必须在两处都写清（程序那份指令 + 出厂提示词），
 * 只改一处 = 她根本不会写这一节。 */
{
  const scSrc2 = sc;
  ok('程序那份指令里也有「## 主人原话」', scSrc2.includes('## 主人原话'));
  ok('两处都写明「照抄、别概括」', /照抄/.test(prompt) && /照抄/.test(scSrc2));
  ok('两处都写「七块」（块数要跟着改，不然她按六块写就漏了）',
    /七块/.test(prompt) && /七块/.test(scSrc2));
}

/* ③ 别退回旧写法 */
ok('提示词里不再出现「最多 1200 字」', !/最多\s*1200\s*字/.test(prompt));

/* ④【2026-11-17 加·三个真 bug，一次性钉住】
 *
 * 现场：鲸娘建模鱼那个会话「一直不停写压缩记忆」。查出来是三件事叠在一起：
 *   a. `acceptSelfNote` 里引用了**从没定义过**的 ADVISOR_LINE →
 *      每存一次抛一次 ReferenceError → 被上层 try/catch 静默吞掉 →
 *      本子永远是空的 → 上层以为她没写 → 再递工作单 → 她再写。
 *   b. `saveSelfNote` 落盘走 appendDigest，而它 `.slice(0,300)` →
 *      上限写 3000，实际只存 300（实测保住 11%）。
 *   c. 落本子只写在「整轮正常收尾」那个分支里 → 长任务被停止/超限时，
 *      她写的记忆当场蒸发。
 *
 * 测法：不看注释，**真跑一遍**，用假会话 id 写 2000 字再读回来比对。
 */
{
  const scSrc = sc;
  ok('ADVISOR_LINE 有定义（不是只引用）',
    /const\s+ADVISOR_LINE\s*=/.test(scSrc),
    '只有引用没有定义 = 每存一次抛一次 ReferenceError，压缩记忆永远存不进去');

  const agentSrc = readFileSync(new URL('../src/agent.mjs', import.meta.url), 'utf8');
  ok('agent.mjs 每圈收流就尝试落本子（不只在整轮收尾）',
    /_liveNote\s*=\s*String\(_noteGate\.note/.test(agentSrc),
    '长任务被停止/超限时不走收尾分支，记忆会整段蒸发');
  ok('落本子成功后会摘掉旧工作单',
    /dropCompressOrders\(\)/.test(agentSrc));
  ok('收尾那次落盘会跳过已存过的那份',
    /_noteRaw\s*!==\s*_noteSavedRaw/.test(agentSrc));
  ok('折叠成功后把这份笔记作废（别让下一段拿旧摘要压新内容）',
    /clearSelfNote\(/.test(agentSrc));

  /* 真跑：写入 → 读回 → 长度必须基本不缩水 */
  const probe = await (async () => {
    try {
      const mod = await import(new URL('../src/self-compress.mjs', import.meta.url).href);
      const sid = '__probe_compact_note_' + process.pid;
      const seg = 'seg-9-probe' + process.pid;
      const line = '这一行是测试用来占长度的事实：src/agent.mjs 第 100 行，数字 20261117。';
      const body = '【压缩记忆·' + seg + '】\n## 目标\n' + (line + '\n').repeat(25);
      const w = mod.saveSelfNote(sid, body);
      if (!w || !w.ok) return { err: 'saveSelfNote 没收：' + String(w && w.reason) };
      const got = mod.lastSelfNote(sid, seg);
      return { wrote: body.length, read: got.length, got };
    } catch (e) {
      return { err: String(e && e.message || e) };
    }
  })();

  if (probe.err) {
    ok('压缩记忆能真的存进本子并读回来', false, probe.err);
  } else {
    ok('压缩记忆能真的存进本子并读回来', probe.read > 0);
    ok('读回来的长度不缩水（≥80%，别被 300 字摘要上限砍掉）',
      probe.read >= probe.wrote * 0.8,
      '写入 ' + probe.wrote + ' 字，读回 ' + probe.read + ' 字');
    ok('段号能对上（按段取的那份就是这一段）', probe.got.includes('seg-9-probe'));

    /* 用掉之后必须作废：否则下一段会拿上一段的摘要压新内容 */
    const tomb = await (async () => {
      try {
        const mod = await import(new URL('../src/self-compress.mjs', import.meta.url).href);
        mod.clearSelfNote('__probe_tomb_' + process.pid, 'seg-9-probe');
        return mod.lastSelfNote('__probe_tomb_' + process.pid, 'seg-9-probe');
      } catch (e) { return 'ERR:' + String(e && e.message || e); }
    })();
    ok('作废之后读不回来（墓碑生效，两条路都不许复活）',
      tomb === '', '还读到了 ' + String(tomb).length + ' 字');
  }
}

console.log('\n压缩记忆：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
