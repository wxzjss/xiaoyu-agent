#!/usr/bin/env node
/**
 * 守一条：开机重放实时柜子日志（restoreLiveLogsFromDisk）的「已进历史」判据不许太宽。
 *
 * 【2026-11-15 修】原判据「盘上任何一条消息 at >= startedAt 就删日志」，
 * 会被轮**中途**的落盘误触发（压缩落地 onCompressed / worker 递文件 stashFile /
 * 插话被取走后跟着落地）—— 那几条的 at 同样 >= startedAt，但这一轮没收尾。
 * 硬杀重启后日志一删，柜子里那排工具卡凭空消失。
 *
 * 收紧成 restoreDraftHalfTurn 同款口径：只有尾巴像真收尾
 * （最后一条是 assistant、有正文、没挂工具）才删；否则照旧重放恢复柜子。
 *
 * 跑法：node scripts/check-live-restore-tail.mjs   （纯源码守卫）
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
};

console.log('〔live 恢复·尾巴判据〕');
const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs'), 'utf8');

ok('restoreLiveLogsFromDisk 里存在收紧后的 _lmFinished 判据',
  /const _lmFinished = !!\(_lm && _lm\.role === 'assistant'/.test(server));
ok('判据三要素齐全：有正文 + 不是 assistant(tool_calls) 空壳',
  /String\(_lm\.content \?\? ''\)\.trim\(\)\.length/.test(server)
  && /!\(Array\.isArray\(_lm\.tool_calls\) && _lm\.tool_calls\.length\)/.test(server));
ok('只有真收尾才删日志（live-restore-skip 在 _lmFinished 分支里）',
  /if \(_lmFinished\) \{\s*try \{ diagLog\('live-restore-skip'/.test(server));
ok('没收尾的保留日志照旧恢复（有 live-restore-keep 记号）',
  /live-restore-keep/.test(server));
ok('老的「一律删」写法已不存在',
  !/if \(lastAt >= startedAt\) \{ try \{ diagLog\('live-restore-skip'[\s\S]{0,80}__fsUnlinkSync\(abs\); \} catch \{\} continue; \}/.test(server));

console.log('');
console.log(`结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
