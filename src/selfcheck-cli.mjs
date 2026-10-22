#!/usr/bin/env node
/**
 * 命令行跑自检。环境检查由 AI 自己做（要花几秒调模型）。
 *   npm run selfcheck
 */
const { runSelfCheck, pendingIssues } = await import('../src/selfcheck.mjs');

console.log('AI 自检跑起来了，可能要几秒…\n');
const r = await runSelfCheck();
const s = r.summary;

console.log(`自检（AI）：${s.okCount} 通过 / ${s.warnCount} 提醒 / ${s.failCount} 失败 · 花了 ${Math.round((r.tookMs ?? 0) / 100) / 10}s`);
if (r.skipped) console.log(`跳过：${r.skipped}`);
if (r.summaryText) console.log(`结论：${r.summaryText}`);
console.log('');
for (const i of r.items) {
  const mark = i.level === 'ok' ? '  ok  ' : i.level === 'warn' ? ' warn ' : ' FAIL ';
  console.log(`${mark} ${i.name}：${i.detail}${i.fix ? `\n        建议：${i.fix}` : ''}`);
}

const pending = pendingIssues();
if (pending.length) {
  console.log('\n下次主人来了会提醒这些：');
  for (const p of pending) console.log(`  - ${p.name}：${p.detail}`);
}
process.exit(s.failCount > 0 ? 1 : 0);
