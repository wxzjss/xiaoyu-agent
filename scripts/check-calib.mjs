/**
 * 严检：量线估算与校准
 *  ① 校准必须用「最后一次请求」的真实值（lastUsage），不能用累加值（usage）
 *  ② 校准系数必须按会话隔离，不能全局共享
 */
import fs from 'node:fs';

const base = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\';
const agent = fs.readFileSync(base + 'agent.mjs', 'utf8');
const compress = fs.readFileSync(base + 'compress.mjs', 'utf8');

let pass = 0, total = 0;
const chk = (l, c) => { total++; c ? (pass++, console.log('  [ok] ' + l)) : console.log('  [FAIL] ' + l); };

console.log('=== ① 校准用哪个值 ===');
chk('用 lastUsage（最后一次请求）', /noteRealTokens\(\s*realPrompt/.test(agent) && /lastUsage\?\.prompt_tokens/.test(agent));
chk('不再拿累加的 usage.prompt_tokens 去校准',
  !/const realPrompt = Number\(usage\.prompt_tokens/.test(agent));
chk('lastUsage 确实在每轮记录', /lastUsage = \{ \.\.\.usage \}|lastUsage = \{\.\.\.usage\}/.test(agent));

console.log('\n=== ② 校准系数按会话隔离 ===');
chk('有按会话存的 Map', /_calibBySession = new Map\(\)/.test(compress));
chk('有 _calibGet(sessionId)', /function _calibGet\(sessionId\)/.test(compress));
chk('noteRealTokens 接收 sessionId', /noteRealTokens\(realTokens, estimatedTokens, sessionId\)/.test(compress));
chk('不再全局改 calibRatio', !/^\s+calibRatio = Math\.min\(8, calibRatio \+ 0\.2\);/m.test(compress));
chk('会话桶有上限', /CALIB_MAX_SESSIONS/.test(compress));

console.log('\n=== ③ 真跑：两个会话的系数互不影响 ===');
const mod = await import('file:///' + base.replace(/\\/g, '/') + 'compress.mjs');
mod.noteRealTokens(100000, 50000, 'sessA');   // A 系数上浮
const a1 = mod.currentCalibration('sessA');
const b1 = mod.currentCalibration('sessB');
chk('A 系数被校准变了', a1 !== 1.6);
chk('B 系数没被 A 牵连', b1 === 1.6);
console.log(`     A=${a1.toFixed(3)}  B=${b1.toFixed(3)}`);

// 脏数据：real 远大于 est，应该只微调，不能顶到 8
mod.noteRealTokens(10000000, 1000, 'sessC');
const c1 = mod.currentCalibration('sessC');
chk('脏数据不把系数顶到 8', c1 < 4);
console.log(`     C(脏数据)=${c1.toFixed(3)}`);

console.log('\n------------');
console.log(`断言：${pass}/${total}`);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
