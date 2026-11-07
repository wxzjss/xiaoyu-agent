/** 工具依赖元数据：四处判定收口之后，别再漂移。 */
import { makeChecker } from './_harness_util.mjs';
import {
  classifyCall, canParallel, groupLayers, dependencyEdges,
  isReadOnlyCommand, buildToolIndex, TOOL_SPEC,
} from '../src/harness/tool-spec.mjs';
import { tools } from '../src/tools.mjs';

const t = makeChecker('harness / tool-spec');
let C;
try { C = (typeof tools !== 'undefined' && Array.isArray(tools)) ? tools : []; } catch { C = []; }

const call = (name, args = {}) => ({
  id: name, function: { name, arguments: JSON.stringify(args) },
});

t.ok('元数据表非空', Object.keys(TOOL_SPEC).length >= 30, Object.keys(TOOL_SPEC).length + ' 项');

// 现网 53 个工具，每一个都要能安全分类（不能抛、未知的要保守）
let allSafe = true;
for (const tool of C) {
  try {
    const r = classifyCall(call(tool.name));
    if (r.parallelSafe && !r.idempotent) allSafe = false;
  } catch { allSafe = false; }
}
t.ok('现网每个工具都能安全分类（' + C.length + ' 个）', allSafe);

const READS = ['read_file', 'list_dir', 'search_files', 'web_search', 'memory_search', 'chronicle_read'];
const WRITES = ['write_file', 'send_file', 'restart_self', 'ask_subagent', 'ui_click'];
t.ok('只读组判定为可并行', READS.every((n) => classifyCall(call(n)).parallelSafe));
t.ok('写组判定为串行', WRITES.every((n) => !classifyCall(call(n)).parallelSafe));
t.ok('两个读可以同层', canParallel(call('read_file'), call('list_dir')));
t.ok('读 + 写不可同层', !canParallel(call('read_file'), call('write_file')));
t.ok('未登记工具保守串行', !classifyCall(call('brand_new_tool_zzz')).parallelSafe);

t.ok('只读命令可并行', isReadOnlyCommand('git status') && isReadOnlyCommand('dir /b'));
t.ok('重定向/管道/串接一律串行', ['ls > a.txt', 'ls | findstr x', 'node -e "x"; del y', 'a && b']
  .every((c) => !isReadOnlyCommand(c)));
t.ok('run_command 动态判定', classifyCall(call('run_command', { command: 'git log -3' })).parallelSafe
  && !classifyCall(call('run_command', { command: 'del x.txt' })).parallelSafe);

const layers = (arr) => groupLayers(arr).map((l) => l.map((c) => c.function.name).join('+'));
t.ok('[读,读,读] → 一层', JSON.stringify(layers([call('read_file'), call('list_dir'), call('search_files')]))
  === JSON.stringify(['read_file+list_dir+search_files']));
t.ok('[读,写,读,读] → 三层', JSON.stringify(layers([call('read_file'), call('write_file'), call('read_file'), call('read_file')]))
  === JSON.stringify(['read_file', 'write_file', 'read_file+read_file']));
t.ok('[写,写] → 两层严格串行', layers([call('write_file'), call('send_file')]).length === 2);
t.ok('依赖边不会把两个读连起来', dependencyEdges([call('read_file'), call('list_dir')]).length === 0);
const edges = dependencyEdges([call('read_file'), call('write_file'), call('read_file')]);
t.ok('写操作是屏障（前后各一条边）', edges.length === 2, JSON.stringify(edges));
t.ok('两个读之间没有边', !edges.some(([i, j]) => i === 0 && j === 2));

const idx = buildToolIndex(C.map((x) => ({ function: { name: x.name, description: x.description || '' } })));
t.ok('索引覆盖全部工具', idx.length === C.length, idx.length + '/' + C.length);
t.ok('每个工具都有触发器', idx.every((x) => x.trigger && x.trigger.length > 2));

t.done();
