#!/usr/bin/env node
/**
 * check-stream-silent.mjs — 【断流重续不许往界面上发任何提示】
 *
 * 【2026-11-17 主人第二次强调】
 *   「还有我要求是【断流重续不发任何系统提示】」
 *
 * 上一版只去掉了「每轮开始·第一条」那套，但断流分支里还留着两个：
 *   · n===30/60/120 时 notice「上游已经断了 N 次…」
 *   · 每次断流都 onEvent({type:'retry'}) + text(notice)「（连接断了一下，接着往下写…）」
 * 而 .sysnote 是 white-space:pre-wrap，正文里前后各两个换行被如实画出来
 * → 一行字被撑成大方块（主人截图里那个）。
 *
 * 几条一起钉：
 *   ① 断流/截断重续的代码段里，不允许出现任何面向界面的提示；
 *   ② SysNote 必须 trim 首尾空白，别的系统提示也不许是大方块。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('stream / 断流静默');

/** 去掉注释，只留真代码 —— 注释里提到那几句提示不算违规。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const agent = stripComments(fs.readFileSync('src/agent.mjs', 'utf8'));
const ui = fs.readFileSync('src-ui/SysNote.jsx', 'utf8');

/* ── ① 断流分支：从 isStreamDropped 到 limited，不许有界面提示 ── */
{
  const at = agent.indexOf('if (isStreamDropped(err))');
  const end = agent.indexOf('const limited = isRateLimited', at);
  const seg = at >= 0 && end > at ? agent.slice(at, end) : '';
  t.ok('能找到断流分支', seg.length > 150);

  const calls = [...seg.matchAll(/onEvent\(\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]);
  const bad = calls.filter((x) => x !== 'flush_draft');
  t.ok('断流分支不再发任何界面提示', bad.length === 0, '还发着：' + bad.join(','));
  t.ok('断流分支仍保留 flush_draft（落盘不丢字）', calls.includes('flush_draft'));
  t.ok('断流分支不再发 retry 事件', !/type:\s*'retry'/.test(seg));
  t.ok('断流分支不再有「接着往下写…」的界面提示', !/接着往下写…/.test(seg));
  t.ok('断流临时指令标了 _dropRetryHint（一次性）', /_dropRetryHint:\s*true/.test(seg));
  t.ok('断流临时指令带 context（不进历史）', /context:\s*true/.test(seg));
  t.ok('断流不再有 30/60/120 次的界面通报', !/上游已经断了/.test(seg));
}

/* ── ② 截断续写（length 截断）同样静默 ── */
{
  const at = agent.indexOf('上一句太长被截断了');
  const seg = at >= 0 ? agent.slice(at, at + 700) : '';
  t.ok('能找到截断续写分支', seg.length > 50);
  t.ok('截断续写不弹「说到这儿断了一下」', !/说到这儿断了一下/.test(seg));
  t.ok('截断续写的指令也是一次性的', /_dropRetryHint:\s*true/.test(seg));
}

/* ── ③ SysNote 必须 trim 首尾空白（否则一行字撑成大方块） ── */
t.ok('SysNote 对正文做了首尾 trim', ui.includes("u3000") && ui.includes("replace("));

/* ── ④ 样式别退回大内边距 ── */
{
  const html = fs.readFileSync('public/index.html', 'utf8');
  const m = /\.sysnote\s*\{([\s\S]*?)\}/.exec(html);
  const body = m ? m[1] : '';
  t.ok('能找到 .sysnote 样式', body.length > 50);
  t.ok('.sysnote 内边距不再是大块（padding 首值 ≤ 4px）', /padding:\s*[0-4]px/.test(body));
  t.ok('.sysnote 行高收在 1.5 附近', /line-height:\s*1\.5/.test(body));
}

t.done();
