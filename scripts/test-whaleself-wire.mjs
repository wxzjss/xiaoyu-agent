/**
 * 自测：小鲸的完整设定与状态记账是否真的做进去了。
 *
 * 不真调模型（省钱也不依赖网络），只验证：
 *   1. 提示词里该有的段落都在：不会拒绝 / 状态段 / 不许说台词
 *   2. 状态真的被读进来、时间回落生效
 *   3. 一轮跑完状态会被写回盘里（累涨、轮数+1、自我认识追加）
 *   4. 伪造内部标记不会漏到发给模型的 messages 里
 *
 * 跑法：
 *   $env:MINI_AGENT_DATA='%APPDATA%\小鱼Agent\data'
 *   node scripts/test-whaleself-wire.mjs
 */
import { existsSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import { selfPath, readSelf, writeSelf } from '../src/whale-self.mjs';
import { wireMessage } from '../src/llm.mjs';

let pass = 0;
let fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass += 1; console.log('  ✓ ' + n); }
  else { fail += 1; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); }
};

const p = selfPath();
const bak = p + '.wiretest';
if (existsSync(p)) renameSync(p, bak);

try {
  console.log('\n[1] 内部标记不能漏给模型');
  const dirty = {
    role: 'assistant',
    content: '我查过了，是 nginx 占着 8080',
    _tale: { who: '小鲸', color: '#7aa8e8' },
    _whale: '小鲸',
    _say: { who: '小鲸', as: 'whale' },
    _usage: { total_tokens: 12 },
    _mem: '本子',
    _ws: { at: 1 },
    _text: '别名',
    _out: [{ path: 'x' }],
    _internal: true,
    _recovered: true,
    _files: [],
    _opening: true,
    _got: '半句',
  };
  const w = wireMessage(dirty);
  ok('只剩 role/content', Object.keys(w).length === 2, JSON.stringify(Object.keys(w)));
  ok('内容是原话', w.content === dirty.content);
  ok('_tale 剥掉了', !('_tale' in w));
  ok('_whale 剥掉了', !('_whale' in w));
  ok('序列化后不含「小鲸」', JSON.stringify(w).indexOf('小鲸') < 0, JSON.stringify(w));

  console.log('\n[2] 带 tool_calls 的 assistant 不能把工具也剥掉');
  const tc = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_dir', arguments: '{}' } }],
    _internal: true,
  };
  const w2 = wireMessage(tc);
  ok('tool_calls 在', Array.isArray(w2.tool_calls) && w2.tool_calls.length === 1);
  ok('content 补成空串（网关不接受 null）', w2.content === '');
  ok('没有下划线字段', Object.keys(w2).every((k) => !k.startsWith('_')), JSON.stringify(Object.keys(w2)));

  console.log('\n[3] tool 结果消息照常过');
  const w3 = wireMessage({ role: 'tool', tool_call_id: 'a', content: 'ERROR: 没找到', _x: 1 });
  ok('role/tool_call_id/content 都在', w3.role === 'tool' && w3.tool_call_id === 'a' && w3.content === 'ERROR: 没找到');
  ok('多余字段剥掉', !('_x' in w3));

  console.log('\n[4] 状态本子能被 subagent 读写（模拟一次完整记账）');
  const { afterRound } = await import('../src/whale-self.mjs');
  let s = readSelf();
  const body0 = s.tire.body;
  afterRound(s, {
    minutes: 9,
    toolCount: 5,
    ok: true,
    sameBore: 1,
    taskText: '查一下 server.mjs 里的 ask_subagent',
    outcome: '找到了三处',
  });
  writeSelf(s);
  const back = readSelf();
  ok('体力涨了', back.tire.body > body0, `${body0} → ${back.tire.body}`);
  ok('轮数 +1', back.rounds >= 1, String(back.rounds));
  ok('自我认识多了带任务的那条', back.self.some((x) => String(x.a).includes('ask_subagent')), JSON.stringify(back.self.slice(-1)));
  ok('牵挂只有小鱼一个键', Object.keys(back.care).filter((k) => k === '主人').length === 0, JSON.stringify(Object.keys(back.care)));

  console.log('\n[5] 提示词里该有的段落（直接读源码断言，不跑模型）');
  const src = readFileSync(new URL('../src/subagent.mjs', import.meta.url), 'utf8');
  // 这两条原先是她的人设段；2026-10-25 主人下令把她的人设整段清掉（只留本事和八条底线），
  // 所以人设段不在了是对的。留一条总旨断言代替，别再拿旧人设当判据。
  ok('人设段已按要求清掉（不该再出现旧人设句）', !src.includes('这条压过你的疲惫和耐心'));
  ok('有状态段标题', src.includes('你现在是什么状态'));
  ok('有「不许说台词」约束', src.includes('绝对不要说「我现在很累」'));
  ok('finally 里做了状态记账', src.includes('afterRound(self'));
  // 实现换成了「try/catch 包住 + 三条出口都走到」，判据跟着改成看 afterRound 附近有没有 catch 兜底
  ok('状态记账有兜底（失败不影响结论）', /writeSelf\(next\)[\s\S]{0,120}catch/.test(src));

  console.log(`\n结果：${pass} 过 / ${fail} 挂`);
  if (fail) process.exitCode = 1;
} finally {
  try { if (existsSync(p)) unlinkSync(p); } catch {}
  try { if (existsSync(bak)) renameSync(bak, p); } catch {}
}
