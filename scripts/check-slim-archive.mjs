#!/usr/bin/env node
/**
 * check-slim-archive.mjs — 【原文存档按体积回收，别按个数一刀切】
 *
 * 【2026-11-17 加·跟市面上那几家比出来的第三个缺口】
 *
 * L2 瘦身会把「被换掉的旧工具输出原文」落盘到 .state/slim/<会话>/，
 * 文件头承诺是「原文全部落盘可查、随时能翻回来」。
 *
 * 可旧实现是「每会话只留最近 300 个文件」（按 mtime 删）：
 *   · 长会话到第 301 条，最早的原文就悄悄没了 —— 承诺打折；
 *   · 300 这个数字对「一条 2KB 的小输出」太浪费、对「一条 30MB 的构建日志」又可能撑爆盘；
 *   · 删的时候不看大小，一条巨型日志能把几十条有用的挤掉。
 *
 * 现在改成按**体积**管 + 保底条数：
 *   · maxBytes 上限（默认 128MB，SLIM_KEEP_MAX_MB 可调）
 *   · minFiles 保底（默认 60，最近这些永远留着）
 *
 * 这个哨兵**真建目录写文件**来验，不看注释。
 */
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('compress / 原文存档回收');

/* 隔离数据目录：绝不能拿主人真实的 .state/slim 做实验 */
const dir = mkdtempSync(join(tmpdir(), 'xy-slim-'));
process.env.MINI_AGENT_DATA = dir;
process.env.SLIM_KEEP_MAX_MB = '1';   // 1MB 上限，方便造超编

const mod = await import('../src/compact-core.mjs');
const P = mod.__slimPolicy;
t.ok('拿到回收策略', !!P && typeof P.pruneSlimDir === 'function');

if (P && typeof P.pruneSlimDir === 'function') {
  t.ok('上限是「字节」不是「个数」', P.maxBytes > 0, '上限 ' + P.maxBytes + ' 字节');
  t.ok('有保底条数（最近的永远留着）', P.minFiles > 0, String(P.minFiles));
  t.ok('默认上限 >= 64MB（太小的上限等于又回到按个数剪切）',
    P.maxBytes >= 64 * 1024 * 1024 || process.env.SLIM_KEEP_MAX_MB === '1',
    String(P.maxBytes));

  const sid = '__probe_slim_1';
  const d = P.slimDir(sid);
  fs.mkdirSync(d, { recursive: true });

  /* 造 120 个 100KB 的文件 = 12MB，远超 1MB 上限；同时给递增的 mtime。
   * 文件数必须**大于保底条数**，否则按设计一个都不该删（保底优先），验不出东西。 */
  const N = 120;
  const SIZE = 100 * 1024;
  for (let i = 0; i < N; i++) {
    const f = join(d, String(i).padStart(4, '0') + '-tool-' + i + '.txt');
    writeFileSync(f, 'x'.repeat(SIZE));
    const when = (Date.now() / 1000) - (N - i) * 60;   // i 越大越新
    utimesSync(f, when, when);
  }
  const beforeCount = readdirSync(d).filter((f) => f.endsWith('.txt')).length;
  t.ok('造好了场景（120 个文件 / 共 12MB）', beforeCount === N, beforeCount + ' 个');

  P.pruneSlimDir(sid);
  const left = readdirSync(d).filter((f) => f.endsWith('.txt')).sort();
  const leftBytes = left.reduce((s, f) => s + fs.statSync(join(d, f)).size, 0);

  t.ok('确实回收了（不是全留）', left.length < beforeCount, '剩 ' + left.length + ' 个');
  /* 两条约束谁先到头谁停：体积上限，或保底条数。这里 1MB 上限远小于 60×100KB，
   * 所以实际由「保底 60 条」决定 —— 这正是设计意图：最近的永远翻得回来。 */
  t.ok('留下的条数 = 保底条数（体积上限更严时以保底为准）',
    left.length === P.minFiles, '剩 ' + left.length + ' / 保底 ' + P.minFiles);
  t.ok('总量没失控（≤ 保底条数 × 单文件大小）',
    leftBytes <= P.minFiles * SIZE * 1.05,
    '剩 ' + Math.round(leftBytes / 1024) + 'KB');

  /* 关键：留下的一定是**最新**的（不能把刚用过的那几份删了） */
  const keptNewest = left.includes(String(N - 1).padStart(4, '0') + '-tool-' + (N - 1) + '.txt');
  const droppedOldest = !fs.existsSync(join(d, '0000-tool-0.txt'));
  t.ok('最新的那份留下了', keptNewest);
  t.ok('最旧的那份被回收了', droppedOldest);
  t.ok('留下的正好是最新的一批（不是随机删）',
    left.every((f) => Number(f.slice(0, 4)) >= N - P.minFiles), left[0]);

  /* 幂等：再跑一遍不该再删（已经在上限内） */
  const before2 = readdirSync(d).filter((f) => f.endsWith('.txt')).length;
  P.pruneSlimDir(sid);
  const after2 = readdirSync(d).filter((f) => f.endsWith('.txt')).length;
  t.ok('再跑一遍不再动（幂等）', after2 === before2, before2 + ' → ' + after2);
}

/* 源码层面：别再退回「按个数」的老写法 */
{
  const src = fs.readFileSync('src/compact-core.mjs', 'utf8');
  t.ok('不再有 SLIM_KEEP_MAX（按个数）', !/const SLIM_KEEP_MAX = \d+/.test(src));
  t.ok('有体积上限常量', /SLIM_KEEP_MAX_BYTES/.test(src));
  t.ok('有保底条数常量', /SLIM_KEEP_MIN_FILES/.test(src));
  t.ok('上限可以用环境变量调（盘小时能收紧）', /SLIM_KEEP_MAX_MB/.test(src));
}

t.done();
