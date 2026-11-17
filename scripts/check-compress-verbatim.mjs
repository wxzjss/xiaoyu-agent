#!/usr/bin/env node
/**
 * check-compress-verbatim.mjs — 【压缩后主人原话必须还在】
 *
 * 【2026-11-17 加·跟市面上那几家比出来的缺口】
 *
 * 三家的压缩结构对照：
 *   · WorkBuddy  9 段，第 6 段「All user messages」尽量保留原话
 *   · Claude Code 9 段，同样单列用户消息，verbatim
 *   · 小鱼老版    4 段（主人要什么/已经做完/还没做完/关键约束）—— **全是概括**
 *
 * 概括的代价是实打实的，而且当天就吃过：
 * 主人说「全部完整复制粘贴、一字不改」，压过之后只剩
 * 「主人要求导出上下文」，等他回头看，「一字不改」这个硬约束已经没了。
 *
 * 所以加第五节「主人原话」，并且这个哨兵钉四件事：
 *   ① 标签表、三份提示词里都得有它（少一处 = 模型压根不会写）；
 *   ② 它那一节**不许被顾问腔过滤器误杀**（主人的话里本来就可能出现「建议」）；
 *   ③ renderForSummary 采样时主人原话享优先权（别按人均额度先砍成半句）；
 *   ④ 程序兜底摘要（buildRescueNote）也要把主人原话抄下来。
 *
 * 全部用**真跑**验，不只 grep 源码 —— 「常量对、链路断」这种坑今天已经踩过一次。
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('compress / 主人原话');
const src = fs.readFileSync('src/compress.mjs', 'utf8');
const core = fs.readFileSync('src/compact-core.mjs', 'utf8');

/* ── ① 标签表 + 三份提示词 ──
 * 注意：模型摘要这条路 2026-10-30 已被主人停用（只认她亲手写的压缩记忆），
 * 所以这三份提示词现在是**老路径/死代码**，这里只钉「别哪天又改回去写成四标签」。
 * 真正在跑的是下面 ②③④⑤ 那几条。 */
t.ok('标签表登记了「主人原话」', /SUMMARY_TAGS\s*=\s*\[[^\]]*'主人原话'/.test(src));
t.ok('SUMMARY_SYSTEM 要求写「主人原话」', /主人原话:\s*\n/.test(src));
t.ok('frameSummaryInput（模型那份）要求写「主人原话」',
  /'主人原话:',/.test(src));
t.ok('HER_SUMMARY_SYSTEM（她自己那份）也要求写',
  (src.match(/主人原话:/g) || []).length >= 3);
t.ok('提示词明确「照抄不是概括」', /照抄原话|是\*\*抄\*\*/.test(src));
t.ok('点明要保留「不许/必须/只能」这类硬话', /不许.*必须.*只能|「不许」「必须」「只能」/.test(src));

/* ── ①b 真正在跑的那条：她自己写压缩记忆的指令 ──
 * 这才是主路径。模型摘要停用之后，「主人原话」只能靠她按指令亲手写进笔记里。 */
{
  const selfc = fs.readFileSync('src/self-compress.mjs', 'utf8');
  const factory = fs.readFileSync('persona/FACTORY-PROMPT.md', 'utf8');
  t.ok('她写笔记的指令里有「## 主人原话」块', selfc.includes('## 主人原话'));
  t.ok('出厂提示词里也有这一块', factory.includes('## 主人原话'));
  t.ok('明确「别概括、别转述，他怎么写就怎么留」',
    /别概括、别转述/.test(selfc) && /别概括、别转述/.test(factory));
  t.ok('两处块数都说「七块」（改块数忘了改这句 = 她照六块写，漏掉原话）',
    /七块/.test(selfc) && /七块/.test(factory));
}

/* ── ② 那一节不许被顾问腔过滤误杀 ── */
t.ok('清洗里有「主人原话那一节放行」的分支', /inUserQuote/.test(src));

/* ── ③ 采样时主人原话优先 ── */
t.ok('renderForSummary 给主人原话单独留额度', /isUserLine/.test(src) && /SUMMARY_USER_TOTAL_MAX/.test(src));

/* ── ④ 兜底摘要也抄原话 ── */
t.ok('buildRescueNote 里有「主人原话」一节', /主人原话（照抄/.test(core));

/* ── ⑤ 真跑：清洗不许把照抄的那节洗掉 ── */
{
  const mod = await import('../src/compress.mjs');
  const clean = mod.cleanSummary;
  t.ok('cleanSummary 能直接调用（已提到模块顶层，可测）', typeof clean === 'function');

  if (typeof clean === 'function') {
    const raw = [
      '主人原话:',
      '- 别改那套单元，我要的是插话这条链路。',
      '- 建议你先看清楚再动手，别一把梭。',      // 带「建议」，旧版会被顾问腔误杀
      '- 45 秒那条也得一起修，不许只修一半。',
      '- 一个字都不许改，我说的是原文。',
      '主人要什么:',
      '- 修插话链路。',
      '已经做完:',
      '- src/server.mjs 改了 12 行。',
      '还没做完:',
      '- 45 秒那条没动。',
      '关键约束:',
      '- 45 秒 = 45000 毫秒。',
    ].join('\n');
    const out = clean(raw);
    t.ok('洗完还留着「主人原话」这一节', /主人原话:/.test(out));
    t.ok('原话逐条还在（含带「建议」的那句）',
      out.includes('别改那套单元') && out.includes('建议你先看清楚'));
    t.ok('「不许只修一半」「一个字都不许改」都在',
      out.includes('不许只修一半') && out.includes('一个字都不许改'));
    t.ok('别的四节也没被挤掉',
      /主人要什么:/.test(out) && /已经做完:/.test(out) && /还没做完:/.test(out) && /关键约束:/.test(out));
    t.ok('限长没有把它截掉（≥3000，尾巴上的关键约束才保得住）',
      /SUMMARY_TEXT_MAX\s*=\s*(\d+)/.test(src) && Number(/SUMMARY_TEXT_MAX\s*=\s*(\d+)/.exec(src)[1]) >= 3000);
  }
}

/* ── ⑥ 真跑：超长会话采样时，主人原话不能被先砍掉 ── */
{
  const mod = await import('../src/compress.mjs');
  const render = mod.__for_test?.renderForSummary;
  const LIMIT = mod.__for_test_quality?.SUMMARY_INPUT_MAX || 26000;
  t.ok('renderForSummary 能从测试出口拿到', typeof render === 'function');
  if (typeof render === 'function') {
    const big = 'x'.repeat(3000);
    const msgs = [];
    /* 塞一堆又长又没用的工具流水，把预算挤满 */
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: 'tool', content: big });
      msgs.push({ role: 'assistant', content: big });
    }
    /* 再夹几句主人原话 —— 这几句必须活下来 */
    msgs.push({ role: 'user', content: '【关键】不许把 server.mjs 里的 who 判断改回去，我说的是原文照抄。' });
    msgs.push({ role: 'user', content: '【关键】45 秒 = 45000 毫秒，别写成 150。' });
    const rendered = render(msgs);
    t.ok('采样后仍在预算内', rendered.length <= LIMIT + 400, '长度 ' + rendered.length + ' / 上限 ' + LIMIT);
    t.ok('主人原话在采样后仍然完整可读（不许改回去那句）',
      rendered.includes('不许把 server.mjs 里的 who 判断改回去'));
    t.ok('主人原话里的数字也在（45000 不是 150）', rendered.includes('45000'));
    t.ok('工具流水被压短了（证明真的压了）', rendered.length < 40 * 3000);
  }
}

/* ── ⑦ 真跑：兜底摘要带主人原话 ── */
{
  const mod = await import('../src/compact-core.mjs');
  if (typeof mod.buildRescueNote === 'function') {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '把这套压缩改成保留原话，不许概括。' },
      { role: 'assistant', content: '好的，我先看一下 compress.mjs 里怎么写的，再动手改。现在开始读文件。' },
      { role: 'user', content: '还有 45 秒那条也要一起修。' },
    ];
    const note = mod.buildRescueNote(msgs, { planText: '目标：改压缩', segId: 'seg-1-abc' });
    t.ok('兜底摘要里出现「主人原话」', /主人原话/.test(note));
    t.ok('兜底摘要抄到了主人那句「不许概括」', note.includes('不许概括'));
    t.ok('兜底摘要抄到了「45 秒」那句', note.includes('45 秒'));
  }
}

t.done();
