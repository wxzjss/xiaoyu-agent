#!/usr/bin/env node
/**
 * 记忆本自检 —— 不动主人的真数据。
 *
 * 【为什么要有这个】
 * 2026-10-29 主人要「查一下记忆本的所有功能都生效了吗」。当时是临时写几个脚本
 * 跑一次性验证，跑完就没了。以后每次改记忆相关的代码，还得再临时造一遍。
 *
 * 这个脚本把那次的检查固定下来：所有写入都发生在临时目录里
 * （MINI_AGENT_DATA 指到系统临时目录下一个随机名字），跑完自己删掉。
 * **它不会碰 %APPDATA%\小鱼Agent\data 里的任何东西** —— 这是硬约束，
 * 之前有一次测试写进了主人的真目录，本子时间戳都被改了。
 *
 * 用法：
 *   node scripts/memory-selftest.mjs
 * 退出码：0 = 全过；1 = 有失败
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 【必须在 import 任何 src 模块之前设好】——
// config.mjs 是模块顶层就把 dataDir 定下来的，晚一步设变量就等于没设。
const TMP = mkdtempSync(join(tmpdir(), 'xiaoyu-memtest-'));
process.env.MINI_AGENT_DATA = TMP;

const results = [];
const ok = (section, name, cond, extra) => results.push({ section, name, cond: !!cond, extra: extra || '' });

function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 46 - title.length)));
}

try {
  const M = await import('../src/session-memory.mjs');
  const W = await import('../src/whale-memory.mjs');
  const MY = await import('../src/my-memory.mjs');
  const F = await import('../src/features.mjs');

  // ════════════════════════════ 一、会话记忆本（session-memory）═══
  section('会话记忆本');
  const ID = 'selftest0001';
  const ID2 = 'selftest0002';

  const skel = M.ensureMemory(ID);
  ok('会话本', 'ensureMemory 建出骨架', typeof skel === 'string' && skel.startsWith('# 会话记忆'));
  ok('会话本', '再调一次不覆盖', M.ensureMemory(ID) === skel);
  ok('会话本', 'readMemory 读得回', M.readMemory(ID) === skel);
  ok('会话本', '不存在的会话回 null', M.readMemory('nosuchid0001') === null);

  const body = skel + '\n### 任务目标\n自检\n';
  ok('会话本', 'writeMemory 写得进', M.writeMemory(ID, body) === true && M.readMemory(ID) === body);
  ok('会话本', 'force=false 时已存在不动', M.writeMemory(ID, 'XXX', { force: false }) === false);

  const d1 = M.appendDigest(ID, '自检第一条：写进去了');
  const d2 = M.appendDigest(ID, '自检第二条：编号要自增');
  ok('会话本', 'appendDigest 编号从 1 开始', d1 && d1.index === 1, 'index=' + (d1 && d1.index));
  ok('会话本', 'appendDigest 编号自增', d2 && d2.index === 2, 'index=' + (d2 && d2.index));
  ok('会话本', 'digestEntries 数得对', M.digestEntries(M.readMemory(ID)).length === 2);
  const dup = M.appendDigest(ID, '自检第一条：写进去了');
  ok('会话本', '同一件事不记第二遍', dup && dup.skipped === 'duplicate', JSON.stringify(dup && dup.skipped));
  let threw = false;
  try { M.appendDigest(ID, '   '); } catch (e) { threw = e.status === 400; }
  ok('会话本', '空摘要被拒（400）', threw);

  const info = M.memoryInfo(ID);
  ok('会话本', 'memoryInfo 报字数', info.chars > 0, 'chars=' + info.chars);
  ok('会话本', 'memoryInfo 报摘要条数', info.digest === 2, 'digest=' + info.digest);

  ok('会话本', 'copyMemory 抄得出一份', (M.copyMemory(ID, ID2) || '').length > 0 && M.readMemory(ID2) === M.readMemory(ID));
  const snap = M.snapMemory(ID2, null);
  ok('会话本', 'snapMemory(null) 删掉并留备份', snap.removed === true && !!snap.backup);
  ok('会话本', 'trashMemory 挪走且留档', M.trashMemory(ID) === true && M.readMemory(ID) === null
    && existsSync(join(TMP, '.state', 'memory', '.trash', ID + '.md')));

  const ID3 = 'selftest0003';
  M.writeMemory(ID3, 'x'.repeat(300));
  const w = M.wipeMemory(ID3);
  ok('会话本', 'wipeMemory 报出字节数并留备份', w.bytes === 300 && !!w.backup && existsSync(w.backup));
  ok('会话本', 'wipeMemory 清完只剩骨架', (M.readMemory(ID3) || '').startsWith('# 会话记忆'));
  let pathBlocked = false;
  try { M.writeMemory('../escape', 'x'); } catch (e) { pathBlocked = e.status === 400; }
  ok('会话本', '非法 id 被拒（防路径穿越）', pathBlocked);

  // ════════════════════════════ 二、滚动上限与归档 ═══════════════
  section('上限 80 条 · 溢出归档');
  const AR = 'selftestarch';
  // 每条内容都不同：session-memory 有源头查重，句式一样会被当成同一件事
  for (let i = 1; i <= 85; i++) M.appendDigest(AR, '压测条目 ' + i + ' 号：内容彼此不同 ' + 'ABCDEFGHIJ'[i % 10].repeat((i % 7) + 1));
  const archText = M.readMemory(AR) || '';
  const archAt = archText.indexOf('## 归档');
  const archLines = archAt >= 0 ? archText.slice(archAt).split('\n').filter((l) => /^-\s+R\d/.test(l.trim())) : [];
  ok('归档', '滚出去的 5 条进了「## 归档」段', archLines.length === 5, '实际 ' + archLines.length + ' 条');
  ok('归档', '归档里是编号最小的那 5 条', archLines.every((l) => /R000[1-5]\b/.test(l)),
    archLines.map((l) => (l.match(/R\d+/) || [''])[0]).join(','));
  const kept = M.digestEntries(M.readMemory(AR)).length;
  ok('归档', '滚动区仍是 80 条', kept === 80, '实际 ' + kept);

  // ════════════════════════════ 三、长期记忆开关（只读）═══════════
  section('长期记忆关掉 = 只读');
  MY.appendRolling('开着的状态下写一条');
  const readOn = MY.memoryText();
  F.setFeature('memory', false);
  ok('只读', 'setFeature 真把关掉了', F.getEnabledMap().memory === false);
  const readOff = MY.memoryText();
  ok('只读', '关掉后仍读得到（不是失明）', readOff.length > 0, readOff.length + ' 字');
  ok('只读', '关掉后正文里明说不能写', readOff.includes('关着') && readOff.includes('不能往里写'));
  let myRej1 = false;
  try { MY.appendRolling('关掉后还想写'); } catch (e) { myRej1 = String(e.message || '').includes('关着'); }
  ok('只读', 'appendRolling 被拒', myRej1);
  let myRej2 = false;
  try { MY.appendFixed('任务目标', '关掉后还想钉'); } catch (e) { myRej2 = true; }
  ok('只读', 'appendFixed 被拒', myRej2);
  ok('只读', '小鲸那本 appendWhaleMemory 返回 false', W.appendWhaleMemory('我查过的事', '关掉后还想写') === false);
  ok('只读', '小鲸那本整份覆盖返回 false', W.writeWhaleMemory('整份覆盖') === false);
  const compCap = W.compactWhaleMemory();
  ok('只读', '小鲸那本压缩什么都不做', compCap && compCap.compacted === false);
  F.setFeature('memory', true);
  ok('只读', '打开后又写得进去', !!MY.appendRolling('打开后再写一条'));

  // ════════════════════════════ 四、小鲸那本 ═════════════════════
  section('小鲸那本（三格本子）');
  W.appendWhaleMemory('我踩过的坑', '自检：踩了一个坑');
  const wt = W.readWhaleMemory();
  ok('小鲸本', '三个分区都在', W.SECTIONS.every((s) => wt.includes(s)), W.SECTIONS.join('/'));
  ok('小鲸本', '写进去的读得回', wt.includes('自检：踩了一个坑'));
  W.appendWhaleMemory('我查过的事', '自检：查了一件事');
  const cnt = (W.readWhaleMemory().match(/自检：查了一件事/g) || []).length;
  ok('小鲸本', '同一句不重复记', cnt === 1, '出现 ' + cnt + ' 次');
  const wi = W.whaleMemoryInfo();
  ok('小鲸本', 'whaleMemoryInfo 报字数', wi.chars > 0, 'chars=' + wi.chars);

  // ════════════════════════════ 五、我这本（按人设分）═══════════
  section('我的记忆本（按人设分本）');
  const pm = MY.appendFixed('关键事实（已验证）', '自检：固定记忆能钉');
  ok('我的本', 'appendFixed 成功', !!pm);
  ok('我的本', '钉的内容进了正文', MY.memoryText().includes('自检：固定记忆能钉'));
  const parsed = MY.parseMemory(MY.composeMemory().text);
  ok('我的本', 'parseMemory 分得出固定区和滚动区', parsed.roll.length > 0 && String(parsed.fixed).length > 0,
    'roll=' + parsed.roll.length);
  ok('我的本', 'memoryInfo 报出本子路径', !!MY.memoryInfo().path);
} catch (e) {
  console.error('\n💥 自检本身炸了：' + (e && e.stack ? e.stack : e));
  results.push({ section: '自检', name: '脚本没跑完', cond: false, extra: String(e && e.message) });
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// ── 汇总 ──
const failed = results.filter((r) => !r.cond);
console.log('\n' + '═'.repeat(56));
for (const r of results) {
  if (!r.cond) console.log('  ✘ [' + r.section + '] ' + r.name + (r.extra ? '  ' + r.extra : ''));
}
console.log('记忆本自检：' + (results.length - failed.length) + ' 过 / ' + failed.length + ' 挂（共 ' + results.length + ' 项）');
console.log('临时目录已清理：' + TMP);
console.log('═'.repeat(56));
process.exit(failed.length ? 1 : 0);
