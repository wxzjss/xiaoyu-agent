/**
 * 严检：判定口径必须和量线口径一致
 *
 * 以前 estTokens 硬按 1.5 算、estimateTokens 乘了校准系数，
 * 同一份历史一个说 43.7%、一个说 69.6% —— 量线一直催，压缩永不触发。
 */
import fs from 'node:fs';

const base = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\';
const cc = await import('file:///' + base.replace(/\\/g, '/') + 'compact-core.mjs');
const cp = await import('file:///' + base.replace(/\\/g, '/') + 'compress.mjs');

let pass = 0, total = 0;
const chk = (l, c, extra = '') => { total++; c ? (pass++, console.log('  [ok] ' + l + (extra ? '  ' + extra : ''))) : console.log('  [FAIL] ' + l + (extra ? '  ' + extra : '')); };

console.log('=== 代码特征 ===');
const ccSrc = fs.readFileSync(base + 'compact-core.mjs', 'utf8');
chk('estTokens 接收 sessionId', /export function estTokens\(messages, sessionId\)/.test(ccSrc));
chk('estTokens 读校准系数', /currentCalibration\(sessionId\)/.test(ccSrc));
chk('不再硬编码 / 1\.5', !/Math\.ceil\(textChars \/ 1\.5\)/.test(ccSrc));
chk('planTurnCompact 传 sessionId', /planTurnCompact\(messages, limit, sessionId\)/.test(ccSrc));

console.log('\n=== 真跑：两个口径必须一致 ===');
const sid = 'smvwf26l5ap3c';
const p = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\.state\\sessions\\' + sid + '.json';
let msgs = [];
try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); msgs = j.messages || j.history || []; } catch {}
if (!msgs.length) msgs = [{ role: 'user', content: 'x'.repeat(1000) }];

const a = cc.estTokens(msgs, sid);
const b = cp.estimateTokens(msgs);
const k = a / b;
console.log('  estTokens=' + a + '  estimateTokens=' + b + '  倍数=' + k.toFixed(4));
chk('判定与量线口径一致（倍数≈1）', Math.abs(k - 1) < 0.02, 'k=' + k.toFixed(4));

console.log('\n=== 真跑：到了线必须真判要压 ===');
const over = [{ role: 'user', content: 'x'.repeat(800000) }];
const g = cc.planTurnCompact(over, 1000000, 'probe-session');
console.log('  80 万字符的会话：tier=' + g.tier + ' ratio=' + g.ratio.toFixed(3) + ' shouldSlim=' + g.shouldSlim);
chk('超线时会判要瘦身', g.shouldSlim === true);

console.log('\n------------');
console.log('断言：' + pass + '/' + total);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
