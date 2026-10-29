/**
 * ask_peer 递话也得受「小鲸按钮」管 —— 2026-10-29
 *
 * 单独一条，因为这条路上游漏过一次：ask_subagent 有门，ask_peer 没有，
 * 结果主人把按钮关了，话照样能递进她信箱，下一轮她就冒出来了。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'chk-peer-off-'));
process.env.MINI_AGENT_DATA = join(home, 'data');

let pass = 0, fail = 0;
const ok = (c, l, e = '') => { if (c) { pass++; console.log(`  [ok] ${l}${e ? ' | ' + e : ''}`); } else { fail++; console.log(`  [FAIL] ${l}${e ? ' | ' + e : ''}`); } };

const { config } = await import('file:///D:/小鱼Agent/src/config.mjs');
const stateDir = join(config.dataDir, '.state');
mkdirSync(stateDir, { recursive: true });
const setSwitch = (on) => writeFileSync(join(stateDir, 'whale-on.json'), JSON.stringify({ schemaVersion: 2, on: { me: on } }), 'utf8');

const { tools, runWithToolContext } = await import('file:///D:/小鱼Agent/src/tools.mjs');
const askPeer = tools.find((t) => t.name === 'ask_peer');
ok(!!askPeer, '找到 ask_peer 工具');

console.log('\n【一】小鲸按钮关着 → 递不进去');
setSwitch(false);
const r1 = await runWithToolContext({ sessionId: 'me' }, () => askPeer.run({ to: 'whale', text: '喂，出来一下' }));
ok(typeof r1 === 'string' && r1.includes('没被放出来'), 'ask_peer 被拒绝了', String(r1).slice(0, 60));

console.log('\n【二】按钮开着 → 照常递');
setSwitch(true);
const r2 = await runWithToolContext({ sessionId: 'me' }, () => askPeer.run({ to: 'whale', text: '按钮开着，可以说话了' }));
ok(!String(r2).includes('没被放出来'), 'ask_peer 放行了', String(r2).slice(0, 60));

console.log('\n【三】递给别的会话（不是 whale）不受这条闸影响');
setSwitch(false);
const r3 = await runWithToolContext({ sessionId: 'me' }, () => askPeer.run({ to: 'some-other-session', text: '喂' }));
ok(!String(r3).includes('没被放出来'), '别的会话照样能递', String(r3).slice(0, 60));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${fail === 0 ? '全部通过' : fail + ' 项没过'}（${pass} 项通过）`);
try { rmSync(home, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
