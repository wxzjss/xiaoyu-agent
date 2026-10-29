/**
 * 「按钮灭着，她一个字都不许出来」验收 —— 2026-10-29
 *
 * 主人报的原话：屏幕上那颗「小鲸」按钮是关着的，她还冒出来说话。
 *
 * 三条进来的路都验：
 *   ① pushWhaleSays（总出口）—— 关着直接不写
 *   ② takeWhaleSays（出口）—— 盘上残留的老话，关着整份丢掉
 *   ③ disk 信箱 —— 丢完之后盘上那份也得清掉，不能留到下次开关一开才冒出来
 *
 * 再反过来验一遍：开关开着时这三条全都正常（不能把好好的功能改哑了）。
 *
 * 全程用临时数据目录，不碰真数据。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'chk-whale-off-'));
process.env.MINI_AGENT_DATA = join(home, 'data');
rmSync(process.env.MINI_AGENT_DATA, { recursive: true, force: true });

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  [ok] ${label}${extra ? ' | ' + extra : ''}`); }
  else { fail++; console.log(`  [FAIL] ${label}${extra ? ' | ' + extra : ''}`); }
};

const { config } = await import('file:///D:/小鱼Agent/src/config.mjs');
const voice = await import('file:///D:/小鱼Agent/src/whale-voice.mjs');
const pres = await import('file:///D:/小鱼Agent/src/whale-presence.mjs');

const SID = 'default';
const stateDir = join(config.dataDir, '.state');
const { mkdirSync } = await import('node:fs');
mkdirSync(stateDir, { recursive: true });

/** 直接写 whale-on.json，模拟主人点按钮 */
function setSwitch(on) {
  writeFileSync(join(stateDir, 'whale-on.json'),
    JSON.stringify({ schemaVersion: 2, on: { [SID]: on } }), 'utf8');
}
const mailbox = () => join(stateDir, 'whale-mailbox', String(SID).replace(/[^\w.-]/g, '_') + '.json');

console.log('\n【一】开关关着：三种入口全都不出声');
setSwitch(false);
ok(pres.whaleOn(SID) === false, '前提：开关读出来是关的');

voice.pushWhaleSays(SID, '我是小鲸，按钮灭着我也不该出现', '小鲸');
ok(voice.peekWhaleSays(SID).length === 0, 'pushWhaleSays 被拦住，信箱是空的',
  `实际 ${voice.peekWhaleSays(SID).length} 条`);

// 伪造一条「开关开着时写进去的」残留
mkdirSync(join(stateDir, 'whale-mailbox'), { recursive: true });
const mb = mailbox();
writeFileSync(mb, JSON.stringify({ text: '上辈子留下的一句', who: '小鲸', at: Date.now() - 1000 }) + '\n', 'utf8');
ok(existsSync(mb), '伪造残留成功（模拟开关开着时写进来的）');

const taken = voice.takeWhaleSays(SID);
ok(taken.length === 0, 'takeWhaleSays 关着时什么也不给', `实际 ${taken.length} 条`);
ok(!existsSync(mb), '盘上那份残留也清掉了（不会等下次开关一开才冒出来）');

console.log('\n【二】开关开着：三条路全都正常');
setSwitch(true);
ok(pres.whaleOn(SID) === true, '前提：开关读出来是开的');

voice.pushWhaleSays(SID, '按钮开着我当然能说话', '小鲸');
const p1 = voice.peekWhaleSays(SID);
ok(p1.length === 1 && String(p1[0].text).includes('按钮开着'), 'pushWhaleSays 正常放行',
  `${p1.length} 条`);
const t1 = voice.takeWhaleSays(SID);
ok(t1.length === 1, 'takeWhaleSays 正常取出', `${t1.length} 条`);
ok(voice.peekWhaleSays(SID).length === 0, '取完清空');

console.log('\n【三】冒充主人那条路也得受同一个闸管');
setSwitch(false);
voice.pushWhaleSays(SID, '装成主人说的话', '主人', { as: 'user', who: '主人' });
const u = voice.peekWhaleSays(SID);
ok(u.length === 0, 'as:user 冒充主人，关着也拦住了', `${u.length} 条`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${fail === 0 ? '全部通过' : fail + ' 项没过'}（${pass} 项通过）`);

try { rmSync(home, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
