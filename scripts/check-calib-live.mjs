/**
 * 严检：校准系数必须**真的**按会话生效
 *
 * 上一版只把 noteRealTokens 改成按会话存，可 estimateTokens 里还在读
 * 全局 calibRatio（永远是初值 1.6）—— 隔离形同虚设，等于白改。
 * 这个脚本就是钉死这件事：校准一个会话，它的估算必须真的变。
 */
import fs from 'node:fs';

const base = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\';
const cp = await import('file:///' + base.replace(/\\/g, '/') + 'compress.mjs');

let pass = 0, total = 0;
const chk = (l, c) => { total++; c ? (pass++, console.log('  [ok] ' + l)) : console.log('  [FAIL] ' + l); };

const src = fs.readFileSync(base + 'src'.replace('src', 'compress.mjs'), 'utf8');

console.log('=== 代码特征 ===');
chk('estimateTokens 接收 sessionId', /export function estimateTokens\(messages, sessionId\)/.test(src));
chk('函数体里用本会话系数', /const calibRatio = _calibGet\(sessionId\)/.test(src));
chk('noteRealTokens 也按会话存', /export function noteRealTokens\(realTokens, estimatedTokens, sessionId\)/.test(src));
chk('currentCalibration 按会话读', /export function currentCalibration\(sessionId\)/.test(src));

console.log('\n=== 真跑 ===');
const mk = (n) => Array.from({ length: n }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  content: '这是一段用来测估算的中文文本，长度大约五十个字左右。'.repeat(20),
}));
const msgs = mk(200);

const a0 = cp.estimateTokens(msgs, 'sessX');
const b0 = cp.estimateTokens(msgs, 'sessY');
chk('两个新会话起点一样', a0 === b0);

cp.noteRealTokens(a0 * 3, a0, 'sessX');
const a1 = cp.estimateTokens(msgs, 'sessX');
const b1 = cp.estimateTokens(msgs, 'sessY');

chk('校准后本会话估算真的变了（不再是死值 1.6）', a1 !== a0);
chk('另一个会话不受影响', b1 === b0);
chk('currentCalibration 能读到各自的值',
  cp.currentCalibration('sessX') !== cp.currentCalibration('sessY'));

console.log('\n  A: ' + a0 + ' → ' + a1 + '  (k=' + cp.currentCalibration('sessX') + ')');
console.log('  B: ' + b0 + ' → ' + b1 + '  (k=' + cp.currentCalibration('sessY') + ')');

console.log('\n------------');
console.log('断言：' + pass + '/' + total);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
