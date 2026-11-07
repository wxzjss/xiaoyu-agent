/** 工具调用协议：增量合并、重复交付不丢批、XML 跨块、幂等键。 */
import { makeChecker } from './_harness_util.mjs';
import {
  normalizeCall, createCallAccumulator, makeIdempotencyKey,
  parseXmlToolCalls, createXmlScanner,
} from '../src/harness/tool-protocol.mjs';

const t = makeChecker('harness / tool-protocol');

t.ok('normalizeCall 兼容对象参数', normalizeCall({ id: 'a', function: { name: 'read_file', arguments: { path: 'x' } } }).arguments === '{"path":"x"}');
t.ok('normalizeCall 容忍空', normalizeCall(null).name === '');

// 流式片段：name / arguments 都被切在两块中间
const a = createCallAccumulator();
a.merge([{ id: 'a', function: { name: 'read_', arguments: '{"pa' } }]);
a.merge([{ id: 'a', function: { name: 'file', arguments: 'th":"x"}' } }]);
t.ok('跨块片段拼成一条完整调用', a.size === 1 && a.values()[0].name === 'read_file'
  && a.values()[0].arguments === '{"path":"x"}', JSON.stringify(a.values()));

// 事故复现：同一 round 第二次交付不能把第一批冲掉
const b = createCallAccumulator();
b.merge([{ id: 'x', function: { name: 'read_file', arguments: '{}' } },
         { id: 'y', function: { name: 'list_dir', arguments: '{}' } }]);
b.merge([{ id: 'z', function: { name: 'search_files', arguments: '{}' } }]);
t.ok('同轮二次交付后仍是 3 条（不覆盖）', b.size === 3 && b.values().map((c) => c.name).join(',') === 'read_file,list_dir,search_files', 'size=' + b.size);

// 整批重发（完整副本）也不能变成两条
const c = createCallAccumulator();
c.merge([{ id: 'k', function: { name: 'read_file', arguments: '{"p":1}' } }]);
c.merge([{ id: 'k', function: { name: 'read_file', arguments: '{"p":1}' } }]);
t.ok('整批重发幂等（仍 1 条）', c.size === 1 && c.values()[0].arguments === '{"p":1}');

// 无 id 的调用靠 index 归一，不能互相顶掉
const d = createCallAccumulator();
d.merge([{ index: 0, function: { name: 'read_file', arguments: '{}' } },
         { index: 1, function: { name: 'list_dir', arguments: '{}' } }]);
t.ok('无 id 的两条都保留', d.size === 2);

const key = makeIdempotencyKey('s1', 3, 'call_1');
t.ok('幂等键含会话/轮次/id', key === 's1|3|call_1');
t.ok('不同轮次键不同', key !== makeIdempotencyKey('s1', 4, 'call_1'));

// XML 边流边扫
const xs = createXmlScanner();
const p1 = xs.feed('甲<invoke name="read_file"><parameter name="path">a');
const p2 = xs.feed('.txt</parameter></invoke>乙');
t.ok('XML 未闭合时不提前吐', p1.length === 0);
t.ok('XML 闭合即吐出', p2.length === 1 && p2[0].name === 'read_file'
  && JSON.parse(p2[0].arguments).path === 'a.txt', JSON.stringify(p2));
const one = parseXmlToolCalls('<invoke name="list_dir"><parameter name="path">"."</parameter></invoke>');
t.ok('一次性 XML 解析兼容旧行为', one.length === 1 && one[0].name === 'list_dir');
t.ok('普通尖括号不当工具', parseXmlToolCalls('a < b 且 c > d').length === 0);

// reset
const e = createCallAccumulator();
e.merge([{ id: 'q', function: { name: 'read_file', arguments: '{}' } }]);
e.reset();
t.ok('reset 清空', e.size === 0);

t.done();
