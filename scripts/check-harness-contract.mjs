/**
 * 【契约冻结守卫】
 *
 * 这次重做只换「模型→工具→再回模型」的机制，不许顺手改掉任何对外约定。
 * 这一格专门盯：工具调用不再覆盖赋值、事件仍由主循环发、旧白名单已收口、
 * SSE 事件字段、会话落盘结构、以及人设/底线/安全词的红线。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';
import { isReadOnlyCommand as harnessReadOnly } from '../src/harness/tool-spec.mjs';

const t = makeChecker('harness / contract');
const read = (p) => fs.readFileSync(p, 'utf8');
const agent = read('src/agent.mjs');
const server = read('src/server.mjs');
const ui = read('public/index.html');
const sessions = read('src/sessions-core.mjs');
const persona = read('src/persona.mjs');
const settings = read('src/settings.mjs');

// ── 丢批事故不许回来 ──────────────────────────────────────────────
t.ok('主路径用累积器，不再覆盖赋值', /toolCalls = _callAcc\.values\(\)/.test(agent));
t.ok('主路径不再调 takeFreshToolCalls（会冲掉第一批）', !/toolCalls = takeFreshToolCalls\(/.test(agent));
t.ok('每圈开头 reset 累积器', /_callAcc\.reset\(\)/.test(agent));
t.ok('harness 模块真的被 import', /from '\.\/harness\/index\.mjs'/.test(agent));
t.ok('createCallAccumulator 已接入', /createCallAccumulator/.test(agent));
t.ok('executeBatch 已接入主循环', /await executeBatch\(assistantMsg\.tool_calls/.test(agent));
/* 外层 round 每条用户消息都从 0 重新数，网关又爱复用 call_0 ——
 * 幂等键必须带 run 级 nonce，否则第二条消息会命中上一条的缓存、工具不跑。 */
t.ok('幂等键带 run 级 nonce（跨消息不串账）', /_harnessRunKey/.test(agent)
  && /round: _harnessRunKey \+ ':' \+ round/.test(agent));
t.ok('旧的 _RO 白名单已删（判定收口到 tool-spec）', !/_RO = new Set/.test(agent));
t.ok('isReadOnlyCommand 委托给 harness', /return harnessIsReadOnlyCommand\(raw\)/.test(agent));

// ── 事件契约：字段一个都不能少，且仍由主循环一条条发 ────────────────
t.ok('tool_start 仍是 {id,name,args}', /type: 'tool_start', id: call\.id, name: call\.function\.name, args: call\.function\.arguments/.test(agent));
t.ok('tool_end 仍是 {id,name,ok,output,images}', /type: 'tool_end', id: call\.id, name: call\.function\.name, ok, output, images: imgGot/.test(agent));
t.ok('调度器接进来时关掉了自己的事件（emitEvents:false）', /emitEvents: false/.test(agent));
t.ok('sentfile 事件在服务端有分支', /type: 'sentfile'/.test(server) || /sentfile/.test(server));
for (const ev of ['text', 'tool_start', 'tool_end', 'compressed', 'aborted', 'error', 'done']) {
  t.ok('SSE 事件 ' + ev + ' 仍在', new RegExp("type: '" + ev + "'").test(server));
}
/* reasoning / text 是同一条分支里用动态 type 发的（send({type:_k})），
 * 所以单独验那个分支，别拿死字符串去套。 */
t.ok('SSE 事件 reasoning 仍在（动态 type 分支）', /ev\.type === 'reasoning'/.test(server) && /send\(\{ type: _k/.test(server));
for (const ev of ['tool_start', 'tool_end', 'sentfile', 'done']) {
  t.ok('前端仍认 ' + ev, new RegExp("ev\\.type === '" + ev + "'").test(ui));
}

// ── 会话落盘结构 ───────────────────────────────────────────────────
for (const k of ['id', 'title', 'createdAt', 'updatedAt', 'messages', 'rewinds']) {
  t.ok('会话字段 ' + k + ' 仍在', new RegExp('\\b' + k + '\\b').test(sessions));
}
t.ok('落盘仍是原子写', /writeFileAtomic/.test(sessions));

// ── 人设 / 底线 / 安全词红线（这些段落本次一个字都不许动） ──────────
const RED_LINES = [
  'SAFE_MODE_FALLBACK', 'PERSONA_MODE_FALLBACK', 'PERSONA_WORD',
  'retargetPersona', 'loadPersona', 'safeMode', 'safeWord',
];
for (const k of RED_LINES) t.ok('红线符号 ' + k + ' 仍在 persona.mjs', persona.includes(k));
t.ok('人设档说明没被删', /主人原话|人设档|当前状态/.test(persona));
/* 底线不在 persona.mjs（在设置里），单独验它没被这轮改动碰过 */
for (const k of ['bottomLines', 'currentBottomLines', 'normalizeLines']) {
  t.ok('底线符号 ' + k + ' 仍在 settings.mjs', settings.includes(k));
}

// ── 提示词不许自我否定 ───────────────────────────────────────────
// 只看**真正会拼进提示词的代码**，注释里为了交代来龙去脉引用旧句是允许的。
const personaCode = persona.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
t.ok('没有「拿不准就一定一次一个」这种自我否定', !/拿不准就一定一次一个/.test(personaCode));
t.ok('没有「写文件和跑命令一次只做一件」', !/写文件和跑命令一次只做一件/.test(personaCode));
t.ok('调度交给程序这句话真的在提示词里', /程序按依赖算/.test(personaCode));
t.ok('可并行名单来自 tool-spec 而不是手写', /buildToolIndex\(rawSchemas\)/.test(personaCode));

// ── 运行时加载链：改坏了 import（循环依赖 / 缺文件）重启就白屏 ──────
const mod = await import('../src/agent.mjs');
t.ok('agent.mjs 能在运行时真的加载出来', typeof mod.runAgent === 'function');
t.ok('takeFreshToolCalls 仍导出（兼容老引用）', typeof mod.takeFreshToolCalls === 'function');
t.ok('agent 的只读判定与 tool-spec 完全一致（只读命令）',
  mod.isReadOnlyCommand('git status') === harnessReadOnly('git status'));
t.ok('agent 的只读判定与 tool-spec 完全一致（带管道）',
  mod.isReadOnlyCommand('ls | findstr x') === harnessReadOnly('ls | findstr x'));
const toolsMod = await import('../src/tools.mjs');
const rc = toolsMod.tools.find((x) => x.name === 'run_command');
t.ok('run_command 仍注册、且 schema 带 shell_hint', Boolean(rc) && Boolean(rc.parameters?.properties?.shell_hint));
t.ok('run_command 能真跑一条简单命令', /v\d+\./.test(String(await toolsMod.runWithToolContext(
  { sessionId: '__contract_probe__', pushEvent: () => {}, stashFile: () => {}, outbox: [] },
  () => rc.run({ command: 'node -v' }),
))));

t.done();
