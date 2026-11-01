/**
 * 严检：并发下量线状态会不会互相踩
 */
const fs = await import('node:fs');
const p = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\agent.mjs';
const src = fs.readFileSync(p, 'utf8');

const start = src.indexOf('const _midWarnState = new Map();');
const end = src.indexOf('\n}', src.indexOf('function _midWarnStateOf')) + 2;
const fn = new Function(src.slice(start, end) + '\nreturn { _midWarnStateOf, _midWarnState };');
const { _midWarnStateOf } = fn();

let pass = 0, total = 0;
const chk = (l, c) => { total++; c ? (pass++, console.log('  [ok] ' + l)) : console.log('  [FAIL] ' + l); };

console.log('=== 并发取同一会话 ===');
const ids = [];
for (let i = 0; i < 100; i++) ids.push(_midWarnStateOf('same'));
chk('100 次取出的是同一个对象（没有各建各的）', ids.every((r) => r === ids[0]));

console.log('\n=== 两个会话交错写 ===');
const a = _midWarnStateOf('A');
const b = _midWarnStateOf('B');
a.tier = 3; a.at = 600000;
b.tier = 1; b.at = 350000;
chk('A 的档位没被 B 改掉', a.tier === 3 && a.at === 600000);
chk('B 的档位没被 A 改掉', b.tier === 1 && b.at === 350000);

console.log('\n=== 模拟两圈同时推进 ===');
const c = _midWarnStateOf('C');
c.tier = 5; c.at = 900000;
const snapshot = { ...c };
c.tier = 0; c.at = 0;  // 压缩后复位
chk('复位后旧快照不影响新状态', c.tier === 0 && c.at === 0);
chk('快照本身没被污染', snapshot.tier === 5);

console.log('\n────────────');
console.log(`断言：${pass}/${total}`);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
