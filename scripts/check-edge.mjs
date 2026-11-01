/**
 * 严检：边界与异常输入 —— 不许因为取不到状态就崩掉一整轮
 */
import fs from 'node:fs';

const p = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\agent.mjs';
const src = fs.readFileSync(p, 'utf8');

let pass = 0, total = 0;
const chk = (l, c) => { total++; c ? (pass++, console.log('  [ok] ' + l)) : console.log('  [FAIL] ' + l); };

console.log('=== 代码特征 ===');
chk('sessionId 有默认值，不会 undefined', /sessionId = 'default'/.test(src));
chk('取状态的函数单独抽出（_midWarnStateOf）', /function _midWarnStateOf/.test(src));
chk('量线整段套了 try/catch（量不出来不打断干活）', /量不出来就算了，别打断干活/.test(src));

console.log('\n=== 真跑异常输入 ===');
const start = src.indexOf('const _midWarnState = new Map();');
const end = src.indexOf('\n}\n', src.indexOf('function _midWarnStateOf')) + 3;
const code = src.slice(start, end);

const fn = new Function(code + '\nreturn { _midWarnStateOf, _midWarnState };');
const { _midWarnStateOf, _midWarnState } = fn();

const cases = [
  ['undefined', undefined],
  ['null', null],
  ['空串', ''],
  ['正常 id', 'sess-abc'],
  ['超长 id', 'x'.repeat(5000)],
  ['带特殊字符', 'a/../../b\\c:d*?'],
  ['数字', 12345],
  ['对象', { toString: () => 'obj-sess' }],
];

for (const [label, input] of cases) {
  let ok = true, msg = '';
  try {
    const r = _midWarnStateOf(input);
    if (!r || typeof r !== 'object' || typeof r.tier !== 'number' || typeof r.at !== 'number') {
      ok = false; msg = ' 返回结构不对: ' + JSON.stringify(r);
    }
  } catch (e) { ok = false; msg = ' 抛了: ' + e.message; }
  chk(`${label} 不崩且返回正确结构${msg}`, ok);
}

console.log('\n=== 内存上限 ===');
console.log('  当前桶数 =', _midWarnState.size);
chk('桶数在合理上限内', _midWarnState.size <= 420);

console.log('\n────────────');
console.log(`断言：${pass}/${total}`);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
