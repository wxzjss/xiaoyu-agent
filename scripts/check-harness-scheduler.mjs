/** 调度器：真的并行、严格分层、事件成对、失败隔离、幂等不重跑。 */
import { makeChecker } from './_harness_util.mjs';
import { executeBatch, plan, layerStats, clearIdempotency, idempotencySize } from '../src/harness/scheduler.mjs';

const t = makeChecker('harness / scheduler');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = (id, name, args = {}) => ({ id, function: { name, arguments: JSON.stringify(args) } });

// 1) 三个只读真的同时跑
clearIdempotency('chk');
let events = [];
let runs = 0;
const r1 = await executeBatch([C('a', 'read_file'), C('b', 'list_dir'), C('c', 'search_files')], {
  runTool: async (n) => { runs++; await sleep(60); return { ok: true, output: n }; },
  onEvent: (e) => events.push(e),
  sessionId: 'chk', round: 1,
});
t.ok('3 个读并行：总耗时接近最慢那个（<160ms）', r1.stats.elapsedMs < 160, r1.stats.elapsedMs + 'ms');
t.ok('只跑 3 次', runs === 3);
t.ok('事件成对且各 3 条', events.length === 6
  && events.filter((e) => e.type === 'tool_start').length === 3
  && events.filter((e) => e.type === 'tool_end').length === 3);
t.ok('tool_end 字段齐全（id/name/ok/output）', events.filter((e) => e.type === 'tool_end')
  .every((e) => e.id && e.name && typeof e.ok === 'boolean' && typeof e.output === 'string'));
t.ok('结果按 id 可取', r1.results.get('a')?.ok === true && r1.byIndex.length === 3);
t.ok('parallelHitRate = 1', r1.stats.parallelHitRate === 1);

// 2) 写操作确实分层串行
clearIdempotency('chk');
const t0 = Date.now();
const seq = [];
await executeBatch([C('d', 'read_file'), C('e', 'write_file'), C('f', 'read_file')], {
  runTool: async (n) => { seq.push(n); await sleep(35); return { ok: true, output: n }; },
  emitEvents: false, sessionId: 'chk', round: 2,
});
const dt = Date.now() - t0;
t.ok('读-写-读分三层串行（≥100ms）', dt >= 100, dt + 'ms');
t.ok('执行顺序与发出顺序一致', seq.join(',') === 'read_file,write_file,read_file', seq.join(','));

// 3) 同层一个失败不影响其它
clearIdempotency('chk');
const ev3 = [];
const r3 = await executeBatch([C('g', 'read_file'), C('h', 'list_dir'), C('i', 'search_files')], {
  runTool: async (n) => { if (n === 'list_dir') throw new Error('故意炸'); await sleep(10); return { ok: true, output: n }; },
  onEvent: (e) => ev3.push(e), emitEvents: true, sessionId: 'chk', round: 3,
});
t.ok('失败被兜成 ok:false，不抛出', r3.results.get('h')?.ok === false);
t.ok('同层其它两个照常成功', r3.results.get('g')?.ok === true && r3.results.get('i')?.ok === true);
t.ok('失败的那条也有 tool_end', ev3.filter((e) => e.type === 'tool_end' && e.id === 'h').length === 1);

// 4) 幂等：同 session+round 连发两次同一批，第二次一次都不该重跑
clearIdempotency('chk');
let runs4 = 0;
const batch4 = [C('a', 'read_file'), C('b', 'list_dir'), C('c', 'search_files')];
const opts4 = {
  runTool: async (n) => { runs4++; await sleep(20); return { ok: true, output: n }; },
  emitEvents: false, sessionId: 'chk', round: 11,
};
await executeBatch(batch4, opts4);
const r4 = await executeBatch(batch4, opts4);
t.ok('幂等命中：第二次一次都没重跑（共 3 次）', runs4 === 3, 'runs=' + runs4);
t.ok('幂等命中仍返回原结果', r4.results.get('a')?.ok === true);

// 5) emitEvents:false 时事件归零但结果照给
clearIdempotency('chk');
let ev5 = 0;
const r5 = await executeBatch([C('j', 'read_file')], {
  runTool: async () => ({ ok: true, output: 'x' }),
  onEvent: () => ev5++, emitEvents: false, sessionId: 'chk', round: 5,
});
t.ok('emitEvents:false 不发事件、结果照给', ev5 === 0 && r5.results.get('j')?.output === 'x');

// 6) plan / stats 纯函数
const layers = plan([C('1', 'read_file'), C('2', 'list_dir'), C('3', 'write_file'), C('4', 'read_file')]);
t.ok('plan 切成 3 层', layers.length === 3, JSON.stringify(layers.map((l) => l.length)));
t.ok('layerStats 算得出命中率', layerStats(layers).parallelHitRate === 0.5);
t.ok('幂等账本有上限', idempotencySize() < 500, String(idempotencySize()));

// 7) onlyParallelLayers：接进老主循环时，只接管「真能同时跑」的层
clearIdempotency('chk');
let runs7 = 0;
const r7 = await executeBatch([
  C('k1', 'read_file'), C('k2', 'list_dir'), C('k3', 'write_file'), C('k4', 'read_file'), C('k5', 'search_files'),
], {
  runTool: async (n) => { runs7++; await sleep(20); return { ok: true, output: n }; },
  emitEvents: false, onlyParallelLayers: true, sessionId: 'chk', round: 7,
});
t.ok('只预跑两个并行读层（4 次），写和单个读留给主循环', runs7 === 4, 'runs=' + runs7);
t.ok('写操作没有结果（主循环自己跑）', !r7.results.has('k3'));
t.ok('两个读层都并起来了', r7.stats.parallelLayers === 2, JSON.stringify(r7.stats));

// 8) 契约守卫：主循环里事件仍一条条发，调度器关掉了自己的事件
clearIdempotency('chk');
let ev8 = 0;
await executeBatch([C('m1', 'read_file'), C('m2', 'list_dir')], {
  runTool: async () => ({ ok: true, output: 'x' }),
  onEvent: () => ev8++, emitEvents: false, onlyParallelLayers: true, sessionId: 'chk', round: 8,
});
t.ok('emitEvents:false + onlyParallelLayers 时事件归零', ev8 === 0);

t.done();
