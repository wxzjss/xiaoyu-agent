/**
 * 【发出去的历史里，旧的工具结构必须抹平】
 *
 * 主人 2026-11-09：「感觉不是模型的问题，飞鱼模型在之前一直是好好的，
 * 自从 11 月 8 号你的某次更新后就突然这样了」「我要求根治」。
 *
 * 抓真实请求做对照实验（同一会话、同一接入点，只改一处）：
 *   原样 281 条（124 条 tool）     → 0 字思考，只回「嗯，我在。」
 *   只留最后 40 条（含 tool）      → 还是敷衍
 *   去掉所有 role:'tool'          → 132 字思考，正常
 *   tool 内容换占位符（结构留着）  → 还是敷衍
 *   工具结构整段抹平成文字        → 203 字思考，正常
 *
 * 结论：这个网关**碰到历史里的 role:'tool' 结构就退化**，跟长度/档位/模型都无关。
 * 所以 wireMessages 里加 flattenOldToolTurns：只保留最后一组工具往返（当前这轮在用），
 * 更早的一律压成纯文本，不再附「用过工具」那句。
 */
import { makeChecker } from './_harness_util.mjs';
import { flattenOldToolTurns, wireMessages } from '../src/llm.mjs';

const t = makeChecker('llm / 工具历史抹平');

const mk = (role, content, extra) => ({ role, content, ...(extra || {}) });
const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

// 两轮工具，最后一组要原样留着
const history = [
  mk('user', '第一问'),
  mk('assistant', '', { tool_calls: [call('c1', 'run_command')] }),
  mk('tool', '第一轮结果很长很长', { tool_call_id: 'c1' }),
  mk('assistant', '第一轮完了'),
  mk('user', '第二问'),
  mk('assistant', '', { tool_calls: [call('c2', 'read_file')] }),
  mk('tool', '第二轮结果', { tool_call_id: 'c2' }),
];

const out = flattenOldToolTurns(history);

t.ok('旧的 tool 消息整条去掉', !out.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'));
t.ok('旧的 tool_calls 压成纯文本、不再附「用过工具」那句',
  out.some((m) => m.role === 'assistant')
  && !out.some((m) => /用过工具/.test(String(m.content || ''))));
t.ok('最后一组 tool 原样保留', out.some((m) => m.role === 'tool' && m.tool_call_id === 'c2'));
t.ok('最后一组 tool_calls 也保留', out.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)
  && m.tool_calls.some((c) => c.id === 'c2')));
t.ok('消息条数变少（旧的被合并了）', out.length < history.length, history.length + ' → ' + out.length);

// 整段都是工具往返（刚开始干活）→ 一个都不许动
const onlyTail = [
  mk('user', '干活'),
  mk('assistant', '', { tool_calls: [call('x1', 'run_command')] }),
  mk('tool', '结果', { tool_call_id: 'x1' }),
];
const out2 = flattenOldToolTurns(onlyTail);
t.ok('全尾都是工具往返时不动', out2.length === onlyTail.length && out2.some((m) => m.role === 'tool'));

// 纯聊天历史：一点不动
const plain = [mk('user', '你好'), mk('assistant', '在的')];
const out3 = flattenOldToolTurns(plain);
t.ok('纯聊天历史原样返回', out3.length === 2 && out3[0].content === '你好');

// wireMessages 串起来也要过这一道
const wired = wireMessages(history);
t.ok('wireMessages 已经接上抹平', !wired.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'));
t.ok('wireMessages 不会把最后一组也抹掉', wired.some((m) => m.role === 'tool' && m.tool_call_id === 'c2'));

t.done();
