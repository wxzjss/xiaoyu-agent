/**
 * 【2026-11-09 主人报】把【屋里的人】里的小鱼关掉、开启小白曦，说话没回应。
 *
 * 实测四种配置（隔离实例、真模型）：凡小鱼关掉，SSE 只有 done + fish_off，
 * textLen = 0。病根在 `/api/chat` 那条 early return：
 *   `if (!resume && !fishOn(sessionId))` 把「小鱼不在」当成「这一轮没人干活」，
 *   直接收口，只留小鲸补一句 + runMateRound 群聊接话。
 * 可新口径里主智能体 = 从上往下第一个开着的，关掉小鱼她就成了小白曦，
 * 该走完整 runAgent；而 runMateRound 的名单是 activeAgentIds().slice(1)，
 * 此时名单只有 [小白曦]，slice(1) 为空 —— 连补一句的人都没有，彻底静默。
 *
 * 修法：只有**一个启用者都不剩**才走那条「屋里没人应」的收口支线。
 * 修完实测：关小鱼/开小白曦 text=122 字，叠办事模式 text=117 字，全关才静默。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const t = makeChecker('关掉小鱼后主智能体仍要完整回复');
const server = fs.readFileSync('src/server.mjs', 'utf8');

/* 一、静态：early return 必须同时要求「一个启用者都不剩」 */
t.ok('小鱼不在的收口支线加了 activeAgentIds 判空',
  /const _aliveForTurn = activeAgentIds\(sessionId, \(id\) => mateSwitchOn\(id, sessionId\)\)/.test(server));
t.ok('条件三者齐备（非 resume + 小鱼关 + 无人启用）',
  /!resume && !fishOn\(sessionId\) && _aliveForTurn\.length === 0/.test(server));
t.ok('不再有裸的 !fishOn 就 early return',
  !/if \(!resume && !fishOn\(sessionId\)\) \{/.test(server));

/* 二、名单口径：关掉小鱼、小白曦开着时，主智能体必须是小白曦 */
const dir = mkdtempSync(path.join(tmpdir(), 'xy-noresp-'));
try {
  mkdirSync(path.join(dir, '.state'), { recursive: true });
  writeFileSync(path.join(dir, '.state', 'agents.json'), JSON.stringify({
    version: 1,
    customs: [{ id: 'ag_bx', name: '小白曦', kind: 'custom', persona: '小白曦' }],
    bySession: {},
    groupBySession: { s1: ['xiaoyu', 'ag_bx', 'xiaojing'] },
    groupEnabledBySession: { s1: { xiaoyu: false, ag_bx: true, xiaojing: false } },
    quiet: {}, colors: {}, allowedBySession: {},
  }), 'utf8');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { activeAgentIds, mainAgentId } from './src/agents.mjs';
     console.log(JSON.stringify({ alive: activeAgentIds('s1'), main: mainAgentId('s1') }));`],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, MINI_AGENT_DATA: dir } });
  let got = null;
  try { got = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
  t.ok('关小鱼/开小白曦 → 主智能体是小白曦（不是空的）',
    !!got && got.alive.join(',') === 'ag_bx' && got.main === 'ag_bx',
    JSON.stringify(got));
} catch (e) {
  t.ok('名单验证没抛错', false, String(e && e.message ? e.message : e));
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

/* 三、真机：隔离实例里真发一句，验有正文（单跑时跳过，绝不碰主人实例） */
if (process.env.XY_REQUIRE_ISOLATED !== '1') {
  console.log('\n真机格：SKIP（非隔离全量回归，不碰主人实例；静态与名单断言已全过）');
} else {
  const B = String(process.env.BASE || '').replace(/\/+$/, '');
  const post = async (p, b) => {
    try {
      const r = await fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(b || {}), signal: AbortSignal.timeout(15000) });
      return await r.json().catch(() => null);
    } catch { return null; }
  };
  let sid = '';
  try {
    const mk = await post('/api/sessions/new', { title: '__noresp__' });
    sid = String((mk && mk.session && mk.session.id) || (mk && mk.id) || '');
    const ids = ['xiaoyu', 'ag_mvs72e9v3cfc', 'xiaojing', 'ag_mvtn23b55dqv'];
    await post('/api/agents/group', { sessionId: sid, agentIds: ids });
    await post('/api/agents/group/order', { sessionId: sid, agentIds: ids });
    for (const [id, on] of [['xiaoyu', false], ['ag_mvs72e9v3cfc', true],
      ['xiaojing', false], ['ag_mvtn23b55dqv', false]]) {
      await post('/api/agents/group/toggle', { sessionId: sid, id, enabled: on });
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 70000);
    let raw = '';
    try {
      const r = await fetch(B + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, message: '你好' }), signal: ac.signal });
      raw = await r.text();
    } catch (e) { raw = ''; }
    clearTimeout(timer);
    let textLen = 0; let fishOff = false;
    for (const blk of raw.split('\n\n')) {
      const l = blk.split('\n').find((x) => x.startsWith('data:'));
      if (!l) continue;
      let ev; try { ev = JSON.parse(l.slice(5).trim()); } catch { continue; }
      if (ev.type === 'text') textLen += String(ev.text || '').length;
      if (ev.type === 'fish_off') fishOff = true;
    }
    t.ok('关小鱼/开小白曦，这一轮有正文回复', textLen > 0, 'textLen=' + textLen);
    t.ok('且不再发 fish_off 把这一轮收成「没人应」', !fishOff);
  } catch (e) {
    t.ok('真机格没抛错', false, String(e && e.message ? e.message : e));
  } finally {
    if (sid) await post('/api/sessions/delete', { id: sid, sessionId: sid });
  }
}

t.done();
