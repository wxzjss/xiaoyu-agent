/**
 * 【2026-11-09 主人重做】把这套规矩钉死，别哪天又退回「各算各的」。
 *
 * 主人口径：
 *   ① 【屋里的人】从上往下第一个**启用**的 = 主智能体（动态），
 *      她也是这一轮唯一有 Agent 工作能力的人；
 *   ② 排在她下面的一律禁用 Agent 工作能力（只能说话，不能跑工具/派活）；
 *   ③ 链式可见：A 看到主人原话 → B 看到「主人 + A」→ C 看到「主人 + A + B」……
 *
 * 这次是「换口径」不是补 bug：2026-11-01 那条「派活优先找屋里除主智能体之外的人、
 * 没启用就自动启用」被覆盖；「排在小鱼上面的人先开口」整段停用。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCardMessages, pickSpeakers } from '../src/group.mjs';

const t = makeChecker('链式接话：A→B→C，只有第一个有 Agent 能力');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const agents = read('src/agents.mjs');
const server = read('src/server.mjs');
const group = read('src/group.mjs');
const tools = read('src/tools.mjs');
const ui = read('public/index.html');

/* ── 一、单一真源 ───────────────────────────────────────────── */
t.ok('有 activeAgentIds 作为唯一真源', /export function activeAgentIds\(/.test(agents));
t.ok('mainAgentId 复用它（不再自己遍历一遍）',
  /export function mainAgentId\([\s\S]{0,240}activeAgentIds\(sessionId, isOn\)/.test(agents));
t.ok('两条接话路径都用「主智能体以下」的名单',
  (server.match(/activeAgentIds\(sessionId, \(id\) => mateSwitchOn\(id, sessionId\)\)/g) || []).length >= 2
  && (server.match(/\.slice\(1\)/g) || []).length >= 2);
t.ok('不再写死「排除小鱼」', !/filter\(\(a\) => String\(a\.id\) !== AGENT_XIAOYU\)/.test(server));
t.ok('界面高亮按第一个开着的算，不是 idx===0',
  /firstOn = members\.findIndex\(\(x\) => x && x\.enabled !== false\)/.test(ui)
  && /isMain \? ' first'/.test(ui));

/* ── 二、禁用 Agent 工作能力 ────────────────────────────────── */
t.ok('接话者永远不拿工具（speakAsCard 不传 tools）',
  /res = await chat\(\{ messages: msgs, model, sessionId, signal \}\)/.test(group)
  && !/speakAsCard[\s\S]{0,900}tools:/.test(group));
t.ok('不再把屋里的人挂名成 worker / 自动启用 / 拉人进屋',
  !/pickHelperForTask\(/.test(tools) && /禁用 Agent 工作能力/.test(tools));
t.ok('提示词明说这一轮没有工具、不能干活',
  /没有工具、不能干活/.test(group));

/* ── 三、链式顺序与可见 ─────────────────────────────────────── */
t.ok('「排在小鱼上面的人先开口」默认停用',
  /XY_LEGACY_ABOVE === '1'/.test(server));
t.ok('pickSpeakers 支持严格名单顺序',
  /keepOrder = false/.test(group) && /!keepOrder && aliveHits\.length/.test(group));
t.ok('两条接话路径都开了 keepOrder',
  (server.match(/keepOrder: true/g) || []).length >= 2);

const roster = [
  { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
];
const ordered = pickSpeakers({
  roster, userText: '@C 你先说 @A 然后你', quietIds: [], enabledIds: ['a', 'b', 'c'], keepOrder: true,
});
t.ok('keepOrder 时严格 A→B→C（@ 不插队）',
  ordered.map((x) => x.id).join(',') === 'a,b,c', ordered.map((x) => x.id).join(','));
const reordered = pickSpeakers({
  roster, userText: '@C 你先说 @A 然后你', quietIds: [], enabledIds: ['a', 'b', 'c'],
});
t.ok('不传 keepOrder 时旧行为没被改坏（@ 仍可插队）',
  reordered[0] && reordered[0].id === 'c', reordered.map((x) => x.id).join(','));

/* 真正拼一次 C 的请求：主人 + A + B 都得在，且标清是谁说的 */
const msgs = [
  { role: 'user', content: '主人说的话' },
  { role: 'assistant', content: 'A 的回答' },   // 主智能体是小鱼：按约定 _who 为空
  { role: 'assistant', content: 'B 的接话', _who: 'B', _card: 'b', _cardVoice: true },
];
const out = buildCardMessages({
  agent: { id: 'c', name: 'C' }, messages: msgs, sessionId: '__chain__', mainName: '小鱼',
});
const body = out.map((m) => String(m.content || '')).join('\n');
const atUser = body.indexOf('主人说的话');
const atA = body.indexOf('小鱼：A 的回答');
const atB = body.indexOf('B：B 的接话');
t.ok('C 能看到主人原话', atUser >= 0);
t.ok('C 能看到 A 的话，且标成主智能体说的', atA > atUser, 'atA=' + atA);
t.ok('C 能看到 B 的话，且标成 B 说的', atB > atA, 'atB=' + atB);
t.ok('顺序是 主人 → A → B', atUser < atA && atA < atB);
t.ok('提示词里写明了「链式接话」规矩', /链式接话/.test(body));
t.ok('提示点出主智能体是动态传进来的', body.includes('「小鱼」是这一轮的主智能体'));

const out2 = buildCardMessages({
  agent: { id: 'c', name: 'C' }, messages: msgs, sessionId: '__chain__', mainName: '小白曦',
});
const body2 = out2.map((m) => String(m.content || '')).join('\n');
t.ok('主智能体不是小鱼时，A 的话标的是她的名字（不再写死小鱼）',
  body2.includes('小白曦：A 的回答'));

/* ── 四、启用状态真的是动态的（隔离临时目录里跑） ───────────── */
const dir = mkdtempSync(path.join(tmpdir(), 'xy-chain-'));
try {
  mkdirSync(path.join(dir, '.state'), { recursive: true });
  writeFileSync(path.join(dir, '.state', 'agents.json'), JSON.stringify({
    version: 1,
    customs: [{ id: 'ag_b', name: 'B', kind: 'custom', persona: 'B' }],
    bySession: {},
    groupBySession: { s1: ['xiaoyu', 'ag_b', 'xiaojing'] },
    groupEnabledBySession: { s1: { xiaoyu: false, ag_b: true } },
    quiet: {}, colors: {}, allowedBySession: {},
  }), 'utf8');
  const probe = `
    import { activeAgentIds, mainAgentId } from './src/agents.mjs';
    const a = activeAgentIds('s1');
    console.log(JSON.stringify({ alive: a, main: mainAgentId('s1') }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, MINI_AGENT_DATA: dir },
  });
  let got = null;
  try { got = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
  t.ok('关掉最上面一个，主智能体自动挪到下一个开着的',
    !!got && got.alive.join(',') === 'ag_b,xiaojing' && got.main === 'ag_b',
    JSON.stringify(got) + ' ' + String(r.stderr || '').slice(0, 120));
} catch (e) {
  t.ok('动态主智能体验证没抛错', false, String(e && e.message ? e.message : e));
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

t.done();
